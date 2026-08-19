/**
 * lib/ai-client.js — shared OpenRouter caller for the whole app.
 *
 * Replaces the 5 near-identical copies that used to live in crawler.js,
 * ai-digest.js, job-api.js, news-bot.js and timeline-ai.js. Behavior each
 * caller relied on (model list, retry-with-delay, completeness scoring) stays
 * in the caller; this module only owns the network call + the two things
 * that were broken/duplicated everywhere:
 *
 *  1. `openai/gpt-oss-20b:free` rejects `reasoning:{enabled:false}` ("Reasoning
 *     is mandatory for this endpoint and cannot be disabled") — every caller
 *     sent that flag unconditionally, so this model failed 100% of the time.
 *  2. All 5 callers shared one OpenRouter account with no coordination, so
 *     they burned through the free-tier daily quota together and then each
 *     kept hammering it with full retry loops. A shared daily budget +
 *     same-day breaker stops wasted calls once the account is known to be
 *     rate-limited for the day.
 */
const https = require('https');
const settingsDB = require('../settings-db');

const OPENROUTER_KEY = process.env.OPENROUTER_KEY || '';
const DEFAULT_PREFERRED = 'google/gemma-4-26b-a4b-it:free';

const FALLBACK_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'openai/gpt-oss-20b:free',
];

// Models known to reject a disabled-reasoning request outright.
const REASONING_REQUIRED = new Set(['openai/gpt-oss-20b:free']);

// ── model resolution — always re-read settings, never cache (models can change any time) ──
function getModels(overrideSettingsKey) {
  const general = settingsDB.get('ai_model', DEFAULT_PREFERRED);
  let preferred = general;
  if (overrideSettingsKey) {
    const override = settingsDB.get(overrideSettingsKey, '');
    if (override) preferred = override;
  }
  return [preferred, ...FALLBACK_MODELS.filter(m => m !== preferred)];
}

// ════════════════════════════════════════════════════════
//  SHARED DAILY BUDGET (across every caller in the app)
// ════════════════════════════════════════════════════════
function todayStr() { return new Date().toISOString().slice(0, 10); }

function _rolloverIfNewDay() {
  const day = settingsDB.get('ai_budget_date', '');
  if (day !== todayStr()) {
    settingsDB.set('ai_budget_date', todayStr());
    settingsDB.set('ai_calls_used', 0);
    settingsDB.set('ai_daily_limit_hit', false);
  }
}

// Default cap is conservative on purpose (free tier w/o balance is small).
// Raise it from Settings (key: ai_daily_limit) once the OpenRouter account is charged.
function hasBudget() {
  _rolloverIfNewDay();
  if (settingsDB.get('ai_daily_limit_hit', false)) return false;
  const limit = Number(settingsDB.get('ai_daily_limit', 150)) || 150;
  const used = Number(settingsDB.get('ai_calls_used', 0)) || 0;
  return used < limit;
}

function recordCall() {
  _rolloverIfNewDay();
  settingsDB.set('ai_calls_used', (Number(settingsDB.get('ai_calls_used', 0)) || 0) + 1);
}

// OpenRouter told us the free-tier daily cap is hit — stop trying for the rest of the day,
// across ALL callers, instead of every module retrying its own full model list.
function tripDailyBudget(reason) {
  _rolloverIfNewDay();
  settingsDB.set('ai_daily_limit_hit', true);
  console.warn(`[ai-client] daily free-tier budget exhausted, pausing all AI calls until midnight: ${reason || ''}`);
}

// short circuit breaker for transient rate-limit bursts (independent of the daily flag)
let _pausedUntil = 0;
/**
 * آیا این مدل از کیسه‌ی رایگان OpenRouter خرج می‌کند؟
 * پسوند :free قطعی است؛ برای بقیه به کش قیمت نگاه می‌کنیم، چون چند مدل
 * رایگان (openrouter/free و هم‌خانواده‌هایش) اصلاً پسوند ندارند.
 */
// آخرین خطایی که OpenRouter برگرداند — برای پیام‌های قابل‌فهم در پنل
let _lastError = '';
function lastError() { return _lastError; }

/**
 * ترجمه‌ی خطای خام OpenRouter به جمله‌ای که بشود بر اساسش کاری کرد.
 * سه حالت کاملاً متفاوت قبلاً همه یک پیام می‌گرفتند.
 */
function explainFailure() {
  const e = _lastError || '';
  if (/key limit exceeded/i.test(e))
    return 'سقف مصرف خودِ کلید API در OpenRouter پر شده — از داشبورد OpenRouter، بخش Keys، محدودیت این کلید را بالا ببرید یا برش دارید. (سقف داخل پنل ما ربطی به این ندارد.)';
  if (/insufficient credit|402|payment/i.test(e))
    return 'اعتبار حساب OpenRouter تمام شده — حساب را شارژ کنید.';
  if (/free-models-per-day/i.test(e))
    return 'سهمیه‌ی روزانه‌ی مدل‌های رایگان OpenRouter تمام شده — یک مدل پولی انتخاب کنید یا تا نیمه‌شب UTC صبر کنید.';
  if (/reasoning is mandatory/i.test(e))
    return 'این مدل reasoning اجباری دارد و با تنظیم فعلی سازگار نیست — مدل دیگری انتخاب کنید.';
  return e ? ('خطای مدل: ' + e.slice(0, 160)) : '';
}

function isFreeModel(id) {
  if (!id) return true;
  if (/:free$/.test(id)) return true;
  try {
    const c = require('./openrouter-models').list();
    const m = (c.models || []).find(x => x.id === id);
    if (m) return !!m.free;
  } catch (e) { /* کش نبود — محافظه‌کارانه پولی حساب کن تا بی‌دلیل بلاک نشود */ }
  return false;
}

/**
 * سه چیز جدا اینجا قاطی می‌شدند و نتیجه‌اش این بود که انتخاب مدل پولی
 * عملاً بی‌اثر می‌ماند:
 *   ۱. قطع‌کننده‌ی کوتاه (هجوم rate-limit) — همه را موقتاً متوقف می‌کند.
 *   ۲. سقف خودمان (ai_daily_limit) — به مدل ربطی ندارد، شامل همه است.
 *   ۳. سهمیه‌ی روزانه‌ی رایگانِ OpenRouter (ai_daily_limit_hit) — این یکی
 *      *فقط* مدل‌های رایگان را می‌خواباند، ولی قبلاً کل فراخوانی‌ها را
 *      می‌بست؛ یعنی کاربر مدل پولی می‌گذاشت و باز «سهمیه تمام شده» می‌گرفت.
 * حالا حالت ۳ تنها وقتی متوقف‌کننده است که هیچ مدل پولی‌ای در زنجیره نباشد.
 */
function isPaused(models) {
  if (Date.now() < _pausedUntil) return true;
  _rolloverIfNewDay();
  const limit = Number(settingsDB.get('ai_daily_limit', 150)) || 150;
  const used  = Number(settingsDB.get('ai_calls_used', 0)) || 0;
  if (used >= limit) return true;
  if (!settingsDB.get('ai_daily_limit_hit', false)) return false;
  return !(models || getModels()).some(m => !isFreeModel(m));
}
function _tripShort(reason) {
  _pausedUntil = Date.now() + 5 * 60 * 1000;
  console.warn(`[ai-client] circuit breaker tripped — paused 5min: ${reason}`);
}
function _isRateLimit(msg) { return /rate.?limit|429|too many requests|free-models-per-(min|day)/i.test(msg || ''); }
function _isDailyLimit(msg) { return /free-models-per-day/i.test(msg || ''); }

// ════════════════════════════════════════════════════════
//  VALIDATION HELPERS (shared across digest / timeline callers)
// ════════════════════════════════════════════════════════
function persianRatio(text) {
  if (!text) return 0;
  const stripped = text.replace(/\s/g, '');
  if (!stripped.length) return 0;
  const persianChars = stripped.match(/[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿٠-٩۰-۹]/g) || [];
  return persianChars.length / stripped.length;
}

function isChainOfThoughtJunk(text) {
  if (!text) return true;
  const lower = text.toLowerCase();
  const markers = [
    'the word', 'let me', 'actually it', 'so we', 'we need', 'we must',
    'now produce', 'but still', 'must avoid', 'we can', 'thus we',
    'note:', 'note that', 'check:', 'check for', 'check if',
    'step 1', 'step 2', 'i need', 'i should', 'i will',
    "let's", 'lets ', 'here is', 'here are', "here's",
    'you need', 'you should', 'you must', 'you can',
    'i think', 'i believe', 'in this', 'in the following',
    'first,', 'second,', 'third,', 'finally,',
    'that is', 'this is', 'this means',
  ];
  let hits = 0;
  for (const m of markers) { if (lower.includes(m)) hits++; if (hits >= 3) return true; }
  return false;
}

// Defensive JSON extractor: tolerates unquoted string/numeric keys, trailing commas, code fences.
function extractJson(text) {
  if (!text) return null;
  let s = text.trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(s); } catch (e) {}
  const start = s.search(/[[{]/);
  if (start === -1) return null;
  let open = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') open++;
    else if (c === '}' || c === ']') { open--; if (open === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  let candidate = s.slice(start, end + 1);
  candidate = candidate.replace(/([{,]\s*)(\d+|[A-Za-z_]\w*)\s*:/g, '$1"$2":');
  candidate = candidate.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(candidate); } catch (e) { return null; }
}

// ════════════════════════════════════════════════════════
//  NETWORK
// ════════════════════════════════════════════════════════
function _post(model, messages, { max_tokens = 1200, json = false } = {}) {
  const body = JSON.stringify({
    model,
    messages,
    max_tokens,
    // only send reasoning:false to models that actually accept it being disabled
    ...(REASONING_REQUIRED.has(model) ? {} : { reasoning: { enabled: false } }),
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://signalhoosh.site',
        'X-Title': 'Signal Hoosh',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

// One pass over the model list (fallback list is a safety net, not a retry loop —
// callers that want retries-with-delay, like ai-digest.js, wrap this themselves).
// `validate(text)` may return false to reject a model's output and move to the next one.
async function _run(prompt, { system, max_tokens, json, models, tag, validate } = {}) {
  if (!OPENROUTER_KEY) { console.warn(`[ai-client${tag ? '/' + tag : ''}] no OPENROUTER_KEY`); return null; }
  const chain = models || getModels();
  if (isPaused(chain)) return null;
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
  for (const model of chain) {
    // سهمیه‌ی رایگان که بسته باشد، امتحان‌کردن مدل رایگانِ بعدی فقط یک
    // فراخوانی سوخته است — همان خطا برمی‌گردد. مستقیم سراغ پولی‌های زنجیره.
    if (isFreeModel(model) && settingsDB.get('ai_daily_limit_hit', false)) continue;
    try {
      recordCall();
      const result = await _post(model, messages, { max_tokens, json });
      const text = result.choices?.[0]?.message?.content || '';
      if (!text || result.error) {
        const msg = result.error?.message || 'no output';
        // این خطا فقط مدل‌های رایگان را از کار می‌اندازد. قبلاً کل فراخوانی
        // را لغو می‌کرد و مدل پولیِ بعدیِ زنجیره هرگز امتحان نمی‌شد.
        if (_isDailyLimit(msg)) { tripDailyBudget(msg); continue; }
        if (_isRateLimit(msg)) { _tripShort(msg); continue; }
        // آخرین خطای واقعی را نگه می‌داریم؛ وگرنه صداکننده فقط null می‌بیند و
        // مجبور است پیام مبهم «خروجی معتبر نبود» بدهد، در حالی که علت واقعی
        // می‌تواند «سقف کلید تمام شده» باشد که کار کاربر را عوض می‌کند.
        _lastError = model + ': ' + msg;
        console.warn(`[ai-client${tag ? '/' + tag : ''}] ${model}: ${msg.slice(0, 120)}`);
        continue;
      }
      if (validate && !validate(text)) continue;
      console.log(`[ai-client${tag ? '/' + tag : ''}] OK with ${model}`);
      return text.trim();
    } catch (e) {
      console.warn(`[ai-client${tag ? '/' + tag : ''}] ${model} error:`, e.message);
    }
  }
  return null;
}

// Plain Persian prose. Applies the standard chain-of-thought / persian-ratio filters
// unless the caller passes its own `validate`.
async function callText(prompt, opts = {}) {
  const validate = opts.validate || (text => !isChainOfThoughtJunk(text) && persianRatio(text) >= 0.50);
  return _run(prompt, { ...opts, json: false, validate });
}

// Strict JSON. Parses defensively (unquoted keys, trailing commas, code fences).
async function callJSON(prompt, opts = {}) {
  const raw = await _run(prompt, { ...opts, json: true, validate: null });
  return raw ? extractJson(raw) : null;
}

module.exports = {
  callText, callJSON, getModels, isPaused, lastError, explainFailure,
  persianRatio, isChainOfThoughtJunk, extractJson,
  FALLBACK_MODELS, DEFAULT_PREFERRED,
};
