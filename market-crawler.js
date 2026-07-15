/**
 * market-crawler.js — دیجی‌کالا best-selling
 * selector: styles_ProductList__item
 */
const puppeteer = require('puppeteer');
const marketDB  = require('./market-db');

const CONFIG = {
  chromePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  timeout: 90_000,
  urls: { week: 'https://www.digikala.com/best-selling/?last_days=week' }
};

let browser = null;
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await puppeteer.launch({
    executablePath: CONFIG.chromePath,
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });
  return browser;
}

async function scrapeDigikala(url, label) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fa-IR,fa;q=0.9' });
    await page.setViewport({ width: 1440, height: 900 });

    console.log(`[market/${label}] fetching...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });
    await new Promise(r => setTimeout(r, 10000));

    // scroll آروم برای lazy load همه عکس‌ها
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let pos = 0;
        const total = document.body.scrollHeight;
        const t = setInterval(() => {
          window.scrollBy(0, 300);
          pos += 300;
          if (pos >= total) {
            clearInterval(t);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 100);
      });
    });
    // صبر برای لود شدن عکس‌ها بعد از scroll
    await new Promise(r => setTimeout(r, 8000));

    const products = await page.evaluate(() => {
      const results = [];
      const seenIds   = new Set();
      const seenRanks = new Set();
      const items = Array.from(document.querySelectorAll('[class*="styles_ProductList__item"]'));

      items.forEach(item => {
        try {
          const link = item.querySelector('a[href*="/product/dkp-"]');
          if (!link) return;

          const href = link.href || '';
          const digi_id = (href.match(/dkp-(\d+)/) || [])[1] || '';
          if (!digi_id || seenIds.has(digi_id)) return;

          const lines = (link.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);

          // رتبه — اول data-product-index (دیجی‌کالا از 1 شروع میکنه)، بعد متن
          const idxAttr = item.getAttribute('data-product-index');
          let rank = idxAttr !== null ? parseInt(idxAttr) : null;
          // اگه 0 بود یعنی اولین آیتم، fallback به متن
          if (rank === 0) rank = null;
          if (!rank) rank = parseInt((lines[0]||'').replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
          if (!rank || rank < 1 || rank > 100) return;
          if (seenRanks.has(rank)) return;

          // نام
          const skipWords = ['ارسال','موجود','انبار','فروشنده','تنها','مبلغ'];
          const name = lines.find((l, i) => {
            if (i === 0) return false;
            if (/^[\d۰-۹٪%,.،]+$/.test(l)) return false;
            if (skipWords.some(w => l.includes(w))) return false;
            return l.length > 3;
          }) || '';
          if (!name) return;

          // عکس
          const img = item.querySelector('img[src*="dkstatics-public"]')
                   || item.querySelector('img[data-src*="dkstatics-public"]');
          const image_url = (img?.src?.includes('dkstatics') ? img.src : img?.getAttribute('data-src') || img?.src || '').split('?')[0];

          // قیمت
          const priceLines = lines.filter(l => {
            const n = l.replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[,٬\s]/g,'');
            return /^\d{4,}$/.test(n);
          });
          const priceRaw = (priceLines[priceLines.length-1]||'').replace(/[^۰-۹\d]/g,'').replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
          const price = priceRaw.length > 3 ? parseInt(priceRaw) * 10 : null;

          seenIds.add(digi_id);
          seenRanks.add(rank);
          results.push({ rank, digi_id, name, brand:'', category:'', url: href, image_url, price });
        } catch(e) {}
      });

      results.sort((a,b) => a.rank - b.rank);
      return results;
    });

    console.log(`[market/${label}] scraped ${products.length} products`);
    if (products.length > 0) {
      products.slice(0,3).forEach(p => console.log(`  #${p.rank}: ${p.name.slice(0,40)}`));
    }
    return products;
  } finally {
    await page.close();
  }
}

async function crawlMarket() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n═══ Market crawl ${today} ═══`);
  try {
    const weekData = await scrapeDigikala(CONFIG.urls.week, 'week');
    if (weekData.length) marketDB.saveBatch(weekData, 'week', today);
    else console.log('[market] WARNING: 0 products');
    marketDB.cleanup();
    console.log(`═══ Market done — ${weekData.length} products ═══\n`);
    return { week: weekData.length };
  } catch(e) {
    console.error('[market crawl] error:', e.message);
    return { error: e.message };
  }
}

function startMarketScheduler() {
  setTimeout(crawlMarket, 10000);
  setInterval(crawlMarket, 24 * 60 * 60 * 1000);
  console.log('[market] scheduler started — runs every 24h');
}

module.exports = { crawlMarket, startMarketScheduler };
