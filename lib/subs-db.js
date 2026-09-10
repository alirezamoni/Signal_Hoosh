/**
 * lib/subs-db.js — فهرست ایمیل خبرنامه.
 *
 * چرا حالا، در حالی که هنوز راه ارسالی نداریم: مخاطبِ ایمیلی تنها دارایی
 * توزیعی است که به الگوریتم گوگل وابسته نیست، و هر روزی که فرم نباشد
 * ثبت‌نام‌های آن روز برای همیشه از دست می‌روند. جمع‌آوری از امروز شروع
 * می‌شود؛ ارسال وقتی اضافه می‌شود که سرویس ارسال انتخاب شود.
 *
 * confirmed از روز اول در جدول هست تا وقتی opt-in دوتایی اضافه شد، ستون
 * لازم نباشد بعداً به جدولِ پر اضافه شود.
 */
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'data', 'subs.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS subscribers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    source     TEXT,
    ip_hash    TEXT,
    active     INTEGER NOT NULL DEFAULT 1,
    confirmed  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_subs_created ON subscribers(created_at DESC);
`);

// ایمیل خام ذخیره می‌شود چون بدون آن نمی‌شود خبرنامه فرستاد، ولی IP فقط
// برای تشخیص سوءاستفاده لازم است و نگه‌داشتن خامش دلیلی ندارد.
const IP_SALT = 'signalhoosh-subs-v1';
const hashIp = ip => (ip ? crypto.createHash('sha256').update(IP_SALT + String(ip)).digest('hex').slice(0, 32) : null);

const RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

function normalize(email) {
  return String(email || '').trim().toLowerCase().slice(0, 190);
}

function isValid(email) {
  return RE.test(email);
}

/** برمی‌گرداند 'ok' | 'dup' | 'bad'. */
function add(email, source, ip) {
  const e = normalize(email);
  if (!isValid(e)) return 'bad';
  try {
    db.prepare(
      'INSERT INTO subscribers (email, created_at, source, ip_hash) VALUES (?, ?, ?, ?)'
    ).run(e, new Date().toISOString(), String(source || '').slice(0, 60), hashIp(ip));
    return 'ok';
  } catch (err) {
    if (String(err.message).indexOf('UNIQUE') !== -1) return 'dup';
    throw err;
  }
}

function remove(id) {
  return db.prepare('DELETE FROM subscribers WHERE id = ?').run(id).changes;
}

function list(limit = 100, offset = 0) {
  return db.prepare(
    'SELECT id, email, created_at, source, active, confirmed FROM subscribers ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
}

function all() {
  return db.prepare('SELECT email, created_at, source, active, confirmed FROM subscribers ORDER BY created_at DESC').all();
}

function stats() {
  const total = db.prepare('SELECT COUNT(*) c FROM subscribers').get().c;
  const week = db.prepare("SELECT COUNT(*) c FROM subscribers WHERE created_at > datetime('now','-7 days')").get().c;
  const today = db.prepare("SELECT COUNT(*) c FROM subscribers WHERE created_at > datetime('now','-1 day')").get().c;
  return { total, week, today };
}

/** CSV با BOM، وگرنه اکسل فارسی را خراب نشان می‌دهد. */
function toCsv() {
  const rows = all();
  const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const head = ['email', 'created_at', 'source', 'active', 'confirmed'];
  const lines = [head.join(',')];
  for (const r of rows) lines.push(head.map(h => esc(r[h])).join(','));
  return '﻿' + lines.join('\r\n');
}

module.exports = { add, remove, list, all, stats, toCsv, isValid, normalize, _db: db };
