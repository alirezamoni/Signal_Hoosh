/**
 * lib/listener-watchdog.js — نگهبان تازگیِ جریان خبر
 *
 * چرا لازم است: شنونده‌ی تلگرام می‌تواند «زنده ولی بی‌کار» بماند. در
 * ۱ سپتامبر ۲۰۲۶ دقیقاً همین شد — پروسه online بود، به تلگرام وصل بود و
 * لاگ می‌داد، ولی چون راه‌اندازی‌اش وسط دانلود عکس پروفایل کانال‌ها گیر
 * کرده بود هرگز به حلقه‌ی پیام نرسید و ۳٫۷ ساعت هیچ خبری ذخیره نشد.
 *
 * PM2 چنین چیزی را نمی‌بیند: پروسه نه کرش کرده نه حافظه ترکانده. تنها
 * نشانه‌ی قابل اتکا، خودِ داده است — اگر خبری درج نمی‌شود، یعنی خراب است،
 * فارغ از اینکه چرا.
 *
 * پس این نگهبان عمداً کلی است و به علت کاری ندارد؛ فقط تازگی را می‌سنجد.
 */
const path = require('path');
const { execFile } = require('child_process');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'news.db');
const CHECK_MS = 10 * 60 * 1000;     // هر ۱۰ دقیقه نگاه می‌کند
const SILENCE_MIN = 25;              // بیش از این سکوت = خراب
const COOLDOWN_MS = 20 * 60 * 1000;  // بین دو ری‌استارت، فرصت بالا آمدن

let lastRestartAt = 0;

/**
 * آستانه‌ی ۲۵ دقیقه از داده‌ی واقعی می‌آید: ۲۰ کانال فعال روی هم هر چند
 * دقیقه پیام دارند و در ۲۴ ساعت گذشته بلندترین سکوت طبیعی خیلی کمتر از
 * این بوده. عدد کمتر باعث ری‌استارت بی‌مورد در ساعات کم‌ترافیک بامداد
 * می‌شود.
 */
function lastNewsAt() {
  let db = null;
  try {
    db = new Database(DB_PATH, { readonly: true });
    const r = db.prepare('SELECT MAX(created_at) v FROM news').get();
    if (!r || !r.v) return null;
    // created_at به شکل «2026-09-01 20:01:57» و به وقت UTC ذخیره می‌شود
    const d = new Date(String(r.v).replace(' ', 'T') + 'Z');
    return isNaN(d) ? null : d;
  } catch (e) {
    console.warn('[watchdog] خواندن news.db ناموفق:', e.message);
    return null;
  } finally {
    if (db) { try { db.close(); } catch (e) {} }
  }
}

function restartListener(minutes) {
  lastRestartAt = Date.now();
  console.warn(`[watchdog] ${minutes} دقیقه است خبری درج نشده — ری‌استارت news-listener`);
  execFile('pm2', ['restart', 'news-listener'], { timeout: 60000 }, (err, stdout, stderr) => {
    if (err) console.error('[watchdog] ری‌استارت ناموفق:', err.message);
    else console.log('[watchdog] news-listener ری‌استارت شد');
  });
}

function check() {
  const last = lastNewsAt();
  if (!last) return;                                   // دیتابیس خوانده نشد — دخالت نکن

  const minutes = Math.round((Date.now() - last.getTime()) / 60000);
  if (minutes < SILENCE_MIN) return;

  // اگر تازه ری‌استارت کرده‌ایم، فرصت بده؛ وگرنه حلقه‌ی ری‌استارت می‌سازیم
  if (Date.now() - lastRestartAt < COOLDOWN_MS) {
    console.warn(`[watchdog] هنوز ${minutes} دقیقه سکوت، ولی ری‌استارت اخیر است — صبر`);
    return;
  }
  restartListener(minutes);
}

function start(delayMs) {
  setTimeout(() => { check(); setInterval(check, CHECK_MS); }, delayMs || 5 * 60 * 1000);
  console.log(`[watchdog] نگهبان جریان خبر فعال — سکوت بیش از ${SILENCE_MIN} دقیقه یعنی ری‌استارت`);
}

module.exports = { start, check, lastNewsAt, SILENCE_MIN };
