/**
 * commodity-db.js — قیمت جهانی کالا (نفت، فلزات، محصولات کشاورزی)
 *
 * برخلاف gold-db.js که هر پلتفرم را جدا رصد می‌کند، اینجا یک منبع واحد
 * در یک درخواست همه‌ی نمادها را می‌دهد؛ پس وضعیت هم یک ردیف کلی است،
 * نه یکی به‌ازای هر نماد.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, 'data', 'commodity.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS commodity_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL,        -- شناسه‌ی پایدار، مثل crude-oil
    name_en     TEXT,
    category    TEXT,                 -- کلید دسته: energy | precious | base | agri | livestock | index
    unit        TEXT,                 -- واحد خام از منبع، مثل "USD/Bbl"
    price       REAL,
    change      REAL,
    change_pct  REAL,
    weekly_pct  REAL,
    monthly_pct REAL,
    ytd_pct     REAL,
    yoy_pct     REAL,
    captured_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_com_slug ON commodity_snapshots(slug, captured_at DESC);

  CREATE TABLE IF NOT EXISTS commodity_status (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    ok          INTEGER DEFAULT 0,
    last_ok     TEXT,
    last_try    TEXT,
    error       TEXT,
    ms          INTEGER,
    fail_streak INTEGER DEFAULT 0,
    row_count   INTEGER DEFAULT 0
  );
`);

const _insert = db.prepare(`
  INSERT INTO commodity_snapshots
    (slug,name_en,category,unit,price,change,change_pct,weekly_pct,monthly_pct,ytd_pct,yoy_pct,captured_at)
  VALUES (@slug,@name_en,@category,@unit,@price,@change,@change_pct,@weekly_pct,@monthly_pct,@ytd_pct,@yoy_pct,@captured_at)
`);

function saveSnapshots(rows) {
  const at = new Date().toISOString();
  const tx = db.transaction(list => { for (const r of list) _insert.run(Object.assign({ captured_at: at }, r)); });
  tx(rows);
  return rows.length;
}

function setStatus(s) {
  const prev = db.prepare('SELECT fail_streak FROM commodity_status WHERE id=1').get();
  const streak = s.ok ? 0 : ((prev && prev.fail_streak) || 0) + 1;
  db.prepare(`
    INSERT INTO commodity_status (id, ok, last_ok, last_try, error, ms, fail_streak, row_count)
    VALUES (1, @ok, @lastOk, @lastTry, @error, @ms, @streak, @rows)
    ON CONFLICT(id) DO UPDATE SET
      ok=@ok, last_try=@lastTry, error=@error, ms=@ms, fail_streak=@streak, row_count=@rows,
      last_ok=CASE WHEN @ok=1 THEN @lastTry ELSE last_ok END
  `).run({
    ok: s.ok ? 1 : 0, lastOk: s.ok ? new Date().toISOString() : null,
    lastTry: new Date().toISOString(), error: s.error || null, ms: s.ms || null,
    streak, rows: s.rows || 0,
  });
}

function getStatus() {
  return db.prepare('SELECT * FROM commodity_status WHERE id=1').get() || null;
}

/** آخرین قیمت هر نماد، به‌همراه تغییر نسبت به عکس قبلی برای اسپارک‌لاین کوچک */
function getLatestAll() {
  return db.prepare(`
    SELECT s.* FROM commodity_snapshots s
    WHERE s.id IN (SELECT MAX(id) FROM commodity_snapshots GROUP BY slug)
    ORDER BY s.category, s.slug
  `).all();
}

function getSeries(slug, hours) {
  const since = new Date(Date.now() - (hours || 24) * 3600 * 1000).toISOString();
  return db.prepare(
    'SELECT price, captured_at FROM commodity_snapshots WHERE slug=? AND captured_at>=? ORDER BY captured_at'
  ).all(slug, since);
}

/** هر ۱۰ دقیقه یعنی ~۴۳۰۰ ردیف در ماه برای هر نماد؛ ۳۰ روز کافی است */
function cleanup(days) {
  const cut = new Date(Date.now() - (days || 30) * 86400 * 1000).toISOString();
  return db.prepare('DELETE FROM commodity_snapshots WHERE captured_at < ?').run(cut).changes;
}

module.exports = { db, saveSnapshots, setStatus, getStatus, getLatestAll, getSeries, cleanup };
