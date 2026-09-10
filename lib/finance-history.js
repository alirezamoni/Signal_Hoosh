/**
 * lib/finance-history.js — سری روزانه‌ی قیمت‌ها برای صفحات تاریخچه.
 *
 * چرا جدا از finance-db.js: آن فایل را کرالر مالی هم می‌نویسد و بین دو جلسه
 * مشترک است. اینجا فقط خواندن است و هیچ نوشتنی ندارد، پس جدا نگه‌داشتنش
 * سطح برخورد را کم می‌کند.
 *
 * ⚠️ «روز» یعنی روزِ تهران، نه UTC. کسی که «قیمت دلار ۲۵ مرداد» را جست‌وجو
 * می‌کند منظورش روز تقویمی ایران است؛ با گروه‌بندی UTC، معامله‌های ۲۰:۳۰ تا
 * ۲۴:۰۰ به روز بعد می‌افتند. timestamp به‌صورت ISO با Z ذخیره شده، پس
 * substr(...,1,19) آن را به شکل ساده‌ی بدون منطقه می‌آورد و بعد +۳:۳۰
 * اضافه می‌شود.
 */
const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'data', 'finance.db'), { readonly: true });

const TEH_DAY = "date(datetime(substr(timestamp,1,19),'+3 hours','+30 minutes'))";
const TEH_HOUR = "strftime('%H', datetime(substr(timestamp,1,19),'+3 hours','+30 minutes'))";

// سری روزها فقط وقتی عوض می‌شود که روز عوض شود؛ اسکن ۳۸ هزار ردیف در هر
// بازدید بی‌دلیل است.
const _cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v;
  const v = fn();
  _cache.set(key, { at: Date.now(), v });
  if (_cache.size > 200) _cache.clear();
  return v;
}

/** نمادهای موجود، با تازه‌ترین قیمتشان. */
function symbols() {
  return cached('symbols', 60000, () => db.prepare(`
    SELECT s.symbol, s.name, s.unit, s.price, s.change_pct, s.timestamp
    FROM finance_snapshots s
    JOIN (SELECT symbol, MAX(id) AS mid FROM finance_snapshots GROUP BY symbol) t
      ON t.mid = s.id
    ORDER BY s.symbol
  `).all());
}

function symbolInfo(symbol) {
  return symbols().find(s => s.symbol === symbol) || null;
}

/** اولین و آخرین روزِ تهرانی که برای این نماد داده داریم. */
function range(symbol) {
  return cached('range:' + symbol, 300000, () => db.prepare(`
    SELECT MIN(${TEH_DAY}) AS first, MAX(${TEH_DAY}) AS last
    FROM finance_snapshots WHERE symbol = ?
  `).get(symbol) || { first: null, last: null });
}

/**
 * خلاصه‌ی هر روز: اولین، آخرین، کف و سقف.
 *
 * ROW_NUMBER دو طرفه به‌جای زیرپرس‌وجوی همبسته استفاده می‌شود — روی ۳۸ هزار
 * ردیف، زیرپرس‌وجو برای هر روز یک اسکن جدا می‌زد.
 */
function dailySeries(symbol, limit = 90) {
  return cached('daily:' + symbol + ':' + limit, 300000, () => db.prepare(`
    WITH d AS (
      SELECT price, timestamp, ${TEH_DAY} AS day
      FROM finance_snapshots WHERE symbol = ?
    ),
    r AS (
      SELECT day, price,
             ROW_NUMBER() OVER (PARTITION BY day ORDER BY timestamp ASC)  AS ra,
             ROW_NUMBER() OVER (PARTITION BY day ORDER BY timestamp DESC) AS rd
      FROM d
    )
    SELECT day,
           MIN(price) AS low,
           MAX(price) AS high,
           COUNT(*)   AS n,
           MAX(CASE WHEN ra = 1 THEN price END) AS open,
           MAX(CASE WHEN rd = 1 THEN price END) AS close
    FROM r
    GROUP BY day
    ORDER BY day DESC
    LIMIT ?
  `).all(symbol, limit));
}

/** یک روز مشخص: خلاصه + نمونه‌ی ساعتی. اگر داده نبود null. */
function day(symbol, date) {
  return cached('day:' + symbol + ':' + date, 300000, () => {
    const sum = db.prepare(`
      WITH d AS (
        SELECT price, timestamp FROM finance_snapshots
        WHERE symbol = ? AND ${TEH_DAY} = ?
      ),
      r AS (
        SELECT price,
               ROW_NUMBER() OVER (ORDER BY timestamp ASC)  AS ra,
               ROW_NUMBER() OVER (ORDER BY timestamp DESC) AS rd
        FROM d
      )
      SELECT MIN(price) AS low, MAX(price) AS high, COUNT(*) AS n,
             MAX(CASE WHEN ra = 1 THEN price END) AS open,
             MAX(CASE WHEN rd = 1 THEN price END) AS close
      FROM r
    `).get(symbol, date);

    if (!sum || !sum.n) return null;

    const hourly = db.prepare(`
      SELECT ${TEH_HOUR} AS hour, AVG(price) AS price, MIN(price) AS low, MAX(price) AS high
      FROM finance_snapshots
      WHERE symbol = ? AND ${TEH_DAY} = ?
      GROUP BY hour ORDER BY hour ASC
    `).all(symbol, date);

    return Object.assign({ day: date, hourly }, sum);
  });
}

/** روز قبل و بعدی که واقعاً داده دارند — برای پیمایش و پیوند داخلی. */
function neighbours(symbol, date) {
  const prev = db.prepare(`
    SELECT ${TEH_DAY} AS day FROM finance_snapshots
    WHERE symbol = ? AND ${TEH_DAY} < ? ORDER BY timestamp DESC LIMIT 1
  `).get(symbol, date);
  const next = db.prepare(`
    SELECT ${TEH_DAY} AS day FROM finance_snapshots
    WHERE symbol = ? AND ${TEH_DAY} > ? ORDER BY timestamp ASC LIMIT 1
  `).get(symbol, date);
  return { prev: prev ? prev.day : null, next: next ? next.day : null };
}

module.exports = { symbols, symbolInfo, range, dailySeries, day, neighbours, _db: db };
