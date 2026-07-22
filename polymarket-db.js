/**
 * polymarket-db.js — SQLite برای بازارهای Polymarket (ایران)
 * الگوی market-db: markets (اطلاعات ثابت) + market_ranks (رتبه به ازای sort)
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'polymarket.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS markets (
    poly_id       TEXT PRIMARY KEY,
    slug          TEXT,
    title         TEXT,
    title_fa      TEXT,
    description_fa TEXT,
    image         TEXT,
    icon          TEXT,
    url           TEXT,
    tags_json     TEXT,
    category      TEXT,
    category_fa   TEXT,
    volume        REAL,
    volume24hr    REAL,
    liquidity     REAL,
    comment_count INTEGER,
    price         REAL,
    price_label   TEXT,
    end_date      TEXT,
    updated_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS market_ranks (
    sort        TEXT NOT NULL,
    poly_id     TEXT NOT NULL,
    rank        INTEGER NOT NULL,
    volume      REAL,
    volume24hr  REAL,
    comment_count INTEGER,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (sort, poly_id),
    FOREIGN KEY (poly_id) REFERENCES markets(poly_id)
  );

  CREATE TABLE IF NOT EXISTS crawl_meta (
    sort          TEXT PRIMARY KEY,
    last_fetched  TEXT,
    count         INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_ranks_sort  ON market_ranks(sort, rank);
`);

// migration: ستون‌های جدید را اگه نبود اضافه کن
const cols = db.prepare("PRAGMA table_info(markets)").all().map(c => c.name);
  for (const col of ['price','price_label']) {
    if (!cols.includes(col)) {
      const tp = col === 'price_label' ? 'TEXT' : 'REAL';
      db.exec(`ALTER TABLE markets ADD COLUMN ${col} ${tp}`);
    }
  }

// ── upsert اطلاعات ثابت بازار ───────────────────────────
function upsertMarket(m) {
  db.prepare(`
    INSERT INTO markets (poly_id, slug, title, title_fa, description_fa, image, icon, url,
                         tags_json, category, category_fa, volume, volume24hr, liquidity,
                         comment_count, price, price_label, end_date, updated_at)
    VALUES (@poly_id,@slug,@title,@title_fa,@description_fa,@image,@icon,@url,
            @tags_json,@category,@category_fa,@volume,@volume24hr,@liquidity,
            @comment_count,@price,@price_label,@end_date,@updated_at)
    ON CONFLICT(poly_id) DO UPDATE SET
      slug=excluded.slug, title=excluded.title, image=excluded.image, icon=excluded.icon,
      url=excluded.url, tags_json=excluded.tags_json, category=excluded.category,
      volume=excluded.volume, volume24hr=excluded.volume24hr, liquidity=excluded.liquidity,
      comment_count=excluded.comment_count, end_date=excluded.end_date, updated_at=excluded.updated_at,
      price=excluded.price, price_label=excluded.price_label,
      title_fa=COALESCE(excluded.title_fa, markets.title_fa),
      category_fa=COALESCE(excluded.category_fa, markets.category_fa),
      description_fa=COALESCE(excluded.description_fa, markets.description_fa)
  `).run(m);
}

// ── جایگزینی رتبه‌های یک sort ─────────────────────────────
function replaceRanks(sort, rows, fetchedAt) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM market_ranks WHERE sort=?').run(sort);
    const ins = db.prepare(`INSERT INTO market_ranks (sort,poly_id,rank,volume,volume24hr,comment_count,fetched_at)
                            VALUES (?,?,?,?,?,?,?)`);
    for (const r of rows) ins.run(sort, r.poly_id, r.rank, r.volume, r.volume24hr, r.comment_count, fetchedAt);
    db.prepare('INSERT OR REPLACE INTO crawl_meta (sort,last_fetched,count) VALUES (?,?,?)')
      .run(sort, fetchedAt, rows.length);
  });
  tx();
}

// ── لیست مرتب برای یک sort ───────────────────────────────
function getSortedList(sort, limit = 50) {
  return db.prepare(`
    SELECT m.poly_id, m.slug, m.title, m.title_fa, m.image, m.icon, m.url,
           m.category, m.category_fa, m.tags_json, m.volume, m.volume24hr,
           m.liquidity, m.comment_count, m.price, m.price_label, m.end_date,
           r.rank, r.volume AS rank_volume, r.volume24hr AS rank_volume24hr,
           r.comment_count AS rank_comment_count,
           (SELECT last_fetched FROM crawl_meta WHERE sort=?) AS fetched_at
    FROM market_ranks r
    JOIN markets m ON m.poly_id = r.poly_id
    WHERE r.sort = ?
    ORDER BY r.rank ASC
    LIMIT ?
  `).all(sort, sort, limit);
}

function getStatus() {
  const rows = db.prepare('SELECT sort, last_fetched, count FROM crawl_meta').all();
  const out = {};
  for (const r of rows) out[r.sort] = { last_fetched: r.last_fetched, count: r.count };
  return out;
}

module.exports = { upsertMarket, replaceRanks, getSortedList, getStatus };
