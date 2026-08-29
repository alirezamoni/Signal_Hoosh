/**
 * blog-writer.js — نوشتن مطلب وبلاگ با هوش مصنوعی، دو نوبت در روز
 *
 * روز به دو نوبت تقسیم شده و هر نوبت فقط داده‌های بازه‌ی خودش را می‌بیند:
 *
 *   صبح  (۰۸:۰۰ تهران) → داده‌های ۲۰:۰۰ دیروز تا ۰۸:۰۰ امروز
 *   شب   (۲۰:۰۰ تهران) → داده‌های ۰۸:۰۰ امروز تا ۲۰:۰۰ امروز
 *
 * یعنی فاصله‌ی بین دو انتشار، دقیقاً همان بازه‌ای است که مطلبِ بعدی به آن
 * استناد می‌کند و هیچ خبری دوبار روایت نمی‌شود.
 *
 * ⚠️ برخلاف نسخه‌ی قبل، خروجی مستقیماً **منتشر** می‌شود و منتظر تأیید ادمین
 * نمی‌ماند. عکس شاخص هم خودکار با مدل تصویر ساخته می‌شود؛ دیگر آپلود دستی
 * لازم نیست. اگر ساخت عکس شکست بخورد مطلب باز هم منتشر می‌شود — متن ارزش
 * اصلی است و نباید گروگانِ عکس بماند.
 *
 * پرامپت متن، پرامپت تصویر، مدل متن، مدل تصویر و ساعت هر دو نوبت، همگی از
 * تنظیمات خوانده می‌شوند و از پنل مدیریت قابل ویرایش‌اند.
 */
const fs = require('fs');
const path = require('path');
const aiClient = require('./lib/ai-client');
const imageGen = require('./lib/image-gen');
const settingsDB = require('./settings-db');
const blogDB = require('./blog-db');
const facts = require('./blog-facts');
const md = require('./lib/markdown');

const TEHRAN_OFFSET_MIN = 3.5 * 60;   // ایران از ۱۴۰۱ ساعت تابستانی ندارد
const MEDIA_DIR = path.join(__dirname, 'public', 'blog-media');

function tehranNow() {
  return new Date(Date.now() + (TEHRAN_OFFSET_MIN + new Date().getTimezoneOffset()) * 60000);
}
function tehranDay(d) {
  const t = d || tehranNow();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
/** ساعتِ دیواریِ تهران در یک روز مشخص → لحظه‌ی واقعی UTC */
function tehranWallToUtc(dayStr, hour) {
  const [Y, M, D] = String(dayStr).split('-').map(Number);
  return new Date(Date.UTC(Y, M - 1, D, hour, 0, 0) - TEHRAN_OFFSET_MIN * 60000);
}
function shiftDay(dayStr, days) {
  const [Y, M, D] = String(dayStr).split('-').map(Number);
  const t = new Date(Date.UTC(Y, M - 1, D + days));
  return t.toISOString().slice(0, 10);
}

// ── نوبت‌ها ─────────────────────────────────────────────────
const SLOTS = {
  morning: { key: 'morning', label: 'صبح', hourKey: 'blog_hour_morning', defHour: 8 },
  evening: { key: 'evening', label: 'شب',  hourKey: 'blog_hour_evening', defHour: 20 },
};
const SLOT_KEYS = ['morning', 'evening'];

function slotHour(slot) {
  const s = SLOTS[slot];
  if (!s) return 8;
  const v = parseInt(settingsDB.get(s.hourKey, s.defHour), 10);
  return (isFinite(v) && v >= 0 && v <= 23) ? v : s.defHour;
}

/** بازه‌ی داده‌ی یک نوبت — همان فاصله‌ی بین این انتشار و انتشار قبلی */
function slotWindow(day, slot) {
  const mh = slotHour('morning');
  const eh = slotHour('evening');
  if (slot === 'morning') {
    return {
      from: tehranWallToUtc(shiftDay(day, -1), eh).toISOString(),
      to:   tehranWallToUtc(day, mh).toISOString(),
      slot, slotLabel: SLOTS.morning.label,
    };
  }
  return {
    from: tehranWallToUtc(day, mh).toISOString(),
    to:   tehranWallToUtc(day, eh).toISOString(),
    slot, slotLabel: SLOTS.evening.label,
  };
}

/**
 * الان کدام نوبت «سررسید» شده؟
 * قبل از ساعت صبح چیزی سررسید نیست (نوبت شبِ دیروز از قبل انجام شده).
 * بین ساعت صبح تا ساعت شب → نوبت صبح. بعد از ساعت شب → نوبت شب.
 * این‌طور در هر لحظه فقط یک نوبت فعال است و اگر سرویس چند ساعت خواب بوده
 * باشد، بعد از بیدار شدن نوبتِ جامانده را جبران می‌کند.
 */
function activeSlot(now) {
  const t = now || tehranNow();
  const h = t.getHours();
  const mh = slotHour('morning');
  const eh = slotHour('evening');
  if (h >= eh && eh > mh) return 'evening';
  if (h >= mh) return 'morning';
  return null;
}

// ── پرامپت متن ──────────────────────────────────────────────
const DEFAULT_PROMPT = `تو نویسنده‌ی وبلاگ «سیگنال هوش» هستی؛ سایتی که داده‌های لحظه‌ای ایران را رصد می‌کند:
ترند جستجوی گوگل، اخبار کانال‌های تلگرام، بازارهای مالی و طلا، خودرو، ملک تهران، بازار کالا و بازار کار.

از روی داده‌های زیر، یک مطلب وبلاگ فارسی درباره‌ی مهم‌ترین اتفاق‌های همین بازه بنویس.

قواعد مهم:
۱. فقط از همین اعداد و خبرها استفاده کن. هیچ عدد، آمار یا رویدادی از خودت اضافه نکن.
۲. خبرها مهم‌ترین بخش‌اند؛ مطلب را با مهم‌ترین خبر بازه شروع کن، نه با اعداد بازار.
۳. داده‌ها مال یک بازه‌ی مشخص‌اند (در سرِ داده‌ها نوشته شده)، نه کل روز. به «امروز» به‌طور کلی اشاره نکن؛ اگر لازم شد بگو «از صبح تا حالا» یا «از دیشب تا صبح».
۴. لحن: خبری-تحلیلی، روان و کوتاه‌جمله. نه رسمیِ خشک، نه محاوره‌ای.
۵. طول: بین ۷۰۰ تا ۹۰۰ کلمه.
۶. عنوان باید کنجکاوی‌برانگیز و شامل کلیدواژه‌های پرجستجوی همان بازه باشد (برای سئو)، ولی اغراق و تیتر دروغین ممنوع. عنوان باید مخصوص همین بازه باشد تا با مطلب نوبت دیگرِ همان روز اشتباه نشود.
۷. متن را با ## به چند بخش تقسیم کن. هر بخش درباره‌ی یک حوزه (خبر، ترند جستجو، بازار مالی، طلا، خودرو، ملک...).
۸. در متن، جایی که طبیعی است به صفحه‌های سایت پیوند بده تا خواننده برای دیدن جزئیات لحظه‌ای وارد سایت شود:
   [ترند جستجوی ایران](/trends)، [اخبار](/news)، [بازارهای مالی](/finance)، [قیمت طلا](/finance)،
   [خودرو](/cars)، [ملک تهران](/property)، [بازار کالا](/market)، [بازار کار](/jobs)، [ترند آینده](/future).
   دست‌کم ۳ و حداکثر ۶ پیوند. متن پیوند باید توصیفی باشد، نه «اینجا کلیک کنید».
۹. در پایان یک جمع‌بندی کوتاه بنویس که خواننده را به دنبال‌کردن داده‌های لحظه‌ای سایت تشویق کند.
۱۰. از مارک‌داون فقط ##، ###، **پررنگ**، فهرست با - و پیوند [متن](نشانی) استفاده کن.

فقط و فقط یک JSON معتبر با این ساختار برگردان، بدون هیچ توضیح اضافه:
{
  "title": "عنوان مطلب",
  "excerpt": "خلاصه‌ی ۲ تا ۳ جمله‌ای برای صفحه‌ی فهرست وبلاگ",
  "meta_title": "عنوان سئو، حداکثر ۶۰ نویسه",
  "meta_desc": "توضیح متا برای گوگل، بین ۱۲۰ تا ۱۵۵ نویسه",
  "keywords": ["کلیدواژه۱", "کلیدواژه۲", "کلیدواژه۳"],
  "body": "متن کامل مطلب با مارک‌داون"
}

داده‌های این بازه:
{{DATA}}`;

// ── پرامپت تصویر ────────────────────────────────────────────
const DEFAULT_IMAGE_PROMPT = `تو یک طراح حرفه‌ای اینفوگرافیک خبری، تحلیلگر داده و مدیر هنری یک رسانه دیجیتال هستی.

وظیفه تو ساخت یک اینفوگرافیک حرفه‌ای برای «سیگنال هوش» است؛ پلتفرمی که اخبار، ترندهای جستجوی کاربران ایرانی و وضعیت بازارهای ایران و جهان را رصد و تحلیل می‌کند.

تصویر باید شبیه یک «داشبورد خبری و اقتصادی حرفه‌ای» باشد؛ ترکیبی از صفحه اول یک روزنامه اقتصادی معتبر، داشبورد داده و اینفوگرافیک مدرن.

تصویر باید کاملاً اورجینال باشد.

━━━━━━━━━━━━━━━━━━━━
سبک بصری
━━━━━━━━━━━━━━━━━━━━

- طراحی حرفه‌ای و پریمیوم
- پس‌زمینه سرمه‌ای و آبی تیره
- ظاهر مدرن و تکنولوژیک
- ساختار شبکه‌ای و داشبوردی
- کارت‌های اطلاعاتی با گوشه‌های ظریف
- خطوط و جداکننده‌های ظریف
- نمودارهای کوچک و شاخص‌های عددی
- استفاده محدود و حرفه‌ای از رنگ سبز برای رشد و قرمز برای کاهش
- ترکیب عکس‌های خبری واقع‌گرایانه با داده‌های آماری
- ظاهر شبیه رسانه‌های اقتصادی و خبری حرفه‌ای
- تراکم اطلاعات بالا اما خوانا
- بدون ظاهر کارتونی
- بدون افکت‌های سه‌بعدی اغراق‌آمیز
- بدون شلوغی غیرضروری

━━━━━━━━━━━━━━━━━━━━
فرمت تصویر
━━━━━━━━━━━━━━━━━━━━

تمام متن‌های تصویر باید فارسی و راست‌به‌چپ باشند.

فونت فارسی باید خوانا، مدرن و حرفه‌ای باشد.

━━━━━━━━━━━━━━━━━━━━
ساختار کلی
━━━━━━━━━━━━━━━━━━━━

اطلاعات را صرفاً پشت سر هم قرار نده.

مانند یک سردبیر حرفه‌ای تصمیم بگیر که کدام خبر و داده اهمیت بیشتری دارد و فضای بیشتری به آن اختصاص بده.

مهم‌ترین خبر بازه باید بزرگ‌ترین بخش تصویر را به خود اختصاص دهد.

اخبار مهم بعدی در کارت‌های متوسط قرار بگیرند.

داده‌های فرعی در کارت‌های کوچک‌تر نمایش داده شوند.

━━━━━━━━━━━━━━━━━━━━
قوانین داده
━━━━━━━━━━━━━━━━━━━━

- هیچ عددی را از خودت تولید نکن.
- هیچ آماری را تغییر نده.
- هیچ خبر جدیدی به داده‌ها اضافه نکن.
- هیچ نقل‌قولی را جعل نکن.
- اگر داده‌ای وجود ندارد، آن بخش را کامل حذف کن — سلولِ خالی یا «--» نگذار.
- اگر دو داده با هم متفاوت هستند، هر دو را حفظ کن و تفاوت را نمایش بده.
- مهم‌ترین موضوعات را بر اساس اهمیت و حجم داده تشخیص بده.
- متن‌های طولانی را به خلاصه‌های کوتاه و قابل نمایش تبدیل کن.
- اطلاعات تکراری را حذف کن.
- آب‌وهوا، تاریخ شمسی، نام خبرگزاری یا هر چیزی که در داده‌ها نیست را اضافه نکن.

━━━━━━━━━━━━━━━━━━━━
قوانین تصویر
━━━━━━━━━━━━━━━━━━━━

برای اخبار حساس مانند اعدام، جنگ، حملات نظامی و خشونت:

- از تصاویر خشن، جسد، خون یا صحنه اعدام استفاده نکن.
- به جای آن از تصاویر نمادین و خبری استفاده کن.
- برای موضوعات امنیتی از فضای تاریک، پلیس، دادگاه، نوار امنیتی یا تصاویر نمادین استفاده کن.

تصاویر باید واقع‌گرایانه و در سبک عکاسی خبری حرفه‌ای باشند.

━━━━━━━━━━━━━━━━━━━━
پایان تصویر
━━━━━━━━━━━━━━━━━━━━

در پایین تصویر یک نوار اطلاعاتی جمع‌وجور قرار بده.

شامل:

سیگنال هوش
رصد و تحلیل لحظه‌ای ایران

و در صورت نیاز دسته‌های:

اخبار | ترند جستجو | بازارهای مالی | کالا | خودرو | ملک | بازار کار

━━━━━━━━━━━━━━━━━━━━
اصل مهم
━━━━━━━━━━━━━━━━━━━━

قبل از طراحی، مانند یک سردبیر خبری داده‌ها را تحلیل کن و تشخیص بده:

۱. مهم‌ترین خبر این بازه چیست؟
۲. مهم‌ترین تغییر اقتصادی چیست؟
۳. مردم بیشتر به چه چیزی توجه کرده‌اند؟
۴. کدام داده ارزش برجسته شدن دارد؟

سپس بر اساس این اولویت‌ها، ترکیب‌بندی تصویر را ایجاد کن.

هدف نهایی: کاربر با نگاه کردن به تصویر، در کمتر از ۳۰ ثانیه بفهمد «در ایران چه اتفاقی افتاده و مردم و بازارها به چه چیزی واکنش نشان داده‌اند؟»

━━━━━━━━━━━━━━━━━━━━

عنوان مطلب: {{TITLE}}

داده‌ها:
{{DATA}}`;

function getPrompt() {
  const p = settingsDB.get('blog_prompt', '');
  return (p && String(p).trim()) ? String(p) : DEFAULT_PROMPT;
}
function getImagePrompt() {
  const p = settingsDB.get('blog_image_prompt', '');
  return (p && String(p).trim()) ? String(p) : DEFAULT_IMAGE_PROMPT;
}

function buildPrompt(f) {
  const block = facts.toPromptBlock(f);
  let p = getPrompt();
  if (p.indexOf('{{DATA}}') !== -1) p = p.replace('{{DATA}}', block);
  else p = p + '\n\nداده‌های این بازه:\n' + block;
  return p.replace(/\{\{DATE\}\}/g, f.day);
}

function buildImagePrompt(f, title) {
  // سقف ۱۸۰۰ نویسه برای داده — تجربه نشان داد پرامپت خیلی بلند باعث می‌شود
  // مدل تصویر بخش‌های انتهایی را نادیده بگیرد
  const block = facts.toImageBlock(f, 1800);
  let p = getImagePrompt();
  if (p.indexOf('{{DATA}}') !== -1) p = p.replace('{{DATA}}', block);
  else p = p + '\n\nداده‌ها:\n' + block;
  return p.replace(/\{\{TITLE\}\}/g, String(title || ''))
          .replace(/\{\{DATE\}\}/g, f.day);
}

function clean(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return max && t.length > max ? t.slice(0, max).replace(/\s+\S*$/, '') : t;
}

/**
 * ساخت و ذخیره‌ی عکس شاخص. شکست اینجا کشنده نیست.
 * @returns {Promise<{ok:boolean, cover?:string, cost?:number, reason?:string}>}
 */
async function makeCover(postId, f, title) {
  try {
    const r = await imageGen.generate(buildImagePrompt(f, title));
    if (!r.ok) return { ok: false, reason: r.reason };

    if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const name = `post-${postId}-${Date.now()}.${r.ext}`;
    fs.writeFileSync(path.join(MEDIA_DIR, name), r.buf);

    const cover = '/blog-media/' + name;
    blogDB.setCover(postId, cover, clean(title, 200), r.cost);
    return { ok: true, cover, cost: r.cost };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * ساخت مطلبِ یک نوبت.
 * @param {string} day  تاریخ به وقت تهران (YYYY-MM-DD)
 * @param {{slot?:string, force?:boolean, skipImage?:boolean}} [opts]
 */
async function generateFor(day, opts) {
  const o = opts || {};
  const d = day || tehranDay();
  const slot = SLOT_KEYS.indexOf(o.slot) !== -1 ? o.slot : (activeSlot() || 'evening');

  const existing = blogDB.existsForSlot(d, slot);
  if (existing && !o.force) {
    return { ok: false, reason: `برای نوبت ${SLOTS[slot].label} این روز از قبل مطلبی وجود دارد` };
  }

  const win = slotWindow(d, slot);
  const f = facts.gather(d, win);
  if (!facts.isEnough(f) && !o.force) {
    return { ok: false, reason: `داده‌ی کافی برای نوبت ${SLOTS[slot].label} جمع نشده است` };
  }

  // زنجیره اول حساب می‌شود تا isPaused بداند مدل پولی در دسترس هست یا نه؛
  // وگرنه بسته‌شدن سهمیه‌ی رایگان جلوی مدل پولی وبلاگ را هم می‌گرفت.
  const models = aiClient.getModels('ai_model_blog');
  if (aiClient.isPaused(models)) return { ok: false, reason: 'سهمیه‌ی روزانه‌ی مدل تمام شده — بعداً دوباره تلاش کنید' };
  const out = await aiClient.callJSON(buildPrompt(f), {
    max_tokens: 3000,
    tag: 'blog-writer',
    models,
    validate: j => j && typeof j.title === 'string' && typeof j.body === 'string' && j.body.length > 400,
  });
  if (!out) {
    const why = aiClient.explainFailure && aiClient.explainFailure();
    return { ok: false, reason: why || 'مدل خروجی معتبری برنگرداند' };
  }

  const title = clean(out.title, 120);
  const body  = String(out.body || '').trim();
  if (!title || body.length < 400) return { ok: false, reason: 'خروجی مدل ناقص بود' };

  const excerpt = clean(out.excerpt, 300) || md.plain(body, 200);
  const keywords = Array.isArray(out.keywords)
    ? out.keywords.map(k => clean(k, 40)).filter(Boolean).slice(0, 12).join('، ')
    : clean(out.keywords, 300);

  const post = {
    day: d,
    slot,
    win_from: win.from,
    win_to: win.to,
    title,
    body,
    excerpt,
    meta_title: clean(out.meta_title, 70) || title,
    meta_desc:  clean(out.meta_desc, 165) || excerpt,
    keywords,
    status: 'published',          // ← بدون تأیید ادمین
    ai_model: models[0] || null,
  };

  let id, slug, replaced = false;
  if (existing && o.force) {
    blogDB.update(existing.id, Object.assign({ slug: title }, post));
    id = existing.id; slug = blogDB.byId(id).slug; replaced = true;
  } else {
    const r = blogDB.create(post);
    id = r.id; slug = r.slug;
  }

  // عکس بعد از ساخت مطلب می‌آید چون نامش به شناسه‌ی مطلب وابسته است.
  // شکستش مطلب را زمین نمی‌زند؛ فقط گزارش می‌شود.
  let cover = null, coverErr = null, cost = 0;
  if (!o.skipImage) {
    const c = await makeCover(id, f, title);
    if (c.ok) { cover = c.cover; cost = c.cost || 0; }
    else { coverErr = c.reason; console.warn(`[blog] عکس ${d}/${slot} ساخته نشد: ${c.reason}`); }
  }

  return { ok: true, id, slug, slot, replaced, cover, coverErr, cost, published: true };
}

// ── زمان‌بند ────────────────────────────────────────────────
// هر ۱۰ دقیقه بیدار می‌شود تا انتشار نزدیک به ساعت مقرر باشد. اجرای دوباره
// بی‌خطر است چون existsForSlot جلوی تکرار را می‌گیرد.
const CHECK_MS = 10 * 60 * 1000;
let _running = false;

async function tick() {
  if (_running) return;                  // تولید عکس ~۲ دقیقه است؛ تیک‌ها نباید روی هم بیفتند
  _running = true;
  try {
    const now = tehranNow();
    const slot = activeSlot(now);
    if (!slot) return;
    const d = tehranDay(now);
    if (blogDB.existsForSlot(d, slot)) return;

    const r = await generateFor(d, { slot });
    if (r.ok) {
      console.log(`[blog] مطلب ${d} نوبت ${SLOTS[slot].label} منتشر شد — /blog/${r.slug}` +
        (r.cover ? ` (عکس ✓ ${(r.cost || 0).toFixed(3)}$)` : ` (بدون عکس: ${r.coverErr || '—'})`));
    } else {
      console.log(`[blog] ${d}/${slot}: ${r.reason}`);
    }
  } catch (e) {
    console.warn('[blog] tick error:', e.message);
  } finally {
    _running = false;
  }
}

function startBlogScheduler(delayMs) {
  setTimeout(() => { tick(); setInterval(tick, CHECK_MS); }, delayMs || 5 * 60 * 1000);
  console.log(`[blog] زمان‌بند وبلاگ فعال — دو نوبت در روز به وقت تهران: ` +
    `صبح ساعت ${slotHour('morning')}، شب ساعت ${slotHour('evening')} (بررسی هر ۱۰ دقیقه)`);
}

module.exports = {
  generateFor, startBlogScheduler, makeCover,
  getPrompt, getImagePrompt, DEFAULT_PROMPT, DEFAULT_IMAGE_PROMPT,
  tehranDay, tehranNow, slotWindow, activeSlot, slotHour,
  SLOTS, SLOT_KEYS,
};
