/**
 * web-test.js — لایه‌ی عمومی رندرشده‌ی سمت سرور (نسخه‌ی آزمایشی)
 *
 * روی پورت ۳۰۰۲ اجرا می‌شود و کاملاً از server.js (پورت ۳۰۰۱) جداست.
 * فقط می‌خواند — هیچ نوشتنی در دیتابیس ندارد.
 */
require('dotenv').config();

const path    = require('path');
const fs      = require('fs');
const express = require('express');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');

const newsDB    = require('./news-db');
const financeDB = require('./finance-db');
const carDB     = require('./car-db');
const marketDB  = require('./market-db');
const jobDB     = require('./job-db');
const polyDB    = require('./polymarket-db');
const trendDB   = require('./trend-db');
const txt       = require('./lib/clean-text');
const spam      = require('./lib/spam-filter');
const auth      = require('./auth');
const db        = require('./db');
const settingsDB = require('./settings-db');
const aiClient   = require('./lib/ai-client');
const orModels   = require('./lib/openrouter-models');
const cookieParser = require('cookie-parser');

const app  = express();
const PORT = process.env.WEB_PORT || 3002;
const SITE = 'https://signalhoosh.site';

// ── دسترسی مستقیم فقط-خواندنی برای پرس‌وجوهایی که در ماژول‌ها نیست ──
const newsRO = new Database(path.join(__dirname, 'data', 'news.db'), { readonly: true });

// نوشتنی — فقط برای عملیات پنل مدیریت (آزادسازی خبر، تغییر قانون)
const newsRW = new Database(path.join(__dirname, 'data', 'news.db'));

let timelineRO = { prepare: () => ({ all: () => [], get: () => null }) };
try { timelineRO = new Database(path.join(__dirname, 'data', 'timeline.db'), { readonly: true }); }
catch (e) { console.warn('[web] timeline.db در دسترس نیست — تب آینده خالی نمایش داده می‌شود'); }

// ── پیام‌های فرم تماس ──
const msgDB = new Database(path.join(__dirname, 'data', 'messages.db'));
msgDB.pragma('journal_mode = WAL');
msgDB.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    topic      TEXT,
    url        TEXT,
    message    TEXT NOT NULL,
    ip         TEXT,
    read       INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_msg_read ON messages(read, created_at DESC);
`);

// ════════════ کمک‌تابع‌ها ════════════

const FA = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
function fa(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[0-9]/g, d => FA[+d]).replace(/,/g, '٬').replace(/\./g, '٫');
}
function num(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Math.round(Number(n)).toLocaleString('en-US');
}
function toman(n) {
  if (!n) return '—';
  const v = Number(n);
  if (v >= 1e9) return (v / 1e9).toFixed(2) + ' میلیارد';
  if (v >= 1e6) return Math.round(v / 1e6) + ' میلیون';
  return num(v);
}
function pct(p) {
  if (p === null || p === undefined || isNaN(p)) return '';
  const v = Number(p);
  return (v > 0 ? '+' : v < 0 ? '−' : '') + fa(Math.abs(v).toFixed(1)) + '٪';
}
function excerpt(t, n) {
  if (!t) return '';
  const s = String(t).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function timeAgo(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  const m = Math.floor((Date.now() - d.getTime()) / 60000);
  if (m < 1)    return 'همین الان';
  if (m < 60)   return fa(m) + ' دقیقه پیش';
  const h = Math.floor(m / 60);
  if (h < 24)   return fa(h) + ' ساعت پیش';
  const dd = Math.floor(h / 24);
  return fa(dd) + ' روز پیش';
}
// فقط روز، بدون ساعت — برای «تاریخ داده» و «آخرین بروزرسانی»
// که مقدارشان یک رشته‌ی میلادی مثل 2026-08-10 است
// timeAgo فقط گذشته را می‌سنجد؛ برای «تا کِی نتیجه مشخص می‌شود» لازم است
function timeUntil(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  const m = Math.round((d.getTime() - Date.now()) / 60000);
  if (m <= 0) return 'به‌زودی';
  if (m < 60) return fa(m) + ' دقیقه دیگر';
  const h = Math.round(m / 60);
  if (h < 24) return fa(h) + ' ساعت دیگر';
  return fa(Math.round(h / 24)) + ' روز دیگر';
}

// اعداد منفی با منهای فارسی، هم‌راستا با pct()
function faSigned(n, digits) {
  if (n == null || isNaN(n)) return '—';
  const v = Number(n);
  return (v < 0 ? '−' : '') + fa(Math.abs(v).toFixed(digits == null ? 2 : digits));
}

// نقاط polyline برای نمودار خطی کوچک — بدون وابستگی به کتابخانه
function sparkPoints(vals, wd, ht) {
  if (!vals || vals.length < 2) return '';
  const min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  const span = (max - min) || 1;
  return vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * wd;
    const y = ht - ((v - min) / span) * ht;
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
}

function faDay(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d)) return fa(ts);
  try {
    return new Intl.DateTimeFormat('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  } catch (e) { return fa(String(ts)); }
}

function faDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    }).format(d);
  } catch (e) { return fa(d.toISOString().slice(0, 16).replace('T', ' ')); }
}
// نام فایل‌های مدیا → آدرس قابل سرو
function mediaOf(media_url) {
  const out = { list: [], first: null, count: 0 };
  if (!media_url) return out;
  const v = String(media_url).trim();
  let list;
  if (v.startsWith('[')) { try { list = JSON.parse(v); } catch (e) { list = [v]; } }
  else list = [v];
  for (const u of list) {
    if (typeof u !== 'string') continue;
    if (u.startsWith('/news-media/') || u.startsWith('/finance-media/')) out.list.push(u);
  }
  out.count = out.list.length;
  out.first = out.list[0] || null;
  return out;
}

const TABS = [
  { href: '/',           label: 'خانه' },
  { href: '/trends',     label: 'ترند سرچ ایران' },
  { href: '/news',       label: 'ترند اخبار ایران' },
  { href: '/finance',    label: 'ترند بازارهای مالی' },
  { href: '/cars',       label: 'ترند خودرو ایران' },
  { href: '/market',     label: 'ترند کالای ایران' },
  { href: '/jobs',       label: 'مارکت کار ایران' },
  { href: '/polymarket', label: 'ترند های پلی مارکت' },
  { href: '/future',     label: 'ترند آینده' }
];

function usd(n) {
  if (n == null || isNaN(n)) return '—';
  const v = Number(n);
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
  return '$' + Math.round(v);
}

/**
 * مسیر SVG برای اسپارک‌لاین — آرایه‌ی عدد را به path تبدیل می‌کند.
 * اگر داده کمتر از دو نقطه باشد، رشته‌ی خالی برمی‌گرداند تا نمودار خالی رندر نشود.
 */
function sparkPath(values, w, h, pad) {
  const v = (values || []).filter(x => x != null && !isNaN(x)).map(Number);
  if (v.length < 2) return '';
  w = w || 100; h = h || 30; pad = pad == null ? 2 : pad;
  const min = Math.min(...v), max = Math.max(...v);
  const span = (max - min) || 1;
  const step = w / (v.length - 1);
  return v.map((y, i) => {
    const x = (i * step).toFixed(1);
    const yy = (pad + (h - pad * 2) * (1 - (y - min) / span)).toFixed(1);
    return (i ? 'L' : 'M') + x + ',' + yy;
  }).join(' ');
}
function sparkArea(values, w, h, pad) {
  const p = sparkPath(values, w, h, pad);
  if (!p) return '';
  return p + ' L' + (w || 100) + ',' + (h || 30) + ' L0,' + (h || 30) + ' Z';
}
function trendDir(values) {
  const v = (values || []).filter(x => x != null && !isNaN(x)).map(Number);
  if (v.length < 2) return 0;
  return v[v.length - 1] - v[0];
}

// بج تغییر رتبه — رتبه‌ی کمتر یعنی بهتر، پس علامت برعکس است
function rankBadge(now, before) {
  if (before == null || now == null) return '<span class="badge badge-flat">تازه</span>';
  const d = before - now;
  if (d === 0) return '<span class="badge badge-flat">—</span>';
  const cls = d > 0 ? 'badge-up' : 'badge-down';
  const arrow = d > 0 ? '▲' : '▼';
  return '<span class="badge ' + cls + '">' + arrow + ' ' + fa(Math.abs(d)) + '</span>';
}

// رندر صفحه داخل layout
function page(res, tpl, active, seo, data, jsonld) {
  const locals = Object.assign({
    fa, num, toman, pct, usd, excerpt, timeAgo, timeUntil, faSigned, faDate, faDay, mediaOf,
    clean: txt.clean, rankBadge, sparkPath, sparkArea, trendDir,
    SITE, TABS, active, ASSETS
  }, data);
  res.render('pages/' + tpl, locals, (err, body) => {
    if (err) { console.error('[render]', tpl, err.message); return res.status(500).send('خطا در رندر صفحه'); }
    res.render('layout', Object.assign({}, locals, { body, seo, jsonld: jsonld || null }), (e2, html) => {
      if (e2) { console.error('[layout]', e2.message); return res.status(500).send('خطا در رندر صفحه'); }
      res.send(html);
    });
  });
}

// ════════════ میان‌افزارها ════════════

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// پشت nginx هستیم — بدون این، rate-limit همه‌ی کاربران را یک IP می‌بیند
app.set('trust proxy', 1);

/**
 * نسخه‌گذاری فایل‌های استاتیک.
 *
 * چرا لازم است: nginx فایل‌های /assets/ را ۷ روز کش می‌کند. بدون تغییر نشانی،
 * به‌روزرسانی CSS تا یک هفته به کاربر نمی‌رسد — دقیقاً همان چیزی که باعث شد
 * اصلاحات ظاهری «انجام‌نشده» به نظر برسند. با افزودن ?v=<زمان تغییر فایل>
 * هر بار که فایل عوض شود نشانی هم عوض می‌شود و کش دور زده می‌شود.
 */
function assetVersion(rel) {
  try {
    return String(Math.floor(fs.statSync(path.join(__dirname, 'public', rel)).mtimeMs));
  } catch (e) { return String(Date.now()); }
}
const ASSETS = {
  tokens:     '/assets/css/tokens.css?v='     + assetVersion('assets/css/tokens.css'),
  base:       '/assets/css/base.css?v='       + assetVersion('assets/css/base.css'),
  components: '/assets/css/components.css?v=' + assetVersion('assets/css/components.css'),
  app:        '/assets/js/app.js?v='          + assetVersion('assets/js/app.js')
};

app.use(helmet({
  contentSecurityPolicy: false,          // استایل/اسکریپت درون‌خطی داریم
  crossOriginEmbedderPolicy: false
}));

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120,                              // ۱۲۰ درخواست در دقیقه برای هر IP
  standardHeaders: true,
  legacyHeaders: false,
  message: 'درخواست بیش از حد. کمی بعد دوباره تلاش کنید.'
}));

// محدودیت سخت‌گیرانه‌تر برای فرم تماس — جلوگیری از اسپم
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'تعداد پیام‌های ارسالی زیاد است. کمی بعد دوباره تلاش کنید.'
});

// محدودیت ورود — جلوی حدس رمز را می‌گیرد
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'تلاش‌های ورود بیش از حد. ۱۵ دقیقه بعد دوباره تلاش کنید.'
});

app.use(cookieParser());
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

// index:false تا public/index.html (اپ قدیمی) روی روت "/" را نگیرد
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: false }));

// ════════════ داده ════════════

function newsStats() {
  const q = (s, d) => { try { return newsRO.prepare(s).get(); } catch (e) { return d; } };
  const total = q('SELECT COUNT(*) c FROM news', { c: 0 }).c;
  const today = q("SELECT COUNT(*) c FROM news WHERE published_at >= datetime('now','-1 day')", { c: 0 }).c;
  const withMedia = q('SELECT COUNT(*) c FROM news WHERE media_url IS NOT NULL', { c: 0 }).c;
  const channels = q('SELECT COUNT(*) c FROM channels WHERE active=1', { c: 0 }).c;
  let top = { title: null, cnt: 0 };
  try {
    top = newsRO.prepare(`
      SELECT c.title, COUNT(*) cnt FROM news n JOIN channels c ON c.id=n.channel_id
      WHERE n.published_at >= datetime('now','-1 day')
      GROUP BY n.channel_id ORDER BY cnt DESC LIMIT 1`).get() || top;
  } catch (e) {}
  return { total, today, withMedia, channels, topChannel: top.title, topChannelCount: top.cnt };
}

function topChannels(limit = 7) {
  try {
    return newsRO.prepare(`
      SELECT c.id, c.title, c.username, c.photo_url, COUNT(*) cnt
      FROM news n JOIN channels c ON c.id=n.channel_id
      WHERE n.published_at >= datetime('now','-1 day')
      GROUP BY n.channel_id ORDER BY cnt DESC LIMIT ?`).all(limit);
  } catch (e) { return []; }
}

function getNewsById(id) {
  try {
    return newsRO.prepare(`
      SELECT n.*, c.title channel_title, c.username channel_username, c.photo_url channel_photo
      FROM news n LEFT JOIN channels c ON c.id=n.channel_id WHERE n.id=?`).get(id);
  } catch (e) { return null; }
}

// واژه‌های پرتکرار که سیگنال موضوعی ندارند
const STOP = new Set(('و در به از که با این را برای های ها می بر تا یک هم آن است شد بود کرد کند شده ' +
  'خود اما یا اگر چه نیز باید دارد دارند داشت گفت اعلام کرد کردند طبق درباره روی پس دیگر همه بین ' +
  'وی او آنها ما شما بیش کمتر بیشتر حال طور نیست هستند بوده خواهد گزارش اساس منابع').split(/\s+/));

/**
 * تشخیص «خبر داغ» — بر پایه‌ی پوشش هم‌زمان چند کانال، نه حدس.
 *
 * منطق: واژه‌های معنادار سه ساعت اخیر را می‌شماریم. اگر یک واژه در
 * ۳ کانال مستقل یا بیشتر آمده باشد، آن موضوع در حال داغ شدن است.
 * خبری که حداقل دو تا از این واژه‌ها را دارد، داغ علامت می‌خورد.
 * این‌طور «انفجار» در یک کانال داغ نیست، ولی خبری که ۵ کانال هم‌زمان
 * پوشش داده‌اند داغ است.
 */
const HOT_MIN_CHANNELS = 5;   // واژه باید در چند کانال مستقل آمده باشد
const HOT_MIN_WORDS    = 3;   // خبر باید چند واژه‌ی این‌چنینی داشته باشد
const HOT_MAX          = 3;   // حداکثر چند خبر در هر نما داغ علامت بخورند

function tokenize(s) {
  return String(s || '')
    .replace(/[^؀-ۿ\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP.has(w));
}

function markNews(rows) {
  // شمارش کانال‌های مستقل برای هر واژه در ۳ ساعت اخیر
  let recent = [];
  try {
    recent = newsRO.prepare(`
      SELECT id, channel_id, COALESCE(text_fa, text) t FROM news
      WHERE COALESCE(blocked,0)=0 AND published_at >= datetime('now','-3 hours')
      LIMIT 400`).all();
  } catch (e) {}

  const wordChannels = new Map();
  for (const r of recent) {
    const seen = new Set(tokenize(r.t));
    for (const w of seen) {
      if (!wordChannels.has(w)) wordChannels.set(w, new Set());
      wordChannels.get(w).add(r.channel_id);
    }
  }

  const scored = rows.map(n => {
    // «تازه» یعنی خبری که جلوی چشم کاربر اضافه شود، نه خبری که موقع
    // بازکردن صفحه اخیر بوده. با ۲ خبر در دقیقه، هر پنجره‌ی زمانی کل
    // صفحه‌ی اول را «تازه» می‌کرد. پس در رندر اولیه هیچ‌کدام تازه نیستند؛
    // فقط مسیر پولینگ این پرچم را روشن می‌کند.
    n.isNew = false;

    // امتیاز داغی = بیشترین تعداد کانال مستقلی که واژه‌های این خبر را پوشش داده‌اند
    let best = 0, strong = 0;
    for (const w of new Set(tokenize(n.text_fa || n.text))) {
      const c = wordChannels.has(w) ? wordChannels.get(w).size : 0;
      if (c >= HOT_MIN_CHANNELS) { strong++; if (c > best) best = c; }
    }
    n.hot = false;
    n.hotChannels = best;
    n._score = strong >= HOT_MIN_WORDS ? best : 0;
    return n;
  });

  // فقط چند خبرِ برتر داغ می‌شوند. اگر همه داغ باشند، «داغ» بی‌معنا است —
  // با ۶۸ کانالِ هم‌پوشان، آستانه‌ی ثابت عملاً کل صفحه را علامت می‌زد.
  scored.slice()
    .filter(n => n._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, HOT_MAX)
    .forEach(n => { n.hot = true; });

  return scored;
}

// واکشی اخبار همراه با دسته‌بندی کانال
function fetchNews(limit, channelId, offset, category) {
  const where = ['COALESCE(n.blocked,0)=0'];
  const params = [];
  if (channelId) { where.push('n.channel_id=?'); params.push(channelId); }
  if (category)  { where.push('c.category=?');   params.push(category); }
  params.push(limit, offset || 0);
  try {
    return newsRO.prepare(`
      SELECT n.*, c.title channel_title, c.username channel_username,
             c.photo_url channel_photo, c.category channel_category
      FROM news n JOIN channels c ON c.id=n.channel_id
      WHERE ${where.join(' AND ')}
      ORDER BY n.published_at DESC LIMIT ? OFFSET ?`).all(...params);
  } catch (e) { console.warn('[fetchNews]', e.message); return []; }
}

function readJson(f, d) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', f), 'utf8')); }
  catch (e) { return d; }
}

function trendRows(limit = 10) {
  const j = readJson('h4.json', null);
  const arr = Array.isArray(j) ? j : (j && Array.isArray(j.trends) ? j.trends : (j && Array.isArray(j.items) ? j.items : []));
  return arr.slice(0, limit).map(t => ({
    keyword: t.keyword || t.title || t.query || '',
    vol: t.vol || t.volume || t.traffic || '',
    growth: t.growth || t.increase || ''
  })).filter(t => t.keyword);
}

// ════════════ روت‌ها ════════════

// قیمت‌های مالی در دیتابیس ریال‌اند — برای نمایش به تومان تبدیل می‌شوند
// ── واحد نمادهای مالی ──
// دیتابیس واحد هر نماد را جدا نگه می‌دارد: ریال، دلار، نقطه.
// فقط ریالی‌ها باید به تومان تبدیل شوند؛ تقسیم بی‌قید بر ۱۰ باعث می‌شد
// نفت برنت ۸۷٫۴۸ دلار «۹» و انس طلا ۴۳۶۰ دلار «۴۳۶» و شاخص بورس
// ۵٬۶۵۲٬۰۲۱ نقطه «۵۶۵٬۲۰۲» نمایش داده شود.
// بیت‌کوین را منبع اشتباهاً «ریال» برچسب می‌زند، پس با نام نماد اصلاح می‌شود.
const USD_SYMBOLS = new Set(['ounce', 'oil_brent', 'oil', 'bitcoin', 'btc', 'ethereum', 'eth']);

function finUnit(f) {
  if (!f) return 'تومان';
  if (USD_SYMBOLS.has(f.symbol)) return 'دلار';
  const u = String(f.unit || 'ریال').trim();
  return u === 'ریال' ? 'تومان' : u;
}

function finPrice(f, v) {
  const raw = (v === undefined) ? (f && f.price) : v;
  if (raw == null) return null;
  const n = Number(raw);
  if (isNaN(n)) return null;
  return finUnit(f) === 'تومان' ? n / 10 : n;
}

// num() گرد می‌کند و ۸۷٫۴۸ دلار را «۸۷» می‌کند؛ برای اعداد کوچک اعشار می‌ماند
function finText(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (isNaN(n)) return '—';
  if (Math.abs(n) >= 1000) return num(n);
  return (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function finRow(f, extra) {
  const price = finPrice(f);
  return Object.assign({}, f, {
    price,
    change: finPrice(f, f.change),
    low:    finPrice(f, f.low),
    high:   finPrice(f, f.high),
    bubble: finPrice(f, f.bubble),
    unitText:  finUnit(f),
    priceText: finText(price),
  }, extra || {});
}

const JOB_LABELS = {
  jobinja: 'جابینجا',
  jobvision: 'جاب‌ویژن',
  'human-resources': 'منابع انسانی',
  accounting: 'مالی و حسابداری',
  developer: 'برنامه‌نویسی و توسعه',
  'data-science': 'علم داده و تحلیل',
  'digital-marketing': 'بازاریابی دیجیتال',
  driver: 'رانندگی و حمل‌ونقل',
  civil: 'مهندسی عمران',
  'software-web-development': 'برنامه‌نویسی و IT',
  'sales-marketing': 'فروش و بازاریابی',
  'civil-engineering': 'مهندسی عمران',
  'graphic-design': 'گرافیک و طراحی',
  'customer-support': 'پشتیبانی مشتری'
};

app.get('/', (req, res) => {
  let ticker = [], finance = [], cars = [], market = [], poly = [], jobs = null, carCount = 0;

  try {
    const raw = (financeDB.getLatest() || []).map(f => finRow(f));
    ticker  = raw.slice(0, 8);
    finance = raw.slice(0, 6);
  } catch (e) { console.warn('[home] finance:', e.message); }

  try {
    const all = carDB.getLatest() || [];
    carCount = all.length;
    cars = all.slice(0, 6).map(c => ({
      name_fa: c.name_fa, slug: c.slug, image_url: c.image_url,
      median_price: c.snapshot ? (c.snapshot.median_price || c.snapshot.avg_price) : null,
      change_pct: c.change_pct != null ? c.change_pct : (c.snapshot ? c.snapshot.change_pct : null)
    }));
  } catch (e) { console.warn('[home] cars:', e.message); }

  try { market = (marketDB.getLatestList('week', 6) || []).slice(0, 6); } catch (e) { console.warn('[home] market:', e.message); }

  try {
    poly = (polyDB.getSortedList('trending', 5) || []).slice(0, 5).map(p => Object.assign({}, p, {
      url: p.url || (p.slug ? 'https://polymarket.com/event/' + p.slug : 'https://polymarket.com/')
    }));
  } catch (e) { console.warn('[home] poly:', e.message); }

  try {
    const s = jobDB.getSummary() || {};
    const rows = [];
    for (const [k, v] of Object.entries(s.sources || {})) rows.push({ label: JOB_LABELS[k] || k, count: v.count });
    const cats = Object.entries(s.categories || {}).sort((a, b) => (b[1].count || 0) - (a[1].count || 0));
    for (const [k, v] of cats.slice(0, 3)) rows.push({ label: JOB_LABELS[k] || k, count: v.count });
    jobs = { ehi: s.ehi != null ? s.ehi : null, rows: rows.slice(0, 5) };
  } catch (e) { console.warn('[home] jobs:', e.message); }

  const news = markNews(fetchNews(6, null, 0, null));

  page(res, 'home', '/', {
    title: 'سیگنال هوش | مانیتور هوشمند ایران — قیمت دلار، طلا، خودرو و ترند اخبار',
    desc: 'مانیتور هوشمند ایران: قیمت لحظه‌ای دلار، طلا، سکه و ارز دیجیتال، ترند جستجوی گوگل، اخبار کانال‌های تلگرام، قیمت روز خودرو، پرفروش‌های بازار کالا و آمار بازار کار — رایگان و بدون ثبت‌نام.',
    path: '/'
  }, {
    ticker, finance, cars, market, poly, jobs, carCount,
    news, newsStats: newsStats(), trends: trendRows(10),
    future: [],
    updatedAt: faDate(new Date().toISOString())
  }, {
    '@context': 'https://schema.org', '@type': 'WebSite',
    name: 'سیگنال هوش', alternateName: 'مانیتور هوشمند ایران',
    url: SITE + '/', inLanguage: 'fa-IR'
  });
});

app.get('/news', (req, res) => {
  const channel = req.query.channel ? parseInt(req.query.channel, 10) : null;
  const category = req.query.cat ? String(req.query.cat) : null;
  const news = markNews(fetchNews(20, channel, 0, category));
  let digest = null;
  try { digest = newsDB.getLatestDigest(); } catch (e) {}

  // کانال‌ها به‌همراه شمار خبر، و فهرست دسته‌بندی‌ها
  let channels = [], cats = [];
  try {
    channels = newsRO.prepare(`
      SELECT c.id, c.title, c.username, c.category, c.photo_url, COUNT(n.id) cnt
      FROM channels c LEFT JOIN news n ON n.channel_id=c.id AND COALESCE(n.blocked,0)=0
      WHERE c.active=1 GROUP BY c.id ORDER BY cnt DESC`).all();
    cats = newsRO.prepare(`
      SELECT category, COUNT(*) cnt FROM channels
      WHERE active=1 AND category IS NOT NULL AND category != ''
      GROUP BY category ORDER BY cnt DESC`).all();
  } catch (e) { console.warn('[news] channels:', e.message); }

  page(res, 'news', '/news', {
    title: 'ترند اخبار ایران | اخبار لحظه‌ای کانال‌های تلگرام — سیگنال هوش',
    desc: 'تحلیل هوشمند جریان خبری ایران: اخبار لحظه‌ای از کانال‌های عمومی تلگرام با ترجمه‌ی خودکار منابع غیرفارسی و گزارش هوش مصنوعی.',
    path: '/news'
  }, { news, digest, channels, cats, current: channel, curCat: category, stats: newsStats(), topChannels: topChannels() });
});

/**
 * اخبار تازه‌تر از یک شناسه — برای افزوده شدن زنده بدون رفرش.
 * خروجی JSON با قطعه‌ی HTML آماده تا مرورگر فقط prepend کند.
 */
app.get('/news/live/:since', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const since = parseInt(req.params.since, 10) || 0;
  const channel = req.query.channel ? parseInt(req.query.channel, 10) : null;
  const category = req.query.cat ? String(req.query.cat) : null;

  const where = ['COALESCE(n.blocked,0)=0', 'n.id > ?'];
  const params = [since];
  if (channel)  { where.push('n.channel_id=?'); params.push(channel); }
  if (category) { where.push('c.category=?');   params.push(category); }

  let rows = [];
  try {
    rows = newsRO.prepare(`
      SELECT n.*, c.title channel_title, c.username channel_username,
             c.photo_url channel_photo, c.category channel_category
      FROM news n JOIN channels c ON c.id=n.channel_id
      WHERE ${where.join(' AND ')}
      ORDER BY n.published_at DESC LIMIT 10`).all(...params);
  } catch (e) { return res.json({ maxId: since, count: 0, html: '' }); }

  if (!rows.length) return res.json({ maxId: since, count: 0, html: '' });

  rows = markNews(rows);
  rows.forEach(r => { r.isNew = true; });      // تازه‌رسیده‌ها همیشه حلقه‌ی قرمز بگیرند
  const maxId = rows.reduce((m, r) => Math.max(m, r.id), since);

  let pending = rows.length;
  const parts = new Array(rows.length);
  rows.forEach((r, i) => {
    res.app.render('partials/news-row', { n: r, fa, timeAgo, mediaOf, excerpt, clean: txt.clean }, (e, out) => {
      parts[i] = e ? '' : out;
      if (--pending === 0) res.json({ maxId, count: rows.length, html: parts.join('') });
    });
  });
});

// صفحه‌بندی برای لیزی‌لود (قطعه‌ی HTML برمی‌گرداند)
app.get('/news/page/:n', (req, res) => {
  const n = Math.max(1, Math.min(50, parseInt(req.params.n, 10) || 1));
  const channel = req.query.channel ? parseInt(req.query.channel, 10) : null;
  const category = req.query.cat ? String(req.query.cat) : null;
  const rows = markNews(fetchNews(20, channel, (n - 1) * 20, category));
  let html = '';
  let pending = rows.length;
  if (!pending) return res.send('');
  const parts = new Array(rows.length);
  rows.forEach((r, i) => {
    res.app.render('partials/news-row', { n: r, fa, timeAgo, mediaOf, excerpt }, (e, out) => {
      parts[i] = e ? '' : out;
      if (--pending === 0) res.send(parts.join(''));
    });
  });
});

app.get('/news/:id', (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return next();
  const n = getNewsById(id);
  if (!n) return next();

  const text = (n.text_fa || n.text || '').trim();
  const paras = txt.paragraphs(text);
  const headline = txt.headline(text);
  const media = mediaOf(n.media_url);

  let related = [];
  try {
    related = newsRO.prepare(`
      SELECT n.id, n.text, n.text_fa, n.published_at, c.title channel_title, c.username channel_username
      FROM news n LEFT JOIN channels c ON c.id=n.channel_id
      WHERE n.id != ? ORDER BY n.published_at DESC LIMIT 4`).all(id);
  } catch (e) {}
  let fin = [];
  try { fin = (financeDB.getLatest() || []).slice(0, 4); } catch (e) {}

  page(res, 'news-detail', '/news', {
    title: headline + ' | سیگنال هوش',
    desc: txt.description(text),
    path: '/news/' + id,
    ogType: 'article',
    image: media.first || null
  }, { n, headline, bodyParas: paras, media, related, fin }, {
    '@context': 'https://schema.org', '@type': 'NewsArticle',
    headline,
    datePublished: n.published_at,
    dateModified: n.published_at,
    inLanguage: 'fa-IR',
    image: media.list.map(u => SITE + u),
    mainEntityOfPage: { '@type': 'WebPage', '@id': SITE + '/news/' + id },
    publisher: { '@type': 'Organization', name: 'سیگنال هوش', url: SITE }
  });
});

// ════════════ بقیه‌ی تب‌ها ════════════

app.get('/trends', (req, res) => {
  const j4  = readJson('h4.json', {});
  const j24 = readJson('h24.json', {});
  const h4  = Array.isArray(j4.trends) ? j4.trends : [];
  const h24 = Array.isArray(j24.trends) ? j24.trends : [];
  let stats = {}, hall = [], persistent = [], meteors = [];
  try { stats      = trendDB.getStats() || {}; } catch (e) {}
  try { hall       = trendDB.getHallOfFame(6) || []; } catch (e) {}
  try { persistent = trendDB.getMostPersistent(6) || []; } catch (e) {}
  try { meteors    = trendDB.getMeteors(6) || []; } catch (e) {}

  // موضوعات غالب — دسته‌ها را بر اساس حجم جستجوی ترندهای ۴ ساعته وزن می‌دهیم،
  // نه صرفاً تعدادشان؛ یک کلیدواژه‌ی ۵۰ هزارتایی مهم‌تر از سه تای ۲۰۰تایی است.
  const catWeight = new Map();
  for (const t of h4) {
    const c = (t.cat || '').trim();
    if (!c) continue;
    catWeight.set(c, (catWeight.get(c) || 0) + (Number(t.vol) || 1));
  }
  const catTotal = Array.from(catWeight.values()).reduce((s, v) => s + v, 0);
  const topCats = Array.from(catWeight.entries())
    .map(([name, w]) => ({ name, weight: w, share: catTotal ? Math.round((w / catTotal) * 100) : 0 }))
    .sort((a, b) => b.weight - a.weight);

  page(res, 'trends', '/trends', {
    title: 'ترند سرچ ایران | پرجستجوترین کلیدواژه‌های گوگل — سیگنال هوش',
    desc: 'پرجستجوترین کلیدواژه‌های گوگل در ایران در بازه‌های ۴ و ۲۴ ساعته، همراه با حجم جستجو، رشد و تاریخچه‌ی کامل ترندها.',
    path: '/trends'
  }, { h4, h24, stats, hall, persistent, meteors, topCats, catTotal });
});

app.get('/finance', (req, res) => {
  let rows = [], messages = [], channels = [];
  try { rows = (financeDB.getLatest() || []).map(f => {
    // تاریخچه‌ی ۲۴ ساعته برای اسپارک‌لاین
    let hist = [];
    try {
      const h = financeDB.getSparkline ? financeDB.getSparkline(f.symbol) : null;
      hist = Array.isArray(h) ? h.map(x => (typeof x === 'object' ? (x.price || x.value) : x)) : [];
      if (!hist.length && financeDB.getHistory) {
        hist = (financeDB.getHistory(f.symbol, 24) || []).map(x => x.price);
      }
    } catch (e) {}
    return finRow(f, { hist: hist.filter(x => x != null) });
  }); } catch (e) { console.warn('[finance]', e.message); }
  try { messages = (financeDB.getLatestFinanceMessages(12) || []); } catch (e) {}
  try { channels = (financeDB.getFinanceChannels() || []); } catch (e) {}

  page(res, 'finance', '/finance', {
    title: 'ترند بازارهای مالی | قیمت لحظه‌ای دلار، طلا، سکه و انس — سیگنال هوش',
    desc: 'رصد لحظه‌ای بازارهای موازی ایران: دلار آزاد، طلای ۱۸ عیار، سکه امامی و انس جهانی طلا، همراه با جریان اخبار مالی کانال‌های تلگرام.',
    path: '/finance'
  }, { rows, kpi: rows.slice(0, 4), messages, channels });
});

app.get('/cars', (req, res) => {
  let raw = [], stats = {}, momentum = [], value = [], submodels = [];
  try { raw       = carDB.getLatest() || []; } catch (e) { console.warn('[cars]', e.message); }
  try { stats     = carDB.getStats() || {}; } catch (e) {}
  try { momentum  = carDB.getMomentum(7) || []; } catch (e) {}
  try { value     = carDB.getValueScores() || []; } catch (e) {}
  try { submodels = carDB.getLatestSubmodels() || []; } catch (e) {}

  const cars = raw.map(c => ({
    slug: c.slug, name_fa: c.name_fa, tier: c.tier, url: c.url, image_url: c.image_url,
    median_price: c.snapshot ? (c.snapshot.median_price || c.snapshot.avg_price) : null,
    avg_mileage:  c.snapshot ? c.snapshot.avg_mileage : null,
    price_per_km: c.snapshot ? c.snapshot.price_per_km : null,
    listing_count:c.snapshot ? c.snapshot.listing_count : null,
    change_day_pct: c.change_day_pct
  }));

  const byMomentum = momentum.slice().sort((a, b) => (b.pct_per_day || 0) - (a.pct_per_day || 0));
  const priced = cars.filter(c => c.median_price).sort((a, b) => b.median_price - a.median_price);
  const vMap = {}; value.forEach(v => { vMap[v.slug] = v; });
  const mMap = {}; momentum.forEach(m => { mMap[m.slug] = m; });

  const metrics = cars.map(c => Object.assign({}, c, {
    pct_per_day: mMap[c.slug] ? mMap[c.slug].pct_per_day : null,
    value_vs_tier_pct: vMap[c.slug] ? vMap[c.slug].value_vs_tier_pct : null
  })).sort((a, b) => (b.median_price || 0) - (a.median_price || 0));

  const TIER_LABEL = { high: 'لوکس', mid: 'میان‌رده', low: 'اقتصادی' };

  // ── روند قیمت هر مدل در طول زمان ──
  const series = cars.map(c => {
    let h = [];
    try { h = carDB.getHistory(c.slug, 30) || []; } catch (e) {}
    const vals = h.map(x => x.median_price || x.avg_price).filter(v => v != null);
    const first = vals[0], last = vals[vals.length - 1];
    return {
      slug: c.slug, name_fa: c.name_fa, image_url: c.image_url,
      tierLabel: TIER_LABEL[c.tier] || c.tier,
      points: vals.length, first, last,
      spark: sparkPoints(vals, 220, 44),
      changePct: (first && last) ? ((last - first) / first) * 100 : null
    };
  }).filter(s => s.points > 1);

  // ── قیمت‌بر‌کارکرد، فقط داخل هر رده قابل مقایسه است ──
  const tiers = ['high', 'mid', 'low'].map(t => {
    const items = value.filter(v => v.tier === t && v.price_per_km);
    if (!items.length) return null;
    const mx = Math.max.apply(null, items.map(i => i.price_per_km));
    return {
      label: TIER_LABEL[t],
      avg: items[0].tier_avg_price_per_km,
      max: mx,
      avgPct: mx ? Math.round((items[0].tier_avg_price_per_km / mx) * 100) : 0,
      items: items.slice().sort((a, b) => a.price_per_km - b.price_per_km)
        .map(i => Object.assign({}, i, { widthPct: Math.round((i.price_per_km / mx) * 100) }))
    };
  }).filter(Boolean);

  // ── پراکندگی: سرعت رشد در برابر صرفه ──
  let scatter = null;
  const sp = metrics.filter(m => m.pct_per_day != null && m.value_vs_tier_pct != null);
  if (sp.length) {
    const xa = Math.max.apply(null, [1].concat(sp.map(p => Math.abs(p.pct_per_day))));
    const ya = Math.max.apply(null, [1].concat(sp.map(p => Math.abs(p.value_vs_tier_pct))));
    scatter = {
      xMax: xa, yMax: ya,
      items: sp.map(p => ({
        name_fa: p.name_fa,
        tierLabel: TIER_LABEL[p.tier] || p.tier,
        pct_per_day: p.pct_per_day,
        value_vs_tier_pct: p.value_vs_tier_pct,
        x: (50 + (p.pct_per_day / xa) * 42).toFixed(1),
        // مثبت یعنی گران‌تر از میانگین رده → پایین‌تر روی نمودار
        y: (50 + (p.value_vs_tier_pct / ya) * 42).toFixed(1)
      }))
    };
  }

  page(res, 'cars', '/cars', {
    title: 'ترند خودرو ایران | قیمت روز خودرو بر پایه آگهی‌های واقعی — سیگنال هوش',
    desc: 'روند بازار خودرو ایران: میانه قیمت، کارکرد، سرعت رشد و صرفه اقتصادی خودروها بر پایه‌ی آگهی‌های واقعی بازار، با بروزرسانی هر ۱۲ ساعت.',
    path: '/cars'
  }, {
    cars, stats, submodels, metrics, series, tiers, scatter,
    totalListings: cars.reduce((s, c) => s + (c.listing_count || 0), 0),
    topGain:  byMomentum[0] || null,
    topLoss:  byMomentum[byMomentum.length - 1] || null,
    priciest: priced[0] || null,
    cheapest: priced[priced.length - 1] || null
  });
});

app.get('/market', (req, res) => {
  const src = 'week';
  let list = [], summary = {}, hot = [], cold = [], newcomers = [], legends = [];
  try { list      = marketDB.getLatestList(src, 50) || []; } catch (e) { console.warn('[market]', e.message); }
  try { summary   = marketDB.getSummaryCards(src) || {}; } catch (e) {}
  try { hot       = (marketDB.getHotProducts(src) || []).slice(0, 5); } catch (e) {}
  try { cold      = (marketDB.getColdProducts(src) || []).slice(0, 5); } catch (e) {}
  try { newcomers = (marketDB.getNewEntrants(src) || []).slice(0, 5); } catch (e) {}
  try { legends   = (marketDB.getLegends(src) || []).slice(0, 5); } catch (e) {}

  page(res, 'market', '/market', {
    title: 'ترند کالای ایران | پرفروش‌ترین کالاها و روند قیمت — سیگنال هوش',
    desc: 'تحلیل قیمت و روند فروش کالاهای پرمصرف ایران: کالاهای ترند هفته، بیشترین رشد و افت فروش، تازه‌واردها و پرفروش‌های ماندگار.',
    path: '/market'
  }, { list, summary, hot, cold, newcomers, legends });
});

app.get('/jobs', (req, res) => {
  let summary = {}, totalHist = [], srcHist = {};
  try { summary = jobDB.getSummary() || {}; } catch (e) { console.warn('[jobs]', e.message); }
  try {
    const th = jobDB.getTotalHistory ? (jobDB.getTotalHistory(30) || []) : [];
    totalHist = th.map(r => r.count != null ? r.count : r.total).filter(x => x != null);
  } catch (e) {}

  const sources = Object.entries(summary.sources || {}).map(([k, v]) => {
    let hist = [];
    try {
      const h = jobDB.getHistory ? (jobDB.getHistory(k, 30) || []) : [];
      hist = h.map(r => r.count).filter(x => x != null);
    } catch (e) {}
    return Object.assign({ key: k, label: JOB_LABELS[k] || k, hist }, v);
  });
  const total = sources.reduce((s, x) => s + (x.count || 0), 0);
  const cats = Object.entries(summary.categories || {})
    .map(([k, v]) => {
      let hist = [];
      try {
        const h = jobDB.getCategoryHistory ? (jobDB.getCategoryHistory(k, 30) || []) : [];
        hist = h.map(r => r.count).filter(x => x != null);
      } catch (e) {}
      return Object.assign({ key: k, label: JOB_LABELS[k] || k, hist }, v);
    })
    .sort((a, b) => (b.count || 0) - (a.count || 0));

  page(res, 'jobs', '/jobs', {
    title: 'مارکت کار ایران | آمار آگهی‌های استخدام و شاخص سلامت اشتغال — سیگنال هوش',
    desc: 'پایش بازار کار ایران با داده‌های جابینجا و جاب‌ویژن: تعداد آگهی‌های استخدام به تفکیک حوزه‌ی شغلی و شاخص سلامت اشتغال (EHI).',
    path: '/jobs'
  }, { summary, sources, cats, total, totalHist });
});

// فایل تأییدیه‌ی Google Search Console
app.get('/google7d8cf733453e41c3.html', (req, res) => {
  res.type('text/html').send('google-site-verification: google7d8cf733453e41c3.html');
});

app.get('/polymarket', (req, res) => {
  const link = p => p.url || (p.slug ? 'https://polymarket.com/event/' + p.slug : 'https://polymarket.com/');
  const withDelta = p => Object.assign({}, p, {
    link: link(p),
    delta: (p.prev_rank_6h != null && p.rank != null) ? (p.prev_rank_6h - p.rank) : null
  });
  let trending = [], volume = [], status = {};
  try { trending = (polyDB.getSortedList('trending', 25) || []).map(withDelta); } catch (e) { console.warn('[poly]', e.message); }
  try { volume   = (polyDB.getSortedList('volume', 25) || []).map(withDelta); } catch (e) {}
  try { status   = polyDB.getStatus() || {}; } catch (e) {}

  page(res, 'polymarket', '/polymarket', {
    title: 'ترند های پلی مارکت | بازارهای پیش‌بینی مرتبط با ایران — سیگنال هوش',
    desc: 'پایش بازارهای پیش‌بینی پلی‌مارکت مرتبط با ایران: احتمال وقوع رویدادها، حجم معاملات و تغییرات توجه معامله‌گران، با ترجمه‌ی فارسی.',
    path: '/polymarket'
  }, { trending, volume, lastFetched: (status.trending && status.trending.last_fetched) || null });
});

// برچسب فارسی نمادها و گره‌های سیگنال
// کلیدها باید دقیقاً با symbol در finance.db و target در timeline.db یکی باشند،
// وگرنه کد خام مثل «gold18» به کاربر نشان داده می‌شود.
const SYM = {
  usd: 'دلار آزاد', gold18: 'طلای ۱۸ عیار', coin: 'سکه امامی', mesghal: 'مثقال طلا',
  ounce: 'انس جهانی طلا', eur: 'یورو', tether: 'تتر',
  bitcoin: 'بیت‌کوین', btc: 'بیت‌کوین', ethereum: 'اتریوم', eth: 'اتریوم',
  oil_brent: 'نفت برنت', oil: 'نفت', stock_market: 'بورس تهران', bourse: 'بورس تهران',
  coin_bubble: 'حباب سکه', nim: 'نیم سکه', rob: 'ربع سکه'
};

// موضوع محرک الگو — مقادیر خام انگلیسی در جدول pattern_library
const TOPIC = {
  economy: 'اقتصاد', war: 'جنگ و تنش', politics: 'سیاست', energy: 'انرژی',
  tech: 'فناوری', sport: 'ورزش', social: 'اجتماعی', health: 'سلامت',
  culture: 'فرهنگ', general: 'عمومی', other: 'سایر'
};
const topicLabel = t => TOPIC[t] || t || '—';
const CHAIN_STATUS = { active: 'فعال', closed: 'بسته‌شده', expired: 'منقضی' };
const NODE = { trend: 'ترند جستجو', news: 'خبر', poly: 'پلی‌مارکت', market: 'بازار', telegram: 'تلگرام' };
const REGIME = { war: 'پرتنش', normal: 'عادی', calm: 'آرام', volatile: 'پرنوسان' };
const symLabel = s => SYM[s] || s || '—';

app.get('/future', (req, res) => {
  const tl = (sql, args) => {
    try { return timelineRO.prepare(sql).all(...(args || [])); } catch (e) { return []; }
  };

  const predictions = tl(`SELECT * FROM predictions WHERE status='open' ORDER BY created_at DESC LIMIT 12`)
    .map(p => {
      let attr = null;
      try { attr = p.attribution_json ? JSON.parse(p.attribution_json) : null; } catch (e) {}
      return Object.assign({}, p, {
        symLabel: symLabel(p.target),
        regimeLabel: REGIME[p.regime] || p.regime,
        conf: p.calibrated_confidence != null ? p.calibrated_confidence : p.confidence,
        attr
      });
    });

  const chains = tl(`SELECT * FROM signal_chains WHERE status='active' ORDER BY peak_severity DESC, created_at DESC LIMIT 8`)
    .map(c => Object.assign({}, c, {
      rootLabel: NODE[c.root_node] || c.root_node,
      regimeLabel: REGIME[c.regime] || c.regime,
      statusLabel: CHAIN_STATUS[c.status] || c.status,
      topicLabel: topicLabel(c.topic)
    }));

  const patterns = tl(`SELECT * FROM pattern_library WHERE sample_count >= 2 ORDER BY reliability DESC, sample_count DESC LIMIT 15`)
    .map(p => Object.assign({}, p, {
      symLabel: symLabel(p.target),
      nodeLabel: NODE[p.trigger_node] || p.trigger_node,
      topicLabel: topicLabel(p.trigger_topic)
    }));

  const accuracy = tl(`SELECT * FROM accuracy_metrics WHERE scope='target' ORDER BY total DESC LIMIT 10`)
    .map(a => Object.assign({}, a, {
      symLabel: symLabel(a.scope_key),
      dirPct: a.total ? (a.correct_dir / a.total) * 100 : null
    }));

  const indicators = tl(`SELECT indicator, target, MAX(accuracy) accuracy, MAX(sample_count) sample_count,
                                MIN(lead_time_min) lead_time_min, MAX(correlation) correlation
                         FROM leading_indicators WHERE sample_count >= 10
                         GROUP BY indicator, target ORDER BY accuracy DESC LIMIT 12`)
    .map(i => Object.assign({}, i, { indLabel: NODE[i.indicator] || i.indicator, symLabel: symLabel(i.target) }));

  const archive = tl(`SELECT p.target, p.time_horizon, p.direction, p.predicted_pct, v.*
                      FROM prediction_validations v JOIN predictions p ON p.id = v.prediction_id
                      ORDER BY v.rowid DESC LIMIT 12`)
    .map(a => Object.assign({}, a, { symLabel: symLabel(a.target) }));

  // دقت کلی از جدول accuracy_metrics (اسکوپ کلی اگر بود، وگرنه میانگین وزنی)
  let acc = { dir: null, n: 0 }, confidence = null;
  try {
    const g = timelineRO.prepare(`SELECT SUM(total) t, SUM(correct_dir) c FROM accuracy_metrics WHERE scope='target'`).get();
    if (g && g.t) { acc = { dir: (g.c / g.t) * 100, n: g.t }; confidence = (g.c / g.t) * 100; }
  } catch (e) {}

  let regime = null;
  try { regime = timelineRO.prepare(`SELECT * FROM market_regimes ORDER BY rowid DESC LIMIT 1`).get(); } catch (e) {}

  page(res, 'future', '/future', {
    title: 'ترند آینده | زنجیره‌های علّی و پیش‌بینی بازار ایران — سیگنال هوش',
    desc: 'موتور کشف زنجیره‌های علّی: چه خبری چه بازاری را با چه تأخیری حرکت می‌دهد. پیش‌بینی دلار، سکه و طلا با سنجش شفاف دقت.',
    path: '/future'
  }, { predictions, chains, patterns, accuracy, indicators, archive, acc, confidence, regime, REGIME });
});

// ── ارتباط با ما ──
app.get('/contact', (req, res) => {
  page(res, 'contact', '/contact', {
    title: 'ارتباط با ما | سیگنال هوش',
    desc: 'راه ارتباطی با تیم سیگنال هوش — برای درخواست حذف داده، گزارش خطا یا هر پرسش دیگری.',
    path: '/contact'
  }, { sent: req.query.sent === '1', error: null });
});

app.post('/contact', contactLimiter, (req, res) => {
  const b = req.body || {};
  if (b.website) return res.redirect('/contact?sent=1');   // تله‌ی ربات
  const name = String(b.name || '').trim().slice(0, 80);
  const email = String(b.email || '').trim().slice(0, 120);
  const message = String(b.message || '').trim().slice(0, 4000);

  if (!name || !email || !message || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return page(res, 'contact', '/contact', {
      title: 'ارتباط با ما | سیگنال هوش', desc: 'ارتباط با تیم سیگنال هوش.', path: '/contact', noindex: true
    }, { sent: false, error: 'لطفاً نام، ایمیل معتبر و متن پیام را کامل وارد کنید.' });
  }

  try {
    msgDB.prepare(
      'INSERT INTO messages (name, email, topic, url, message, ip) VALUES (?,?,?,?,?,?)'
    ).run(name, email, String(b.topic || '').slice(0, 60), String(b.url || '').slice(0, 300),
          message, (req.headers['x-forwarded-for'] || req.ip || '').toString().slice(0, 45));
  } catch (e) { console.error('[contact]', e.message); }

  res.redirect('/contact?sent=1');
});

app.get('/disclaimer', (req, res) => {
  page(res, 'disclaimer', '', {
    title: 'سلب مسئولیت و منابع داده | سیگنال هوش',
    desc: 'سیگنال هوش داده‌های عمومی اینترنت را خودکار جمع‌آوری می‌کند و ناشر یا مالک این محتوا نیست. متن کامل سلب مسئولیت، فهرست منابع و روند درخواست حذف داده.',
    path: '/disclaimer'
  }, {});
});

// ════════════ پنل مدیریت ════════════
// از robots مسدود است و هدر noindex می‌گیرد.

function adminGuard(req, res, next) {
  const payload = auth.verifyToken((req.cookies && req.cookies.token) || '');
  if (!payload) return res.redirect('/admin/login');
  req.user = payload;
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
}

// بخش‌هایی که مدل هوش مصنوعی اختصاصی می‌پذیرند.
// کلید هر بخش در settings.json ذخیره می‌شود و lib/ai-client آن را می‌خواند؛
// اگر خالی باشد از ai_model عمومی استفاده می‌شود.
const AI_MODULES = [
  { key: 'ai_model_trends',     label: 'خلاصه‌ی هوشمند ترند سرچ',      file: 'ai-digest.js',   tag: 'digest' },
  { key: 'ai_model_categorize', label: 'دسته‌بندی خودکار کلیدواژه‌ها', file: 'crawler.js',     tag: 'trend-categorize' },
  { key: 'ai_model_news',       label: 'گزارش خبری هوشمند',            file: 'news-bot.js',    tag: 'news-digest' },
  { key: 'ai_model_jobs',       label: 'تحلیل بازار کار',              file: 'job-api.js',     tag: 'job-ai' },
  { key: 'timeline_ai_model',   label: 'ترند آینده (تایم‌لاین)',        file: 'timeline-ai.js', tag: 'tl-ai' },
];

const DB_LABELS = {
  'news.db': 'اخبار', 'trends.db': 'ترند سرچ', 'trend.db': 'ترند سرچ',
  'finance.db': 'بازار مالی', 'cars.db': 'خودرو', 'car.db': 'خودرو',
  'market.db': 'کالا', 'jobs.db': 'بازار کار', 'job.db': 'بازار کار',
  'polymarket.db': 'پلی‌مارکت', 'timeline.db': 'ترند آینده',
  'messages.db': 'پیام‌های تماس', 'users.db': 'کاربران',
};

// شمردن ۳۰هزار فایل رسانه در هر بار باز کردن پنل کند است — یک دقیقه کش می‌شود.
let _mediaCache = { at: 0, count: 0, mb: 0 };
function mediaStats() {
  if (Date.now() - _mediaCache.at < 60000) return _mediaCache;
  let count = 0, bytes = 0;
  try {
    const dir = path.join(__dirname, 'public', 'news-media');
    for (const f of fs.readdirSync(dir)) {
      try { bytes += fs.statSync(path.join(dir, f)).size; count++; } catch (e) {}
    }
  } catch (e) {}
  _mediaCache = { at: Date.now(), count, mb: Math.round(bytes / 1048576) };
  return _mediaCache;
}

function dbFiles() {
  const out = [];
  const seen = new Set();
  for (const dir of [path.join(__dirname, 'data'), __dirname]) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch (e) { continue; }
    for (const f of files) {
      if (!f.endsWith('.db') || seen.has(f)) continue;
      seen.add(f);
      try {
        const st = fs.statSync(path.join(dir, f));
        out.push({
          file: f,
          label: DB_LABELS[f] || f.replace(/\.db$/, ''),
          sizeMB: Math.round(st.size / 1048576 * 10) / 10,
          mtime: st.mtime.toISOString(),
          // بیش از ۶ ساعت بدون نوشتن = احتمالاً جمع‌آورنده‌ی آن بخش خوابیده
          stale: Date.now() - st.mtimeMs > 6 * 3600 * 1000,
        });
      } catch (e) {}
    }
  }
  return out.sort((a, b) => b.sizeMB - a.sizeMB);
}

function systemInfo(dbs) {
  let totalGB = 0, freeGB = 0, diskPct = 0;
  try {
    const s = fs.statfsSync('/');
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    totalGB = Math.round(total / 1073741824);
    freeGB  = Math.round(free / 1073741824 * 10) / 10;
    diskPct = total ? Math.round((1 - free / total) * 100) : 0;
  } catch (e) {}

  const up = process.uptime();
  const d = Math.floor(up / 86400), h = Math.floor((up % 86400) / 3600), m = Math.floor((up % 3600) / 60);
  const uptime = d ? d + ' روز و ' + h + ' ساعت' : (h ? h + ' ساعت و ' + m + ' دقیقه' : m + ' دقیقه');
  const media = mediaStats();

  return {
    totalGB, freeGB, diskPct, uptime,
    memMB: Math.round(process.memoryUsage().rss / 1048576),
    node: process.version,
    port: PORT,
    mediaCount: media.count,
    mediaMB: media.mb,
    dbTotalMB: Math.round(dbs.reduce((a, x) => a + x.sizeMB, 0)),
  };
}

const ADMIN_SECS = ['overview', 'users', 'channels', 'ai', 'messages', 'spam', 'blocked', 'system'];

function adminPage(req, res, extra) {
  const q = (sql, d) => { try { return newsRO.prepare(sql).get(); } catch (e) { return d; } };
  const news    = q('SELECT COUNT(*) c FROM news', { c: 0 }).c;
  const blockedN= q('SELECT COUNT(*) c FROM news WHERE blocked=1', { c: 0 }).c;

  let rules = [], hard = 0, soft = 0;
  try {
    rules = spam.list();
    hard = rules.filter(r => (r.severity || 'hard') === 'hard').length;
    soft = rules.length - hard;
  } catch (e) {}

  let messages = [], unread = 0, total = 0;
  try {
    messages = msgDB.prepare('SELECT * FROM messages ORDER BY read ASC, created_at DESC LIMIT 30').all();
    unread   = msgDB.prepare('SELECT COUNT(*) c FROM messages WHERE read=0').get().c;
    total    = msgDB.prepare('SELECT COUNT(*) c FROM messages').get().c;
  } catch (e) {}

  let blocked = [];
  try {
    blocked = newsRO.prepare(`
      SELECT n.id, n.text, n.text_fa, n.published_at, n.tg_link, n.blocked_rule, c.title channel_title
      FROM news n LEFT JOIN channels c ON c.id=n.channel_id
      WHERE n.blocked=1 ORDER BY n.published_at DESC LIMIT 20`).all();
  } catch (e) {}

  let users = [];
  try { users = db.getAllUsers() || []; } catch (e) {}

  let chNews = [], chFin = [];
  try { chNews = newsDB.getChannels() || []; } catch (e) {}
  try { chFin  = financeDB.getFinanceChannels() || []; } catch (e) {}

  const setAll = (() => { try { return settingsDB.getAll() || {}; } catch (e) { return {}; } })();
  const ai = {
    general: setAll.ai_model || aiClient.DEFAULT_PREFERRED,
    limit:   Number(setAll.ai_daily_limit || 150) || 150,
    used:    Number(setAll.ai_calls_used || 0) || 0,
    date:    setAll.ai_budget_date || '',
    modules: AI_MODULES.map(m => Object.assign({}, m, { value: setAll[m.key] || '' })),
  };

  // فهرست کامل OpenRouter (از کش، بدون انتظار شبکه). اگر هنوز واکشی
  // نشده باشد، دست‌کم مدل‌های پشتیبانِ خودِ برنامه نشان داده می‌شوند.
  const orCache = orModels.list();
  const models = orCache.models.length
    ? orCache.models
    : aiClient.FALLBACK_MODELS.map(id => ({ id, name: id, free: true, inM: 0, outM: 0, ctx: null }));
  const modelsMeta = {
    fetchedAt: orCache.fetchedAt,
    total: models.length,
    free: models.filter(m => m.free).length,
    cached: !!orCache.models.length,
  };
  const freeModels = models.filter(m => m.free);
  const dbs = dbFiles();
  const sec = ADMIN_SECS.indexOf(String((req.query && req.query.sec) || '')) !== -1
    ? String(req.query.sec) : 'overview';

  page(res, 'admin', '', {
    title: 'پنل مدیریت | سیگنال هوش', desc: 'پنل مدیریت', path: '/admin', noindex: true
  }, Object.assign({
    rules, messages, blocked, users, chNews, chFin, ai, models, modelsMeta, freeModels, dbs, sec,
    sys: systemInfo(dbs),
    stats: {
      news, blocked: blockedN, visible: news - blockedN,
      rules: rules.length, hard, soft, messages: total, unread,
      activeUsers: users.filter(u => u.active).length,
      admins: users.filter(u => u.role === 'superadmin').length,
    },
    flash:    (req.query && req.query.ok)  ? String(req.query.ok).slice(0, 200)  : null,
    flashErr: (req.query && req.query.err) ? String(req.query.err).slice(0, 200) : null,
  }, extra || {}));
}

// بازگشت به همان بخشی که کاربر در آن بود، همراه با پیام نتیجه
function backFrom(req, res, ok, err) {
  const p = req.path;
  let sec = 'overview';
  if (p.indexOf('/users') !== -1)         sec = 'users';
  else if (p.indexOf('/channels') !== -1) sec = 'channels';
  else if (p.indexOf('/ai') !== -1)       sec = 'ai';
  else if (p.indexOf('/messages') !== -1) sec = 'messages';
  else if (p.indexOf('/spam') !== -1)     sec = 'spam';
  else if (p.indexOf('/news') !== -1)     sec = 'blocked';
  const qs = ['sec=' + sec];
  if (ok)  qs.push('ok=' + encodeURIComponent(ok));
  if (err) qs.push('err=' + encodeURIComponent(err));
  res.redirect('/admin?' + qs.join('&'));
}

app.get('/admin/login', (req, res) => {
  if (auth.verifyToken((req.cookies && req.cookies.token) || '')) return backFrom(req, res);
  page(res, 'admin-login', '', {
    title: 'ورود به پنل مدیریت | سیگنال هوش', desc: 'ورود', path: '/admin/login', noindex: true
  }, { error: null });
});

app.post('/admin/login', loginLimiter, (req, res) => {
  const mobile = String((req.body && req.body.mobile) || '').trim()
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));   // ارقام فارسی → لاتین
  const password = String((req.body && req.body.password) || '');

  const fail = msg => page(res, 'admin-login', '', {
    title: 'ورود به پنل مدیریت | سیگنال هوش', desc: 'ورود', path: '/admin/login', noindex: true
  }, { error: msg });

  // ⚠️ verifyPassword شماره‌ی موبایل می‌گیرد، نه شیء کاربر
  const user = db.verifyPassword(mobile, password);
  if (!user) return fail('شماره موبایل یا رمز عبور نادرست است.');

  res.cookie('token', auth.signToken(user), {
    httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000,
    secure: process.env.NODE_ENV === 'production'
  });
  backFrom(req, res);
});

app.get('/admin/logout', (req, res) => { res.clearCookie('token'); res.redirect('/admin/login'); });

app.get('/admin', adminGuard, (req, res) => adminPage(req, res, { user: req.user }));

app.post('/admin/messages/:id/read', adminGuard, (req, res) => {
  try { msgDB.prepare('UPDATE messages SET read=1 WHERE id=?').run(req.params.id); } catch (e) {}
  backFrom(req, res);
});
app.post('/admin/messages/:id/delete', adminGuard, (req, res) => {
  try { msgDB.prepare('DELETE FROM messages WHERE id=?').run(req.params.id); } catch (e) {}
  backFrom(req, res);
});

app.post('/admin/spam/add', adminGuard, (req, res) => {
  const b = req.body || {};
  const pattern = String(b.pattern || '').trim();
  if (pattern) {
    try {
      spam.add(pattern, b.kind || 'contains', b.category || 'سایر');
      newsRW.prepare('UPDATE spam_rules SET severity=? WHERE pattern=?').run(b.severity === 'soft' ? 'soft' : 'hard', pattern);
      spam.invalidate();
    } catch (e) { console.error('[admin/spam]', e.message); }
  }
  backFrom(req, res);
});
app.post('/admin/spam/:id/toggle', adminGuard, (req, res) => {
  try {
    const cur = newsRW.prepare('SELECT enabled FROM spam_rules WHERE id=?').get(req.params.id);
    spam.toggle(req.params.id, !(cur && cur.enabled));
  } catch (e) {}
  backFrom(req, res);
});
app.post('/admin/spam/:id/delete', adminGuard, (req, res) => {
  try { spam.remove(req.params.id); } catch (e) {}
  backFrom(req, res);
});

app.post('/admin/news/:id/unblock', adminGuard, (req, res) => {
  try { newsRW.prepare('UPDATE news SET blocked=0, blocked_rule=NULL WHERE id=?').run(req.params.id); } catch (e) {}
  backFrom(req, res);
});

// ══ کاربران ══
// مشاهده‌ی سایت نیازی به حساب ندارد؛ این حساب‌ها فقط برای همین پنل است.

app.post('/admin/users/add', adminGuard, (req, res) => {
  const b = req.body || {};
  const mobile = String(b.mobile || '').trim().replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
  const password = String(b.password || '');
  const name = String(b.name || '').trim();
  const role = b.role === 'superadmin' ? 'superadmin' : 'user';

  if (!/^09\d{9}$/.test(mobile)) return backFrom(req, res, null, 'شماره موبایل معتبر نیست (مثال: 09123456789).');
  if (password.length < 6)        return backFrom(req, res, null, 'رمز عبور باید حداقل ۶ کاراکتر باشد.');

  try {
    db.createUser({ mobile, password, name: name || mobile, role });
    backFrom(req, res, 'کاربر «' + (name || mobile) + '» افزوده شد.');
  } catch (e) {
    backFrom(req, res, null, /[\u0600-\u06FF]/.test(e.message) ? e.message : 'خطا: ' + e.message);
  }
});

app.post('/admin/users/:id/toggle', adminGuard, (req, res) => {
  if (String(req.params.id) === String(req.user.id)) return backFrom(req, res, null, 'حساب خودتان را نمی‌توانید غیرفعال کنید.');
  try {
    // ⚠️ toggleActive(id, active) آرگومان دوم را «حالت مقصد» می‌گیرد، نه سوییچ.
    // بدون آن مقدار undefined ذخیره می‌شود و کاربر برای همیشه قفل می‌ماند.
    const u = (db.getAllUsers() || []).find(x => String(x.id) === String(req.params.id));
    if (!u) return backFrom(req, res, null, 'کاربر یافت نشد.');
    db.toggleActive(u.id, !u.active);
    backFrom(req, res, u.active ? 'کاربر غیرفعال شد.' : 'کاربر فعال شد.');
  } catch (e) { backFrom(req, res, null, 'خطا: ' + e.message); }
});

app.post('/admin/users/:id/delete', adminGuard, (req, res) => {
  if (String(req.params.id) === String(req.user.id)) return backFrom(req, res, null, 'حساب خودتان را نمی‌توانید حذف کنید.');
  try { db.deleteUser(req.params.id); backFrom(req, res, 'کاربر حذف شد.'); }
  catch (e) { backFrom(req, res, null, 'خطا: ' + e.message); }
});

// ══ کانال‌ها ══
// خبری → news-db، مالی → finance-db. حذف نرم است: جمع‌آوری متوقف می‌شود
// ولی اخبار قبلی روی سایت می‌مانند.

function chanApi(kind) {
  return kind === 'finance'
    ? { add: financeDB.upsertFinanceChannel, upd: financeDB.updateFinanceChannel, del: financeDB.deleteFinanceChannel, label: 'مالی' }
    : { add: newsDB.upsertChannel,           upd: newsDB.updateChannel,           del: newsDB.deleteChannel,           label: 'خبری' };
}

app.post('/admin/channels/add', adminGuard, (req, res) => {
  const b = req.body || {};
  const api = chanApi(b.kind);
  const username = String(b.username || '').trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '');
  const title = String(b.title || '').trim();
  if (!username) return backFrom(req, res, null, 'شناسه‌ی کانال را وارد کنید.');

  try {
    // tg_id واقعی را ربات هنگام اولین اتصال پر می‌کند؛ فعلاً شناسه‌ی موقت
    api.add('@' + username, username, title || username, String(b.category || '').trim() || null, null, b.needs_translation ? 1 : 0);
    backFrom(req, res, 'کانال ' + api.label + ' «' + (title || username) + '» افزوده شد.');
  } catch (e) {
    backFrom(req, res, null, /UNIQUE|exist/i.test(e.message) ? 'این کانال از قبل ثبت شده است.' : 'خطا: ' + e.message);
  }
});

app.post('/admin/channels/:id/save', adminGuard, (req, res) => {
  const b = req.body || {};
  const api = chanApi(b.kind);
  try {
    api.upd(req.params.id, {
      username: String(b.username || '').trim().replace(/^@/, ''),
      title: String(b.title || '').trim(),
      category: String(b.category || '').trim() || null,
      needs_translation: b.needs_translation ? 1 : 0,
    });
    backFrom(req, res, 'کانال «' + String(b.title || '').trim() + '» ذخیره شد.');
  } catch (e) { backFrom(req, res, null, 'خطا: ' + e.message); }
});

app.post('/admin/channels/:id/delete', adminGuard, (req, res) => {
  const api = chanApi((req.body || {}).kind);
  try { api.del(req.params.id); backFrom(req, res, 'جمع‌آوری از این کانال متوقف شد.'); }
  catch (e) { backFrom(req, res, null, 'خطا: ' + e.message); }
});

// ══ هوش مصنوعی ══
// lib/ai-client هر بار تنظیمات را تازه می‌خواند، پس تغییر بدون ری‌استارت اعمال می‌شود.

app.post('/admin/ai/save', adminGuard, (req, res) => {
  const b = req.body || {};
  try {
    // شناسه‌ی ناموجود را نپذیر — وگرنه آن بخش تا اصلاح دستی روی مدل پشتیبان می‌ماند
    const bad = [];
    const wanted = {};
    const gen = String(b.ai_model || '').trim();
    if (gen) { if (orModels.isKnown(gen)) wanted.ai_model = gen; else bad.push(gen); }
    for (const m of AI_MODULES) {
      const v = String(b[m.key] || '').trim();
      if (!v) { wanted[m.key] = ''; continue; }
      if (orModels.isKnown(v)) wanted[m.key] = v; else bad.push(v);
    }
    if (bad.length) return backFrom(req, res, null, 'این شناسه‌ها در فهرست OpenRouter نیستند: ' + bad.join('، '));
    for (const k in wanted) settingsDB.set(k, wanted[k]);

    const lim = parseInt(String(b.ai_daily_limit || '').replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)), 10);
    if (!isNaN(lim) && lim >= 0 && lim <= 10000) settingsDB.set('ai_daily_limit', lim);

    backFrom(req, res, 'تنظیمات هوش مصنوعی ذخیره شد و بلافاصله اعمال می‌شود.');
  } catch (e) { backFrom(req, res, null, 'خطا: ' + e.message); }
});

app.post('/admin/ai/refresh-models', adminGuard, async (req, res) => {
  try {
    const d = await orModels.refresh();
    backFrom(req, res, 'فهرست مدل‌ها تازه شد — ' + d.models.length + ' مدل، ' +
      d.models.filter(m => m.free).length + ' مورد رایگان.');
  } catch (e) { backFrom(req, res, null, 'واکشی فهرست ناموفق بود: ' + e.message); }
});

app.post('/admin/ai/reset-budget', adminGuard, (req, res) => {
  try {
    settingsDB.set('ai_calls_used', 0);
    settingsDB.set('ai_daily_limit_hit', false);
    backFrom(req, res, 'شمارنده‌ی مصرف امروز صفر شد.');
  } catch (e) { backFrom(req, res, null, 'خطا: ' + e.message); }
});

// بارگذاری تدریجی فید اخبار — تا پیش از این، اسکریپت سمت مرورگر
// همان ردیف‌های موجود را کپی می‌کرد و خبر تکراری نشان می‌داد.
app.get('/news/more', (req, res) => {
  const offset  = Math.min(parseInt(req.query.offset, 10) || 0, 2000);
  const channel = req.query.channel || null;
  const cat     = req.query.cat || null;
  const LIMIT   = 20;

  let rows = [];
  try { rows = fetchNews(LIMIT, channel, offset, cat) || []; } catch (e) { console.warn('[news/more]', e.message); }
  rows.forEach(n => { n.isNew = false; n.hot = false; });

  res.set('Cache-Control', 'public, max-age=60');
  if (!rows.length) return res.json({ count: 0, done: true, html: '' });

  let pending = rows.length;
  const parts = new Array(rows.length);
  rows.forEach((n, i) => {
    res.app.render('partials/news-row', { n, fa, timeAgo, mediaOf, excerpt, clean: txt.clean }, (e, out) => {
      parts[i] = e ? '' : out;
      if (--pending === 0) res.json({ count: rows.length, done: rows.length < LIMIT, html: parts.join('') });
    });
  });
});

// ── robots و sitemap ──
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    'User-agent: *\n' +
    'Allow: /\n' +
    'Disallow: /api/\n' +
    'Disallow: /internal/\n' +
    'Disallow: /admin\n' +
    'Disallow: /legacy\n' +
    'Disallow: /news/page/\n\n' +
    'Sitemap: ' + SITE + '/sitemap.xml\n'
  );
});

app.get('/sitemap.xml', (req, res) => {
  const urls = [
    { loc: '/', pri: '1.0', freq: 'hourly' },
    { loc: '/trends', pri: '0.9', freq: 'hourly' },
    { loc: '/news', pri: '0.9', freq: 'hourly' },
    { loc: '/finance', pri: '0.9', freq: 'hourly' },
    { loc: '/cars', pri: '0.8', freq: 'daily' },
    { loc: '/market', pri: '0.8', freq: 'daily' },
    { loc: '/jobs', pri: '0.7', freq: 'daily' },
    { loc: '/polymarket', pri: '0.7', freq: 'daily' },
    { loc: '/future', pri: '0.6', freq: 'daily' },
    { loc: '/contact', pri: '0.4', freq: 'monthly' },
    { loc: '/disclaimer', pri: '0.4', freq: 'monthly' }
  ];
  let items = '';
  try {
    for (const r of newsRO.prepare('SELECT id, published_at FROM news ORDER BY published_at DESC LIMIT 2000').all()) {
      items += `<url><loc>${SITE}/news/${r.id}</loc><lastmod>${new Date(r.published_at).toISOString()}</lastmod><changefreq>never</changefreq><priority>0.6</priority></url>`;
    }
  } catch (e) {}
  res.type('application/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    urls.map(u => `<url><loc>${SITE}${u.loc}</loc><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('') +
    items + '</urlset>'
  );
});

// ── ۴۰۴ واقعی ──
app.use((req, res) => {
  res.status(404);
  page(res, 'notfound', '', {
    title: 'صفحه پیدا نشد | سیگنال هوش',
    desc: 'صفحه‌ی موردنظر پیدا نشد.',
    path: req.path,
    noindex: true
  }, {});
});

app.listen(PORT, () => {
  console.log(`[web-test] رندر سمت سرور روی پورت ${PORT} — سایت اصلی (۳۰۰۱) دست‌نخورده است`);
});
