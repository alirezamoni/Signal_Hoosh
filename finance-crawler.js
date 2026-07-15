const puppeteer = require('puppeteer');
const financeDB = require('./finance-db');

const CONFIG = {
  chromePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  url: 'https://www.tgju.org/',
  timeout: 30000,
  intervalMs: 60 * 1000,
};

let browser = null;
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await puppeteer.launch({
    executablePath: CONFIG.chromePath,
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });
  return browser;
}

// تبدیل اعداد فارسی به انگلیسی
function faToEn(str) {
  if (!str) return '';
  return str.toString()
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[,،\s]/g, '')
    .trim();
}

// parse تغییر: "(2.22%) 40,100,000" → { pct: 2.22, change: 40100000, positive: true }
function parseChange(spanText, spanClass) {
  if (!spanText) return { change: null, change_pct: null, positive: null };
  const txt = faToEn(spanText);
  // "(2.22%) 40,100,000" or "(0.63%) 30,849" or "0 (0%)"
  const m = txt.match(/\(?(-?[\d.]+)%?\)?\s*(-?[\d,.]+)?/);
  let pct = null, change = null;
  if (m) {
    if (m[1]) pct = parseFloat(m[1]);
    if (m[2]) change = parseFloat(m[2].replace(/,/g, ''));
  }
  const positive = spanClass?.includes('high');
  return { change, change_pct: pct, positive };
}

// نگاشت data-market-row به symbol داخلی
const SYMBOL_MAP = {
  'price_dollar_rl':   { symbol: 'usd',         name: 'دلار آزاد',     unit: 'ریال' },
  'geram18':            { symbol: 'gold18',      name: 'طلای ۱۸ عیار',  unit: 'ریال' },
  'mesghal':            { symbol: 'mesghal',     name: 'مثقال طلا',     unit: 'ریال' },
  'sekee':              { symbol: 'coin',        name: 'سکه امامی',     unit: 'ریال' },
  'ons':                { symbol: 'ounce',       name: 'انس جهانی طلا', unit: 'دلار' },
  'crypto-bitcoin':     { symbol: 'bitcoin',    name: 'بیت کوین',      unit: 'ریال' },
  'crypto-tether-irr':  { symbol: 'tether',      name: 'تتر',           unit: 'ریال' },
  'oil_brent':          { symbol: 'oil_brent',   name: 'نفت برنت',      unit: 'دلار' },
  'gc30':               { symbol: 'stock_market', name: 'بورس تهران',  unit: 'نقطه' },
  'coin_blubber':       { symbol: 'coin_bubble', name: 'حباب سکه',     unit: 'ریال' },
};

async function scrapeTgju() {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.8' });
    await page.goto(CONFIG.url, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });

    // صبر کن جدول بازار لود بشه
    await page.waitForSelector('tr[data-market-row]', { timeout: 15000 }).catch(() => {});

    const data = await page.evaluate(() => {
      const rows = document.querySelectorAll('tr[data-market-row]');
      const results = [];
      rows.forEach(row => {
        const marketRow = row.getAttribute('data-market-row');
        const tds = row.querySelectorAll('td');
        const th = row.querySelector('th');
        if (!marketRow || tds.length < 3) return;

        const name = th?.textContent?.trim() || '';
        const priceText = tds[0]?.textContent?.trim() || '';
        // td.nf دوم — span با تغییر
        const changeSpan = tds[1]?.querySelector('span');
        const changeText = changeSpan?.textContent?.trim() || '';
        const changeClass = changeSpan?.className || '';
        // low / high
        const lowText = tds[2]?.textContent?.trim() || '';
        const highText = tds[3]?.textContent?.trim() || '';
        const timeText = tds[4]?.textContent?.trim() || '';

        results.push({
          marketRow, name, priceText, changeText, changeClass,
          lowText, highText, timeText,
        });
      });
      return results;
    });

    const now = new Date().toISOString();
    const snapshots = [];

    for (const row of data) {
      const mapping = SYMBOL_MAP[row.marketRow];
      if (!mapping) continue;

      const price = parseFloat(faToEn(row.priceText));
      if (!price || isNaN(price)) continue;

      const { change, change_pct } = parseChange(row.changeText, row.changeClass);
      const low = parseFloat(faToEn(row.lowText)) || null;
      const high = parseFloat(faToEn(row.highText)) || null;

      snapshots.push({
        symbol: mapping.symbol,
        name: mapping.name,
        price,
        unit: mapping.unit,
        change,
        change_pct,
        low,
        high,
        bubble: null,
        timestamp: now,
      });
    }

    // حباب سکه: اگه coin_blubber پیدا شد، مقدارش رو به سکه اضافه کن
    const bubbleRow = data.find(r => r.marketRow === 'coin_blubber');
    if (bubbleRow) {
      const bubblePrice = parseFloat(faToEn(bubbleRow.priceText));
      const coinSnap = snapshots.find(s => s.symbol === 'coin');
      if (coinSnap && !isNaN(bubblePrice)) {
        coinSnap.bubble = bubblePrice;
      }
    } else {
      // محاسبه حباب: سکه - (طلای ۱۸ × ۸.13)
      const coinSnap = snapshots.find(s => s.symbol === 'coin');
      const goldSnap = snapshots.find(s => s.symbol === 'gold18');
      if (coinSnap && goldSnap) {
        coinSnap.bubble = coinSnap.price - (goldSnap.price * 8.13);
      }
    }

    return snapshots;
  } finally {
    await page.close();
  }
}

async function crawl() {
  try {
    console.log('[finance] scraping tgju.org...');
    const snapshots = await scrapeTgju();
    if (snapshots.length) {
      financeDB.saveSnapshots(snapshots);
      console.log(`[finance] saved ${snapshots.length} snapshots`);
    } else {
      console.warn('[finance] no data scraped');
    }
  } catch(e) {
    console.error('[finance] crawl error:', e.message);
  }
}

function startScheduler() {
  console.log('[finance] scheduler started — runs every 1 minute');
  // اولین اجرا بعد از ۱۰ ثانیه
  setTimeout(crawl, 10000);
  // بعد هر ۱ دقیقه
  setInterval(crawl, CONFIG.intervalMs);
  // cleanup هر ۲۴ ساعت
  setInterval(() => financeDB.cleanup(), 24 * 60 * 60 * 1000);
}

module.exports = { startScheduler, crawl };
