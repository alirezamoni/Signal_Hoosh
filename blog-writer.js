/**
 * blog-writer.js — نوشتن مطلب روزانه‌ی وبلاگ با هوش مصنوعی
 *
 * پایان هر روز، داده‌های مهم همه‌ی تب‌ها (blog-facts.js) به مدل داده می‌شود و
 * خروجی به‌صورت **پیش‌نویس** ذخیره می‌شود. هیچ متنی بدون تأیید ادمین منتشر
 * نمی‌شود؛ انتشار فقط از پنل و با دست ادمین انجام می‌شود.
 *
 * پرامپت و مدل هر دو از تنظیمات خوانده می‌شوند تا بدون تغییر کد قابل ویرایش
 * باشند (blog_prompt و ai_model_blog در پنل مدیریت).
 */
const aiClient = require('./lib/ai-client');
const settingsDB = require('./settings-db');
const blogDB = require('./blog-db');
const facts = require('./blog-facts');
const md = require('./lib/markdown');

const TEHRAN_OFFSET_MIN = 3.5 * 60;   // ایران از ۱۴۰۱ ساعت تابستانی ندارد

function tehranNow() {
  return new Date(Date.now() + (TEHRAN_OFFSET_MIN + new Date().getTimezoneOffset()) * 60000);
}
function tehranDay(d) {
  const t = d || tehranNow();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

const DEFAULT_PROMPT = `تو نویسنده‌ی وبلاگ «سیگنال هوش» هستی؛ سایتی که داده‌های لحظه‌ای ایران را رصد می‌کند:
ترند جستجوی گوگل، اخبار کانال‌های تلگرام، بازارهای مالی و طلا، خودرو، ملک تهران، بازار کالا و بازار کار.

از روی داده‌های زیر، یک مطلب وبلاگ فارسی درباره‌ی مهم‌ترین اتفاق‌های امروز ایران بنویس.

قواعد مهم:
۱. فقط از همین اعداد و خبرها استفاده کن. هیچ عدد، آمار یا رویدادی از خودت اضافه نکن.
۲. خبرها مهم‌ترین بخش‌اند؛ مطلب را با مهم‌ترین خبر روز شروع کن، نه با اعداد بازار.
۳. لحن: خبری-تحلیلی، روان و کوتاه‌جمله. نه رسمیِ خشک، نه محاوره‌ای.
۴. طول: بین ۷۰۰ تا ۹۰۰ کلمه.
۵. عنوان باید کنجکاوی‌برانگیز و شامل کلیدواژه‌های پرجستجوی همان روز باشد (برای سئو)، ولی اغراق و تیتر دروغین ممنوع.
۶. متن را با ## به چند بخش تقسیم کن. هر بخش درباره‌ی یک حوزه (خبر، ترند جستجو، بازار مالی، طلا، خودرو، ملک...).
۷. در متن، جایی که طبیعی است به صفحه‌های سایت پیوند بده تا خواننده برای دیدن جزئیات لحظه‌ای وارد سایت شود:
   [ترند جستجوی ایران](/trends)، [اخبار](/news)، [بازارهای مالی](/finance)، [قیمت طلا](/finance)،
   [خودرو](/cars)، [ملک تهران](/property)، [بازار کالا](/market)، [بازار کار](/jobs)، [ترند آینده](/future).
   دست‌کم ۳ و حداکثر ۶ پیوند. متن پیوند باید توصیفی باشد، نه «اینجا کلیک کنید».
۸. در پایان یک جمع‌بندی کوتاه بنویس که خواننده را به دنبال‌کردن داده‌های لحظه‌ای سایت تشویق کند.
۹. از مارک‌داون فقط ##، ###، **پررنگ**، فهرست با - و پیوند [متن](نشانی) استفاده کن.

فقط و فقط یک JSON معتبر با این ساختار برگردان، بدون هیچ توضیح اضافه:
{
  "title": "عنوان مطلب",
  "excerpt": "خلاصه‌ی ۲ تا ۳ جمله‌ای برای صفحه‌ی فهرست وبلاگ",
  "meta_title": "عنوان سئو، حداکثر ۶۰ نویسه",
  "meta_desc": "توضیح متا برای گوگل، بین ۱۲۰ تا ۱۵۵ نویسه",
  "keywords": ["کلیدواژه۱", "کلیدواژه۲", "کلیدواژه۳"],
  "body": "متن کامل مطلب با مارک‌داون"
}

داده‌های امروز:
{{DATA}}`;

function getPrompt() {
  const p = settingsDB.get('blog_prompt', '');
  return (p && String(p).trim()) ? String(p) : DEFAULT_PROMPT;
}

function buildPrompt(f) {
  const block = facts.toPromptBlock(f);
  let p = getPrompt();
  if (p.indexOf('{{DATA}}') !== -1) p = p.replace('{{DATA}}', block);
  else p = p + '\n\nداده‌های امروز:\n' + block;
  return p.replace(/\{\{DATE\}\}/g, f.day);
}

function clean(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return max && t.length > max ? t.slice(0, max).replace(/\s+\S*$/, '') : t;
}

/**
 * ساخت پیش‌نویس برای یک روز.
 * @returns {{ok:boolean, id?:number, slug?:string, reason?:string}}
 */
async function generateFor(day, opts) {
  const o = opts || {};
  const d = day || tehranDay();

  const existing = blogDB.existsForDay(d);
  if (existing && !o.force) return { ok: false, reason: 'برای این روز از قبل مطلبی وجود دارد' };

  const f = facts.gather(d);
  if (!facts.isEnough(f) && !o.force) return { ok: false, reason: 'داده‌ی کافی برای این روز جمع نشده است' };

  if (aiClient.isPaused()) return { ok: false, reason: 'سهمیه‌ی روزانه‌ی مدل تمام شده — بعداً دوباره تلاش کنید' };

  const models = aiClient.getModels('ai_model_blog');
  const out = await aiClient.callJSON(buildPrompt(f), {
    max_tokens: 3000,
    tag: 'blog-writer',
    models,
    // مدل‌های رایگان گاهی JSON ناقص یا متن انگلیسی برمی‌گردانند؛ متن کوتاه به‌درد نمی‌خورد
    validate: j => j && typeof j.title === 'string' && typeof j.body === 'string' && j.body.length > 400,
  });
  if (!out) return { ok: false, reason: 'مدل خروجی معتبری برنگرداند' };

  const title = clean(out.title, 120);
  const body  = String(out.body || '').trim();
  if (!title || body.length < 400) return { ok: false, reason: 'خروجی مدل ناقص بود' };

  const excerpt = clean(out.excerpt, 300) || md.plain(body, 200);
  const keywords = Array.isArray(out.keywords) ? out.keywords.map(k => clean(k, 40)).filter(Boolean).slice(0, 12).join('، ')
    : clean(out.keywords, 300);

  const post = {
    day: d,
    title,
    body,
    excerpt,
    meta_title: clean(out.meta_title, 70) || title,
    meta_desc:  clean(out.meta_desc, 165) || excerpt,
    keywords,
    status: 'draft',
    ai_model: models[0] || null,
  };

  if (existing && o.force) {
    blogDB.update(existing.id, Object.assign({ slug: title }, post));
    return { ok: true, id: existing.id, slug: blogDB.byId(existing.id).slug, replaced: true };
  }
  const r = blogDB.create(post);
  return { ok: true, id: r.id, slug: r.slug };
}

// ── زمان‌بند ────────────────────────────────────────────────
// هر نیم‌ساعت بیدار می‌شود و اگر به ساعت مقرر (به وقت تهران) رسیده باشیم و
// مطلب امروز هنوز ساخته نشده باشد، می‌سازد. اجرای دوباره بی‌خطر است چون
// existsForDay جلوی تکرار را می‌گیرد.
const CHECK_MS = 30 * 60 * 1000;

async function tick() {
  try {
    const hour = Number(settingsDB.get('blog_hour', 23));
    const now = tehranNow();
    if (now.getHours() < (isFinite(hour) ? hour : 23)) return;
    const d = tehranDay(now);
    if (blogDB.existsForDay(d)) return;
    const r = await generateFor(d);
    if (r.ok) console.log(`[blog] پیش‌نویس ${d} ساخته شد — /admin?sec=blog`);
    else console.log(`[blog] ${d}: ${r.reason}`);
  } catch (e) {
    console.warn('[blog] tick error:', e.message);
  }
}

function startBlogScheduler(delayMs) {
  setTimeout(() => { tick(); setInterval(tick, CHECK_MS); }, delayMs || 5 * 60 * 1000);
  console.log(`[blog] زمان‌بند وبلاگ فعال — بررسی هر ۳۰ دقیقه، نوشتن پس از ساعت ${settingsDB.get('blog_hour', 23)} به وقت تهران`);
}

module.exports = { generateFor, startBlogScheduler, getPrompt, DEFAULT_PROMPT, tehranDay };
