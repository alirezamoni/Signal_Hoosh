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
    high         REAL,
    bubble      REAL,
    timestamp   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fin_symbol ON finance_snapshots(symbol);
  CREATE INDEX IF NOT EXISTS idx_fin_ts     ON finance_snapshots(timestamp);

  CREATE TABLE IF NOT EXISTS finance_channels (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id              TEXT UNIQUE NOT NULL,
    username           TEXT,
    title              TEXT,
    category           TEXT DEFAULT 'ارز دیجیتال',
    photo_url          TEXT,
    active             INTEGER DEFAULT 1,
    needs_translation  INTEGER DEFAULT 1,
    added_at           TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS finance_messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id   INTEGER NOT NULL,
    message_id   INTEGER NOT NULL,
    text         TEXT,
    text_fa      TEXT,
    lang         TEXT DEFAULT 'fa',
    media_type   TEXT,
    media_url    TEXT,
    tg_link      TEXT,
    published_at TEXT NOT NULL,
    created_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(channel_id, message_id),
    FOREIGN KEY(channel_id) REFERENCES finance_channels(id)
  );
  CREATE INDEX IF NOT EXISTS idx_fmsg_channel ON finance_messages(channel_id);
  CREATE INDEX IF NOT EXISTS idx_fmsg_pub     ON finance_messages(published_at);
`);

// ── Save a batch of snapshots ──────────────────────────
const _insert = db.prepare(
  'INSERT INTO finance_snapshots (symbol,name,price,unit,change,change_pct,low,high,bubble,timestamp) VALUES (?,?,?,?,?,?,?,?,?,?)'
);
function saveSnapshots(items) {
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      _insert.run(r.symbol, r.name, r.price, r.unit ?? null, r.change ?? null, r.change_pct ?? null, r.low ?? null, r.high ?? null, r.bubble ?? null, r.timestamp);
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

// ══════════════════════════════════════
//  FINANCE CHANNELS
// ══════════════════════════════════════

const _upsertCh = db.prepare(
  'INSERT INTO finance_channels (tg_id,username,title,category,photo_url,needs_translation) VALUES (?,?,?,?,?,?) ON CONFLICT(tg_id) DO UPDATE SET username=COALESCE(excluded.username,username), title=COALESCE(excluded.title,title), category=COALESCE(excluded.category,category), photo_url=COALESCE(excluded.photo_url,photo_url), needs_translation=COALESCE(excluded.needs_translation,needs_translation) RETURNING id'
);
function upsertFinanceChannel(tg_id, username, title, category, photo_url, needs_translation) {
  const nt = needs_translation !== undefined ? (needs_translation ? 1 : 0) : 1;
  const row = _upsertCh.get(String(tg_id), username||null, title||tg_id, category||'ارز دیجیتال', photo_url||null, nt);
  return row ? row.id : null;
}

function updateFinanceChannel(id, data) {
  const cur = db.prepare('SELECT * FROM finance_channels WHERE id=?').get(id);
  if (!cur) return;
  db.prepare(`UPDATE finance_channels SET username=?, title=?, category=?, photo_url=?, needs_translation=? WHERE id=?`).run(
    data.username ?? cur.username,
    data.title ?? cur.title,
    data.category ?? cur.category,
    data.photo_url ?? cur.photo_url,
    data.needs_translation !== undefined ? (data.needs_translation ? 1 : 0) : cur.needs_translation,
    id
  );
}

function deleteFinanceChannel(id) {
  db.prepare('UPDATE finance_channels SET active=0 WHERE id=?').run(id);
}

function getFinanceChannels() {
  return db.prepare('SELECT * FROM finance_channels WHERE active=1 ORDER BY title').all();
}

function getFinanceChannelByTgId(tg_id) {
  return db.prepare('SELECT * FROM finance_channels WHERE tg_id=? AND active=1').get(String(tg_id));
}

// ══════════════════════════════════════
//  FINANCE MESSAGES
// ══════════════════════════════════════

const _insertMsg = db.prepare(
  'INSERT OR IGNORE INTO finance_messages (channel_id,message_id,text,text_fa,lang,media_type,media_url,tg_link,published_at) VALUES (?,?,?,?,?,?,?,?,?)'
);
function saveFinanceMessage(item) {
  _insertMsg.run(
    item.channel_id, item.message_id, item.text||null, item.text_fa||null,
    item.lang||'fa', item.media_type||null, item.media_url||null,
    item.tg_link||null, item.published_at
  );
}

function deleteFinanceMessage(id) {
  db.prepare('DELETE FROM finance_messages WHERE id=?').run(id);
}

function getLatestFinanceMessages(limit = 20, channel_id = null, offset = 0, since = 0) {
  const params = [];
  let sql = `SELECT m.*, c.title AS channel_title, c.username AS channel_username, c.photo_url AS channel_photo
    FROM finance_messages m JOIN finance_channels c ON c.id = m.channel_id WHERE c.active=1`;
  if (channel_id) { sql += ' AND m.channel_id=?'; params.push(channel_id); }
  if (since)      { sql += ' AND m.id > ?'; params.push(since); }
  sql += ' ORDER BY m.id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

module.exports = {
  saveSnapshots, getLatest, getLatestBySymbol, getSparkline, getHistory, getChanges, cleanup,
  upsertFinanceChannel, updateFinanceChannel, deleteFinanceChannel, getFinanceChannels, getFinanceChannelByTgId,
  saveFinanceMessage, deleteFinanceMessage, getLatestFinanceMessages,
};
