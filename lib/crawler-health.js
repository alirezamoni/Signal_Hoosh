/**
 * lib/crawler-health.js — آیا جمع‌آورنده‌ها واقعاً زنده‌اند؟
 *
 * پنل تا امروز «آخرین نوشتن» را از mtime فایل دیتابیس می‌خواند. در حالت WAL
 * فایل ‎-shm با هر بار *باز شدن* اتصال لمس می‌شود — حتی یک خواندن ساده یا
 * استارت پروسه. نتیجه: بعد از هر `pm2 restart` همه‌ی نقطه‌ها سبز می‌شوند،
 * حتی برای جمع‌آورنده‌ای که هفته‌هاست مرده است.
 *
 * نمونه‌ی واقعی، ۱۰ سپتامبر ۲۰۲۶ — همان چیزی که باعث نوشتن این فایل شد:
 *
 *     data/property.db      mtime 2026-08-31 18:11
 *     data/property.db-shm  mtime 2026-09-10 11:27   ← پنل این را می‌خواند
 *     MAX(captured_at) در property_snapshots = 2026-08-31T13:41
 *
 * یعنی جمع‌آورنده‌ی ملک ده روز مرده بود و پنل سبز نشانش می‌داد.
 *
 * اینجا به‌جای فایل، تازه‌ترین ردیفِ واقعی هر جدول خوانده می‌شود. این تنها
 * سنجه‌ای است که با ری‌استارت یا خواندن جابه‌جا نمی‌شود.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const Database = require('better-sqlite3');

const DATA = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA, 'crawler-health.json');

/**
 * جدول و ستونِ زمانِ واقعیِ هر جمع‌آورنده.
 *
 * maxAgeH با دوره‌ی زمان‌بند خودش تنظیم شده، با حاشیه — هدف گرفتنِ «مرده»
 * است نه «یک نوبت را رد کرد». آستانه‌ی تنگ همان چیزی است که در ۱۵ اوت
 * باعث شد همه‌ی کرالرهای روزانه ۱۸ ساعت از شبانه‌روز قرمز باشند و کاربر
 * دنبال خرابی‌ای بگردد که وجود نداشت.
 */
const SOURCES = {
  'trends.db':     { key: 'trends',     label: 'ترند سرچ گوگل',   table: 'trend_snapshots',     col: 'captured_at',  kind: 'iso',  every: 'هر ۴ ساعت',   maxAgeH: 8 },
  'finance.db':    { key: 'finance',    label: 'بازارهای مالی',    table: 'finance_snapshots',   col: 'timestamp',    kind: 'iso',  every: 'هر ۳ دقیقه',  maxAgeH: 1 },
  'gold.db':       { key: 'gold',       label: 'پلتفرم‌های طلا',   table: 'gold_prices',         col: 'captured_at',  kind: 'iso',  every: 'هر ۱۰ دقیقه', maxAgeH: 2 },
  'commodity.db':  { key: 'commodity',  label: 'کالای جهانی',      table: 'commodity_snapshots', col: 'captured_at',  kind: 'iso',  every: 'هر ۱۰ دقیقه', maxAgeH: 2 },
  'news.db':       { key: 'news',       label: 'اخبار تلگرام',     table: 'news',                col: 'published_at', kind: 'iso',  every: 'لحظه‌ای',      maxAgeH: 2 },
  'polymarket.db': { key: 'polymarket', label: 'پلی‌مارکت',        table: 'market_ranks',        col: 'fetched_at',   kind: 'iso',  every: 'هر ۶ ساعت',   maxAgeH: 12 },
  'cars.db':       { key: 'cars',       label: 'بازار خودرو',      table: 'car_snapshots',       col: 'captured_at',  kind: 'iso',  every: 'هر ۱۲ ساعت',  maxAgeH: 26 },
  'market.db':     { key: 'market',     label: 'کالای دیجی‌کالا',  table: 'snapshots',           col: 'snap_date',    kind: 'date', every: 'هر ۲۴ ساعت',  maxAgeH: 50 },
  'jobs.db':       { key: 'jobs',       label: 'بازار کار',        table: 'job_snapshots',       col: 'snap_date',    kind: 'date', every: 'هر ۲۴ ساعت',  maxAgeH: 50 },
  'property.db':   { key: 'property',   label: 'ملک تهران',        table: 'property_snapshots',  col: 'captured_at',  kind: 'iso',  every: 'هر ۲۴ ساعت',  maxAgeH: 50 },
};

/**
 * ستون تاریخِ بدون ساعت (snap_date) را به انتهای همان روز تعبیر می‌کنیم.
 * snap_date از UTC ساخته می‌شود، پس اجرای ۰۲:۳۰ به‌وقت محلی روی تاریخ روز
 * قبل می‌نشیند؛ سخت‌گیری روی این ستون یعنی هشدار الکی.
 */
function parseStamp(v, kind) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const ms = kind === 'date'
    ? Date.parse(s.slice(0, 10) + 'T23:59:59Z')
    : Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isFinite(ms) ? ms : null;
}

let _cache = { at: 0, rows: null };

/** یک ردیف سلامت برای هر جمع‌آورنده. ۶۰ ثانیه کش، چون پنل با هر بار باز شدن صدا می‌زند. */
function check(force) {
  if (!force && _cache.rows && Date.now() - _cache.at < 60000) return _cache.rows;

  const rows = [];
  for (const file of Object.keys(SOURCES)) {
    const src = SOURCES[file];
    const row = {
      file, key: src.key, label: src.label, every: src.every,
      maxAgeH: src.maxAgeH, lastAt: null, ageH: null, status: 'unknown', error: null,
    };
    let db = null;
    try {
      db = new Database(path.join(DATA, file), { readonly: true, fileMustExist: true });
      const v = db.prepare('SELECT MAX("' + src.col + '") v FROM "' + src.table + '"').get().v;
      const ms = parseStamp(v, src.kind);
      if (ms == null) {
        row.status = 'unknown';
        row.error = 'ستون زمان خالی است';
      } else {
        row.lastAt = new Date(ms).toISOString();
        // ستون تاریخ‌محور به انتهای روز تعبیر می‌شود، پس تا پیش از پایان
        // امروز «سن» منفی درمی‌آید. برای آستانه اشکالی ندارد، ولی در پنل
        // «۴۶۷- دقیقه» بی‌معنی است — کف صفر.
        row.ageH = Math.max(0, Math.round((Date.now() - ms) / 36000) / 100);
        row.status = row.ageH > src.maxAgeH ? 'down' : 'ok';
      }
    } catch (e) {
      row.status = 'unknown';
      row.error = e.message;
    } finally {
      if (db) { try { db.close(); } catch (e) {} }
    }
    rows.push(row);
  }

  _cache = { at: Date.now(), rows };
  return rows;
}

/** نگاشت file → ردیف سلامت، برای روکش‌کردن روی فهرست دیتابیس‌های پنل. */
function byFile(force) {
  const m = {};
  for (const r of check(force)) m[r.file] = r;
  return m;
}

// ── هشدار ─────────────────────────────────────────────────────────────
// فقط روی *تغییر وضعیت* پیام می‌رود، نه در هر بار بررسی. هشداری که هر نیم
// ساعت تکرار شود بعد از یک روز نادیده گرفته می‌شود و آن‌وقت خرابیِ بعدی را
// هم کسی نمی‌بیند. اگر خرابی ادامه داشت، روزی یک یادآوری بس است.
const REMIND_MS = 24 * 3600 * 1000;

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function writeState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); } catch (e) {}
}

function botToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN.trim();
  try {
    const m = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
      .match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch (e) { return ''; }
}

function alertChannel() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8'));
    return String(s.alert_channel_id || s.tg_channel_id || '').trim();
  } catch (e) { return ''; }
}

function tgSend(text) {
  const token = botToken(), chat = alertChannel();
  if (!token || !chat) return Promise.resolve(false);
  const body = JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true });
  return new Promise(resolve => {
    const req = https.request({
      host: 'api.telegram.org', path: '/bot' + token + '/sendMessage', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

function fmtAge(h) {
  if (h == null) return '—';
  if (h < 1) return Math.round(h * 60) + ' دقیقه';
  if (h < 48) return Math.round(h) + ' ساعت';
  return Math.round(h / 24) + ' روز';
}

async function runCheck() {
  const rows = check(true);
  const state = readState();
  const now = Date.now();
  let changed = false;

  for (const r of rows) {
    const prev = state[r.key] || { status: 'ok', since: now, lastAlertAt: 0 };

    if (r.status === 'down') {
      const isNew = prev.status !== 'down';
      const due = now - (prev.lastAlertAt || 0) > REMIND_MS;
      if (isNew || due) {
        const ok = await tgSend(
          '🔴 <b>جمع‌آورنده متوقف است</b>\n\n' +
          '<b>' + r.label + '</b> (' + r.every + ')\n' +
          'آخرین ردیف واقعی: ' + fmtAge(r.ageH) + ' پیش\n' +
          'آستانه: ' + r.maxAgeH + ' ساعت\n' +
          '<code>' + r.file + '</code>' +
          (isNew ? '' : '\n\n— یادآوری روزانه، هنوز برنگشته')
        );
        state[r.key] = { status: 'down', since: isNew ? now : (prev.since || now), lastAlertAt: ok ? now : (prev.lastAlertAt || 0) };
        changed = true;
      } else if (isNew) { changed = true; }
    } else if (r.status === 'ok' && prev.status === 'down') {
      const downFor = prev.since ? (now - prev.since) / 3600000 : null;
      await tgSend(
        '🟢 <b>برگشت</b>\n\n<b>' + r.label + '</b> دوباره می‌نویسد' +
        (downFor != null ? '\nمدت توقف: ' + fmtAge(downFor) : '')
      );
      state[r.key] = { status: 'ok', since: now, lastAlertAt: 0 };
      changed = true;
    } else if (prev.status !== r.status) {
      state[r.key] = { status: r.status, since: now, lastAlertAt: prev.lastAlertAt || 0 };
      changed = true;
    }
  }

  if (changed) writeState(state);
  return rows;
}

function startHealthScheduler(everyMs) {
  const ms = everyMs || 30 * 60 * 1000;
  setTimeout(() => { runCheck().catch(e => console.warn('[health]', e.message)); }, 60 * 1000);
  setInterval(() => { runCheck().catch(e => console.warn('[health]', e.message)); }, ms);
  console.log('[health] پایش سلامت جمع‌آورنده‌ها فعال — هر ' + Math.round(ms / 60000) + ' دقیقه');
}

module.exports = { check, byFile, runCheck, startHealthScheduler, SOURCES, fmtAge };
