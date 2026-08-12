/**
 * insights-series.js — ساختن سری‌های زمانی روزانه از همه‌ی ماژول‌ها
 *
 * هر ماژول شکل داده‌ی خودش را دارد؛ اینجا همه به یک شکل مشترک درمی‌آیند:
 * { key, label, unit, points: Map<'YYYY-MM-DD', number> }
 *
 * قاعده‌ی مقدار روزانه: برای قیمت، آخرین مقدار آن روز (بستن)؛ برای شمارش،
 * جمع یا مقدار ثبت‌شده‌ی همان روز.
 */
const path = require('path');
const Database = require('better-sqlite3');

function open(name) {
  try { return new Database(path.join(__dirname, 'data', name), { readonly: true }); }
  catch (e) { return null; }
}

const SYM_LABEL = {
  dollar: 'دلار', usd: 'دلار', gold18: 'طلای ۱۸ عیار', coin: 'سکه امامی',
  coin_emami: 'سکه امامی', mesghal: 'مثقال طلا', ounce: 'انس جهانی طلا',
  bitcoin: 'بیت‌کوین', btc: 'بیت‌کوین', ethereum: 'اتریوم', bourse: 'بورس تهران',
  tehran_index: 'بورس تهران', oil_brent: 'نفت برنت', eur: 'یورو', euro: 'یورو',
};

/** کف روز به وقت محلی کافی نیست؛ همه‌ی زمان‌ها UTC ذخیره شده‌اند */
const dayOf = ts => String(ts || '').slice(0, 10);

function addSeries(out, key, label, unit, kind) {
  const s = { key, label, unit, kind: kind || 'price', points: new Map() };
  out.push(s);
  return s;
}

function buildAll() {
  const out = [];

  /* ── بازارهای مالی ── */
  const fin = open('finance.db');
  if (fin) {
    try {
      // نمادهایی که واقعاً تاریخچه دارند
      const syms = fin.prepare(`
        SELECT symbol, COUNT(DISTINCT substr(timestamp,1,10)) d
        FROM finance_snapshots WHERE price > 0
        GROUP BY symbol HAVING d >= 20 ORDER BY d DESC LIMIT 14
      `).all();
      for (const { symbol } of syms) {
        /* «آخرین قیمت هر روز» را با زیرپرس‌وجوی همبسته گرفتن، روی ۲۴۴ هزار
           ردیف عملاً تمام‌نشدنی است. یک اسکن مرتب‌شده و نگه‌داشتن آخرین
           مقدار هر روز در جاوااسکریپت، همان نتیجه را در یک گذر می‌دهد. */
        const rows = fin.prepare(
          'SELECT substr(timestamp,1,10) day, price, name FROM finance_snapshots ' +
          'WHERE symbol = ? AND price > 0 ORDER BY timestamp'
        ).all(symbol);
        if (rows.length < 20) continue;
        const label = SYM_LABEL[symbol] || (rows[0] && rows[0].name) || symbol;
        const s = addSeries(out, 'fin:' + symbol, label, 'قیمت', 'price');
        for (const r of rows) s.points.set(r.day, r.price);   // هر روز با آخرین مقدارش بازنویسی می‌شود
      }
    } catch (e) { console.warn('[insights/fin]', e.message); }
    fin.close();
  }

  /* ── ترند جستجو ── */
  const tr = open('trends.db');
  if (tr) {
    try {
      // حجم کل جستجوی ترندشده در روز — نبض کنجکاوی عمومی
      const tot = tr.prepare(`
        SELECT snap_date day, SUM(vol) v FROM trend_snapshots
        WHERE snap_date IS NOT NULL AND vol > 0 GROUP BY snap_date ORDER BY day
      `).all();
      if (tot.length >= 20) {
        const s = addSeries(out, 'trend:total', 'حجم کل جستجوهای ترند', 'جستجو', 'count');
        for (const r of tot) s.points.set(r.day, r.v);
      }
      // کلیدواژه‌هایی که در بیشتر روزها حضور داشته‌اند
      const kws = tr.prepare(`
        SELECT keyword, COUNT(DISTINCT snap_date) d FROM trend_snapshots
        WHERE vol > 0 AND snap_date IS NOT NULL
        GROUP BY keyword HAVING d >= 25 ORDER BY d DESC LIMIT 10
      `).all();
      for (const { keyword } of kws) {
        const rows = tr.prepare(`
          SELECT snap_date day, MAX(vol) v FROM trend_snapshots
          WHERE keyword = ? AND vol > 0 GROUP BY snap_date ORDER BY day
        `).all(keyword);
        if (rows.length < 20) continue;
        const s = addSeries(out, 'trend:' + keyword, 'جستجوی «' + keyword + '»', 'جستجو', 'count');
        for (const r of rows) s.points.set(r.day, r.v);
      }
    } catch (e) { console.warn('[insights/trend]', e.message); }
    tr.close();
  }

  /* ── حجم خبر ── */
  const nw = open('news.db');
  if (nw) {
    try {
      const rows = nw.prepare(`
        SELECT substr(published_at,1,10) day, COUNT(*) c FROM news
        WHERE COALESCE(blocked,0)=0 AND published_at IS NOT NULL
        GROUP BY day ORDER BY day
      `).all();
      if (rows.length >= 20) {
        const s = addSeries(out, 'news:count', 'تعداد خبر منتشرشده', 'خبر', 'count');
        for (const r of rows) s.points.set(r.day, r.c);
      }
    } catch (e) { console.warn('[insights/news]', e.message); }
    nw.close();
  }

  /* ── بازار کار ── */
  const jb = open('jobs.db');
  if (jb) {
    try {
      const rows = jb.prepare(`
        SELECT snap_date day, SUM(count) c FROM job_snapshots
        WHERE category='total' GROUP BY snap_date ORDER BY day
      `).all();
      if (rows.length >= 20) {
        const s = addSeries(out, 'jobs:total', 'کل آگهی‌های استخدام', 'آگهی', 'count');
        for (const r of rows) s.points.set(r.day, r.c);
      }
    } catch (e) { console.warn('[insights/jobs]', e.message); }
    jb.close();
  }

  /* ── خودرو ── */
  const cr = open('cars.db');
  if (cr) {
    try {
      const models = cr.prepare(`
        SELECT s.model_id, m.name_fa, COUNT(DISTINCT s.snap_date) d
        FROM car_snapshots s JOIN car_models m ON m.id = s.model_id
        WHERE s.median_price > 0 GROUP BY s.model_id HAVING d >= 20
      `).all();
      for (const m of models) {
        const rows = cr.prepare(`
          SELECT snap_date day, AVG(median_price) v FROM car_snapshots
          WHERE model_id = ? AND median_price > 0 GROUP BY snap_date ORDER BY day
        `).all(m.model_id);
        if (rows.length < 20) continue;
        const s = addSeries(out, 'car:' + m.model_id, 'قیمت ' + m.name_fa, 'تومان', 'price');
        for (const r of rows) s.points.set(r.day, r.v);
      }
    } catch (e) { console.warn('[insights/cars]', e.message); }
    cr.close();
  }

  /* ── ملک ── */
  const pr = open('property.db');
  if (pr) {
    try {
      const rows = pr.prepare(`
        SELECT day, AVG(meter) v FROM property_snapshots WHERE meter > 0 GROUP BY day ORDER BY day
      `).all();
      if (rows.length >= 20) {
        const s = addSeries(out, 'prop:avg', 'میانگین قیمت مسکن تهران', 'تومان', 'price');
        for (const r of rows) s.points.set(r.day, r.v);
      }
    } catch (e) { console.warn('[insights/prop]', e.message); }
    pr.close();
  }

  /* ── کالا ── */
  const mk = open('market.db');
  if (mk) {
    try {
      const rows = mk.prepare(`
        SELECT snap_date day, AVG(price) v FROM snapshots WHERE price > 0 GROUP BY snap_date ORDER BY day
      `).all();
      if (rows.length >= 20) {
        const s = addSeries(out, 'market:avg', 'میانگین قیمت پرفروش‌های کالا', 'تومان', 'price');
        for (const r of rows) s.points.set(r.day, r.v);
      }
    } catch (e) { console.warn('[insights/market]', e.message); }
    mk.close();
  }

  return out.filter(s => s.points.size >= 20);
}

module.exports = { buildAll, dayOf, SYM_LABEL };
