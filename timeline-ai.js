/**
 * timeline-ai.js — shared OpenRouter helper for the Causal Discovery Engine.
 *
 * RULES (§1.3):
 *  1. Re-read the user's chosen model from settings BEFORE every call. Never cache.
 *  2. Fallback list is a SAFETY NET only; never hardcode a preferred model.
 *  3. Log which model served each call.
 *  4. NEVER use openrouter/auto. Endpoint fixed.
 *  5. Two output kinds: narrative (Persian prose) AND structured (strict JSON).
 *
 * NOTE on fallback list: the spec (§1.3) lists models the project has since retired
 * (tencent/hy3, llama-3.3, gemma-4-31b…). We follow the live repo fallback list used by
 * ai-digest.js / server.js (gemma-4-26b, nemotron-3 family, gpt-oss-20b) so we never
 * request a model OpenRouter no longer serves.
 */
const https = require('https');
const settingsDB = require('./settings-db');

const OPENROUTER_KEY = process.env.OPENROUTER_KEY || '';
const DEFAULT_PREFERRED = 'google/gemma-4-26b-a4b-it:free';

// Live repo fallback list (matches ai-digest.js / server.js FREE_DEFAULTS)
const FALLBACK_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'openai/gpt-oss-20b:free',
];

// RULE 1 + RULE 2: read fresh every call; preferred first, fallback is safety net.
// The timeline engine has its OWN optional model (timeline_ai_model); if empty,
// it falls back to the general ai_model. Both are re-read fresh per call.
function getModels() {
  const general = settingsDB.get('ai_model', DEFAULT_PREFERRED);
  const tlPref = settingsDB.get('timeline_ai_model', '');
  const preferred = (tlPref && tlPref.length) ? tlPref : general;
  return [preferred, ...FALLBACK_MODELS.filter(m => m !== preferred)];
}

// Which model actually served (for logging/display). Returns the resolved preferred.
function resolvedModel() {
  const general = settingsDB.get('ai_model', DEFAULT_PREFERRED);
  const tlPref = settingsDB.get('timeline_ai_model', '');
  return (tlPref && tlPref.length) ? tlPref : general;
}

// ── pre-validation filters (mirror ai-digest.js) ──
function persianRatio(text) {
  if (!text) return 0;
  const stripped = text.replace(/\s/g, '');
  if (!stripped.length) return 0;
  const persianChars = stripped.match(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF\u0660-\u0669\u06F0-\u06F9]/g) || [];
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

function _post(model, messages, { max_tokens = 1200, json = false } = {}) {
  const body = JSON.stringify({
    model,
    messages,
    max_tokens,
    reasoning: { enabled: false },
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://signal.ir',
        'X-Title': 'Signal Hoosh Timeline',
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

// Narrative call: Persian prose for humans. Validates persianRatio + chain-of-thought.
async function callNarrative(prompt, system) {
  if (!OPENROUTER_KEY) { console.warn('[tl-ai] no OPENROUTER_KEY'); return null; }
  for (const model of getModels()) {
    try {
      const result = await _post(model, [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ], { max_tokens: 1200 });
      const text = result.choices?.[0]?.message?.content || '';
      if (!text || result.error) { console.warn(`[tl-ai] ${model}: ${result.error?.message?.slice(0,60) || 'no output'}`); continue; }
      if (isChainOfThoughtJunk(text)) { console.warn(`[tl-ai] ${model}: chain-of-thought leak, skipping`); continue; }
      if (persianRatio(text) < 0.50) { console.warn(`[tl-ai] ${model}: persian ratio low, skipping`); continue; }
      console.log(`[tl-ai] narrative OK with ${model}`);
      return text.trim();
    } catch (e) { console.warn(`[tl-ai] ${model} error:`, e.message); }
  }
  return null;
}

// Defensive JSON extractor: tolerate unquoted keys, trailing commas, code fences.
function extractJson(text) {
  if (!text) return null;
  let s = text.trim();
  // strip code fences
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  // direct parse first
  try { return JSON.parse(s); } catch (e) {}
  // extract first {...} or [...]
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
  // tolerate unquoted keys: {foo: 1} -> {"foo": 1}
  candidate = candidate.replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":');
  // remove trailing commas
  candidate = candidate.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(candidate); } catch (e) { return null; }
}

// Structured call: strict JSON for DB. Requests JSON-only, parses defensively.
async function callStructured(prompt, system) {
  if (!OPENROUTER_KEY) { console.warn('[tl-ai] no OPENROUTER_KEY'); return null; }
  for (const model of getModels()) {
    try {
      const result = await _post(model, [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ], { max_tokens: 900, json: true });
      const text = result.choices?.[0]?.message?.content || '';
      if (!text || result.error) { console.warn(`[tl-ai/json] ${model}: ${result.error?.message?.slice(0,60) || 'no output'}`); continue; }
      const parsed = extractJson(text);
      if (!parsed) { console.warn(`[tl-ai/json] ${model}: unparseable, skipping`); continue; }
      console.log(`[tl-ai/json] structured OK with ${model}`);
      return parsed;
    } catch (e) { console.warn(`[tl-ai/json] ${model} error:`, e.message); }
  }
  return null;
}

module.exports = { callNarrative, callStructured, getModels, resolvedModel, persianRatio, isChainOfThoughtJunk, extractJson, FALLBACK_MODELS };
