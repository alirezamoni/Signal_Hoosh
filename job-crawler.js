/**
 * job-crawler.js — جابینجا + جاب‌ویژن scraper
 * روزی یه بار
 */
const puppeteer = require('puppeteer');
const jobDB = require('./job-db');
const { withCrawlLock } = require('./lib/crawl-lock');
const { makeProfileDir, cleanupProfileDir } = require('./lib/browser-lifecycle');

const CONFIG = {
  chromePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  timeout: 60_000,
  waitMs: 10000,
};

const CATEGORIES = [
  { key: 'human-resources',   url: 'https://jobvision.ir/jobs/category/human-resources' },
  { key: 'accounting',        url: 'https://jobvision.ir/jobs/category/accounting' },
  { key: 'developer',         url: 'https://jobvision.ir/jobs/category/developer' },
  { key: 'data-science',      url: 'https://jobvision.ir/jobs/category/data-science' },
  { key: 'digital-marketing', url: 'https://jobvision.ir/jobs/category/digital-marketing' },
  { key: 'driver',            url: 'https://jobvision.ir/jobs/category/driver' },
  { key: 'civil',             url: 'https://jobvision.ir/jobs/category/civil' },
];

let browser = null;
let browserProfileDir = null;
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  // if the previous browser died on its own (crash/disconnect), its temp profile
  // dir was never cleaned up — same leak class that filled the disk on 2026-08-05
  cleanupProfileDir(browserProfileDir);
  browserProfileDir = makeProfileDir('jobs');
  browser = await puppeteer.launch({
    executablePath: CONFIG.chromePath,
    headless: 'new',
    userDataDir: browserProfileDir,
    protocolTimeout: 120_000,   // پیش‌فرض زیر فشار این سرور کوتاه است
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });
  return browser;
}

// این کرالر فقط روزی یک‌بار اجرا می‌شود؛ نگه‌داشتن کروم زنده بین دو اجرا (۲۴ ساعت
// فاصله) فقط رم را برای هیچ به هدر می‌دهد — و روی این سرور که به‌خاطر ری‌استارت‌های
// مکرر PM2 هر بار بلافاصله بعد از boot این کرال اول اجرا می‌شود، چند کروم دائمی
// (این + market-crawler) کنار هم دقیقاً همان چیزی بود که حافظه را به سقف رساند.
async function closeBrowser() {
  try {
    if (browser) { const p = browser.process(); if (p) p.kill('SIGKILL'); await browser.close().catch(() => {}); }
  } catch (e) { /* ignore */ }
  browser = null;
  cleanupProfileDir(browserProfileDir);
  browserProfileDir = null;
}

function parseCount(text) {
  // اعداد فارسی و عربی به انگلیسی
  const normalized = text
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[,،٬]/g, '');
  const m = normalized.match(/(\d+)/);
  return m ? parseInt(m[1]) : null;
}

async function scrapeCount(page, url, regex) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });
  await new Promise(r => setTimeout(r, CONFIG.waitMs));
  const text = await page.evaluate(() => document.body.innerText);
  const m = text.match(regex);
  if (!m) {
    console.warn(`[job] no match for ${url} — regex: ${regex}`);
    return null;
  }
  return parseCount(m[0]);
}

async function crawlJobs() {
  return withCrawlLock('job', _crawlJobs, 10 * 60 * 1000);
}

async function _crawlJobs() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n═══ Job crawl ${today} ═══`);
  const b = await getBrowser();
  const page = await b.newPage();
  const items = [];

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fa-IR,fa;q=0.9' });
    await page.setViewport({ width: 1440, height: 900 });

    // جابینجا — کل
    const jobinjaCount = await scrapeCount(page, 'https://jobinja.ir/jobs', /[\d,،٬۰-۹]+\s*فرصت\s*‌?شغلی/);
    console.log(`[job] jobinja total: ${jobinjaCount}`);
    if (jobinjaCount) items.push({ source: 'jobinja', category: 'total', count: jobinjaCount });

    // جاب‌ویژن — کل
    const jobvisionCount = await scrapeCount(page, 'https://jobvision.ir/jobs', /[٠-٩۰-۹\d,،٬]+\s*آگهی\s*استخدام/);
    console.log(`[job] jobvision total: ${jobvisionCount}`);
    if (jobvisionCount) items.push({ source: 'jobvision', category: 'total', count: jobvisionCount });

    // دسته‌بندی‌های جاب‌ویژن
    for (const cat of CATEGORIES) {
      const count = await scrapeCount(page, cat.url, /[٠-٩۰-۹\d,،٬]+\s*آگهی\s*استخدام/);
      console.log(`[job] jobvision/${cat.key}: ${count}`);
      if (count) items.push({ source: 'jobvision', category: cat.key, count });
      await new Promise(r => setTimeout(r, 2000));
    }

    if (items.length) {
      jobDB.saveBatch(items, today);
      console.log(`[job] saved ${items.length} snapshots`);
    }
    jobDB.cleanup();
  } catch(e) {
    console.error('[job crawl] error:', e.message);
  } finally {
    await page.close();
    await closeBrowser();
  }

  console.log(`═══ Job crawl done ═══\n`);
  return { count: items.length };
}

/**
 * اجرای اول با تأخیر شش دقیقه تا از هجوم کرالرهای لحظه‌ی بوت فاصله بگیرد،
 * و تا سه بار تلاش با فاصله‌ی ده دقیقه. بدون تلاش مجدد، یک شکست گذرا
 * یعنی یک روز کامل بدون داده.
 */
async function crawlWithRetry(attempt = 1) {
  const MAX = 3;
  try {
    const n = await crawlJobs();
    if (n || attempt >= MAX) return n;
    console.warn('[job] هیچ آماری برنگشت — تلاش ' + attempt + ' از ' + MAX);
  } catch (e) {
    console.warn('[job] تلاش ' + attempt + ' از ' + MAX + ' شکست خورد: ' + e.message);
    if (attempt >= MAX) return null;
  }
  await new Promise(r => setTimeout(r, 10 * 60 * 1000));
  return crawlWithRetry(attempt + 1);
}

function startJobScheduler() {
  setTimeout(() => crawlWithRetry().catch(e => console.error('[job]', e.message)), 6 * 60 * 1000);
  setInterval(() => crawlWithRetry().catch(e => console.error('[job]', e.message)), 24 * 60 * 60 * 1000);
  console.log('[job] scheduler started — runs every 24h (اجرای اول با ۶ دقیقه تأخیر)');
}

module.exports = { crawlJobs, startJobScheduler, crawlWithRetry };
