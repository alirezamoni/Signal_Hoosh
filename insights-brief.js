/**
 * insights-brief.js — روایت روزانه‌ی یک‌پاراگرافی از کل ایران
 *
 * تقسیم کار عمدی: **همه‌ی اعداد را کد استخراج می‌کند** و مدل زبانی فقط
 * از روی همان اعداد یک پاراگراف فارسی می‌نویسد. اگر مدل اجازه داشت خودش
 * از دیتابیس عدد دربیاورد، دیر یا زود عددی می‌ساخت که وجود ندارد — و در
 * سایتی که کارش نمایش داده‌ی درست است، این بدترین اتفاق ممکن است.
 *
 * اگر مدل در دسترس نبود (سقف روزانه‌ی اوپن‌روتر زیاد پر می‌شود)، همان
 * اعداد با یک قالب ثابت به جمله تبدیل می‌شوند. بخش هیچ‌وقت خالی نمی‌ماند.
 */
const path = require('path');
const Database = require('better-sqlite3');
const db = require('./insights-db');

let ai = null;
try { ai = require('./lib/ai-client'); } catch (e) { /* بدون هوش مصنوعی هم کار می‌کند */ }

const open = n => { try { return new Database(path.join(__dirname, 'data', n), { readonly: true }); } catch (e) { return null; } };
const pct = v => (v > 0 ? '+' : '') + v.toFixed(1) + '٪';

const SYM = {
  usd: 'دلار', gold18: 'طلای ۱۸ عیار', coin: 'سکه امامی', mesghal: 'مثقال طلا',
  ounce: 'انس جهانی طلا', bitcoin: 'بیت‌کوین', tether: 'تتر', stock_market: 'بورس تهران',
  oil_brent: 'نفت برنت', coin_bubble: 'حباب سکه',
};

/** واقعیت‌های امروز از هر ماژول — فقط چیزهایی که واقعاً داده دارند */
function gatherFacts() {
  const today = new Date().toISOString().slice(0, 10);
  const f = { day: today, markets: [], trends: [], news: null, property: null, cars: [], jobs: null, gold: null, poly: null };

  /* بازارهای مالی — بزرگ‌ترین حرکت‌های ۲۴ ساعت */
  const fin = open('finance.db');
  if (fin) {
    try {
      /* زیرپرس‌وجوی همبسته روی ۲۴۴ هزار ردیف عملاً تمام نمی‌شود. محدود
         کردن به ۴۸ ساعت اخیر و نگه‌داشتن آخرین ردیف هر نماد در حافظه،
         همان نتیجه را فوری می‌دهد. */
      const recent = fin.prepare(
        "SELECT symbol, name, price, change_pct FROM finance_snapshots " +
        "WHERE price > 0 AND timestamp >= datetime('now','-2 days') ORDER BY timestamp"
      ).all();
      const last = new Map();
      for (const r of recent) last.set(r.symbol, r);
      const rows = [...last.values()];
      f.markets = rows
        .filter(r => r.change_pct != null && Math.abs(r.change_pct) >= 0.2)
        .sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct))
        .slice(0, 4)
        .map(r => ({ name: SYM[r.symbol] || r.name || r.symbol, changePct: Math.round(r.change_pct * 10) / 10 }));
    } catch (e) { console.warn('[brief/fin]', e.message); }
    fin.close();
  }

  /* ترند جستجو — بیشترین رشد امروز */
  const tr = open('trends.db');
  if (tr) {
    try {
      f.trends = tr.prepare(`
        SELECT keyword, MAX(growth) g, MAX(vol) v FROM trend_snapshots
        WHERE snap_date = ? AND growth > 0 GROUP BY keyword ORDER BY g DESC LIMIT 3
      `).all(today).map(r => ({ keyword: r.keyword, growthPct: Math.round(r.g), vol: r.v }));
    } catch (e) { console.warn('[brief/trend]', e.message); }
    tr.close();
  }

  /* خبر — حجم امروز نسبت به میانگین هفته */
  const nw = open('news.db');
  if (nw) {
    try {
      const t = nw.prepare("SELECT COUNT(*) c FROM news WHERE substr(published_at,1,10)=? AND COALESCE(blocked,0)=0").get(today);
      const avg = nw.prepare(`
        SELECT AVG(c) a FROM (SELECT COUNT(*) c FROM news
          WHERE COALESCE(blocked,0)=0 AND substr(published_at,1,10) < ?
            AND substr(published_at,1,10) >= date(?, '-7 days')
          GROUP BY substr(published_at,1,10))
      `).get(today, today);
      if (t && t.c) {
        f.news = { count: t.c, weekAvg: avg && avg.a ? Math.round(avg.a) : null };
        if (f.news.weekAvg) f.news.vsAvgPct = Math.round(((t.c / f.news.weekAvg) - 1) * 100);
      }
    } catch (e) { console.warn('[brief/news]', e.message); }
    nw.close();
  }

  /* ملک — بیشترین رشد و گران‌ترین منطقه */
  try {
    const pdb = require('./property-db');
    const rows = pdb.latest().filter(r => r.meter > 0);
    if (rows.length) {
      const sorted = rows.slice().sort((a, b) => b.meter - a.meter);
      const avg = rows.reduce((s, r) => s + r.meter, 0) / rows.length;
      f.property = {
        avgMeterM: Math.round(avg / 1e6),
        topName: sorted[0].name_fa, topMeterM: Math.round(sorted[0].meter / 1e6),
        cheapName: sorted[sorted.length - 1].name_fa, cheapMeterM: Math.round(sorted[sorted.length - 1].meter / 1e6),
      };
    }
  } catch (e) { /* ماژول ملک ممکن است هنوز داده نداشته باشد */ }

  /* خودرو — بیشترین تغییر */
  const cr = open('cars.db');
  if (cr) {
    try {
      const rows = cr.prepare(`
        SELECT m.name_fa, s.median_price, s.snap_date FROM car_snapshots s
        JOIN car_models m ON m.id = s.model_id
        WHERE s.snap_date >= date('now','-8 days') AND s.median_price > 0 ORDER BY s.snap_date
      `).all();
      const by = new Map();
      for (const r of rows) {
        if (!by.has(r.name_fa)) by.set(r.name_fa, []);
        by.get(r.name_fa).push(r.median_price);
      }
      const moves = [];
      for (const [name, vals] of by) {
        if (vals.length < 2) continue;
        const d = ((vals[vals.length - 1] / vals[0]) - 1) * 100;
        if (Math.abs(d) >= 0.5) moves.push({ name, changePct: Math.round(d * 10) / 10 });
      }
      f.cars = moves.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 2);
    } catch (e) { console.warn('[brief/cars]', e.message); }
    cr.close();
  }

  /* بازار کار */
  const jb = open('jobs.db');
  if (jb) {
    try {
      const rows = jb.prepare(`
        SELECT snap_date, SUM(count) c FROM job_snapshots WHERE category='total'
        GROUP BY snap_date ORDER BY snap_date DESC LIMIT 8
      `).all();
      if (rows.length >= 2) {
        const now = rows[0].c, before = rows[rows.length - 1].c;
        f.jobs = { count: now, changePct: Math.round(((now / before) - 1) * 1000) / 10 };
      }
    } catch (e) { console.warn('[brief/jobs]', e.message); }
    jb.close();
  }

  /* طلای آنلاین — کف بازار و دامنه */
  try {
    const g = require('./gold-db').getLatest().filter(x => x.price > 0);
    if (g.length >= 2) {
      f.gold = {
        cheapest: g[0].name_fa, cheapestM: Math.round(g[0].price / 1e5) / 10,
        spreadPct: Math.round(((g[g.length - 1].price / g[0].price) - 1) * 1000) / 10,
        platforms: g.length,
      };
    }
  } catch (e) { /* اختیاری */ }

  return f;
}

/** جمله‌ی جایگزین وقتی مدل در دسترس نیست — از همان اعداد */
function templateText(f) {
  const parts = [];
  // «+۰٫۹٪» در متن راست‌چین به شکل «۰٫۹+٪» دیده می‌شود؛ با کلمه نوشتن
  // جهت، هم مشکل دوجهته حل می‌شود هم جمله فارسی‌تر می‌شود
  const move = v => Math.abs(v).toFixed(1) + ' درصد ' + (v > 0 ? 'رشد' : 'افت');
  if (f.markets.length) {
    parts.push('در بازارهای مالی ' + f.markets.slice(0, 2)
      .map(m => m.name + ' ' + move(m.changePct)).join(' و ') + ' داشت');
  }
  if (f.trends.length) {
    parts.push('پرجستجوترین موضوع امروز «' + f.trends[0].keyword + '» بود');
  }
  if (f.news && f.news.vsAvgPct != null) {
    parts.push('حجم اخبار ' + move(f.news.vsAvgPct) + ' نسبت به میانگین هفته داشت');
  }
  if (f.property) {
    parts.push('میانگین قیمت مسکن تهران ' + f.property.avgMeterM + ' میلیون تومان بر متر است');
  }
  if (f.jobs && f.jobs.changePct != null) {
    parts.push('آگهی‌های استخدام در یک هفته ' + move(f.jobs.changePct) + ' داشت');
  }
  if (!parts.length) return null;
  return parts.join('، ') + '.';
}

function buildPrompt(f) {
  return [
    'تو خبرنگار داده‌محور یک سایت رصد بازار ایران هستی.',
    'با اعداد زیر، دقیقاً یک پاراگراف فارسی روان بنویس که خلاصه‌ی وضعیت امروز ایران باشد.',
    '',
    'قواعد سخت‌گیرانه:',
    '- فقط و فقط از همین اعداد استفاده کن. هیچ عدد یا نام تازه‌ای از خودت اضافه نکن.',
    '- حداکثر ۶۰ کلمه. یک پاراگراف، بدون فهرست و بدون تیتر.',
    '- لحن خبری و خنثی. هیچ توصیه‌ی خرید و فروش نده.',
    '- اگر بین دو عدد ارتباط جالبی هست (مثلاً رشد جستجو همراه با تغییر قیمت)، به آن اشاره کن.',
    '- بدون مقدمه و بدون توضیح اضافه؛ فقط خود پاراگراف.',
    '',
    'داده‌ها:',
    JSON.stringify(f, null, 1),
  ].join('\n');
}

async function generate() {
  const f = gatherFacts();
  const day = f.day;

  const filled = (f.markets.length ? 1 : 0) + (f.trends.length ? 1 : 0) + (f.news ? 1 : 0) +
                 (f.property ? 1 : 0) + (f.cars.length ? 1 : 0) + (f.jobs ? 1 : 0) + (f.gold ? 1 : 0);
  if (filled < 2) { console.log('[brief] داده‌ی امروز کافی نیست (' + filled + ' ماژول)'); return null; }

  let text = null, source = 'template', model = null;
  if (ai && ai.callText) {
    try {
      const out = await ai.callText(buildPrompt(f), { maxTokens: 260, settingsKey: 'ai_model_brief' });
      if (out && String(out).trim().length > 40) {
        text = String(out).trim().replace(/^["'«]+|["'»]+$/g, '');
        // اگر مدل جواب انگلیسی یا آشغال داد، بهتر است سراغ قالب برویم
        if (ai.persianRatio && ai.persianRatio(text) < 0.5) text = null;
        else { source = 'ai'; model = 'openrouter'; }
      }
    } catch (e) { console.warn('[brief] مدل جواب نداد:', e.message); }
  }
  if (!text) text = templateText(f);
  if (!text) return null;

  db.saveBrief(day, text, f, source, model);
  console.log('[brief] ' + day + ' (' + source + '): ' + text.slice(0, 90) + '…');
  return { day, text, source, facts: f };
}

function startBriefScheduler(hours) {
  const h = hours || 6;
  setTimeout(() => generate().catch(e => console.error('[brief]', e.message)), 4 * 60 * 1000);
  setInterval(() => generate().catch(e => console.error('[brief]', e.message)), h * 3600 * 1000);
  console.log('[brief] زمان‌بند روایت روزانه فعال — هر ' + h + ' ساعت');
}

module.exports = { generate, gatherFacts, templateText, startBriefScheduler };

if (require.main === module) {
  require('dotenv').config();
  generate().then(r => { console.log(r ? JSON.stringify(r, null, 1).slice(0, 1500) : 'چیزی تولید نشد'); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
