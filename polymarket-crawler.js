/**
 * polymarket-crawler.js — Polymarket (ایران) از Gamma API
 *
 * منبع: https://gamma-api.polymarket.com/events?tag_id=78 (تگ "Iran")
 *   - sort=volume  → order=volume   (حجیم‌ترین)
 *   - sort=trending → order=volume24hr (ترندترین؛ نزدیک‌ترین معادل رسمی Gamma
 *     برای sort=trending سایت، چون فیلد trending در API وجود ندارد و ۲۴h volume
 *     بهترین نشانگر فعالیت اخیر است)
 *
 * ترجمه: Google Translate رایگان (client=gtx) مثل news-bot — بدون مصرف credit AI.
 * کش ترجمه: عنوان تغییر نکرده باشد دوباره ترجمه نمی‌شود.
 * Scheduler: هر ۳۰ دقیقه.
 */
const https = require('https');
const polyDB = require('./polymarket-db');

const CONFIG = {
  tag_id: 78,                 // Polymarket tag: Iran
  limit: 100,
  host: 'gamma-api.polymarket.com',
  sorts: {
    // کلید داخلی → (پارامتر order در Gamma، عنوان فارسی بخش)
    trending: { order: 'volume24hr', label: 'ترندترین' },
    volume:   { order: 'volume',     label: 'حجیم‌ترین' },
  },
  intervalMs: 30 * 60 * 1000, // ۳۰ دقیقه
};

// ── GET JSON از Gamma API ─────────────────────────────────
function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('parse error: ' + d.slice(0, 200))); }
      });
    }).on('error', reject).setTimeout(30000, function () { this.destroy(); reject(new Error('timeout')); });
  });
}

// ── ترجمه با Google Translate رایگان ──────────────────────
function translateFA(text) {
  if (!text || text.length < 2) return Promise.resolve(null);
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=fa&dt=t&q=${encodeURIComponent(text.slice(0, 1000))}`;
  return new Promise(resolve => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve((JSON.parse(d)[0] || []).map(x => x[0]).filter(Boolean).join('') || null); }
        catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null)).setTimeout(15000, function () { this.destroy(); resolve(null); });
  });
}

// ─ـ کش ترجمه‌های موجود از دیتابیس (برای جلوگیری از ترجمه مجدد) ──
const Database = require('better-sqlite3');
const path = require('path');
const _cacheDB = new Database(path.join(__dirname, 'data', 'polymarket.db'));
_cacheDB.pragma('journal_mode = WAL');
function loadTranslationCache() {
  const rows = _cacheDB.prepare('SELECT poly_id, title, title_fa, category, category_fa FROM markets').all();
  const map = {};
  for (const r of rows) map[r.poly_id] = r;
  return map;
}

// ── استخراج دسته از tags ──────────────────────────────────
function pickCategory(tags) {
  if (!Array.isArray(tags) || !tags.length) return '';
  // اولین tag غیر Iran (تگ اصلی خودمان) — وگرنه اولی
  const other = tags.find(t => String(t.id) !== String(CONFIG.tag_id));
  return (other || tags[0]).label || '';
}

// ─ـ انتخاب بازار اصلی (ساب‌مارکت) برای نمایش قیمت/تاریخ ───
// منطق: پرحجم‌ترین ساب‌مارکت با قیمت فعال (بین ۱٪ و ۹۹٪)؛ اگر نبود پرحجم‌ترین کل.
// خروجی: { price, price_label, end_date } — price=احتمال Yes، end_date=تاریخ پایان آن مارکت
function pickPrimaryMarket(ev) {
  const markets = Array.isArray(ev.markets) ? ev.markets : [];
  if (!markets.length) return { price: null, price_label: null, end_date: ev.endDate || null };
  const parsed = markets.map(mk => {
    let prices = [];
    let outcomes = [];
    try { prices = JSON.parse(mk.outcomePrices || '[]'); } catch (_) {}
    try { outcomes = JSON.parse(mk.outcomes || '[]'); } catch (_) {}
    const vol = Number(mk.volume) || 0;
    let yesPrice = null;
    if (outcomes.length && prices.length) {
      const yi = outcomes.findIndex(o => /^yes$/i.test(String(o)));
      if (yi >= 0) yesPrice = Number(prices[yi]);
      else yesPrice = Number(prices[0]); // fallback به اولین outcome
    }
    return {
      vol, yesPrice,
      endDate: mk.endDate || ev.endDate || null,
      closed: mk.closed === true || mk.active === false,
    };
  });
  const active = parsed.filter(p => p.yesPrice != null && p.yesPrice > 0.01 && p.yesPrice < 0.99 && !p.closed);
  const pool = active.length ? active : parsed.filter(p => p.yesPrice != null);
  if (!pool.length) return { price: null, price_label: null, end_date: ev.endDate || null };
  pool.sort((a, b) => b.vol - a.vol);
  const top = pool[0];
  return {
    price: top.yesPrice,
    price_label: top.yesPrice != null ? (top.yesPrice >= 0.5 ? 'Yes' : 'Yes') : null,
    end_date: top.endDate || ev.endDate || null,
  };
}

// ── یک sort را فچ، ترجمه و ذخیره ───────────────────────────
async function crawlSort(sortKey) {
  const sort = CONFIG.sorts[sortKey];
  if (!sort) return { error: 'unknown sort' };

  const url = `https://${CONFIG.host}/events?tag_id=${CONFIG.tag_id}&closed=false&active=true` +
              `&limit=${CONFIG.limit}&order=${sort.order}&ascending=false`;
  console.log(`[polymarket/${sortKey}] fetching...`);
  let events;
  try { events = await getJSON(url); }
  catch (e) { console.error(`[polymarket/${sortKey}] fetch error:`, e.message); return { error: e.message }; }
  if (!Array.isArray(events)) { console.error(`[polymarket/${sortKey}] bad response`); return { error: 'bad response' }; }

  const cache = loadTranslationCache();
  const nowISO = new Date().toISOString();
  const ranks = [];

  let i = 0;
  for (const ev of events) {
    const poly_id = String(ev.id);
    if (!poly_id) continue;
    i++;
    const slug = ev.slug || '';
    const title = ev.title || '';
    const image = ev.image || ev.icon || '';
    const icon = ev.icon || ev.image || '';
    const url_pm = slug ? `https://polymarket.com/event/${slug}` : '';
    const category = pickCategory(ev.tags);
    const volume = Number(ev.volume) || 0;
    const volume24hr = Number(ev.volume24hr) || 0;
    const liquidity = Number(ev.liquidity) || 0;
    const comment_count = Number(ev.commentCount) || 0;
    const tags_json = ev.tags ? JSON.stringify(ev.tags.map(t => ({ label: t.label, slug: t.slug }))) : null;
    const pm = pickPrimaryMarket(ev);

    // ترجمه فقط اگر عنوان تغییر کرده یا هنوز ترجمه ندارد
    const c = cache[poly_id];
    let title_fa = (c && c.title === title) ? c.title_fa : null;
    let category_fa = (c && c.category === category) ? c.category_fa : null;

    if (!title_fa && title) title_fa = await translateFA(title);
    if (!category_fa && category) category_fa = await translateFA(category);

    polyDB.upsertMarket({
      poly_id, slug, title, title_fa, description_fa: null,
      image, icon, url: url_pm, tags_json, category, category_fa,
      volume, volume24hr, liquidity, comment_count,
      price: pm.price, price_label: pm.price_label, end_date: pm.end_date,
      updated_at: nowISO,
    });

    ranks.push({ poly_id, rank: i, volume, volume24hr, comment_count });
  }

  polyDB.replaceRanks(sortKey, ranks, nowISO);
  console.log(`[polymarket/${sortKey}] saved ${ranks.length} markets`);
  return { count: ranks.length };
}

async function crawlPolymarket() {
  console.log('\n═══ Polymarket crawl ═══');
  const t = [];
  for (const key of Object.keys(CONFIG.sorts)) t.push(await crawlSort(key));
  console.log('═══ Polymarket done ═══\n');
  return t;
}

function startPolymarketScheduler() {
  setTimeout(crawlPolymarket, 10000);
  setInterval(crawlPolymarket, CONFIG.intervalMs);
  console.log(`[polymarket] scheduler started — runs every ${CONFIG.intervalMs / 60000} min`);
}

module.exports = { crawlPolymarket, startPolymarketScheduler, CONFIG };
