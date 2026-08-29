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
 * مرزهای بازه باید دقیقاً هم‌قالبِ چیزی باشند که در جدول ذخیره شده، وگرنه
 * مقایسه‌ی رشته‌ای در SQLite بی‌صدا یک ثانیه این‌ور و آن‌ور می‌شود.
 * news.published_at به شکل «2026-08-29T05:54:48+00:00» است — یعنی افست
 * صریح، نه Z. با همین قالب، مقایسه دقیق است و ایندکس idx_news_published
 * هم استفاده می‌شود (برخلاف datetime() که ایندکس را از کار می‌اندازد).
 */
function newsStamp(iso) {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/** بازه را به شکل {from,to} استاندارد می‌کند؛ نبودِ بازه یعنی «کل آن روز». */
function normWindow(day, win) {
  if (win && win.from && win.to) return { from: win.from, to: win.to };
  const d = day || todayStr();
  return { from: d + 'T00:00:00.000Z', to: d + 'T23:59:59.999Z' };
}

/**
 * خبرهای مهم امروز.
 *
 * جدول news نه ستون بازدید دارد نه دسته، پس «مهم» را باید تخمین زد. طولِ متن
 * بهترین نشانه‌ی در دسترس است: خبر یک‌خطی معمولاً اعلان است، خبر بلند گزارش.
 * بلندترین‌های روز برداشته می‌شوند و بعد به ترتیب زمانی مرتب می‌شوند تا مدل
 * روایت روز را از صبح تا شب ببیند، نه فقط ساعت آخر را.
 */
function topNews(day, limit = 12, win) {
  const nw = open('news.db');
  if (!nw) return [];
  const w = normWindow(day, win);
  let rows = [];
  try {
    rows = nw.prepare(`
      SELECT n.id, n.text, n.text_fa, n.published_at, c.title channel_title
      FROM news n LEFT JOIN channels c ON c.id = n.channel_id
      WHERE n.published_at >= ? AND n.published_at < ? AND COALESCE(n.blocked,0)=0
        AND LENGTH(COALESCE(n.text_fa, n.text)) >= 160
      ORDER BY LENGTH(COALESCE(n.text_fa, n.text)) DESC
      LIMIT ?
    `).all(newsStamp(w.from), newsStamp(w.to), limit);
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
function commodities(win) {
  const cdb = open('commodity.db');
  if (!cdb) return [];
  let rows = [];
  try {
    // captured_at اینجا قالب Z دارد (نه افست صریحِ جدول اخبار)، پس
    // toISOString مستقیم درست است.
    const from = win && win.from ? new Date(win.from).toISOString()
                                 : new Date(Date.now() - 864e5).toISOString();
    const recent = cdb.prepare(`
      SELECT slug, name_en, category, unit, price, change_pct, captured_at
      FROM commodity_snapshots WHERE captured_at >= ? ORDER BY captured_at
    `).all(from);
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
function gather(day, win) {
  const d = day || todayStr();
  const w = normWindow(d, win);
  let base = {};
  try { base = require('./insights-brief').gatherFacts() || {}; } catch (e) { console.warn('[blog-facts/base]', e.message); }
  // ترندهای جستجو عکس‌برداریِ روزانه‌اند و بازه‌ی ساعتی برایشان معنا ندارد،
  // پس عمداً روی کل روز می‌مانند.
  const tm = trendMoves(d);
  return {
    day: d,
    window: w,
    slot: (win && win.slot) || null,
    slotLabel: (win && win.slotLabel) || null,
    markets: base.markets || [],
    property: base.property || null,
    cars: base.cars || [],
    jobs: base.jobs || null,
    newsVolume: base.news || null,
    trends: tm,
    news: topNews(d, 12, w),
    commodities: commodities(w),
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
  L.push('تاریخ داده‌ها: ' + f.day + (f.slotLabel ? ' — نوبت ' + f.slotLabel : ''));
  if (f.window) L.push('بازه‌ی داده‌ها: ' + tehranRange(f.window));

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

/** بازه را به ساعت تهران و خوانا نشان می‌دهد */
function tehranRange(w) {
  const f = new Date(new Date(w.from).getTime() + 3.5 * 3600e3);
  const t = new Date(new Date(w.to).getTime() + 3.5 * 3600e3);
  const hh = d => String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  return `از ${hh(f)} تا ${hh(t)} به وقت تهران`;
}

/**
 * بلوک داده برای مدل تصویر — با toPromptBlock فرق دارد و باید فرق داشته باشد.
 *
 * درسِ آزمایش اول: بلوک کاملِ نویسنده ۵٬۴۰۰ نویسه بود و وقتی کورکورانه به
 * ۲٬۵۰۰ بریده شد، فقط تیتر خبرها ماند و هیچ عددی به مدل نرسید — نتیجه یک
 * اینفوگرافیک زیبا بود که همه‌ی سلول‌های عددی‌اش «--» داشت.
 *
 * پس اینجا برعکس عمل می‌شود: اعداد (که کوتاه‌اند و ستون فقرات یک داشبورد)
 * همیشه کامل می‌آیند، و تنها چیزی که برای جا شدن کوتاه می‌شود متن خبرهاست.
 */
function toImageBlock(f, maxLen) {
  const cap = maxLen || 1800;
  const money = v => new Intl.NumberFormat('en-US').format(Math.round(v));
  const num = [];

  if (f.window) num.push('بازه: ' + tehranRange(f.window) + ' — ' + f.day);

  const t = f.trends || {};
  if ((t.topVolume || []).length) {
    num.push('[پرجستجوترین‌ها] ' + t.topVolume.slice(0, 6).map(r => `${r.keyword} (${money(r.vol)})`).join(' · '));
  }
  if ((t.risers || []).length) {
    num.push('[بیشترین رشد جستجو] ' + t.risers.slice(0, 5).map(r => `${r.keyword} +${r.growthPct}٪`).join(' · '));
  }
  if ((f.markets || []).length) {
    num.push('[بازار مالی ۲۴ساعت] ' + f.markets.slice(0, 8).map(m => `${m.name} ${m.changePct > 0 ? '+' : ''}${m.changePct}٪`).join(' · '));
  }
  if (f.gold) {
    num.push(`[طلای آنلاین] ارزان‌ترین ${f.gold.cheapest.name} ${money(f.gold.cheapest.price)} تومان · گران‌ترین ${f.gold.priciest.name} ${money(f.gold.priciest.price)} تومان · اختلاف ${f.gold.spreadPct}٪`);
  }
  if ((f.commodities || []).length) {
    num.push('[کالای جهانی] ' + f.commodities.slice(0, 6).map(c => `${c.name} ${c.changePct > 0 ? '+' : ''}${c.changePct}٪`).join(' · '));
  }
  if (f.property) num.push(`[ملک تهران] میانگین متری ${f.property.avgMeterM} میلیون تومان · گران‌ترین ${f.property.topName} ${f.property.topMeterM}م · ارزان‌ترین ${f.property.cheapName} ${f.property.cheapMeterM}م`);
  if ((f.cars || []).length) num.push('[خودرو] ' + f.cars.slice(0, 5).map(c => `${c.name} ${c.changePct > 0 ? '+' : ''}${c.changePct}٪`).join(' · '));
  if (f.jobs) num.push(`[بازار کار] ${money(f.jobs.count)} آگهی فعال (${f.jobs.changePct > 0 ? '+' : ''}${f.jobs.changePct}٪ هفتگی)`);
  if (f.newsVolume) num.push(`[حجم خبر این بازه] ${f.newsVolume.count} خبر`);

  const numText = num.join('\n');
  // هرچه از سقف باقی ماند سهم خبرهاست — نه برعکس
  let left = cap - numText.length - 30;
  const lines = [];
  for (const n of (f.news || [])) {
    if (left < 60 || lines.length >= 5) break;
    let s = n.text.length > 110 ? n.text.slice(0, 110).replace(/\s+\S*$/, '') + '…' : n.text;
    if (s.length + 4 > left) break;
    lines.push(`${lines.length + 1}. ${s}`);
    left -= s.length + 4;
  }

  return numText + (lines.length ? '\n\n[مهم‌ترین خبرهای این بازه]\n' + lines.join('\n') : '');
}

module.exports = { gather, toPromptBlock, toImageBlock, isEnough, topNews, trendMoves, normWindow };
