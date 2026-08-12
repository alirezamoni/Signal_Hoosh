/**
 * backup-db.js — پشتیبان روزانه‌ی همه‌ی دیتابیس‌ها
 *
 * کپی ساده‌ی فایل .db در حالت WAL ناامن است: بخشی از تراکنش‌ها هنوز در
 * فایل -wal است و کپی می‌تواند ناسازگار دربیاید. API خودِ SQLite برای
 * backup این را درست انجام می‌دهد و نویسنده‌ها را هم بلاک نمی‌کند.
 *
 * اجرا: node backup-db.js   (از cron روزانه)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const DATA = path.join(__dirname, 'data');
const ROOT = '/opt/backups/signal';
const KEEP_DAYS = 14;

const stamp = new Date().toISOString().slice(0, 10);
const dest = path.join(ROOT, stamp);
fs.mkdirSync(dest, { recursive: true });

function gzip(src) {
  const out = src + '.gz';
  fs.writeFileSync(out, zlib.gzipSync(fs.readFileSync(src), { level: 6 }));
  fs.unlinkSync(src);
  return out;
}

(async () => {
  let ok = 0, fail = 0, bytes = 0;

  for (const f of fs.readdirSync(DATA).filter(f => f.endsWith('.db'))) {
    const target = path.join(dest, f);
    try {
      const db = new Database(path.join(DATA, f), { readonly: true });
      await db.backup(target);
      db.close();
      const g = gzip(target);
      bytes += fs.statSync(g).size;
      ok++;
    } catch (e) {
      console.error('[backup] ✗', f, e.message);
      fail++;
    }
  }

  // فایل‌های پیکربندی هم مهم‌اند — بدون settings.json مدل‌ها و بودجه از دست می‌رود
  for (const f of ['settings.json', 'users.json']) {
    try {
      const src = path.join(DATA, f);
      if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dest, f)); ok++; }
    } catch (e) { /* اختیاری */ }
  }

  // پیکربندی nginx و لیست پروسه‌ها — برای بازسازی سرور از صفر
  try {
    fs.copyFileSync('/etc/nginx/sites-available/signalhoosh', path.join(dest, 'nginx-signalhoosh.conf'));
  } catch (e) {}
  try {
    fs.writeFileSync(path.join(dest, 'pm2-list.json'), execFileSync('pm2', ['jlist'], { encoding: 'utf8' }));
  } catch (e) {}

  // چرخش
  let removed = 0;
  const cut = Date.now() - KEEP_DAYS * 86400000;
  for (const d of fs.readdirSync(ROOT)) {
    const p = path.join(ROOT, d);
    try {
      if (!fs.statSync(p).isDirectory()) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      if (new Date(d).getTime() < cut) { fs.rmSync(p, { recursive: true, force: true }); removed++; }
    } catch (e) {}
  }

  console.log(`[backup] ${stamp} — ${ok} فایل، ${(bytes / 1048576).toFixed(1)} مگ` +
              (fail ? `، ${fail} ناموفق` : '') + (removed ? `، ${removed} پشتیبان قدیمی حذف شد` : ''));
  if (fail) process.exit(1);
})().catch(e => { console.error('[backup] خطا:', e.message); process.exit(1); });
