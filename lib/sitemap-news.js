/**
 * lib/sitemap-news.js — انتخاب و اولویت‌بندی خبرها برای سایت‌مپ
 *
 * چرا این فایل وجود دارد:
 *
 * سایت‌مپ قبلاً فقط خبرهای ≥۳۰۰ نویسه را معرفی می‌کرد. داده‌ی سرچ کنسول
 * نشان داد این معیار غلط بود: از ۱۸ صفحه‌ی پرکلیک، ۱۲ تا زیر ۳۰۰ نویسه
 * بودند — ‎/news/119743‎ با ۱۰۹ نویسه، ۳۰ کلیک و CTR ۱۵٪ در جایگاه ۲٫۷۶.
 * اینها خبر فوری‌اند و برای کوئریِ «نامِ فلانی» طول اهمیتی ندارد.
 *
 * و چون صفحه‌ی آرشیو روز فقط ۴۰ خبر نشان می‌دهد (از ~۲٬۶۰۰ خبرِ آن روز)،
 * خبری که در سایت‌مپ نباشد عملاً هیچ مسیر کشفی ندارد. یعنی آن فیلتر طول
 * معادل حذف ۴۶ هزار صفحه از ایندکس بود — با گرسنگی دادن، نه با دستور.
 *
 * ⚠️ ولی «همه را بریز داخل» هم جواب نیست: گوگل روزی ~۷۴۰ آدرس یکتای خبر
 * می‌خزد و سایت روزی ۴٬۱۶۱ خبر می‌سازد. پس ترتیب و اولویت مهم‌تر از حجم
 * است. اینجا همه معرفی می‌شوند ولی priority و changefreq به گوگل می‌گویند
 * کدام‌ها را اول بردارد.
 */
const path = require('path');
const Database = require('better-sqlite3');

const DATA = path.join(__dirname, '..', 'data');
const SHARD_SIZE = 40000;          // سقف استاندارد ۵۰٬۰۰۰ است؛ حاشیه می‌گذاریم
const TTL_MS = 30 * 60 * 1000;     // ساخت کامل چند ثانیه است، پس کش لازم است
const HOT_KEYWORDS = 60;
const FRESH_HOURS = 48;

let cache = { at: 0, shards: null, stats: null };

/** پرجستجوترین کلیدواژه‌های ۴۸ ساعت اخیر — برای اولویت‌دادن به خبرِ مرتبط */
function hotKeywords() {
  let db = null;
  try {
    db = new Database(path.join(DATA, 'trends.db'), { readonly: true });
    return db.prepare(`
      SELECT keyword FROM trend_snapshots
      WHERE captured_at >= datetime('now','-2 days')
      GROUP BY keyword ORDER BY MAX(vol) DESC LIMIT ?`).all(HOT_KEYWORDS)
      .map(r => String(r.keyword || '').trim())
      .filter(k => k.length >= 3);
  } catch (e) {
    return [];
  } finally {
    if (db) { try { db.close(); } catch (e) {} }
  }
}

function build() {
  const db = new Database(path.join(DATA, 'news.db'), { readonly: true });
  const hot = hotKeywords();

  // متن فقط برای خبرهای تازه لازم است؛ برای بقیه فقط id و تاریخ کافی است.
  // بدون این تفکیک، خواندن متن ۶۶ هزار ردیف حافظه و زمان می‌برد.
  const rows = db.prepare(`
    SELECT id, published_at,
           CASE WHEN published_at >= datetime('now','-7 days')
                THEN substr(COALESCE(text_fa, text), 1, 400) ELSE NULL END AS snippet
    FROM news
    WHERE COALESCE(blocked,0) = 0
    ORDER BY published_at DESC`).all();
  db.close();

  const now = Date.now();
  let hotHits = 0;
  const urls = rows.map(r => {
    const ageH = (now - new Date(r.published_at).getTime()) / 3600000;

    let pri, freq;
    if (ageH < FRESH_HOURS)   { pri = 0.9; freq = 'hourly'; }
    else if (ageH < 24 * 7)   { pri = 0.8; freq = 'daily'; }
    else if (ageH < 24 * 30)  { pri = 0.7; freq = 'weekly'; }
    else                      { pri = 0.5; freq = 'monthly'; }

    // خبری که با یک ترندِ جاری می‌خواند، دقیقاً همان چیزی است که همین حالا
    // جستجو می‌شود — بالاترین شانس کلیک. این دارایی یکتای این سایت است.
    if (r.snippet && hot.length) {
      for (const k of hot) {
        if (r.snippet.indexOf(k) !== -1) { pri = Math.min(1.0, pri + 0.1); hotHits++; break; }
      }
    }

    return { id: r.id, lastmod: r.published_at, pri: pri.toFixed(1), freq };
  });

  const shards = [];
  for (let i = 0; i < urls.length; i += SHARD_SIZE) shards.push(urls.slice(i, i + SHARD_SIZE));

  cache = {
    at: Date.now(),
    shards,
    stats: { total: urls.length, shards: shards.length, hotHits, hotKeywords: hot.length },
  };
  console.log(`[sitemap] ${urls.length} خبر در ${shards.length} فایل، ${hotHits} مورد منطبق با ${hot.length} ترند داغ`);
  return cache;
}

function get() {
  if (!cache.shards || Date.now() - cache.at > TTL_MS) {
    try { return build(); }
    catch (e) {
      console.warn('[sitemap] ساخت ناموفق:', e.message);
      return cache.shards ? cache : { shards: [], stats: { total: 0, shards: 0 } };
    }
  }
  return cache;
}

/** XML یک شارد. n از صفر شروع می‌شود. */
function shardXml(n, SITE) {
  const c = get();
  const shard = c.shards[n];
  if (!shard) return null;
  const body = shard.map(u => {
    let lm = '';
    try { const d = new Date(u.lastmod); if (!isNaN(d)) lm = `<lastmod>${d.toISOString()}</lastmod>`; } catch (e) {}
    return `<url><loc>${SITE}/news/${u.id}</loc>${lm}<changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + body + '</urlset>';
}

function shardCount() { return get().shards.length; }
function stats() { return get().stats || { total: 0, shards: 0 }; }
function invalidate() { cache = { at: 0, shards: null, stats: null }; }

module.exports = { shardXml, shardCount, stats, invalidate, SHARD_SIZE };
