/**
 * crawler.js — Google Trends Iran
 * با AI دسته‌بندی از OpenRouter
 */
const puppeteer = require('puppeteer');
const https = require('https');
const fs   = require('fs');
const path = require('path');
const settingsDB = require('./settings-db');

const CONFIG = {
  chromePath:  process.env.CHROME_PATH    || '/usr/bin/google-chrome',
  openrouterKey: process.env.OPENROUTER_KEY || '',
  dataDir:     path.join(__dirname, 'data'),
  urls: {
    h4:  'https://trends.google.com/trending?geo=IR&hours=4&hl=fa',
    h24: 'https://trends.google.com/trending?geo=IR&hours=24&hl=fa',
  },
  intervalMs: 5 * 60 * 1000,
  timeout:    45_000,
};

if (!fs.existsSync(CONFIG.dataDir)) fs.mkdirSync(CONFIG.dataDir, { recursive: true });

function faToEn(s) {
  return String(s||'').replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
}

function parseVolFA(text) {
  if (!text) return 0;
  const t = faToEn(text).replace(/٬|,/g, '').trim();
  const m = t.match(/([\d.]+)\s*(هزار|میلیون|k|m)?/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const u = (m[2]||'').toLowerCase();
  if (u==='هزار'||u==='k') return Math.round(n*1000);
  if (u==='میلیون'||u==='m') return Math.round(n*1e6);
  return Math.round(n);
}

function parseGrowthFA(text) {
  if (!text) return 0;
  const t = faToEn(text).replace(/٬|,/g,'');
  const m = t.match(/(\d+)[٪%]/);
  return m ? parseInt(m[1]) : 0;
}

function extractTime(text) {
  if (!text) return '';
  const m = text.match(/(\d+\s*(?:دقیقه|ساعت|روز)\s*پیش)/);
  return m ? m[1] : '';
}

function fmtUnit(v) {
  if (v>=1e6) return 'M+';
  if (v>=1000) return 'K+';
  return '+';
}

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

async function scrapeTrends(url, label) {
  const b    = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fa-IR,fa;q=0.9' });
    await page.setViewport({ width: 1440, height: 900 });
    console.log(`[${label}] fetching...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });
    // منتظر لود شدن جدول
    await page.waitForSelector('table tbody tr', { timeout: 15000 }).catch(()=>{});
    await new Promise(r => setTimeout(r, 6000));

    const raw = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('table tbody tr').forEach((row, i) => {
        try {
          const rankTd = row.querySelector('td:first-child');
          const rank = parseInt((rankTd?.innerText||'').trim()) || (i+1);

          const clone = row.cloneNode(true);
          clone.querySelectorAll('mat-icon,.material-icons,button,[aria-hidden="true"]').forEach(el=>el.remove());
          const tds = clone.querySelectorAll('td');
          if (tds.length < 2) return;

          const kwTdText = (tds[1]?.innerText||'').trim();
          // پاک‌سازی کامل keyword از متن اضافه
          const rawKw = kwTdText.split('\n')[0].trim();
          const keyword = rawKw
            .replace(/[\u200f\u200e\u202a-\u202e]/g, '')
            .replace(/[\s\u00a0]*[\d۰-۹][\d۰-۹\s٬,.،]*(هزار|میلیون)?[\s\u00a0]*\+?[\s\u00a0]*(جستجو|·|فعال|ساعت|دقیقه|پیش).*$/u, '')
            .replace(/[\s\u00a0]*·.*$/, '')
            .replace(/[\u200f\u200e\u202a-\u202e]/g, '')
            .trim();
          if (!keyword) return;

          const volTdText = (tds[2]?.innerText||'').trim();
          const combinedText = kwTdText + '\n' + volTdText;
          const statusText = (tds[3]?.innerText||'').trim();

          const subEls = tds[1]?.querySelectorAll('a') || [];
          const subs = Array.from(subEls)
            .map(el=>el.innerText.trim())
            .filter(s=>s && !s.includes('مورد') && !s.includes('more') && s.length>1)
            .slice(0,4);

          results.push({ rank, keyword, combinedText, statusText, subs });
        } catch(e) {}
      });
      return results;
    });

    const parsed = raw.map(t => {
      const lines = t.combinedText.split('\n').map(l=>l.trim()).filter(Boolean);
      const volLine = lines.find(l=>/\d/.test(l)&&(l.includes('هزار')||l.includes('میلیون')||/\d+\+/.test(faToEn(l))))||lines[0]||'';
      const growthLine = lines.find(l=>l.includes('٪')||l.includes('%'))||'';
      const vol = parseVolFA(volLine);
      const growth = parseGrowthFA(growthLine);
      const time = extractTime(t.combinedText);
      const active = !t.statusText.includes('طول کشید') && !t.statusText.toLowerCase().includes('lasted');
      return {
        rank: t.rank,
        keyword: t.keyword,
        vol, unit: fmtUnit(vol), growth,
        active, lasted: !active ? t.statusText.trim() : null,
        cat: '', subs: t.subs, time,
      };
    });

    parsed.sort((a,b)=>a.rank-b.rank);
    parsed.forEach((t,i)=>t.rank=i+1);
    console.log(`[${label}] scraped ${parsed.length} trends`);
    return parsed;
  } finally {
    await page.close();
  }
}

// ── AI دسته‌بندی ──────────────────────────────────────────
async function aiCategorize(trends) {
  if (!trends.length) return trends;
  try {
    const keywords = trends.map((t,i)=>`${i+1}. ${t.keyword}`).join('\n');
    const prompt = `این لیست کلیدواژه‌های ترند جستجو در ایران است. برای هر کدام یک دسته‌بندی فارسی مناسب بنویس.

${keywords}

فقط JSON برگردان، بدون توضیح اضافه:
{"1":"ورزشی","2":"اقتصادی",...}

دسته‌بندی‌های مجاز (فقط از این‌ها): ورزشی، اقتصادی، سیاسی، سرگرمی، اجتماعی، مذهبی، تکنولوژی، خودرو، سلامت، مالی، قیمت کالا، علم`;

    const body = JSON.stringify({
      model: settingsDB.get('ai_model', 'openai/gpt-oss-20b:free'),
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 600,
    });

    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'openrouter.ai',
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.openrouterKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://signal.ir',
          'X-Title': 'Signal Crawler',
          'Content-Length': Buffer.byteLength(body),
        },
      }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    const text = result.choices?.[0]?.message?.content || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return trends;
    const catMap = JSON.parse(jsonMatch[0]);
    console.log('[AI] categories assigned');
    return trends.map((t,i) => ({ ...t, cat: catMap[String(i+1)] || '' }));
  } catch(e) {
    console.warn('[AI categorize] error:', e.message);
    return trends;
  }
}

function save(key, data) {
  const payload = { updatedAt: new Date().toISOString(), count: data.length, trends: data };
  fs.writeFileSync(path.join(CONFIG.dataDir, `${key}.json`), JSON.stringify(payload, null, 2));
  console.log(`[save] ${key}.json — ${data.length} items`);
}

function load(key) {
  const file = path.join(CONFIG.dataDir, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function crawl() {
  console.log(`\n═══ Crawl started at ${new Date().toISOString()} ═══`);
  try {
    // sequential برای جلوگیری از race condition روی browser
    const d4  = await scrapeTrends(CONFIG.urls.h4,  '4h');
    const d24 = await scrapeTrends(CONFIG.urls.h24, '24h');

    // یه call به AI برای همه کلیدواژه‌های ترکیب‌شده
    const allKeywords = [...d4];
    d24.forEach(t => { if (!d4.find(x=>x.keyword===t.keyword)) allKeywords.push(t); });

    if (allKeywords.length) {
      const categorized = await aiCategorize(allKeywords);
      const catMap = {};
      categorized.forEach(t => { catMap[t.keyword] = t.cat; });
      d4.forEach(t  => { t.cat = catMap[t.keyword] || ''; });
      d24.forEach(t => { t.cat = catMap[t.keyword] || ''; });
    }

    if (d4.length)  save('h4',  d4);
    if (d24.length) save('h24', d24);
  } catch(e) {
    console.error('[crawl] error:', e.message);
  }
  console.log(`═══ Crawl done ═══\n`);
}

// ── RSS Live Poller (هر ۳۰ ثانیه) ───────────────────────
const RSS_URL = 'https://trends.google.com/trending/rss?geo=IR';
const RSS_FILE = path.join(CONFIG.dataDir, 'rss_live.json');

let prevRssTitles = new Set();

function loadRssLive() {
  if (!fs.existsSync(RSS_FILE)) return null;
  return JSON.parse(fs.readFileSync(RSS_FILE, 'utf8'));
}

async function fetchRSSFeed() {
  return new Promise((resolve, reject) => {
    https.get(RSS_URL, {
      headers: { 'Accept-Language': 'fa-IR,fa;q=0.9', 'User-Agent': 'Mozilla/5.0' }
    }, (res) => {
      let xml = '';
      res.on('data', chunk => xml += chunk);
      res.on('end', () => {
        try {
          const items = [];
          const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
          for (const match of itemMatches) {
            const block = match[1];
            const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || block.match(/<title>(.*?)<\/title>/))?.[1]?.trim() || '';
            const link = block.match(/<link>(.*?)<\/link>/)?.[1]?.trim() || '';
            const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim() || '';
            const image = block.match(/<ht:picture>(.*?)<\/ht:picture>/)?.[1]?.trim() || '';
            const approxTraffic = block.match(/<ht:approx_traffic>(.*?)<\/ht:approx_traffic>/)?.[1]?.trim() || '';
            if (title) items.push({ title, link, pubDate, image, approxTraffic });
          }
          resolve(items);
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function pollRSS() {
  try {
    const items = await fetchRSSFeed();
    if (!items.length) return;

    // کشف کلیدواژه‌های جدید
    const isFirst = prevRssTitles.size === 0;
    const newItems = isFirst ? [] : items.filter(i => !prevRssTitles.has(i.title));
    items.forEach(i => prevRssTitles.add(i.title));

    if (newItems.length) {
      console.log(`[RSS] ${newItems.length} new item(s): ${newItems.map(i=>i.title).join(', ')}`);
    }

    const payload = {
      updatedAt: new Date().toISOString(),
      count: items.length,
      newCount: newItems.length,
      newTitles: newItems.map(i => i.title),
      items,
    };
    fs.writeFileSync(RSS_FILE, JSON.stringify(payload, null, 2));
  } catch(e) {
    console.warn('[RSS poll] error:', e.message);
  }
}

async function startRSSPoller() {
  // اولین fetch بلافاصله
  await pollRSS();
  setInterval(pollRSS, 30 * 1000);
  console.log('RSS poller running — every 30 seconds');
}

async function startScheduler() {
  await crawl();
  setInterval(crawl, CONFIG.intervalMs);
  console.log(`Scheduler running — every ${CONFIG.intervalMs/60000} minutes`);
  // RSS poller جداگانه
  startRSSPoller();
}

module.exports = { startScheduler, crawl, load, loadRssLive };
if (require.main === module) startScheduler().catch(console.error);
