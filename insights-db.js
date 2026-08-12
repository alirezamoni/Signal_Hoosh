/**
 * insights-db.js — نتایج تحلیل‌های بین‌ماژولی
 *
 * جدا از timeline.db نگه داشته می‌شود: آن دیتابیس موتور پیش‌بینی است و
 * تحلیل‌های اینجا ورودی‌شان کل سایت است، نه فقط رویدادهای تایم‌لاین.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, 'data', 'insights.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS daily_brief (
    day        TEXT PRIMARY KEY,        -- YYYY-MM-DD
    text_fa    TEXT NOT NULL,
    facts_json TEXT,                    -- اعدادی که متن از رویشان نوشته شده
    source     TEXT,                    -- ai | template
    model      TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS lead_lag (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    x_key       TEXT NOT NULL,          -- سری پیشرو
    x_label     TEXT,
    y_key       TEXT NOT NULL,          -- سری دنباله‌رو
    y_label     TEXT,
    lag_days    INTEGER NOT NULL,
    corr        REAL,                   -- پیرسون روی تغییرات روزانه
    hit_rate    REAL,                   -- نسبت دفعاتی که جهت درست درآمده
    n           INTEGER,                -- تعداد جفت‌مشاهده
    p_approx    REAL,                   -- تقریب p-value دوطرفه
    significant INTEGER DEFAULT 0,      -- از تصحیح آزمون چندگانه رد شده؟
    computed_at TEXT,
    UNIQUE(x_key, y_key, lag_days)
  );
  CREATE INDEX IF NOT EXISTS idx_ll ON lead_lag(hit_rate DESC, n DESC);
`);

function saveBrief(day, text_fa, facts, source, model) {
  db.prepare(`
    INSERT INTO daily_brief (day, text_fa, facts_json, source, model)
    VALUES (?,?,?,?,?)
    ON CONFLICT(day) DO UPDATE SET
      text_fa=excluded.text_fa, facts_json=excluded.facts_json,
      source=excluded.source, model=excluded.model, created_at=datetime('now')
  `).run(day, text_fa, facts ? JSON.stringify(facts) : null, source || null, model || null);
}

function latestBrief() {
  return db.prepare('SELECT * FROM daily_brief ORDER BY day DESC LIMIT 1').get() || null;
}
function briefHistory(limit) {
  return db.prepare('SELECT day, text_fa, source FROM daily_brief ORDER BY day DESC LIMIT ?').all(limit || 7);
}

function replaceLeadLag(rows) {
  const del = db.prepare('DELETE FROM lead_lag');
  const ins = db.prepare(`
    INSERT INTO lead_lag (x_key,x_label,y_key,y_label,lag_days,corr,hit_rate,n,p_approx,significant,computed_at)
    VALUES (@x_key,@x_label,@y_key,@y_label,@lag_days,@corr,@hit_rate,@n,@p_approx,@significant,@computed_at)
  `);
  db.transaction(list => { del.run(); for (const r of list) ins.run(r); })(rows);
}

/** قوی‌ترین رابطه‌ها — یک ردیف برای هر جفت، بهترین تأخیرش */
function topLeadLag(limit) {
  return db.prepare(`
    SELECT * FROM lead_lag l
    WHERE l.id = (
      SELECT id FROM lead_lag WHERE x_key=l.x_key AND y_key=l.y_key
      ORDER BY ABS(corr) DESC LIMIT 1
    )
    ORDER BY significant DESC, ABS(corr) DESC, n DESC LIMIT ?
  `).all(limit || 12);
}

function leadLagMeta() {
  return db.prepare(
    'SELECT COUNT(*) n, SUM(significant) sig, MAX(computed_at) at FROM lead_lag'
  ).get() || { n: 0, sig: 0, at: null };
}

module.exports = { db, saveBrief, latestBrief, briefHistory, replaceLeadLag, topLeadLag, leadLagMeta };
