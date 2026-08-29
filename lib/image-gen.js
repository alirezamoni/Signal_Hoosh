/**
 * lib/image-gen.js — تولید تصویر با OpenRouter
 *
 * تنها جای فراخوانی https://openrouter.ai/api/v1/images در کل پروژه.
 *
 * چند نکته که از آزمایش واقعی روی همین سرور درآمد و در کد لحاظ شده‌اند:
 *
 * ۱. این اندپوینت با /api/v1/chat/completions فرق دارد. مدل‌های تصویر در
 *    فهرست مدل‌های چت نیستند (lib/openrouter-images.js را ببینید).
 * ۲. تولید هر تصویر حدود ۱۲۰ ثانیه طول می‌کشد. مهلت پیش‌فرض fetch برای
 *    این کار کم است، پس مهلت صریح ۴ دقیقه گذاشته شده.
 * ۳. هر تصویر حدود ۰٫۱۵ دلار خرج دارد. هزینه‌ی هر فراخوانی از پاسخ
 *    خوانده و لاگ می‌شود تا مصرف قابل ردیابی باشد.
 * ۴. پاسخ base64 است (data[0].b64_json) نه URL — یعنی فایل روی سرور
 *    خودمان ذخیره می‌شود، مطابق همان قاعده‌ی همیشگی پروژه که هیچ رسانه‌ای
 *    hotlink نمی‌شود.
 */
const orKey = require('./openrouter-key');
const settingsDB = require('../settings-db');

const API_URL = 'https://openrouter.ai/api/v1/images';
const DEFAULT_MODEL = 'sourceful/riverflow-v2.5-pro';
const TIMEOUT_MS = 4 * 60 * 1000;

const EXT_BY_TYPE = {
  'image/webp': 'webp',
  'image/png':  'png',
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',
  'image/gif':  'gif',
};

function getModel() {
  return String(settingsDB.get('ai_model_image', '') || '').trim() || DEFAULT_MODEL;
}

let _lastError = '';
function lastError() { return _lastError; }

/**
 * @param {string} prompt متن کامل پرامپت (پرامپت طراحی + داده‌ها)
 * @param {object} [opts] resolution / aspect_ratio / background / output_format / model
 * @returns {Promise<{ok:boolean, buf?:Buffer, ext?:string, mediaType?:string,
 *                    model?:string, cost?:number, ms?:number, reason?:string}>}
 */
async function generate(prompt, opts) {
  const o = opts || {};
  const model = String(o.model || getModel()).trim();
  const key = orKey.get();

  _lastError = '';
  if (!key) { _lastError = 'کلید OpenRouter تنظیم نشده'; return { ok: false, reason: _lastError }; }
  if (!prompt || String(prompt).trim().length < 20) {
    _lastError = 'پرامپت تصویر خالی یا خیلی کوتاه است';
    return { ok: false, reason: _lastError };
  }

  const body = {
    model,
    prompt: String(prompt),
    resolution:    o.resolution    || '1K',
    aspect_ratio:  o.aspect_ratio  || '16:9',
    background:    o.background    || 'auto',
    output_format: o.output_format || 'webp',
  };

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://signalhoosh.site',
        'X-Title': 'Signal Hoosh',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // TimeoutError پیام مفیدی ندارد؛ به فارسیِ قابل‌فهم ترجمه می‌شود
    _lastError = /timeout|abort/i.test(e.name + ' ' + e.message)
      ? `مدل ${model} در ${TIMEOUT_MS / 60000} دقیقه پاسخ نداد`
      : 'خطای شبکه: ' + e.message;
    return { ok: false, reason: _lastError };
  }

  const ms = Date.now() - t0;
  const txt = await res.text();

  if (!res.ok) {
    let detail = txt.slice(0, 300);
    try { const j = JSON.parse(txt); detail = (j.error && (j.error.message || j.error)) || detail; } catch (e) {}
    if (res.status === 402) _lastError = 'اعتبار OpenRouter کافی نیست — ' + detail;
    else if (res.status === 401) _lastError = 'کلید OpenRouter پذیرفته نشد';
    else if (res.status === 404) _lastError = `مدل «${model}» شناخته نشد — از فهرست مدل‌های تصویر یکی را انتخاب کنید`;
    else if (res.status === 429) _lastError = 'محدودیت نرخ OpenRouter — کمی بعد دوباره';
    else _lastError = `HTTP ${res.status}: ${detail}`;
    return { ok: false, reason: _lastError, ms };
  }

  let j;
  try { j = JSON.parse(txt); } catch (e) {
    _lastError = 'پاسخ JSON معتبر نبود';
    return { ok: false, reason: _lastError, ms };
  }

  const d = (j.data || [])[0] || {};
  const b64 = d.b64_json || d.image_base64 || null;
  if (!b64) {
    _lastError = d.url ? 'مدل به‌جای فایل، آدرس برگرداند' : 'پاسخ تصویری نداشت';
    return { ok: false, reason: _lastError, ms };
  }

  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) { _lastError = 'تصویر خالی بود'; return { ok: false, reason: _lastError, ms }; }

  const mediaType = String(d.media_type || 'image/webp').toLowerCase();
  const cost = (j.usage && Number(j.usage.cost)) || 0;
  console.log(`[image-gen] ${model} — ${Math.round(buf.length / 1024)}KB، ${Math.round(ms / 1000)}s، ${cost.toFixed(4)}$`);

  return {
    ok: true, buf, mediaType,
    ext: EXT_BY_TYPE[mediaType] || 'webp',
    model, cost, ms,
  };
}

module.exports = { generate, getModel, lastError, DEFAULT_MODEL, EXT_BY_TYPE };
