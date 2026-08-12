/**
 * property-crawler.js — رصد روزانه‌ی قیمت مسکن ۲۲ منطقه‌ی تهران
 *
 * صفحه‌ی هر منطقه با Next.js رندر می‌شود و کل داده — قیمت تخمینی، سری
 * ماهانه، و مرز جغرافیایی — داخل بار RSC همان HTML است. پس نه به مرورگر
 * بی‌سر نیاز داریم و نه به API خصوصی؛ یک درخواست ساده‌ی HTTPS کافی است.
 * این یعنی این کرالر برخلاف کرالرهای طلا و خودرو هیچ کرومی بالا نمی‌آورد.
 */
const https = require('https');
const db = require('./property-db');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BASE = 'https://kilid.com/house-prices/tehran-region';

const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
const faNum = n => String(n).replace(/\d/g, d => FA_DIGITS[+d]);

let crawling = false;

function get(url, redirects) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'user-agent': UA, 'accept-language': 'fa-IR,fa;q=0.9', accept: 'text/html' },
      timeout: 45000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if ((redirects || 0) > 4) return reject(new Error('too many redirects'));
        return resolve(get(new URL(res.headers.location, url).href, (redirects || 0) + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let b = ''; res.setEncoding('utf8');
      res.on('data', d => b += d);
      res.on('end', () => resolve(b));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** بار RSC که Next.js تکه‌تکه داخل تگ‌های script می‌ریزد را دوباره سرهم می‌کند */
function rscOf(html) {
  let out = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) {
    try { out += JSON.parse('"' + m[1] + '"'); } catch (e) { /* تکه‌ی ناقص */ }
  }
  return out;
}

/** از یک `{` یا `[` شروع می‌کند و شیء JSON متوازن را جدا می‌کند */
function grab(s, at) {
  let depth = 0, inStr = false, esc = false;
  for (let i = at; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (inStr) { if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return s.slice(at, i + 1); }
  }
  return null;
}

function jsonAfter(rsc, key, opener) {
  const i = rsc.indexOf(key);
  if (i < 0) return null;
  const j = rsc.indexOf(opener, i + key.length - 1);
  if (j < 0) return null;
  const raw = grab(rsc, j);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/* ── ساده‌سازی مرز: داگلاس–پیوکر ──
   مرز خام هر منطقه صدها نقطه دارد. برای یک نقشه‌ی ۱۰۰۰ پیکسلی این حجم
   بی‌فایده است و فقط صفحه را سنگین می‌کند. ~۷۰ متر خطا در این مقیاس
   کمتر از یک پیکسل است. */
function perpDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  let maxD = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= tol) return [pts[0], pts[pts.length - 1]];
  return simplify(pts.slice(0, idx + 1), tol).slice(0, -1).concat(simplify(pts.slice(idx), tol));
}

/* ── نقشه ──
   تصویر استوانه‌ای ساده. در عرض جغرافیایی تهران (۳۵٫۷ درجه) طول جغرافیایی
   باید در cos(lat) ضرب شود وگرنه شهر کشیده به‌نظر می‌رسد. */
const MAP_W = 1000;

function buildMap() {
  const regions = db.getRegions().filter(r => r.polygon);
  if (!regions.length) return 0;

  const polys = regions.map(r => ({
    n: r.region_no, pts: JSON.parse(r.polygon),
    c: (r.center_lng != null && r.center_lat != null) ? [r.center_lng, r.center_lat] : null,
  }));
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const p of polys) for (const [lng, lat] of p.pts) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const k = Math.cos((minLat + maxLat) / 2 * Math.PI / 180);
  const spanX = (maxLng - minLng) * k, spanY = maxLat - minLat;
  const scale = MAP_W / spanX;
  const H = Math.round(spanY * scale);

  const px = lng => (lng - minLng) * k * scale;
  const py = lat => (maxLat - lat) * scale;

  for (const p of polys) {
    const d = p.pts.map(([lng, lat], i) =>
      (i ? 'L' : 'M') + px(lng).toFixed(1) + ' ' + py(lat).toFixed(1)).join('') + 'Z';

    // برچسب شماره روی مرکز رسمی منطقه؛ اگر نبود، میانگین نقاط مرز
    let cx, cy;
    if (p.c) { cx = px(p.c[0]); cy = py(p.c[1]); }
    else {
      cx = p.pts.reduce((s, q) => s + px(q[0]), 0) / p.pts.length;
      cy = p.pts.reduce((s, q) => s + py(q[1]), 0) / p.pts.length;
    }
    db.setSvgPath(p.n, d, Math.round(cx * 10) / 10, Math.round(cy * 10) / 10);
  }

  db.setMeta('map_viewbox', '0 0 ' + MAP_W + ' ' + H);
  return polys.length;
}

/* ── یک منطقه ── */

async function crawlRegion(n) {
  const t0 = Date.now();
  try {
    const html = await get(BASE + n);
    const rsc = rscOf(html);
    if (!rsc) throw new Error('بار RSC خالی بود');

    const extId = (html.match(/region=(\d+)/) || [])[1] || null;

    // قیمت تخمینی — statsKind 72 متری، 71 کل واحد
    let meter = null, unit = null;
    const stats = jsonAfter(rsc, '"stats":[', '[');
    if (stats) {
      for (const g of stats) for (const c of (g.content || [])) {
        if (c.statsKind === 72 && c.value > 0) meter = c.value;
        if (c.statsKind === 71 && c.value > 0) unit = c.value;
      }
    }

    // سری ماهانه
    const trends = jsonAfter(rsc, '"trends":[', '[');
    const points = (trends || [])
      .filter(t => t && t.date && t.value > 0)
      .map(t => ({
        date: String(t.date).slice(0, 10),
        period: String(t.periodSymbol || '').replace(/\s*-\s*/, ' ').trim() || null,
        value: t.value,
      }));

    // مرز و مرکز
    let polygon = null, cLng = null, cLat = null;
    const poly = jsonAfter(rsc, '"polygon"', '{');
    if (poly && Array.isArray(poly.coordinates) && poly.coordinates.length > 3) {
      const pts = poly.coordinates.filter(p => Array.isArray(p) && p.length === 2);
      polygon = simplify(pts, 0.0008).map(p => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5]);
    }
    const pt = jsonAfter(rsc, '"point"', '{');
    if (pt && Array.isArray(pt.coordinate)) { cLng = pt.coordinate[0]; cLat = pt.coordinate[1]; }

    // محله‌های شاخص — برای پیوند داخلی و توصیف صفحه
    let areas = null;
    const rel = jsonAfter(rsc, '"bigAreaRelated"', '[');
    if (Array.isArray(rel)) {
      areas = rel.map(a => a && a.nameLocal).filter(Boolean).slice(0, 12);
      if (!areas.length) areas = null;
    }

    if (meter == null && !points.length) throw new Error('نه قیمت تخمینی بود نه سری ماهانه');

    /* چند منطقه ارزیابی مستقیم ندارند ولی سری ماهانه‌شان به‌روز است. به‌جای
       اینکه روی نقشه سوراخ بماند، آخرین نقطه‌ی سری را — اگر تازه باشد —
       به‌عنوان تخمین می‌گیریم و علامت می‌زنیم تا در نمایش شفاف بماند. */
    let est = false;
    if (meter == null && points.length) {
      const last = points[points.length - 1];
      const ageDays = (Date.now() - new Date(last.date).getTime()) / 86400000;
      if (ageDays <= 75) { meter = last.value; est = true; }
    }

    db.upsertRegion({
      region_no: n, ext_id: extId, name_fa: 'منطقه ' + faNum(n),
      slug: 'region' + n, center_lng: cLng, center_lat: cLat, polygon, areas,
    });
    if (meter != null || unit != null) db.saveSnapshot(n, meter, unit, est);
    if (points.length) db.saveTrends(n, points);
    db.setStatus(n, { ok: true, ms: Date.now() - t0 });

    return { n, ok: true, meter, unit, est, trends: points.length, poly: polygon ? polygon.length : 0 };
  } catch (e) {
    db.setStatus(n, { ok: false, error: e.message, ms: Date.now() - t0 });
    return { n, ok: false, error: e.message };
  }
}

/* ── اجرای کامل ── */

async function crawlAll() {
  if (crawling) { console.log('[property] اجرای قبلی هنوز تمام نشده — رد شد'); return null; }
  crawling = true;
  const t0 = Date.now();
  const out = [];
  try {
    for (let n = 1; n <= 22; n++) {
      out.push(await crawlRegion(n));
      await new Promise(r => setTimeout(r, 1200));   // فشار نیاوردن به منبع
    }
    const mapped = buildMap();
    db.cleanup(1095);
    const ok = out.filter(o => o.ok).length;
    console.log(`[property] ${ok}/22 منطقه · نقشه ${mapped} · ${Math.round((Date.now() - t0) / 1000)} ثانیه`);
    const bad = out.filter(o => !o.ok);
    if (bad.length) console.warn('[property] ناموفق:', bad.map(b => b.n + '(' + b.error + ')').join(', '));
  } finally { crawling = false; }
  return out;
}

/** روزی یک‌بار؛ اولین اجرا با تأخیر تا با بوت شدن بقیه‌ی کرالرها تداخل نکند */
function startPropertyScheduler(hours) {
  const h = hours || 24;
  setTimeout(() => { crawlAll().catch(e => console.error('[property]', e.message)); }, 90 * 1000);
  setInterval(() => { crawlAll().catch(e => console.error('[property]', e.message)); }, h * 3600 * 1000);
  console.log(`[property] زمان‌بند فعال — هر ${h} ساعت`);
}

module.exports = { crawlAll, crawlRegion, buildMap, startPropertyScheduler };

if (require.main === module) {
  crawlAll().then(r => { console.log(JSON.stringify(r, null, 1)); process.exit(0); });
}
