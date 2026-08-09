/**
 * lib/clean-text.js — پاک‌سازی متن پیام تلگرام برای نمایش و سئو
 *
 * متن کانال‌ها پر از مارکداون (**بولد**)، ایموجی پرچم، امضای کانال
 * (@channel | #tag) و فاصله‌ی اضافه است. اگر خام در <title> و
 * meta description برود، نتیجه‌ی گوگل زشت و بی‌اعتبار می‌شود.
 */

// ایموجی و نمادهای تزئینی (پرچم، فلش، علامت‌های تلگرامی)
const EMOJI = /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE0F}\u{20E3}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}]/gu;

/**
 * حذف مارکداون و نویز — برای عنوان و توضیحات
 */
function clean(s) {
  if (!s) return '';
  let t = String(s);

  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');   // [متن](لینک) → متن
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');          // **بولد**
  t = t.replace(/__([^_]+)__/g, '$1');              // __ایتالیک__
  t = t.replace(/~~([^~]+)~~/g, '$1');              // ~~خط‌خورده~~
  t = t.replace(/`{1,3}([^`]*)`{1,3}/g, '$1');      // `کد`
  t = t.replace(/^>\s?/gm, '');                     // نقل‌قول
  t = t.replace(/\*+/g, ' ');                       // ستاره‌های یتیم
  t = t.replace(/_{2,}/g, ' ');

  t = t.replace(/https?:\/\/\S+/g, ' ');            // لینک خام
  t = t.replace(/@[\w؀-ۿ_]+/g, ' ');      // @کانال
  t = t.replace(/#[\w؀-ۿ_]+/g, ' ');      // #هشتگ
  t = t.replace(/\|/g, ' ');

  t = t.replace(EMOJI, ' ');
  t = t.replace(/[‌‏‎]/g, ' ');      // نیم‌فاصله و کنترل جهت
  t = t.replace(/[«»""'']/g, '"');
  t = t.replace(/\s*[-–—•·]{2,}\s*/g, ' ');
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/^[\s:،,.\-–—]+|[\s:،,\-–—]+$/g, '');

  return t.trim();
}

/**
 * عنوان خبر — اولین جمله‌ی معنادار
 */
function headline(text, max = 110) {
  const t = clean(text);
  if (!t) return 'خبر';
  // تا اولین نقطه‌ی پایان جمله، اگر طول معقولی داشت
  const m = t.match(/^(.{25,}?)(?:[.!?؟\n]|$)/);
  let h = m ? m[1] : t;
  if (h.length > max) h = h.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return h.trim() || 'خبر';
}

/**
 * توضیحات متا — بدون بریدن وسط کلمه
 */
function description(text, max = 155) {
  const t = clean(text);
  if (!t) return 'خبر منتشرشده در کانال‌های عمومی تلگرام — سیگنال هوش';
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

/**
 * پاراگراف‌های بدنه — مارکداون پاک ولی ساختار خطوط حفظ می‌شود
 */
function paragraphs(text) {
  if (!text) return [];
  return String(text)
    .split(/\n{2,}|\n/)
    .map(p => clean(p))
    .filter(p => p && p.length > 1);
}

module.exports = { clean, headline, description, paragraphs };
