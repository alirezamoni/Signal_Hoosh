/**
 * scripts/backfill-trends.js — یک‌بار اجرا می‌شود.
 *
 * trends.db از امروز شروع به پر شدن می‌کند، ولی موتور تایم‌لاین از قبل رویدادهای
 * `trend_spike` را در timeline.db ذخیره کرده (کلیدواژه + حجم + رشد + زمان).
 * این اسکریپت آن‌ها را به trend_snapshots منتقل می‌کند تا فیچر «از روز اول تا الان»
 * از همان ابتدا داده داشته باشد.
 *
 * اجرای دوباره‌اش بی‌ضرر است (INSERT OR IGNORE روی UNIQUE).
 */
const path = require('path');
const Database = require('better-sqlite3');
const trendDB = require('../trend-db');
const { categorizeKeyword } = require('../lib/categorize');

const timelinePath = path.join(__dirname, '..', 'data', 'timeline.db');
const tl = new Database(timelinePath, { readonly: true });

const rows = tl.prepare(`
  SELECT topic, magnitude, data, detected_at
  FROM timeline_events
  WHERE event_type = 'trend_spike' AND topic IS NOT NULL AND topic != ''
  ORDER BY detected_at ASC
`).all();

console.log(`[backfill] ${rows.length} trend_spike event(s) found in timeline.db`);

let inserted = 0, categorized = 0;
for (const r of rows) {
  let vol = 0, growth = Number(r.magnitude) || 0, cat = null;
  try {
    const d = JSON.parse(r.data || '{}');
    vol = Number(d.vol) || 0;
    growth = Number(d.growth) || growth;
    cat = d.cat || null;
  } catch (e) { /* data ممکن است ناقص باشد */ }

  if (!cat) {
    cat = trendDB.getCachedCat(r.topic) || categorizeKeyword(r.topic);
    if (cat) { trendDB.setCachedCat(r.topic, cat, 'rule'); categorized++; }
  }

  // این رویدادها از پنجره ۴ ساعته می‌آیند (detectTrendSpike روی h4.json کار می‌کند)
  trendDB.saveSnapshot(
    [{ keyword: r.topic, rank: null, vol, growth, cat, active: 1 }],
    '4h',
    r.detected_at
  );
  inserted++;
}

console.log(`[backfill] ${inserted} snapshot(s) written, ${categorized} categorized by rules`);
console.log('[backfill] stats now:', JSON.stringify(trendDB.getStats()));
