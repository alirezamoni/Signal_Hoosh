const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'finance.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS finance_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol      TEXT NOT NULL,
    name        TEXT NOT NULL,
    price       REAL NOT NULL,
    unit        TEXT,
    change      REAL,
    change_pct  REAL,
    low         REAL,
    high        REAL,
    bubble      REAL,
    timestamp   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fin_symbol ON finance_snapshots(symbol);
  CREATE INDEX IF NOT EXISTS idx_fin_ts     ON finance_snapshots(timestamp);
`);

// ── Save a batch of snapshots ──────────────────────────
const _insert = db.prepare(
  'INSERT INTO finance_snapshots (symbol,name,price,unit,change,change_pct,low,high,bubble,timestamp) VALUES (?,?,?,?,?,?,?,?,?,?)'
);
function saveSnapshots(items) {
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      _insert.run(r.symbol, r.name, r.price, r.unit||null, r.change||null, r.change_pct||null, r.low||null, r.high||null, r.bubble||null, r.timestamp);
    }
  });
  tx(items);
}

// ── Get latest price for every symbol ──────────────────
function getLatest() {
  return db.prepare(`
    SELECT * FROM finance_snapshots
    WHERE id IN (SELECT MAX(id) FROM finance_snapshots GROUP BY symbol)
  `).all();
}

// ── Get latest for one symbol ──────────────────────────
function getLatestBySymbol(symbol) {
  return db.prepare('SELECT * FROM finance_snapshots WHERE symbol=? ORDER BY id DESC LIMIT 1').get(symbol);
}

// ── Sparkline data — last N points sampled ─────────────
function getSparkline(symbol, points = 30) {
  const rows = db.prepare(`
    SELECT price, timestamp FROM finance_snapshots
    WHERE symbol=? AND timestamp >= datetime('now','-24 hours')
    ORDER BY timestamp ASC
  `).all(symbol);
  if (!rows.length) return [];
  // sample down to ~points
  const step = Math.max(1, Math.floor(rows.length / points));
  const sampled = [];
  for (let i = 0; i < rows.length; i += step) sampled.push(rows[i]);
  if (sampled[sampled.length-1] !== rows[rows.length-1]) sampled.push(rows[rows.length-1]);
  return sampled.map(r => ({ price: r.price, time: r.timestamp }));
}

// ── Full history for charts ────────────────────────────
function getHistory(symbol, hours = 24) {
  return db.prepare(`
    SELECT * FROM finance_snapshots
    WHERE symbol=? AND timestamp >= datetime('now', ?)
    ORDER BY timestamp ASC
  `).all(symbol, `-${hours} hours`);
}

// ── Changes: daily, 3m, 6m, yearly ─────────────────────
function getChanges(symbol) {
  const latest = getLatestBySymbol(symbol);
  if (!latest) return null;

  function priceAt(hoursAgo) {
    return db.prepare(`
      SELECT price FROM finance_snapshots
      WHERE symbol=? AND timestamp <= datetime('now', ?)
      ORDER BY timestamp DESC LIMIT 1
    `).get(symbol, `-${hoursAgo} hours`);
  }

  function calc(old) {
    if (!old) return null;
    const diff = latest.price - old.price;
    const pct = old.price ? (diff / old.price * 100) : 0;
    return { change: diff, pct };
  }

  return {
    current: latest,
    daily:      calc(priceAt(24)),
    quarterly:  calc(priceAt(24 * 90)),
    semiannual: calc(priceAt(24 * 180)),
    yearly:     calc(priceAt(24 * 365)),
  };
}

// ── Cleanup old data (keep 1 year) ──────────────────────
function cleanup() {
  const r = db.prepare(`DELETE FROM finance_snapshots WHERE timestamp < datetime('now','-365 days')`).run();
  if (r.changes) console.log(`[finance-db] cleanup: ${r.changes} old snapshots removed`);
}

module.exports = { saveSnapshots, getLatest, getLatestBySymbol, getSparkline, getHistory, getChanges, cleanup };
