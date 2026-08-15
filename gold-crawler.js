/**
 * gold-crawler.js — قیمت طلای ۱۸ عیار از پلتفرم‌های آنلاین
 *
 * چرا مرورگر و نه درخواست ساده:
 *   ملی‌گلد، تکنوگلد و طلاسی پشت ArvanCloud هستند و به درخواست ساده ۳۰۷
 *   به خودشان می‌دهند (حلقه‌ی چالش ضدربات). بقیه هم اغلب قیمت را سمت
 *   مرورگر بارگذاری می‌کنند. یک مرورگر مشترک برای هر ۱۰ سایت، هر ۱۰ دقیقه،
 *   هم ارزان‌تر از ۱۰ راه‌حل جداگانه است هم شکننده‌تر نیست.
 *
 * چرا تشخیص خودکار مقیاس:
 *   هر سایت واحد خودش را دارد — تومان بر گرم، ریال بر گرم، حتی ریال بر
 *   میلی‌گرم (اینوی). به‌جای هاردکد کردن ضریب هر سایت که با یک تغییر
 *   بی‌صدا غلط می‌شود، عدد خام در چند ضریب محتمل ضرب می‌شود و آن ضریبی
 *   پذیرفته می‌شود که نتیجه‌اش نزدیک قیمت مرجع بازار باشد.
 */
const path = require('path');
const https = require('https');
const goldDB = require('./gold-db');

const REF_DB = path.join(__dirname, 'data', 'finance.db');

/* نشانه‌های متنی که کنار قیمت درست می‌آیند، به ترتیب اولویت.
 * اولین نشانه‌ای که عدد معتبر بدهد برنده است.
 *
 * چرا 'لحظه‌ای خرید' جلوتر از 'قیمت خرید' آمده: در تکنوگلد متن واقعی
 * صفحه «قیمت لحظه‌ای خرید هر گرم…» است، نه «قیمت خرید» پشت‌سرهم — پس
 * هیچ‌وقت با هینت قبلی مچ نمی‌شد و به هینت عمومی‌تر «قیمت لحظه‌ای»
 * می‌رسید که همان امتیاز را به قیمت خرید *و* فروش می‌داد؛ چون در آن
 * تساوی هرچه زودتر در DOM بود برنده می‌شد، گاهی فروش را ذخیره می‌کرد.
 * ما همیشه قیمت «خرید» را می‌خواهیم — همان چیزی که کاربر برای خرید از
 * آن پلتفرم می‌پردازد، تا جدول «کف بازار» قابل‌مقایسه بماند. */
const HINTS = [
  'لحظه‌ای خرید', 'قیمت خرید', 'نرخ فعلی', 'آخرین قیمت', 'قیمت لحظه‌ای',
  'طلای ۱۸ عیار', 'طلا ۱۸ عیار', 'طلای 18 عیار', '۱۸ عیار', '18 عیار',
];

const PLATFORMS = [
  { slug: 'melligold',    name_fa: 'ملی‌گلد',      url: 'https://melligold.com/price/18-karat-gold',        sort_order: 1 },
  { slug: 'milli',        name_fa: 'میلی',         url: 'https://milli.gold/landing/',                      sort_order: 2 },
  { slug: 'talasea',      name_fa: 'طلاسی',        url: 'https://talasea.ir/gold-price',                    sort_order: 3 },
  { slug: 'technogold',   name_fa: 'تکنوگلد',      url: 'https://technogold.gold/',                         sort_order: 4 },
  { slug: 'wallgold',     name_fa: 'وال‌گلد',      url: 'https://wallgold.ir/gold-price/',                  sort_order: 5 },
  { slug: 'taline',       name_fa: 'طلاین',        url: 'https://taline.ir/goldprice/',                     sort_order: 6 },
  { slug: 'invi',         name_fa: 'اینوی',        url: 'https://invi.ir/gold-price/18carat',               sort_order: 7 },
  { slug: 'hamrahgold',   name_fa: 'همراه گلد',    url: 'https://hamrahgold.com/price-board',               sort_order: 8 },
  { slug: 'goldika',      name_fa: 'گلدیکا',       url: 'https://goldika.ir/gold/18k',                      sort_order: 9 },
  { slug: 'tabdeal',      name_fa: 'تبدیل',        url: 'https://tabdeal.org/digital-gold',                 sort_order: 10 },
  { slug: 'digikala-gold', name_fa: 'طلای دیجی‌کالا', url: 'https://www.digikala.com/wealth/my-assets/',   sort_order: 11, logo: '/gold-logos/digikala-gold.svg' },
  { slug: 'ecogold',      name_fa: 'اکوگلد',       url: 'https://ecogold.ir/',                              sort_order: 12, logo: '/gold-logos/ecogold.jpg' },
];

function seed() {
  for (const p of PLATFORMS) goldDB.upsertPlatform(p);
}

/** قیمت مرجع طلای ۱۸ عیار از دیتابیس مالی خودمان (تومان بر گرم) */
function reference() {
  try {
    const Database = require('better-sqlite3');
    const d = new Database(REF_DB, { readonly: true, fileMustExist: true });
    const r = d.prepare(
      "SELECT price FROM finance_snapshots WHERE symbol='gold18' ORDER BY id DESC LIMIT 1"
    ).get();
    d.close();
    // در finance.db واحد ریال است
    return r && r.price ? Number(r.price) / 10 : null;
  } catch (e) { return null; }
}

/**
 * عدد خام سایت را به «تومان بر گرم» تبدیل می‌کند.
 * ضریب درست آن است که نتیجه‌اش تا ±۱۵٪ قیمت مرجع بازار باشد — بازه‌ای
 * که اختلاف واقعی پلتفرم‌ها (چند دهم درصد) راحت داخلش جا می‌شود ولی
 * عدد بی‌ربط (تعداد بازدید، شماره تلفن، قیمت سکه) بیرون می‌ماند.
 */
function toToman(raw, ref) {
  const lo = ref * 0.85, hi = ref * 1.15;
  for (const f of [1, 0.1, 100, 10, 0.01, 1000]) {
    const v = raw * f;
    if (v >= lo && v <= hi) return v;
  }
  return null;
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        accept: 'application/json',
      },
      timeout: 15000,
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let b = ''; res.setEncoding('utf8');
      res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('JSON نامعتبر')); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/**
 * دو پلتفرم آخر یک API عمومی و تمیز دارند — بدون چالش ضدربات، بدون
 * رندر سمت مرورگر. یک HTTPS GET ساده کافی است، پس اصلاً کروم لازم
 * ندارند؛ در حلقه‌ی اصلی از مسیر Puppeteer رد می‌شوند.
 */
const API_SCRAPERS = {
  /** api.digikala.com قیمت را «ریال بر میلی‌گرم» می‌دهد؛ ×۱۰۰ به تومان بر گرم */
  'digikala-gold': async () => {
    const j = await getJSON('https://api.digikala.com/non-inventory/v1/prices/');
    const raw = j && j.gold18 && j.gold18.price;
    if (!raw) throw new Error('gold18.price در پاسخ نبود');
    return Math.round(Number(raw) * 100);
  },
  /** backend.ecogold.ir از قبل تومان بر گرم می‌دهد؛ buy_price یعنی قیمتی که کاربر برای خرید می‌پردازد */
  ecogold: async () => {
    const j = await getJSON('https://backend.ecogold.ir/api/prices/otc');
    const row = j && Array.isArray(j.data) && j.data.find(x => x.symbol === 'GOLD18-IRT');
    if (!row || !row.buy_price) throw new Error('GOLD18-IRT در پاسخ نبود');
    return Math.round(Number(row.buy_price));
  },
};

async function scrapeOne(page, plat, ref) {
  const t0 = Date.now();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'fa-IR,fa;q=0.9' });
  // networkidle2 روی سایت‌هایی که وب‌سوکت دائمی دارند (صرافی‌ها) هرگز رخ
  // نمی‌دهد و به تایم‌اوت می‌خورد. domcontentloaded به‌علاوه‌ی مکث ثابت
  // مطمئن‌تر است.
  // تایم‌اوت ناوبری را کشنده نمی‌گیریم: صفحه‌هایی که وب‌سوکت دائمی دارند
  // هرگز "بی‌کار" نمی‌شوند، ولی DOM‌شان همان اول آماده است. اگر goto مهلت
  // تمام کرد، باز هم تلاش می‌کنیم عدد را از همان چیزی که لود شده بخوانیم.
  try {
    await page.goto(plat.url, { waitUntil: 'domcontentloaded', timeout: 40000 });
  } catch (e) {
    if (!/timeout/i.test(e.message)) throw e;
  }
  await new Promise(r => setTimeout(r, plat.slug === 'tabdeal' ? 18000 : 9000));

  // صفحه‌های پشت چالش ضدربات بعد از لود یک بار دیگر ناوبری می‌کنند و
  // context جاوااسکریپت از بین می‌رود. یک تلاش دوباره کافی است.
  const readCands = () => page.evaluate((HINTS) => {
    // واحد پول را هم پاک می‌کنیم، وگرنه برگی مثل «۱۹,۱۶۶,۳۵۵ تومان» (که
    // مقدار و واحد در یک تکه متن‌اند، بدون تگ جدا) رد صلاحیت می‌شد چون
    // بعد از حذف کاما و فاصله هنوز حرف داشت — دقیقاً قیمت خرید تکنوگلد
    // با همین الگو از دست می‌رفت.
    const norm = s => String(s)
      .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
      .replace(/[٬,،\s]/g, '')
      .replace(/(تومان|ریال|ريال|تومن)$/g, '');

    // هر برگِ متنی که فقط یک عدد باشد (با احتساب واحد پول چسبیده به آن)،
    // همراه با متن کادر دربرگیرنده‌اش
    const leaves = [];
    document.querySelectorAll('*').forEach(el => {
      if (el.children.length) return;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 30) return;
      const raw = norm(t);
      if (!/^\d{5,12}$/.test(raw)) return;
      let ctx = '';
      let e = el;
      for (let i = 0; e && i < 4; i++, e = e.parentElement) {
        ctx = (e.textContent || '').replace(/\s+/g, ' ').trim();
        if (ctx.length > 12) break;
      }
      leaves.push({ n: Number(raw), ctx: ctx.slice(0, 160) });
    });

    // امتیاز: هرچه نشانه‌ی متنی مهم‌تری کنارش باشد، جلوتر
    return leaves.map(l => {
      let score = HINTS.length;
      for (let i = 0; i < HINTS.length; i++) {
        if (l.ctx.includes(HINTS[i])) { score = i; break; }
      }
      return { n: l.n, ctx: l.ctx, score };
    }).sort((a, b) => a.score - b.score).slice(0, 40);
  }, HINTS);

  let cands;
  try { cands = await readCands(); }
  catch (e) {
    if (!/context was destroyed|detached/i.test(e.message)) throw e;
    await new Promise(r => setTimeout(r, 7000));
    cands = await readCands();
  }

  for (const c of cands) {
    const v = toToman(c.n, ref);
    if (v) return { price: Math.round(v), ms: Date.now() - t0, ctx: c.ctx.slice(0, 60) };
  }
  throw new Error('عددی در بازه‌ی قیمت طلای ۱۸ عیار پیدا نشد');
}

// اگر یک دور هنوز تمام نشده، دور بعدی نباید مرورگر دوم بالا بیاورد —
// دو کروم هم‌زمان روی این سرور دو‌هسته‌ای بار I/O را چند برابر می‌کند.
let crawling = false;

async function crawl() {
  if (crawling) { console.log('[gold] دور قبلی هنوز تمام نشده — این دور رد شد'); return { ok: 0, fail: 0 }; }
  crawling = true;
  try { return await _crawl(); } finally { crawling = false; }
}

async function _crawl() {
  seed();
  const ref = reference();
  if (!ref) {
    console.warn('[gold] قیمت مرجع در دسترس نیست — این دور رد شد');
    return { ok: 0, fail: 0, skipped: true };
  }

  const puppeteer = require('puppeteer');
  console.log(`═══ Gold platforms — مرجع بازار ${Math.round(ref).toLocaleString('en-US')} تومان ═══`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  let ok = 0, fail = 0;
  try {
    for (const plat of goldDB.getPlatforms(true)) {
      const t0 = Date.now();
      const apiFn = API_SCRAPERS[plat.slug];

      // دو پلتفرم با API عمومی، بدون باز کردن صفحه‌ی مرورگر
      if (apiFn) {
        try {
          const raw = await apiFn();
          // apiFn از قبل به تومان بر گرم تبدیل کرده؛ toToman اینجا فقط
          // به‌عنوان حفاظ می‌ماند — اگر ساختار پاسخ API روزی بی‌خبر عوض
          // شود، عدد بی‌ربط رد می‌شود نه این‌که ذخیره شود.
          const v = toToman(raw, ref);
          if (!v) throw new Error('عدد ' + raw + ' در بازه‌ی قیمت مرجع نیست');
          const price = Math.round(v);
          goldDB.savePrice(plat.id, price);
          goldDB.setStatus(plat.id, { ok: true, ms: Date.now() - t0 });
          ok++;
          console.log(`  ✓ ${plat.name_fa.padEnd(11)} ${price.toLocaleString('en-US')}  (${Date.now() - t0}ms)  « API مستقیم`);
        } catch (e) {
          goldDB.setStatus(plat.id, { ok: false, error: e.message.slice(0, 160) });
          fail++;
          console.log(`  ✗ ${plat.name_fa.padEnd(11)} ${e.message.slice(0, 70)}`);
        }
        continue;
      }

      const page = await browser.newPage();
      try {
        const r = await scrapeOne(page, plat, ref);
        goldDB.savePrice(plat.id, r.price);
        goldDB.setStatus(plat.id, { ok: true, ms: r.ms });
        ok++;
        console.log(`  ✓ ${plat.name_fa.padEnd(11)} ${r.price.toLocaleString('en-US')}  (${r.ms}ms)  « ${r.ctx}`);
      } catch (e) {
        goldDB.setStatus(plat.id, { ok: false, error: e.message.slice(0, 160) });
        fail++;
        console.log(`  ✗ ${plat.name_fa.padEnd(11)} ${e.message.slice(0, 70)}`);
      }
      try { await page.close(); } catch (e) {}
    }
  } finally {
    try { await browser.close(); } catch (e) {}
  }

  goldDB.cleanup(30);
  console.log(`═══ Gold done — ${ok} موفق، ${fail} ناموفق ═══`);
  return { ok, fail };
}

let timer = null;
function startGoldScheduler(minutes) {
  const ms = (minutes || 10) * 60 * 1000;
  if (timer) clearInterval(timer);
  // اولین اجرا با کمی تأخیر تا با راه‌اندازی بقیه‌ی سرویس‌ها تداخل نکند
  setTimeout(() => { crawl().catch(e => console.error('[gold]', e.message)); }, 45000);
  timer = setInterval(() => { crawl().catch(e => console.error('[gold]', e.message)); }, ms);
  console.log(`[gold] زمان‌بند فعال شد — هر ${minutes || 10} دقیقه`);
}

module.exports = { crawl, seed, startGoldScheduler, PLATFORMS };

if (require.main === module) {
  crawl().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
