/**
 * blog-db.js — وبلاگ سیگنال هوش (data/blog.db)
 *
 * هر شب یک پیش‌نویس از داده‌های همان روز ساخته می‌شود و تا وقتی ادمین
 * نخوانده و منتشر نکرده، هیچ‌جای سایت دیده نمی‌شود. برای همین status
 * ستون اصلی این جدول است و همه‌ی پرس‌وجوهای عمومی رویش فیلتر دارند.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'blog.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS blog_posts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slug         TEXT UNIQUE NOT NULL,
    day          TEXT,                    -- روزی که داده‌های متن مال آن است
    title        TEXT NOT NULL,
    excerpt      TEXT,
    body         TEXT NOT NULL,           -- مارک‌داونِ محدود (lib/markdown.js)
    cover        TEXT,                    -- مسیر عکس روی خود سرور
    cover_alt    TEXT,
    meta_title   TEXT,
    meta_desc    TEXT,
    keywords     TEXT,
    status       TEXT NOT NULL DEFAULT 'draft',   -- draft | published
    ai_model     TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    published_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_blog_status ON blog_posts(status, published_at DESC);
  CREATE INDEX IF NOT EXISTS idx_blog_day    ON blog_posts(day);
`);

// ── مهاجرت: از یک مطلب در روز به دو مطلب در روز ──────────────
// تا پیش از این، «روز» کلید یکتای مطلب بود. حالا هر روز دو نوبت دارد
// (صبح و شب) و هر نوبت بازه‌ی داده‌ی خودش را دارد، پس روز به‌تنهایی دیگر
// کافی نیست. ستون‌ها با ALTER اضافه می‌شوند تا ۱۲ مطلب موجود دست‌نخورده
// بمانند؛ آن‌ها slot خالی می‌گیرند و در منطق نوبت‌ها شرکت نمی‌کنند.
{
  const have = db.prepare("SELECT name FROM pragma_table_info('blog_posts')").all().map(c => c.name);
  const add = (col, decl) => { if (!have.includes(col)) db.exec(`ALTER TABLE blog_posts ADD COLUMN ${col} ${decl}`); };
  add('slot',     'TEXT');   // morning | evening | NULL برای مطالب قدیمی
  add('win_from', 'TEXT');   // ابتدای بازه‌ی داده (ISO/UTC)
  add('win_to',   'TEXT');   // انتهای بازه‌ی داده (ISO/UTC)
  add('cover_cost', 'REAL'); // هزینه‌ی دلاری تولید عکس، برای ردیابی مصرف
  add('trend_key', 'TEXT');  // کلیدواژه‌ی موضوعِ مقاله‌ی ترندمحور
  add('trend_vol', 'INTEGER');
  add('parent_id', 'INTEGER'); // مقاله‌ی قبلیِ همین موضوع، برای زنجیره‌ی ادامه‌دار
  db.exec('CREATE INDEX IF NOT EXISTS idx_blog_day_slot ON blog_posts(day, slot)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_blog_trend ON blog_posts(trend_key, published_at DESC)');
}

// ── ساخت نامک (slug) ───────────────────────────────────────
// گوگل نامک فارسی را بی‌مشکل ایندکس می‌کند و برای کاربر فارسی‌زبان هم
// خواناتر از حروف‌نگاری لاتین است. فقط باید از نویسه‌های خطرناکِ مسیر پاک شود.
function slugify(text) {
  let s = String(text || '').trim()
    .replace(/[‌‎‏]/g, ' ')          // نیم‌فاصله و نویسه‌های جهت
    .replace(/[^؀-ۿ\w\s-]/g, '')          // فقط فارسی/لاتین/رقم/فاصله/خط‌تیره
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!s) s = 'post';
  return s.slice(0, 80);
}

const _slugTaken = db.prepare('SELECT 1 FROM blog_posts WHERE slug=? AND id IS NOT ?');
function uniqueSlug(base, ignoreId) {
  const root = slugify(base);
  let s = root, n = 2;
  while (_slugTaken.get(s, ignoreId == null ? null : ignoreId)) { s = root + '-' + n; n++; }
  return s;
}

// ── نوشتن ──────────────────────────────────────────────────
function create(p) {
  const now = new Date().toISOString();
  const slug = uniqueSlug(p.slug || p.title, null);
  const info = db.prepare(`
    INSERT INTO blog_posts
      (slug, day, slot, win_from, win_to, trend_key, trend_vol, parent_id,
       title, excerpt, body, cover, cover_alt,
       meta_title, meta_desc, keywords, status, ai_model, created_at, updated_at, published_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    slug, p.day || null, p.slot || null, p.win_from || null, p.win_to || null,
    p.trend_key || null, p.trend_vol == null ? null : Number(p.trend_vol),
    p.parent_id == null ? null : Number(p.parent_id),
    p.title, p.excerpt || null, p.body,
    p.cover || null, p.cover_alt || null, p.meta_title || null, p.meta_desc || null,
    p.keywords || null, p.status || 'draft', p.ai_model || null, now, now,
    p.status === 'published' ? now : null
  );
  return { id: info.lastInsertRowid, slug };
}

function update(id, p) {
  const cur = byId(id);
  if (!cur) return null;
  const slug = p.slug != null ? uniqueSlug(p.slug || p.title || cur.title, id) : cur.slug;
  db.prepare(`
    UPDATE blog_posts SET
      slug=?, title=?, excerpt=?, body=?, cover=?, cover_alt=?,
      meta_title=?, meta_desc=?, keywords=?, updated_at=?
    WHERE id=?
  `).run(
    slug,
    p.title != null ? p.title : cur.title,
    p.excerpt != null ? p.excerpt : cur.excerpt,
    p.body != null ? p.body : cur.body,
    p.cover != null ? p.cover : cur.cover,
    p.cover_alt != null ? p.cover_alt : cur.cover_alt,
    p.meta_title != null ? p.meta_title : cur.meta_title,
    p.meta_desc != null ? p.meta_desc : cur.meta_desc,
    p.keywords != null ? p.keywords : cur.keywords,
    new Date().toISOString(), id
  );
  return byId(id);
}

function setStatus(id, status) {
  const now = new Date().toISOString();
  if (status === 'published') {
    // published_at فقط بار اول ست می‌شود تا انتشار دوباره، تاریخ اصلی
    // (و ترتیب سایت‌مپ و فید) را جابه‌جا نکند
    db.prepare(`UPDATE blog_posts SET status='published',
                published_at=COALESCE(published_at, ?), updated_at=? WHERE id=?`).run(now, now, id);
  } else {
    db.prepare(`UPDATE blog_posts SET status='draft', updated_at=? WHERE id=?`).run(now, id);
  }
  return byId(id);
}

function remove(id) { return db.prepare('DELETE FROM blog_posts WHERE id=?').run(id).changes; }

// ── خواندن ─────────────────────────────────────────────────
function byId(id) { return db.prepare('SELECT * FROM blog_posts WHERE id=?').get(id) || null; }
function bySlug(slug) { return db.prepare('SELECT * FROM blog_posts WHERE slug=?').get(String(slug || '')) || null; }
function publishedBySlug(slug) {
  return db.prepare("SELECT * FROM blog_posts WHERE slug=? AND status='published'").get(String(slug || '')) || null;
}

function listPublished(limit = 12, offset = 0) {
  return db.prepare(`SELECT * FROM blog_posts WHERE status='published'
                     ORDER BY published_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
}
function countPublished() {
  return db.prepare("SELECT COUNT(*) c FROM blog_posts WHERE status='published'").get().c;
}
function listAll(limit = 60) {
  // پیش‌نویس‌ها اول: کاری که منتظر ادمین است باید بالای فهرست پنل باشد
  return db.prepare(`SELECT * FROM blog_posts
                     ORDER BY (status='draft') DESC, COALESCE(published_at, created_at) DESC
                     LIMIT ?`).all(limit);
}
function existsForDay(day) {
  return db.prepare('SELECT * FROM blog_posts WHERE day=?').get(String(day || '')) || null;
}
/**
 * آیا مطلبِ این نوبتِ این روز از قبل ساخته شده؟
 * جای existsForDay را در زمان‌بند می‌گیرد: حالا روز دو نوبت دارد و
 * وجودِ مطلب صبح نباید جلوی ساخته‌شدن مطلب شب را بگیرد.
 */
function existsForSlot(day, slot) {
  return db.prepare('SELECT * FROM blog_posts WHERE day=? AND slot=?')
           .get(String(day || ''), String(slot || '')) || null;
}
/**
 * آخرین مقاله‌ی ترندمحور درباره‌ی همین موضوع در N روز اخیر.
 *
 * تطبیق دو مرحله‌ای است چون کلیدواژه‌ی ترند روزبه‌روز کمی فرق می‌کند
 * («لارک» امروز، «حمله به لارک» فردا): اول تطبیق دقیق trend_key، بعد
 * جستجوی کلیدواژه داخل موضوع یا عنوان مقاله‌های قبلی.
 */
function recentTrendArticle(trendKey, days) {
  const k = String(trendKey || '').trim();
  if (!k) return null;
  const since = new Date(Date.now() - (days || 3) * 864e5).toISOString();

  let row = db.prepare(`
    SELECT * FROM blog_posts
    WHERE slot='trend' AND status='published' AND trend_key = ? AND published_at >= ?
    ORDER BY published_at DESC LIMIT 1`).get(k, since);

  if (!row) {
    row = db.prepare(`
      SELECT * FROM blog_posts
      WHERE slot='trend' AND status='published' AND published_at >= ?
        AND (trend_key LIKE ? OR ? LIKE '%'||trend_key||'%' OR title LIKE ?)
      ORDER BY published_at DESC LIMIT 1`).get(since, '%'+k+'%', k, '%'+k+'%');
  }
  if (!row) return null;

  const days_ago = Math.floor((Date.now() - new Date(row.published_at).getTime()) / 864e5);
  return Object.assign({}, row, { daysAgo: days_ago });
}

/** زنجیره‌ی مقاله‌های یک موضوع — برای نمایش «پیشینه» زیر مقاله */
function trendChain(postId, limit) {
  const p = byId(postId);
  if (!p || !p.trend_key) return [];
  return db.prepare(`
    SELECT id, slug, title, published_at FROM blog_posts
    WHERE slot='trend' AND status='published' AND trend_key = ? AND id IS NOT ?
    ORDER BY published_at DESC LIMIT ?`).all(p.trend_key, postId, limit || 4);
}

function setTrendMeta(id, key, vol, parentId) {
  db.prepare('UPDATE blog_posts SET trend_key=?, trend_vol=?, parent_id=?, updated_at=? WHERE id=?')
    .run(key || null, vol == null ? null : Number(vol), parentId == null ? null : Number(parentId),
         new Date().toISOString(), id);
  return byId(id);
}

/** ثبت عکسِ تولیدشده. جدا از update() چون بعد از ساخت مطلب اجرا می‌شود. */
function setCover(id, cover, alt, cost) {
  db.prepare('UPDATE blog_posts SET cover=?, cover_alt=?, cover_cost=?, updated_at=? WHERE id=?')
    .run(cover || null, alt || null, cost == null ? null : Number(cost), new Date().toISOString(), id);
  return byId(id);
}
function stats() {
  return db.prepare(`SELECT
      COUNT(*) total,
      SUM(status='draft') drafts,
      SUM(status='published') published,
      MAX(published_at) last_published
    FROM blog_posts`).get();
}
// برای پیوند داخلی بین نوشته‌ها
function related(excludeId, limit = 3) {
  return db.prepare(`SELECT slug, title, excerpt, cover, published_at FROM blog_posts
                     WHERE status='published' AND id IS NOT ?
                     ORDER BY published_at DESC LIMIT ?`).all(excludeId == null ? null : excludeId, limit);
}

module.exports = {
  create, update, setStatus, remove,
  byId, bySlug, publishedBySlug, listPublished, countPublished, listAll,
  existsForDay, existsForSlot, setCover, stats, related, slugify, uniqueSlug,
  recentTrendArticle, trendChain, setTrendMeta,
  _db: db,
};
