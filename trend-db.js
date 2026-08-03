/**
 * trend-db.js — تاریخچه ترندهای جستجو (data/trends.db)
 *
 * تا امروز ترندها فقط در h4.json/h24.json نگه داشته می‌شدند و هر کرال کامل
 * replace می‌شد، یعنی هیچ تاریخچه‌ای وجود نداشت. این ماژول هر snapshot را
 * نگه می‌دارد تا بتوان پرسید «کدام کلیدواژه از روز اول تا الان بیشترین
 * جستجو را داشته». الگوی market-db.js دنبال شده (WAL + cleanup یک‌ساله).
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'trends.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS trend_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword     TEXT NOT NULL,
    window      TEXT NOT NULL,          -- '4h' | '24h'
    rank        INTEGER,
    vol         INTEGER,
    growth      INTEGER,
    cat         TEXT,
    active      INTEGER DEFAULT 1,
    captured_at TEXT NOT NULL,
    snap_date   TEXT NOT NULL,          -- YYYY-MM-DD
    UNIQUE(keyword, window, captured_at)
  );
  CREATE INDEX IF NOT EXISTS idx_ts_keyword ON trend_snapshots(keyword);
  CREATE INDEX IF NOT EXISTS idx_ts_captured ON trend_snapshots(captured_at);
  CREATE INDEX IF NOT EXISTS idx_ts_date ON trend_snapshots(snap_date);
  CREATE INDEX IF NOT EXISTS idx_ts_cat ON trend_snapshots(cat);

  CREATE TABLE IF NOT EXISTS trend_keyword_cat (
    keyword    TEXT PRIMARY KEY,
    cat        TEXT NOT NULL,
    source     TEXT NOT NULL,           -- 'ai' | 'rule'
    updated_at TEXT NOT NULL
  );
`);

// ── ذخیره یک دور کرال ──────────────────────────────────────
const _insert = db.prepare(`
  INSERT OR IGNORE INTO trend_snapshots
    (keyword, window, rank, vol, growth, cat, active, captured_at, snap_date)
  VALUES (?,?,?,?,?,?,?,?,?)
`);

function saveSnapshot(trends, window, capturedAt) {
  const ts = capturedAt || new Date().toISOString();
  const day = ts.slice(0, 10);
  const tx = db.transaction(rows => {
    for (const t of rows) {
      const kw = (t.keyword || '').trim();
      if (!kw) continue;
      _insert.run(kw, window, t.rank ?? null, t.vol ?? 0, t.growth ?? 0,
        t.cat || null, t.active ? 1 : 0, ts, day);
    }
  });
  tx(trends || []);
}

// ── کش دسته‌بندی ───────────────────────────────────────────
// AI فقط وقتی سهمیه دارد جواب می‌دهد؛ هر دسته‌ای که یک‌بار گرفتیم نگه می‌داریم
// تا با قطعی سهمیه از بین نرود. دسته‌ی AI روی دسته‌ی قاعده‌محور اولویت دارد.
const _getCat = db.prepare('SELECT cat, source FROM trend_keyword_cat WHERE keyword=?');
const _setCat = db.prepare(`
  INSERT INTO trend_keyword_cat (keyword, cat, source, updated_at) VALUES (?,?,?,?)
  ON CONFLICT(keyword) DO UPDATE SET
    cat=excluded.cat, source=excluded.source, updated_at=excluded.updated_at
  WHERE excluded.source='ai' OR trend_keyword_cat.source!='ai'
`);

function getCachedCat(keyword) {
  const r = _getCat.get(String(keyword || '').trim());
  return r ? r.cat : null;
}

function setCachedCat(keyword, cat, source) {
  const kw = String(keyword || '').trim();
  if (!kw || !cat) return;
  _setCat.run(kw, cat, source === 'ai' ? 'ai' : 'rule', new Date().toISOString());
}

function setCachedCatBulk(pairs, source) {
  const tx = db.transaction(list => {
    for (const [kw, cat] of list) setCachedCat(kw, cat, source);
  });
  tx(pairs || []);
}

// ── پرس‌وجوهای فیچرهای جدید ────────────────────────────────

// تالار مشاهیر: پرحجم‌ترین/ماندگارترین کلیدواژه‌ها از ابتدا تا حالا
function getHallOfFame(limit = 50, days = null) {
  const where = days ? `WHERE snap_date >= date('now', '-${parseInt(days)} days')` : '';
  return db.prepare(`
    SELECT keyword,
           MAX(vol)                      AS peak_vol,
           MAX(growth)                   AS peak_growth,
           COUNT(DISTINCT snap_date)     AS days_seen,
           COUNT(*)                      AS appearances,
           MIN(captured_at)              AS first_seen,
           MAX(captured_at)              AS last_seen,
           MIN(rank)                     AS best_rank,
           (SELECT cat FROM trend_keyword_cat c WHERE c.keyword = s.keyword) AS cat
    FROM trend_snapshots s
    ${where}
    GROUP BY keyword
    ORDER BY peak_vol DESC, days_seen DESC
    LIMIT ?
  `).all(limit);
}

// ماندگارترین‌ها: بیشترین تعداد روز حضور
function getMostPersistent(limit = 15) {
  return db.prepare(`
    SELECT keyword, COUNT(DISTINCT snap_date) AS days_seen, MAX(vol) AS peak_vol,
           MIN(captured_at) AS first_seen, MAX(captured_at) AS last_seen
    FROM trend_snapshots
    GROUP BY keyword
    HAVING days_seen > 1
    ORDER BY days_seen DESC, peak_vol DESC
    LIMIT ?
  `).all(limit);
}

// شهاب‌سنگ‌ها: فقط یک روز دیده شدند ولی با رشد/حجم بالا
function getMeteors(limit = 15) {
  return db.prepare(`
    SELECT keyword, MAX(vol) AS peak_vol, MAX(growth) AS peak_growth,
           MIN(captured_at) AS first_seen, COUNT(DISTINCT snap_date) AS days_seen
    FROM trend_snapshots
    GROUP BY keyword
    HAVING days_seen = 1
    ORDER BY peak_growth DESC, peak_vol DESC
    LIMIT ?
  `).all(limit);
}

// تایم‌لاین یک کلیدواژه برای نمودار
function getKeywordTimeline(keyword, days = 30) {
  return db.prepare(`
    SELECT snap_date, MAX(vol) AS vol, MAX(growth) AS growth, MIN(rank) AS best_rank
    FROM trend_snapshots
    WHERE keyword = ? AND snap_date >= date('now', ?)
    GROUP BY snap_date
    ORDER BY snap_date ASC
  `).all(String(keyword || '').trim(), `-${parseInt(days)} days`);
}

// سهم دسته‌ها بر پایه حجم جستجو
function getCategoryShare(days = 7) {
  return db.prepare(`
    SELECT COALESCE(cat, 'نامشخص') AS cat,
           SUM(vol) AS total_vol,
           COUNT(DISTINCT keyword) AS keywords
    FROM trend_snapshots
    WHERE snap_date >= date('now', ?)
    GROUP BY COALESCE(cat, 'نامشخص')
    ORDER BY total_vol DESC
  `).all(`-${parseInt(days)} days`);
}

// نقشه حرارتی: روز × دسته
function getActivityHeatmap(days = 14) {
  return db.prepare(`
    SELECT snap_date, COALESCE(cat, 'نامشخص') AS cat, SUM(vol) AS total_vol
    FROM trend_snapshots
    WHERE snap_date >= date('now', ?)
    GROUP BY snap_date, COALESCE(cat, 'نامشخص')
    ORDER BY snap_date ASC
  `).all(`-${parseInt(days)} days`);
}

function getStats() {
  return db.prepare(`
    SELECT COUNT(*) AS snapshots,
           COUNT(DISTINCT keyword) AS keywords,
           COUNT(DISTINCT snap_date) AS days,
           MIN(snap_date) AS first_day,
           MAX(snap_date) AS last_day
    FROM trend_snapshots
  `).get();
}

function cleanup() {
  const r = db.prepare(`DELETE FROM trend_snapshots WHERE snap_date < date('now','-365 days')`).run();
  if (r.changes) console.log(`[trend-db] cleanup: ${r.changes} old snapshots removed`);
}

module.exports = {
  saveSnapshot, getCachedCat, setCachedCat, setCachedCatBulk,
  getHallOfFame, getMostPersistent, getMeteors, getKeywordTimeline,
  getCategoryShare, getActivityHeatmap, getStats, cleanup,
  _db: db,
};
