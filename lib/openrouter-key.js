/**
 * lib/openrouter-key.js — تنها جای خواندن کلید OpenRouter.
 *
 * کلید در data/settings.json نگه داشته می‌شود (که کل پوشه‌اش در .gitignore
 * است) و از بخش «هوش مصنوعی» پنل مدیریت وارد می‌شود — نه در کد، نه در ریپو.
 * .env فقط پشتیبانِ عقب‌گرد است تا اگر تنظیمات خالی بود سرویس نخوابد.
 *
 * ⚠️ همیشه get() را سرِ هر فراخوانی صدا بزنید، نه یک بار موقع لود ماژول.
 * قبلاً هر فایل کلید را با `const K = process.env.OPENROUTER_KEY` در بالای
 * خودش می‌خواند؛ نتیجه این بود که عوض‌کردن کلید تا ری‌استارت کامل پروسه
 * هیچ اثری نداشت — دقیقاً همان چیزی که موقع لو رفتن کلید نباید اتفاق بیفتد.
 */
const settingsDB = require('../settings-db');

function fromPanel() {
  return String(settingsDB.get('openrouter_key', '') || '').trim();
}

function get() {
  return fromPanel() || String(process.env.OPENROUTER_KEY || '').trim();
}

/** کلید از کجا می‌آید — برای نمایش وضعیت در پنل */
function source() {
  if (fromPanel()) return 'panel';
  if (String(process.env.OPENROUTER_KEY || '').trim()) return 'env';
  return 'none';
}

/**
 * فقط برای نمایش. کلید کامل هرگز نباید به قالب، لاگ یا پاسخ HTTP برود —
 * پنل هم پشت لاگین است ولی یک اسکرین‌شات کافی است تا دوباره لو برود.
 */
function mask(k) {
  const s = String(k == null ? get() : k).trim();
  if (!s) return '';
  if (s.length <= 12) return '••••';
  return s.slice(0, 8) + '…' + s.slice(-4);
}

module.exports = { get, source, mask };
