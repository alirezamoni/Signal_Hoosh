# ARCHITECTURE.md — سیگنال هوش

> این سند در فاز ۰ (شناخت) نوشته شده، بر اساس خواندن کامل کد از production
> (`root@81.168.119.67:/opt/signal/`). هیچ کدی در این فاز تغییر نکرده است.

---

## نمای کلی

Signal Hoosh یک اپ Node.js/Express تک‌پروسه‌ای (+ یک پروسه پایتون کمکی) است.
هر ماژول یک الگوی تکرارشونده دارد:

```
[Crawler / Listener] → [ذخیره‌سازی (SQLite یا JSON)] → [API لایه Express] → [index.html (fetch + render)]
                              ↑
                    [لایه AI اختیاری (OpenRouter)] برای تحلیل/ترجمه
```

دو پروسه PM2 روی سرور اجرا می‌شوند:
- `signal` (id 0) → `server.js` — کل Express app + همه schedulerهای in-process (crawler، دایجست AI، مارکت، کار، بات اخبار)
- `news-listener` (id 1) → `news-listener.py` — Telethon MTProto listener، مستقل از Node

هیچ nginx / reverse proxy روی سرور نصب نیست؛ اپ مستقیم روی پورت 3001 گوش می‌دهد.
سرور یک `git` repo نیست (فایل‌ها مستقیم با scp/دستی مدیریت می‌شوند).

---

## ماژول ۱ — ترند سرچ ایران

**فایل‌ها:** `crawler.js` (321 خط) → `data/h4.json`, `data/h24.json`, `data/rss_live.json` → مصرف در `server.js` → رندر در `index.html`

جریان داده:
1. `crawler.js` با Puppeteer به `trends.google.com/trending?geo=IR` می‌رود (هر ۴ و ۲۴ ساعت را جدا اسکرپ می‌کند)، هر ۵ دقیقه (`CONFIG.intervalMs`).
2. کلیدواژه‌ها استخراج و پارس می‌شوند (حجم، رشد، وضعیت فعال/پایان‌یافته).
3. یک فراخوانی AI برای دسته‌بندی فارسی همه کلیدواژه‌ها (`aiCategorize`) — **⚠️ با مدل `openrouter/auto`** که طبق CLAUDE.md ممنوع است (احتمال خطای 402).
4. نتیجه در `data/h4.json` / `data/h24.json` ذخیره می‌شود (کامل replace، بدون تاریخچه).
5. یک RSS poller جدا (هر ۳۰ ثانیه) از `trends.google.com/trending/rss?geo=IR` برای live ticker در `data/rss_live.json`.
6. `server.js` این فایل‌ها را از طریق `GET /api/trends/4h|24h` و `GET /api/rss/live` سرو می‌کند.
7. `index.html`: `fetchTrends()` هر ۵ دقیقه poll می‌کند، `renderHotGrid`/`renderTable` رندر می‌کنند.

**تحلیل AI جدا (دایجست):** `ai-digest.js` (190 خط) — مجزا از crawler.js:
- هر ۱۵ دقیقه یک خلاصه ۵-جمله‌ای فارسی از ۴h، هر ۳ ساعت برای ۲۴h.
- مدل از `settings-db.js` خوانده می‌شود + fallback به لیست ۴ مدل رایگان ثابت (`FREE_MODELS`)، با ۳ بار retry (فاصله ۱ دقیقه) و امتیازدهی به کامل‌بودن/فارسی‌بودن خروجی.
- خروجی در `data/digest_4h.json` / `digest_24h.json`.
- سرو با `GET /api/digest/:type` + `POST /api/digest/:type/refresh` (دستی).
- **این الگوی retry/fallback بهترین نسخه در کل پروژه است** — کاندید خوب برای پایه `lib/ai-client.js` در فاز ۲.

---

## ماژول ۲ — مارکت کالای ایران

**فایل‌ها:** `market-crawler.js` (147) → `market-db.js` (259، SQLite `data/market.db`) → `market-api.js` (73) → `index.html` (`loadMarket`)

1. `market-crawler.js` هر ۲۴ ساعت با Puppeteer صفحه best-selling دیجی‌کالا را می‌گیرد (`digikala.com/best-selling`).
2. رتبه از `data-product-index` (که از ۱ شروع می‌شود — نکته حیاتی #1 در CLAUDE.md) یا fallback به متن استخراج می‌شود.
3. `market-db.js`: دو جدول `products` (شناسه ثابت محصول) و `snapshots` (رتبه/قیمت روزانه، `UNIQUE(product_id, source, snap_date)`). WAL mode.
4. Query‌های آماده برای مقایسه با دیروز/هفته قبل/ماه قبل (`getLatestList`)، کارت‌های خلاصه (`getSummaryCards`: داغ/سرد/گران‌شده/ارزان‌شده)، `getHotProducts`, `getColdProducts`, `getNewEntrants`, `getLegends` (پرفروش ماندگار)، آمار دسته/برند.
5. cleanup خودکار snapshotهای قدیمی‌تر از ۳۶۵ روز.
6. `market-api.js` یک router ساده Express است که مستقیم متدهای `market-db.js` را expose می‌کند — **بدون هیچ لایه AI**.
7. فرانت: `loadMarket()` بسته به تب فعال یکی از ۷ endpoint را می‌گیرد و جدول/کارت را رندر می‌کند.

---

## ماژول ۳ — مارکت کار ایران

**فایل‌ها:** `job-crawler.js` (108) → `job-db.js` (145، SQLite `data/jobs.db`) → `job-api.js` (79) → `index.html` (`loadJobs`, `loadJobsAI`)

1. هر ۲۴ ساعت، Puppeteer شمارش آگهی‌های کل جابینجا + کل و ۷ دسته‌بندی جاب‌ویژن را از متن صفحه با regex می‌خواند (نه DOM ساخت‌یافته — شکننده اگر متن صفحه تغییر کند).
2. `job_snapshots` (source, category, count, snap_date) با WAL.
3. `getSummary()` یک محاسبه EHI (Employment Health Index) دارد: نسبت شمارش امروز به میانگین ۳۰ روز × ۲ — منطق دامنه‌ای (business logic) که در schema مستند نشده؛ باید مستند بماند.
4. `job-api.js`: endpoint `GET /ai-analysis` **مستقیم و بدون استفاده از `settings-db` fallback list یا retry** یک فراخوانی تکی به OpenRouter می‌زند (فقط مدل انتخابی از تنظیمات، بدون fallback در صورت شکست) — ناهم‌خوان با الگوی `ai-digest.js`.

---

## ماژول ۴ — ترند اخبار ایران

این پیچیده‌ترین ماژول است؛ **دو مسیر جمع‌آوری موازی** دارد:

### مسیر الف (فعال، اصلی): Telethon → `/internal/*`
1. `news-listener.py` با اکانت واقعی کاربر (شماره در `.env`، session در `data/tg_session.session`) به تلگرام وصل می‌شود (MTProto، نه Bot API — چون Bot API فقط کانال‌هایی که ربات ادمینشه را می‌بیند؛ نکته حیاتی #2 در CLAUDE.md).
2. کانال‌های رصدشده از `data/watched_channels.json` خوانده می‌شوند (این فایل را `news-api.js` هر بار افزودن/ویرایش/حذف کانال می‌نویسد).
3. لیسنر باید عضو هر کانال باشد (`JoinChannelRequest` بیرون از این فایل انجام شده — دستی).
4. پیام‌های جدید (`events.NewMessage`) با فیلتر روی لیست مجاز گرفته می‌شوند؛ آلبوم‌های چندعکسه با `grouped_id` بافر و بعد از ۱.۵ ثانیه یک‌جا flush می‌شوند (`flush_album`).
5. مدیا با `download_media` دانلود و base64 می‌شود (mime واقعی از magic bytes تشخیص داده می‌شود، نه فقط فرمت تلگرام) — چون لینک تلگرام auth می‌خواهد.
6. با `POST /internal/news` (هدر `X-Internal-Secret`) به Node فرستاده می‌شود.
7. `server.js` → `newsDB.upsertChannel` (اگر کانال جدید بود) → `translateAndSave` در `news-bot.js`.
8. `translateAndSave`: تشخیص زبان (`detectLang` — بر پایه نسبت حروف عربی/انگلیسی/فارسی)، اگر غیرفارسی بود ترجمه با Google Translate رایگان (نه AI — نکته آگاهانه در CLAUDE.md برای صرفه‌جویی credit)، سپس `news-db.js: saveNews`.
9. عکس پروفایل کانال با `POST /internal/channel-info` جدا فرستاده و در `public/channel-photos/{id}.jpg` ذخیره می‌شود (اسم دستی کاربر حفظ می‌شود — `title` در `updateChannel` دست‌نخورده می‌ماند).

### مسیر ب (کد هست، ولی احتمالاً بلااستفاده): Telegram Bot API polling در `news-bot.js`
- `startNewsBot()` هر ۲ ثانیه `getUpdates` را روی `TELEGRAM_BOT_TOKEN` poll می‌کند و پیام‌های `channel_post` را پردازش می‌کند.
- طبق نکته حیاتی #2 در CLAUDE.md، این مسیر فقط برای کانال‌هایی کار می‌کند که ربات در آن‌ها ادمین است — که برای کانال‌های خبری واقعی معمولاً برقرار نیست. **این کد زنده است (در پروسه `signal` اجرا می‌شود) ولی احتمالاً هیچ داده مفیدی نمی‌گیرد.** نیاز به بررسی/حذف در فاز‌های بعد (به کاربر گزارش شود، حذف نشود بدون تأیید).

### دایجست اخبار
- `generateDigest()` در `news-bot.js` (هم از پولر داخلی، هم از endpoint `/api/news/digest/generate` صدا زده می‌شود) هر ۴ ساعت خبرهای ۴ ساعت اخیر را با AI به یک گزارش ۵-۷ جمله‌ای تبدیل می‌کند (fallback لیست مدل، ولی retry واحد per model نه چندباره مثل ai-digest.js).
- `news_digest` جدول جدا در `news.db`.

### فید و رندر فرانت
- `GET /api/news/feed?limit&offset&channel` → `newsDB.getLatestNews`.
- فرانت (`loadNews`, `renderNewsFeed`, `pollNewNews`) **هرگز کل فید را rebuild نمی‌کند** — فقط `prepend` برای خبر جدید (poll هر ۵ ثانیه)، `append` برای «بیشتر بخوان». وضعیت باز/بسته متن‌های بلند در `_newsExpandState` (Map جدا از DOM) نگه داشته می‌شود — این دقیقاً نکته حیاتی #10 در CLAUDE.md است و علت باگ قبلی «بیشتر بخوان» بوده.
- عکس/ویدیوی تلگرام از طریق پروکسی سمت سرور `GET /api/news/media?url=...` (فقط `api.telegram.org/file/` مجاز است) چون لینک مستقیم auth می‌خواهد.

### باگ کشف‌شده (مستند، اصلاح نشده در این فاز)
`news-api.js` خط ۳۶: `router.get('/categories', (req,res)=>{res.json(CATEGORIES)})` — متغیر `CATEGORIES` هرگز در این فایل تعریف/import نشده → این endpoint اگر صدا زده شود `ReferenceError` می‌دهد (۵۰۰). خوشبختانه فرانت این endpoint را صدا نمی‌زند (دسته‌ها را از لیست کانال‌ها client-side می‌سازد)، پس در عمل بی‌ضرر است ولی باید در فاز کیفیت (۶) یا فاز AI (۲) پاک/فیکس شود.

---

## احراز هویت و کاربران

- `db.js`: کاربران در `data/users.json` (bcrypt hash، بدون SQLite).
- `auth.js`: JWT دستی، امضا با `signToken`، انقضا ۷ روز. `requireAuth` و `requireSuperAdmin` middleware.
- توکن در فرانت در `localStorage['signal_token']` نگه داشته می‌شود و به صورت هدر `Authorization: Bearer <token>` فرستاده می‌شود.
- **نکته**: `auth.js` یک fallback به `req.cookies?.token` دارد ولی `cookie-parser` هرگز در `server.js` mount نشده (`app.use(cookieParser())` وجود ندارد) — این مسیر همیشه `undefined` است، کد مرده‌ی بی‌ضرر. `cookie-parser` در `package.json` هست ولی عملاً بلااستفاده.
- سوپرادمین پیش‌فرض روی اولین اجرا با `db.seedSuperAdmin()` ساخته می‌شود (موبایل/پسورد از env یا مقدار hardcode).
- مدیریت کاربران (افزودن/حذف/toggle) فقط برای `superadmin` — از طریق `/api/admin/users*`.

---

## تنظیمات سیستم

- `settings-db.js`: فایل تخت JSON (`data/settings.json`)، فقط یک کلید فعال (`ai_model`).
- هر ماژول AI (`ai-digest.js`, `news-bot.js`, `job-api.js`) **جدا** `settingsDB.get('ai_model', ...)` را می‌خواند و لیست fallback خودش را دارد (کد تکراری — دقیقاً بدهی فنی مذکور در CLAUDE.md).
- `GET /api/settings/ai-models` از OpenRouter لیست مدل‌ها را می‌گیرد (cache حافظه ۳۰ دقیقه‌ای)، مدل‌های پیشنهادی (`FREE_DEFAULTS`) را pin می‌کند.

---

## نقشه فراخوانی AI (برای فاز ۲)

سه پیاده‌سازی مستقل و ناهم‌خوان از «تماس با OpenRouter»:

| فایل | الگو | مدل‌ها | retry | timeout |
|---|---|---|---|---|
| `crawler.js` (`aiCategorize`) | تک تماس | **`openrouter/auto`** (⚠️ ممنوع طبق CLAUDE.md) | ندارد | ندارد (فقط via https default) |
| `ai-digest.js` (`callAI`/`fetchWithRetry`) | fallback لیست + retry با امتیازدهی | از settings + `FREE_MODELS` | ۳ بار با فاصله ۶۰ ثانیه، هر بار همه مدل‌ها | ۳۰s |
| `news-bot.js` (`generateDigest`) | fallback لیست، یک‌بار در هر مدل | از settings + `FREE_MODELS` | یک دور روی لیست مدل‌ها، بدون retry تکراری | ۳۰s |
| `job-api.js` (`/ai-analysis`) | تک مدل، بدون fallback | فقط مدل تنظیمات | ندارد | ۲۵s |

نتیجه‌گیری برای فاز ۲: الگوی `ai-digest.js` باید پایه‌ی `lib/ai-client.js` شود (بهترین retry/fallback)، با این تفاوت که پارامترهای prompt/max_tokens/امتیازدهی کامل‌بودن باید قابل‌تنظیم per-caller بمانند چون هرکدام از این سه فایل نیاز/طول خروجی متفاوت دارند.

---

## نقشه اسرار (Phase 1 hardcode findings)

جدول کامل در `.env.example` آمده. خلاصه محل‌ها:

> ✅ **به‌روزرسانی فاز ۱ (۲۰۲۶-۰۷-۱۰):** همه موارد زیر رفع شدند — همه به `.env` منتقل شدند، `NODE_INTERNAL_SECRET` و `JWT_SECRET` مقدار جدید تصادفی گرفتند، سرور اگر این دو در env نباشند بالا نمی‌آید. جدول زیر برای مستندسازی **وضعیت قبل از فاز ۱** نگه داشته شده (مقادیر واقعی/قدیمی عمداً حذف شده‌اند چون این سند می‌رود روی یک ریپازیتوری عمومی).

| راز | کجا hardcode بود | ریسک | وضعیت |
|---|---|---|---|
| `OPENROUTER_KEY` | `ecosystem.config.js` **و** `public/index.html:875` (به فرانت لو رفته بود) | 🔴 بحرانی | ✅ منتقل شد به `.env`؛ چون قبلاً در فرانت عمومی بود، کاربر باید از داشبورد OpenRouter rotate کند |
| `TELEGRAM_BOT_TOKEN` | `ecosystem.config.js` | 🟡 | ✅ منتقل شد به `.env` (rotate نشد، فقط سمت سرور بود) |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` / `TELEGRAM_PHONE` | `ecosystem.config.js` + hardcode تکراری در `news-listener.py`/`setup-news.sh` | 🔴 بحرانی (اکانت واقعی کاربر تلگرام، نه بات) | ✅ منتقل شد به `.env` — **عمداً rotate نشد** (تغییرش یعنی از‌نو ساختن session با کد SMS) |
| `NODE_INTERNAL_SECRET` | مقدار پیش‌فرض hardcode در `server.js`/`news-listener.py`/`setup-news.sh` | 🟡 متوسط | ✅ منتقل به `.env` + مقدار جدید تصادفی (هر دو پروسه هم‌زمان restart شدند) |
| JWT secret | مقدار پیش‌فرض hardcode در `auth.js` | 🔴 بحرانی (جعل JWT superadmin ممکن بود) | ✅ منتقل به `.env` + مقدار جدید تصادفی (یعنی کاربران باید یک‌بار دوباره لاگین کنند) |
| ADMIN_MOBILE / ADMIN_PASS | مقدار پیش‌فرض hardcode در `db.js` | 🟡 | ✅ حذف شد؛ الان اگر ست نباشد seed اولیه فقط با پیام خطا رد می‌شود (بی‌ضرر چون کاربر واقعی از قبل وجود دارد) |

---

## نکات معماری برای فازهای بعد (مشاهدات، نه اقدام در فاز ۰)

1. **دو کپی از `index.html`**: یک نسخه در ریشه `/opt/signal/index.html` (قدیمی‌تر، ۱۶۶۷ خط) و نسخه واقعی سرو شده در `/opt/signal/public/index.html` (۲۱۴۷ خط، دقیقاً همانی که در CLAUDE.md اشاره شده). نسخه ریشه توسط Express سرو **نمی‌شود** (`express.static` و SPA fallback هر دو از پوشه `public` می‌خوانند) — احتمالاً باقیمانده‌ی یک نسخه قدیمی‌تر است. باید از کاربر پرسیده شود آیا می‌شود حذفش کرد یا نگه داریم برای مقایسه (پیشنهاد: قبل از هر migration، backup بگیریم و بعد حذف کنیم، طبق اصل «هیچ داده‌ای پاک نشود» چون شاید عمداً نگه داشته شده).
2. **`fix-parse.js`** و **`setup-news.sh`**: اسکریپت‌های یک‌باره نگهداری/راه‌اندازی هستند، بخشی از اپلیکیشن اصلی نیستند ولی مسیر `/opt/signal` را hardcode دارند. باید در ساختار جدید به یک پوشه `scripts/` منتقل شوند (فاز بعدی).
3. **`crawler.js` هنوز `openrouter/auto` دارد** — این هم یک باگ امنیتی/هزینه‌ای (402) و هم نقض مستقیم قانون سخت #4 در CLAUDE.md. اولویت بالا برای فاز ۲ (یا حتی فوری‌تر، چون هزینه واقعی OpenRouter credit می‌خورد).
4. **کاربران/تنظیمات JSON در برابر بقیه SQLite** — دقیقاً همانی که CLAUDE.md به عنوان بدهی فنی اشاره کرده؛ گزینه‌های فاز ۳ در MIGRATION_guide.md مستند شده.
5. **جمع‌آوری اخبار موازی (Bot API polling + Telethon)** — نیاز به تصمیم صریح کاربر: آیا `startNewsBot()`'s polling (خط ۲۷۱ به بعد `news-bot.js`) باید غیرفعال/حذف شود؟ چون Telethon مسیر واقعی جمع‌آوری است طبق نکته حیاتی #2 در CLAUDE.md.
6. **بدون nginx/TLS** — دسترسی مستقیم روی پورت 3001. اگر دامنه‌ای برای production در نظر است، باید nginx + Let's Encrypt در فازهای دیپلوی اضافه شود (خارج از اسکوپ فازهای ۰-۶ استانداردسازی کد، ولی باید قبل از انتشار عمومی/production نهایی به کاربر گفته شود).
7. **پروسه سرور `git` نیست** — فعلاً کد با `scp` دستی مدیریت می‌شود. راه‌اندازی deploy از طریق git (فاز نهایی کاربر: push به GitHub + بردن روی production) باید مسیر amن (deploy key یا SSH مشابه) داشته باشد، نه commit مستقیم اسرار.

---

## فایل‌های موجود که در نقشه CLAUDE.md نبودند

- `fix-parse.js` — اسکریپت یک‌باره اصلاح فرمت اعداد در `h4.json`/`h24.json` (مسیر hardcode به `/opt/signal/data`)
- `setup-news.sh` — اسکریپت نصب Telethon + ساخت session + راه‌اندازی PM2 برای news-listener (شامل هاردکد `API_ID`/`API_HASH`)
- `index.html` ریشه (کپی قدیمی، سرو نمی‌شود — نگاه کن بالا)
- `package-lock.json`

---

## خلاصه Endpoint ↔ فایل ↔ داده (جدول تکمیلی روی CLAUDE.md)

| Endpoint | فایل | منبع داده |
|---|---|---|
| `POST /api/auth/login`, `GET /api/auth/me` | `server.js` + `auth.js` + `db.js` | `data/users.json` |
| `/api/admin/users*` | `server.js` + `db.js` | `data/users.json` |
| `/api/market/*` | `market-api.js` | `data/market.db` |
| `/api/jobs/*` | `job-api.js` | `data/jobs.db` + OpenRouter (ai-analysis) |
| `/api/news/*` | `news-api.js` + `news-db.js` + `news-bot.js` | `data/news.db` + `data/watched_channels.json` |
| `/api/news/media` | `server.js` (پروکسی مستقیم) | تلگرام CDN |
| `/internal/news`, `/internal/channel-info` | `server.js` + `news-db.js` + `news-bot.js` | از `news-listener.py` |
| `/api/trends/4h|24h`, `/api/rss/live` | `server.js` + `crawler.js` | `data/h4.json`, `h24.json`, `rss_live.json` |
| `/api/digest/:type`, `/api/digest/:type/refresh` | `server.js` + `ai-digest.js` | `data/digest_4h.json`, `digest_24h.json` |
| `/api/settings*` | `server.js` + `settings-db.js` | `data/settings.json` |
