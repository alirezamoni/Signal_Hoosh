/**
 * market-db.js — SQLite برای تاریخچه مارکت
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'market.db'));

// WAL mode برای performance بهتر
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    digi_id     TEXT UNIQUE,
    name        TEXT NOT NULL,
    brand       TEXT,
    category    TEXT,
    url         TEXT,
    image_url   TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  INTEGER NOT NULL,
    source      TEXT NOT NULL DEFAULT 'week',
    rank        INTEGER NOT NULL,
    price       INTEGER,
    snap_date   TEXT NOT NULL,
    FOREIGN KEY (product_id) REFERENCES products(id),
    UNIQUE(product_id, source, snap_date)
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_product ON snapshots(product_id);
  CREATE INDEX IF NOT EXISTS idx_snapshots_date    ON snapshots(snap_date);
  CREATE INDEX IF NOT EXISTS idx_snapshots_source  ON snapshots(source, snap_date);
`);

// ── upsert محصول و ثبت snapshot ──────────────────────────
function upsertProduct(p) {
  const existing = db.prepare('SELECT id FROM products WHERE digi_id = ?').get(p.digi_id);
  if (existing) {
    db.prepare(`UPDATE products SET name=?,brand=?,category=?,url=?,image_url=? WHERE id=?`)
      .run(p.name, p.brand, p.category, p.url, p.image_url, existing.id);
    return existing.id;
  }
  const r = db.prepare(`INSERT INTO products (digi_id,name,brand,category,url,image_url) VALUES (?,?,?,?,?,?)`)
    .run(p.digi_id, p.name, p.brand, p.category, p.url, p.image_url);
  return r.lastInsertRowid;
}

function saveSnapshot(product_id, source, rank, price, date) {
  db.prepare(`INSERT OR REPLACE INTO snapshots (product_id,source,rank,price,snap_date) VALUES (?,?,?,?,?)`)
    .run(product_id, source, rank, price, date);
}

const saveBatch = db.transaction((items, source, date) => {
  for (const item of items) {
    const pid = upsertProduct(item);
    saveSnapshot(pid, source, item.rank, item.price, date);
  }
});

// ── API queries ───────────────────────────────────────────
function getLatestList(source = 'week', limit = 50) {
  const latestDate = db.prepare(
    `SELECT snap_date FROM snapshots WHERE source=? ORDER BY snap_date DESC LIMIT 1`
  ).get(source)?.snap_date;
  if (!latestDate) return [];

  return db.prepare(`
    SELECT
      p.id, p.digi_id, p.name, p.brand, p.category, p.url, p.image_url,
      s.rank, s.price, s.snap_date,
      -- دیروز
      (SELECT rank FROM snapshots WHERE product_id=p.id AND source=? AND snap_date < ? ORDER BY snap_date DESC LIMIT 1) as prev_rank,
      -- هفته قبل
      (SELECT s7.rank FROM snapshots s7 WHERE s7.product_id=p.id AND s7.source=? AND s7.snap_date <= date(?,' -7 days') ORDER BY s7.snap_date DESC LIMIT 1) as rank_7d,
      -- ماه قبل
      (SELECT sm.rank FROM snapshots sm WHERE sm.product_id=p.id AND sm.source=? AND sm.snap_date <= date(?,' -30 days') ORDER BY sm.snap_date DESC LIMIT 1) as rank_30d
    FROM snapshots s
    JOIN products p ON p.id = s.product_id
    WHERE s.source=? AND s.snap_date=?
    ORDER BY s.rank ASC
    LIMIT ?
  `).all(source, latestDate, source, latestDate, source, latestDate, source, latestDate, limit);
}

function getProductHistory(product_id, source = 'week', days = 90) {
  return db.prepare(`
    SELECT rank, price, snap_date
    FROM snapshots
    WHERE product_id=? AND source=? AND snap_date >= date('now',?)
    ORDER BY snap_date ASC
  `).all(product_id, source, `-${days} days`);
}

function getProductStats(product_id, source = 'week') {
  return db.prepare(`
    SELECT
      MIN(rank) as best_rank,
      MAX(rank) as worst_rank,
      COUNT(DISTINCT snap_date) as days_tracked,
      SUM(CASE WHEN rank <= 50 THEN 1 ELSE 0 END) as days_in_top50,
      SUM(CASE WHEN rank <= 10 THEN 1 ELSE 0 END) as days_in_top10
    FROM snapshots
    WHERE product_id=? AND source=?
  `).get(product_id, source);
}

function getSummaryCards(source = 'week') {
  const latestDate = db.prepare(
    `SELECT snap_date FROM snapshots WHERE source=? ORDER BY snap_date DESC LIMIT 1`
  ).get(source)?.snap_date;
  if (!latestDate) return null;

  const prevDate = db.prepare(
    `SELECT snap_date FROM snapshots WHERE source=? AND snap_date < ? ORDER BY snap_date DESC LIMIT 1`
  ).get(source, latestDate)?.snap_date;

  const totalProducts = db.prepare(`SELECT COUNT(DISTINCT product_id) as c FROM snapshots WHERE source=? AND snap_date=?`).get(source, latestDate)?.c || 0;

  let hotProduct = null, coldProduct = null, priceUp = null, priceDown = null;

  if (prevDate) {
    hotProduct = db.prepare(`
      SELECT p.name, p.image_url, s.rank, (s.rank - prev.rank) as diff
      FROM snapshots s
      JOIN snapshots prev ON prev.product_id=s.product_id AND prev.source=s.source AND prev.snap_date=?
      JOIN products p ON p.id=s.product_id
      WHERE s.source=? AND s.snap_date=? AND diff < 0
      ORDER BY diff ASC LIMIT 1
    `).get(prevDate, source, latestDate);

    coldProduct = db.prepare(`
      SELECT p.name, p.image_url, s.rank, (s.rank - prev.rank) as diff
      FROM snapshots s
      JOIN snapshots prev ON prev.product_id=s.product_id AND prev.source=s.source AND prev.snap_date=?
      JOIN products p ON p.id=s.product_id
      WHERE s.source=? AND s.snap_date=? AND diff > 0
      ORDER BY diff DESC LIMIT 1
    `).get(prevDate, source, latestDate);

    priceUp = db.prepare(`
      SELECT p.name, s.price, prev.price as prev_price, (s.price - prev.price) as price_diff
      FROM snapshots s
      JOIN snapshots prev ON prev.product_id=s.product_id AND prev.source=s.source AND prev.snap_date=?
      JOIN products p ON p.id=s.product_id
      WHERE s.source=? AND s.snap_date=? AND s.price IS NOT NULL AND prev.price IS NOT NULL AND price_diff > 0
      ORDER BY price_diff DESC LIMIT 1
    `).get(prevDate, source, latestDate);

    priceDown = db.prepare(`
      SELECT p.name, s.price, prev.price as prev_price, (s.price - prev.price) as price_diff
      FROM snapshots s
      JOIN snapshots prev ON prev.product_id=s.product_id AND prev.source=s.source AND prev.snap_date=?
      JOIN products p ON p.id=s.product_id
      WHERE s.source=? AND s.snap_date=? AND s.price IS NOT NULL AND prev.price IS NOT NULL AND price_diff < 0
      ORDER BY price_diff ASC LIMIT 1
    `).get(prevDate, source, latestDate);
  }

  return { totalProducts, hotProduct, coldProduct, priceUp, priceDown, latestDate };
}

function getHotProducts(source = 'week', limit = 10) {
  const latestDate = db.prepare(`SELECT snap_date FROM snapshots WHERE source=? ORDER BY snap_date DESC LIMIT 1`).get(source)?.snap_date;
  const prevDate   = db.prepare(`SELECT snap_date FROM snapshots WHERE source=? AND snap_date < ? ORDER BY snap_date DESC LIMIT 1`).get(source, latestDate)?.snap_date;
  if (!latestDate || !prevDate) return [];
  return db.prepare(`
    SELECT p.name, p.brand, p.image_url, p.url, s.rank, prev.rank as prev_rank, (prev.rank - s.rank) as gain
    FROM snapshots s
    JOIN snapshots prev ON prev.product_id=s.product_id AND prev.source=s.source AND prev.snap_date=?
    JOIN products p ON p.id=s.product_id
    WHERE s.source=? AND s.snap_date=? AND gain > 0
    ORDER BY gain DESC LIMIT ?
  `).all(prevDate, source, latestDate, limit);
}

function getColdProducts(source = 'week', limit = 10) {
  const latestDate = db.prepare(`SELECT snap_date FROM snapshots WHERE source=? ORDER BY snap_date DESC LIMIT 1`).get(source)?.snap_date;
  const prevDate   = db.prepare(`SELECT snap_date FROM snapshots WHERE source=? AND snap_date < ? ORDER BY snap_date DESC LIMIT 1`).get(source, latestDate)?.snap_date;
  if (!latestDate || !prevDate) return [];
  return db.prepare(`
    SELECT p.name, p.brand, p.image_url, p.url, s.rank, prev.rank as prev_rank, (s.rank - prev.rank) as loss
    FROM snapshots s
    JOIN snapshots prev ON prev.product_id=s.product_id AND prev.source=s.source AND prev.snap_date=?
    JOIN products p ON p.id=s.product_id
    WHERE s.source=? AND s.snap_date=? AND loss > 0
    ORDER BY loss DESC LIMIT ?
  `).all(prevDate, source, latestDate, limit);
}

function getNewEntrants(source = 'week', limit = 20) {
  const latestDate = db.prepare(`SELECT snap_date FROM snapshots WHERE source=? ORDER BY snap_date DESC LIMIT 1`).get(source)?.snap_date;
  if (!latestDate) return [];
  return db.prepare(`
    SELECT p.name, p.brand, p.image_url, p.url, s.rank
    FROM snapshots s
    JOIN products p ON p.id=s.product_id
    WHERE s.source=? AND s.snap_date=?
      AND NOT EXISTS (
        SELECT 1 FROM snapshots s2
        WHERE s2.product_id=s.product_id AND s2.source=s.source AND s2.snap_date < ?
      )
    ORDER BY s.rank ASC LIMIT ?
  `).all(source, latestDate, latestDate, limit);
}

function getLegends(source = 'week', limit = 10) {
  return db.prepare(`
    SELECT p.name, p.brand, p.image_url, p.url, COUNT(*) as days_in_top50,
           MIN(s.rank) as best_rank
    FROM snapshots s JOIN products p ON p.id=s.product_id
    WHERE s.source=? AND s.rank <= 50
    GROUP BY s.product_id
    ORDER BY days_in_top50 DESC LIMIT ?
  `).all(source, limit);
}

function getCategoryStats(source = 'week') {
  const latestDate = db.prepare(`SELECT snap_date FROM snapshots WHERE source=? ORDER BY snap_date DESC LIMIT 1`).get(source)?.snap_date;
  if (!latestDate) return [];
  return db.prepare(`
    SELECT p.category, COUNT(*) as count, AVG(s.rank) as avg_rank
    FROM snapshots s JOIN products p ON p.id=s.product_id
    WHERE s.source=? AND s.snap_date=? AND p.category IS NOT NULL
    GROUP BY p.category ORDER BY count DESC
  `).all(source, latestDate);
}

function getBrandStats(source = 'week', limit = 20) {
  const latestDate = db.prepare(`SELECT snap_date FROM snapshots WHERE source=? ORDER BY snap_date DESC LIMIT 1`).get(source)?.snap_date;
  if (!latestDate) return [];
  return db.prepare(`
    SELECT p.brand, COUNT(*) as count, AVG(s.rank) as avg_rank, MIN(s.rank) as best_rank
    FROM snapshots s JOIN products p ON p.id=s.product_id
    WHERE s.source=? AND s.snap_date=? AND p.brand IS NOT NULL
    GROUP BY p.brand ORDER BY count DESC, avg_rank ASC LIMIT ?
  `).all(source, latestDate, limit);
}

// ── cleanup قدیمی‌تر از ۳۶۵ روز ────────────────────────
function cleanup() {
  const r = db.prepare(`DELETE FROM snapshots WHERE snap_date < date('now','-365 days')`).run();
  if (r.changes) console.log(`[market-db] cleanup: ${r.changes} old snapshots removed`);
}

module.exports = {
  saveBatch, getLatestList, getProductHistory, getProductStats,
  getSummaryCards, getHotProducts, getColdProducts, getNewEntrants,
  getLegends, getCategoryStats, getBrandStats, cleanup
};
