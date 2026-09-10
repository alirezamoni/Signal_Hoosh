/**
 * lib/tg-digest.js — گزارش روزانه در کانال تلگرام.
 *
 * چرا این ماژول وجود دارد: تا امروز تنها راه رسیدن کاربر به سایت، گوگل بود.
 * یعنی هر تغییر الگوریتم مستقیم روی ترافیک می‌نشست و هیچ مخاطبِ مستقیمی
 * وجود نداشت. کانال تلگرام تنها کانالی است که در ایران هم مؤثر است و هم
 * به رتبه‌ی جست‌وجو وابسته نیست.
 *
 * ⚠️ این ماژول از Bot API استفاده می‌کند، نه اکانت شخصی. اکانت شخصی
 * (lib/tg-outbox.js) نشستِ Telethon را در دست دارد و کارش بکاپ است؛
 * انتشار روزانه با آن یعنی همان الگویی که FloodWait می‌گیرد، روی همان
 * اکانتی که خبر را می‌آورد.
 *
 * پیش‌نیاز: ربات باید در کانال مقصد ادمین با اجازه‌ی «ارسال پیام» باشد.
 * تا وقتی نباشد، ارسال با خطای واضح در تنظیمات ثبت می‌شود و چیزی نمی‌شکند.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const SETTINGS = path.join(DATA, 'settings.json');
const STATE = path.join(DATA, 'tg-digest.json');
const SITE = 'https://signalhoosh.site';

// مخاطب این کانال در ایران است، پس ساعت انتشار به وقت تهران حساب می‌شود
// نه به وقت سرور (لندن) و نه به وقت گرداننده.
const TZ = 'Asia/Tehran';

function readJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }
function writeJSON(f, v) { try { fs.writeFileSync(f, JSON.stringify(v, null, 1)); } catch (e) {} }

function settings() { return readJSON(SETTINGS, {}) || {}; }

function saveSetting(k, v) {
  const s = settings();
  s[k] = v;
  writeJSON(SETTINGS, s);
}

const FA = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
const fa = s => String(s).replace(/\d/g, d => FA[+d]);
const group = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '٬');

/** قیمت را با واحد خودش نشان می‌دهد؛ ریال به تومان تبدیل می‌شود. */
function money(row) {
  const p = Number(row.price);
  if (!Number.isFinite(p)) return null;
  if (String(row.unit || '').indexOf('ریال') !== -1) return fa(group(p / 10)) + ' تومان';
  if (row.symbol === 'ounce') return fa(group(p)) + ' دلار';
  return fa(group(p));
}

function arrow(pct) {
  const v = Number(pct);
  if (!Number.isFinite(v) || v === 0) return '';
  // جداکنندهٔ اعشار فارسی «٫» است؛ نقطه‌ی لاتین کنار ارقام فارسی بد می‌نشیند
  return (v > 0 ? ' 🔺' : ' 🔻') + fa(Math.abs(v).toFixed(1)).replace('.', '٫') + '٪';
}

function todayFa() {
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long'
    }).format(new Date());
  } catch (e) { return ''; }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** متن گزارش. اگر هیچ داده‌ای نبود null برمی‌گرداند تا پیام خالی نرود. */
function build() {
  const lines = [];
  lines.push('📊 <b>سیگنال هوش</b> — ' + esc(todayFa()));

  // ── بازار ──
  const WANT = ['usd', 'coin', 'gold18', 'ounce'];
  let fin = [];
  try { fin = require(path.join(ROOT, 'finance-db')).getLatest() || []; } catch (e) {}
  const bySym = {};
  for (const r of fin) bySym[r.symbol] = r;
  const priceLines = [];
  for (const sym of WANT) {
    const r = bySym[sym];
    if (!r) continue;
    const m = money(r);
    if (!m) continue;
    priceLines.push('• ' + esc(r.name || sym) + ': <b>' + m + '</b>' + arrow(r.change_pct));
  }
  if (priceLines.length) {
    lines.push('');
    lines.push('💵 <b>بازار</b>');
    lines.push(priceLines.join('\n'));
  }

  // ── پرجست‌وجوترین‌ها ──
  try {
    const idx = require(path.join(ROOT, 'trend-db')).getKeywordIndex() || [];
    const top = idx.slice(0, 5).map(k => esc(k.keyword)).filter(Boolean);
    if (top.length) {
      lines.push('');
      lines.push('🔎 <b>پرجست‌وجوترین‌های امروز</b>');
      lines.push(top.map(t => '• ' + t).join('\n'));
    }
  } catch (e) {}

  // ── تحلیل روز ──
  try {
    const posts = require(path.join(ROOT, 'blog-db')).listPublished(1, 0) || [];
    if (posts.length) {
      const p = posts[0];
      lines.push('');
      lines.push('📝 <b>تحلیل امروز</b>');
      lines.push('<a href="' + SITE + '/blog/' + encodeURIComponent(p.slug) + '">' + esc(p.title) + '</a>');
    }
  } catch (e) {}

  if (lines.length < 2) return null;

  lines.push('');
  lines.push('👈 <a href="' + SITE + '/">همه‌ی داده‌ها در سیگنال هوش</a>');
  return lines.join('\n');
}

function botToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN.trim();
  try {
    const m = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch (e) { return ''; }
}

function channel() {
  return String(settings().tg_public_channel || '@signalHoosh').trim();
}

/** ارسال خام. خطای تلگرام عیناً برگردانده می‌شود تا در پنل دیده شود. */
function send(text) {
  const token = botToken(), chat = channel();
  if (!token) return Promise.resolve({ ok: false, error: 'TELEGRAM_BOT_TOKEN تنظیم نشده' });
  if (!chat) return Promise.resolve({ ok: false, error: 'کانال مقصد تنظیم نشده' });

  const body = JSON.stringify({
    chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: false,
  });
  return new Promise(resolve => {
    const req = https.request({
      host: 'api.telegram.org', path: '/bot' + token + '/sendMessage', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 20000,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(raw); } catch (e) {}
        if (j && j.ok) resolve({ ok: true });
        else resolve({ ok: false, error: (j && j.description) || ('HTTP ' + res.statusCode) });
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end(body);
  });
}

/** ساخت + ارسال، با ثبت نتیجه در تنظیمات تا پنل آخرین وضعیت را نشان دهد. */
async function sendDigest(reason) {
  const text = build();
  if (!text) {
    saveSetting('tg_digest_last_error', 'داده‌ای برای گزارش نبود');
    return { ok: false, error: 'داده‌ای برای گزارش نبود' };
  }
  const r = await send(text);
  saveSetting('tg_digest_last_at', new Date().toISOString());
  saveSetting('tg_digest_last_error', r.ok ? '' : String(r.error || ''));
  console.log('[tg-digest] ' + (reason || 'manual') + ' → ' + (r.ok ? 'ارسال شد' : 'خطا: ' + r.error));
  return r;
}

/** تاریخ امروز به وقت تهران، برای اینکه روزی یک‌بار بیشتر ارسال نشود. */
function tehranDay() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch (e) { return new Date().toISOString().slice(0, 10); }
}
function tehranHour() {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date()));
  } catch (e) { return new Date().getUTCHours(); }
}

/**
 * هر ۱۵ دقیقه نگاه می‌کند؛ اگر ساعتِ تهران به ساعتِ تنظیم‌شده رسیده و
 * امروز چیزی نرفته، می‌فرستد. با ری‌استارت دوباره ارسال نمی‌شود چون
 * روزِ آخرین ارسال روی دیسک است.
 */
function startDigestScheduler(everyMs) {
  const ms = everyMs || 15 * 60 * 1000;
  const tick = async () => {
    try {
      const s = settings();
      if (!s.tg_digest_enabled) return;
      const hour = Number(s.tg_digest_hour == null ? 21 : s.tg_digest_hour);
      if (tehranHour() < hour) return;
      const st = readJSON(STATE, {}) || {};
      const day = tehranDay();
      if (st.lastDay === day) return;
      const r = await sendDigest('scheduled');
      if (r.ok) writeJSON(STATE, { lastDay: day, at: new Date().toISOString() });
    } catch (e) { console.warn('[tg-digest]', e.message); }
  };
  setTimeout(tick, 2 * 60 * 1000);
  setInterval(tick, ms);
  console.log('[tg-digest] زمان‌بند گزارش روزانه فعال — بررسی هر ' + Math.round(ms / 60000) + ' دقیقه');
}

module.exports = { build, send, sendDigest, startDigestScheduler, channel, TZ };
