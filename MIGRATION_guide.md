# راهنمای Migration داده — سیگنال هوش

این سند برای Claude Code است تا داده‌های فعلی production را بدون از دست رفتن به ساختار استاندارد منتقل کند.

---

## وضعیت فعلی داده روی سرور

روی `root@81.168.119.67:/opt/signal/data/`:

| فایل | نوع | محتوا | ریسک از دست رفتن |
|------|-----|-------|------------------|
| `users.json` | JSON | کاربران + پسورد hash + نقش | 🔴 بحرانی — لاگین به این وابسته است |
| `settings.json` | JSON | مدل AI انتخابی | 🟡 متوسط — قابل بازسازی |
| `h4.json`, `h24.json` | JSON | ترند فعلی (بدون تاریخچه) | 🟢 کم — هر ۱۵ دقیقه replace می‌شود |
| `digest_4h.json`, `digest_24h.json` | JSON | تحلیل AI ترند | 🟢 کم — بازتولید می‌شود |
| `market.db` | SQLite | محصولات + تاریخچه قیمت یک‌ساله | 🔴 بحرانی — تاریخچه غیرقابل بازیابی |
| `jobs.db` | SQLite | تاریخچه بازار کار یک‌ساله | 🔴 بحرانی — غیرقابل بازیابی |
| `news.db` | SQLite | کانال‌ها + اخبار ۳۰ روزه + digest | 🟡 متوسط — کانال‌ها مهم، اخبار replace می‌شوند |
| `tg_session.session` | Telethon | نشست لاگین تلگرام | 🔴 بحرانی — لاگین مجدد نیاز به کد SMS دارد |

---

## اصول Migration

### ۱. اول backup، بعد هر کاری
```bash
# روی سرور، قبل از هر migration
cd /opt/signal
mkdir -p data/backups/$(date +%Y%m%d_%H%M%S)
cp data/*.json data/*.db data/*.session data/backups/$(date +%Y%m%d_%H%M%S)/ 2>/dev/null
```

### ۲. Migration باید idempotent باشد
اجرای دوباره اسکریپت نباید داده را دوبار وارد کند یا خراب کند. از `INSERT OR IGNORE`، چک وجود، یا `CREATE TABLE IF NOT EXISTS` استفاده کن.

### ۳. اول روی کپی تست کن
هرگز migration تست‌نشده روی production اجرا نکن:
```bash
# یک کپی بگیر و migration را روی کپی اجرا کن
cp data/news.db /tmp/news_test.db
# اسکریپت را روی /tmp/news_test.db اجرا کن، نتیجه را چک کن
```

### ۴. tg_session را هرگز دست نزن
فایل نشست Telethon را کپی کن ولی migration رویش اجرا نکن. اگر خراب شود، لاگین مجدد نیاز به کد SMS دارد که فرآیند دستی است.

---

## سناریوهای Migration

### سناریو A: یکپارچه‌سازی JSON به SQLite (فاز ۳ استانداردسازی)

اگر تصمیم شد کاربران و تنظیمات از JSON به SQLite بروند:

**قبل از حذف JSON، اسکریپت migration بنویس:**

```javascript
// migrate-json-to-sqlite.js — نمونه ساختار
const Database = require('better-sqlite3');
const fs = require('fs');

function migrateUsers(db) {
  // 1. جدول را بساز (idempotent)
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    mobile TEXT UNIQUE,
    password TEXT,          -- hash موجود را دست نزن
    name TEXT,
    role TEXT,
    active INTEGER DEFAULT 1,
    ai_model TEXT,          -- فیلد جدید احتمالی (فاز فیچر)
    created_at TEXT
  )`);

  // 2. از JSON بخوان
  if (!fs.existsSync('./data/users.json')) return;
  const users = JSON.parse(fs.readFileSync('./data/users.json', 'utf8'));

  // 3. با INSERT OR IGNORE وارد کن (idempotent)
  const stmt = db.prepare(`INSERT OR IGNORE INTO users
    (id, mobile, password, name, role, active, created_at)
    VALUES (?,?,?,?,?,?,?)`);
  for (const u of users) {
    stmt.run(u.id, u.mobile, u.password, u.name, u.role,
             u.active ? 1 : 0, u.createdAt || new Date().toISOString());
  }
  console.log(`migrated ${users.length} users`);
}

// اجرا: node migrate-json-to-sqlite.js
// بعد از تأیید صحت، users.json را به users.json.bak تغییر نام بده (حذف نکن)
```

**قوانین این سناریو:**
- پسورد hash شده را **دست نزن** — همان hash موجود منتقل شود، دوباره hash نکن.
- بعد از migration، لاگین را با کاربر واقعی سوپرادمین (موبایل در `data/users.json`) تست کن.
- JSON قدیمی را حذف نکن، به `.bak` تغییر نام بده تا rollback ممکن باشد.

### سناریو B: تغییر schema دیتابیس موجود (افزودن ستون)

اگر نیاز به افزودن ستون به جدول موجود بود (مثلاً `ai_model` به users، یا فیلد جدید به news):

```javascript
// روش امن افزودن ستون — چک کن قبلاً اضافه نشده باشد
function addColumnIfNotExists(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`added ${column} to ${table}`);
  }
}
// مثال:
addColumnIfNotExists(db, 'news', 'media_type', 'TEXT');
```

**هرگز** `DROP TABLE` و بازسازی نکن — همیشه `ALTER TABLE`.

### سناریو C: نرمال‌سازی media در news.db

اگر media (که الان data-url یا JSON array در یک ستون است) به جدول جدا منتقل شود:

- جدول جدید `news_media(id, news_id, url, position)` بساز.
- اسکریپت migration بنویس که ستون `media_url` فعلی را پارس کند:
  - اگر با `[` شروع شد → JSON array → چند ردیف در `news_media`
  - اگر `data:` یا `http` بود → یک ردیف
- ستون `media_url` قدیمی را **فعلاً نگه دار** (حذف نکن) تا از عقب‌سازگاری مطمئن شوی.
- بعد از تست کامل UI، در یک migration جدا ستون قدیمی را حذف کن.

---

## چک‌لیست قبل از هر Migration روی Production

- [ ] backup کامل گرفته شد (`data/backups/`)
- [ ] اسکریپت migration روی کپی (`/tmp/`) تست شد
- [ ] اسکریپت idempotent است (دوبار اجرا خراب نمی‌کند)
- [ ] فایل‌های JSON/DB قدیمی حذف نمی‌شوند، فقط `.bak` می‌شوند
- [ ] `tg_session` دست‌نخورده است
- [ ] بعد از migration، این‌ها تست شدند:
  - [ ] لاگین سوپرادمین
  - [ ] نمایش هر ۴ ماژول داشبورد
  - [ ] جمع‌آوری تلگرام (`pm2 logs news-listener`)
  - [ ] تولید یک گزارش AI
- [ ] راه rollback مشخص است (backup + `.bak`ها)

---

## دستور rollback اضطراری

اگر migration خراب کرد:
```bash
cd /opt/signal
pm2 stop signal news-listener
# آخرین backup را برگردان
cp data/backups/<latest>/* data/
pm2 restart signal news-listener --update-env
```

---

## نکته مهم برای Claude Code

**تو به سرور production دسترسی مستقیم نداری.** اسکریپت‌های migration را بنویس و به کاربر بده تا او روی سرور اجرا کند. برای هر اسکریپت:
1. دقیقاً بگو کجا اجرا شود (`/opt/signal/`)
2. دستور backup را همراهش بده
3. دستور تست روی کپی را بده
4. دستور اجرای واقعی
5. دستور تأیید صحت (query شمارش رکوردها قبل/بعد)
6. راه rollback
