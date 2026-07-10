/**
 * job-db.js — SQLite برای مارکت کار ایران
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'jobs.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS job_snapshots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source     TEXT NOT NULL,
    category   TEXT NOT NULL DEFAULT 'total',
    count      INTEGER NOT NULL,
    snap_date  TEXT NOT NULL,
    UNIQUE(source, category, snap_date)
  );
  CREATE INDEX IF NOT EXISTS idx_job_date     ON job_snapshots(snap_date);
  CREATE INDEX IF NOT EXISTS idx_job_source   ON job_snapshots(source, category);
`);

function saveSnapshot(source, category, count, date) {
  db.prepare(`INSERT OR REPLACE INTO job_snapshots (source,category,count,snap_date) VALUES (?,?,?,?)`)
    .run(source, category, count, date);
}

const saveBatch = db.transaction((items, date) => {
  for (const item of items) saveSnapshot(item.source, item.category, item.count, date);
});

function getLatest(source, category = 'total') {
  return db.prepare(`SELECT count, snap_date FROM job_snapshots WHERE source=? AND category=? ORDER BY snap_date DESC LIMIT 1`).get(source, category);
}

function getHistory(source, category = 'total', days = 30) {
  return db.prepare(`
    SELECT count, snap_date FROM job_snapshots
    WHERE source=? AND category=? AND snap_date >= date('now',?)
    ORDER BY snap_date ASC
  `).all(source, category, `-${days} days`);
}

function getSummary(date) {
  // اگه date نداشتیم آخرین روز رو بگیر
  const lastDate = date || db.prepare(`SELECT snap_date FROM job_snapshots ORDER BY snap_date DESC LIMIT 1`).get()?.snap_date;
  if (!lastDate) return null;

  const rows = db.prepare(`SELECT source, category, count FROM job_snapshots WHERE snap_date=?`).all(lastDate);

  // تاریخ‌های مقایسه
  const yesterday = db.prepare(`SELECT snap_date FROM job_snapshots WHERE snap_date < ? ORDER BY snap_date DESC LIMIT 1`).get(lastDate)?.snap_date;
  const week7ago  = db.prepare(`SELECT snap_date FROM job_snapshots WHERE snap_date <= date(?,' -7 days') ORDER BY snap_date DESC LIMIT 1`).get(lastDate)?.snap_date;
  const month30ago = db.prepare(`SELECT snap_date FROM job_snapshots WHERE snap_date <= date(?,' -30 days') ORDER BY snap_date DESC LIMIT 1`).get(lastDate)?.snap_date;

  function getCount(src, cat, d) {
    if (!d) return null;
    return db.prepare(`SELECT count FROM job_snapshots WHERE source=? AND category=? AND snap_date=?`).get(src, cat, d)?.count || null;
  }

  function pct(curr, prev) {
    if (!curr || !prev) return null;
    return Math.round((curr - prev) / prev * 100);
  }

  const result = { date: lastDate, sources: {}, categories: {} };

  // کل هر source
  ['jobinja', 'jobvision'].forEach(src => {
    const curr = rows.find(r => r.source === src && r.category === 'total')?.count;
    result.sources[src] = {
      count: curr,
      vs_yesterday: pct(curr, getCount(src, 'total', yesterday)),
      vs_week:      pct(curr, getCount(src, 'total', week7ago)),
      vs_month:     pct(curr, getCount(src, 'total', month30ago)),
    };
  });

  // مجموع
  const totalCurr = (result.sources.jobinja?.count||0) + (result.sources.jobvision?.count||0);
  const totalYest = (getCount('jobinja','total',yesterday)||0) + (getCount('jobvision','total',yesterday)||0);
  const totalWeek = (getCount('jobinja','total',week7ago)||0) + (getCount('jobvision','total',week7ago)||0);
  const totalMonth = (getCount('jobinja','total',month30ago)||0) + (getCount('jobvision','total',month30ago)||0);
  result.total = {
    count: totalCurr,
    vs_yesterday: pct(totalCurr, totalYest||null),
    vs_week:      pct(totalCurr, totalWeek||null),
    vs_month:     pct(totalCurr, totalMonth||null),
  };

  // EHI — نسبت به میانگین ۳۰ روز
  const avg30 = db.prepare(`
    SELECT AVG(count) as avg FROM job_snapshots
    WHERE source='jobvision' AND category='total' AND snap_date >= date(?,' -30 days')
  `).get(lastDate)?.avg;
  result.ehi = avg30 && totalCurr ? Math.round((totalCurr / (avg30 * 2)) * 100) : null;

  // دسته‌بندی‌ها
  const cats = ['human-resources','accounting','developer','data-science','digital-marketing','driver','civil'];
  cats.forEach(cat => {
    const curr = rows.find(r => r.source === 'jobvision' && r.category === cat)?.count;
    const prev7 = getCount('jobvision', cat, week7ago);
    const prev30 = getCount('jobvision', cat, month30ago);
    result.categories[cat] = {
      count: curr,
      vs_week:  pct(curr, prev7),
      vs_month: pct(curr, prev30),
      share: totalCurr ? Math.round((curr||0) / totalCurr * 100 * 10) / 10 : 0,
    };
  });

  return result;
}

function getCategoryHistory(category, days = 30) {
  return db.prepare(`
    SELECT count, snap_date FROM job_snapshots
    WHERE source='jobvision' AND category=? AND snap_date >= date('now',?)
    ORDER BY snap_date ASC
  `).all(category, `-${days} days`);
}

function getTotalHistory(days = 30) {
  return db.prepare(`
    SELECT snap_date,
      SUM(CASE WHEN category='total' THEN count ELSE 0 END) as total,
      MAX(CASE WHEN source='jobinja' AND category='total' THEN count END) as jobinja,
      MAX(CASE WHEN source='jobvision' AND category='total' THEN count END) as jobvision
    FROM job_snapshots
    WHERE category='total' AND snap_date >= date('now',?)
    GROUP BY snap_date ORDER BY snap_date ASC
  `).all(`-${days} days`);
}

function cleanup() {
  const r = db.prepare(`DELETE FROM job_snapshots WHERE snap_date < date('now','-365 days')`).run();
  if (r.changes) console.log(`[job-db] cleanup: ${r.changes} old rows removed`);
}

module.exports = { saveBatch, saveSnapshot, getLatest, getHistory, getSummary, getCategoryHistory, getTotalHistory, cleanup };
