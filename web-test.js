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

const app  = express();
const PORT = process.env.WEB_PORT || 3002;
const SITE = 'https://signalhoosh.site';

// ── دسترسی مستقیم فقط-خواندنی برای پرس‌وجوهایی که در ماژول‌ها نیست ──
const newsRO = new Database(path.join(__dirname, 'data', 'news.db'), { readonly: true });

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

// رندر صفحه داخل layout
function page(res, tpl, active, seo, data, jsonld) {
  const locals = Object.assign({
    fa, num, toman, pct, excerpt, timeAgo, faDate, mediaOf, SITE, TABS, active
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
      FROM news n LEFT JOIN channels c ON c.id=n.channel_id WHERE n.id=? AND COALESCE(n.blocked,0)=0`).get(id);
  } catch (e) { return null; }
}

// خبرهایی که در بازه‌ی کوتاه تکرار زیادی داشته‌اند = داغ
function markHot(rows) {
  const cutoff = Date.now() - 90 * 60 * 1000;
  return rows.map(n => {
    const t = new Date(n.published_at).getTime();
    n.hot = !isNaN(t) && t > cutoff && !!n.media_url;
    return n;
  });
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
function rialToToman(p) { return p == null ? null : Number(p) / 10; }

const JOB_LABELS = {
  jobinja: 'جابینجا', jobvision: 'جاب‌ویژن',
  'human-resources': 'منابع انسانی', accounting: 'مالی و حسابداری',
  'software-web-development': 'برنامه‌نویسی و IT', 'sales-marketing': 'فروش و بازاریابی',
  'civil-engineering': 'مهندسی عمران', 'graphic-design': 'گرافیک و طراحی',
  'customer-support': 'پشتیبانی مشتری'
};

app.get('/', (req, res) => {
  let ticker = [], finance = [], cars = [], market = [], poly = [], jobs = null, carCount = 0;

  try {
    const raw = (financeDB.getLatest() || []).map(f => Object.assign({}, f, { price: rialToToman(f.price) }));
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

  const news = markHot(newsDB.getLatestNews(6, null, 0, 0) || []);

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
  const news = markHot(newsDB.getLatestNews(20, channel, 0, 0) || []);
  let digest = null;
  try { digest = newsDB.getLatestDigest(); } catch (e) {}
  let channels = [];
  try { channels = newsDB.getChannels() || []; } catch (e) {}

  page(res, 'news', '/news', {
    title: 'ترند اخبار ایران | اخبار لحظه‌ای کانال‌های تلگرام — سیگنال هوش',
    desc: 'تحلیل هوشمند جریان خبری ایران: اخبار لحظه‌ای از کانال‌های عمومی تلگرام با ترجمه‌ی خودکار منابع غیرفارسی و گزارش هوش مصنوعی.',
    path: '/news'
  }, { news, digest, channels, current: channel, stats: newsStats(), topChannels: topChannels() });
});

// صفحه‌بندی برای لیزی‌لود (قطعه‌ی HTML برمی‌گرداند)
app.get('/news/page/:n', (req, res) => {
  const n = Math.max(1, Math.min(50, parseInt(req.params.n, 10) || 1));
  const channel = req.query.channel ? parseInt(req.query.channel, 10) : null;
  const rows = markHot(newsDB.getLatestNews(20, channel, (n - 1) * 20, 0) || []);
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
  const paras = text.split(/\n{2,}|\n/).map(s => s.trim()).filter(Boolean);
  const headline = excerpt(paras[0] || 'خبر', 120);
  const media = mediaOf(n.media_url);

  let related = [];
  try {
    related = newsRO.prepare(`
      SELECT n.id, n.text, n.text_fa, n.published_at, c.title channel_title, c.username channel_username
      FROM news n LEFT JOIN channels c ON c.id=n.channel_id
      WHERE n.id != ? AND COALESCE(n.blocked,0)=0 ORDER BY n.published_at DESC LIMIT 4`).all(id);
  } catch (e) {}
  let fin = [];
  try { fin = (financeDB.getLatest() || []).slice(0, 4); } catch (e) {}

  page(res, 'news-detail', '/news', {
    title: headline + ' | سیگنال هوش',
    desc: excerpt(text, 155),
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

// ── robots و sitemap ──
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    'User-agent: *\n' +
    'Allow: /\n' +
    'Disallow: /api/\n' +
    'Disallow: /internal/\n' +
    'Disallow: /admin\n' +
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
    for (const r of newsRO.prepare('SELECT id, published_at FROM news WHERE COALESCE(blocked,0)=0 ORDER BY published_at DESC LIMIT 2000').all()) {
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
