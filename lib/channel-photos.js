/**
 * channel-photos.js — گرفتن عکس پروفایل کانال‌هایی که هنوز عکس ندارند
 *
 * کانال‌های خبری عکسشان را خودِ news-bot از Bot API می‌گیرد، ولی کانال‌های
 * مالی منتظر می‌مانند تا پروژه‌ی ربات تلگرام عکس را با photo_b64 بفرستد —
 * و اگر آن پروژه این کار را نکند، کانال برای همیشه بی‌عکس می‌ماند.
 * این ماژول همان کار را مستقیم و مستقل انجام می‌دهد.
 *
 * پیش‌نیاز: ربات باید عضو (یا ادمین) کانال باشد، وگرنه getChat خطا می‌دهد.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PHOTO_DIR = path.join(__dirname, '..', 'public', 'channel-photos');

function api(token, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const req = https.request({
      host: 'api.telegram.org', path: `/bot${token}/${method}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 20000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(body);
  });
}

function download(token, filePath, dest) {
  return new Promise((resolve, reject) => {
    https.get(`https://api.telegram.org/file/bot${token}/${filePath}`, res => {
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length < 200) return reject(new Error('فایل خیلی کوچک'));
        fs.mkdirSync(PHOTO_DIR, { recursive: true });
        fs.writeFileSync(dest, buf);
        resolve(buf.length);
      });
    }).on('error', reject);
  });
}

/** عکس یک کانال را می‌گیرد و مسیر محلی را برمی‌گرداند */
async function fetchOne(token, tgId, fileName) {
  const chat = await api(token, 'getChat', { chat_id: tgId });
  if (!chat.ok) throw new Error(chat.description || 'getChat ناموفق');
  const photo = chat.result && chat.result.photo;
  if (!photo) throw new Error('این کانال عکس پروفایل ندارد');

  const fileId = photo.big_file_id || photo.small_file_id;
  const info = await api(token, 'getFile', { file_id: fileId });
  if (!info.ok || !info.result || !info.result.file_path) throw new Error('getFile ناموفق');

  await download(token, info.result.file_path, path.join(PHOTO_DIR, fileName));
  return '/channel-photos/' + fileName;
}

/**
 * همه‌ی کانال‌های بدون عکس (خبری و مالی) را یک بار تلاش می‌کند.
 * برمی‌گرداند: { ok, fail, details[] }
 */
async function backfill() {
  const token = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
  if (!token) return { ok: 0, fail: 0, details: [{ name: '—', error: 'BOT_TOKEN تنظیم نشده' }] };

  const targets = [];
  try {
    const newsDB = require('../news-db');
    for (const c of newsDB.getChannels() || []) {
      if (!c.photo_url && c.tg_id) targets.push({ kind: 'news', c, file: c.id + '.jpg' });
    }
  } catch (e) {}
  try {
    const financeDB = require('../finance-db');
    for (const c of financeDB.getFinanceChannels() || []) {
      if (!c.photo_url && c.tg_id) targets.push({ kind: 'finance', c, file: 'fin_' + c.id + '.jpg' });
    }
  } catch (e) {}

  const details = [];
  let ok = 0, fail = 0;
  for (const t of targets) {
    const label = t.c.title || t.c.username || t.c.tg_id;
    try {
      const url = await fetchOne(token, t.c.tg_id, t.file);
      if (t.kind === 'news') require('../news-db').updateChannel(t.c.id, { photo_url: url });
      else require('../finance-db').updateFinanceChannel(t.c.id, {
        username: t.c.username, tg_id: t.c.tg_id, title: t.c.title,
        category: t.c.category, photo_url: url, needs_translation: t.c.needs_translation,
      });
      ok++; details.push({ name: label, ok: true });
      console.log('[photos] ✓ ' + label);
    } catch (e) {
      fail++; details.push({ name: label, error: e.message.slice(0, 120) });
      console.log('[photos] ✗ ' + label + ' — ' + e.message.slice(0, 80));
    }
  }
  return { ok, fail, details };
}

let timer = null;
function startPhotoScheduler(hours) {
  const ms = (hours || 6) * 3600 * 1000;
  if (timer) clearInterval(timer);
  setTimeout(() => { backfill().catch(e => console.warn('[photos]', e.message)); }, 90000);
  timer = setInterval(() => { backfill().catch(e => console.warn('[photos]', e.message)); }, ms);
  console.log(`[photos] زمان‌بند عکس کانال‌ها فعال شد — هر ${hours || 6} ساعت`);
}

module.exports = { backfill, fetchOne, startPhotoScheduler };
