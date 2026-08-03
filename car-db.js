/**
 * car-db.js — بازار خودرو ایران (data/cars.db)
 *
 * هر ۱۲ ساعت یک snapshot از هر برند در دیوار ذخیره می‌شود تا بتوان روند قیمت،
 * کارکرد و سنجه «قیمت بر کارکرد» را در طول زمان دنبال کرد.
 *
 * چرا هم میانگین و هم میانه: در آگهی‌های خودرو چند آگهی خیلی گران (مثلاً وانت
 * صفرکیلومتر بین پرایدهای کارکرده) میانگین را جابه‌جا می‌کند؛ میانه تصویر
 * واقعی‌تری از بازار می‌دهد. هر دو نگه داشته می‌شود تا مقایسه ممکن باشد.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'cars.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS car_models (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    slug       TEXT UNIQUE NOT NULL,
    name_fa    TEXT NOT NULL,
    tier       TEXT NOT NULL,          -- low | mid | high
    url        TEXT NOT NULL,
    image_url  TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS car_snapshots (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id       INTEGER NOT NULL,
    avg_price      REAL,
    median_price   REAL,
    min_price      REAL,
    max_price      REAL,
    avg_mileage    REAL,
    median_mileage REAL,
    price_per_km   REAL,               -- تومان به ازای هر کیلومتر
    listing_count  INTEGER,
    captured_at    TEXT NOT NULL,
    snap_date      TEXT NOT NULL,      -- YYYY-MM-DD
    slot           INTEGER NOT NULL,   -- 0 = نیمه اول روز، 1 = نیمه دوم
    UNIQUE(model_id, snap_date, slot),
    FOREIGN KEY(model_id) REFERENCES car_models(id)
  );
  CREATE INDEX IF NOT EXISTS idx_cs_model ON car_snapshots(model_id);
  CREATE INDEX IF NOT EXISTS idx_cs_date  ON car_snapshots(snap_date);
`);

// ── مدل‌ها ────────────────────────────────────────────────
const _upsertModel = db.prepare(`
  INSERT INTO car_models (slug, name_fa, tier, url, image_url, updated_at)
  VALUES (?,?,?,?,?,?)
  ON CONFLICT(slug) DO UPDATE SET
    name_fa=excluded.name_fa, tier=excluded.tier, url=excluded.url,
    image_url=COALESCE(excluded.image_url, car_models.image_url),
    updated_at=excluded.updated_at
  RETURNING id
`);

function upsertModel(m) {
  const row = _upsertModel.get(m.slug, m.name_fa, m.tier, m.url, m.image_url || null, new Date().toISOString());
  return row ? row.id : null;
}

function getModels() {
  return db.prepare('SELECT * FROM car_models ORDER BY tier, name_fa').all();
}

// ── snapshotها ────────────────────────────────────────────
const _insertSnap = db.prepare(`
  INSERT INTO car_snapshots
    (model_id, avg_price, median_price, min_price, max_price, avg_mileage,
     median_mileage, price_per_km, listing_count, captured_at, snap_date, slot)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(model_id, snap_date, slot) DO UPDATE SET
    avg_price=excluded.avg_price, median_price=excluded.median_price,
    min_price=excluded.min_price, max_price=excluded.max_price,
    avg_mileage=excluded.avg_mileage, median_mileage=excluded.median_mileage,
    price_per_km=excluded.price_per_km, listing_count=excluded.listing_count,
    captured_at=excluded.captured_at
`);

function saveSnapshot(modelId, s, capturedAt) {
  const ts = capturedAt || new Date().toISOString();
  const d = new Date(ts);
  const slot = d.getUTCHours() < 12 ? 0 : 1;
  _insertSnap.run(
    modelId, s.avg_price ?? null, s.median_price ?? null, s.min_price ?? null,
    s.max_price ?? null, s.avg_mileage ?? null, s.median_mileage ?? null,
    s.price_per_km ?? null, s.listing_count ?? 0, ts, ts.slice(0, 10), slot
  );
}

// آخرین snapshot هر مدل + مقایسه با نوبت قبل و با ۲۴ ساعت پیش
function getLatest() {
  const models = getModels();
  return models.map(m => {
    const cur = db.prepare(
      'SELECT * FROM car_snapshots WHERE model_id=? ORDER BY captured_at DESC LIMIT 1'
    ).get(m.id);
    if (!cur) return { ...m, snapshot: null };

    const prev = db.prepare(
      'SELECT * FROM car_snapshots WHERE model_id=? AND captured_at < ? ORDER BY captured_at DESC LIMIT 1'
    ).get(m.id, cur.captured_at);

    const dayAgo = db.prepare(
      `SELECT * FROM car_snapshots WHERE model_id=? AND captured_at <= datetime(?, '-1 day')
       ORDER BY captured_at DESC LIMIT 1`
    ).get(m.id, cur.captured_at);

    const pct = (now, before) =>
      (before && before > 0 && now != null) ? ((now - before) / before) * 100 : null;

    return {
      ...m,
      snapshot: cur,
      change_prev_pct: pct(cur.median_price, prev && prev.median_price),
      change_day_pct: pct(cur.median_price, dayAgo && dayAgo.median_price),
      mileage_change_day_pct: pct(cur.median_mileage, dayAgo && dayAgo.median_mileage),
    };
  });
}

function getHistory(slug, days = 30) {
  return db.prepare(`
    SELECT s.* FROM car_snapshots s
    JOIN car_models m ON m.id = s.model_id
    WHERE m.slug = ? AND s.snap_date >= date('now', ?)
    ORDER BY s.captured_at ASC
  `).all(slug, `-${parseInt(days)} days`);
}

// «سرعت رشد» — شیب درصدی قیمت در N روز اخیر (درصد تغییر به ازای هر روز)
function getMomentum(days = 7) {
  const models = getModels();
  return models.map(m => {
    const rows = db.prepare(`
      SELECT median_price, captured_at FROM car_snapshots
      WHERE model_id=? AND snap_date >= date('now', ?) AND median_price IS NOT NULL
      ORDER BY captured_at ASC
    `).all(m.id, `-${parseInt(days)} days`);
    if (rows.length < 2) return { slug: m.slug, name_fa: m.name_fa, tier: m.tier, pct_per_day: null, points: rows.length };
    const first = rows[0], last = rows[rows.length - 1];
    const spanDays = Math.max(
      (new Date(last.captured_at) - new Date(first.captured_at)) / 86400000, 0.5
    );
    const totalPct = ((last.median_price - first.median_price) / first.median_price) * 100;
    return {
      slug: m.slug, name_fa: m.name_fa, tier: m.tier,
      pct_per_day: totalPct / spanDays, total_pct: totalPct,
      span_days: spanDays, points: rows.length,
    };
  });
}

// «صرفه اقتصادی» — قیمت‌بر‌کارکرد هر مدل نسبت به میانگین هم‌رده‌اش.
// عدد منفی یعنی از رده خودش ارزان‌تر است (به ازای هر کیلومتر پول کمتری می‌دهی).
function getValueScores() {
  const latest = getLatest().filter(x => x.snapshot && x.snapshot.price_per_km);
  const byTier = {};
  for (const x of latest) (byTier[x.tier] = byTier[x.tier] || []).push(x.snapshot.price_per_km);
  const tierAvg = {};
  for (const t in byTier) tierAvg[t] = byTier[t].reduce((a, b) => a + b, 0) / byTier[t].length;
  return latest.map(x => ({
    slug: x.slug, name_fa: x.name_fa, tier: x.tier,
    price_per_km: x.snapshot.price_per_km,
    tier_avg_price_per_km: tierAvg[x.tier],
    value_vs_tier_pct: tierAvg[x.tier]
      ? ((x.snapshot.price_per_km - tierAvg[x.tier]) / tierAvg[x.tier]) * 100
      : null,
  }));
}

function getStats() {
  return db.prepare(`
    SELECT COUNT(*) snapshots, COUNT(DISTINCT model_id) models,
           COUNT(DISTINCT snap_date) days, MIN(snap_date) first_day, MAX(snap_date) last_day
    FROM car_snapshots
  `).get();
}

function cleanup() {
  const r = db.prepare(`DELETE FROM car_snapshots WHERE snap_date < date('now','-365 days')`).run();
  if (r.changes) console.log(`[car-db] cleanup: ${r.changes} old snapshots removed`);
}

module.exports = {
  upsertModel, getModels, saveSnapshot, getLatest, getHistory,
  getMomentum, getValueScores, getStats, cleanup,
};
