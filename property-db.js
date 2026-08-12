/**
 * property-db.js — قیمت مسکن ۲۲ منطقه‌ی تهران
 *
 * سه لایه‌ی داده نگه داشته می‌شود:
 *   property_regions   — شناسنامه‌ی منطقه: نام، مرکز، مرز جغرافیایی، مسیر SVG نقشه
 *   property_snapshots — عکس روزانه‌ی قیمت (یک ردیف در روز برای هر منطقه)
 *   property_trends    — سری ماهانه‌ی تاریخی که منبع بیرونی می‌دهد
 *
 * چرا هم snapshot و هم trend؟ سری ماهانه‌ی منبع، تاریخچه‌ی گذشته را می‌دهد
 * ولی پیوسته نیست و با تأخیر بروز می‌شود. عکس روزانه‌ی خودمان سری دقیق و
 * پیوسته‌ای می‌سازد که از امروز به بعد کاملاً مال ماست.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, 'data', 'property.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS property_regions (
    region_no  INTEGER PRIMARY KEY,
    ext_id     TEXT,
    name_fa    TEXT NOT NULL,
    slug       TEXT UNIQUE NOT NULL,
    center_lng REAL,
    center_lat REAL,
    polygon    TEXT,            -- آرایه‌ی JSON از [lng,lat]، ساده‌سازی‌شده
    svg_path   TEXT,            -- مسیر SVG آماده در دستگاه مختصات مشترک نقشه
    svg_cx     REAL,            -- جای برچسب شماره‌ی منطقه روی همان بوم
    svg_cy     REAL,
    areas      TEXT,            -- محله‌های شاخص، JSON
    active     INTEGER DEFAULT 1,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS property_snapshots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    region_no  INTEGER NOT NULL,
    day        TEXT NOT NULL,   -- YYYY-MM-DD میلادی
    meter      REAL,            -- تومان بر متر مربع
    unit       REAL,            -- تومان برای یک واحد متوسط
    est        INTEGER DEFAULT 0, -- ۱ یعنی از سری ماهانه پشتیبان گرفته شده، نه ارزیابی مستقیم
    captured_at TEXT NOT NULL,
    UNIQUE(region_no, day)
  );
  CREATE INDEX IF NOT EXISTS idx_psnap ON property_snapshots(region_no, day DESC);

  CREATE TABLE IF NOT EXISTS property_trends (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    region_no INTEGER NOT NULL,
    date      TEXT NOT NULL,    -- YYYY-MM-DD
    period    TEXT,             -- برچسب شمسی، مثلاً «مرداد ۱۴۰۵»
    value     REAL,             -- تومان بر متر مربع
    UNIQUE(region_no, date)
  );
  CREATE INDEX IF NOT EXISTS idx_ptrend ON property_trends(region_no, date);

  CREATE TABLE IF NOT EXISTS property_status (
    region_no   INTEGER PRIMARY KEY,
    ok          INTEGER DEFAULT 0,
    last_ok     TEXT,
    last_try    TEXT,
    error       TEXT,
    ms          INTEGER,
    fail_streak INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS property_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

/* CREATE TABLE IF NOT EXISTS ستون تازه را به جدول موجود اضافه نمی‌کند،
   پس ستون‌هایی که بعداً آمده‌اند باید صریح اضافه شوند. */
for (const [tbl, col, type] of [
  ['property_regions', 'svg_cx', 'REAL'],
  ['property_regions', 'svg_cy', 'REAL'],
  ['property_snapshots', 'est', 'INTEGER DEFAULT 0'],
]) {
  const has = db.prepare(`PRAGMA table_info(${tbl})`).all().some(c => c.name === col);
  if (!has) db.exec(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${type}`);
}

function setMeta(key, value) {
  db.prepare('INSERT INTO property_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}
function getMeta(key) {
  const r = db.prepare('SELECT value FROM property_meta WHERE key=?').get(key);
  return r ? r.value : null;
}

/* ── مناطق ── */

function upsertRegion(r) {
  db.prepare(`
    INSERT INTO property_regions (region_no, ext_id, name_fa, slug, center_lng, center_lat, polygon, areas, updated_at)
    VALUES (@region_no, @ext_id, @name_fa, @slug, @center_lng, @center_lat, @polygon, @areas, datetime('now'))
    ON CONFLICT(region_no) DO UPDATE SET
      ext_id     = COALESCE(@ext_id, ext_id),
      name_fa    = @name_fa,
      center_lng = COALESCE(@center_lng, center_lng),
      center_lat = COALESCE(@center_lat, center_lat),
      polygon    = COALESCE(@polygon, polygon),
      areas      = COALESCE(@areas, areas),
      updated_at = datetime('now')
  `).run({
    region_no: r.region_no, ext_id: r.ext_id || null, name_fa: r.name_fa,
    slug: r.slug, center_lng: r.center_lng == null ? null : r.center_lng,
    center_lat: r.center_lat == null ? null : r.center_lat,
    polygon: r.polygon ? JSON.stringify(r.polygon) : null,
    areas: r.areas ? JSON.stringify(r.areas) : null,
  });
}

function setSvgPath(region_no, d, cx, cy) {
  db.prepare('UPDATE property_regions SET svg_path=?, svg_cx=?, svg_cy=? WHERE region_no=?')
    .run(d, cx == null ? null : cx, cy == null ? null : cy, region_no);
}

function getRegions() {
  return db.prepare('SELECT * FROM property_regions WHERE active=1 ORDER BY region_no').all();
}

function getRegion(region_no) {
  return db.prepare('SELECT * FROM property_regions WHERE region_no=?').get(region_no);
}

/* ── عکس روزانه ── */

function saveSnapshot(region_no, meter, unit, est, day) {
  const d = day || new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO property_snapshots (region_no, day, meter, unit, est, captured_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(region_no, day) DO UPDATE SET
      meter=excluded.meter, unit=excluded.unit, est=excluded.est, captured_at=excluded.captured_at
  `).run(region_no, d, meter, unit, est ? 1 : 0, new Date().toISOString());
}

function saveTrends(region_no, points) {
  const st = db.prepare(`
    INSERT INTO property_trends (region_no, date, period, value) VALUES (?,?,?,?)
    ON CONFLICT(region_no, date) DO UPDATE SET period=excluded.period, value=excluded.value
  `);
  const tx = db.transaction(list => { for (const p of list) st.run(region_no, p.date, p.period, p.value); });
  tx(points || []);
}

function setStatus(region_no, s) {
  const prev = db.prepare('SELECT fail_streak FROM property_status WHERE region_no=?').get(region_no);
  const streak = s.ok ? 0 : ((prev && prev.fail_streak) || 0) + 1;
  db.prepare(`
    INSERT INTO property_status (region_no, ok, last_ok, last_try, error, ms, fail_streak)
    VALUES (@n, @ok, @lastOk, @lastTry, @error, @ms, @streak)
    ON CONFLICT(region_no) DO UPDATE SET
      ok=@ok, last_try=@lastTry, error=@error, ms=@ms, fail_streak=@streak,
      last_ok=CASE WHEN @ok=1 THEN @lastTry ELSE last_ok END
  `).run({
    n: region_no, ok: s.ok ? 1 : 0, lastOk: s.ok ? new Date().toISOString() : null,
    lastTry: new Date().toISOString(), error: s.error || null, ms: s.ms || null, streak,
  });
}

/* ── خواندن برای نمایش ── */

/**
 * آخرین وضعیت هر منطقه، به‌همراه مقایسه با عکس قبلی و قدیمی‌ترین عکس.
 * prev برای «تغییر از آخرین بروزرسانی» و first برای «رشد از شروع رصد» است.
 */
function latest() {
  return db.prepare(`
    SELECT r.region_no, r.name_fa, r.slug, r.svg_path, r.svg_cx, r.svg_cy, r.areas,
           s.meter, s.unit, s.est, s.day, s.captured_at,
           p.meter AS prev_meter, p.day AS prev_day,
           st.ok, st.last_ok, st.error
    FROM property_regions r
    LEFT JOIN property_snapshots s ON s.id = (
      SELECT id FROM property_snapshots WHERE region_no=r.region_no AND meter IS NOT NULL
      ORDER BY day DESC LIMIT 1)
    LEFT JOIN property_snapshots p ON p.id = (
      SELECT id FROM property_snapshots WHERE region_no=r.region_no AND meter IS NOT NULL
        AND day < COALESCE(s.day,'9999') ORDER BY day DESC LIMIT 1)
    LEFT JOIN property_status st ON st.region_no = r.region_no
    WHERE r.active=1
    ORDER BY r.region_no
  `).all();
}

/** سری ماهانه‌ی منبع برای یک منطقه */
function trendsOf(region_no) {
  return db.prepare('SELECT date, period, value FROM property_trends WHERE region_no=? ORDER BY date').all(region_no);
}

/** سری روزانه‌ی خودمان برای یک منطقه */
function snapshotsOf(region_no, days) {
  return db.prepare(
    'SELECT day, meter, unit FROM property_snapshots WHERE region_no=? AND meter IS NOT NULL ' +
    'ORDER BY day DESC LIMIT ?'
  ).all(region_no, days || 180).reverse();
}

/** چند روز داده‌ی روزانه داریم — برای اینکه صادقانه بگوییم رصد از کی شروع شده */
function coverage() {
  return db.prepare(
    'SELECT MIN(day) first_day, MAX(day) last_day, COUNT(DISTINCT day) days FROM property_snapshots WHERE meter IS NOT NULL'
  ).get() || { first_day: null, last_day: null, days: 0 };
}

function allStatus() {
  return db.prepare(`
    SELECT r.region_no, r.name_fa, r.slug, r.active, r.updated_at,
           st.ok, st.last_ok, st.last_try, st.error, st.ms, st.fail_streak,
           (SELECT COUNT(*) FROM property_snapshots WHERE region_no=r.region_no) AS snaps,
           (SELECT meter FROM property_snapshots WHERE region_no=r.region_no ORDER BY day DESC LIMIT 1) AS meter
    FROM property_regions r LEFT JOIN property_status st ON st.region_no=r.region_no
    ORDER BY r.region_no
  `).all();
}

/** یک عکس در روز برای هر منطقه یعنی ~۸۰۰۰ ردیف در سال — نگه‌داشتن ۳ سال بی‌ضرر است */
function cleanup(days) {
  const cut = new Date(Date.now() - (days || 1095) * 86400 * 1000).toISOString().slice(0, 10);
  return db.prepare('DELETE FROM property_snapshots WHERE day < ?').run(cut).changes;
}

module.exports = {
  db, upsertRegion, setSvgPath, getRegions, getRegion, setMeta, getMeta,
  saveSnapshot, saveTrends, setStatus,
  latest, trendsOf, snapshotsOf, coverage, allStatus, cleanup,
};
