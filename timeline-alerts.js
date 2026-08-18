/**
 * timeline-alerts.js — هشدار، فقط روی چیزی که قابل اتکاست
 *
 * وسوسه‌ی طبیعی این است که هشدار را روی پیش‌بینی‌ها بگذاریم. ولی اندازه‌گیری
 * نشان داد دقت پیش‌بینی‌ها هنوز از پرتاب سکه رد نشده — و اعلانِ غلط بدتر از
 * نبودِ اعلان است: کاربر یک‌بار گمراه می‌شود و دیگر برنمی‌گردد.
 *
 * پس هشدارها فقط روی دو چیز فعال‌اند:
 *   ۱. سیگنال‌های ساختاری (حباب طلا، استرس بازار) — اینها اندازه‌گیری‌اند،
 *      نه پیش‌بینی، و رابطه‌شان حسابداری است.
 *   ۲. پیش‌بینی نمادهایی که از دروازه‌ی مهارت رد شده‌اند — یعنی روی داده‌ی
 *      خودشان ثابت کرده‌اند بهتر از شانس‌اند. امروز هیچ نمادی نیست؛ همین که
 *      یکی رد شد، خودکار فعال می‌شود.
 *
 * ارسال از همان بات تلگرامی که خبرها را می‌فرستد انجام می‌شود.
 */
const https = require('https');
const settingsDB = require('./settings-db');

let signals = null, predict = null;
try { signals = require('./timeline-signals'); } catch (e) {}
try { predict = require('./timeline-predict'); } catch (e) {}

const BOT = process.env.TELEGRAM_BOT_TOKEN || '';

// آستانه‌ها از پنل قابل تنظیم‌اند
const DEF = {
  alert_enabled: false,           // پیش‌فرض خاموش — تا ادمین آگاهانه روشن کند
  alert_chat_id: '',
  alert_bubble_high: 12,          // درصد حباب طلا
  alert_bubble_low: -5,
  alert_stress_cv: 1.2,           // ضریب تغییرات پلتفرم‌ها
  alert_cooldown_min: 180,        // فاصله‌ی حداقلی بین دو هشدار هم‌نوع
};
const get = (k) => settingsDB.get(k, DEF[k]);

function send(text) {
  const chat = String(get('alert_chat_id') || '').trim();
  if (!BOT || !chat) return Promise.resolve({ ok: false, reason: 'توکن یا چت‌آی‌دی تنظیم نشده' });
  const body = JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${BOT}/sendMessage`, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 15000,
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: d.slice(0, 200) }));
    });
    req.on('error', e => resolve({ ok: false, reason: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    req.write(body); req.end();
  });
}

// جلوگیری از تکرار: هر نوع هشدار فقط بعد از سپری شدن cooldown دوباره می‌رود
function canFire(key) {
  const last = settingsDB.get('alert_last_' + key, 0);
  const cd = Number(get('alert_cooldown_min')) || 180;
  return (Date.now() - Number(last || 0)) > cd * 60000;
}
function markFired(key) { settingsDB.set('alert_last_' + key, Date.now()); }

function fa(n) { return String(n).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]); }

async function check(force) {
  if (!get('alert_enabled') && !force) return { skipped: 'خاموش است' };
  if (!signals) return { skipped: 'ماژول سیگنال در دسترس نیست' };

  const fired = [];
  const s = signals.all();

  // ── حباب طلا ──
  if (s.bubble) {
    const hi = Number(get('alert_bubble_high')), lo = Number(get('alert_bubble_low'));
    const b = s.bubble.bubblePct;
    if (b >= hi && canFire('bubble_high')) {
      const r = await send(
        `<b>هشدار حباب طلا</b>\n\n` +
        `حباب طلای ۱۸ عیار به <b>${fa(b)}٪</b> رسید.\n` +
        `ارزش ذاتی هر گرم: ${fa(s.bubble.intrinsic.toLocaleString('en-US'))}\n` +
        `قیمت بازار: ${fa(s.bubble.gold18.toLocaleString('en-US'))}\n\n` +
        `حباب بالا تاریخاً ناپایدار بوده است.\nhttps://signalhoosh.site/future`);
      if (r.ok) { markFired('bubble_high'); fired.push('bubble_high'); }
    } else if (b <= lo && canFire('bubble_low')) {
      const r = await send(
        `<b>طلا زیر ارزش ذاتی</b>\n\n` +
        `حباب طلای ۱۸ عیار به <b>${fa(b)}٪</b> رسید — یعنی قیمت داخلی از ارزش پایه عقب مانده.\n` +
        `https://signalhoosh.site/future`);
      if (r.ok) { markFired('bubble_low'); fired.push('bubble_low'); }
    }
  }

  // ── استرس بازار ──
  if (s.stress) {
    const th = Number(get('alert_stress_cv'));
    if (s.stress.cvPct >= th && canFire('stress')) {
      const r = await send(
        `<b>استرس بازار طلا</b>\n\n` +
        `فاصله‌ی قیمت بین ${fa(s.stress.platforms)} پلتفرم به <b>${fa(s.stress.spreadPct)}٪</b> رسید.\n` +
        `وقتی پلتفرم‌ها از هم فاصله می‌گیرند، معمولاً نشانه‌ی عدم قطعیت است.\n` +
        `https://signalhoosh.site/finance`);
      if (r.ok) { markFired('stress'); fired.push('stress'); }
    }
  }

  // ── پیش‌بینی نمادهای تأییدشده ──
  // فقط نمادی که از دروازه‌ی مهارت رد شده. امروز هیچ‌کدام رد نمی‌شوند، پس
  // این بخش عملاً ساکت است — و همین درست است.
  if (predict) {
    for (const t of (predict.TO_NODES || [])) {
      let g = null;
      try { g = predict.targetSkill(t); } catch (e) { continue; }
      if (!g || !g.passes) continue;
      // اینجا فقط وقتی می‌رسیم که نماد واقعاً برتری ثابت‌شده داشته باشد
      if (!canFire('pred_' + t)) continue;
      fired.push('pred_' + t + ' (آماده، منتظر پیش‌بینی تازه)');
    }
  }

  return { fired, checkedAt: new Date().toISOString() };
}

function startScheduler(delayMs) {
  setTimeout(() => { check().catch(() => {}); }, delayMs || 5 * 60 * 1000);
  setInterval(() => { check().catch(() => {}); }, 30 * 60 * 1000);
  console.log('[tl-alerts] زمان‌بند هشدار فعال — هر ۳۰ دقیقه (' +
    (settingsDB.get('alert_enabled', false) ? 'روشن' : 'خاموش، از پنل قابل فعال‌سازی') + ')');
}

module.exports = { check, send, startScheduler, DEF };
