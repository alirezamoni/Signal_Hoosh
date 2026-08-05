/**
 * car-crawler.js — بازار خودرو ایران از دیوار، هر ۱۲ ساعت
 *
 * از لینک آگهی (`a[href*="/v/"]`) به‌عنوان لنگر استفاده می‌کند نه کلاس‌های CSS،
 * چون نام کلاس‌های دیوار build به build عوض می‌شود ولی ساختار لینک ثابت است.
 * متن هر کارت به این شکل است: عنوان / «... کیلومتر» / «... تومان» / شهر.
 */
const puppeteer = require('puppeteer');
const carDB = require('./car-db');
const { withCrawlLock } = require('./lib/crawl-lock');
const { makeProfileDir, cleanupProfileDir } = require('./lib/browser-lifecycle');

const CONFIG = {
  chromePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  timeout: 45000,
  maxCrawlMs: 8 * 60 * 1000,
  intervalMs: 12 * 60 * 60 * 1000,   // هر ۱۲ ساعت
  targetListings: 50,                 // ~۲ صفحه
  scrollRounds: 6,
};

const MODELS = [
  { slug: 'pride',         name_fa: 'پراید',    tier: 'low',  url: 'https://divar.ir/s/iran/car/pride' },
  { slug: 'samand',        name_fa: 'سمند',     tier: 'low',  url: 'https://divar.ir/s/iran/car/samand' },
  { slug: 'peugeot',       name_fa: 'پژو',      tier: 'mid',  url: 'https://divar.ir/s/iran/car/peugeot' },
  { slug: 'mvm',           name_fa: 'ام‌وی‌ام',  tier: 'mid',  url: 'https://divar.ir/s/iran/car/mvm' },
  { slug: 'mercedes-benz', name_fa: 'مرسدس بنز', tier: 'high', url: 'https://divar.ir/s/iran/car/mercedes-benz' },
  { slug: 'bmw',           name_fa: 'ب‌ام‌و',    tier: 'high', url: 'https://divar.ir/s/iran/car/bmw' },
];

// محدوده‌های منطقی برای دور ریختن آگهی‌های خراب/تبلیغاتی (تومان و کیلومتر)
const PRICE_MIN = 10_000_000;
const PRICE_MAX = 100_000_000_000;
const MILEAGE_MAX = 2_000_000;

let browser = null;
let browserTimer = null;
let browserProfileDir = null;

async function safeKillBrowser() {
  if (browserTimer) { clearTimeout(browserTimer); browserTimer = null; }
  try {
    if (browser) {
      const proc = browser.process();
      if (proc) proc.kill('SIGKILL');
      browser.close().catch(() => {});
    }
  } catch (e) { /* ignore */ }
  browser = null;
  // Puppeteer's own temp-dir cleanup does not reliably fire under SIGKILL (this is
  // what filled the disk to 100% on 2026-08-05). We own the dir, so we delete it.
  cleanupProfileDir(browserProfileDir);
  browserProfileDir = null;
}

async function getBrowser() {
  try { if (browser && browser.isConnected()) return browser; } catch (e) {}
  await safeKillBrowser();
  browserProfileDir = makeProfileDir('cars');
  browser = await puppeteer.launch({
    executablePath: CONFIG.chromePath,
    headless: 'new',
    userDataDir: browserProfileDir,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  browserTimer = setTimeout(() => safeKillBrowser(), CONFIG.maxCrawlMs + 60000);
  return browser;
}

function faToEn(str) {
  return String(str || '')
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

function parseNum(text) {
  const t = faToEn(text).replace(/[,،٬\s]/g, '');
  const m = t.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

// حذف پرت‌ها با روش IQR. بدون این، یک آگهی ۱۵ میلیونی «سمند» (که در واقع قطعه یا
// بیعانه است) یا یک بنز کلکسیونی ۳۷ میلیاردی، میانگین را بی‌معنا می‌کند. میانه
// خودش مقاوم است ولی کاربر میانگین را هم می‌بیند، پس باید قابل اتکا باشد.
function trimOutliers(arr) {
  if (arr.length < 8) return arr;              // نمونه کم: تمیزکاری بی‌معنی است
  const s = [...arr].sort((a, b) => a - b);
  const q = p => {
    const idx = (s.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
  };
  const q1 = q(0.25), q3 = q(0.75), iqr = q3 - q1;
  if (!(iqr > 0)) return arr;
  const lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr;
  const kept = arr.filter(v => v >= lo && v <= hi);
  return kept.length >= Math.max(4, Math.floor(arr.length * 0.5)) ? kept : arr;
}

async function scrapeModel(page, model) {
  await page.goto(model.url, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });
  await new Promise(r => setTimeout(r, 5000));

  // دیوار آگهی‌ها را lazy load می‌کند؛ اسکرول تا رسیدن به تعداد هدف
  let listings = [];
  for (let i = 0; i < CONFIG.scrollRounds; i++) {
    listings = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      for (const a of document.querySelectorAll('a[href*="/v/"]')) {
        const href = (a.getAttribute('href') || '').split('?')[0];
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const lines = (a.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
        if (!lines.length) continue;
        const img = a.querySelector('img');
        out.push({
          title: lines[0],
          priceLine: lines.find(l => l.includes('تومان')) || '',
          mileageLine: lines.find(l => l.includes('کیلومتر')) || '',
          img: img ? (img.getAttribute('src') || img.getAttribute('data-src') || '') : null,
        });
      }
      return out;
    });
    if (listings.length >= CONFIG.targetListings) break;
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await new Promise(r => setTimeout(r, 1800));
  }

  const prices = [], mileages = [], perKm = [];
  let image = null;
  let kept = 0;

  for (const l of listings.slice(0, CONFIG.targetListings)) {
    // آگهی‌های «توافقی» قیمت ندارند و باید کنار گذاشته شوند وگرنه میانگین خراب می‌شود
    if (!l.priceLine || /توافقی/.test(l.priceLine)) continue;
    const price = parseNum(l.priceLine);
    if (!price || price < PRICE_MIN || price > PRICE_MAX) continue;

    const mileage = l.mileageLine ? parseNum(l.mileageLine) : null;
    if (mileage != null && mileage > MILEAGE_MAX) continue;

    prices.push(price);
    // کارکرد زیر ۱۰۰۰ کیلومتر یا صفرکیلومتر است یا فروشنده فیلد را پر نکرده؛
    // در هر دو حالت وارد کردنش میانگین کارکرد را به‌شدت پایین می‌کشد.
    if (mileage != null && mileage >= 1000) mileages.push(mileage);
    if (mileage != null && mileage >= 1000) perKm.push(price / mileage);
    if (!image && l.img) image = l.img;
    kept++;
  }

  if (!prices.length) return null;

  const cleanPrices = trimOutliers(prices);
  const cleanMileages = trimOutliers(mileages);

  return {
    image_url: image,
    listing_count: kept,
    avg_price: mean(cleanPrices),
    median_price: median(cleanPrices),
    min_price: cleanPrices.length ? Math.min(...cleanPrices) : null,
    max_price: cleanPrices.length ? Math.max(...cleanPrices) : null,
    avg_mileage: mean(cleanMileages),
    median_mileage: median(cleanMileages),
    // تومان به ازای هر کیلومتر — میانه گرفته می‌شود تا آگهی‌های پرت اثر نگذارند
    price_per_km: median(trimOutliers(perKm)),
  };
}

async function crawlCars() {
  return withCrawlLock('cars', _crawlCars, CONFIG.maxCrawlMs);
}

async function _crawlCars() {
  console.log(`\n═══ Car crawl ${new Date().toISOString().slice(0, 10)} ═══`);
  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fa-IR,fa;q=0.9' });
    await page.setViewport({ width: 1440, height: 900 });

    const capturedAt = new Date().toISOString();
    let ok = 0;
    for (const model of MODELS) {
      try {
        const s = await scrapeModel(page, model);
        if (!s) { console.warn(`[car] ${model.name_fa}: no usable listings`); continue; }
        const id = carDB.upsertModel({ ...model, image_url: s.image_url });
        carDB.saveSnapshot(id, s, capturedAt);
        ok++;
        console.log(`[car] ${model.name_fa}: ${s.listing_count} listings, median ${Math.round(s.median_price).toLocaleString()} تومان, ${s.price_per_km ? Math.round(s.price_per_km).toLocaleString() + ' تومان/کیلومتر' : 'price/km n/a'}`);
      } catch (e) {
        console.warn(`[car] ${model.name_fa} error:`, e.message);
      }
      await new Promise(r => setTimeout(r, 2500)); // مکث بین برندها، فشار کمتر روی دیوار
    }
    carDB.cleanup();
    console.log(`═══ Car crawl done — ${ok}/${MODELS.length} models ═══\n`);
    return { ok, total: MODELS.length };
  } catch (e) {
    console.error('[car crawl] error:', e.message);
    return { error: e.message };
  } finally {
    try { if (page) await page.close(); } catch (e) {}
    await safeKillBrowser();
  }
}

function startCarScheduler() {
  // بعد از بقیه کرالرهای startup اجرا شود تا صف قفل شلوغ نشود
  setTimeout(() => crawlCars().catch(() => {}), 60000);
  setInterval(() => crawlCars().catch(() => {}), CONFIG.intervalMs);
  console.log('[car] scheduler started — runs every 12h');
}

module.exports = { crawlCars, startCarScheduler, MODELS };
