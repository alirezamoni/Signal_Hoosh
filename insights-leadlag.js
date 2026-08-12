/**
 * insights-leadlag.js — کشف رابطه‌ی تأخیری بین ماژول‌ها
 *
 * پرسش: «وقتی X حرکت می‌کند، آیا Y چند روز بعد حرکت می‌کند؟»
 *
 * چند تصمیم روش‌شناختی که نتیجه را از حرف مفت جدا می‌کند:
 *
 * ۱) همبستگی روی *تغییرات روزانه* حساب می‌شود، نه روی سطح قیمت. دو سری
 *    که هر دو صعودی‌اند (مثل دلار و قیمت مسکن در تورم) روی سطح، همبستگی
 *    ۰٫۹۹ می‌دهند بدون اینکه هیچ رابطه‌ای داشته باشند. این «همبستگی
 *    کاذب» کلاسیک‌ترین اشتباه این نوع تحلیل است.
 *
 * ۲) نرخ برد جهت جدا از همبستگی گزارش می‌شود. همبستگی می‌گوید «چقدر
 *    هم‌حرکت‌اند»، نرخ برد می‌گوید «چند درصد مواقع جهت درست درآمده» —
 *    که چیزی است که آدم واقعاً می‌خواهد بداند.
 *
 * ۳) حرکت‌های خیلی کوچک از نرخ برد کنار گذاشته می‌شوند، وگرنه نویز
 *    صفر-نزدیک، نرخ برد را مصنوعی به ۵۰٪ می‌چسباند.
 *
 * ۴) تصحیح آزمون چندگانه: با صدها جفت-تأخیر، چند تای «معنادار» صرفاً
 *    شانسی پیدا می‌شوند. آستانه‌ی p با تعداد آزمون‌ها سخت‌تر می‌شود.
 *
 * ۵) هیچ‌کدام از این‌ها علیت را ثابت نمی‌کند. خروجی صریحاً «رابطه‌ی
 *    آماری» نامیده می‌شود و در صفحه هم همین نوشته می‌شود.
 */
const series = require('./insights-series');
const db = require('./insights-db');

const MAX_LAG = 7;
const MIN_N = 18;          // ~سه هفته هم‌پوشانی؛ کمتر از این هر عددی نویز است
const MIN_ABS_CORR = 0.35;
const MIN_HIT = 0.60;
const EPS_MOVE = 0.001;    // تغییر کمتر از ۰٫۱٪ یعنی «بی‌حرکت»
const FDR_Q = 0.10;        // نرخ کشف کاذب قابل قبول

/** تبدیل سری سطح به تغییر نسبی روزانه؛ سری شمارشی هم نسبی حساب می‌شود */
function toChanges(points) {
  const days = [...points.keys()].sort();
  const out = new Map();
  for (let i = 1; i < days.length; i++) {
    const a = points.get(days[i - 1]), b = points.get(days[i]);
    if (!a || !isFinite(a) || !isFinite(b)) continue;
    // فاصله‌ی بیش از ۳ روز یعنی وقفه‌ی داده، نه تغییر واقعی
    const gap = (new Date(days[i]) - new Date(days[i - 1])) / 86400000;
    if (gap > 3) continue;
    out.set(days[i], (b - a) / a);
  }
  return out;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den ? num / den : 0;
}

/** تقریب p دوطرفه از آماره‌ی t با تقریب نرمال — برای غربال کافی است */
function pValue(r, n) {
  if (n < 4 || Math.abs(r) >= 1) return 0;
  const t = Math.abs(r) * Math.sqrt((n - 2) / (1 - r * r));
  // تقریب تابع توزیع تجمعی نرمال (Zelen & Severo)
  const z = t;
  const p = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const k = 1 / (1 + 0.2316419 * z);
  const poly = k * (0.319381530 + k * (-0.356563782 + k * (1.781477937 + k * (-1.821255978 + k * 1.330274429))));
  return Math.max(0, Math.min(1, 2 * p * poly));
}

/* جفت‌هایی که رابطه‌شان تعریفی است، نه کشف‌شده: حباب سکه از خود قیمت سکه
   محاسبه می‌شود و مثقال واحدی از همان طلای ۱۸ عیار است. نمایششان به‌عنوان
   «رابطه‌ی کشف‌شده» گمراه‌کننده است و صدر جدول را هم اشغال می‌کند. */
const TAUTOLOGIES = [
  ['fin:coin', 'fin:coin_bubble'],
  ['fin:gold18', 'fin:mesghal'],
  ['fin:gold18', 'fin:coin'],
  ['fin:mesghal', 'fin:coin'],
];
function isTautology(a, b) {
  return TAUTOLOGIES.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

function addDays(day, k) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
}

function analysePair(X, Y, lag) {
  const xs = [], ys = [];
  let hit = 0, considered = 0;
  for (const [day, xv] of X.changes) {
    const yv = Y.changes.get(addDays(day, lag));
    if (yv === undefined) continue;
    xs.push(xv); ys.push(yv);
    if (Math.abs(xv) > EPS_MOVE && Math.abs(yv) > EPS_MOVE) {
      considered++;
      if (Math.sign(xv) === Math.sign(yv)) hit++;
    }
  }
  if (xs.length < MIN_N || considered < Math.floor(MIN_N * 0.6)) return null;
  const r = pearson(xs, ys);
  let hitRate = hit / considered;
  // اگر رابطه معکوس است، «برد» یعنی جهت مخالف درست درآمده
  if (r < 0) hitRate = 1 - hitRate;
  return { corr: r, hit_rate: hitRate, n: xs.length, p_approx: pValue(r, xs.length) };
}

function run() {
  const all = series.buildAll();
  if (all.length < 2) { console.log('[leadlag] سری کافی نیست'); return { rows: [], series: all.length }; }

  for (const s of all) s.changes = toChanges(s.points);
  const usable = all.filter(s => s.changes.size >= MIN_N);

  const results = [];
  let tests = 0;
  for (const X of usable) {
    for (const Y of usable) {
      if (X.key === Y.key || isTautology(X.key, Y.key)) continue;
      for (let lag = 1; lag <= MAX_LAG; lag++) {
        const r = analysePair(X, Y, lag);
        tests++;
        if (!r) continue;
        results.push(Object.assign({
          x_key: X.key, x_label: X.label, y_key: Y.key, y_label: Y.label,
          lag_days: lag, computed_at: new Date().toISOString(),
        }, r));
      }
    }
  }

  /* غربال اول: رابطه باید هم به‌اندازه‌ی کافی قوی باشد، هم جهتش قابل اتکا،
     هم روی مشاهده‌ی کافی سوار باشد. */
  const strong = results.filter(r =>
    Math.abs(r.corr) >= MIN_ABS_CORR && r.hit_rate >= MIN_HIT && r.n >= MIN_N);

  /* غربال دوم: تصحیح آزمون چندگانه با روش بنجامینی-هوخبرگ.
     بونفرونی اینجا بیش از حد سخت‌گیر است — با هزار آزمون آستانه‌اش
     ۵×۱۰⁻⁵ می‌شود و با تاریخچه‌ی فعلی هیچ رابطه‌ای هرگز رد نمی‌شود، حتی
     رابطه‌های واقعی. BH نرخ کشف کاذب را کنترل می‌کند نه احتمال هر خطا،
     که برای غربال اکتشافی معیار درست‌تری است. */
  const sorted = strong.slice().sort((a, b) => a.p_approx - b.p_approx);
  let cutoff = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].p_approx <= ((i + 1) / Math.max(1, tests)) * FDR_Q) cutoff = i;
  }
  sorted.forEach((r, i) => { r.significant = i <= cutoff ? 1 : 0; });

  db.replaceLeadLag(sorted);
  const sig = sorted.filter(r => r.significant).length;
  console.log(`[leadlag] ${usable.length} سری · ${tests} آزمون · ${sorted.length} کاندید · ${sig} معنادار (FDR ${FDR_Q})`);
  return { rows: sorted, series: usable.length, tests, significant: sig };
}

module.exports = { run, toChanges, pearson, pValue };

if (require.main === module) {
  const r = run();
  console.log('\nقوی‌ترین‌ها:');
  r.rows.slice().sort((a, b) => Math.abs(b.corr) - Math.abs(a.corr)).slice(0, 15).forEach(x =>
    console.log(`  ${x.x_label} → ${x.y_label} | تأخیر ${x.lag_days} روز | r=${x.corr.toFixed(2)} | برد ${(x.hit_rate * 100).toFixed(0)}% | n=${x.n}`));
}
