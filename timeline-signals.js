/**
 * timeline-signals.js — سیگنال‌های مشتق‌شده از داده‌ای که همین حالا داریم
 *
 * موتور پیش‌بینی تا امروز فقط ۷ نماد را می‌دید، در حالی که سایت بیش از ۱۲۰
 * سری زمانی زنده جمع می‌کند. مهم‌تر از تعداد، *جنس* سیگنال است: همبستگی
 * بین اسپایک جستجوی فوتبال و قیمت نفت کاذب است، ولی این سه رابطه ساختاری‌اند
 * و دلیل اقتصادی روشنی دارند:
 *
 *  ۱۸) حباب طلا  — فاصله‌ی قیمت داخلی از ارزش ذاتی (انس × دلار).
 *  ۱۹) استرس بازار — پراکندگی قیمت بین پلتفرم‌های طلا.
 *  ۲۰) کالای جهانی — نفت و فلزات جهانی که اصلاً وارد موتور نمی‌شدند.
 *
 * هیچ‌کدام «پیش‌بینی» نیستند؛ اندازه‌گیری‌اند. به همین دلیل بدون دروازه‌ی
 * مهارت هم قابل نمایش‌اند — چیزی را ادعا نمی‌کنند که ثابت نشده باشد.
 */
const financeDB = require('./finance-db');

let goldDB = null, commodityDB = null;
try { goldDB = require('./gold-db'); } catch (e) {}
try { commodityDB = require('./commodity-db'); } catch (e) {}

// یک گرم طلای ۱۸ عیار = (انس/۳۱٫۱۰۳۵) × (۱۸/۲۴) × نرخ دلار
const GRAMS_PER_OUNCE = 31.1034768;
const PURITY_18K = 18 / 24;

function price(sym) {
  try { const r = financeDB.getLatestBySymbol(sym); return r && r.price ? Number(r.price) : null; }
  catch (e) { return null; }
}

// ── ۱۸) حباب طلای داخلی ─────────────────────────────────────────────
// ارزش ذاتی از انس جهانی و دلار ساخته می‌شود؛ اختلافش با قیمت واقعی بازار
// همان چیزی است که معامله‌گر ایرانی «حباب» می‌نامد. برخلاف همبستگی‌های
// کشف‌شده، این یک اتحاد حسابداری است نه الگوی آماری.
function goldBubble() {
  const ounce = price('ounce');      // دلار به ازای هر انس
  const usd = price('usd');          // ریال/تومان به ازای هر دلار
  const gold18 = price('gold18');    // قیمت داخلی هر گرم
  if (!ounce || !usd || !gold18) return null;

  const intrinsic = (ounce / GRAMS_PER_OUNCE) * PURITY_18K * usd;
  if (!intrinsic || !isFinite(intrinsic)) return null;

  const bubblePct = ((gold18 - intrinsic) / intrinsic) * 100;
  // حباب بالای ~۱۰٪ یعنی تقاضای داخلی از ارزش ذاتی جلو زده (معمولاً ترس یا
  // انتظار تورمی)؛ حباب منفی یعنی قیمت داخلی عقب مانده است.
  let state = 'عادی';
  if (bubblePct >= 15) state = 'حباب زیاد';
  else if (bubblePct >= 7) state = 'حباب محسوس';
  else if (bubblePct <= -5) state = 'زیر ارزش ذاتی';

  return {
    ounce, usd, gold18,
    intrinsic: Math.round(intrinsic),
    bubblePct: +bubblePct.toFixed(2),
    state,
    // جهت، سیگنالی است که معنای اقتصادی دارد: حباب بزرگ تاریخاً ناپایدار است
    pressure: bubblePct >= 15 ? 'down' : (bubblePct <= -5 ? 'up' : 'flat'),
  };
}

// ── ۱۹) استرس بازار از پراکندگی پلتفرم‌های طلا ───────────────────────
// وقتی بازار آرام است همه‌ی پلتفرم‌ها تقریباً هم‌قیمت‌اند. وقتی عدم قطعیت
// بالا می‌رود، فاصله‌شان باز می‌شود. این یک شاخص کلاسیک استرس است و اینجا
// داده‌اش هر ۱۰ دقیقه تازه می‌شود.
function platformStress() {
  if (!goldDB) return null;
  let rows = [];
  try { rows = goldDB.getLatest() || []; } catch (e) { return null; }
  const prices = rows.map(r => Number(r.price)).filter(p => p > 0);
  if (prices.length < 4) return null;

  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  if (!mean) return null;
  const sd = Math.sqrt(prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length);
  const cv = (sd / mean) * 100;            // ضریب تغییرات، درصد
  const min = Math.min(...prices), max = Math.max(...prices);
  const spreadPct = ((max - min) / mean) * 100;

  let state = 'آرام';
  if (cv >= 1.2) state = 'پرتنش';
  else if (cv >= 0.6) state = 'نامتعادل';

  return {
    platforms: prices.length,
    mean: Math.round(mean),
    min, max,
    spreadPct: +spreadPct.toFixed(2),
    cvPct: +cv.toFixed(3),
    state,
  };
}

// ── ۲۰) پیوند کالای جهانی ────────────────────────────────────────────
// ۹۷ قلم کالای جهانی جمع می‌شود و هیچ‌کدام وارد موتور نمی‌شد. اینجا فقط
// آن‌هایی برداشته می‌شوند که برای اقتصاد ایران معنا دارند.
const COMMODITY_WATCH = {
  'crude-oil':    { fa: 'نفت خام', link: 'oil_brent' },
  'brent-crude-oil': { fa: 'نفت برنت', link: 'oil_brent' },
  'gold':         { fa: 'طلا (جهانی)', link: 'ounce' },
  'silver':       { fa: 'نقره', link: null },
  'copper':       { fa: 'مس', link: null },
  'natural-gas':  { fa: 'گاز طبیعی', link: null },
  'wheat':        { fa: 'گندم', link: null },
  'urea':         { fa: 'اوره', link: null },
};

function commoditySignals() {
  if (!commodityDB) return [];
  let rows = [];
  try { rows = commodityDB.getLatestAll() || []; } catch (e) { return []; }
  const out = [];
  for (const r of rows) {
    const w = COMMODITY_WATCH[r.slug];
    if (!w) continue;
    out.push({
      slug: r.slug, fa: w.fa, link: w.link,
      price: r.price, changePct: r.change_pct,
      weeklyPct: r.weekly_pct, monthlyPct: r.monthly_pct,
      capturedAt: r.captured_at,
    });
  }
  return out;
}

// ── جمع‌بندی برای نمایش ──────────────────────────────────────────────
function all() {
  return {
    bubble: safe(goldBubble),
    stress: safe(platformStress),
    commodities: safe(commoditySignals) || [],
  };
}
function safe(fn) { try { return fn(); } catch (e) { return null; } }

module.exports = { goldBubble, platformStress, commoditySignals, all, COMMODITY_WATCH };
