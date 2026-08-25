/**
 * stats-db.js — آمار کل سامانه برای صفحه‌ی data.signalhoosh.site
 *
 * محاسبه سنگین است (COUNT روی چند دیتابیس چندصدهزارردیفی)، پس روزی یک بار
 * حساب و روی دیسک ذخیره می‌شود. اگر فایل کش نبود یا مال امروز نبود، همان
 * درخواست اول دوباره می‌سازدش — یعنی صفحه هیچ‌وقت خالی نمی‌ماند حتی اگر
 * زمان‌بند اجرا نشده باشد.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA = path.join(__dirname, 'data');
const CACHE = path.join(DATA, 'site-stats.json');

function open(file) {
  try { return new Database(path.join(DATA, file), { readonly: true, fileMustExist: true }); }
  catch (e) { return null; }
}

/** یک عدد از یک دیتابیس، با بی‌خطر‌شدن در برابر جدولِ نبود */
function one(file, sql, fallback) {
  const db = open(file);
  if (!db) return fallback;
  try { const r = db.prepare(sql).get(); return r ? Object.values(r)[0] : fallback; }
  catch (e) { return fallback; }
  finally { db.close(); }
}

function rows(file, sql) {
  const db = open(file);
  if (!db) return [];
  try { return db.prepare(sql).all(); }
  catch (e) { return []; }
  finally { db.close(); }
}

function dbSizeMB(file) {
  let total = 0;
  for (const suffix of ['', '-wal']) {
    try { total += fs.statSync(path.join(DATA, file + suffix)).size; } catch (e) {}
  }
  return Math.round(total / 1048576 * 10) / 10;
}

/* ── جمع‌آورنده‌ها؛ دوره‌ها با آنچه در server.js ثبت شده می‌خواند ── */
const CRAWLERS = [
  { key: 'trends',     label: 'ترند سرچ گوگل',   every: 'هر ۴ ساعت',  db: 'trends.db' },
  { key: 'finance',    label: 'بازارهای مالی',   every: 'هر ۳ دقیقه', db: 'finance.db' },
  { key: 'gold',       label: 'پلتفرم‌های طلا',  every: 'هر ۱۰ دقیقه', db: 'gold.db' },
  { key: 'commodity',  label: 'کالای جهانی',     every: 'هر ۱۰ دقیقه', db: 'commodity.db' },
  { key: 'news',       label: 'اخبار تلگرام',    every: 'لحظه‌ای',    db: 'news.db' },
  { key: 'polymarket', label: 'پلی‌مارکت',       every: 'هر ۶ ساعت',  db: 'polymarket.db' },
  { key: 'cars',       label: 'بازار خودرو',     every: 'هر ۱۲ ساعت', db: 'cars.db' },
  { key: 'market',     label: 'کالای دیجی‌کالا', every: 'هر ۲۴ ساعت', db: 'market.db' },
  { key: 'jobs',       label: 'بازار کار',       every: 'هر ۲۴ ساعت', db: 'jobs.db' },
  { key: 'property',   label: 'ملک تهران',       every: 'هر ۲۴ ساعت', db: 'property.db' },
];

function build() {
  const news = {
    total:      one('news.db', 'SELECT COUNT(*) c FROM news', 0),
    day:        one('news.db', "SELECT COUNT(*) c FROM news WHERE published_at > datetime('now','-1 day')", 0),
    week:       one('news.db', "SELECT COUNT(*) c FROM news WHERE published_at > datetime('now','-7 days')", 0),
    translated: one('news.db', "SELECT COUNT(*) c FROM news WHERE text_fa IS NOT NULL AND TRIM(text_fa)<>''", 0),
    media:      one('news.db', "SELECT COUNT(*) c FROM news WHERE media_url IS NOT NULL AND media_url<>''", 0),
    channels:   one('news.db', 'SELECT COUNT(*) c FROM channels WHERE active=1', 0),
    translating:one('news.db', 'SELECT COUNT(*) c FROM channels WHERE active=1 AND needs_translation=1', 0),
    categories: one('news.db', 'SELECT COUNT(DISTINCT category) c FROM channels WHERE active=1', 0),
    since:      one('news.db', 'SELECT MIN(published_at) v FROM news', null),
  };
  news.perDay = news.week ? Math.round(news.week / 7) : 0;

  const sections = [
    { label: 'ترند سرچ',      rows: one('trends.db', 'SELECT COUNT(*) c FROM trend_snapshots', 0),        note: 'اسنپ‌شات + منحنی واقعی گوگل' },
    { label: 'بازار مالی',     rows: one('finance.db', 'SELECT COUNT(*) c FROM finance_snapshots', 0),     note: one('finance.db', 'SELECT COUNT(DISTINCT symbol) c FROM finance_snapshots', 0) + ' نماد زنده' },
    { label: 'کالای جهانی',    rows: one('commodity.db', 'SELECT COUNT(*) c FROM commodity_snapshots', 0), note: 'فلز، انرژی، محصولات کشاورزی' },
    { label: 'اخبار',          rows: news.total,                                                          note: news.channels + ' کانال تلگرام' },
    { label: 'پلتفرم‌های طلا',  rows: one('gold.db', 'SELECT COUNT(*) c FROM gold_prices', 0),              note: one('gold.db', 'SELECT COUNT(*) c FROM gold_platforms WHERE active=1', 0) + ' طلافروشی آنلاین' },
    { label: 'ترند آینده',     rows: one('timeline.db', 'SELECT COUNT(*) c FROM predictions', 0),          note: 'پیش‌بینی ثبت‌شده' },
    { label: 'بازار خودرو',    rows: one('cars.db', 'SELECT COUNT(*) c FROM car_submodels', 0),            note: one('cars.db', 'SELECT COUNT(*) c FROM car_models', 0) + ' برند خودرو' },
    { label: 'کالای دیجی‌کالا', rows: one('market.db', 'SELECT COUNT(*) c FROM snapshots', 0),              note: 'پرفروش‌های بازار' },
    { label: 'پلی‌مارکت',      rows: one('polymarket.db', 'SELECT COUNT(*) c FROM markets', 0),            note: 'بازار پیش‌بینی، ترجمه‌شده' },
    { label: 'بازار کار',      rows: one('jobs.db', 'SELECT COUNT(*) c FROM job_snapshots', 0),            note: 'آگهی به تفکیک دسته' },
    { label: 'ملک تهران',      rows: one('property.db', 'SELECT COUNT(*) c FROM property_regions', 0),     note: 'منطقه، با قیمت متری' },
  ].sort((a, b) => b.rows - a.rows);

  const totalPoints = sections.reduce((a, s) => a + (s.rows || 0), 0);

  // موتور پیش‌بینی — جدول‌هایش خودشان بهترین توضیح‌اند
  const engine = rows('timeline.db',
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r => r.name);

  const crawlers = CRAWLERS.map(c => Object.assign({}, c, { sizeMB: dbSizeMB(c.db) }));

  let diskMB = 0;
  try { for (const f of fs.readdirSync(DATA)) if (f.endsWith('.db')) diskMB += fs.statSync(path.join(DATA, f)).size; } catch (e) {}

  return {
    builtAt: new Date().toISOString(),
    day: new Date().toISOString().slice(0, 10),
    news, sections, engine, crawlers,
    totals: {
      points: totalPoints,
      crawlers: CRAWLERS.length,
      sections: 10,
      diskMB: Math.round(diskMB / 1048576),
      trendPages: one('trends.db', 'SELECT COUNT(DISTINCT keyword) c FROM trend_snapshots', 0),
    },
  };
}

function read() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) { return null; }
}

/** همیشه چیزی برمی‌گرداند؛ اگر کش مال امروز نبود دوباره می‌سازد */
function get() {
  const c = read();
  if (c && c.day === new Date().toISOString().slice(0, 10)) return c;
  return refresh();
}

function refresh() {
  const s = build();
  try { fs.writeFileSync(CACHE, JSON.stringify(s)); } catch (e) { console.warn('[stats] ذخیره نشد:', e.message); }
  return s;
}

/** آخر هر روز تازه می‌شود؛ ضمناً هر ۶ ساعت یک بار هم برای اطمینان */
function startStatsScheduler() {
  setTimeout(refresh, 30 * 1000);
  setInterval(refresh, 6 * 3600 * 1000);
  console.log('[stats] زمان‌بند آمار فعال — تازه‌سازی هر ۶ ساعت');
}

module.exports = { get, refresh, startStatsScheduler, CRAWLERS };
