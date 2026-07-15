/**
 * news-db.js — SQLite برای اخبار تلگرام
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'news.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id        TEXT UNIQUE NOT NULL,
    username     TEXT,
    title        TEXT,
    category     TEXT DEFAULT 'خبرگزاری‌ها',
    photo_url    TEXT,
    active       INTEGER DEFAULT 1,
    added_at     TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS news (
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
    FOREIGN KEY(channel_id) REFERENCES channels(id)
  );

  CREATE TABLE IF NOT EXISTS news_digest (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    text         TEXT NOT NULL,
    period_start TEXT,
    period_end   TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_news_published ON news(published_at DESC);
  CREATE INDEX IF NOT EXISTS idx_news_channel   ON news(channel_id);
`);

// ── Channels ──────────────────────────────────────────────
function upsertChannel(tg_id, username, title, category, photo_url) {
  // چک با tg_id
  let existing = db.prepare('SELECT id FROM channels WHERE tg_id=?').get(tg_id);
  // اگه نبود، با username چک کن
  if (!existing && username) {
    existing = db.prepare('SELECT id FROM channels WHERE username=?').get(username);
  }
  if (existing) {
    db.prepare('UPDATE channels SET tg_id=?,username=?,title=?,category=?,photo_url=?,active=1 WHERE id=?')
      .run(tg_id, username, title, category||'خبرگزاری‌ها', photo_url||null, existing.id);
    return existing.id;
  }
  const r = db.prepare('INSERT INTO channels (tg_id,username,title,category,photo_url,active) VALUES (?,?,?,?,?,1)')
    .run(tg_id, username, title, category||'خبرگزاری‌ها', photo_url||null);
  return r.lastInsertRowid;
}

function updateChannel(id, data) {
  db.prepare('UPDATE channels SET username=?,title=?,category=?,photo_url=? WHERE id=?')
    .run(data.username, data.title, data.category, data.photo_url||null, id);
}

function deleteChannel(id) {
  db.prepare('UPDATE channels SET active=0 WHERE id=?').run(id);
}

function getChannels() {
  return db.prepare('SELECT * FROM channels WHERE active=1 ORDER BY title').all();
}

function getChannelByTgId(tg_id) {
  // اول با tg_id عددی چک کن
  let ch = db.prepare('SELECT * FROM channels WHERE tg_id=? AND active=1').get(tg_id);
  if (ch) return ch;
  // بعد با username چک کن
  const username = tg_id.startsWith('@') ? tg_id : null;
  if (username) ch = db.prepare('SELECT * FROM channels WHERE username=? AND active=1').get(username);
  return ch || null;
}

// ── News ─────────────────────────────────────────────────
function saveNews(item) {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO news (channel_id,message_id,text,text_fa,lang,media_type,media_url,tg_link,published_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(item.channel_id, item.message_id, item.text, item.text_fa||null, item.lang||'fa',
           item.media_type||null, item.media_url||null, item.tg_link||null, item.published_at);
    return true;
  } catch(e) { return false; }
}

function getLatestNews(limit=20, channel_id=null, offset=0) {
  if (channel_id) {
    return db.prepare(`
      SELECT n.*, c.title as channel_title, c.username as channel_username, c.photo_url as channel_photo
      FROM news n JOIN channels c ON c.id=n.channel_id
      WHERE n.channel_id=? ORDER BY n.published_at DESC LIMIT ? OFFSET ?
    `).all(channel_id, limit, offset);
  }
  return db.prepare(`
    SELECT n.*, c.title as channel_title, c.username as channel_username, c.photo_url as channel_photo
    FROM news n JOIN channels c ON c.id=n.channel_id
    ORDER BY n.published_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
}

function getNewsSince(since_minutes=240) {
  return db.prepare(`
    SELECT n.*, c.title as channel_title
    FROM news n JOIN channels c ON c.id=n.channel_id
    WHERE n.published_at >= datetime('now',?)
    ORDER BY n.published_at DESC
  `).all(`-${since_minutes} minutes`);
}

// ── Digest ───────────────────────────────────────────────
function saveDigest(text, period_start, period_end) {
  db.prepare('INSERT INTO news_digest (text,period_start,period_end) VALUES (?,?,?)').run(text, period_start, period_end);
}

function getLatestDigest() {
  return db.prepare('SELECT * FROM news_digest ORDER BY created_at DESC LIMIT 1').get();
}

// ── آمار اخبار ──────────────────────────────────────────
function getNewsStats() {
  const totalNews = db.prepare('SELECT COUNT(*) as c FROM news').get()?.c || 0;
  const totalChannels = db.prepare('SELECT COUNT(*) as c FROM channels WHERE active=1').get()?.c || 0;

  // اخبار امروز
  const todayNews = db.prepare(`SELECT COUNT(*) as c FROM news WHERE published_at >= datetime('now','-24 hours')`).get()?.c || 0;

  // اخبار این هفته
  const weekNews = db.prepare(`SELECT COUNT(*) as c FROM news WHERE published_at >= datetime('now','-7 days')`).get()?.c || 0;

  // فعال‌ترین کانال‌ها (top 5)
  const topChannels = db.prepare(`
    SELECT c.title, c.category, COUNT(n.id) as news_count
    FROM news n JOIN channels c ON c.id = n.channel_id
    WHERE n.published_at >= datetime('now','-7 days')
    GROUP BY n.channel_id
    ORDER BY news_count DESC LIMIT 5
  `).all();

  // تعداد اخبار هر دسته (7 روز اخیر)
  const categoryStats = db.prepare(`
    SELECT c.category, COUNT(n.id) as count
    FROM news n JOIN channels c ON c.id = n.channel_id
    WHERE n.published_at >= datetime('now','-7 days') AND c.category IS NOT NULL
    GROUP BY c.category
    ORDER BY count DESC
  `).all();

  // آمار روزانه (۱۴ روز اخیر)
  const dailyStats = db.prepare(`
    SELECT date(n.published_at) as day, COUNT(*) as count
    FROM news n
    WHERE n.published_at >= datetime('now','-14 days')
    GROUP BY day
    ORDER BY day ASC
  `).all();

  // توزیع زبانی (7 روز اخیر)
  const langStats = db.prepare(`
    SELECT lang, COUNT(*) as count
    FROM news
    WHERE published_at >= datetime('now','-7 days')
    GROUP BY lang ORDER BY count DESC
  `).all();

  // میانگین اخبار روزانه (۳۰ روز اخیر)
  const avgDaily = db.prepare(`
    SELECT AVG(cnt) as avg FROM (
      SELECT COUNT(*) as cnt FROM news
      WHERE published_at >= datetime('now','-30 days')
      GROUP BY date(published_at)
    )
  `).get()?.avg || 0;

  // ساعات شلوغ (7 روز اخیر)
  const hourlyStats = db.prepare(`
    SELECT CAST(strftime('%H', published_at) AS INTEGER) as hour, COUNT(*) as count
    FROM news
    WHERE published_at >= datetime('now','-7 days')
    GROUP BY hour ORDER BY hour ASC
  `).all();

  return {
    totalNews,
    totalChannels,
    todayNews,
    weekNews,
    avgDaily: Math.round(avgDaily),
    topChannels,
    categoryStats,
    dailyStats,
    langStats,
    hourlyStats,
  };
}

// ── Cleanup ──────────────────────────────────────────────
function cleanup() {
  // فقط ۳۰ روز نگه دار
  const r = db.prepare(`DELETE FROM news WHERE published_at < datetime('now','-30 days')`).run();
  if (r.changes) console.log(`[news-db] cleanup: ${r.changes} old news removed`);
  db.prepare(`DELETE FROM news_digest WHERE created_at < datetime('now','-7 days')`).run();
}

function deleteNews(id) {
  db.prepare('DELETE FROM news WHERE id=?').run(id);
}

module.exports = { upsertChannel, updateChannel, deleteChannel, getChannels, getChannelByTgId, saveNews, deleteNews, getLatestNews, getNewsSince, saveDigest, getLatestDigest, getNewsStats, cleanup };
