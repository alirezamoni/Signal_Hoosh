/**
 * gold-db.js — قیمت طلای ۱۸ عیار در پلتفرم‌های آنلاین
 *
 * هر پلتفرم یک ردیف در gold_platforms دارد و هر اندازه‌گیری یک ردیف در
 * gold_prices. وضعیت آخرین تلاش جدا نگه داشته می‌شود تا در پنل مدیریت
 * بشود دید کدام سایت جواب نمی‌دهد و چرا.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, 'data', 'gold.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS gold_platforms (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    slug       TEXT UNIQUE NOT NULL,
    name_fa    TEXT NOT NULL,
    url        TEXT NOT NULL,
    logo       TEXT,                       -- مسیر محلی، نه لینک بیرونی
    active     INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS gold_prices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    platform_id INTEGER NOT NULL,
    price       REAL NOT NULL,             -- تومان به ازای هر گرم
    captured_at TEXT NOT NULL,
    FOREIGN KEY(platform_id) REFERENCES gold_platforms(id)
  );
  CREATE INDEX IF NOT EXISTS idx_gold_prices ON gold_prices(platform_id, captured_at DESC);

  CREATE TABLE IF NOT EXISTS gold_status (
    platform_id INTEGER PRIMARY KEY,
    ok          INTEGER DEFAULT 0,
    last_ok     TEXT,
    last_try    TEXT,
    error       TEXT,
    ms          INTEGER,
    fail_streak INTEGER DEFAULT 0,
    FOREIGN KEY(platform_id) REFERENCES gold_platforms(id)
  );
`);

/* ── پلتفرم‌ها ── */

function upsertPlatform(p) {
  const cur = db.prepare('SELECT id FROM gold_platforms WHERE slug=?').get(p.slug);
  if (cur) {
    db.prepare('UPDATE gold_platforms SET name_fa=?, url=?, logo=COALESCE(?,logo), sort_order=? WHERE id=?')
      .run(p.name_fa, p.url, p.logo || null, p.sort_order || 0, cur.id);
    return cur.id;
  }
  return db.prepare('INSERT INTO gold_platforms (slug,name_fa,url,logo,sort_order) VALUES (?,?,?,?,?)')
    .run(p.slug, p.name_fa, p.url, p.logo || null, p.sort_order || 0).lastInsertRowid;
}

function getPlatforms(onlyActive) {
  return db.prepare(
    'SELECT * FROM gold_platforms' + (onlyActive ? ' WHERE active=1' : '') + ' ORDER BY sort_order, id'
  ).all();
}

// حذف نرم — تاریخچه‌ی قیمت می‌ماند تا نمودار گذشته سوراخ نشود
function deactivate(id) { db.prepare('UPDATE gold_platforms SET active=0 WHERE id=?').run(id); }
function activate(id)   { db.prepare('UPDATE gold_platforms SET active=1 WHERE id=?').run(id); }

// حذف کامل، همراه با تاریخچه
function removePlatform(id) {
  db.prepare('DELETE FROM gold_prices WHERE platform_id=?').run(id);
  db.prepare('DELETE FROM gold_status WHERE platform_id=?').run(id);
  db.prepare('DELETE FROM gold_platforms WHERE id=?').run(id);
}

/* ── قیمت‌ها ── */

function savePrice(platformId, price, at) {
  db.prepare('INSERT INTO gold_prices (platform_id, price, captured_at) VALUES (?,?,?)')
    .run(platformId, price, at || new Date().toISOString());
}

function setStatus(platformId, s) {
  const prev = db.prepare('SELECT fail_streak FROM gold_status WHERE platform_id=?').get(platformId);
  const streak = s.ok ? 0 : ((prev && prev.fail_streak) || 0) + 1;
  db.prepare(`
    INSERT INTO gold_status (platform_id, ok, last_ok, last_try, error, ms, fail_streak)
    VALUES (@id, @ok, @lastOk, @lastTry, @error, @ms, @streak)
    ON CONFLICT(platform_id) DO UPDATE SET
      ok=@ok, last_try=@lastTry, error=@error, ms=@ms, fail_streak=@streak,
      last_ok=CASE WHEN @ok=1 THEN @lastTry ELSE last_ok END
  `).run({
    id: platformId, ok: s.ok ? 1 : 0, lastOk: s.ok ? new Date().toISOString() : null,
    lastTry: new Date().toISOString(), error: s.error || null, ms: s.ms || null, streak,
  });
}

/** آخرین قیمت هر پلتفرم فعال، مرتب از ارزان به گران */
function getLatest() {
  return db.prepare(`
    SELECT p.id, p.slug, p.name_fa, p.url, p.logo,
           g.price, g.captured_at,
           s.ok, s.last_ok, s.error, s.fail_streak
    FROM gold_platforms p
    LEFT JOIN gold_status s ON s.platform_id = p.id
    LEFT JOIN gold_prices g ON g.id = (
      SELECT id FROM gold_prices WHERE platform_id = p.id ORDER BY captured_at DESC LIMIT 1
    )
    WHERE p.active = 1
    ORDER BY CASE WHEN g.price IS NULL THEN 1 ELSE 0 END, g.price ASC
  `).all();
}

/** وضعیت همه‌ی پلتفرم‌ها برای پنل مدیریت — شامل غیرفعال‌ها */
function getAllWithStatus() {
  return db.prepare(`
    SELECT p.*, s.ok, s.last_ok, s.last_try, s.error, s.ms, s.fail_streak,
           (SELECT COUNT(*) FROM gold_prices WHERE platform_id=p.id) AS samples,
           (SELECT price FROM gold_prices WHERE platform_id=p.id ORDER BY captured_at DESC LIMIT 1) AS price
    FROM gold_platforms p
    LEFT JOIN gold_status s ON s.platform_id = p.id
    ORDER BY p.sort_order, p.id
  `).all();
}

/** سری زمانی همه‌ی پلتفرم‌ها برای نمودار مشترک */
function getSeries(hours) {
  const since = new Date(Date.now() - (hours || 24) * 3600 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT g.platform_id, g.price, g.captured_at, p.name_fa, p.slug
    FROM gold_prices g JOIN gold_platforms p ON p.id = g.platform_id
    WHERE p.active = 1 AND g.captured_at >= ?
    ORDER BY g.captured_at ASC
  `).all(since);

  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.platform_id)) by.set(r.platform_id, { slug: r.slug, name_fa: r.name_fa, points: [] });
    by.get(r.platform_id).points.push({ t: r.captured_at, v: r.price });
  }
  return Array.from(by.values());
}

/** نگه‌داشتن ۳۰ روز — هر ۱۰ دقیقه یعنی ~۴۳۰۰ ردیف در ماه برای هر پلتفرم */
function cleanup(days) {
  const cut = new Date(Date.now() - (days || 30) * 86400 * 1000).toISOString();
  return db.prepare('DELETE FROM gold_prices WHERE captured_at < ?').run(cut).changes;
}

module.exports = {
  db, upsertPlatform, getPlatforms, deactivate, activate, removePlatform,
  savePrice, setStatus, getLatest, getAllWithStatus, getSeries, cleanup,
};
