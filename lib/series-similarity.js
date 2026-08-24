/**
 * lib/series-similarity.js — «کدام سری شبیه کدام حرکت می‌کند؟»
 *
 * روی *تغییر درصدی* همبستگی می‌گیریم، نه قیمت خام. قیمت خام همه‌ی
 * طلافروشی‌ها تقریباً یکی است و همبستگی‌اش همیشه ~۱ درمی‌آید — یعنی هیچ
 * چیزی نمی‌گوید. تغییر درصدی نشان می‌دهد چه کسی *واقعاً* پابه‌پای دیگری
 * تکان می‌خورد. روی داده‌ی واقعی ۷ روزه‌ی ۱۱ پلتفرم، r بین ۰٫۰۵- و ۰٫۹۰
 * پخش شد و هیچ جفتی بالای ۰٫۹۵ نبود، پس آمار معنادار است.
 *
 * جدا از شکلِ حرکت، «اختلاف سطح» را هم می‌دهیم: میانه‌ی درصد اختلاف قیمت
 * در لحظه‌های مشترک. این همان چیزی است که کاربر می‌خواهد ببیند —
 * «فلان‌جا مثل فلان‌جا حرکت می‌کند ولی نیم درصد گران‌تر است».
 */
const { pearson, pValue } = require('../insights-leadlag');

/**
 * نقاط را روی شبکه‌ی زمانی هم‌تراز می‌کند. بدون این، دو سری که در
 * ثانیه‌های متفاوت نمونه‌برداری شده‌اند هیچ نقطه‌ی مشترکی ندارند.
 */
function bucketize(points, bucketMs) {
  const m = new Map();
  for (const p of points || []) {
    const t = p.t != null ? p.t : p.captured_at || p.timestamp;
    const v = p.v != null ? p.v : p.price;
    if (v == null || !isFinite(v)) continue;
    const ms = typeof t === 'number' ? t : new Date(t).getTime();
    if (!isFinite(ms)) continue;
    m.set(Math.floor(ms / bucketMs), Number(v));   // آخرین مقدار هر سطل
  }
  return m;
}

function pctChanges(bucketMap) {
  const keys = [...bucketMap.keys()].sort((a, b) => a - b);
  const out = new Map();
  for (let i = 1; i < keys.length; i++) {
    const prev = bucketMap.get(keys[i - 1]);
    const cur = bucketMap.get(keys[i]);
    if (prev > 0) out.set(keys[i], (cur - prev) / prev);
  }
  return out;
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

/**
 * @param {Array<{key,label,points}>} series
 * @param {{bucketMin?:number, minShared?:number}} opts
 * @returns {{pairs:Array, loners:Array, count:number}}
 */
function compare(series, opts) {
  const o = opts || {};
  const bucketMs = (o.bucketMin || 15) * 60 * 1000;
  const minShared = o.minShared || 30;

  const prepared = [];
  for (const s of series || []) {
    const m = bucketize(s.points, bucketMs);
    if (m.size > minShared) prepared.push({ key: s.key, label: s.label, m, ch: pctChanges(m) });
  }

  const pairs = [];
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const A = prepared[i], B = prepared[j];
      const shared = [...A.ch.keys()].filter(k => B.ch.has(k));
      if (shared.length < minShared) continue;

      const r = pearson(shared.map(k => A.ch.get(k)), shared.map(k => B.ch.get(k)));
      if (r == null || !isFinite(r)) continue;

      // اختلاف سطح در لحظه‌های مشترک، برحسب درصد
      const lvl = [...A.m.keys()].filter(k => B.m.has(k) && B.m.get(k) > 0)
        .map(k => (A.m.get(k) - B.m.get(k)) / B.m.get(k) * 100);
      const gap = median(lvl);

      // همیشه گران‌تر را سمت چپ بگذار تا خواندنش یکدست باشد
      const flip = gap != null && gap < 0;
      pairs.push({
        aKey: flip ? B.key : A.key,   aLabel: flip ? B.label : A.label,
        bKey: flip ? A.key : B.key,   bLabel: flip ? A.label : B.label,
        corr: r,
        gapPct: gap == null ? null : Math.abs(gap),
        n: shared.length,
        p: pValue(r, shared.length),
      });
    }
  }

  pairs.sort((x, y) => y.corr - x.corr);

  // سری‌هایی که با هیچ‌کس هم‌حرکت نیستند — اغلب جالب‌ترین یافته‌اند
  const best = new Map();
  for (const p of pairs) {
    if (!best.has(p.aKey) || best.get(p.aKey).corr < p.corr) best.set(p.aKey, p);
    if (!best.has(p.bKey) || best.get(p.bKey).corr < p.corr) best.set(p.bKey, p);
  }
  const loners = prepared
    .filter(s => best.has(s.key) && best.get(s.key).corr < 0.3)
    .map(s => ({ key: s.key, label: s.label, bestCorr: best.get(s.key).corr }));

  return { pairs, loners, count: prepared.length };
}

module.exports = { compare, bucketize, pctChanges };
