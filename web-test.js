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
const goldDB    = require('./gold-db');
const propDB    = require('./property-db');
const commodityDB = require('./commodity-db');
const commodityCrawler = require('./commodity-crawler');
const insightsDB = require('./insights-db');
const tlSkill    = require('./timeline-skill');
const tlPredict  = require('./timeline-predict');
const tlSignals  = require('./timeline-signals');
const tlBacktest = require('./timeline-backtest');
const blogDB     = require('./blog-db');
const blogWriter = require('./blog-writer');
const mdown      = require('./lib/markdown');
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
  { href: '/trends',     label: 'ترند سرچ' },
  { href: '/news',       label: 'ترند اخبار' },
  { href: '/finance',    label: 'ترند مالی' },
  { href: '/property',   label: 'ترند ملک' },
  { href: '/cars',       label: 'ترند خودرو' },
  { href: '/market',     label: 'ترند کالا' },
  { href: '/jobs',       label: 'ترند بازار کار' },
  { href: '/polymarket', label: 'ترند پلی‌مارکت' },
  { href: '/future',     label: 'پیش‌بینی ترند' }
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
// مسیر راهنما در صفحه دیده می‌شود ولی برای گوگل نشانه‌گذاری نشده بود؛
// با این نشانه‌گذاری، در نتایج جستجو به‌جای آدرس خام، مسیر فارسی می‌آید.
function breadcrumbFor(active) {
  const tab = TABS.find(t => t.href === active);
  if (!tab || tab.href === '/') return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'خانه', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: tab.label, item: SITE + tab.href },
    ],
  };
}

function breadcrumbLeaf(active, leaf) {
  const base = breadcrumbFor(active);
  if (!base || !leaf) return base;
  base.itemListElement.push({ '@type': 'ListItem', position: 3, name: leaf.name, item: SITE + leaf.item });
  return base;
}

function page(res, tpl, active, seo, data, jsonld) {
  // صفحات عمومی می‌توانند در لبه کش شوند. s-maxage فقط برای کش مشترک
  // (nginx و Cloudflare) است؛ مرورگر کاربر با max-age کوتاه‌تر تازه می‌ماند.
  // بدون این، هر بازدیدکننده مستقیم به سرور می‌خورد و زیر ترافیک، همین
  // نقطه اول از همه‌جا کم می‌آورد.
  if (!seo || !seo.noindex) {
    res.set('Cache-Control', 'public, max-age=30, s-maxage=120, stale-while-revalidate=600');
  } else {
    res.set('Cache-Control', 'no-store');
  }
  const locals = Object.assign({
    fa, num, toman, pct, usd, excerpt, timeAgo, timeUntil, faSigned, faDate, faDay, mediaOf,
    clean: txt.clean, rankBadge, sparkPath, sparkArea, trendDir,
    SITE, TABS, active, ASSETS
  }, data);
  res.render('pages/' + tpl, locals, (err, body) => {
    if (err) { console.error('[render]', tpl, err.message); return res.status(500).send('خطا در رندر صفحه'); }
    const crumb = (seo && seo.crumb) ? breadcrumbLeaf(active, seo.crumb) : breadcrumbFor(active);
    let ld = jsonld || null;
    if (crumb) ld = ld ? [].concat(ld, crumb) : crumb;
    res.render('layout', Object.assign({}, locals, { body, seo, jsonld: ld }), (e2, html) => {
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
  og_default: '/og-default.png?v=' + assetVersion('og-default.png'),
  tokens:     '/assets/css/tokens.css?v='     + assetVersion('assets/css/tokens.css'),
  base:       '/assets/css/base.css?v='       + assetVersion('assets/css/base.css'),
  components: '/assets/css/components.css?v=' + assetVersion('assets/css/components.css'),
  app:        '/assets/js/app.js?v='          + assetVersion('assets/js/app.js')
};

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      // unsafe-inline لازم است چون استایل و اسکریپت درون‌خطی داریم؛
      // ولی دامنه‌های مجاز محدودند، پس تزریق از بیرون همچنان بسته است
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://www.googletagmanager.com', 'https://www.google-analytics.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https://www.google-analytics.com', 'https://region1.google-analytics.com', 'https://www.googletagmanager.com'],
      frameSrc: ['https://t.me', 'https://*.t.me'],   // امبد ویدیوی خبر
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
  // امبد تلگرام از دامنه‌ی دیگری می‌آید و با same-origin بلاک می‌شود
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// دسترسی‌هایی که این سایت هرگز لازم ندارد
app.use((req, res, next) => {
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  next();
});

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

/**
 * خلاصه‌ی ملک برای تب خانه — گران‌ترین و ارزان‌ترین سر و ته شهر، به‌همراه
 * نقشه‌ی کوچک. هر تب تازه باید نشانه‌ای در خانه بگذارد وگرنه کاربری که
 * فقط صفحه‌ی اول را می‌بیند از وجودش خبردار نمی‌شود.
 */
function propertyHome() {
  try {
    const m = propertyModel();
    if (!m.rows.length) return null;
    return {
      city: m.city, map: m.map,
      top: m.rows.slice(0, 3),
      bottom: m.rows.slice(-3).reverse(),
      best: m.oppRows[0] || null,
      count: m.rows.length,
    };
  } catch (e) { console.warn('[home/property]', e.message); return null; }
}

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
    property: propertyHome(),
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
  // قطعه‌ی HTML برای اسکرول بی‌نهایت است، نه صفحه‌ی مستقل — گوگل نباید ایندکسش کند
  res.set('X-Robots-Tag', 'noindex, nofollow');
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

// نمودار میل به جستجو — منحنی واقعی خود گوگل‌ترند که کرالر کش کرده است.
// هندسه عمداً با همان قرارداد گوگل ساخته می‌شود (viewBox 0 0 128 48، x از ۲ تا ۱۲۶
// و y از ۶ تا ۴۶) تا نمودار ما دقیقاً هم‌شکل چیزی باشد که در خود گوگل دیده می‌شود.
function curveGeometry(points) {
  const v = (points || []).map(Number).filter(x => !isNaN(x));
  if (v.length < 2) return null;
  const min = Math.min.apply(null, v), max = Math.max.apply(null, v);
  const span = (max - min) || 1;
  const step = 124 / (v.length - 1);
  const pts = v.map((y, i) => {
    const x = (2 + i * step).toFixed(0);
    const yy = (46 - ((y - min) / span) * 40).toFixed(0);
    return x + ',' + yy;
  });
  return { line: pts.join(' '), fill: '2,48 ' + pts.join(' ') + ' 126,48' };
}

function withCurve(list, window) {
  let map = new Map();
  try { map = trendDB.getCurveMap(window) || new Map(); } catch (e) {}
  return list.map(t => {
    const g = curveGeometry(map.get(t.keyword));
    return Object.assign({}, t, {
      curveLine: g ? g.line : '',
      curveFill: g ? g.fill : '',
    });
  });
}

app.get('/trends', (req, res) => {
  const j4  = readJson('h4.json', {});
  const j24 = readJson('h24.json', {});
  const h4  = withCurve(Array.isArray(j4.trends) ? j4.trends : [], '4h');
  const h24 = withCurve(Array.isArray(j24.trends) ? j24.trends : [], '24h');
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

  let kwCount = 0;
  try { kwCount = keywordIndex().length; } catch (e) {}

  page(res, 'trends', '/trends', {
    title: 'ترند سرچ ایران | پرجستجوترین کلیدواژه‌های گوگل — سیگنال هوش',
    desc: 'پرجستجوترین کلیدواژه‌های گوگل در ایران در بازه‌های ۴ و ۲۴ ساعته، همراه با حجم جستجو، رشد و تاریخچه‌ی کامل ترندها.',
    path: '/trends'
  }, { h4, h24, stats, hall, persistent, meteors, topCats, catTotal, kwCount, kwSlug });
});

// ══════════════ آرشیو کلیدواژه‌ها و صفحه‌ی مستقل هر کلیدواژه ══════════════

// فهرست کامل ۲۳۵ میلی‌ثانیه طول می‌کشد و در هر بازدید لازم می‌شود؛
// ۱۰ دقیقه کش می‌شود (کرال ترند هر ۵ دقیقه است، پس تازگی کافی است).
let _kwCache = { at: 0, rows: [], slugs: null };
function keywordIndex() {
  if (Date.now() - _kwCache.at < 10 * 60 * 1000 && _kwCache.rows.length) return _kwCache.rows;
  let rows = [];
  try { rows = trendDB.getKeywordIndex() || []; } catch (e) { return _kwCache.rows; }
  const slugs = new Map();
  for (const r of rows) {
    r.slug = kwSlug(r.keyword);
    // اگر دو کلیدواژه به یک نامک برسند، اولی (پرحجم‌تر، چون مرتب است) برنده است
    if (!slugs.has(r.slug)) slugs.set(r.slug, r.keyword);
  }
  _kwCache = { at: Date.now(), rows, slugs };
  return rows;
}
// نامک: فاصله‌ها به خط تیره. حروف فارسی در URL می‌مانند و گوگل آن‌ها را
// درست می‌خواند (همان کاری که ویکی‌پدیای فارسی می‌کند).
function kwSlug(kw) {
  return String(kw || '').trim().replace(/\s+/g, '-');
}
function keywordFromSlug(slug) {
  keywordIndex();
  const s = String(slug || '').trim();
  if (_kwCache.slugs && _kwCache.slugs.has(s)) return _kwCache.slugs.get(s);
  // اگر کش هنوز نساخته یا کلیدواژه تازه است، مستقیم امتحان کن
  const direct = s.replace(/-/g, ' ');
  try { if (trendDB.getKeywordProfile(direct)) return direct; } catch (e) {}
  try { if (trendDB.getKeywordProfile(s)) return s; } catch (e) {}
  return null;
}

const KW_CATS = ['ورزشی', 'اقتصادی', 'سیاسی', 'سرگرمی', 'اجتماعی', 'مذهبی', 'تکنولوژی', 'خودرو', 'سلامت', 'مالی', 'قیمت کالا', 'علم'];

app.get('/trends/keywords', (req, res) => {
  const all = keywordIndex();
  const cat  = req.query.cat ? String(req.query.cat) : null;
  const sort = ['vol', 'days', 'recent', 'growth'].includes(String(req.query.sort)) ? String(req.query.sort) : 'vol';
  const page_ = Math.max(1, Math.min(60, parseInt(req.query.p, 10) || 1));
  const PER = 60;

  let rows = cat ? all.filter(r => r.cat === cat) : all.slice();
  if (sort === 'days')        rows.sort((a, b) => b.days - a.days || b.peak_vol - a.peak_vol);
  else if (sort === 'recent') rows.sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)));
  else if (sort === 'growth') rows.sort((a, b) => (b.peak_growth || 0) - (a.peak_growth || 0) || b.peak_vol - a.peak_vol);

  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / PER));
  const p = Math.min(page_, pages);
  const slice = rows.slice((p - 1) * PER, p * PER);

  // شمارش هر دسته برای نوار فیلتر
  const catCounts = new Map();
  for (const r of all) if (r.cat) catCounts.set(r.cat, (catCounts.get(r.cat) || 0) + 1);
  const cats = KW_CATS.filter(c => catCounts.has(c)).map(c => ({ name: c, n: catCounts.get(c) }));

  const qs = (o) => {
    const q = [];
    const c = o.cat !== undefined ? o.cat : cat;
    const s = o.sort !== undefined ? o.sort : sort;
    const pg = o.p !== undefined ? o.p : null;
    if (c) q.push('cat=' + encodeURIComponent(c));
    if (s && s !== 'vol') q.push('sort=' + s);
    if (pg && pg > 1) q.push('p=' + pg);
    return '/trends/keywords' + (q.length ? '?' + q.join('&') : '');
  };

  const titleBase = cat ? `کلیدواژه‌های ترند دسته‌ی ${cat}` : 'آرشیو کلیدواژه‌های ترند جستجوی ایران';
  page(res, 'trend-keywords', '/trends', {
    title: titleBase + (p > 1 ? ` — صفحه ${fa(p)}` : '') + ' | سیگنال هوش',
    desc: `فهرست ${fa(total)} کلیدواژه‌ی ترندشده‌ی گوگل در ایران` + (cat ? ` در دسته‌ی ${cat}` : '') +
          '، با حجم جستجو، بیشترین رشد، بهترین رتبه و تاریخ حضور هر کدام.',
    path: qs({ p }),
    // صفحات دوم به بعد ایندکس نمی‌شوند تا محتوای نازک و تکراری تولید نشود
    noindex: p > 1
  }, {
    rows: slice, total, p, pages, cat, sort, cats,
    prevUrl: p > 1 ? qs({ p: p - 1 }) : null,
    nextUrl: p < pages ? qs({ p: p + 1 }) : null,
    qs, kwSlug,
  });
});

app.get('/trends/:slug', (req, res, next) => {
  const keyword = keywordFromSlug(req.params.slug);
  if (!keyword) return next();

  let prof = null;
  try { prof = trendDB.getKeywordProfile(keyword); } catch (e) {}
  if (!prof) return next();

  let daily = [], windows = [], curves = {}, related = [];
  try { daily   = trendDB.getKeywordDaily(keyword) || []; } catch (e) {}
  try { windows = trendDB.getKeywordWindows(keyword) || []; } catch (e) {}
  try { curves  = trendDB.getKeywordCurves(keyword) || {}; } catch (e) {}
  try { related = trendDB.getRelatedKeywords(keyword, 10) || []; } catch (e) {}

  // نمودار ستونی حجم روزانه
  const maxVol = daily.reduce((m, d) => Math.max(m, d.vol || 0), 0) || 1;
  const dayLabel = (d) => {
    try {
      return new Intl.DateTimeFormat('fa-IR', { month: 'short', day: 'numeric' }).format(new Date(d + 'T00:00:00Z'));
    } catch (e) { return fa(d.slice(5)); }
  };
  const bars = daily.map(d => ({
    day: d.day, vol: d.vol, growth: d.growth, best_rank: d.best_rank,
    label: dayLabel(d.day),
    h: Math.max(3, Math.round((d.vol / maxVol) * 100)),
  }));

  // منحنی میل به جستجو با همان هندسه‌ی گوگل
  const curveOf = w => {
    const c = curves[w];
    if (!c) return null;
    const g = curveGeometry(c.points);
    return g ? { line: g.line, fill: g.fill, updated_at: c.updated_at } : null;
  };
  const curve4 = curveOf('4h'), curve24 = curveOf('24h');

  // خبرهای همان بازه که این عبارت در متنشان آمده — محدود به بازه‌ی
  // فعال بودن کلیدواژه، وگرنه LIKE روی ۸۰ هزار خبر کند می‌شود
  let news = [];
  try {
    const from = prof.first_day;
    const to = new Date(new Date(prof.last_day + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
    news = markNews(newsRO.prepare(`
      SELECT n.*, c.title AS channel_title, c.username AS channel_username
      FROM news n LEFT JOIN channels c ON c.id = n.channel_id
      WHERE COALESCE(n.blocked,0)=0
        AND n.published_at >= ? AND n.published_at < ?
        AND (n.text_fa LIKE ? OR n.text LIKE ?)
      ORDER BY n.published_at DESC LIMIT 6
    `).all(from, to, '%' + keyword + '%', '%' + keyword + '%'));
  } catch (e) { news = []; }

  const active = prof.latest && prof.latest.active;
  const volText = prof.peak_vol >= 1000 ? fa(Math.round(prof.peak_vol / 1000)) + ' هزار' : fa(prof.peak_vol);
  const intro =
    `«${keyword}» ` +
    (prof.days > 1
      ? `در ${fa(prof.days)} روز از ${faDay(prof.first_day)} تا ${faDay(prof.last_day)} در فهرست ترندهای جستجوی گوگل ایران دیده شده`
      : `در ${faDay(prof.first_day)} در فهرست ترندهای جستجوی گوگل ایران دیده شده`) +
    ` و در اوج خود به ${volText} جستجو` +
    (prof.best_rank ? ` و رتبه‌ی ${fa(prof.best_rank)} ` : ' ') +
    `رسیده است` +
    (prof.cat ? `. دسته‌بندی این عبارت «${prof.cat}» است` : '') + '.';

  page(res, 'trend-keyword', '/trends', {
    title: `${keyword} — ترند جستجو، حجم و تاریخچه | سیگنال هوش`,
    desc: `حجم جستجو، رشد، رتبه و نمودار تاریخچه‌ی عبارت «${keyword}» در ترندهای گوگل ایران` +
          (prof.peak_vol ? ` — اوج ${volText} جستجو` : '') +
          (prof.days > 1 ? `، ${fa(prof.days)} روز حضور` : '') + '.',
    // درصدگذاری‌شده تا دقیقاً با همان نشانی‌ای که در سایت‌مپ آمده یکی باشد
    path: '/trends/' + encodeURIComponent(kwSlug(keyword)),
  }, {
    kw: keyword, prof, daily, bars, windows, curve4, curve24, related, news, active, intro, kwSlug,
  }, {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: `ترند جستجوی «${keyword}» در ایران`,
    description: intro,
    url: SITE + '/trends/' + encodeURIComponent(kwSlug(keyword)),
    temporalCoverage: prof.first_day + '/' + prof.last_day,
    isAccessibleForFree: true,
    creator: { '@type': 'Organization', name: 'سیگنال هوش', url: SITE },
    variableMeasured: [
      { '@type': 'PropertyValue', name: 'اوج حجم جستجو', value: prof.peak_vol },
      { '@type': 'PropertyValue', name: 'بهترین رتبه', value: prof.best_rank },
      { '@type': 'PropertyValue', name: 'روزهای حضور', value: prof.days },
    ],
  });
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

  // ── پلتفرم‌های طلای آنلاین ──
  // getLatest از ارزان به گران مرتب می‌آید، پس ردیف اول کف بازار است.
  let goldRows = [], goldChart = null, goldUpdated = null, goldSpread = null;
  try {
    const rows = (goldDB.getLatest() || []).filter(r => r.price != null);
    if (rows.length) {
      const floor = rows[0].price;
      const top   = rows[rows.length - 1].price;
      goldRows = rows.map((r, i) => Object.assign({}, r, {
        diff: Math.round(r.price - floor),
        isFloor: i === 0,
        isTop: rows.length > 2 && r.price === top && i > 0,
      }));
      goldSpread = Math.round(top - floor);
      goldUpdated = rows.reduce((m, r) => (r.captured_at > m ? r.captured_at : m), rows[0].captured_at);
    }
  } catch (e) { console.warn('[gold]', e.message); }

  // نمودار مشترک: همه‌ی پلتفرم‌ها روی یک محور تا اختلافشان دیده شود
  try {
    const series = (goldDB.getSeries(24) || []).filter(s => s.points.length > 1);
    if (series.length) {
      const all = series.flatMap(s => s.points);
      const vs = all.map(p => p.v);
      const ts = all.map(p => new Date(p.t).getTime());
      const vMin = Math.min.apply(null, vs), vMax = Math.max.apply(null, vs);
      const tMin = Math.min.apply(null, ts), tMax = Math.max.apply(null, ts);
      const vSpan = (vMax - vMin) || 1, tSpan = (tMax - tMin) || 1;
      const W = 600, H = 180;
      goldChart = {
        vMin, vMax, W, H,
        lines: series.map((s, i) => ({
          name_fa: s.name_fa, slug: s.slug,
          hue: Math.round((i * 360) / series.length),
          last: s.points[s.points.length - 1].v,
          d: s.points.map(p => {
            const x = ((new Date(p.t).getTime() - tMin) / tSpan) * W;
            const y = H - ((p.v - vMin) / vSpan) * H;
            return x.toFixed(1) + ',' + y.toFixed(1);
          }).join(' '),
        })),
      };
    }
  } catch (e) { console.warn('[gold/chart]', e.message); }

  // ── قیمت جهانی کالا (نفت، فلزات، محصولات کشاورزی) ──
  let commodityGroups = [], commodityStatus = null;
  try {
    const all = commodityDB.getLatestAll() || [];
    commodityStatus = commodityDB.getStatus();
    commodityGroups = commodityCrawler.CAT_ORDER
      .map(key => ({
        key, label: commodityCrawler.CAT_FA[key],
        items: all.filter(r => r.category === key).map(r => {
          let hist = [];
          try { hist = (commodityDB.getSeries(r.slug, 72) || []).map(x => x.price).filter(v => v != null); } catch (e) {}
          return Object.assign({}, r, {
            curated: commodityCrawler.CURATED[r.slug] || {},
            nameFa: (commodityCrawler.CURATED[r.slug] || {}).fa || r.slug,
            priceText: finText(r.price),
            hist,
            sparkPoly: hist.length > 1 ? sparkPoints(hist, 64, 20) : '',
          });
        }),
      }))
      .filter(g => g.items.length);
  } catch (e) { console.warn('[finance/commodity]', e.message); }

  page(res, 'finance', '/finance', {
    title: 'ترند بازارهای مالی | قیمت لحظه‌ای دلار، طلا، سکه و انس — سیگنال هوش',
    desc: 'رصد لحظه‌ای بازارهای موازی ایران: دلار آزاد، طلای ۱۸ عیار، سکه امامی و انس جهانی طلا، همراه با جریان اخبار مالی کانال‌های تلگرام.',
    path: '/finance'
  }, { rows, kpi: rows.slice(0, 4), messages, channels, goldRows, goldChart, goldUpdated, goldSpread,
       commodityGroups, commodityStatus });
});

app.get('/cars', (req, res) => {
  let raw = [], stats = {}, momentum = [], value = [], submodels = [];
  try { raw       = carDB.getLatest() || []; } catch (e) { console.warn('[cars]', e.message); }
  try { stats     = carDB.getStats() || {}; } catch (e) {}
  try { momentum  = carDB.getMomentum(7) || []; } catch (e) {}
  try { value     = carDB.getValueScores() || []; } catch (e) {}
  try { submodels = carDB.getLatestSubmodels() || []; } catch (e) {}

  /* زیرمدل‌ها بر اساس رده و نام برند مرتب برمی‌گردند. با برداشتن ۸ تای
     اول، هر هشت‌تا از یک برند درمی‌آمد و بقیه‌ی برندها اصلاً دیده نمی‌شدند.
     گروه‌بندی می‌کنیم تا «تنوع» واقعاً تنوع باشد. */
  const submodelGroups = [];
  {
    const by = new Map();
    for (const s of submodels) {
      const k = s.model_slug || s.model_name || '?';
      if (!by.has(k)) by.set(k, { slug: k, name: s.model_name || k, tier: s.model_tier, items: [] });
      by.get(k).items.push(s);
    }
    for (const g of by.values()) {
      g.total = g.items.length;
      g.items.sort((x, y) => (y.avg_price || 0) - (x.avg_price || 0));
      g.top = g.items.slice(0, 5);
      g.rest = g.items.slice(5);
      submodelGroups.push(g);
    }
    const TIER_ORD = { high: 0, mid: 1, low: 2 };
    submodelGroups.sort((x, y) =>
      (TIER_ORD[x.tier] == null ? 9 : TIER_ORD[x.tier]) - (TIER_ORD[y.tier] == null ? 9 : TIER_ORD[y.tier])
      || (y.total - x.total));
  }

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
    cars, stats, submodels, submodelGroups, metrics, series, tiers, scatter,
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

  // دروازه‌ی مهارت: پیش‌بینی برای نمادی که هنوز روی داده‌ی خودش برتری نشان
  // نداده، ساخته و اعتبارسنجی می‌شود (تا یاد بگیرد) ولی به کاربر نشان داده
  // نمی‌شود. نمایش پیش‌بینی‌ای که دقتش زیر پرتاب سکه است، فقط اعتبار خرج می‌کند.
  const skillGate = {};
  try { for (const t of tlPredict.TO_NODES) skillGate[t] = tlPredict.targetSkill(t); } catch (e) {}

  const openRaw = tl(`SELECT * FROM predictions WHERE status='open' ORDER BY created_at DESC LIMIT 24`);
  const predictions = openRaw
    .filter(p => (skillGate[p.target] || {}).passes)
    .slice(0, 12)
    .map(p => {
      let attr = null;
      try { attr = p.attribution_json ? JSON.parse(p.attribution_json) : null; } catch (e) {}
      const g = skillGate[p.target] || {};
      return Object.assign({}, p, {
        symLabel: symLabel(p.target),
        regimeLabel: REGIME[p.regime] || p.regime,
        conf: p.calibrated_confidence != null ? p.calibrated_confidence : p.confidence,
        // کارنامه‌ی همین نماد، کنار خودِ پیش‌بینی (مورد ۲۴)
        trackAcc: g.acc != null ? Math.round(g.acc * 100) : null,
        trackN: g.n || 0,
        attr
      });
    });

  // نمادهایی که فعلاً در حالت مشاهده‌اند — شفاف اعلام می‌شوند، نه اینکه بی‌صدا غیب شوند
  const withheld = Object.entries(skillGate)
    .filter(([, g]) => !g.passes && g.n > 0)
    .map(([t, g]) => ({
      target: t, symLabel: symLabel(t), n: g.n,
      accPct: g.acc != null ? Math.round(g.acc * 100) : null, reason: g.reason,
    }))
    .sort((a, b) => b.n - a.n);

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

  // زیر این تعداد نمونه، هر درصدی نویز است و نباید به‌عنوان «دقت» نمایش داده شود
  const MIN_ACC_SAMPLES = tlPredict.SKILL_MIN_SAMPLES;
  const accuracy = tl(`SELECT * FROM accuracy_metrics WHERE scope='target' ORDER BY total DESC LIMIT 10`)
    .map(a => Object.assign({}, a, {
      symLabel: symLabel(a.scope_key),
      dirPct: a.total ? (a.correct_dir / a.total) * 100 : null,
      enough: (a.total || 0) >= MIN_ACC_SAMPLES,
    }));

  // شاخصی که همبستگی‌اش عملاً صفر است، «شاخص پیشرو» نیست. نمایش دادنش با
  // نوار اطمینان، به کاربر سیگنالی وعده می‌دهد که در داده وجود ندارد.
  const MIN_CORR = 0.10;
  const indicatorsAll = tl(`SELECT indicator, target, MAX(accuracy) accuracy, MAX(sample_count) sample_count,
                                MIN(lead_time_min) lead_time_min, MAX(ABS(correlation)) correlation
                         FROM leading_indicators WHERE sample_count >= 10
                         GROUP BY indicator, target ORDER BY correlation DESC LIMIT 40`)
    .map(i => Object.assign({}, i, { indLabel: NODE[i.indicator] || i.indicator, symLabel: symLabel(i.target) }));
  const indicators = indicatorsAll.filter(i => Math.abs(i.correlation || 0) >= MIN_CORR).slice(0, 12);
  const indicatorsDropped = indicatorsAll.length - indicators.length;

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

  // ── کارنامه‌ی واقعی موتور ──
  let skill = null;
  try {
    skill = tlSkill.compute();
    if (skill) {
      skill.verdictText = tlSkill.VERDICT_FA[skill.verdict] || '';
      (skill.byTarget || []).forEach(t => { t.label = symLabel(t.target); });
    }
  } catch (e) { console.warn('[future/skill]', e.message); }

  // ── روایت روزانه ──
  let brief = null, briefHistory = [];
  try {
    brief = insightsDB.latestBrief();
    if (brief && brief.facts_json) { try { brief.facts = JSON.parse(brief.facts_json); } catch (e) {} }
    briefHistory = insightsDB.briefHistory(6).slice(1);
  } catch (e) { console.warn('[future/brief]', e.message); }

  // ── رابطه‌های تأخیری ──
  let leadLag = [], leadLagMeta = { n: 0, sig: 0, at: null };
  try {
    leadLag = insightsDB.topLeadLag(14).map(r => Object.assign({}, r, {
      corrPct: Math.round(Math.abs(r.corr) * 100),
      hitPct: Math.round(r.hit_rate * 100),
      dir: r.corr >= 0 ? 'هم‌جهت' : 'وارونه',
    }));
    leadLagMeta = insightsDB.leadLagMeta();
  } catch (e) { console.warn('[future/leadlag]', e.message); }

  // ── اعتبار منابع ──
  // جدول برای هر بروزرسانی یک ردیف تازه درج می‌کند به‌جای آپدیت، پس ۲۶۹
  // ردیف در واقع چند منبع تکراری است. آخرین ردیف هر منبع را برمی‌داریم.
  let sources = [];
  try {
    sources = tl(`SELECT * FROM source_reliability r
                  WHERE r.id = (SELECT MAX(id) FROM source_reliability
                                WHERE source_type = r.source_type
                                  AND COALESCE(source_key, label) = COALESCE(r.source_key, r.label))
                  ORDER BY reliability DESC, sample_count DESC LIMIT 14`)
      .map(s => Object.assign({}, s, {
        relPct: s.reliability != null ? Math.round(s.reliability * 100) : null,
        accPct: s.historical_accuracy != null ? Math.round(s.historical_accuracy * 100) : null,
        typeLabel: ({ rss: 'خوراک خبری', telegram: 'کانال تلگرام', market: 'داده‌ی بازار',
                      trend: 'ترند جستجو', poly: 'بازار پیش‌بینی' })[s.source_type] || s.source_type,
        biasLabel: ({ neutral: 'خنثی', positive: 'خوش‌بین', negative: 'بدبین' })[s.bias] || s.bias,
        speedLabel: ({ real_time: 'لحظه‌ای', fast: 'سریع', medium: 'متوسط', slow: 'کند' })[s.update_speed] || s.update_speed,
      }));

    /* چند کانال جدا برچسب یکسان دارند (source_key عدد داخلی است و به درد
       کاربر نمی‌خورد). به‌جای ده ردیف تکراری، یک ردیف با میانگین وزنی. */
    const byLabel = new Map();
    for (const s of sources) {
      const k = (s.label || s.source_key || '?') + '|' + s.source_type;
      if (!byLabel.has(k)) byLabel.set(k, Object.assign({}, s, { members: 0, _rel: 0, _acc: 0, _n: 0 }));
      const g = byLabel.get(k);
      g.members++;
      g._rel += (s.reliability || 0);
      g._acc += (s.historical_accuracy || 0);
      g._n += (s.sample_count || 0);
    }
    sources = [...byLabel.values()].map(g => Object.assign(g, {
      relPct: g.members ? Math.round((g._rel / g.members) * 100) : null,
      accPct: g.members ? Math.round((g._acc / g.members) * 100) : null,
      sample_count: g._n,
    })).sort((a, b) => (b.relPct || 0) - (a.relPct || 0) || b.sample_count - a.sample_count);
  } catch (e) { console.warn('[future/sources]', e.message); }

  let regime = null;
  try { regime = timelineRO.prepare(`SELECT * FROM market_regimes ORDER BY rowid DESC LIMIT 1`).get(); } catch (e) {}

  // سیگنال‌های ساختاری: اندازه‌گیری‌اند نه پیش‌بینی، پس دروازه‌ی مهارت
  // شامل حالشان نمی‌شود — چیزی ادعا نمی‌کنند که ثابت نشده باشد.
  let sig = { bubble: null, stress: null, commodities: [] };
  try { sig = tlSignals.all(); } catch (e) { console.warn('[future/signals]', e.message); }

  page(res, 'future', '/future', {
    title: 'ترند آینده | زنجیره‌های علّی و پیش‌بینی بازار ایران — سیگنال هوش',
    desc: 'موتور کشف زنجیره‌های علّی: چه خبری چه بازاری را با چه تأخیری حرکت می‌دهد. پیش‌بینی دلار، سکه و طلا با سنجش شفاف دقت.',
    path: '/future'
  }, { predictions, chains, patterns, accuracy, indicators, archive, acc, confidence, regime, REGIME,
       brief, briefHistory, leadLag, leadLagMeta, sources, skill,
       withheld, indicatorsDropped, MIN_ACC_SAMPLES, sig });
});

// ── کارنامه و تشخیص کامل موتور ──
const MODEL_FA = {
  A: 'مدل الگوی تاریخی', B: 'مدل رویدادهای مشابه', C: 'مدل استدلال هوش مصنوعی',
  D: 'پیش‌فرض دامنه‌ای',
  'پایه:learned': 'پایه: یادگرفته', 'پایه:prior': 'پایه: پیش‌فرض',
  'پایه:edge': 'پایه: یال کشف‌شده', 'پایه:نامشخص': 'پایه: نامشخص',
};
app.get('/future/accuracy', (req, res) => {
  let bt = null;
  try {
    bt = tlBacktest.fullReport();
    (bt.inversion || []).forEach(i => { i.label = symLabel(i.target); });
    (bt.models || []).forEach(m => {
      m.faLabel = MODEL_FA[m.model] || m.model;
      // همان ضریبی که در ترکیب واقعاً اعمال می‌شود
      if (['A', 'B', 'C', 'D'].includes(m.model) && m.n >= 30) {
        m.weightFactor = +Math.max(0.1, Math.min(1.6, m.accPct / 50)).toFixed(2);
      }
    });
  } catch (e) { console.warn('[future/accuracy]', e.message); }

  page(res, 'future-accuracy', '/future', {
    title: 'کارنامه‌ی موتور پیش‌بینی — دقت واقعی و کالیبراسیون | سیگنال هوش',
    desc: 'دقت واقعی پیش‌بینی‌های بازار به تفکیک دارایی، افق زمانی و مدل — با مقایسه‌ی صریح در برابر پرتاب سکه و سنجش کالیبراسیون.',
    path: '/future/accuracy',
    crumb: 'کارنامه و تشخیص',
  }, { bt });
});

// ── چه چیزی پیشرو چیست ──
app.get('/future/leads', (req, res) => {
  let rows = [], meta = { n: 0, sig: 0, at: null };
  try {
    rows = (insightsDB.topLeadLag(40) || []).map(r => Object.assign({}, r, {
      fromLabel: symLabel(r.from_key) || NODE[r.from_key] || r.from_key,
      toLabel: symLabel(r.to_key) || NODE[r.to_key] || r.to_key,
    }));
    meta = insightsDB.leadLagMeta() || meta;
  } catch (e) { console.warn('[future/leads]', e.message); }

  page(res, 'future-leads', '/future', {
    title: 'چه چیزی پیشرو چیست — رابطه‌های تأخیری بازار ایران | سیگنال هوش',
    desc: 'کدام سیگنال با چه تأخیری کدام بازار را حرکت می‌دهد — سنجیده‌شده با آزمون همبستگی روی داده‌ی واقعی، با معناداری آماری.',
    path: '/future/leads',
    crumb: 'چه چیزی پیشرو چیست',
  }, { rows, meta });
});

// ── صفحه‌ی مستقل هر زنجیره ──
app.get('/future/chain/:id', (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return next();
  // از هندل فقط‌خواندنی استفاده می‌شود؛ لایه‌ی SSR نباید دیتابیس نوشتنی باز کند
  let chain = null;
  try { chain = timelineRO.prepare('SELECT * FROM signal_chains WHERE id=?').get(id); } catch (e) {}
  if (!chain) return next();

  // رویدادهای زنجیره از event_ids استخراج می‌شوند
  let evIds = [];
  try {
    const parsed = JSON.parse(chain.event_ids || '{}');
    evIds = [...new Set([].concat(parsed.roots || [], (parsed.edges || []).flat()))].filter(Number.isFinite);
  } catch (e) {}
  chain.events = [];
  if (evIds.length) {
    try {
      chain.events = timelineRO.prepare(
        `SELECT * FROM timeline_events WHERE id IN (${evIds.map(() => '?').join(',')})`
      ).all(...evIds);
    } catch (e) {}
  }

  chain.rootLabel = NODE[chain.root_node] || chain.root_node;
  chain.regimeLabel = REGIME[chain.regime] || chain.regime;
  chain.statusLabel = CHAIN_STATUS[chain.status] || chain.status;
  chain.topicLabel = topicLabel(chain.topic);

  const events = (chain.events || []).map(e => Object.assign({}, e, {
    nodeLabel: NODE[e.node_key] || e.node_key,
  })).sort((a, b) => new Date(a.detected_at) - new Date(b.detected_at));

  let preds = [];
  try {
    preds = timelineRO.prepare(`
      SELECT p.*, v.direction_correct FROM predictions p
      LEFT JOIN prediction_validations v ON v.prediction_id = p.id
      WHERE p.chain_id = ? ORDER BY p.created_at DESC`).all(id)
      .map(p => Object.assign({}, p, { symLabel: symLabel(p.target) }));
  } catch (e) {}

  let related = [];
  try {
    related = timelineRO.prepare(
      `SELECT id, title, started_at FROM signal_chains WHERE topic = ? AND id <> ? ORDER BY started_at DESC LIMIT 6`
    ).all(chain.topic, id);
  } catch (e) {}

  page(res, 'future-chain', '/future', {
    title: `${chain.title} — زنجیره‌ی رویداد | سیگنال هوش`,
    desc: (chain.ai_analysis || chain.title || '').slice(0, 180),
    path: '/future/chain/' + id,
    crumb: chain.topicLabel || 'زنجیره',
    // زنجیره‌ی ضعیف یا کم‌رویداد نباید وارد ایندکس شود — محتوای نازک
    noindex: !(chain.peak_severity >= 0.5 && events.length >= 3),
  }, { chain, events, preds, related });
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

// ════════════ وبلاگ ════════════
// عمداً در تب‌های بالای سایت نیست و فقط از فوتر لینک می‌گیرد؛ ولی برای
// گوگل کاملاً قابل خزش است (سایت‌مپ + فید + پیوند داخلی از هر نوشته).

const BLOG_PER_PAGE = 12;

function blogListPage(req, res, pageNum) {
  const total = blogDB.countPublished();
  const pages = Math.max(1, Math.ceil(total / BLOG_PER_PAGE));
  const p = Math.min(Math.max(1, pageNum || 1), pages);
  const posts = blogDB.listPublished(BLOG_PER_PAGE, (p - 1) * BLOG_PER_PAGE)
    .map(x => Object.assign({}, x, { excerptText: x.excerpt || mdown.plain(x.body, 180) }));

  page(res, 'blog', '', {
    title: p > 1
      ? `وبلاگ سیگنال هوش — صفحه ${p} | تحلیل روزانه داده‌های ایران`
      : 'وبلاگ سیگنال هوش | تحلیل روزانه ترند، بازار و اخبار ایران',
    desc: 'هر روز یک گزارش از مهم‌ترین اتفاق‌های ایران بر پایه‌ی داده: پرجستجوترین کلیدواژه‌های گوگل، خبرهای مهم، قیمت طلا و دلار، خودرو، ملک و بازار کار.',
    path: p > 1 ? '/blog/page/' + p : '/blog',
    // صفحه‌های ۲ به بعد محتوای تکراری‌اند؛ فقط صفحه‌ی اول ایندکس شود
    noindex: p > 1,
  }, { posts, pageNum: p, pages, total }, {
    '@context': 'https://schema.org', '@type': 'Blog',
    name: 'وبلاگ سیگنال هوش', url: SITE + '/blog', inLanguage: 'fa-IR',
    publisher: { '@type': 'Organization', name: 'سیگنال هوش', url: SITE },
  });
}

app.get('/blog', (req, res) => blogListPage(req, res, 1));
app.get('/blog/page/:n', (req, res) => blogListPage(req, res, parseInt(req.params.n, 10) || 1));

// فید — مسیرش باید پیش از /blog/:slug تعریف شود وگرنه slug آن را می‌بلعد
app.get('/blog/rss.xml', (req, res) => {
  const posts = blogDB.listPublished(30, 0);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const items = posts.map(p => `<item>` +
    `<title>${esc(p.title)}</title>` +
    `<link>${SITE}/blog/${encodeURIComponent(p.slug)}</link>` +
    `<guid isPermaLink="true">${SITE}/blog/${encodeURIComponent(p.slug)}</guid>` +
    `<pubDate>${new Date(p.published_at).toUTCString()}</pubDate>` +
    `<description>${esc(p.excerpt || mdown.plain(p.body, 300))}</description>` +
    `</item>`).join('');
  res.type('application/rss+xml').send(
    '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>' +
    '<title>وبلاگ سیگنال هوش</title>' +
    `<link>${SITE}/blog</link>` +
    '<description>تحلیل روزانه‌ی داده‌های ایران</description>' +
    '<language>fa-ir</language>' + items + '</channel></rss>'
  );
});

app.get('/blog/:slug', (req, res, next) => {
  const post = blogDB.publishedBySlug(req.params.slug);
  if (!post) return next();

  const bodyHtml = mdown.render(post.body);
  const words = mdown.plain(post.body).split(/\s+/).filter(Boolean).length;
  const readMin = Math.max(1, Math.round(words / 200));
  const related = blogDB.related(post.id, 3);
  const desc = post.meta_desc || post.excerpt || mdown.plain(post.body, 155);
  // layout خودش SITE را جلوی seo.image می‌گذارد، پس اینجا باید مسیر نسبی بماند؛
  // ولی JSON-LD نشانی مطلق می‌خواهد.
  const imgAbs = post.cover ? SITE + post.cover : null;

  page(res, 'blog-post', '', {
    title: (post.meta_title || post.title) + ' | سیگنال هوش',
    desc,
    path: '/blog/' + post.slug,
    image: post.cover || null,
    ogType: 'article',
  }, { post, bodyHtml, readMin, related }, [{
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: desc,
    datePublished: post.published_at,
    dateModified: post.updated_at || post.published_at,
    inLanguage: 'fa-IR',
    image: imgAbs ? [imgAbs] : undefined,
    keywords: post.keywords || undefined,
    mainEntityOfPage: { '@type': 'WebPage', '@id': SITE + '/blog/' + post.slug },
    author: { '@type': 'Organization', name: 'سیگنال هوش', url: SITE },
    publisher: { '@type': 'Organization', name: 'سیگنال هوش', url: SITE },
  }, {
    // وبلاگ تب نیست، پس breadcrumbFor چیزی نمی‌سازد و باید دستی بدهیم
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'خانه', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: 'وبلاگ', item: SITE + '/blog' },
      { '@type': 'ListItem', position: 3, name: post.title, item: SITE + '/blog/' + post.slug },
    ],
  }]);
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
  { key: 'ai_model_blog',       label: 'نویسنده‌ی وبلاگ روزانه',        file: 'blog-writer.js', tag: 'blog-writer' },
];

const DB_LABELS = {
  'news.db': 'اخبار', 'trends.db': 'ترند سرچ', 'trend.db': 'ترند سرچ',
  'finance.db': 'بازار مالی', 'cars.db': 'خودرو', 'car.db': 'خودرو',
  'market.db': 'کالا', 'jobs.db': 'بازار کار', 'job.db': 'بازار کار',
  'polymarket.db': 'پلی‌مارکت', 'timeline.db': 'ترند آینده',
  'messages.db': 'پیام‌های تماس', 'users.db': 'کاربران',
  'property.db': 'ملک تهران', 'gold.db': 'پلتفرم‌های طلا', 'commodity.db': 'کالای جهانی',
  'blog.db': 'وبلاگ',
};

// آستانه‌ی «قدیمی» برای بخش‌هایی که عمداً کم‌تکرار بروز می‌شوند
const DB_MAX_AGE_H = { 'property.db': 30, 'messages.db': 24 * 30 };
const DEFAULT_MAX_AGE_H = 6;

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

// در حالت WAL، نوشتن‌ها به فایل -wal می‌روند و mtime خودِ .db می‌تواند
// هفته‌ها عقب بماند. تازه‌ترین زمان بین سه فایل، زمان واقعی آخرین نوشتن است.
function dbTouchedAt(full) {
  let newest = 0, size = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const st = fs.statSync(full + suffix);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
      if (suffix === '') size = st.size;
    } catch (e) {}
  }
  return { mtimeMs: newest, size };
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
        const t = dbTouchedAt(path.join(dir, f));
        if (!t.mtimeMs) continue;
        out.push({
          file: f,
          label: DB_LABELS[f] || f.replace(/\.db$/, ''),
          sizeMB: Math.round(t.size / 1048576 * 10) / 10,
          mtime: new Date(t.mtimeMs).toISOString(),
          // بدون نوشتن در بازه‌ی مورد انتظار = احتمالاً جمع‌آورنده خوابیده
          stale: Date.now() - t.mtimeMs > (DB_MAX_AGE_H[f] || DEFAULT_MAX_AGE_H) * 3600 * 1000,
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

const ADMIN_SECS = ['overview', 'blog', 'users', 'channels', 'gold', 'commodity', 'ai', 'messages', 'spam', 'blocked', 'system'];

// آستانه‌ی حجم عکس شاخص وبلاگ. عکس به‌صورت base64 از فرم می‌آید (بدون
// وابستگی multipart)، و base64 حدود ۳۳٪ بزرگ‌تر از فایل خام است.
const BLOG_COVER_MAX_BYTES = 4 * 1024 * 1024;
const BLOG_MEDIA_DIR = path.join(__dirname, 'public', 'blog-media');

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

  let goldPlatforms = [];
  try { goldPlatforms = goldDB.getAllWithStatus() || []; } catch (e) {}

  let commodityAdminRows = [], commodityAdminStatus = null, commodityIntervalMin = commodityCrawler.getIntervalMin();
  try {
    commodityAdminStatus = commodityDB.getStatus();
    commodityAdminRows = (commodityDB.getLatestAll() || []).map(r => Object.assign({}, r, {
      nameFa: (commodityCrawler.CURATED[r.slug] || {}).fa || r.slug,
      catFa: commodityCrawler.CAT_FA[r.category] || r.category,
      priceText: finText(r.price),
    }));
  } catch (e) { console.warn('[admin/commodity]', e.message); }

  let blogPosts = [], blogStats = { total: 0, drafts: 0, published: 0 };
  try {
    blogPosts = (blogDB.listAll(60) || []).map(p => Object.assign({}, p, {
      excerptText: p.excerpt || mdown.plain(p.body, 140),
      words: mdown.plain(p.body).split(/\s+/).filter(Boolean).length,
    }));
    blogStats = blogDB.stats() || blogStats;
  } catch (e) { console.warn('[admin/blog]', e.message); }

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
    // فقط نسخه‌ی ماسک‌شده به قالب می‌رود — کلید کامل هرگز رندر نمی‌شود
    keyMask:   require('./lib/openrouter-key').mask(),
    keySource: require('./lib/openrouter-key').source(),
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
    rules, messages, blocked, users, chNews, chFin, ai, models, modelsMeta, freeModels, dbs, sec, goldPlatforms,
    blogPosts, blogStats,
    blogPrompt: blogWriter.getPrompt(),
    // سقف تقویمِ فرم «ساخت پیش‌نویس» — روز آینده انتخاب‌شدنی نباشد
    blogToday: blogWriter.tehranDay(),
    blogPromptIsDefault: !String(setAll.blog_prompt || '').trim(),
    blogHour: Number(setAll.blog_hour == null ? 23 : setAll.blog_hour),
    commodityAdminRows, commodityAdminStatus, commodityIntervalMin,
    COMMODITY_MIN: commodityCrawler.MIN_INTERVAL_MIN, COMMODITY_MAX: commodityCrawler.MAX_INTERVAL_MIN,
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
  else if (p.indexOf('/commodity') !== -1) sec = 'commodity';
  else if (p.indexOf('/blog') !== -1)     sec = 'blog';
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

// ══ پلتفرم‌های طلا ══
// غیرفعال‌سازی جمع‌آوری را متوقف می‌کند ولی تاریخچه می‌ماند؛ حذف کامل
// تاریخچه را هم می‌برد و نمودار گذشته سوراخ می‌شود.

app.post('/admin/commodity/save', adminGuard, (req, res) => {
  try {
    const raw = String(req.body.commodity_interval_min || '').replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
    const min = parseInt(raw, 10);
    if (isNaN(min)) return backFrom(req, res, null, 'عدد وارد نشد.');
    if (min < commodityCrawler.MIN_INTERVAL_MIN || min > commodityCrawler.MAX_INTERVAL_MIN) {
      return backFrom(req, res, null, 'بازه باید بین ' + commodityCrawler.MIN_INTERVAL_MIN + ' تا ' + commodityCrawler.MAX_INTERVAL_MIN + ' دقیقه باشد.');
    }
    settingsDB.set('commodity_interval_min', min);
    backFrom(req, res, 'بازه‌ی کرال روی ' + min + ' دقیقه تنظیم شد و از چرخه‌ی بعدی اعمال می‌شود.');
  } catch (e) { backFrom(req, res, null, 'خطا: ' + e.message); }
});

app.post('/admin/gold/:id/toggle', adminGuard, (req, res) => {
  try {
    const p = (goldDB.getPlatforms() || []).find(x => String(x.id) === String(req.params.id));
    if (!p) return backFrom(req, res, null, 'پلتفرم یافت نشد.');
    if (p.active) { goldDB.deactivate(p.id); backFrom(req, res, '«' + p.name_fa + '» غیرفعال شد — جمع‌آوری متوقف، تاریخچه محفوظ.'); }
    else { goldDB.activate(p.id); backFrom(req, res, '«' + p.name_fa + '» دوباره فعال شد.'); }
  } catch (e) { backFrom(req, res, null, 'خطا: ' + e.message); }
});

app.post('/admin/gold/:id/delete', adminGuard, (req, res) => {
  try {
    const p = (goldDB.getPlatforms() || []).find(x => String(x.id) === String(req.params.id));
    if (!p) return backFrom(req, res, null, 'پلتفرم یافت نشد.');
    goldDB.removePlatform(p.id);
    backFrom(req, res, '«' + p.name_fa + '» و همه‌ی تاریخچه‌اش حذف شد.');
  } catch (e) { backFrom(req, res, null, 'خطا: ' + e.message); }
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
    if (!isNaN(lim) && lim >= 0 && lim <= 1000000) settingsDB.set('ai_daily_limit', lim);

    // کلید فقط وقتی جایگزین می‌شود که واقعاً چیزی وارد شده باشد؛ ارسال خالی
    // یعنی «دست نزن»، چون فرم هیچ‌وقت کلید فعلی را داخل input نمی‌گذارد.
    // بعد از نوشتن، دسترسی فایل تنظیمات به ۶۰۰ محدود می‌شود — این فایل حالا
    // یک راز دارد و پیش‌فرضش برای همه خواندنی بود.
    const rawKey = String(b.openrouter_key || '').trim();
    if (rawKey) {
      settingsDB.set('openrouter_key', rawKey);
      try { fs.chmodSync(path.join(__dirname, 'data', 'settings.json'), 0o600); } catch (e) {}
    }

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

// ════════════ پنل مدیریت — وبلاگ ════════════

// صفحه‌ی ویرایش یک نوشته
app.get('/admin/blog/:id', adminGuard, (req, res) => {
  const post = blogDB.byId(parseInt(req.params.id, 10));
  if (!post) return backFrom(req, res, null, 'نوشته پیدا نشد');
  page(res, 'admin-blog-edit', '', {
    title: 'ویرایش نوشته | پنل مدیریت', desc: '', path: '/admin/blog', noindex: true
  }, {
    post,
    preview: mdown.render(post.body),
    words: mdown.plain(post.body).split(/\s+/).filter(Boolean).length,
    flash:    (req.query && req.query.ok)  ? String(req.query.ok).slice(0, 200)  : null,
    flashErr: (req.query && req.query.err) ? String(req.query.err).slice(0, 200) : null,
  });
});

function backToPost(res, id, ok, err) {
  const qs = [];
  if (ok)  qs.push('ok=' + encodeURIComponent(ok));
  if (err) qs.push('err=' + encodeURIComponent(err));
  res.redirect('/admin/blog/' + id + (qs.length ? '?' + qs.join('&') : ''));
}

// متن نوشته از سقف ۶۴ کیلوبایتی فرم‌های عادی رد می‌شود، پس این مسیر
// حد جداگانه‌ای دارد. عکس اصلاً از این مسیر نمی‌آید (مسیر cover جداست).
app.post('/admin/blog/:id/save', adminGuard, express.urlencoded({ extended: false, limit: '512kb' }), (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 200);
    const body  = String(b.body || '').trim();
    if (!title || body.length < 50) return backToPost(res, id, null, 'عنوان و متن نمی‌توانند خالی باشند');
    blogDB.update(id, {
      title,
      body,
      slug: String(b.slug || '').trim() || title,
      excerpt:    String(b.excerpt || '').trim().slice(0, 400),
      meta_title: String(b.meta_title || '').trim().slice(0, 120),
      meta_desc:  String(b.meta_desc || '').trim().slice(0, 300),
      keywords:   String(b.keywords || '').trim().slice(0, 400),
      cover_alt:  String(b.cover_alt || '').trim().slice(0, 200),
    });
    backToPost(res, id, 'ذخیره شد');
  } catch (e) { backToPost(res, id, null, 'خطا: ' + e.message); }
});

// عکس شاخص — مرورگر فایل را base64 می‌کند و اینجا فقط رمزگشایی و ذخیره
// می‌شود. این کار وابستگی multipart (multer) را حذف می‌کند و با قرارداد
// همیشگی سایت هم می‌خواند: عکس روی سرور خودمان ذخیره می‌شود، نه hotlink.
const COVER_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
app.post('/admin/blog/:id/cover', adminGuard, express.json({ limit: '6mb' }), (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const post = blogDB.byId(id);
    if (!post) return res.status(404).json({ error: 'نوشته پیدا نشد' });
    const data = String((req.body && req.body.data) || '');
    const m = data.match(/^data:([\w\/+.-]+);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'قالب عکس نامعتبر است' });
    const ext = COVER_TYPES[m[1].toLowerCase()];
    if (!ext) return res.status(400).json({ error: 'فقط JPG، PNG، WebP یا GIF' });
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) return res.status(400).json({ error: 'فایل خالی است' });
    if (buf.length > BLOG_COVER_MAX_BYTES) {
      return res.status(413).json({ error: 'حجم عکس بیش از ۴ مگابایت است' });
    }
    if (!fs.existsSync(BLOG_MEDIA_DIR)) fs.mkdirSync(BLOG_MEDIA_DIR, { recursive: true });
    const name = 'post-' + id + '-' + Date.now() + '.' + ext;
    fs.writeFileSync(path.join(BLOG_MEDIA_DIR, name), buf);

    // عکس قبلی همان نوشته دیگر به‌کار نمی‌آید
    if (post.cover && post.cover.indexOf('/blog-media/') === 0) {
      try { fs.unlinkSync(path.join(BLOG_MEDIA_DIR, path.basename(post.cover))); } catch (e) {}
    }
    blogDB.update(id, { cover: '/blog-media/' + name });
    res.json({ ok: true, cover: '/blog-media/' + name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/blog/:id/publish', adminGuard, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const p = blogDB.byId(id);
    if (!p) return backToPost(res, id, null, 'نوشته پیدا نشد');
    if (!p.cover) return backToPost(res, id, null, 'برای انتشار، اول عکس شاخص را اضافه کنید');
    blogDB.setStatus(id, 'published');
    backToPost(res, id, 'منتشر شد — /blog/' + blogDB.byId(id).slug);
  } catch (e) { backToPost(res, id, null, 'خطا: ' + e.message); }
});

app.post('/admin/blog/:id/unpublish', adminGuard, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try { blogDB.setStatus(id, 'draft'); backToPost(res, id, 'به پیش‌نویس برگشت'); }
  catch (e) { backToPost(res, id, null, 'خطا: ' + e.message); }
});

app.post('/admin/blog/:id/delete', adminGuard, (req, res) => {
  try {
    const p = blogDB.byId(parseInt(req.params.id, 10));
    if (p && p.cover && p.cover.indexOf('/blog-media/') === 0) {
      try { fs.unlinkSync(path.join(BLOG_MEDIA_DIR, path.basename(p.cover))); } catch (e) {}
    }
    blogDB.remove(parseInt(req.params.id, 10));
    backFrom(req, res, 'نوشته حذف شد');
  } catch (e) { backFrom(req, res, null, 'خطا: ' + e.message); }
});

// ساخت دستی — وقتی ادمین نخواهد تا شب صبر کند، یا زمان‌بند به خطا خورده باشد
app.post('/admin/blog/generate', adminGuard, async (req, res) => {
  try {
    const day = String((req.body && req.body.day) || '').trim() || blogWriter.tehranDay();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return backFrom(req, res, null, 'تاریخ نامعتبر است');
    const force = !!(req.body && req.body.force);
    const r = await blogWriter.generateFor(day, { force });
    if (r.ok) backFrom(req, res, (r.replaced ? 'پیش‌نویس بازنویسی شد' : 'پیش‌نویس ساخته شد') + ' — برای بررسی بازش کنید');
    else backFrom(req, res, null, r.reason || 'ساخته نشد');
  } catch (e) { backFrom(req, res, null, 'خطا: ' + e.message); }
});

app.post('/admin/blog/settings', adminGuard, express.urlencoded({ extended: false, limit: '256kb' }), (req, res) => {
  try {
    const b = req.body || {};
    const prompt = String(b.blog_prompt || '').trim();
    // خالی گذاشتن یعنی «برگرد به پرامپت پیش‌فرض»
    settingsDB.set('blog_prompt', prompt);
    const h = parseInt(String(b.blog_hour || '').replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)), 10);
    if (!isNaN(h) && h >= 0 && h <= 23) settingsDB.set('blog_hour', h);
    backFrom(req, res, prompt ? 'تنظیمات وبلاگ ذخیره شد' : 'پرامپت به حالت پیش‌فرض برگشت');
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

// ════════════ بایگانی اخبار ════════════

const ARCH_PAGE = 40;

// روزهای موجود، با تعداد خبر هر روز
function archiveDays(limit) {
  try {
    return newsRO.prepare(
      'SELECT substr(published_at,1,10) day, COUNT(*) c FROM news ' +
      'WHERE COALESCE(blocked,0)=0 GROUP BY day ORDER BY day DESC' +
      (limit ? ' LIMIT ' + Number(limit) : '')
    ).all().map(d => Object.assign(d, { faDay: faDay(d.day) }));
  } catch (e) { return []; }
}

function archiveSources(limit) {
  try {
    return newsRO.prepare(
      'SELECT c.username, c.title, c.category, c.photo_url, COUNT(n.id) c2 ' +
      'FROM channels c JOIN news n ON n.channel_id=c.id AND COALESCE(n.blocked,0)=0 ' +
      'WHERE c.active=1 AND c.username IS NOT NULL AND c.username <> \'\' ' +
      'GROUP BY c.id ORDER BY c2 DESC' + (limit ? ' LIMIT ' + Number(limit) : '')
    ).all().map(s => ({ username: s.username, title: s.title, category: s.category, photo_url: s.photo_url, c: s.c2 }));
  } catch (e) { return []; }
}

// شماره‌ی صفحات با «…» برای فهرست‌های طولانی
function pageList(pg, pages) {
  const out = [];
  const push = p => { if (out[out.length - 1] !== p) out.push(p); };
  push(1);
  if (pg - 2 > 2) push('…');
  for (let p = Math.max(2, pg - 1); p <= Math.min(pages - 1, pg + 1); p++) push(p);
  if (pg + 2 < pages - 1) push('…');
  if (pages > 1) push(pages);
  return out;
}

function archiveQuery(where, params, pg) {
  const offset = (pg - 1) * ARCH_PAGE;
  let total = 0, rows = [];
  try {
    total = newsRO.prepare(
      'SELECT COUNT(*) c FROM news n JOIN channels c ON c.id=n.channel_id WHERE ' + where
    ).get(...params).c;
    rows = newsRO.prepare(
      'SELECT n.*, c.title channel_title, c.username channel_username, c.photo_url channel_photo, ' +
      'c.category channel_category FROM news n JOIN channels c ON c.id=n.channel_id WHERE ' + where +
      ' ORDER BY n.published_at DESC LIMIT ? OFFSET ?'
    ).all(...params, ARCH_PAGE, offset);
  } catch (e) { console.warn('[archive]', e.message); }
  rows.forEach(r => { r.isNew = false; r.hot = false; });
  return { total, rows, pages: Math.max(1, Math.ceil(total / ARCH_PAGE)) };
}

// ── هاب بایگانی، و جستجو ──
app.get('/news/archive', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const source = String(req.query.source || '').trim().slice(0, 60);
  const pg = Math.max(1, Math.min(parseInt(req.query.page, 10) || 1, 500));

  // بدون عبارت جستجو: صفحه‌ی هاب که مسیر خزش به همه‌ی روزها و منابع می‌سازد
  if (q.length < 2) {
    const days = archiveDays(null);
    const sources = archiveSources(null);
    let cats = [];
    try {
      cats = newsRO.prepare(
        'SELECT c.category, COUNT(n.id) c2 FROM channels c JOIN news n ON n.channel_id=c.id ' +
        'AND COALESCE(n.blocked,0)=0 WHERE c.category IS NOT NULL AND c.category <> \'\' ' +
        'GROUP BY c.category ORDER BY c2 DESC'
      ).all().map(r => ({ category: r.category, c: r.c2 }));
    } catch (e) {}

    const total = days.reduce((s, d) => s + d.c, 0);
    return page(res, 'archive-hub', '/news', {
      title: 'بایگانی اخبار ایران | جستجو در ' + fa(num(total)) + ' خبر — سیگنال هوش',
      desc: 'بایگانی کامل اخبار جمع‌آوری‌شده از ' + fa(sources.length) + ' خبرگزاری و کانال تلگرام، به تفکیک روز و منبع، همراه با جستجو در متن اخبار.',
      path: '/news/archive'
    }, {
      q: '', days, sources, cats,
      stats: {
        total, sources: sources.length,
        firstDay: days.length ? days[days.length - 1].day : null,
        lastDay: days.length ? days[0].day : null,
      }
    });
  }

  // با عبارت جستجو: نتایج noindex می‌شوند — صفحه‌ی نتایج جستجو محتوای
  // یکتا تولید نمی‌کند و ایندکس شدنشان فقط بودجه‌ی خزش را هدر می‌دهد.
  const where = ['COALESCE(n.blocked,0)=0', '(n.text_fa LIKE ? OR n.text LIKE ?)'];
  const like = '%' + q + '%';
  const params = [like, like];
  if (source) { where.push('c.username = ?'); params.push(source); }

  const r = archiveQuery(where.join(' AND '), params, pg);
  const qs = u => '/news/archive?q=' + encodeURIComponent(q) + (source ? '&source=' + encodeURIComponent(source) : '') + (u > 1 ? '&page=' + u : '');

  page(res, 'archive-list', '/news', {
    title: 'جستجوی «' + q + '» در بایگانی اخبار | سیگنال هوش',
    desc: 'نتایج جستجوی «' + q + '» در بایگانی اخبار سیگنال هوش.',
    path: '/news/archive', noindex: true
  }, {
    news: r.rows, total: r.total, page: pg, pages: r.pages, pageList: pageList(pg, r.pages),
    pageUrl: qs, q, crumb: 'جستجو',
    heading: 'نتایج جستجوی «' + q + '»',
    subtitle: fa(num(r.total)) + ' خبر پیدا شد' + (source ? ' در منبع ' + source : ''),
    intro: null, prevDay: null, nextDay: null, sourceInfo: null,
    alsoDays: archiveDays(14), alsoSources: archiveSources(12),
  });
});

// ── یک روز مشخص ──
app.get('/news/archive/:date', (req, res, next) => {
  const date = String(req.params.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return next();
  const pg = Math.max(1, Math.min(parseInt(req.query.page, 10) || 1, 500));

  const r = archiveQuery("COALESCE(n.blocked,0)=0 AND substr(n.published_at,1,10)=?", [date], pg);
  if (!r.total) return next();

  const days = archiveDays(null);
  const idx = days.findIndex(d => d.day === date);
  const nextDay = idx > 0 ? days[idx - 1] : null;        // روز جدیدتر
  const prevDay = idx >= 0 && idx < days.length - 1 ? days[idx + 1] : null;

  const fd = faDay(date);
  page(res, 'archive-list', '/news', {
    title: 'اخبار ' + fd + ' | بایگانی ' + fa(num(r.total)) + ' خبر — سیگنال هوش',
    desc: 'همه‌ی ' + fa(num(r.total)) + ' خبر منتشرشده در ' + fd + ' از خبرگزاری‌ها و کانال‌های خبری، در بایگانی سیگنال هوش.',
    path: '/news/archive/' + date + (pg > 1 ? '?page=' + pg : '')
  }, {
    news: r.rows, total: r.total, page: pg, pages: r.pages, pageList: pageList(pg, r.pages),
    pageUrl: p => '/news/archive/' + date + (p > 1 ? '?page=' + p : ''),
    q: '', crumb: fd,
    heading: 'اخبار ' + fd,
    subtitle: fa(num(r.total)) + ' خبر از ' + '\u200f' + 'خبرگزاری‌ها و کانال‌های رصد‌شده',
    intro: 'همه‌ی اخبار این روز به ترتیب زمان انتشار، از تازه به قدیم. اخبار غیرفارسی هنگام جمع‌آوری خودکار ترجمه شده‌اند.',
    prevDay, nextDay, sourceInfo: null,
    alsoDays: null, alsoSources: archiveSources(12),
  });
});

// ── یک منبع مشخص ──
app.get('/news/source/:username', (req, res, next) => {
  const u = String(req.params.username || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 60);
  if (!u) return next();
  const pg = Math.max(1, Math.min(parseInt(req.query.page, 10) || 1, 500));

  let ch = null;
  try { ch = newsRO.prepare('SELECT * FROM channels WHERE username=? COLLATE NOCASE').get(u); } catch (e) {}
  if (!ch) return next();

  const r = archiveQuery('COALESCE(n.blocked,0)=0 AND n.channel_id=?', [ch.id], pg);
  if (!r.total) return next();

  const name = ch.title || ch.username;
  page(res, 'archive-list', '/news', {
    title: 'اخبار ' + name + ' | بایگانی ' + fa(num(r.total)) + ' خبر — سیگنال هوش',
    desc: 'بایگانی ' + fa(num(r.total)) + ' خبر منتشرشده از ' + name + '، به ترتیب زمان انتشار، در سیگنال هوش.',
    path: '/news/source/' + ch.username + (pg > 1 ? '?page=' + pg : '')
  }, {
    news: r.rows, total: r.total, page: pg, pages: r.pages, pageList: pageList(pg, r.pages),
    pageUrl: p => '/news/source/' + ch.username + (p > 1 ? '?page=' + p : ''),
    q: '', crumb: name,
    heading: 'اخبار ' + name,
    subtitle: fa(num(r.total)) + ' خبر' + (ch.category ? ' · ' + ch.category : ''),
    intro: 'همه‌ی اخبار جمع‌آوری‌شده از این منبع. سیگنال هوش ناشر این محتوا نیست و آن را از کانال عمومی این خبرگزاری جمع‌آوری می‌کند.',
    prevDay: null, nextDay: null, sourceInfo: ch,
    alsoDays: archiveDays(14), alsoSources: archiveSources(12),
  });
});

// ════════════ ترند ملک ════════════

/* رنگ‌بندی نقشه: طیف تک‌رنگ از روشن به تیره. طیف سبز-قرمز اینجا اشتباه
   بود چون در همین سایت معنی «رشد و افت» می‌دهد، نه «کم و زیاد». */
/** نقاط polyline با محور افقی متناسب با تاریخ واقعی هر نقطه */
function datePoly(points, wd, ht) {
  const p = (points || []).filter(x => x && x.date && x.value > 0);
  if (p.length < 2) return '';
  const ts = p.map(x => new Date(x.date).getTime());
  const t0 = ts[0], tSpan = (ts[ts.length - 1] - t0) || 1;
  const vals = p.map(x => x.value);
  const min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  const vSpan = (max - min) || 1;
  return p.map((x, i) => {
    const px = ((ts[i] - t0) / tSpan) * wd;
    const py = ht - ((x.value - min) / vSpan) * ht;
    return px.toFixed(1) + ',' + py.toFixed(1);
  }).join(' ');
}

const PROP_BANDS = ['#e0ecfb', '#a7c8f0', '#6ba3e3', '#3d7fd1', '#1f5aa8'];
const PROP_TTL = 5 * 60 * 1000;
let _propCache = { at: 0, data: null };

function monthsBetween(a, b) {
  const d1 = new Date(a), d2 = new Date(b);
  if (isNaN(d1) || isNaN(d2)) return 0;
  return Math.max(0, Math.round((d2 - d1) / (30.44 * 86400000)));
}

/**
 * همه‌ی محاسبات تب ملک در یک جا.
 *
 * چرا کش پنج‌دقیقه‌ای: داده روزی یک‌بار عوض می‌شود ولی ساختن این مدل
 * ۲۲ پرس‌وجوی سری زمانی دارد. بدون کش، هر بازدید همه را دوباره می‌زند.
 */
function propertyModel() {
  if (_propCache.data && Date.now() - _propCache.at < PROP_TTL) return _propCache.data;

  const all = propDB.latest();
  const rows = all.filter(r => r.meter > 0).map(r => {
    const t = propDB.trendsOf(r.region_no);
    let growthYr = null, growthTotal = null, growthNote = 'سری زمانی کافی نیست', gap = false;

    if (t.length >= 2) {
      const a = t[0], b = t[t.length - 1];
      const m = monthsBetween(a.date, b.date);
      growthTotal = (b.value / a.value - 1) * 100;
      if (m >= 6 && a.value > 0) {
        growthYr = (Math.pow(b.value / a.value, 12 / m) - 1) * 100;
        growthNote = 'از ' + (a.period || '') + ' تا ' + (b.period || '') + '، سالانه‌شده';
      }
      // فاصله‌ی بیش از دو ماه بین دو نقطه یعنی سری پیوسته نیست
      for (let i = 1; i < t.length; i++) if (monthsBetween(t[i - 1].date, t[i].date) > 2) { gap = true; break; }
    }

    return {
      region_no: r.region_no, name_fa: r.name_fa, slug: r.slug,
      meter: r.meter, unit: r.unit, est: !!r.est,
      d: r.svg_path, cx: r.svg_cx, cy: r.svg_cy,
      areas: (() => { try { return JSON.parse(r.areas || '[]'); } catch (e) { return []; } })(),
      day: r.day, captured_at: r.captured_at,
      area: (r.unit && r.meter) ? Math.round(r.unit / r.meter) : null,
      trends: t, growthYr, growthTotal, growthNote, gap,
    };
  });

  if (!rows.length) {
    const empty = { rows: [], city: null, map: { viewBox: null, shapes: [], legend: [] }, cityTrend: { points: [] } };
    _propCache = { at: Date.now(), data: empty };
    return empty;
  }

  rows.sort((a, b) => b.meter - a.meter);

  const metersAll = rows.map(r => r.meter);
  const avg = metersAll.reduce((s, v) => s + v, 0) / metersAll.length;
  const maxM = Math.max.apply(null, metersAll), minM = Math.min.apply(null, metersAll);
  const city = {
    avg, max: rows[0], min: rows[rows.length - 1],
    gap: minM > 0 ? maxM / minM : 0,
  };

  rows.forEach((r, i) => {
    r.rank = i + 1;
    r.vsCity = (r.meter / avg - 1) * 100;
    r.barPct = Math.round((r.meter / maxM) * 100);
  });

  /* شاخص فرصت — دو نمره‌ی نرمال‌شده‌ی صفر تا صد، میانگین ساده.
     عمداً ساده نگه داشته شده تا بشود در یک جمله توضیحش داد. */
  const gs = rows.map(r => r.growthYr).filter(v => v != null);
  const gMin = gs.length ? Math.min.apply(null, gs) : 0;
  const gMax = gs.length ? Math.max.apply(null, gs) : 1;
  const gSpan = (gMax - gMin) || 1;
  const mSpan = (maxM - minM) || 1;
  const gMed = gs.length ? gs.slice().sort((a, b) => a - b)[Math.floor(gs.length / 2)] : 0;

  rows.forEach(r => {
    const cheap = (1 - (r.meter - minM) / mSpan) * 100;
    if (r.growthYr == null) { r.opp = null; r.quadrant = 'داده‌ی رشد ندارد'; return; }
    const grow = ((r.growthYr - gMin) / gSpan) * 100;
    r.opp = Math.round((cheap + grow) / 2);
    const isCheap = r.meter < avg, isFast = r.growthYr > gMed;
    r.quadrant = isCheap && isFast ? 'ارزان و پررشد'
      : isCheap ? 'ارزان و کم‌رشد'
      : isFast ? 'گران و پررشد' : 'گران و کم‌رشد';
  });

  /* نقشه — پنج دسته‌ی هم‌جمعیت (چندک) تا رنگ‌ها یکنواخت پخش شوند */
  const sortedM = metersAll.slice().sort((a, b) => a - b);
  const cuts = [];
  for (let i = 1; i < PROP_BANDS.length; i++) cuts.push(sortedM[Math.floor(sortedM.length * i / PROP_BANDS.length)]);
  const bandOf = v => { let i = 0; while (i < cuts.length && v >= cuts[i]) i++; return i; };

  const map = {
    viewBox: propDB.getMeta('map_viewbox'),
    shapes: rows.filter(r => r.d).map(r => ({
      region_no: r.region_no, slug: r.slug, name_fa: r.name_fa, meter: r.meter,
      d: r.d, cx: r.cx, cy: r.cy, fill: PROP_BANDS[bandOf(r.meter)],
    })),
    legend: PROP_BANDS.map((fill, i) => ({ fill, from: i === 0 ? sortedM[0] : cuts[i - 1] })),
  };

  /* پراکندگی: محور افقی ارزانی (راست = ارزان‌تر، چون صفحه راست‌چین است)،
     محور عمودی رشد (بالا = بیشتر) */
  const scatter = rows.filter(r => r.growthYr != null).map(r => ({
    region_no: r.region_no, slug: r.slug, name_fa: r.name_fa, meter: r.meter, growthYr: r.growthYr,
    x: (8 + (1 - (r.meter - minM) / mSpan) * 84).toFixed(1),
    y: (92 - ((r.growthYr - gMin) / gSpan) * 84).toFixed(1),
  }));

  /* روند میانگین شهر: میانگین ماه‌به‌ماه، فقط ماه‌هایی که حداقل نیمی از
     مناطق داده دارند — وگرنه یک منطقه‌ی پرت کل خط را جابه‌جا می‌کند */
  const byDate = new Map();
  for (const r of rows) for (const p of r.trends) {
    if (!byDate.has(p.date)) byDate.set(p.date, { period: p.period, vals: [] });
    byDate.get(p.date).vals.push(p.value);
  }
  const need = Math.max(3, Math.floor(rows.length / 2));
  const ct = [...byDate.entries()].filter(([, v]) => v.vals.length >= need)
    .sort((a, b) => a[0] < b[0] ? -1 : 1)
    .map(([date, v]) => ({ date, label: v.period, value: v.vals.reduce((s, x) => s + x, 0) / v.vals.length }));

  const cityTrend = { points: ct, poly: '', first: null, last: null, growth: null };
  if (ct.length > 1) {
    cityTrend.poly = datePoly(ct, 100, 40);
    cityTrend.first = ct[0];
    cityTrend.last = ct[ct.length - 1];
    cityTrend.growth = (ct[ct.length - 1].value / ct[0].value - 1) * 100;
  }

  const areaRows = rows.filter(r => r.area).sort((a, b) => b.area - a.area);
  const maxArea = areaRows.length ? areaRows[0].area : 1;
  areaRows.forEach(r => { r.areaPct = Math.round((r.area / maxArea) * 100); });

  const oppRows = rows.filter(r => r.opp != null).slice().sort((a, b) => b.opp - a.opp);

  const newest = rows.map(r => r.captured_at).filter(Boolean).sort().pop();

  const data = {
    rows, city, map, scatter, cityTrend, areaRows, oppRows,
    coverage: propDB.coverage(),
    updatedAt: newest ? timeAgo(newest) : '—',
    budgetData: JSON.stringify(rows.map(r => ({ n: r.name_fa, s: r.slug, m: Math.round(r.meter) }))),
  };
  _propCache = { at: Date.now(), data };
  return data;
}

app.get('/property', (req, res) => {
  const m = propertyModel();
  if (!m.rows.length) return res.status(503).send('داده‌ی ملک هنوز جمع‌آوری نشده است');

  page(res, 'property', '/property', {
    title: 'ترند ملک تهران | قیمت مسکن ۲۲ منطقه و روند بازار — سیگنال هوش',
    desc: 'قیمت تخمینی هر متر مربع مسکن در ۲۲ منطقه‌ی تهران، متراژ واحد متوسط هر منطقه، ' +
          'رشد سالانه‌ی قیمت، نقشه‌ی رنگی قیمت و شاخص فرصت — با بروزرسانی روزانه.',
    path: '/property',
  }, m, {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: 'قیمت مسکن مناطق تهران',
    description: 'قیمت تخمینی هر متر مربع و قیمت واحد مسکونی متوسط در ۲۲ منطقه‌ی شهرداری تهران، با رصد روزانه.',
    url: SITE + '/property',
    inLanguage: 'fa-IR',
    isAccessibleForFree: true,
    spatialCoverage: { '@type': 'Place', name: 'تهران، ایران' },
    variableMeasured: ['قیمت هر متر مربع', 'قیمت واحد مسکونی متوسط', 'متراژ واحد متوسط', 'رشد سالانه‌ی قیمت'],
    creator: { '@type': 'Organization', name: 'سیگنال هوش', url: SITE },
  });
});

app.get('/property/:slug', (req, res, next) => {
  const slug = String(req.params.slug || '');
  const mt = slug.match(/^region([1-9]|1[0-9]|2[0-2])$/);
  if (!mt) return next();
  const no = parseInt(mt[1], 10);

  const m = propertyModel();
  const r = m.rows.find(x => x.region_no === no);
  if (!r) return next();

  const idx = m.rows.indexOf(r);
  const prev = idx > 0 ? m.rows[idx - 1] : null;          // گران‌تر
  const next2 = idx < m.rows.length - 1 ? m.rows[idx + 1] : null;

  // نمودار سری ماهانه‌ی همین منطقه
  const pts = r.trends;
  const chart = { points: pts, poly: '', grid: [10, 20, 30], min: null, max: null, growth: null, gap: r.gap };
  if (pts.length > 1) {
    const vals = pts.map(p => p.value);
    chart.poly = datePoly(pts, 100, 40);
    chart.min = Math.min.apply(null, vals);
    chart.max = Math.max.apply(null, vals);
    chart.growth = (vals[vals.length - 1] / vals[0] - 1) * 100;
    chart.first = pts[0];
    chart.last = pts[pts.length - 1];
  }

  // نزدیک‌ترین مناطق از نظر قیمت — پیوند داخلی مفید و مسیر خزش
  const similar = m.rows.filter(x => x.region_no !== no)
    .map(x => Object.assign({}, x, { diff: (x.meter / r.meter - 1) * 100 }))
    .sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff)).slice(0, 5);

  const intro =
    r.name_fa + ' تهران با قیمت تخمینی ' + fa(toman(r.meter)) + ' تومان برای هر متر مربع، ' +
    'رتبه‌ی ' + fa(r.rank) + ' از ' + fa(m.rows.length) + ' منطقه‌ی شهر را دارد و ' +
    (r.vsCity >= 0 ? fa(Math.abs(r.vsCity).toFixed(0)) + ' درصد گران‌تر' : fa(Math.abs(r.vsCity).toFixed(0)) + ' درصد ارزان‌تر') +
    ' از میانگین تهران است' +
    (r.area ? '. آپارتمان معمول این منطقه حدود ' + fa(r.area) + ' متر مربع است' : '') + '.';

  page(res, 'property-region', '/property', {
    title: 'قیمت مسکن ' + r.name_fa + ' تهران | هر متر ' + fa(toman(r.meter)) + ' تومان — سیگنال هوش',
    desc: 'قیمت تخمینی هر متر مربع و قیمت واحد مسکونی متوسط در ' + r.name_fa + ' تهران، ' +
          'روند ماهانه‌ی قیمت، متراژ واحد متوسط و مقایسه با میانگین شهر.',
    path: '/property/' + r.slug,
    crumb: { name: r.name_fa, item: '/property/' + r.slug },
  }, {
    r, city: m.city, map: m.map, chart, similar, areas: r.areas,
    total: m.rows.length, prev, next: next2,
    coverage: m.coverage, updatedAt: m.updatedAt,
    intro,
  }, {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: 'قیمت مسکن ' + r.name_fa + ' تهران',
    description: intro,
    url: SITE + '/property/' + r.slug,
    inLanguage: 'fa-IR',
    isAccessibleForFree: true,
    spatialCoverage: { '@type': 'Place', name: r.name_fa + '، تهران، ایران' },
    creator: { '@type': 'Organization', name: 'سیگنال هوش', url: SITE },
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
    'Disallow: /news/page/\n' +
    'Disallow: /blog/page/\n\n' +
    'Sitemap: ' + SITE + '/sitemap.xml\n'
  );
});

app.get('/sitemap.xml', (req, res) => {
  const urls = [
    { loc: '/', pri: '1.0', freq: 'hourly' },
    { loc: '/trends', pri: '0.9', freq: 'hourly' },
    { loc: '/news', pri: '0.9', freq: 'hourly' },
    { loc: '/news/archive', pri: '0.8', freq: 'daily' },
    { loc: '/finance', pri: '0.9', freq: 'hourly' },
    { loc: '/property', pri: '0.9', freq: 'daily' },
    { loc: '/cars', pri: '0.8', freq: 'daily' },
    { loc: '/market', pri: '0.8', freq: 'daily' },
    { loc: '/jobs', pri: '0.7', freq: 'daily' },
    { loc: '/polymarket', pri: '0.7', freq: 'daily' },
    { loc: '/future', pri: '0.6', freq: 'daily' },
    { loc: '/future/accuracy', pri: '0.6', freq: 'daily' },
    { loc: '/future/leads', pri: '0.6', freq: 'daily' },
    { loc: '/blog', pri: '0.8', freq: 'daily' },
    { loc: '/contact', pri: '0.4', freq: 'monthly' },
    { loc: '/disclaimer', pri: '0.4', freq: 'monthly' }
  ];
  let items = '';

  // نوشته‌های وبلاگ — فقط منتشرشده‌ها؛ پیش‌نویس هرگز نباید به گوگل معرفی شود
  try {
    for (const p of blogDB.listPublished(1000, 0)) {
      items += `<url><loc>${SITE}/blog/${encodeURIComponent(p.slug)}</loc>` +
        `<lastmod>${new Date(p.updated_at || p.published_at).toISOString()}</lastmod>` +
        `<changefreq>monthly</changefreq><priority>0.7</priority></url>`;
    }
  } catch (e) {}

  // صفحه‌ی هر منطقه‌ی تهران — ۲۲ صفحه‌ی مستقل و قابل ایندکس
  try {
    for (const r of propDB.getRegions()) {
      items += `<url><loc>${SITE}/property/${r.slug}</loc><changefreq>daily</changefreq><priority>0.7</priority></url>`;
    }
  } catch (e) {}

  // صفحه‌ی هر کلیدواژه‌ی ترند. کلیدواژه‌ای که فقط یک‌بار دیده شده تقریباً
  // هیچ داده‌ای برای نشان دادن ندارد و «محتوای نازک» می‌شود؛ همان اشتباهی
  // که برای خبرهای کوتاه هم از آن پرهیز شده. پس آستانه می‌گذاریم.
  try {
    items += `<url><loc>${SITE}/trends/keywords</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`;
    for (const k of keywordIndex()) {
      if (k.snaps < 2) continue;
      items += `<url><loc>${SITE}/trends/${encodeURIComponent(k.slug)}</loc>` +
        `<lastmod>${new Date(k.last_seen).toISOString()}</lastmod>` +
        `<changefreq>${k.last_day === new Date().toISOString().slice(0, 10) ? 'hourly' : 'weekly'}</changefreq>` +
        `<priority>${k.days > 2 ? '0.7' : '0.5'}</priority></url>`;
    }
  } catch (e) {}

  // صفحات روز و منبع — این‌ها مسیر خزش به تک‌تک اخبار می‌سازند
  try {
    for (const d of archiveDays(null)) {
      items += `<url><loc>${SITE}/news/archive/${d.day}</loc><changefreq>daily</changefreq><priority>0.7</priority></url>`;
    }
    for (const s of archiveSources(null)) {
      items += `<url><loc>${SITE}/news/source/${s.username}</loc><changefreq>daily</changefreq><priority>0.7</priority></url>`;
    }
  } catch (e) {}

  try {
    // خبرِ کوتاه برای گوگل «محتوای نازک» است. از ۷۹ هزار خبر، حدود
    // ۲۵ هزارتا زیر ۱۲۰ نویسه‌اند؛ ایندکس شدن انبوهشان اعتبار کل دامنه
    // را پایین می‌آورد. فقط خبرهایی با متن کافی وارد سایت‌مپ می‌شوند.
    for (const r of newsRO.prepare('SELECT id, published_at FROM news WHERE COALESCE(blocked,0)=0 AND LENGTH(COALESCE(text_fa, text)) >= 300 ORDER BY published_at DESC LIMIT 5000').all()) {
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

// فقط لوکال‌هاست — دسترسی عمومی باید از nginx بگذرد
const HOST = process.env.BIND_HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`[web-test] رندر سمت سرور روی پورت ${PORT} — سایت اصلی (۳۰۰۱) دست‌نخورده است`);
});
