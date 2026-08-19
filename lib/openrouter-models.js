/**
 * openrouter-models.js — فهرست مدل‌های OpenRouter برای پنل مدیریت
 *
 * فهرست روی دیسک کش می‌شود، چون ~۴۰۰ مدل است و نباید با هر بار باز کردن
 * پنل یک درخواست شبکه بخورد. اگر کش کهنه بود، در پس‌زمینه تازه می‌شود و
 * همان نسخه‌ی قبلی بی‌درنگ به کاربر داده می‌شود — پنل هرگز منتظر شبکه نمی‌ماند.
 * اگر واکشی شکست خورد، آخرین نسخه‌ی موفق سر جایش می‌ماند.
 */
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'openrouter-models.json');
const API_URL = 'https://openrouter.ai/api/v1/models';
const MAX_AGE_MS = 12 * 3600 * 1000;   // نصف روز

let refreshing = false;

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch (e) { return null; }
}

function writeCache(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
  } catch (e) { console.warn('[openrouter] کش نوشته نشد:', e.message); }
}

// قیمت‌ها در پاسخ OpenRouter رشته و «به ازای هر توکن» هستند؛
// برای خواندن انسان تبدیل به «دلار به ازای یک میلیون توکن» می‌شوند.
function perMillion(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1e6 * 1000) / 1000;
}

/**
 * مدل باید هم متن بگیرد هم متن بدهد. OpenRouter این را در architecture
 * می‌دهد؛ اگر نداشت، محافظه‌کارانه قبولش می‌کنیم تا مدل سالمی به‌خاطر
 * فیلد گمشده حذف نشود.
 */
function isTextModel(m) {
  const a = m.architecture || {};
  const inp = a.input_modalities, out = a.output_modalities;
  // خروجی باید منحصراً متن باشد — مدلی با خروجی صدا یا تصویر مدل چت نیست
  if (Array.isArray(out) && out.length && out.some(x => String(x) !== 'text')) return false;
  if (Array.isArray(inp) && inp.length && !inp.some(x => String(x).includes('text'))) return false;
  // شکل قدیمی: "text->text" یا "text+image->text"
  const mod = a.modality;
  if (typeof mod === 'string' && mod.includes('->')) {
    const [i, o] = mod.split('->');
    if (o.trim() !== 'text' || !i.includes('text')) return false;
  }
  return true;
}

function normalize(raw) {
  const models = (raw || []).filter(isTextModel).map(m => {
    const inM  = perMillion(m.pricing && m.pricing.prompt);
    const outM = perMillion(m.pricing && m.pricing.completion);
    return {
      id: m.id,
      name: m.name || m.id,
      free: inM === 0 && outM === 0,
      inM, outM,
      ctx: m.context_length || null,
      mod: (m.architecture && (m.architecture.modality || (m.architecture.output_modalities || []).join('+'))) || null,
    };
  }).filter(m => m.id);

  // رایگان‌ها اول (به ترتیب الفبا)، بعد پولی‌ها از ارزان به گران
  models.sort((a, b) => {
    if (a.free !== b.free) return a.free ? -1 : 1;
    if (a.free) return a.id.localeCompare(b.id);
    return (a.inM - b.inM) || a.id.localeCompare(b.id);
  });
  return models;
}

async function fetchFromApi() {
  const key = require('./openrouter-key').get();
  const res = await fetch(API_URL, {
    headers: key ? { Authorization: 'Bearer ' + key } : {},
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const models = normalize(json.data);
  if (!models.length) throw new Error('پاسخ خالی بود');
  return { fetchedAt: new Date().toISOString(), models };
}

async function refresh() {
  const data = await fetchFromApi();
  writeCache(data);
  return data;
}

function isStale(cache) {
  if (!cache || !cache.fetchedAt) return true;
  return Date.now() - new Date(cache.fetchedAt).getTime() > MAX_AGE_MS;
}

/**
 * فهرست را همیشه بی‌درنگ برمی‌گرداند (بدون await).
 * اگر کهنه بود، تازه‌سازی در پس‌زمینه شروع می‌شود و دفعه‌ی بعد اثر می‌کند.
 */
function list() {
  const cache = readCache();
  if (isStale(cache) && !refreshing) {
    refreshing = true;
    refresh()
      .then(() => console.log('[openrouter] فهرست مدل‌ها تازه شد'))
      .catch(e => console.warn('[openrouter] تازه‌سازی ناموفق:', e.message))
      .finally(() => { refreshing = false; });
  }
  return cache || { fetchedAt: null, models: [] };
}

/** آیا این شناسه یک مدل واقعی است؟ اگر کش خالی باشد سخت‌گیری نمی‌کنیم. */
function isKnown(id) {
  const c = readCache();
  if (!c || !c.models.length) return true;
  return c.models.some(m => m.id === id);
}

module.exports = { list, refresh, isKnown };
