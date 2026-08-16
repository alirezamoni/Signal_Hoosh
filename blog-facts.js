/**
 * blog-facts.js — داده‌های مهم امروز از همه‌ی تب‌ها، برای نوشتن مطلب روزانه
 *
 * روی gatherFacts() در insights-brief.js سوار است (بازارها، ترند، ملک،
 * خودرو، کار، طلا) و چیزهایی را اضافه می‌کند که آن‌جا لازم نبود ولی برای
 * یک مطلب وبلاگ لازم است: **تیتر خبرهای مهم روز** (مهم‌ترین بخش)، ترندهای
 * ریزشی در کنار رشدی، کالای جهانی و پلی‌مارکت.
 *
 * قاعده‌ی کل پروژه اینجا هم برقرار است: همه‌ی اعداد را کد درمی‌آورد و مدل
 * زبانی فقط از روی همین اعداد می‌نویسد — تا عددی که وجود ندارد ساخته نشود.
 */
const path = require('path');
const Database = require('better-sqlite3');

const open = n => { try { return new Database(path.join(__dirname, 'data', n), { readonly: true }); } catch (e) { return null; } };

function todayStr() { return new Date().toISOString().slice(0, 10); }

/**
 * خبرهای مهم امروز.
 *
 * جدول news نه ستون بازدید دارد نه دسته، پس «مهم» را باید تخمین زد. طولِ متن
 * بهترین نشانه‌ی در دسترس است: خبر یک‌خطی معمولاً اعلان است، خبر بلند گزارش.
 * بلندترین‌های روز برداشته می‌شوند و بعد به ترتیب زمانی مرتب می‌شوند تا مدل
 * روایت روز را از صبح تا شب ببیند، نه فقط ساعت آخر را.
 */
function topNews(day, limit = 12) {
  const nw = open('news.db');
  if (!nw) return [];
  let rows = [];
  try {
    rows = nw.prepare(`
      SELECT n.id, n.text, n.text_fa, n.published_at, c.title channel_title
      FROM news n LEFT JOIN channels c ON c.id = n.channel_id
      WHERE substr(n.published_at,1,10)=? AND COALESCE(n.blocked,0)=0
        AND LENGTH(COALESCE(n.text_fa, n.text)) >= 160
      ORDER BY LENGTH(COALESCE(n.text_fa, n.text)) DESC
      LIMIT ?
    `).all(day, limit);
    rows.sort((a, b) => String(a.published_at).localeCompare(String(b.published_at)));
  } catch (e) { console.warn('[blog-facts/news]', e.message); }
  nw.close();
  return rows.map(r => {
    const t = String(r.text_fa || r.text || '').replace(/\s+/g, ' ').trim();
    return {
      id: r.id,
      source: r.channel_title || null,
      // فقط چکیده به مدل می‌رود؛ متن کامل خبر نه لازم است نه در بودجه‌ی توکن جا می‌شود
      text: t.length > 300 ? t.slice(0, 300).replace(/\s+\S*$/, '') + '…' : t,
    };
  });
}

/** ترندهای جستجو: هم رشدی، هم ریزشی (کسانی که دیروز بودند و امروز نیستند) */
function trendMoves(day) {
  const tr = open('trends.db');
  if (!tr) return { risers: [], fallers: [], topVolume: [] };
  const out = { risers: [], fallers: [], topVolume: [] };
  try {
    out.risers = tr.prepare(`
      SELECT keyword, MAX(growth) g, MAX(vol) v FROM trend_snapshots
      WHERE snap_date=? AND growth>0 GROUP BY keyword ORDER BY g DESC, v DESC LIMIT 8
    `).all(day).map(r => ({ keyword: r.keyword, growthPct: Math.round(r.g), vol: r.v }));

    out.topVolume = tr.prepare(`
      SELECT keyword, MAX(vol) v FROM trend_snapshots
      WHERE snap_date=? GROUP BY keyword ORDER BY v DESC LIMIT 8
    `).all(day).map(r => ({ keyword: r.keyword, vol: r.v }));

    // ریزشی = دیروز حجم خوبی داشت، امروز اصلاً در فهرست نیست
    out.fallers = tr.prepare(`
      SELECT keyword, MAX(vol) v FROM trend_snapshots
      WHERE snap_date = date(?, '-1 day')
        AND keyword NOT IN (SELECT DISTINCT keyword FROM trend_snapshots WHERE snap_date = ?)
      GROUP BY keyword ORDER BY v DESC LIMIT 5
    `).all(day, day).map(r => ({ keyword: r.keyword, volYesterday: r.v }));
  } catch (e) { console.warn('[blog-facts/trends]', e.message); }
  tr.close();
  return out;
}

/** کالای جهانی — بزرگ‌ترین حرکت‌های روز */
function commodities() {
  const cdb = open('commodity.db');
  if (!cdb) return [];
  let rows = [];
  try {
    const recent = cdb.prepare(`
      SELECT slug, name_en, category, unit, price, change_pct, captured_at
      FROM commodity_snapshots WHERE captured_at >= datetime('now','-1 day') ORDER BY captured_at
    `).all();
    const last = new Map();
    for (const r of recent) last.set(r.slug, r);
    rows = [...last.values()]
      .filter(r => r.change_pct != null && Math.abs(r.change_pct) >= 1)
      .sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct))
      .slice(0, 6);
  } catch (e) { console.warn('[blog-facts/commodity]', e.message); }
  cdb.close();
  let names = {};
  try { names = require('./commodity-crawler').CURATED || {}; } catch (e) {}
  return rows.map(r => ({
    name: (names[r.slug] || {}).fa || r.name_en || r.slug,
    changePct: Math.round(r.change_pct * 10) / 10,
    price: r.price, unit: r.unit || null,
  }));
}

/** پلی‌مارکت — بازارهایی که بیشترین جابه‌جایی احتمال را داشته‌اند */
function polymarket() {
  const p = open('polymarket.db');
  if (!p) return [];
  let rows = [];
  try {
    const cols = p.prepare("SELECT name FROM pragma_table_info('poly_markets')").all().map(c => c.name);
    if (cols.includes('question') && cols.includes('probability')) {
      rows = p.prepare(`SELECT question, probability FROM poly_markets
                        ORDER BY COALESCE(volume,0) DESC LIMIT 5`).all();
    }
  } catch (e) { /* ساختار این جدول در نسخه‌های مختلف فرق دارد — اختیاری است */ }
  p.close();
  return rows.map(r => ({ question: r.question, probPct: Math.round((r.probability || 0) * 100) }));
}

/** طلای آنلاین — بازه‌ی قیمت بین پلتفرم‌ها */
function goldPlatforms() {
  try {
    const g = require('./gold-db').getLatest().filter(x => x.price > 0);
    if (g.length < 2) return null;
    const sorted = g.slice().sort((a, b) => a.price - b.price);
    return {
      count: sorted.length,
      cheapest: { name: sorted[0].name_fa, price: sorted[0].price },
      priciest: { name: sorted[sorted.length - 1].name_fa, price: sorted[sorted.length - 1].price },
      spreadPct: Math.round(((sorted[sorted.length - 1].price / sorted[0].price) - 1) * 1000) / 10,
    };
  } catch (e) { return null; }
}

/** همه‌ی داده‌های روز، یک‌جا */
function gather(day) {
  const d = day || todayStr();
  let base = {};
  try { base = require('./insights-brief').gatherFacts() || {}; } catch (e) { console.warn('[blog-facts/base]', e.message); }
  const tm = trendMoves(d);
  return {
    day: d,
    markets: base.markets || [],
    property: base.property || null,
    cars: base.cars || [],
    jobs: base.jobs || null,
    newsVolume: base.news || null,
    trends: tm,
    news: topNews(d),
    commodities: commodities(),
    polymarket: polymarket(),
    gold: goldPlatforms(),
  };
}

/** آیا اصلاً آن‌قدر داده هست که نوشتن معنا داشته باشد؟ */
function isEnough(f) {
  if (!f) return false;
  const n = (f.news || []).length
    + (f.markets || []).length
    + ((f.trends && f.trends.risers) || []).length
    + (f.commodities || []).length;
  return n >= 4;
}

/** تبدیل به متن فشرده‌ی فارسی برای دادن به مدل */
function toPromptBlock(f) {
  const L = [];
  const money = v => new Intl.NumberFormat('en-US').format(Math.round(v));
  L.push('تاریخ داده‌ها: ' + f.day);

  if ((f.news || []).length) {
    L.push('\n[خبرهای مهم امروز — به ترتیب زمانی]');
    f.news.forEach((n, i) => {
      L.push(`${i + 1}. ${n.text}` + (n.source ? ` (منبع: ${n.source})` : ''));
    });
  }
  if (f.newsVolume) {
    L.push(`\nحجم خبر امروز: ${f.newsVolume.count} خبر` +
      (f.newsVolume.vsAvgPct != null ? ` (${f.newsVolume.vsAvgPct > 0 ? '+' : ''}${f.newsVolume.vsAvgPct}٪ نسبت به میانگین هفته)` : ''));
  }

  const t = f.trends || {};
  if ((t.risers || []).length) {
    L.push('\n[ترندهای جستجوی رشدی]');
    t.risers.forEach(r => L.push(`- ${r.keyword}: رشد ${r.growthPct}٪، حجم ${money(r.vol)}`));
  }
  if ((t.topVolume || []).length) {
    L.push('\n[پرجستجوترین‌های امروز]');
    t.topVolume.forEach(r => L.push(`- ${r.keyword}: ${money(r.vol)}`));
  }
  if ((t.fallers || []).length) {
    L.push('\n[ترندهایی که از فهرست خارج شدند (دیروز بودند، امروز نیستند)]');
    t.fallers.forEach(r => L.push(`- ${r.keyword} (حجم دیروز ${money(r.volYesterday)})`));
  }

  if ((f.markets || []).length) {
    L.push('\n[بازارهای مالی — بیشترین تغییر ۲۴ ساعت]');
    f.markets.forEach(m => L.push(`- ${m.name}: ${m.changePct > 0 ? '+' : ''}${m.changePct}٪`));
  }
  if (f.gold) {
    L.push(`\n[طلای آنلاین] ${f.gold.count} پلتفرم — ارزان‌ترین ${f.gold.cheapest.name} ${money(f.gold.cheapest.price)} تومان، ` +
      `گران‌ترین ${f.gold.priciest.name} ${money(f.gold.priciest.price)} تومان، اختلاف ${f.gold.spreadPct}٪`);
  }
  if ((f.commodities || []).length) {
    L.push('\n[کالای جهانی — بیشترین تغییر]');
    f.commodities.forEach(c => L.push(`- ${c.name}: ${c.changePct > 0 ? '+' : ''}${c.changePct}٪`));
  }
  if (f.property) {
    L.push(`\n[ملک تهران] میانگین متری ${f.property.avgMeterM} میلیون تومان — ` +
      `گران‌ترین ${f.property.topName} (${f.property.topMeterM}م)، ارزان‌ترین ${f.property.cheapName} (${f.property.cheapMeterM}م)`);
  }
  if ((f.cars || []).length) {
    L.push('\n[خودرو — بیشترین تغییر هفته]');
    f.cars.forEach(c => L.push(`- ${c.name}: ${c.changePct > 0 ? '+' : ''}${c.changePct}٪`));
  }
  if (f.jobs) {
    L.push(`\n[بازار کار] ${money(f.jobs.count)} آگهی فعال (${f.jobs.changePct > 0 ? '+' : ''}${f.jobs.changePct}٪ نسبت به هفته‌ی گذشته)`);
  }
  if ((f.polymarket || []).length) {
    L.push('\n[پلی‌مارکت — بازارهای پرحجم]');
    f.polymarket.forEach(p => L.push(`- ${p.question}: ${p.probPct}٪`));
  }
  return L.join('\n');
}

module.exports = { gather, toPromptBlock, isEnough, topNews, trendMoves };
