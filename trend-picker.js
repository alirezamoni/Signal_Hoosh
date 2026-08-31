/**
 * trend-picker.js — انتخاب «موضوع روز» از روی ترند جستجو + پشتوانه‌ی خبری
 *
 * ورودی: بازه‌ی ۲۴ ساعته. خروجی: یک موضوع برنده با خبرهای واقعیِ همان بازه،
 * یا null اگر هیچ موضوعی پشتوانه‌ی کافی نداشته باشد.
 *
 * چند تصمیم که از داده‌ی واقعی این سایت درآمد، نه از فرض:
 *
 * ۱. «اخبار مرتبط با ترند» را هیچ API به ما نمی‌دهد. جدول trend_snapshots
 *    فقط keyword/vol/growth/cat دارد و news.db هم FTS ندارد. پس تطبیق متنی
 *    است: اول عبارت کامل، بعد ترکیب واژه‌های معنادار. روی داده‌ی واقعی
 *    ۱۳ ترند از ۲۵ ترند یک روز، پشتوانه‌ی کافی داشتند.
 *
 * ۲. ترندهای هم‌داستان باید خوشه شوند. «لارک»، «جزیره لارک» و «حمله به
 *    لارک» سه ردیف جدا در فهرست ترندند ولی یک خبرند؛ بدون خوشه‌بندی
 *    امتیازدهی سه بار یک موضوع را می‌سنجد و بالای جدول را اشغال می‌کند.
 *    خوشه‌بندی بر اساس هم‌پوشانی مجموعه‌ی خبرهاست، نه شباهت رشته‌ای —
 *    چون «بارش» و «هواشناسی» هیچ واژه‌ی مشترکی ندارند ولی یک ماجرا هستند.
 *
 * ۳. ترندهای ورزشی/سرگرمی معمولاً رد می‌شوند، و این درست است: ۲۰ کانال
 *    فعال ما خبری‌سیاسی‌اند. فیلتر پشتوانه دقیقاً برای همین است — بهتر از
 *    نوشتن مقاله‌ای که هیچ داده‌ای پشتش نیست.
 */
const path = require('path');
const Database = require('better-sqlite3');

const open = n => {
  try { return new Database(path.join(__dirname, 'data', n), { readonly: true }); }
  catch (e) { console.warn('[trend-picker] ' + n + ':', e.message); return null; }
};

// آستانه‌ها — از پنل قابل تغییر نیستند چون تنظیم‌کردنشان نیاز به فهم
// آماری دارد، نه سلیقه. اگر لازم شد اینجا عوض می‌شوند.
const MIN_NEWS     = 3;   // حداقل خبر برای اینکه موضوع «پشتوانه» داشته باشد
const MIN_SOURCES  = 2;   // از حداقل این تعداد منبع متفاوت
const TOP_TRENDS   = 25;  // چند ترند برتر بررسی شوند
const MAX_PER_SRC  = 2;   // در خبرهای منتخب، از هر منبع حداکثر این تعداد
const PICK_NEWS    = 8;   // حداکثر خبر منتخب برای مقاله

/**
 * واژه‌های پرتکرارِ بی‌ارزش برای تطبیق. «بازی»، «خلاصه»، «نتایج» و مانند
 * این‌ها عمداً هستند: در عنوان ترندهای ورزشی می‌آیند و اگر حذف نشوند با
 * هر خبری تطبیق می‌خورند.
 */
const STOP = new Set([
  'و','در','به','از','با','که','را','این','آن','برای','تا','بر','یا','هم','است','بود','شد',
  'می','های','ها','یک','دو','سه','بازی','خلاصه','قیمت','امروز','نتایج','زنده','پخش','فیلم',
  'دانلود','مقابل','علیه','اخبار','خبر','جدید','آخرین','ساعت','روز','سایت','لینک','کامل',
]);

function tokens(kw) {
  return String(kw || '')
    .split(/[\s‌]+/)
    .map(t => t.replace(/[^؀-ۿ\w]/g, ''))
    .filter(t => t.length >= 3 && !STOP.has(t));
}

/** مرز بازه هم‌قالبِ ستون published_at ذخیره‌شده: «…T…+00:00» نه «…Z» */
function newsStamp(iso) {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/** تیتر خبر: خط اول، پاک‌شده از مارک‌داون و ایموجی */
function headline(body) {
  const first = String(body || '').split('\n').find(l => l.trim().length > 12) || String(body || '');
  return first
    .replace(/\*+/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function excerpt(body, max) {
  return String(body || '')
    .replace(/\*+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 320);
}

// ── جمع‌آوری ─────────────────────────────────────────────────

function trendsIn(win) {
  const tr = open('trends.db');
  if (!tr) return [];
  let rows = [];
  try {
    // snap_date روزانه است؛ برای بازه‌ی ۲۴ ساعته دو روز تقویمی لازم است
    const d0 = new Date(win.from).toISOString().slice(0, 10);
    const d1 = new Date(win.to).toISOString().slice(0, 10);
    rows = tr.prepare(`
      SELECT keyword, MAX(vol) vol, MAX(growth) growth, MAX(cat) cat,
             MIN(rank) best_rank, COUNT(*) snaps
      FROM trend_snapshots
      WHERE snap_date IN (?, ?) AND captured_at >= ? AND captured_at <= ?
      GROUP BY keyword
      ORDER BY vol DESC, growth DESC
      LIMIT ?`).all(d0, d1, win.from, win.to, TOP_TRENDS);
  } catch (e) { console.warn('[trend-picker/trends]', e.message); }
  tr.close();
  return rows;
}

function newsFor(nw, keyword, win) {
  const from = newsStamp(win.from), to = newsStamp(win.to);
  const seen = new Map();

  const add = (rows, how) => {
    for (const r of rows) if (!seen.has(r.id)) { r.how = how; seen.set(r.id, r); }
  };

  try {
    // ۱) عبارت کامل — دقیق‌ترین تطبیق
    add(nw.prepare(`
      SELECT n.id, n.tg_link, n.published_at, c.title src,
             COALESCE(n.text_fa, n.text) body
      FROM news n LEFT JOIN channels c ON c.id = n.channel_id
      WHERE n.published_at >= ? AND n.published_at < ? AND COALESCE(n.blocked,0)=0
        AND COALESCE(n.text_fa, n.text) LIKE ?
      ORDER BY n.published_at DESC LIMIT 60`).all(from, to, '%' + keyword + '%'), 'عبارت کامل');

    // ۲) اگر کم بود: همه‌ی واژه‌های معنادار با هم
    const tk = tokens(keyword);
    if (seen.size < MIN_NEWS && tk.length > 1) {
      const where = tk.map(() => 'COALESCE(n.text_fa, n.text) LIKE ?').join(' AND ');
      add(nw.prepare(`
        SELECT n.id, n.tg_link, n.published_at, c.title src,
               COALESCE(n.text_fa, n.text) body
        FROM news n LEFT JOIN channels c ON c.id = n.channel_id
        WHERE n.published_at >= ? AND n.published_at < ? AND COALESCE(n.blocked,0)=0 AND ${where}
        ORDER BY n.published_at DESC LIMIT 60`)
        .all(from, to, ...tk.map(t => '%' + t + '%')), 'همه‌ی واژه‌ها');
    }
  } catch (e) { console.warn('[trend-picker/news]', keyword, e.message); }

  return [...seen.values()];
}

// ── خوشه‌بندی موضوعی ─────────────────────────────────────────

function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
}

/**
 * ترندهایی که مجموعه‌ی خبرشان زیاد هم‌پوشانی دارد، یک موضوع‌اند.
 * آستانه‌ی ۰٫۴ تجربی است: «لارک»/«جزیره لارک» را یکی می‌کند ولی
 * «زلزله تهران» و «جنگ» را جدا نگه می‌دارد.
 */
function cluster(items) {
  const groups = [];
  for (const it of items) {
    let placed = false;
    for (const g of groups) {
      if (jaccard(it.ids, g.ids) >= 0.4) {
        g.members.push(it);
        for (const id of it.ids) g.ids.add(id);
        for (const n of it.news) if (!g.newsById.has(n.id)) g.newsById.set(n.id, n);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push({
        members: [it],
        ids: new Set(it.ids),
        newsById: new Map(it.news.map(n => [n.id, n])),
      });
    }
  }

  return groups.map(g => {
    // نماینده: پرحجم‌ترین؛ در تساوی، کوتاه‌ترین (معمولاً کانونی‌ترین شکل)
    const rep = g.members.slice().sort((a, b) =>
      (b.vol - a.vol) || (a.keyword.length - b.keyword.length))[0];

    // دسته را رأی‌گیری می‌کنیم، نه از نماینده. دسته‌بندیِ خودکارِ ترند روی
    // تک‌واژه‌ها بد عمل می‌کند — «لارک» را «تکنولوژی» زده بود در حالی که
    // «جزیره لارک» درست «اجتماعی» خورده بود. رأی اکثریت خطا را می‌شوید.
    const votes = new Map();
    for (const m of g.members) if (m.cat) votes.set(m.cat, (votes.get(m.cat) || 0) + 1);
    const cat = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];

    // ترتیب خبرها: اول آن‌هایی که واقعاً نامِ موضوع در متنشان هست، بعد
    // تازگی. بدون این، اتحادِ خوشه گاهی خبرِ کم‌ربط را بالا می‌آورد.
    const news = [...g.newsById.values()].sort((a, b) => {
      const ha = a.body.includes(rep.keyword) ? 1 : 0;
      const hb = b.body.includes(rep.keyword) ? 1 : 0;
      return (hb - ha) || String(b.published_at).localeCompare(String(a.published_at));
    });

    return {
      keyword: rep.keyword,
      aliases: g.members.map(m => m.keyword).filter(k => k !== rep.keyword),
      vol:    Math.max(...g.members.map(m => m.vol || 0)),
      growth: Math.max(...g.members.map(m => m.growth || 0)),
      cat:    cat ? cat[0] : null,
      news,
      sources: new Set(news.map(n => n.src).filter(Boolean)),
    };
  });
}

// ── امتیازدهی ────────────────────────────────────────────────

/**
 * حجم جستجو لگاریتمی وارد می‌شود چون فاصله‌ی ۱۰هزار تا ۵۰هزار به‌اندازه‌ی
 * فاصله‌ی ۱۰۰ تا ۱۰هزار معنا ندارد. تنوع منبع وزن بالایی می‌گیرد: خبری که
 * ۱۸ رسانه پوشش داده‌اند واقعاً مهم است، برخلاف خبری که یک کانال ۴۰ بار
 * تکرارش کرده.
 */
function score(c) {
  const vol    = Math.log10(Math.max(c.vol || 1, 1)) * 30;
  const growth = Math.min(c.growth || 0, 1000) / 1000 * 25;
  const depth  = Math.min(c.news.length, 15) * 2.5;
  const spread = c.sources.size * 6;
  return Math.round(vol + growth + depth + spread);
}

/** از هر منبع حداکثر MAX_PER_SRC خبر، تازه‌ترین‌ها اول — برای تنوع روایت */
function pickNews(news) {
  const perSrc = new Map();
  const out = [];
  for (const n of news) {
    const k = n.src || '—';
    const c = perSrc.get(k) || 0;
    if (c >= MAX_PER_SRC) continue;
    perSrc.set(k, c + 1);
    out.push({
      id: n.id,
      headline: headline(n.body),
      excerpt: excerpt(n.body, 300),
      source: n.src || null,
      link: n.tg_link || null,
      at: n.published_at,
    });
    if (out.length >= PICK_NEWS) break;
  }
  return out;
}

/**
 * @param {{from:string,to:string}} win بازه‌ی ۲۴ ساعته (ISO/UTC)
 * @returns {{keyword,aliases,vol,growth,cat,score,news,sourceCount,newsCount,
 *            considered,qualified}|null}
 */
function pick(win) {
  const nw = open('news.db');
  if (!nw) return null;

  const raw = trendsIn(win);
  const items = [];
  for (const t of raw) {
    const news = newsFor(nw, t.keyword, win);
    items.push({ ...t, news, ids: new Set(news.map(n => n.id)) });
  }
  nw.close();

  const clusters = cluster(items)
    .filter(c => c.news.length >= MIN_NEWS && c.sources.size >= MIN_SOURCES)
    .map(c => ({ ...c, score: score(c) }))
    .sort((a, b) => b.score - a.score);

  if (!clusters.length) return null;
  const w = clusters[0];

  return {
    keyword: w.keyword,
    aliases: w.aliases,
    vol: w.vol,
    growth: w.growth,
    cat: w.cat,
    score: w.score,
    newsCount: w.news.length,
    sourceCount: w.sources.size,
    news: pickNews(w.news),
    considered: raw.length,
    qualified: clusters.length,
    runnersUp: clusters.slice(1, 4).map(c => ({ keyword: c.keyword, score: c.score })),
  };
}

module.exports = { pick, tokens, headline, MIN_NEWS, MIN_SOURCES };
