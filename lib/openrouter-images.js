/**
 * lib/openrouter-images.js — فهرست مدل‌های تولید تصویرِ OpenRouter
 *
 * ⚠️ این فهرست از /api/v1/models نمی‌آید و نباید بیاید.
 * آن اندپوینت فقط مدل‌های چت را برمی‌گرداند؛ مدل‌های تصویرسازِ اختصاصی
 * اصلاً در آن نیستند. آزمایش شد: sourceful/riverflow-v2.5-pro روی
 * /api/v1/images کار می‌کند و تصویر سالم می‌دهد، ولی در پاسخِ
 * /api/v1/models وجود ندارد. یعنی اگر مدل تصویر را با
 * openrouter-models.isKnown() اعتبارسنجی کنیم، مدلِ درست را رد می‌کنیم.
 * اندپوینت درست /api/v1/images/models است (۴۸ مدل).
 *
 * الگوی کش عیناً همان openrouter-models.js است: پنل هرگز منتظر شبکه
 * نمی‌ماند و اگر واکشی شکست بخورد آخرین نسخه‌ی موفق سر جایش می‌ماند.
 */
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'openrouter-image-models.json');
const API_URL = 'https://openrouter.ai/api/v1/images/models';
const MAX_AGE_MS = 12 * 3600 * 1000;

/** اگر واکشی هرگز موفق نشد، دست‌کم چند مدلِ تأییدشده در فهرست باشد */
const FALLBACK = [
  'sourceful/riverflow-v2.5-pro',
  'sourceful/riverflow-v2.5-fast',
  'google/gemini-3-pro-image',
  'google/gemini-3.1-flash-image',
  'openai/gpt-image-2',
  'bytedance-seed/seedream-5-0-pro',
];

let refreshing = false;

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch (e) { return null; }
}

function writeCache(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
  } catch (e) { console.warn('[or-images] کش نوشته نشد:', e.message); }
}

/**
 * شکل دقیق هر ردیف در این اندپوینت مستند نیست و ممکن است تغییر کند، پس
 * فقط id لازم است و بقیه‌ی فیلدها اختیاری‌اند. قیمت اینجا «به ازای هر
 * تصویر» است نه هر توکن — همان چیزی که ادمین باید ببیند، چون هر تصویر
 * حدود ۰٫۱۵ دلار خرج دارد و این عدد باید جلوی چشم باشد.
 */
function normalize(raw) {
  const out = [];
  for (const m of (raw || [])) {
    const id = typeof m === 'string' ? m : (m && (m.id || m.slug || m.name));
    if (!id) continue;
    const p = (m && m.pricing) || {};
    const per = Number(p.image != null ? p.image : (p.per_image != null ? p.per_image : p.output));
    out.push({
      id: String(id),
      name: (m && m.name) || String(id),
      perImage: isFinite(per) && per > 0 ? per : null,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

async function fetchFromApi() {
  const key = require('./openrouter-key').get();
  const res = await fetch(API_URL, {
    headers: key ? { Authorization: 'Bearer ' + key } : {},
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const models = normalize(json.data || json.models || json);
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

/** بی‌درنگ برمی‌گردد؛ اگر کهنه بود در پس‌زمینه تازه می‌شود. */
function list() {
  const cache = readCache();
  if (isStale(cache) && !refreshing) {
    refreshing = true;
    refresh()
      .then(d => console.log('[or-images] فهرست مدل‌های تصویر تازه شد —', d.models.length, 'مدل'))
      .catch(e => console.warn('[or-images] تازه‌سازی ناموفق:', e.message))
      .finally(() => { refreshing = false; });
  }
  if (cache && cache.models && cache.models.length) return cache;
  return { fetchedAt: null, models: FALLBACK.map(id => ({ id, name: id, perImage: null })) };
}

/** اگر کش خالی است سخت‌گیری نمی‌کنیم — مدل سالم نباید قربانی کشِ نیامده شود. */
function isKnown(id) {
  const c = readCache();
  if (!c || !c.models || !c.models.length) return true;
  return c.models.some(m => m.id === id);
}

module.exports = { list, refresh, isKnown, FALLBACK };
