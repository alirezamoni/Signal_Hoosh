/**
 * lib/markdown.js — مارک‌داون بسیار محدود، برای متن وبلاگ
 *
 * چرا خودمان و نه یک کتابخانه: متن را یک مدل زبانی می‌نویسد و ادمین
 * ویرایشش می‌کند. اگر HTML خام اجازه داشت، یک <script> در خروجی مدل یا در
 * ویرایش، مستقیم روی صفحه‌ی عمومی می‌نشست. اینجا **اول همه‌چیز escape
 * می‌شود** و بعد فقط چند الگوی مشخص به تگ تبدیل می‌شوند؛ یعنی هیچ مسیری
 * برای تزریق HTML باقی نمی‌ماند و وابستگی جدیدی هم اضافه نمی‌کنیم.
 *
 * پشتیبانی: ## و ### عنوان، پاراگراف، **پررنگ**، *مورب*، [متن](نشانی)،
 * فهرست نقطه‌ای و شماره‌دار، و نقل‌قول (>).
 */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// فقط نشانی داخلی یا https بیرونی. javascript: و data: از همین‌جا رد می‌شوند.
function safeHref(url) {
  const u = String(url || '').trim();
  if (/^\//.test(u)) return u;
  if (/^https:\/\//i.test(u)) return u;
  return null;
}

function inline(text) {
  let s = esc(text);
  // پیوند — قبل از پررنگ/مورب، چون متنِ داخلش نباید دوباره پارس شود
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const href = safeHref(url);
    if (!href) return label;
    const ext = /^https:/i.test(href);
    return '<a href="' + esc(href) + '"' + (ext ? ' target="_blank" rel="noopener"' : '') + '>' + label + '</a>';
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return s;
}

function render(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [], list = null, quote = [];

  const flushPara = () => {
    if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; }
  };
  const flushList = () => {
    if (list) { out.push('<' + list.tag + '>' + list.items.map(i => '<li>' + inline(i) + '</li>').join('') + '</' + list.tag + '>'); list = null; }
  };
  const flushQuote = () => {
    if (quote.length) { out.push('<blockquote>' + inline(quote.join(' ')) + '</blockquote>'); quote = []; }
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const raw of lines) {
    const line = raw.trim();

    if (!line) { flushAll(); continue; }

    let m;
    if ((m = line.match(/^(#{2,4})\s+(.*)$/))) {
      flushAll();
      const level = Math.min(m[1].length, 4);   // h1 مال عنوان نوشته است، نه متن
      out.push('<h' + level + '>' + inline(m[2]) + '</h' + level + '>');
      continue;
    }
    if ((m = line.match(/^[-*•]\s+(.*)$/))) {
      flushPara(); flushQuote();
      if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
      list.items.push(m[1]);
      continue;
    }
    if ((m = line.match(/^\d+[.)]\s+(.*)$/))) {
      flushPara(); flushQuote();
      if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
      list.items.push(m[1]);
      continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara(); flushList();
      quote.push(m[1]);
      continue;
    }
    flushList(); flushQuote();
    para.push(line);
  }
  flushAll();
  return out.join('\n');
}

// متن ساده برای excerpt/توضیحات متا — بدون هیچ نشانه‌گذاری
function plain(md, max) {
  const s = String(md || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*>`_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!max || s.length <= max) return s;
  return s.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

module.exports = { render, plain, esc };
