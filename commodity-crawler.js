/**
 * commodity-crawler.js — قیمت جهانی کالا (بدون مرورگر بی‌سر)
 *
 * داده‌ی هدف کاملاً سمت سرور رندر می‌شود و روی هر ردیف `data-value` دارد،
 * پس برخلاف کرالرهای طلا و خودرو، اینجا هیچ Puppeteer لازم نیست —
 * فقط یک HTTPS GET ساده، درست مثل property-crawler.js.
 *
 * بازه‌ی کرال از پنل مدیریت قابل تغییر است (settings-db، کلید
 * commodity_interval_min) و بین ۱۰ تا ۱۲۰ دقیقه محدود می‌شود — حداقل
 * ۱۰ دقیقه چون منبع یک فروشنده‌ی تجاری داده است و تشخیص ربات دارد؛
 * زیر این عدد رفتن ریسک مسدود شدن را بی‌دلیل بالا می‌برد.
 */
const https = require('https');
const cdb = require('./commodity-db');
const settingsDB = require('./settings-db');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const URL = 'https://tradingeconomics.com/commodities';
const MIN_INTERVAL_MIN = 10;
const MAX_INTERVAL_MIN = 120;
const DEFAULT_INTERVAL_MIN = 10;

/**
 * فهرست کالاها — تقریباً همه‌ی ۹۸ نمادی که منبع می‌دهد، با برچسب فارسی
 * و واحد ترجمه‌شده. چند مورد کاملاً تکراری کنار گذاشته شدند (مثل
 * iron-ore-cny که همان iron-ore با واحد دیگر است).
 * scale برای کالاهایی که منبع به «سنت» قیمت‌گذاری می‌کند (USd) به کار
 * می‌رود تا در نمایش به دلار کامل تبدیل شوند.
 */
const CURATED = {
  // ── انرژی ──
  'crude-oil':        { fa: 'نفت خام WTI',      cat: 'energy', unitFa: 'دلار به بشکه',              scale: 1 },
  'brent-crude-oil':  { fa: 'نفت برنت',         cat: 'energy', unitFa: 'دلار به بشکه',              scale: 1 },
  'urals-oil':        { fa: 'نفت اورال روسیه',  cat: 'energy', unitFa: 'دلار به بشکه',              scale: 1 },
  'natural-gas':      { fa: 'گاز طبیعی آمریکا', cat: 'energy', unitFa: 'دلار به میلیون بی‌تی‌یو',   scale: 1 },
  'eu-natural-gas':   { fa: 'گاز طبیعی اروپا',  cat: 'energy', unitFa: 'یورو به مگاوات‌ساعت',       scale: 1 },
  'uk-natural-gas':   { fa: 'گاز طبیعی انگلیس', cat: 'energy', unitFa: 'پنس به ترم',                scale: 1 },
  'germany-natural-gas-the': { fa: 'گاز طبیعی آلمان', cat: 'energy', unitFa: 'یورو به مگاوات‌ساعت', scale: 1 },
  'liquefied-natural-gas-japan-korea': { fa: 'ال‌ان‌جی ژاپن-کره', cat: 'energy', unitFa: 'دلار به میلیون بی‌تی‌یو', scale: 1 },
  'gasoline':         { fa: 'بنزین آمریکا',     cat: 'energy', unitFa: 'دلار به گالن',              scale: 1 },
  'heating-oil':      { fa: 'گازوئیل حرارتی',   cat: 'energy', unitFa: 'دلار به گالن',              scale: 1 },
  'propane':          { fa: 'پروپان',           cat: 'energy', unitFa: 'دلار به گالن',              scale: 1 },
  'ethanol':          { fa: 'اتانول',           cat: 'energy', unitFa: 'دلار به گالن',              scale: 1 },
  'naphtha':          { fa: 'نفتا',             cat: 'energy', unitFa: 'دلار به تن',                scale: 1 },
  'coal':             { fa: 'زغال‌سنگ',         cat: 'energy', unitFa: 'دلار به تن',                scale: 1 },
  'coking-coal':      { fa: 'زغال‌سنگ کک‌شو',   cat: 'energy', unitFa: 'دلار به تن',                scale: 1 },
  'uranium':          { fa: 'اورانیوم',         cat: 'energy', unitFa: 'دلار به پوند',              scale: 1 },

  // ── فلزات گران‌بها ──
  'gold':             { fa: 'طلا (انس جهانی)',  cat: 'precious', unitFa: 'دلار به اونس', scale: 1 },
  'silver':           { fa: 'نقره',             cat: 'precious', unitFa: 'دلار به اونس', scale: 1 },
  'platinum':         { fa: 'پلاتین',           cat: 'precious', unitFa: 'دلار به اونس', scale: 1 },
  'palladium':        { fa: 'پالادیوم',         cat: 'precious', unitFa: 'دلار به اونس', scale: 1 },
  'rhodium':          { fa: 'رودیوم',           cat: 'precious', unitFa: 'دلار به اونس', scale: 1 },

  // ── فلزات پایه ──
  'copper':           { fa: 'مس',               cat: 'base', unitFa: 'دلار به پوند',   scale: 1 },
  'aluminum':         { fa: 'آلومینیوم',        cat: 'base', unitFa: 'دلار به تن',     scale: 1 },
  'zinc':             { fa: 'روی',              cat: 'base', unitFa: 'دلار به تن',     scale: 1 },
  'nickel':           { fa: 'نیکل',             cat: 'base', unitFa: 'دلار به تن',     scale: 1 },
  'lead':             { fa: 'سرب',              cat: 'base', unitFa: 'دلار به تن',     scale: 1 },
  'tin':              { fa: 'قلع',              cat: 'base', unitFa: 'دلار به تن',     scale: 1 },
  'cobalt':           { fa: 'کبالت',            cat: 'base', unitFa: 'دلار به تن',     scale: 1 },
  'cobalt-hydroxide': { fa: 'هیدروکسید کبالت',  cat: 'base', unitFa: 'دلار به تن',     scale: 1 },
  'lithium':          { fa: 'لیتیوم',           cat: 'base', unitFa: 'یوان به تن',     scale: 1 },
  'iron-ore':         { fa: 'سنگ‌آهن',          cat: 'base', unitFa: 'دلار به تن',     scale: 1 },
  'steel':            { fa: 'فولاد (چین)',      cat: 'base', unitFa: 'یوان به تن',     scale: 1 },
  'hrc-steel':        { fa: 'فولاد گرم‌نورد',    cat: 'base', unitFa: 'دلار به تن',     scale: 1 },
  'scrap-steel':      { fa: 'قراضه‌ی فولاد',    cat: 'base', unitFa: 'دلار به تن',     scale: 1 },
  'scrap-aluminum':   { fa: 'قراضه‌ی آلومینیوم', cat: 'base', unitFa: 'دلار به تن',    scale: 1 },
  'aluminum-alloy':   { fa: 'آلیاژ آلومینیوم',  cat: 'base', unitFa: 'یوان به تن',     scale: 1 },
  'silicon':          { fa: 'سیلیکون',          cat: 'base', unitFa: 'یوان به تن',     scale: 1 },
  'titanium':         { fa: 'تیتانیوم',         cat: 'base', unitFa: 'یوان به کیلوگرم', scale: 1 },
  'molybden':         { fa: 'مولیبدن',          cat: 'base', unitFa: 'یوان به کیلوگرم', scale: 1 },
  'manganese':        { fa: 'منگنز',            cat: 'base', unitFa: 'یوان به واحد',    scale: 1 },
  'gallium':          { fa: 'گالیوم',           cat: 'base', unitFa: 'یوان به کیلوگرم', scale: 1 },
  'germanium':        { fa: 'ژرمانیوم',         cat: 'base', unitFa: 'یوان به کیلوگرم', scale: 1 },
  'indium':           { fa: 'ایندیوم',          cat: 'base', unitFa: 'یوان به کیلوگرم', scale: 1 },
  'magnesium':        { fa: 'منیزیم',           cat: 'base', unitFa: 'یوان به تن',      scale: 1 },
  'neodymium':        { fa: 'نئودیمیوم',        cat: 'base', unitFa: 'یوان به تن',      scale: 1 },
  'tellurium':        { fa: 'تلوریوم',          cat: 'base', unitFa: 'یوان به کیلوگرم', scale: 1 },

  // ── محصولات کشاورزی ──
  'wheat':             { fa: 'گندم',        cat: 'agri', unitFa: 'دلار به بوشل',       scale: 0.01 },
  'corn':               { fa: 'ذرت',         cat: 'agri', unitFa: 'دلار به بوشل',       scale: 0.01 },
  'soybeans':           { fa: 'سویا',        cat: 'agri', unitFa: 'دلار به بوشل',       scale: 0.01 },
  'oat':                { fa: 'جو دوسر',     cat: 'agri', unitFa: 'دلار به بوشل',       scale: 0.01 },
  'canola':             { fa: 'کانولا',      cat: 'agri', unitFa: 'دلار کانادا به تن',  scale: 1 },
  'rapeseed-oil':       { fa: 'روغن کلزا',   cat: 'agri', unitFa: 'یورو به تن',         scale: 1 },
  'sunflower-oil':      { fa: 'روغن آفتابگردان', cat: 'agri', unitFa: 'روپیه هند به ده کیلوگرم', scale: 1 },
  'palm-oil':           { fa: 'روغن نخل',    cat: 'agri', unitFa: 'رینگیت مالزی به تن', scale: 1 },
  'coffee':             { fa: 'قهوه',        cat: 'agri', unitFa: 'دلار به پوند',       scale: 0.01 },
  'cocoa':               { fa: 'کاکائو',     cat: 'agri', unitFa: 'دلار به تن',         scale: 1 },
  'tea':                 { fa: 'چای',        cat: 'agri', unitFa: 'روپیه هند به کیلوگرم', scale: 1 },
  'sugar':               { fa: 'شکر',        cat: 'agri', unitFa: 'دلار به پوند',       scale: 0.01 },
  'cotton':              { fa: 'پنبه',       cat: 'agri', unitFa: 'دلار به پوند',       scale: 0.01 },
  'rice':                { fa: 'برنج',       cat: 'agri', unitFa: 'دلار به صد پوند',    scale: 1 },
  'barley':              { fa: 'جو',         cat: 'agri', unitFa: 'روپیه هند به تن',    scale: 1 },
  'orange-juice':        { fa: 'آب‌پرتقال',  cat: 'agri', unitFa: 'دلار به پوند',       scale: 0.01 },
  'lumber':              { fa: 'الوار',      cat: 'agri', unitFa: 'دلار به هزار فوت تخته', scale: 1 },
  'rubber':              { fa: 'لاستیک طبیعی', cat: 'agri', unitFa: 'دلار به کیلوگرم', scale: 0.01 },
  'wool':                { fa: 'پشم',        cat: 'agri', unitFa: 'دلار استرالیا به صد کیلوگرم', scale: 1 },
  'cheese':              { fa: 'پنیر',       cat: 'agri', unitFa: 'دلار به پوند',       scale: 1 },
  'milk':                { fa: 'شیر',        cat: 'agri', unitFa: 'دلار به صد پوند',    scale: 1 },
  'butter':              { fa: 'کره',        cat: 'agri', unitFa: 'یورو به تن',         scale: 1 },

  // ── صنعتی و مواد اولیه شیمیایی ──
  'methanol':          { fa: 'متانول',        cat: 'industrial', unitFa: 'یوان به تن',      scale: 1 },
  'bitumen':           { fa: 'قیر',           cat: 'industrial', unitFa: 'یوان به تن',      scale: 1 },
  'polyethylene':      { fa: 'پلی‌اتیلن',     cat: 'industrial', unitFa: 'یوان به تن',      scale: 1 },
  'polyvinyl':         { fa: 'پی‌وی‌سی',       cat: 'industrial', unitFa: 'یوان به تن',      scale: 1 },
  'polypropylene':     { fa: 'پلی‌پروپیلن',   cat: 'industrial', unitFa: 'یوان به تن',      scale: 1 },
  'synthetic-rubber':  { fa: 'لاستیک مصنوعی', cat: 'industrial', unitFa: 'یوان به تن',      scale: 1 },
  'soda-ash':          { fa: 'سود اش',        cat: 'industrial', unitFa: 'یوان به تن',      scale: 1 },
  'styrene':           { fa: 'استایرن',       cat: 'industrial', unitFa: 'یوان به تن',      scale: 1 },
  'sulfur':            { fa: 'گوگرد',         cat: 'industrial', unitFa: 'یوان به تن',      scale: 1 },
  'urea':              { fa: 'اوره',          cat: 'industrial', unitFa: 'دلار به تن',      scale: 1 },
  'di-ammonium':       { fa: 'دی‌آمونیوم فسفات', cat: 'industrial', unitFa: 'دلار به تن',   scale: 1 },
  'phosphorus':        { fa: 'فسفر',          cat: 'industrial', unitFa: 'یوان به تن',      scale: 1 },
  'kraft-pulp':        { fa: 'خمیر کرافت',    cat: 'industrial', unitFa: 'یوان به تن',      scale: 1 },

  // ── دام و پروتئین ──
  'live-cattle':   { fa: 'گاو زنده',      cat: 'livestock', unitFa: 'دلار به پوند',        scale: 0.01 },
  'feeder-cattle': { fa: 'گوساله‌ی پرواری', cat: 'livestock', unitFa: 'دلار به پوند',      scale: 0.01 },
  'lean-hogs':     { fa: 'گوشت خوک',       cat: 'livestock', unitFa: 'دلار به پوند',        scale: 0.01 },
  'beef':          { fa: 'گوشت گاو',       cat: 'livestock', unitFa: 'رئال برزیل به ۱۵ کیلوگرم', scale: 1 },
  'poultry':       { fa: 'مرغ',            cat: 'livestock', unitFa: 'رئال برزیل به کیلوگرم', scale: 1 },
  'eggs-us':       { fa: 'تخم‌مرغ آمریکا', cat: 'livestock', unitFa: 'دلار به دوجین',       scale: 1 },
  'eggs-ch':       { fa: 'تخم‌مرغ چین',    cat: 'livestock', unitFa: 'یوان به تن',          scale: 1 },
  'salmon':        { fa: 'ماهی سالمون',    cat: 'livestock', unitFa: 'کرون نروژ به کیلوگرم', scale: 1 },

  // ── شاخص‌های ترکیبی ──
  'crb':                          { fa: 'شاخص CRB',                cat: 'index', unitFa: 'واحد شاخص', scale: 1 },
  'gsci':                         { fa: 'شاخص GSCI',               cat: 'index', unitFa: 'واحد شاخص', scale: 1 },
  'consume-commodity-index':      { fa: 'شاخص کالای بورس شانگهای', cat: 'index', unitFa: 'واحد شاخص', scale: 1 },
  'containerized-freight-index':  { fa: 'شاخص کرایه‌ی کانتینر',    cat: 'index', unitFa: 'واحد شاخص', scale: 1 },
  'carbon':                       { fa: 'مجوز کربن اروپا',         cat: 'index', unitFa: 'یورو',      scale: 1 },
  'wind':                         { fa: 'شاخص انرژی بادی',         cat: 'index', unitFa: 'دلار',      scale: 1 },
  'nuclear':                      { fa: 'شاخص انرژی هسته‌ای',      cat: 'index', unitFa: 'دلار',      scale: 1 },
  'solar':                        { fa: 'شاخص انرژی خورشیدی',      cat: 'index', unitFa: 'دلار',      scale: 1 },
};

const CAT_ORDER = ['energy', 'precious', 'base', 'agri', 'industrial', 'livestock', 'index'];
const CAT_FA = {
  energy: 'انرژی', precious: 'فلزات گران‌بها', base: 'فلزات پایه',
  agri: 'محصولات کشاورزی', industrial: 'صنعتی و مواد اولیه',
  livestock: 'دام و پروتئین', index: 'شاخص‌های ترکیبی',
};

let crawling = false;
let timer = null;

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
      timeout: 30000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return resolve(get(new URL(res.headers.location, url).href));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let b = ''; res.setEncoding('utf8');
      res.on('data', d => b += d);
      res.on('end', () => resolve(b));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const numOf = s => { const n = parseFloat(String(s || '').replace(/,/g, '')); return isNaN(n) ? null : n; };

/** پارس تک‌تک ردیف‌های جدول — روش تقسیم بر اساس `<tr data-symbol="` که
 *  در آزمایش مستقیم روی HTML واقعی صفحه تأیید شد. */
function parseRows(html) {
  const parts = html.split('<tr data-symbol="').slice(1);
  const out = [];
  for (const part of parts) {
    const hrefM = part.match(/<a href="\/commodity\/([^"]+)">/);
    if (!hrefM) continue;
    const slug = hrefM[1];
    const curated = CURATED[slug];
    if (!curated) continue;   // فقط نمادهای فهرست‌شده را نگه می‌داریم

    const priceM = part.match(/id="p"[^>]*>\s*([\-\d.,]*)\s*<\/td>/);
    const values = [...part.matchAll(/data-value="(-?[\d.]+)"/g)].map(m => parseFloat(m[1]));
    // ترتیب مشاهده‌شده در HTML: [تغییر مطلق، درصد تغییر، هفتگی، ماهانه، از‌ابتدای‌سال، سالانه]
    const [nch, pch, weekly, monthly, ytd, yoy] = values;

    const scale = curated.scale || 1;
    const price = priceM ? numOf(priceM[1]) : null;
    if (price == null) continue;

    out.push({
      slug, name_en: slug, category: curated.cat,
      unit: curated.unitFa,
      price: price * scale,
      change: nch != null ? nch * scale : null,
      change_pct: pch != null ? pch : null,
      weekly_pct: weekly != null ? weekly : null,
      monthly_pct: monthly != null ? monthly : null,
      ytd_pct: ytd != null ? ytd : null,
      yoy_pct: yoy != null ? yoy : null,
    });
  }
  return out;
}

async function crawlOnce() {
  if (crawling) { console.log('[commodity] اجرای قبلی هنوز تمام نشده — رد شد'); return null; }
  crawling = true;
  const t0 = Date.now();
  try {
    const html = await get(URL);
    const rows = parseRows(html);
    if (rows.length < 10) throw new Error('فقط ' + rows.length + ' ردیف پیدا شد — احتمالاً ساختار صفحه عوض شده');

    cdb.saveSnapshots(rows);
    cdb.setStatus({ ok: true, ms: Date.now() - t0, rows: rows.length });
    console.log(`[commodity] ${rows.length} کالا ذخیره شد · ${Math.round((Date.now() - t0) / 1000)} ثانیه`);
    return rows.length;
  } catch (e) {
    cdb.setStatus({ ok: false, error: e.message, ms: Date.now() - t0 });
    console.warn('[commodity] خطا:', e.message);
    return null;
  } finally { crawling = false; }
}

function getIntervalMin() {
  const raw = parseInt(settingsDB.get('commodity_interval_min', DEFAULT_INTERVAL_MIN), 10);
  if (isNaN(raw)) return DEFAULT_INTERVAL_MIN;
  return Math.max(MIN_INTERVAL_MIN, Math.min(MAX_INTERVAL_MIN, raw));
}

/**
 * حلقه‌ی خودزمان‌بند به‌جای setInterval ثابت: هر بار قبل از اجرای بعدی
 * تنظیمات را دوباره می‌خواند، پس تغییر بازه از پنل مدیریت همان چرخه‌ی
 * بعدی اعمال می‌شود، بدون نیاز به ری‌استارت پروسه.
 */
function scheduleNext() {
  const min = getIntervalMin();
  timer = setTimeout(async () => {
    await crawlOnce().catch(e => console.error('[commodity]', e.message));
    scheduleNext();
  }, min * 60 * 1000);
}

function startCommodityScheduler(initialDelayMs) {
  setTimeout(() => {
    crawlOnce().catch(e => console.error('[commodity]', e.message)).finally(scheduleNext);
  }, initialDelayMs || 60 * 1000);
  console.log('[commodity] زمان‌بند فعال — پیش‌فرض هر ' + DEFAULT_INTERVAL_MIN + ' دقیقه (قابل تغییر از پنل مدیریت)');
}

module.exports = {
  crawlOnce, startCommodityScheduler, getIntervalMin,
  CURATED, CAT_ORDER, CAT_FA, MIN_INTERVAL_MIN, MAX_INTERVAL_MIN,
};

if (require.main === module) {
  require('dotenv').config();
  crawlOnce().then(n => { console.log('نتیجه:', n); process.exit(n ? 0 : 1); });
}
