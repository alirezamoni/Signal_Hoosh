/**
 * timeline-skill.js — کارنامه‌ی صادقانه‌ی موتور پیش‌بینی
 *
 * «۴۰ درصد جهت‌ها درست بوده» به‌تنهایی هیچ معنایی ندارد. سؤال درست این
 * است: آیا از حدس تصادفی بهتر است؟ اگر یک نماد در ۶۰٪ روزها بالا برود،
 * مدلی که همیشه «بالا» بگوید ۶۰٪ دقت می‌گیرد بدون یک ذره مهارت.
 *
 * پس دقت را در برابر دو مبنا می‌سنجیم:
 *   - مبنای اکثریت: همیشه جهت غالب تاریخی را گفتن
 *   - مبنای تصادفی: ۵۰٪
 *
 * و آزمون دوجمله‌ای می‌گوید فاصله‌ی این دو می‌تواند شانسی باشد یا نه.
 * اگر مهارت اثبات‌شده‌ای نیست، صفحه باید همین را بگوید.
 */
const path = require('path');
const Database = require('better-sqlite3');

function open() {
  try { return new Database(path.join(__dirname, 'data', 'timeline.db'), { readonly: true }); }
  catch (e) { return null; }
}

/** احتمال دیدن k یا بیشتر موفقیت از n پرتاب سکه با احتمال p */
function binomTailGE(k, n, p) {
  if (n <= 0) return 1;
  // لگاریتمی، چون فاکتوریل n بزرگ سرریز می‌کند
  const logC = (n, r) => {
    let s = 0;
    for (let i = 1; i <= r; i++) s += Math.log(n - r + i) - Math.log(i);
    return s;
  };
  let tail = 0;
  for (let i = Math.ceil(k); i <= n; i++) {
    tail += Math.exp(logC(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.min(1, Math.max(0, tail));
}

function compute() {
  const db = open();
  if (!db) return null;
  try {
    const rows = db.prepare(`
      SELECT p.target, p.time_horizon, p.direction, p.confidence,
             v.direction_correct, v.actual_direction, v.skill_score, v.magnitude_in_range
      FROM prediction_validations v JOIN predictions p ON p.id = v.prediction_id
    `).all();
    if (!rows.length) return { n: 0, verdict: 'no_data' };

    const n = rows.length;
    const correct = rows.filter(r => r.direction_correct).length;
    const acc = correct / n;

    // مبنای اکثریت: پرتکرارترین جهت *واقعی* در همین نمونه
    const dirCount = {};
    for (const r of rows) {
      const d = r.actual_direction || 'flat';
      dirCount[d] = (dirCount[d] || 0) + 1;
    }
    const majorityN = Math.max(...Object.values(dirCount));
    const majorityBase = majorityN / n;

    /* مقایسه با سکه فقط وقتی منصفانه است که بازار واقعاً حرکت کرده باشد.
       نتیجه‌ی واقعی سه حالت دارد (بالا/پایین/بی‌حرکت) و «بی‌حرکت» یعنی
       حرکت کمتر از ۰٫۲٪. در افق کوتاه، اغلبِ واقعیت بی‌حرکت است و مدلی
       که جهت قطعی می‌دهد تقریباً همیشه غلط می‌شود — این ضعفِ انتخاب افق
       است، نه لزوماً ضعف سیگنال. پس دو عدد جدا گزارش می‌شود:
         - دقت خام روی همه‌ی موارد
         - دقت مشروط: فقط روزهایی که بازار واقعاً حرکت کرده و مدل هم جهت داده */
    const directional = rows.filter(r => r.direction === 'up' || r.direction === 'down');
    const moved = directional.filter(r => r.actual_direction === 'up' || r.actual_direction === 'down');
    const movedCorrect = moved.filter(r => r.direction_correct).length;
    const coinP = moved.length ? binomTailGE(movedCorrect, moved.length, 0.5) : 1;
    const majP = binomTailGE(correct, n, majorityBase);
    const flatShare = n ? rows.filter(r => r.actual_direction === 'flat').length / n : 0;

    const inRange = rows.filter(r => r.magnitude_in_range).length;
    const avgSkill = rows.reduce((s, r) => s + (r.skill_score || 0), 0) / n;

    const beatsCoin = moved.length >= 20 && movedCorrect / moved.length > 0.5 && coinP < 0.05;
    const beatsMajority = acc > majorityBase && majP < 0.05;

    let verdict = 'no_skill';
    if (n < 30 || moved.length < 20) verdict = 'too_few';
    else if (beatsCoin && beatsMajority) verdict = 'skill';
    else if (beatsCoin || beatsMajority) verdict = 'weak';

    const byTarget = db.prepare(`
      SELECT p.target, COUNT(*) n, SUM(v.direction_correct) c, AVG(v.skill_score) skill
      FROM prediction_validations v JOIN predictions p ON p.id = v.prediction_id
      GROUP BY p.target HAVING n >= 5 ORDER BY n DESC
    `).all().map(t => ({
      target: t.target, n: t.n, correct: t.c,
      accPct: Math.round((t.c / t.n) * 100),
      skill: t.skill,
    }));

    return {
      n, correct, accPct: Math.round(acc * 1000) / 10,
      majorityPct: Math.round(majorityBase * 1000) / 10,
      directionalN: directional.length,
      movedN: moved.length,
      movedAccPct: moved.length ? Math.round((movedCorrect / moved.length) * 1000) / 10 : null,
      flatSharePct: Math.round(flatShare * 1000) / 10,
      coinP, majP,
      inRangePct: Math.round((inRange / n) * 1000) / 10,
      avgSkill: Math.round(avgSkill * 1000) / 1000,
      verdict, byTarget,
    };
  } catch (e) {
    console.warn('[tl-skill]', e.message);
    return null;
  } finally { db.close(); }
}

const VERDICT_FA = {
  skill: 'این موتور در نمونه‌ی فعلی از حدس تصادفی و از «همیشه جهت غالب» بهتر عمل کرده است.',
  weak: 'این موتور فقط از یکی از دو مبنا بهتر بوده؛ برای نتیجه‌گیری قطعی هنوز زود است.',
  no_skill: 'در نمونه‌ی فعلی، این موتور از حدس تصادفی بهتر عمل نکرده است. اعداد این بخش را به‌عنوان پیش‌بینی قابل اتکا در نظر نگیرید.',
  too_few: 'تعداد پیش‌بینی‌های اعتبارسنجی‌شده هنوز برای قضاوت درباره‌ی دقت کافی نیست.',
  no_data: 'هنوز هیچ پیش‌بینی‌ای اعتبارسنجی نشده است.',
};

module.exports = { compute, VERDICT_FA, binomTailGE };

if (require.main === module) {
  const r = compute();
  console.log(JSON.stringify(r, null, 1));
  if (r) console.log('\nحکم:', VERDICT_FA[r.verdict]);
}
