/**
 * gen-og.js — ساخت تصویر پیش‌نمایش (OG Image) سایت
 *
 * تصویر قبلی همه‌ی حروف فارسی را به‌شکل مربع خالی (□) نشان می‌داد چون
 * اسکریپت سازنده‌اش صفحه را قبل از بارگذاری کامل فونت IRANSans عکس
 * گرفته بود. اینجا فونت‌ها مستقیماً به‌صورت base64 داخل HTML جاسازی
 * می‌شوند (بدون وابستگی به شبکه) و صریحاً منتظر `document.fonts.ready`
 * می‌مانیم قبل از اسکرین‌شات.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const FONT_DIR = path.join(__dirname, 'public', 'assets', 'fonts');
const b64 = f => fs.readFileSync(path.join(FONT_DIR, f)).toString('base64');

const FONTS = {
  ultralight: b64('IRANSansWeb_UltraLight.woff2'),
  light:      b64('IRANSansWeb_Light.woff2'),
  regular:    b64('IRANSansWeb.woff2'),
  medium:     b64('IRANSansWeb_Medium.woff2'),
  bold:       b64('IRANSansWeb_Bold.woff2'),
};

const TABS = ['ترند سرچ', 'ترند اخبار', 'ترند مالی', 'ترند ملک', 'ترند خودرو', 'پیش‌بینی ترند'];

const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<style>
@font-face { font-family:'IRANSans'; src:url(data:font/woff2;base64,${FONTS.regular}) format('woff2'); font-weight:400; }
@font-face { font-family:'IRANSans'; src:url(data:font/woff2;base64,${FONTS.medium}) format('woff2'); font-weight:500; }
@font-face { font-family:'IRANSans'; src:url(data:font/woff2;base64,${FONTS.bold}) format('woff2'); font-weight:700; }
@font-face { font-family:'IRANSans'; src:url(data:font/woff2;base64,${FONTS.light}) format('woff2'); font-weight:300; }

* { margin:0; padding:0; box-sizing:border-box; }
html,body { width:1200px; height:630px; overflow:hidden; }
body {
  font-family:'IRANSans', sans-serif;
  background: #0b0e13;
  position: relative;
  color: #e8ecf2;
}
.glow-1 { position:absolute; top:-220px; right:-160px; width:640px; height:640px; border-radius:50%;
  background: radial-gradient(circle, rgba(79,131,247,0.30), transparent 70%); filter: blur(10px); }
.glow-2 { position:absolute; bottom:-260px; left:-200px; width:680px; height:680px; border-radius:50%;
  background: radial-gradient(circle, rgba(155,124,252,0.22), transparent 70%); filter: blur(10px); }
.grid-fade {
  position:absolute; inset:0;
  background-image: linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px),
                     linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px);
  background-size: 40px 40px;
  -webkit-mask-image: radial-gradient(ellipse at 70% 30%, black 0%, transparent 65%);
          mask-image: radial-gradient(ellipse at 70% 30%, black 0%, transparent 65%);
}

.wrap { position:relative; z-index:2; width:100%; height:100%; padding: 64px 72px; display:flex; flex-direction:column; }

.brand { display:flex; align-items:center; gap:14px; }
.mark {
  width:52px; height:52px; border-radius:14px; flex-shrink:0;
  background: linear-gradient(135deg, #4f83f7, #9b7cfc);
  display:flex; align-items:center; justify-content:center;
  font-weight:700; font-size:24px; color:#fff;
  box-shadow: 0 8px 24px rgba(79,131,247,0.35);
}
.brand-name { font-size:28px; font-weight:700; color:#f3f5f9; }
.brand-name b { color:#8fb4ff; font-weight:700; }
.live { margin-right:auto; display:flex; align-items:center; gap:8px; font-size:16px; color:#4ade80; font-weight:500; }
.live i { width:9px; height:9px; border-radius:50%; background:#4ade80; box-shadow:0 0 0 5px rgba(74,222,128,0.16); }

.title { margin-top:64px; font-size:56px; font-weight:700; line-height:1.35; color:#fff; max-width:1000px; }
.title .hl { background: linear-gradient(90deg, #8fb4ff, #c3b2ff); -webkit-background-clip:text; background-clip:text; color:transparent; }

.subtitle { margin-top:22px; font-size:23px; line-height:1.8; color:#9aa4b2; max-width:880px; font-weight:400; }

.pills { margin-top:auto; display:flex; flex-wrap:wrap; gap:10px; }
.pill {
  padding: 10px 20px; border-radius:999px; font-size:17px; font-weight:500;
  background: rgba(255,255,255,0.055); border:1px solid rgba(255,255,255,0.10); color:#c7cedb;
}

.footer { margin-top:26px; display:flex; align-items:center; justify-content:space-between; }
.url { font-size:19px; color:#6c7889; font-weight:500; direction:ltr; }
.tagline { font-size:17px; color:#4f5966; font-weight:400; }
</style>
</head>
<body>
  <div class="glow-1"></div>
  <div class="glow-2"></div>
  <div class="grid-fade"></div>
  <div class="wrap">
    <div class="brand">
      <div class="mark">S</div>
      <div class="brand-name">سیگنال<b> هوش</b></div>
      <div class="live"><i></i>زنده</div>
    </div>

    <div class="title">مانیتور هوشمند <span class="hl">داده‌های ایران</span></div>
    <div class="subtitle">دلار، طلا، بورس و ارز دیجیتال، ترند جست‌وجو و اخبار، قیمت ملک و خودرو، بازار کار و پیش‌بینی — همه در یک داشبورد زنده و رایگان.</div>

    <div class="pills">${TABS.map(t => `<span class="pill">${t}</span>`).join('')}</div>

    <div class="footer">
      <div class="url">signalhoosh.site</div>
      <div class="tagline">بدون ثبت‌نام · بروزرسانی لحظه‌ای</div>
    </div>
  </div>
</body>
</html>`;

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--force-color-profile=srgb'],
  });
  try {
    const page = await browser.newPage();
    // deviceScaleFactor:1 عمداً — meta og:image:width/height سایت دقیقاً
    // 1200×630 اعلام شده و باید با ابعاد واقعی فایل یکی باشد
    await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.title');
    // نکته‌ی اصلی رفع باگ: صبر صریح تا فونت واقعاً بارگذاری و رندر شده باشد
    await page.evaluate(() => document.fonts.ready);
    // دو فریم انیمیشن یعنی حداقل یک ترسیم کامل قبل از عکس گرفتن انجام شده
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    await new Promise(r => setTimeout(r, 400));
    const out = process.argv[2] || path.join(__dirname, 'public', 'og-default.png');
    await page.screenshot({ path: out });
    console.log('✓ ساخته شد:', out, '—', fs.statSync(out).size, 'بایت');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
