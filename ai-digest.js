/**
 * ai-digest.js — تحلیل هوشمند ترندها سمت سرور
 * ۴h: هر ۱۵ دقیقه، ۳ بار تلاش
 * ۲۴h: هر ۳ ساعت، ۳ بار تلاش
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const settingsDB = require('./settings-db');

const DATA_DIR = path.join(__dirname, 'data');
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || '';

const FREE_MODELS = [
  'openai/gpt-oss-20b:free',
  'tencent/hy3:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'nousresearch/hermes-3-llama-3.1-405b:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'meta-llama/llama-3.2-3b-instruct:free',
  'poolside/laguna-m.1:free',
];

function getModels() {
  const preferred = settingsDB.get('ai_model', 'openai/gpt-oss-20b:free');
  return [preferred, ...FREE_MODELS.filter(m => m !== preferred)];
}

const DIGEST_FILES = {
  '4h':  path.join(DATA_DIR, 'digest_4h.json'),
  '24h': path.join(DATA_DIR, 'digest_24h.json'),
};

function loadTrends(key) {
  try {
    const file = path.join(DATA_DIR, `${key}.json`);
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, 'utf8')).trends || [];
  } catch(e) { return []; }
}

function buildItems(trends, count) {
  return trends.slice(0, count).map((t, i) => {
    const kw = (t.keyword || '').replace(/[\u200f\u200e]/g, '').trim();
    return `${i+1}. ${kw} | حجم: ${t.vol||0}+ | رشد: ${t.growth||0}٪`;
  }).join('\n');
}

function buildPrompt4h(items) {
  return `پاسخت را فقط به زبان فارسی بنویس. بدون هیچ مقدمه یا معرفی، مستقیم تحلیل را شروع کن.
داده‌های ترندهای جستجوی ۴ ساعت اخیر ایرانی ها در گوگل هست احتمالا چیز هایی که به گوششون رسیده و یا در این ۴ ساعت براشون مهم بوده یعنی در اخبار، تلوزیون یا دهان به دهان و یا سوشال مدیا دیدن و ترند شده و دوست داشتن بیشتر درموردش بدونن:
${items}
---
خروجی را در قالب ۵ جمله کوتاه و دقیق بنویس:
۱. **سیگنال اقتصادی**: مهم‌ترین تغییر رفتاری مرتبط با اقتصاد (با اشاره به شدت و جهت)
۲. **دغدغه غالب جامعه**: الان مردم بیشتر درگیر چه مسئله‌ای هستند؟
۳. **ناهنجاری یا اتفاق غیرعادی**: اگر ترندی غیرمنتظره یا جهشی وجود دارد توضیح بده
۴. **فرضیه محرک**: چه رویداد یا خبر احتمالی می‌تواند پشت این رفتار باشد؟
۵. **جمع‌بندی یک‌خطی**: وضعیت ۴ ساعت اخیر ایران را در یک جمله دقیق خلاصه کن
---
قوانین: فقط بر اساس داده تحلیل کن | هیچ کلمه انگلیسی در خروجی نیاور | خلاصه و تیز بنویس`;
}

function buildPrompt24h(items) {
  return `پاسخت را فقط به زبان فارسی بنویس. بدون هیچ مقدمه یا معرفی، مستقیم تحلیل را شروع کن.
داده‌های ترندهای جستجوی ۲۴ ساعت اخیر ایرانی ها در گوگل هست احتمالا چیز هایی که در این ۲۴ ساعت براشون مهم بوده یا ترند شده و دوست داشتن بیشتر درموردش بدونن:
${items}
---
خروجی را در قالب ۵ جمله کوتاه و دقیق بنویس:
۱. **سیگنال اقتصادی روز**: مهم‌ترین تغییر رفتاری مرتبط با اقتصاد
۲. **دغدغه غالب جامعه**: امروز مردم بیشتر درگیر چه مسئله‌ای بودند؟
۳. **ناهنجاری یا اتفاق غیرعادی**: ترندی غیرمنتظره یا جهشی
۴. **فرصت یا ریسک**: یک insight برای استارتاپ‌ها یا سرمایه‌گذاران
۵. **جمع‌بندی روز**: یک جمله دقیق درباره وضعیت امروز ایران
---
قوانین: فقط بر اساس داده تحلیل کن | هیچ کلمه انگلیسی در خروجی نیاور | خلاصه و تیز بنویس`;
}

async function callAI(prompt) {
  const freeModels = getModels();
  for (const model of freeModels) {
    try {
      const body = JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 2000 });
      const result = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENROUTER_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://signal.ir',
            'X-Title': 'Signal Hoosh',
            'Content-Length': Buffer.byteLength(body),
          },
        }, res => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
        req.write(body); req.end();
      });
      const text = result.choices?.[0]?.message?.content || '';
      if (!text || result.error) { console.warn(`[digest] ${model}: ${result.error?.message?.slice(0,50)||'no output'}`); continue; }
      console.log(`[digest] OK with ${model}`);
      return text;
    } catch(e) {
      console.warn(`[digest] ${model} error:`, e.message);
    }
  }
  return null;
}

function isComplete(text) {
  if (!text || text.length < 100) return false;
  const t = text.trim();
  return /[.!?۔]$/.test(t);
}

function faCleaned(text) {
  // پاک‌سازی markdown
  return text
    .replace(/\*\*(.+?)\*\*/g, '**$1**') // نگه دار برای فرانت
    .trim();
}

// ۳ بار تلاش با فاصله ۱ دقیقه، کامل‌ترین نسخه فارسی رو انتخاب
async function fetchWithRetry(promptFn, trendsKey, count, retries = 3) {
  const trends = loadTrends(trendsKey);
  if (!trends.length) { console.log(`[digest] no trends for ${trendsKey}`); return null; }
  const items = buildItems(trends, count);
  const prompt = promptFn(items);

  for (let i = 0; i < retries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 60 * 1000));
    console.log(`[digest/${trendsKey}] attempt ${i+1}/${retries}...`);
    try {
      const text = await callAI(prompt);
      if (!text) continue;
      const engRatio = (text.match(/[a-zA-Z]/g)||[]).length / text.replace(/\s/g,'').length;
      const complete = isComplete(text);
      const score = (complete ? 100 : 0) + (1 - engRatio) * 50 + text.length * 0.01;
      console.log(`[digest/${trendsKey}] attempt ${i+1}: len=${text.length} complete=${complete} score=${score.toFixed(0)}`);
      if (score > 50) return faCleaned(text);
    } catch(e) {
      console.warn(`[digest/${trendsKey}] attempt ${i+1} error:`, e.message);
    }
  }
  return null;
}

function saveDigest(key, text) {
  const payload = { text, updatedAt: new Date().toISOString() };
  fs.writeFileSync(DIGEST_FILES[key], JSON.stringify(payload));
  console.log(`[digest/${key}] saved (${text.length} chars)`);
}

function loadDigest(key) {
  try {
    if (!fs.existsSync(DIGEST_FILES[key])) return null;
    return JSON.parse(fs.readFileSync(DIGEST_FILES[key], 'utf8'));
  } catch(e) { return null; }
}

async function refresh4h() {
  console.log('\n[digest/4h] refreshing...');
  const text = await fetchWithRetry(buildPrompt4h, 'h4', 20, 3);
  if (text) saveDigest('4h', text);
}

async function refresh24h() {
  console.log('\n[digest/24h] refreshing...');
  const text = await fetchWithRetry(buildPrompt24h, 'h24', 25, 3);
  if (text) saveDigest('24h', text);
}

function startDigestScheduler() {
  if (!OPENROUTER_KEY) { console.log('[digest] no OPENROUTER_KEY, skipping'); return; }

  // اجرای اولیه بعد از ۳۰ ثانیه
  setTimeout(() => {
    refresh4h();
    refresh24h();
  }, 30000);

  // ۴h: هر ۱۵ دقیقه
  setInterval(refresh4h, 15 * 60 * 1000);
  // ۲۴h: هر ۳ ساعت
  setInterval(refresh24h, 3 * 60 * 60 * 1000);

  console.log('[digest] scheduler started — 4h:15min, 24h:3h');
}

module.exports = { startDigestScheduler, loadDigest, refresh4h, refresh24h };
