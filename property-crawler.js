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

/* ── یک منطقه ──
 *
 * ⚠️ kilid.com در اوت ۲۰۲۶ صفحه‌ی قیمت منطقه را بازطراحی کرد و همه‌ی
 * کلیدهایی که این کرالر می‌خواند (stats/statsKind، trends/periodSymbol،
 * polygon، bigAreaRelated) از بار RSC حذف شدند. از ۳۱ اوت هر ۲۲ منطقه
 * «نه قیمت تخمینی بود نه سری ماهانه» می‌داد و /property ده روز داده‌ی کهنه
 * نشان می‌داد — در حالی که داشبورد سبز بود (mtime، نه ردیف واقعی).
 *
 * ساختار جدید یک «شاخص قیمت مسکن» است. داده‌ی منطقه در شیئی است که کلید
 * total دارد:
 *   total.pricePsmMedian    میانه‌ی قیمت هر متر، تومان       → meter
 *   total.priceTotalMedian  میانه‌ی قیمت کل واحد، تومان      → unit
 *   rows[]                  محله‌ها، هرکدام با قیمت خودش     → areas
 *   area.point {lat, lon}   مرکز منطقه (lon، نه lng)
 * و سری ماهانه در شیء دیگری با همان areaId:
 *   points[] = {periodCode: "1405-05", value}   ← سال و ماهِ شمسی
 *
 * ⚠️ روش هم عوض شده، نه فقط شکل. برآورد قبلی منطقه‌ی ۱ حدود ۲۳۴ میلیون
 * تومان بر متر بود؛ شاخص جدید برای همان ماه ۴۹۰ میلیون می‌گوید. سری قدیمی
 * هم در آذر ۱۴۰۳ متوقف شده بود. پس سری هر منطقه جایگزین می‌شود نه الحاق —
 * propertyModel رشد را از اولین تا آخرین نقطه می‌گیرد و مخلوط دو روش آن را
 * بی‌معنا می‌کرد.
 *
 * مرز جغرافیایی دیگر در صفحه نیست. upsertRegion با COALESCE مرزِ ذخیره‌شده
 * را نگه می‌دارد، پس نقشه سالم می‌ماند.
 */

const FA_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
                   'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

// تقویم شمسی را ICU خود Node دارد؛ کتابخانه‌ی جدا لازم نیست
const PERSIAN_FMT = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
  timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric',
});

function persianParts(ms) {
  const o = {};
  for (const p of PERSIAN_FMT.formatToParts(new Date(ms))) {
    if (p.type === 'year' || p.type === 'month' || p.type === 'day') o[p.type] = parseInt(p.value, 10);
  }
  return o;
}

/** روز اولِ یک ماه شمسی، به میلادی (YYYY-MM-DD) — همان قراردادی که سری قدیمی داشت. */
function jalaliMonthStart(jy, jm) {
  // فروردین حدود ۲۱ مارس شروع می‌شود؛ از کمی قبل از تخمین، روزبه‌روز جلو می‌رویم
  const approx = Date.UTC(jy + 621, 2, 21) + ((jm - 1) * 30.5 - 8) * 86400000;
  for (let k = 0; k < 50; k++) {
    const ms = approx + k * 86400000;
    const p = persianParts(ms);
    if (p.year === jy && p.month === jm && p.day === 1) return new Date(ms).toISOString().slice(0, 10);
  }
  return null;
}

function findObj(node, test, depth) {
  depth = depth || 0;
  if (!node || typeof node !== 'object' || depth > 60) return null;
  if (!Array.isArray(node) && test(node)) return node;
  for (const v of (Array.isArray(node) ? node : Object.values(node))) {
    const r = findObj(v, test, depth + 1);
    if (r) return r;
  }
  return null;
}

/** هر خطِ بار RSC به شکل «شناسه:JSON» است؛ همه‌ی خط‌های قابل‌پارس. */
function rscTrees(rsc) {
  const out = [];
  for (const line of rsc.split('\n')) {
    const c = line.indexOf(':');
    if (c < 1) continue;
    const body = line.slice(c + 1);
    if (body[0] !== '{' && body[0] !== '[') continue;
    try { out.push(JSON.parse(body)); } catch (e) { /* خط ناقص */ }
  }
  return out;
}

const posNum = v => (typeof v === 'number' && isFinite(v) && v > 0) ? v : null;

/** بدون نوشتن در دیتابیس — جدا شده تا روی HTML ذخیره‌شده قابل آزمایش باشد. */
function parseRegion(html) {
  const rsc = rscOf(html);
  if (!rsc) throw new Error('بار RSC خالی بود');
  const trees = rscTrees(rsc);

  let hub = null;
  for (const t of trees) {
    hub = findObj(t, o => o.total && typeof o.total === 'object' && 'pricePsmMedian' in o.total);
    if (hub) break;
  }
  if (!hub) return { meter: null, unit: null, points: [], cLat: null, cLng: null, areas: null, trust: null };

  const total = hub.total;
  let cLat = null, cLng = null;
  const pt = hub.area && hub.area.point;
  if (pt && typeof pt.lat === 'number' && typeof pt.lon === 'number') { cLat = pt.lat; cLng = pt.lon; }

  // محله‌های شاخص — برای پیوند داخلی و توصیف صفحه
  let areas = null;
  if (Array.isArray(hub.rows)) {
    areas = hub.rows.map(r => r && r.name).filter(Boolean).slice(0, 12);
    if (!areas.length) areas = null;
  }

  let series = null;
  for (const t of trees) {
    series = findObj(t, o => o.areaId === total.areaId && Array.isArray(o.points) &&
      o.points.length && o.points[0] && 'periodCode' in o.points[0]);
    if (series) break;
  }
  const points = [];
  for (const p of (series ? series.points : [])) {
    const m = /^(\d{4})-(\d{1,2})$/.exec(String((p && p.periodCode) || ''));
    const v = posNum(p && p.value);
    if (!m || v == null) continue;
    const jy = +m[1], jm = +m[2];
    const date = jalaliMonthStart(jy, jm);
    if (!date) continue;
    points.push({ date, period: FA_MONTHS[jm - 1] + ' ' + jy, value: v });
  }
  points.sort((a, b) => a.date.localeCompare(b.date));

  return {
    meter: posNum(total.pricePsmMedian),
    unit: posNum(total.priceTotalMedian),
    points, cLat, cLng, areas,
    trust: total.trust || null,
  };
}

async function crawlRegion(n) {
  const t0 = Date.now();
  try {
    const html = await get(BASE + n);
    const r = parseRegion(html);
    let meter = r.meter, est = false;
    const unit = r.unit, points = r.points;

    if (meter == null && !points.length) throw new Error('نه قیمت تخمینی بود نه سری ماهانه');

    /* اگر میانه‌ی دوره نبود ولی سری ماهانه تازه است، آخرین نقطه‌ی سری را
       به‌عنوان تخمین می‌گیریم و علامت می‌زنیم تا در نمایش شفاف بماند. */
    if (meter == null && points.length) {
      const last = points[points.length - 1];
      const ageDays = (Date.now() - new Date(last.date).getTime()) / 86400000;
      if (ageDays <= 75) { meter = last.value; est = true; }
    }

    // ext_id و polygon عمداً null — COALESCE مقدار ذخیره‌شده را نگه می‌دارد
    db.upsertRegion({
      region_no: n, ext_id: null, name_fa: 'منطقه ' + faNum(n),
      slug: 'region' + n, center_lng: r.cLng, center_lat: r.cLat, polygon: null, areas: r.areas,
    });
    if (meter != null || unit != null) db.saveSnapshot(n, meter, unit, est);
    // با کمتر از دو نقطه سری قبلی دست نمی‌خورد؛ پارس ناقص نباید تاریخچه را پاک کند
    if (points.length >= 2) db.replaceTrends(n, points);
    db.setStatus(n, { ok: true, ms: Date.now() - t0 });

    return { n, ok: true, meter, unit, est, trends: points.length, trust: r.trust, areas: r.areas ? r.areas.length : 0 };
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

module.exports = { crawlAll, crawlRegion, buildMap, startPropertyScheduler, parseRegion, jalaliMonthStart };

if (require.main === module) {
  crawlAll().then(r => { console.log(JSON.stringify(r, null, 1)); process.exit(0); });
}
