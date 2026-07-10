# CLAUDE.md — سیگنال هوش (Signal Hoosh)

> این فایل برای Claude Code است. کل معماری، قراردادها، و نکات حیاتی پروژه اینجاست.
> **زبان پروژه: فارسی (RTL).** همه UI و خروجی‌های کاربر فارسی هستند.

---

## پروژه چیست؟

**سیگنال هوش** یک داشبورد مانیتورینگ و تحلیل هوشمند فارسی است که چند منبع داده ایرانی را رصد می‌کند، هر منبع را با AI تحلیل می‌کند، و نتایج را در یک SPA نمایش می‌دهد.

**۴ ماژول فعال + ۱ در حال ساخت:**
1. **ترند سرچ ایران** — Google Trends + تحلیل AI (۴ ساعته و ۲۴ ساعته)
2. **مارکت کالای ایران** — دیجی‌کالا پرفروش‌ها + تاریخچه قیمت یک‌ساله
3. **مارکت کار ایران** — جابینجا + جاب‌ویژن + تحلیل AI
4. **ترند اخبار ایران** — کانال‌های تلگرام (Telethon) + ترجمه + گزارش AI
5. 🚧 **ترند سوشال ایران** (X/Twitter) — طراحی شده، پیاده نشده (به `SOCIAL_MODULE_SPEC.md` مراجعه کن)

---

## استک فعلی

| لایه | فناوری |
|------|--------|
| Backend | Node.js + Express (بدون TypeScript) |
| Frontend | **Vanilla HTML/CSS/JS در یک فایل ۲۱۰۰ خطی** (بدون فریمورک، بدون build step) |
| DB (ساخت‌یافته) | SQLite via `better-sqlite3` — مارکت، کار، اخبار |
| DB (ساده) | فایل‌های JSON — کاربران، تنظیمات، ترند |
| Auth | JWT دستی (`jsonwebtoken`) |
| AI | OpenRouter API (مدل‌های رایگان) |
| Crawling | Puppeteer (دیجی‌کالا، جابینجا، جاب‌ویژن)، Telethon/Python (تلگرام) |
| Process | PM2 |
| Charts | Chart.js (CDN) |

---

## زیرساخت سرور

- **سرور**: `root@81.168.119.67` — Ubuntu VPS
- **مسیر**: همه چیز در `/opt/signal/`
- **فرانت**: `/opt/signal/public/index.html`
- **پورت**: 3001

### پروسه‌های PM2
```bash
signal          # id:0 — Node.js اصلی (server.js)
news-listener   # id:2 — Python/Telethon، interpreter: /opt/signal/venv/bin/python3
```

### دستورات پرکاربرد
```bash
pm2 restart signal --update-env
pm2 restart news-listener
pm2 logs signal --lines 30 --nostream
pm2 logs news-listener --lines 30 --nostream
```

### دیپلوی (کاربر از کامپیوتر خودش scp می‌کند)
```bash
scp <backend-files> root@81.168.119.67:/opt/signal/
scp index.html root@81.168.119.67:/opt/signal/public/
```

---

## نقشه فایل‌ها

### هسته
| فایل | خطوط | نقش |
|------|------|-----|
| `server.js` | 328 | Express app، همه routeها، mount کردن routerها |
| `auth.js` | 50 | JWT sign/verify، middleware های `requireAuth` و `requireSuperAdmin` |
| `db.js` | 104 | کاربران (JSON در `data/users.json`) |
| `settings-db.js` | 32 | تنظیمات سیستم (JSON در `data/settings.json`) |

### ترند سرچ
| فایل | خطوط | نقش |
|------|------|-----|
| `crawler.js` | 247 | Google Trends crawler + RSS live |
| `ai-digest.js` | 190 | تحلیل AI ترند (۴h/۲۴h)، ۳ بار retry، خواندن مدل از settings |

### مارکت کالا — SQLite `data/market.db`
| فایل | نقش |
|------|-----|
| `market-crawler.js` | Puppeteer روی دیجی‌کالا best-selling |
| `market-db.js` | جداول `products` + `snapshots` (تاریخچه یک‌ساله) |
| `market-api.js` | endpointهای مارکت |

### مارکت کار — SQLite `data/jobs.db`
| فایل | نقش |
|------|-----|
| `job-crawler.js` | Puppeteer روی جابینجا + جاب‌ویژن |
| `job-db.js` | جدول `job_snapshots` (تاریخچه یک‌ساله) |
| `job-api.js` | endpointهای کار + تحلیل AI |

### اخبار — SQLite `data/news.db`
| فایل | نقش |
|------|-----|
| `news-db.js` | جداول `channels` + `news` (۳۰ روز) + `news_digest` (۷ روز) |
| `news-api.js` | endpointهای اخبار |
| `news-bot.js` | ترجمه (Google Translate رایگان) + گزارش AI |
| `news-listener.py` | Telethon (MTProto) — جمع‌آوری real-time تلگرام |

### فرانت
| فایل | نقش |
|------|-----|
| `public/index.html` | **کل SPA** — HTML + CSS + JS در یک فایل |

عکس کانال‌ها: `public/channel-photos/{id}.jpg`

---

## Schema دیتابیس‌ها

### market.db
```sql
CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  dk_id TEXT UNIQUE,        -- شناسه دیجی‌کالا
  title TEXT,
  url TEXT,
  image TEXT
);
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  product_id INTEGER,
  rank INTEGER,             -- رتبه (از ۱ شروع می‌شود)
  price INTEGER,
  date TEXT,                -- YYYY-MM-DD
  FOREIGN KEY(product_id) REFERENCES products(id)
);
```

### jobs.db
```sql
CREATE TABLE job_snapshots (
  id INTEGER PRIMARY KEY,
  source TEXT,              -- jobinja | jobvision
  category TEXT,            -- human-resources | accounting | ...
  count INTEGER,
  date TEXT                 -- YYYY-MM-DD
);
```

### news.db
```sql
CREATE TABLE channels (
  id INTEGER PRIMARY KEY,
  tg_id TEXT,               -- -100xxxx
  username TEXT,            -- @channel
  title TEXT,               -- اسم دستی کاربر (listener دست نمی‌زند)
  category TEXT,
  photo_url TEXT,           -- /channel-photos/{id}.jpg
  active INTEGER DEFAULT 1
);
CREATE TABLE news (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER,
  message_id INTEGER,
  text TEXT,
  text_fa TEXT,            -- ترجمه فارسی (اگر منبع غیرفارسی)
  lang TEXT,
  media_type TEXT,        -- photo | gallery | video | null
  media_url TEXT,         -- data-url یا JSON array (برای gallery)
  tg_link TEXT,
  published_at TEXT
);
CREATE TABLE news_digest (
  id INTEGER PRIMARY KEY,
  text TEXT,
  since TEXT,
  created_at TEXT
);
```

---

## AI — قوانین حیاتی

⚠️ **`openrouter/auto` را هرگز استفاده نکن** — credit مصرف می‌کند (خطای 402 می‌دهد).

### مدل‌های رایگان تست‌شده (کار می‌کنند)
```
openai/gpt-oss-20b:free              ← پیش‌فرض، بهترین خروجی فارسی
nvidia/nemotron-nano-12b-v2-vl:free
google/gemma-4-26b-a4b-it:free
nvidia/nemotron-3-ultra-550b-a55b:free
```

### مدل‌هایی که "Provider returned error" می‌دهند (استفاده نکن)
`qwen3-next`, `gpt-oss-120b`, `gemma-4-31b`, `llama-3.3-70b`, `dolphin-mistral`, `hermes-3`

### الگوی استاندارد فراخوانی
- همه فراخوانی‌ها باید مدل‌ها را **به ترتیب retry** کنند (اگر یکی fail شد، بعدی)
- مدل انتخابی از `settings-db.js` خوانده می‌شود
- endpoint: `GET /api/settings/ai-models` مدل‌ها را از OpenRouter می‌گیرد (cache 30 دقیقه)

### ترجمه اخبار غیرفارسی
از **Google Translate رایگان** (نه AI، چون credit می‌خورد):
```
https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=fa&dt=t&q=...
```

---

## API Endpoints

```
# Auth
POST   /api/auth/login              { mobile, password } → { token }
GET    /api/auth/me

# Admin (superadmin)
GET    /api/admin/users
POST   /api/admin/users
DELETE /api/admin/users/:id
PATCH  /api/admin/users/:id/toggle

# ترند
GET    /api/trends/4h | /api/trends/24h
GET    /api/digest/4h | /api/digest/24h
POST   /api/digest/:type/refresh

# مارکت
GET    /api/market/*

# کار
GET    /api/jobs/*
GET    /api/jobs/ai-analysis

# اخبار
GET    /api/news/feed?limit=20&offset=N&channel=ID
GET    /api/news/channels
POST   /api/news/channels
PATCH  /api/news/channels/:id
DELETE /api/news/channels/:id
GET    /api/news/digest
POST   /api/news/digest/generate
DELETE /api/news/news/:id                  # فقط superadmin
GET    /api/news/media?url=...             # proxy، فقط api.telegram.org/file/

# داخلی (از Telethon، header: X-Internal-Secret)
POST   /internal/news
POST   /internal/channel-info

# تنظیمات (superadmin)
GET    /api/settings
POST   /api/settings
GET    /api/settings/ai-models
```

---

## نحوه ذخیره داده

| بخش | روش | تاریخچه |
|-----|-----|---------|
| کاربران | `data/users.json` | — |
| ترند | `data/h4.json`, `h24.json`, `digest_4h.json`, `digest_24h.json` | ندارد (replace) |
| مارکت کالا | SQLite | یک سال |
| مارکت کار | SQLite | یک سال |
| اخبار | SQLite | خبر ۳۰ روز، digest ۷ روز |
| تنظیمات | `data/settings.json` | — |
| عکس کانال | فایل | — |

---

## نکات فنی حیاتی (درس‌های سخت)

1. **دیجی‌کالا `data-product-index` از ۱ شروع می‌شود** (نه 0). +1 نزن.
2. **Bot API تلگرام** فقط از کانال‌هایی که ادمین باشی پیام می‌دهد. برای همین **Telethon (MTProto با اکانت کاربر)** استفاده شد که کانال پابلیک را بدون ادمین بودن می‌خواند.
3. **Telethon باید عضو کانال باشد** (`JoinChannelRequest`) وگرنه `events.NewMessage` کار نمی‌کند.
4. **عکس‌ها base64 در DB** ذخیره می‌شوند (لینک تلگرام auth می‌خواهد). `express.json({limit})` باید بزرگ باشد.
5. **اعداد فارسی**: تابع `toFa()`. ⚠️ input موبایل لاگین باید با `toEn()` به انگلیسی تبدیل شود وگرنه لاگین می‌شکند.
6. **کانال تکراری**: `upsertChannel` و `getChannelByTgId` باید با username **هم** چک کنند (نه فقط tg_id).
7. **اسم دستی کانال حفظ می‌شود**: listener موقع آپدیت عکس، `title` را دست نمی‌زند.
8. **گالری چندعکسه**: Telethon آلبوم‌ها را با `grouped_id` جمع می‌کند (تابع `flush_album` با بافر ۱.۵ ثانیه)، در DB به صورت JSON array از data-url ذخیره می‌شود، `media_type='gallery'`.
9. **ویدیو پشتیبانی نمی‌شود** (auth تلگرام لازم دارد) — فقط لینک منبع.
10. **فید اخبار هرگز کل rebuild نمی‌شود** — polling فقط خبر جدید `prepend` می‌کند. وضعیت باز/بسته در `_newsExpandState` (Map) جداست. این ریشه باگ «بیشتر بخوان» بود.

---

## اطلاعات حساس (✅ فاز ۱ انجام شد — همه به `.env` منتقل شدند)

⚠️ **وضعیت قبلی (رفع شده در فاز ۱، ۲۰۲۶-۰۷-۱۰)**: کلید OpenRouter در `public/index.html` خط ۸۷۵ hardcode بود و به فرانت لو رفته بود؛ JWT secret و NODE_INTERNAL_SECRET هم مقدار پیش‌فرض hardcode در کد داشتند. همه این‌ها حذف شدند؛ الان فقط از `process.env` خوانده می‌شوند و سرور اگر `JWT_SECRET`/`NODE_INTERNAL_SECRET` در env نباشد اصلاً بالا نمی‌آید (fail-fast). لیست کامل متغیرهای مورد نیاز در `.env.example` است — **مقادیر واقعی هرگز در کد یا در این فایل قرار نمی‌گیرند.**

🔴 **اقدام باقیمانده از کاربر**: کلید OpenRouter قبلاً در فرانت عمومی قابل مشاهده بوده — باید از داشبورد OpenRouter یک کلید جدید ساخته شود و در `.env` سرور جایگزین شود (فقط کافیست مقدار `OPENROUTER_KEY` در `/opt/signal/.env` عوض و `pm2 restart signal --update-env` اجرا شود، نیازی به تغییر کد نیست).

---

## بدهی فنی شناخته‌شده (کاندیدای refactor)

- ✅ ~~کلید OpenRouter در فرانت لو رفته~~ — فاز ۱ رفع شد (کلید باید rotate شود، بالا را ببین)
- ✅ ~~`crawler.js` از `openrouter/auto` استفاده می‌کرد~~ — فاز ۱ رفع شد، الان مدل از تنظیمات خوانده می‌شود
- منطق فراخوانی AI در ۴ فایل تکرار شده (`ai-digest.js`, `news-bot.js`, `job-api.js`, `crawler.js`) — فاز ۲: یک ماژول `ai-client.js` مشترک
- `public/index.html` تک‌فایل ۲۱۰۰+ خطی با ۹۳ inline style — فاز ۵
- کاربران و تنظیمات JSON هستند ولی بقیه SQLite — فاز ۳
- عکس/گالری اخبار به صورت base64 داخل `news.db` ذخیره می‌شوند — همین باعث شده `news.db` با فقط ۱۳ روز داده به ۱.۳ گیگابایت برسد (۹۸٪ حجم فقط media است). باید مثل `channel-photos` به فایل روی دیسک منتقل شود — فاز ۳
- بدون تست، بدون validation ورودی، بدون error handling استاندارد — فاز ۶
- فراخوانی‌های `fetch` در فرانت تکراری و بدون لایه مشترک — فاز ۵
- `news-bot.js` هنوز یک polling loop با Telegram Bot API دارد که کنار Telethon واقعی اجرا می‌شود؛ احتمالاً بلااستفاده (نیاز به تصمیم صریح قبل از حذف)
- `news-api.js` به یک متغیر `CATEGORIES` تعریف‌نشده ارجاع می‌دهد (فعلاً بی‌ضرر چون فرانت آن endpoint را صدا نمی‌زند)
