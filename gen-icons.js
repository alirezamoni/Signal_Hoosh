/**
 * gen-icons.js — آیکون‌های PWA از همان نشانِ فاوآیکون سایت.
 *
 * چرا پاپیتیر: هیچ کتابخانه‌ی تصویری (sharp/canvas/resvg) روی این سرور نصب
 * نیست و برای چهار فایلِ یک‌بارمصرف ارزش افزودن وابستگی را ندارد. فونت مثل
 * gen-og.js به‌صورت base64 جاسازی می‌شود تا بدون فونت سیستمی هم درست رندر شود.
 *
 * نسخه‌ی maskable پس‌زمینه‌ی توپر و ۱۹٪ حاشیه دارد، چون اندروید آیکون را
 * داخل ماسک دایره/سنگ‌قبری می‌برد و نشانِ لبه‌تالبه بریده می‌شود.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const FONT = fs.readFileSync(
  path.join(__dirname, 'public', 'assets', 'fonts', 'IRANSansWeb_Bold.woff2')
).toString('base64');

function html(size, maskable) {
  const pad = maskable ? Math.round(size * 0.19) : 0;
  const box = size - pad * 2;
  const radius = Math.round(box * 0.22);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
@font-face{font-family:'IS';src:url(data:font/woff2;base64,${FONT}) format('woff2');font-weight:700;}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${size}px;height:${size}px;overflow:hidden}
body{background:${maskable ? '#050505' : 'transparent'};display:flex;align-items:center;justify-content:center}
.m{width:${box}px;height:${box}px;border-radius:${radius}px;
   background:linear-gradient(135deg,#4f83f7 0%,#9b7cfc 100%);
   display:flex;align-items:center;justify-content:center;
   font-family:'IS',system-ui,sans-serif;font-weight:700;color:#fff;
   font-size:${Math.round(box * 0.54)}px;line-height:1;
   padding-bottom:${Math.round(box * 0.04)}px;}
</style></head><body><div class="m">S</div></body></html>`;
}

const JOBS = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true]
];

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--force-color-profile=srgb']
  });
  try {
    const page = await browser.newPage();
    for (const j of JOBS) {
      const name = j[0], size = j[1], maskable = j[2];
      await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
      await page.setContent(html(size, maskable), { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      const outp = path.join(__dirname, 'public', name);
      await page.screenshot({ path: outp, omitBackground: !maskable });
      console.log('OK  ' + name + '  ' + fs.statSync(outp).size + ' bytes');
    }
  } finally { await browser.close(); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
