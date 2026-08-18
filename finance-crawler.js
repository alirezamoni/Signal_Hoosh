const puppeteer = require('puppeteer');
const financeDB = require('./finance-db');
const { withCrawlLock } = require('./lib/crawl-lock');
const { makeProfileDir, cleanupProfileDir, isBrowserAlive } = require('./lib/browser-lifecycle');

const CONFIG = {
  chromePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  url: 'https://www.tgju.org/',
  timeout: 30000,
  maxCrawlMs: 45000,
  // هر ۳ دقیقه به‌جای هر ۱ دقیقه: قیمت ارز/طلا در این بازه تفاوت معناداری ندارد،
  // ولی تعداد اجرای کروم روی این VPS دو‌هسته‌ای یک‌سوم می‌شود.
  intervalMs: 3 * 60 * 1000,
};

let browser = null;
let browserTimer = null;
let browserProfileDir = null;
let consecutiveFailures = 0;  // backoff counter
let lastFailureAt = 0;

// Force-kill browser process regardless of state. This is the ONLY reliable
// way to prevent zombie Chrome processes when Puppeteer gets into a bad state.
async function safeKillBrowser() {
  if (browserTimer) { clearTimeout(browserTimer); browserTimer = null; }
  try {
    if (browser) {
      const proc = browser.process();
      if (proc) proc.kill('SIGKILL');
      browser.close().catch(() => {}); // fire-and-forget — never await a dead browser
    }
  } catch (e) { /* ignore */ }
  browser = null;
  // Puppeteer's own temp-dir cleanup does not reliably fire under SIGKILL (this is
  // what filled the disk to 100% on 2026-08-05). We own the dir, so we delete it.
  cleanupProfileDir(browserProfileDir);
  browserProfileDir = null;
}

async function getBrowser() {
  // If the old browser is alive, reuse it
  if (isBrowserAlive(browser)) return browser;
  // Kill the old one first (it's dead or dying)
  await safeKillBrowser();
  browserProfileDir = makeProfileDir('finance');
  const b = await puppeteer.launch({
    executablePath: CONFIG.chromePath,
    headless: 'new',
    userDataDir: browserProfileDir,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });
  browser = b;
  // Safety: if the browser doesn't respond for 90s, nuke it
  browserTimer = setTimeout(() => safeKillBrowser(), 90000);
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
  // اعلام علامت: class="low" یعنی منفی
  if (positive === false) {
    if (change != null) change = -Math.abs(change);
    if (pct != null) pct = -Math.abs(pct);
  }
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
    // domcontentloaded (نه networkidle2): tgju پر از اسکریپت/تبلیغ است و شبکه‌اش
    // به‌ندرت «آرام» می‌شود؛ سیگنال واقعی آماده‌بودن، همان selector جدول پایین است.
    await page.goto(CONFIG.url, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });

    // صبر کن جدول بازار لود بشه
    await page.waitForSelector('tr[data-market-row]', { timeout: 15000 }).catch(() => {});
    // صبر اضافه برای لود کامل جدول‌های داخلی
    await new Promise(r => setTimeout(r, 3000));

    const data = await page.evaluate(() => {
      const rows = document.querySelectorAll('tr[data-market-row]');
      const results = [];
      rows.forEach(row => {
        const marketRow = row.getAttribute('data-market-row');
        const th = row.querySelector('th');
        if (!marketRow) return;

        const name = th?.textContent?.trim() || '';
        const tds = Array.from(row.querySelectorAll('td'));
        // قیمت از data-price attribute یا اولین td.nf
        let priceText = row.getAttribute('data-price') || '';
        if (!priceText) {
          const firstNf = tds.find(td => td.classList.contains('nf'));
          priceText = firstNf?.textContent?.trim() || '';
        }
        // پیدا کن تغییر — هر td که شامل % باشه
        let changeText = '', changeClass = '';
        for (const td of tds) {
          if (td.classList.contains('chart-td')) continue;
          const txt = td.textContent?.trim() || '';
          if (txt.includes('%') || (txt.includes('(') && txt.includes(')') && /\d/.test(txt))) {
            changeText = txt;
            const span = td.querySelector('span');
            if (span) changeClass = span.className || '';
            else if (td.classList.contains('high')) changeClass = 'high';
            else if (td.classList.contains('low')) changeClass = 'low';
            break;
          }
        }
        // low/high — آخرین tdهای غیر-nf و غیر-chart
        const dataTds = tds.filter(td => !td.classList.contains('chart-td') && !td.classList.contains('tg-1') && !td.classList.contains('nf'));
        const lowText = dataTds[0]?.textContent?.trim() || '';
        const highText = dataTds[1]?.textContent?.trim() || '';
        const timeText = dataTds[2]?.textContent?.trim() || '';

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

    // دیباگ حذف شد — deduplicate: فقط یک snapshot per symbol
    const seen = new Map();
    for (const snap of snapshots) {
      const existing = seen.get(snap.symbol);
      if (!existing) { seen.set(snap.symbol, snap); continue; }
      // merge: مقادیر non-null رو نگه دار
      for (const k of ['price','change','change_pct','low','high','bubble']) {
        if (existing[k] == null && snap[k] != null) existing[k] = snap[k];
      }
    }
    const deduped = [...seen.values()];

    // حباب سکه: اگه coin_blubber پیدا شد، مقدارش رو به سکه اضافه کن
    const bubbleRow = data.find(r => r.marketRow === 'coin_blubber');
    if (bubbleRow) {
      const bubblePrice = parseFloat(faToEn(bubbleRow.priceText));
      const coinSnap = deduped.find(s => s.symbol === 'coin');
      if (coinSnap && !isNaN(bubblePrice)) {
        coinSnap.bubble = bubblePrice;
      }
    } else {
      // محاسبه حباب: سکه - (طلای ۱۸ × ۸.13)
      const coinSnap = deduped.find(s => s.symbol === 'coin');
      const goldSnap = deduped.find(s => s.symbol === 'gold18');
      if (coinSnap && goldSnap) {
        coinSnap.bubble = coinSnap.price - (goldSnap.price * 8.13);
      }
    }

    return deduped;
  } finally {
    await page.close();
  }
}

async function crawl() {
  // Back off after repeated failures, but always recover: wait 2^n ticks (capped),
  // then try again. The previous version skipped every tick forever once it hit 4
  // failures, so one bad spell disabled finance data until the next restart.
  if (consecutiveFailures > 3) {
    const cooldownMs = Math.min(2 ** (consecutiveFailures - 3), 16) * CONFIG.intervalMs;
    if (Date.now() - lastFailureAt < cooldownMs) return;
    console.log(`[finance] retrying after ${consecutiveFailures} failures (cooldown ${Math.round(cooldownMs / 60000)}min)`);
  }
  try {
    console.log('[finance] scraping tgju.org...');
    const snapshots = await withCrawlLock('finance', () => Promise.race([
      scrapeTgju(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CONFIG.maxCrawlMs)),
    ]));
    consecutiveFailures = 0; // reset on success
    if (snapshots.length) {
      financeDB.saveSnapshots(snapshots);
      console.log(`[finance] saved ${snapshots.length} snapshots`);
    } else {
      console.warn('[finance] no data scraped');
    }
  } catch(e) {
    consecutiveFailures++;
    lastFailureAt = Date.now();
    console.error(`[finance] crawl error (${consecutiveFailures}):`, e.message);
    // kill the browser on any error to prevent zombie buildup
    safeKillBrowser();
  }
}

function startScheduler() {
  console.log(`[finance] scheduler started — runs every ${CONFIG.intervalMs / 60000} minutes`);
  // اولین اجرا بعد از ۱۰ ثانیه
  setTimeout(crawl, 10000);
  setInterval(crawl, CONFIG.intervalMs);
  // cleanup هر ۲۴ ساعت
  setInterval(() => financeDB.cleanup(), 24 * 60 * 60 * 1000);
}

module.exports = { startScheduler, crawl };
