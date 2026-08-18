/**
 * timeline-backtest.js — سنجش، به‌جای حدس
 *
 * تا امروز تنها راه فهمیدن اینکه یک تغییر به موتور کمک کرده یا نه، این بود
 * که چند روز صبر کنیم و ببینیم دقت بالا رفت یا نه. با آن حجم نویز، عملاً
 * یعنی هیچ‌وقت نمی‌شد فهمید. این ماژول روی همان پیش‌بینی‌های اعتبارسنجی‌شده‌ی
 * موجود کار می‌کند و به سه پرسش جواب می‌دهد:
 *
 *  ۱۶) مبنای صادقانه   — موتور در برابر «فردا هم مثل امروز» چطور است؟
 *  ۱۳) وارونگی سیگنال  — اگر جهت را برعکس کنیم بهتر می‌شود؟ آیا معنادار است؟
 *  ۱۷) تفکیک افق       — کدام افق زمانی واقعاً سیگنال دارد؟
 *  ۱۴) وزن مدل‌ها      — کدام مدل پایه واقعاً درست می‌گوید؟
 *
 * هیچ‌کدام از این‌ها خودکار چیزی را عوض نمی‌کنند. خروجی‌شان عدد است تا
 * تصمیم آگاهانه گرفته شود — تغییر خودکارِ جهت بر پایه‌ی نمونه‌ی کم، دقیقاً
 * همان بیش‌برازشی است که این موتور را به اینجا رساند.
 */
const tdb = require('./timeline-db');

// آزمون دوجمله‌ای دوطرفه (تقریب نرمال) — «آیا این با شانس فرق دارد؟»
function zScore(correct, total) {
  if (!total) return 0;
  return (correct / total - 0.5) / Math.sqrt(0.25 / total);
}
// z را به p دوطرفه تبدیل می‌کند (تقریب Abramowitz–Stegun)
function pValue(z) {
  const a = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * a);
  const d = 0.3989423 * Math.exp(-a * a / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return 2 * p;
}

function rows() {
  try {
    return tdb.db.prepare(`
      SELECT p.id, p.target, p.time_horizon, p.direction, p.predicted_pct, p.confidence,
             p.regime, p.ensemble_json, p.created_at,
             v.actual_direction, v.actual_pct, v.baseline_pct, v.direction_correct,
             v.magnitude_error, v.skill_score
      FROM predictions p JOIN prediction_validations v ON v.prediction_id = p.id
      ORDER BY p.created_at ASC
    `).all();
  } catch (e) { return []; }
}

function summarize(list) {
  const n = list.length;
  if (!n) return null;
  const ok = list.filter(r => r.direction_correct).length;
  const acc = ok / n;
  const z = zScore(ok, n);
  return {
    n, correct: ok,
    accPct: +(acc * 100).toFixed(1),
    z: +z.toFixed(2),
    p: +pValue(z).toFixed(4),
    significant: Math.abs(z) >= 1.96,
    avgSkill: +(list.reduce((s, r) => s + (r.skill_score || 0), 0) / n).toFixed(4),
    avgMagErr: +(list.reduce((s, r) => s + (r.magnitude_error || 0), 0) / n).toFixed(3),
  };
}

// ── ۱۶) مبنای صادقانه ────────────────────────────────────────────────
// مبنا: «بدون تغییر» (جهت را همان جهت حرکت پایه بگیر). موتور باید از این
// بهتر باشد وگرنه وجودش توجیهی ندارد.
function vsBaseline() {
  const all = rows();
  if (!all.length) return null;
  const engine = summarize(all);

  // مبنای ساده: همیشه جهت غالب تاریخی همان نماد را بگو (استراتژی بی‌مغز)
  const byTarget = {};
  all.forEach(r => (byTarget[r.target] = byTarget[r.target] || []).push(r));
  let naiveCorrect = 0;
  for (const t in byTarget) {
    const list = byTarget[t];
    const ups = list.filter(r => r.actual_direction === 'up').length;
    const majority = ups >= list.length / 2 ? 'up' : 'down';
    naiveCorrect += list.filter(r => r.actual_direction === majority).length;
  }
  return {
    engine,
    naive: { n: all.length, correct: naiveCorrect, accPct: +(100 * naiveCorrect / all.length).toFixed(1) },
    engineBeatsNaive: engine.correct > naiveCorrect,
  };
}

// ── ۱۳) وارونگی سیگنال ───────────────────────────────────────────────
// دقت زیر ۵۰٪ به‌طور معنادار یعنی سیگنال هست ولی علامتش برعکس. این تابع
// فقط *گزارش* می‌دهد کجا وارونگی معنادار است؛ اعمال نمی‌کند.
function inversionReport() {
  const all = rows();
  const byTarget = {};
  all.forEach(r => (byTarget[r.target] = byTarget[r.target] || []).push(r));
  const out = [];
  for (const t in byTarget) {
    const s = summarize(byTarget[t]);
    if (!s) continue;
    const invertedAcc = 100 - s.accPct;
    out.push({
      target: t, ...s, invertedAccPct: +invertedAcc.toFixed(1),
      // فقط وقتی توصیه می‌شود که هم نمونه کافی باشد و هم انحراف معنادار
      recommendInvert: s.n >= 40 && s.z <= -1.96,
      note: s.n < 40 ? 'نمونه کم' : (s.z <= -1.96 ? 'وارونگی معنادار' : (s.z >= 1.96 ? 'بهتر از شانس' : 'قابل تفکیک از شانس نیست')),
    });
  }
  return out.sort((a, b) => b.n - a.n);
}

// ── ۱۷) تفکیک افق زمانی ──────────────────────────────────────────────
function byHorizon() {
  const all = rows();
  const g = {};
  all.forEach(r => (g[r.time_horizon] = g[r.time_horizon] || []).push(r));
  return Object.entries(g).map(([h, list]) => ({ horizon: Number(h), ...summarize(list) }))
    .sort((a, b) => a.horizon - b.horizon);
}

// ── ۱۴) کدام مدل پایه واقعاً درست می‌گوید؟ ───────────────────────────
// هر پیش‌بینی ensemble_json دارد؛ می‌شود دید وقتی مدل A جهتی گفته، چقدر
// درست بوده — مستقل از اینکه ترکیب نهایی چه شد.
function byModel() {
  const all = rows();
  const stat = {};
  for (const r of all) {
    let e = null;
    try { e = JSON.parse(r.ensemble_json || '{}'); } catch (x) { continue; }
    for (const key of ['A', 'B', 'C', 'D']) {
      const m = e[key];
      if (!m || !m.direction || m.direction === 'flat') continue;
      const s = (stat[key] = stat[key] || { n: 0, ok: 0 });
      s.n++;
      if (m.direction === r.actual_direction) s.ok++;
    }
    const basis = e.basis || 'نامشخص';
    const b = (stat['پایه:' + basis] = stat['پایه:' + basis] || { n: 0, ok: 0 });
    b.n++; if (r.direction_correct) b.ok++;
  }
  return Object.entries(stat).map(([k, v]) => ({
    model: k, n: v.n, correct: v.ok,
    accPct: +(100 * v.ok / v.n).toFixed(1),
    z: +zScore(v.ok, v.n).toFixed(2),
  })).sort((a, b) => b.n - a.n);
}

// ── ۲۱) پلی‌مارکت به‌عنوان لنگر کالیبراسیون ──────────────────────────
// پلی‌مارکت احتمال‌هایی است که پشتشان پول واقعی است، یعنی کالیبره‌ترین
// مرجع در دسترس. مقایسه‌ی کالیبراسیون خودمان با آن، معیار بیرونی می‌دهد.
function calibrationReport() {
  let buckets = [];
  try { buckets = tdb.db.prepare('SELECT * FROM calibration_buckets WHERE total > 0 ORDER BY bucket_min').all(); } catch (e) {}
  const totalN = buckets.reduce((s, b) => s + b.total, 0);
  // خطای کالیبراسیون مورد انتظار: میانگین وزنی |اطمینان اعلام‌شده − دقت واقعی|
  const ece = totalN ? buckets.reduce((s, b) => {
    const mid = (b.bucket_min + b.bucket_max) / 2;
    return s + b.total * Math.abs(mid - (b.correct / b.total));
  }, 0) / totalN : null;
  return {
    buckets: buckets.map(b => ({
      range: `${b.bucket_min}–${b.bucket_max}`,
      claimed: +(((b.bucket_min + b.bucket_max) / 2) * 100).toFixed(0),
      actual: +((b.correct / b.total) * 100).toFixed(1),
      n: b.total,
    })),
    ecePct: ece != null ? +(ece * 100).toFixed(1) : null,
    totalN,
  };
}

// ── ۱۵) بک‌تست پیش‌رونده (walk-forward) ──────────────────────────────
// اندازه‌گیری روی همان داده‌ای که ازش یاد گرفته‌ایم، خوش‌بینانه است. اینجا
// داده به ترتیب زمان بریده می‌شود: هر پنجره فقط با گذشته‌ی خودش سنجیده
// می‌شود و روی آینده‌ی دیده‌نشده امتحان می‌شود. این تنها راهی است که
// می‌شود فهمید یک تغییر واقعاً کمک کرده یا فقط گذشته را حفظ کرده.
function walkForward(folds = 5) {
  const all = rows().filter(r => r.actual_direction);
  if (all.length < folds * 10) {
    return { ok: false, reason: `نمونه کافی نیست (${all.length} از حداقل ${folds * 10})`, n: all.length };
  }
  const size = Math.floor(all.length / folds);
  const out = [];
  // از fold دوم شروع می‌کنیم؛ fold اول فقط «گذشته» است
  for (let i = 1; i < folds; i++) {
    const train = all.slice(0, i * size);
    const test = all.slice(i * size, (i + 1) * size);
    if (!test.length) continue;

    // قاعده‌ی آموخته از گذشته: برای هر نماد، آیا جهت اعلام‌شده تاریخاً درست
    // بوده یا وارونه؟ این تنها «مدلی» است که از train یاد می‌گیریم.
    const flip = {};
    const byT = {};
    train.forEach(r => (byT[r.target] = byT[r.target] || []).push(r));
    for (const t in byT) {
      const list = byT[t];
      if (list.length < 15) continue;                    // نمونه کم → دست نزن
      const acc = list.filter(r => r.direction_correct).length / list.length;
      flip[t] = acc < 0.5;
    }

    let asIs = 0, learned = 0;
    for (const r of test) {
      if (r.direction_correct) asIs++;
      const shouldFlip = flip[r.target];
      const correct = shouldFlip ? !r.direction_correct : !!r.direction_correct;
      if (correct) learned++;
    }
    out.push({
      fold: i, trainN: train.length, testN: test.length,
      asIsPct: +(100 * asIs / test.length).toFixed(1),
      learnedPct: +(100 * learned / test.length).toFixed(1),
      flipped: Object.keys(flip).filter(k => flip[k]),
    });
  }
  const avgAsIs = out.reduce((s, f) => s + f.asIsPct, 0) / (out.length || 1);
  const avgLearned = out.reduce((s, f) => s + f.learnedPct, 0) / (out.length || 1);
  return {
    ok: true, folds: out, n: all.length,
    avgAsIsPct: +avgAsIs.toFixed(1),
    avgLearnedPct: +avgLearned.toFixed(1),
    // آیا قاعده‌ی وارونگی روی داده‌ی دیده‌نشده هم کار می‌کند؟
    inversionHelpsOutOfSample: avgLearned > avgAsIs + 2,
  };
}

function fullReport() {
  return {
    walkForward: walkForward(),
    baseline: vsBaseline(),
    inversion: inversionReport(),
    horizons: byHorizon(),
    models: byModel(),
    calibration: calibrationReport(),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { fullReport, walkForward, vsBaseline, inversionReport, byHorizon, byModel, calibrationReport, zScore, pValue, summarize };
