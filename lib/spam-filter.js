/**
 * lib/spam-filter.js — فیلتر کلیدواژه‌ی محتوای نامناسب
 *
 * چرا این ماژول لازم است: کانال‌های تلگرام بین اخبار واقعی، تبلیغ شرط‌بندی و
 * کلاهبرداری هم می‌فرستند. اگر این‌ها ایندکس شوند به اعتبار دامنه آسیب می‌زند.
 *
 * نکته‌ی حیاتی طراحی: تطبیق زیررشته‌ای ساده در فارسی فاجعه است —
 * «بت» داخل «ثبت»، «مثبت»، «نسبت» و «تربت» هست. پس واژه‌های کوتاه با
 * «مرز واژه» تطبیق داده می‌شوند (kind='word')، نه با indexOf خام.
 */
const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'data', 'news.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS spam_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern    TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'word',   -- word | contains | regex
    category   TEXT DEFAULT 'سایر',
    enabled    INTEGER DEFAULT 1,
    hits       INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(pattern)
  );
  CREATE INDEX IF NOT EXISTS idx_spam_enabled ON spam_rules(enabled);
`);

// ── فهرست پیش‌فرض ──
// kind='word'     → فقط اگر واژه‌ی مستقل باشد (برای واژه‌های کوتاه/پرخطر)
// kind='contains' → هرجای متن (برای عبارت‌های بلند و بی‌ابهام)
const DEFAULTS = [
  // شرط‌بندی و قمار
  ['شرط بندی',        'contains', 'شرط‌بندی'],
  ['شرط‌بندی',         'contains', 'شرط‌بندی'],
  ['شرطبندی',          'contains', 'شرط‌بندی'],
  ['سایت شرط',         'contains', 'شرط‌بندی'],
  ['بت',               'word',     'شرط‌بندی'],
  ['bet',              'word',     'شرط‌بندی'],
  ['betting',          'contains', 'شرط‌بندی'],
  ['casino',           'contains', 'شرط‌بندی'],
  ['کازینو',           'contains', 'شرط‌بندی'],
  ['پوکر',             'word',     'شرط‌بندی'],
  ['poker',            'contains', 'شرط‌بندی'],
  ['رولت',             'word',     'شرط‌بندی'],
  ['roulette',         'contains', 'شرط‌بندی'],
  ['بلک جک',           'contains', 'شرط‌بندی'],
  ['انفجار',           'word',     'شرط‌بندی'],
  ['بازی انفجار',      'contains', 'شرط‌بندی'],
  ['ضریب باخت',        'contains', 'شرط‌بندی'],
  ['واریز و برداشت',   'contains', 'شرط‌بندی'],
  ['بونوس',            'word',     'شرط‌بندی'],
  ['بونus',            'contains', 'شرط‌بندی'],
  ['jackpot',          'contains', 'شرط‌بندی'],
  ['جکپات',            'contains', 'شرط‌بندی'],

  // کلاهبرداری مالی
  ['سود تضمینی',       'contains', 'کلاهبرداری'],
  ['سود تضمین شده',    'contains', 'کلاهبرداری'],
  ['سرمایه گذاری تضمینی','contains','کلاهبرداری'],
  ['دو برابر کردن سرمایه','contains','کلاهبرداری'],
  ['دوبرابر کردن سرمایه','contains','کلاهبرداری'],
  ['سیگنال vip',       'contains', 'کلاهبرداری'],
  ['سیگنال رایگان',    'contains', 'کلاهبرداری'],
  ['ربات معامله گر',   'contains', 'کلاهبرداری'],
  ['ربات معامله‌گر',    'contains', 'کلاهبرداری'],
  ['پامپ',             'word',     'کلاهبرداری'],
  ['ایردراپ رایگان',   'contains', 'کلاهبرداری'],
  ['airdrop',          'word',     'کلاهبرداری'],
  ['سود روزانه',       'contains', 'کلاهبرداری'],
  ['بدون ریسک',        'contains', 'کلاهبرداری'],

  // اسپم ارجاعی
  ['زیرمجموعه گیری',   'contains', 'اسپم'],
  ['کد دعوت',          'contains', 'اسپم'],
  ['لینک دعوت',        'contains', 'اسپم'],
  ['رفرال',            'word',     'اسپم'],
  ['referral',         'contains', 'اسپم'],

  // محتوای بزرگسال
  ['فیلم سوپر',        'contains', 'بزرگسال'],
  ['+18',              'contains', 'بزرگسال'],
  ['۱۸+',              'contains', 'بزرگسال'],
  ['پورن',             'word',     'بزرگسال'],
  ['porn',             'contains', 'بزرگسال'],
  ['sex',              'word',     'بزرگسال'],

  // تبلیغات آشکار
  ['رپورتاژ آگهی',     'contains', 'تبلیغات'],
  ['تبلیغات پذیرفته',  'contains', 'تبلیغات'],
  ['جهت تبلیغات',      'contains', 'تبلیغات'],
  ['ثبت سفارش تبلیغ',  'contains', 'تبلیغات'],
  ['وی پی ان رایگان',  'contains', 'تبلیغات'],
  ['فیلترشکن',         'word',     'تبلیغات'],
  ['وی پی ان',         'contains', 'تبلیغات']
];

// ⚠️ فقط وقتی جدول خالی است seed می‌شود.
// اگر هر بار اجرا شود، قانونی که ادمین حذف کرده دوباره برمی‌گردد.
function seedDefaults(force) {
  const n = db.prepare('SELECT COUNT(*) c FROM spam_rules').get().c;
  if (n > 0 && !force) return 0;
  const ins = db.prepare(
    'INSERT OR IGNORE INTO spam_rules (pattern, kind, category) VALUES (?, ?, ?)'
  );
  db.transaction(rows => { for (const r of rows) ins.run(r[0], r[1], r[2]); })(DEFAULTS);
  return DEFAULTS.length;
}
seedDefaults();

// ── نرمال‌سازی متن فارسی ──
// عربی ی/ک → فارسی، حذف نیم‌فاصله و اعراب، ارقام فارسی → لاتین، حروف کوچک
function normalize(s) {
  if (!s) return '';
  return String(s)
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ً-ْـ]/g, '')
    .replace(/‌/g, ' ')
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

// آیا کاراکتر جزو یک واژه است؟ (فارسی، لاتین، رقم)
function isWordChar(c) {
  return !!c && /[ء-ۓa-z0-9]/i.test(c);
}

// تطبیق «واژه‌ی مستقل» — جلوی خطای «بت» داخل «ثبت» را می‌گیرد
function matchWord(text, word) {
  if (!word) return false;
  let i = 0;
  while ((i = text.indexOf(word, i)) !== -1) {
    const before = i > 0 ? text[i - 1] : '';
    const after  = text[i + word.length] || '';
    if (!isWordChar(before) && !isWordChar(after)) return true;
    i += word.length;
  }
  return false;
}

let cache = null, cacheAt = 0;
function rules() {
  if (cache && Date.now() - cacheAt < 60000) return cache;
  let rows;
  try {
    rows = db.prepare('SELECT id, pattern, kind, severity FROM spam_rules WHERE enabled=1').all();
  } catch (e) {
    rows = db.prepare('SELECT id, pattern, kind FROM spam_rules WHERE enabled=1').all()
             .map(r => Object.assign({ severity: 'hard' }, r));
  }
  cache = rows.map(r => ({
    id: r.id, kind: r.kind, severity: r.severity || 'hard', pattern: normalize(r.pattern)
  }));
  cacheAt = Date.now();
  return cache;
}
function invalidate() { cache = null; }

function hits(t, r) {
  if (r.kind === 'word')     return matchWord(t, r.pattern);
  if (r.kind === 'contains') return t.indexOf(r.pattern) !== -1;
  if (r.kind === 'regex')    { try { return new RegExp(r.pattern, 'i').test(t); } catch (e) { return false; } }
  return false;
}

/**
 * بررسی می‌کند متن اسپم است یا نه.
 *
 * hard → یک برخورد کافی است (برند شرط‌بندی، محتوای بزرگسال)
 * soft → حداقل دو نشانه لازم است، چون هرکدام به‌تنهایی می‌تواند خبر واقعی باشد
 *        («ممنوعیت پلتفرم‌های شرط‌بندی در عراق» خبر است، نه تبلیغ)
 *
 * @returns {null | {id, pattern, kind, severity, also?}} قانون منطبق یا null
 */
function check(text) {
  const t = normalize(text);
  if (!t) return null;
  const soft = [];
  for (const r of rules()) {
    if (!hits(t, r)) continue;
    if (r.severity === 'hard') return r;
    soft.push(r);
    if (soft.length >= 2) return Object.assign({}, soft[0], { also: soft[1].pattern });
  }
  return null;
}

function isSpam(text) { return check(text) !== null; }

// شمارنده‌ی برخورد — برای نمایش «این قانون چند بار جلوی اسپم را گرفته»
function recordHit(id) {
  try { db.prepare('UPDATE spam_rules SET hits = hits + 1 WHERE id=?').run(id); } catch (e) {}
}

// ── مدیریت (برای پنل ادمین) ──
function list()            { return db.prepare('SELECT * FROM spam_rules ORDER BY hits DESC, id').all(); }
function add(pattern, kind, category) {
  db.prepare('INSERT OR IGNORE INTO spam_rules (pattern, kind, category) VALUES (?,?,?)')
    .run(pattern.trim(), kind || 'contains', category || 'سایر');
  invalidate();
}
function remove(id)        { db.prepare('DELETE FROM spam_rules WHERE id=?').run(id); invalidate(); }
function toggle(id, on)    { db.prepare('UPDATE spam_rules SET enabled=? WHERE id=?').run(on ? 1 : 0, id); invalidate(); }

module.exports = {
  check, isSpam, recordHit, normalize,
  list, add, remove, toggle, invalidate,
  DEFAULT_COUNT: DEFAULTS.length
};
