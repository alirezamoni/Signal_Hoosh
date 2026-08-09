/**
 * بازتعریف قوانین با دو درجه‌ی شدت — یک‌بار اجرا می‌شود.
 *
 * hard = به‌تنهایی بلاک می‌کند (برند شرط‌بندی، محتوای بزرگسال)
 * soft = فقط وقتی بلاک می‌کند که حداقل دو نشانه‌ی soft با هم باشند
 *
 * دلیل: «شرط‌بندی» به‌تنهایی می‌تواند خبر واقعی باشد
 * («ممنوعیت پلتفرم‌های شرط‌بندی در عراق»)، ولی «شرط‌بندی + ثبت‌نام + بونوس» تبلیغ است.
 */
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'data', 'news.db'));

try { db.exec("ALTER TABLE spam_rules ADD COLUMN severity TEXT DEFAULT 'hard'"); } catch (e) {}

db.prepare('DELETE FROM spam_rules').run();

const RULES = [
  // ── HARD: برند شرط‌بندی (بی‌ابهام) ──
  ['betforward','contains','شرط‌بندی','hard'], ['bet forward','contains','شرط‌بندی','hard'],
  ['hotbet','contains','شرط‌بندی','hard'],     ['tekbet','contains','شرط‌بندی','hard'],
  ['takbet','contains','شرط‌بندی','hard'],     ['undobet','contains','شرط‌بندی','hard'],
  ['denvbet','contains','شرط‌بندی','hard'],    ['betcart','contains','شرط‌بندی','hard'],
  ['betboro','contains','شرط‌بندی','hard'],    ['pinbet','contains','شرط‌بندی','hard'],
  ['wolfbet','contains','شرط‌بندی','hard'],    ['1xbet','contains','شرط‌بندی','hard'],
  ['bet365','contains','شرط‌بندی','hard'],     ['melbet','contains','شرط‌بندی','hard'],
  ['بت فوروارد','contains','شرط‌بندی','hard'], ['هات بت','contains','شرط‌بندی','hard'],
  ['تک بت','contains','شرط‌بندی','hard'],      ['بت ۹۰','contains','شرط‌بندی','hard'],
  ['بت 90','contains','شرط‌بندی','hard'],      ['ولف بت','contains','شرط‌بندی','hard'],
  // الگوی برند: bet چسبیده به رقم (bet90, 1xbet) — «between/better» را نمی‌گیرد
  ['\\b[a-z]*bet\\d+\\b','regex','شرط‌بندی','hard'],
  ['\\b\\d+x?bet\\b','regex','شرط‌بندی','hard'],

  // ── HARD: قمار بی‌ابهام ──
  ['بازی انفجار','contains','شرط‌بندی','hard'],
  ['سایت انفجار','contains','شرط‌بندی','hard'],
  ['ضریب انفجار','contains','شرط‌بندی','hard'],
  ['شرط بندی انفجار','contains','شرط‌بندی','hard'],
  ['کازینو آنلاین','contains','شرط‌بندی','hard'],
  ['سایت شرط بندی','contains','شرط‌بندی','hard'],
  ['سایت شرطبندی','contains','شرط‌بندی','hard'],
  ['بلک جک','contains','شرط‌بندی','hard'],
  ['jackpot','contains','شرط‌بندی','hard'],
  ['جکپات','contains','شرط‌بندی','hard'],

  // ── HARD: بزرگسال ──
  ['فیلم سوپر','contains','بزرگسال','hard'],
  ['پورن','word','بزرگسال','hard'],
  ['porn','contains','بزرگسال','hard'],
  ['xvideos','contains','بزرگسال','hard'],
  ['onlyfans','contains','بزرگسال','hard'],

  // ── HARD: کلاهبرداری بی‌ابهام ──
  ['سود تضمینی','contains','کلاهبرداری','hard'],
  ['سود تضمین شده','contains','کلاهبرداری','hard'],
  ['دو برابر کردن سرمایه','contains','کلاهبرداری','hard'],
  ['دوبرابر کردن سرمایه','contains','کلاهبرداری','hard'],
  ['سرمایه گذاری تضمینی','contains','کلاهبرداری','hard'],
  ['ربات معامله گر','contains','کلاهبرداری','hard'],
  ['ربات معامله‌گر','contains','کلاهبرداری','hard'],
  ['سیگنال vip','contains','کلاهبرداری','hard'],

  // ── SOFT: هرکدام به‌تنهایی می‌تواند خبر باشد؛ دوتا با هم = تبلیغ ──
  ['شرط بندی','contains','شرط‌بندی','soft'],
  ['شرطبندی','contains','شرط‌بندی','soft'],
  ['قمار','word','شرط‌بندی','soft'],
  ['کازینو','word','شرط‌بندی','soft'],
  ['پوکر','word','شرط‌بندی','soft'],
  ['رولت','word','شرط‌بندی','soft'],
  ['betting','contains','شرط‌بندی','soft'],
  ['casino','contains','شرط‌بندی','soft'],
  ['ثبت نام کنید','contains','اسپم','soft'],
  ['همین حالا ثبت نام','contains','اسپم','soft'],
  ['کد دعوت','contains','اسپم','soft'],
  ['لینک دعوت','contains','اسپم','soft'],
  ['زیرمجموعه گیری','contains','اسپم','soft'],
  ['referral','contains','اسپم','soft'],
  ['بونوس','word','اسپم','soft'],
  ['بونوس ثبت نام','contains','اسپم','soft'],
  ['واریز و برداشت','contains','اسپم','soft'],
  ['واریز آنی','contains','اسپم','soft'],
  ['برداشت آنی','contains','اسپم','soft'],
  ['بدون ریسک','contains','کلاهبرداری','soft'],
  ['سود روزانه','contains','کلاهبرداری','soft'],
  ['سیگنال رایگان','contains','کلاهبرداری','soft'],
  ['ایردراپ رایگان','contains','کلاهبرداری','soft'],
  ['پامپ','word','کلاهبرداری','soft'],
  ['لینک بدون فیلتر','contains','شرط‌بندی','soft'],
  ['رپورتاژ آگهی','contains','تبلیغات','soft'],
  ['جهت تبلیغات','contains','تبلیغات','soft'],
  ['تبلیغات پذیرفته','contains','تبلیغات','soft']
];

const ins = db.prepare('INSERT OR IGNORE INTO spam_rules (pattern, kind, category, severity) VALUES (?,?,?,?)');
db.transaction(rs => { for (const r of rs) ins.run(r[0], r[1], r[2], r[3]); })(RULES);

const c = db.prepare("SELECT severity, COUNT(*) n FROM spam_rules GROUP BY severity").all();
console.log('rules:', JSON.stringify(c));
