/**
 * lib/backup.js — پشتیبان کامل و قابل دانلود از پنل مدیریت
 *
 * سه تصمیم که از اندازه‌گیری واقعی این سرور آمده‌اند، نه از حدس:
 *
 * ۱. کپی ساده‌ی فایل .db در حالت WAL ناامن است — بخشی از تراکنش‌ها هنوز در
 *    فایل ‎-wal‎ است و کپی می‌تواند ناسازگار دربیاید. پس مثل backup-db.js از
 *    خودِ API بکاپ SQLite استفاده می‌شود که نویسنده‌ها را هم بلاک نمی‌کند.
 *
 * ۲. رسانه‌ها ۳٫۷ گیگابایت JPEG و WebP‌اند، یعنی از قبل فشرده. gzip روی
 *    آن‌ها روی یک سرور دوهسته‌ای فقط CPU می‌سوزاند و تقریباً هیچ بایتی کم
 *    نمی‌کند. پس آرشیو خام tar است و فقط دیتابیس‌ها داخلش gz دارند.
 *
 * ۳. آرشیو هرگز روی دیسک ساخته نمی‌شود. tar مستقیم به پاسخ HTTP لوله
 *    می‌شود. رسانه‌ها با پیوند نمادین و ‎tar -h‎ وارد آرشیو می‌شوند تا حتی
 *    یک بایت فضای موقت مصرف نشود — سرور فقط ۱۳ گیگ آزاد دارد.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');

const MEDIA_DIRS = ['news-media', 'blog-media', 'channel-photos', 'finance-media'];

// کدی که ارزش نگه‌داشتن دارد. node_modules و venv عمداً نیستند: حجیم‌اند و
// با npm install بازساخته می‌شوند. data و public جداگانه می‌آیند.
const CODE_EXCLUDES = [
  'node_modules', 'venv', '__pycache__', '.git', 'data', 'public',
  'backups', '.claude',
];

function human(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

function dirSize(p) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(p)) {
      try {
        const st = fs.statSync(path.join(p, f));
        total += st.isDirectory() ? dirSize(path.join(p, f)) : st.size;
      } catch (e) {}
    }
  } catch (e) {}
  return total;
}

/** برآورد حجم آرشیو، برای نمایش در پنل پیش از کلیک */
function estimate() {
  const dbBytes = fs.existsSync(DATA)
    ? fs.readdirSync(DATA).filter(f => f.endsWith('.db'))
        .reduce((s, f) => { try { return s + fs.statSync(path.join(DATA, f)).size; } catch (e) { return s; } }, 0)
    : 0;

  const media = {};
  let mediaBytes = 0;
  for (const d of MEDIA_DIRS) {
    const b = dirSize(path.join(PUBLIC, d));
    media[d] = b;
    mediaBytes += b;
  }

  // دیتابیس‌ها با gzip حدود ۱۵٪ حجم اصلی درمی‌آیند (از بکاپ‌های روزانه: ۴۷۹ → ۷۰ مگ)
  const dbPacked = Math.round(dbBytes * 0.15);
  return {
    dbBytes, dbPacked, mediaBytes, media,
    dataOnly: dbPacked + 2 * 1024 * 1024,
    full: dbPacked + mediaBytes + 2 * 1024 * 1024,
    // رشته‌های آماده، چون قالب به تابع human دسترسی ندارد
    dataOnlyH: human(dbPacked + 2 * 1024 * 1024),
    fullH: human(dbPacked + mediaBytes + 2 * 1024 * 1024),
    mediaH: human(mediaBytes),
  };
}

function gitCommit() {
  try { return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch (e) { return 'unknown'; }
}

function rowCounts() {
  const out = {};
  try {
    for (const f of fs.readdirSync(DATA).filter(f => f.endsWith('.db'))) {
      try {
        const db = new Database(path.join(DATA, f), { readonly: true });
        const tabs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        const per = {};
        for (const t of tabs) {
          try { per[t.name] = db.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get().c; } catch (e) {}
        }
        db.close();
        out[f] = per;
      } catch (e) {}
    }
  } catch (e) {}
  return out;
}

const RESTORE_MD = `# بازگردانی پشتیبان سیگنال هوش

این آرشیو همه‌چیزِ لازم برای بالا آوردن سایت از صفر را دارد.

## محتویات

    db/          دیتابیس‌ها (gzip). با gunzip باز می‌شوند.
    config/      settings.json، users.json، .env، ecosystem.config.js،
                 پیکربندی nginx و فهرست پروسه‌های pm2
    code/        کد برنامه (بدون node_modules و venv)
    media/       فایل‌های رسانه — فقط در «پشتیبان کامل»

## مراحل بازگردانی

    # ۱. کد و وابستگی‌ها
    mkdir -p /opt/signal && cp -r code/* /opt/signal/
    cd /opt/signal && npm install --production
    python3 -m venv venv && ./venv/bin/pip install telethon

    # ۲. دیتابیس‌ها
    mkdir -p /opt/signal/data
    for f in db/*.db.gz; do gunzip -c "$f" > "/opt/signal/data/$(basename "\${f%.gz}")"; done

    # ۳. پیکربندی — این‌ها راز دارند، دسترسی محدود کنید
    cp config/settings.json config/users.json /opt/signal/data/
    cp config/.env /opt/signal/.env
    cp config/ecosystem.config.js /opt/signal/
    chmod 600 /opt/signal/.env /opt/signal/data/settings.json

    # ۴. رسانه (اگر پشتیبان کامل است)
    mkdir -p /opt/signal/public && cp -r media/* /opt/signal/public/

    # ۵. nginx و اجرا
    cp config/nginx-signalhoosh.conf /etc/nginx/sites-available/signalhoosh
    ln -sf /etc/nginx/sites-available/signalhoosh /etc/nginx/sites-enabled/
    nginx -t && systemctl reload nginx
    cd /opt/signal && pm2 start ecosystem.config.js && pm2 save

## نکته‌ی مهم درباره‌ی تلگرام

نشست تلگرام در \`data/tg_session.session\` است و داخل پشتیبان هست. اگر روی
سرور دیگری اجرا شود ممکن است تلگرام آن را نامعتبر کند و لازم باشد دوباره با
شماره وارد شوید.

## هشدار امنیتی

\`config/.env\` و \`config/settings.json\` کلیدهای زنده دارند: OpenRouter،
توکن ربات تلگرام، JWT و راز داخلی. این آرشیو را جایی نگذارید که دیگران
دسترسی داشته باشند و در فضای ابری عمومی آپلودش نکنید.
`;

/**
 * عکس لحظه‌ای سازگار از دیتابیس‌ها و پیکربندی، در یک پوشه‌ی موقت.
 * پوشه کوچک است (~۷۰ مگ) چون دیتابیس‌ها gzip می‌شوند.
 */
async function buildSnapshot(includeMedia) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const name = `signalhoosh-backup-${stamp}${includeMedia ? '-full' : '-data'}`;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-backup-'));
  const dir = path.join(base, name);

  fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });

  const report = { databases: [], failed: [] };

  // ── دیتابیس‌ها، با API بکاپ خودِ SQLite ──
  for (const f of fs.readdirSync(DATA).filter(f => f.endsWith('.db'))) {
    const target = path.join(dir, 'db', f);
    try {
      const db = new Database(path.join(DATA, f), { readonly: true });
      await db.backup(target);
      db.close();
      const buf = fs.readFileSync(target);
      fs.writeFileSync(target + '.gz', zlib.gzipSync(buf, { level: 6 }));
      fs.unlinkSync(target);
      report.databases.push({ file: f, raw: buf.length, packed: fs.statSync(target + '.gz').size });
    } catch (e) {
      report.failed.push({ file: f, error: e.message });
      try { fs.unlinkSync(target); } catch (e2) {}
    }
  }

  // ── پیکربندی ──
  const cp = (src, dst) => { try { if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'config', dst)); } catch (e) {} };
  cp(path.join(DATA, 'settings.json'), 'settings.json');
  cp(path.join(DATA, 'users.json'), 'users.json');
  cp(path.join(ROOT, '.env'), '.env');
  cp(path.join(ROOT, 'ecosystem.config.js'), 'ecosystem.config.js');
  cp('/etc/nginx/sites-available/signalhoosh', 'nginx-signalhoosh.conf');
  try {
    fs.writeFileSync(path.join(dir, 'config', 'pm2-list.json'),
      execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 20000 }));
  } catch (e) {}

  // ── کد ــ کوچک است (~۱٫۷ مگ) و همیشه می‌آید ──
  // با لوله‌ی tar کپی می‌شود نه rsync: کپیِ با استثنا را بدون وابستگی تازه
  // انجام می‌دهد و tar روی این سرور قطعاً هست.
  try {
    const codeDir = path.join(dir, 'code');
    fs.mkdirSync(codeDir, { recursive: true });
    const ex = CODE_EXCLUDES.map(x => '--exclude=' + x).join(' ');
    execFileSync('sh', ['-c',
      `tar -cf - ${ex} -C ${JSON.stringify(ROOT)} . | tar -xf - -C ${JSON.stringify(codeDir)}`
    ], { timeout: 180000 });
  } catch (e) {
    report.codeError = e.message;
  }

  // ── رسانه: پیوند نمادین، نه کپی. tar -h دنبالش می‌رود. ──
  if (includeMedia) {
    fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
    for (const d of MEDIA_DIRS) {
      const src = path.join(PUBLIC, d);
      if (fs.existsSync(src)) {
        try { fs.symlinkSync(src, path.join(dir, 'media', d)); } catch (e) {}
      }
    }
  }

  // ── مانیفست ──
  const est = estimate();
  const manifest = [
    'پشتیبان سیگنال هوش',
    '='.repeat(40),
    'ساخته‌شده  : ' + new Date().toISOString(),
    'نوع        : ' + (includeMedia ? 'کامل (با رسانه)' : 'فقط داده'),
    'کامیت گیت  : ' + gitCommit(),
    'میزبان     : ' + os.hostname(),
    '',
    'دیتابیس‌ها:',
    ...report.databases.map(d => `  ${d.file.padEnd(20)} ${human(d.raw).padStart(10)} → ${human(d.packed)}`),
    ...(report.failed.length ? ['', 'ناموفق:', ...report.failed.map(f => `  ${f.file}: ${f.error}`)] : []),
    '',
    'رسانه:',
    ...MEDIA_DIRS.map(d => `  ${d.padEnd(20)} ${human(est.media[d] || 0)}` + (includeMedia ? '' : '  (در این پشتیبان نیست)')),
    '',
    'تعداد ردیف‌ها:',
    ...Object.entries(rowCounts()).map(([f, t]) =>
      `  ${f}\n` + Object.entries(t).map(([k, v]) => `      ${k}: ${v}`).join('\n')),
    '',
    'برای بازگردانی، RESTORE.md را بخوانید.',
  ].join('\n');

  fs.writeFileSync(path.join(dir, 'MANIFEST.txt'), manifest);
  fs.writeFileSync(path.join(dir, 'RESTORE.md'), RESTORE_MD);

  return { base, dir, name, report };
}

/**
 * آرشیو را مستقیم به پاسخ HTTP لوله می‌کند.
 * هیچ فایل موقتی از آرشیو ساخته نمی‌شود؛ فقط عکس دیتابیس‌ها (~۷۰ مگ).
 */
async function streamArchive(res, opts, req) {
  const includeMedia = !!(opts && opts.full);
  const snap = await buildSnapshot(includeMedia);

  const cleanup = () => {
    try { fs.rmSync(snap.base, { recursive: true, force: true }); } catch (e) {}
  };

  res.setHeader('Content-Type', 'application/x-tar');
  res.setHeader('Content-Disposition', `attachment; filename="${snap.name}.tar"`);
  res.setHeader('Cache-Control', 'no-store');
  // بدون این، nginx کل آرشیو را روی دیسک بافر می‌کند
  res.setHeader('X-Accel-Buffering', 'no');

  // ‎-h‎ پیوندهای نمادین رسانه را دنبال می‌کند؛ بدون آن فقط خودِ لینک
  // در آرشیو می‌نشیند و پشتیبان عملاً خالی از رسانه می‌شود.
  const tar = spawn('tar', ['-hcf', '-', '-C', snap.base, snap.name], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  tar.stderr.on('data', d => { stderr += d.toString().slice(0, 2000); });

  tar.stdout.pipe(res);

  tar.on('close', code => {
    cleanup();
    if (code !== 0) console.warn('[backup] tar کد', code, stderr.slice(0, 300));
    else console.log(`[backup] ${snap.name} کامل ارسال شد`);
  });

  tar.on('error', e => {
    console.error('[backup] اجرای tar ناموفق:', e.message);
    cleanup();
    if (!res.headersSent) res.status(500).end('خطا در ساخت پشتیبان');
  });

  // ⚠️ اگر کاربر دانلود را نیمه‌کاره رها کند، tar باید کشته شود؛ وگرنه
  // ۳٫۷ گیگابایت رسانه را برای هیچ می‌خواند و CPU و I/O سرور را می‌گیرد.
  // آزمایش نشان داد فقط res.on('close') کافی نیست — گاهی tar زنده می‌ماند.
  // پس هم به قطع اتصال گوش می‌دهیم هم SIGKILL پشتیبان می‌گذاریم.
  let done = false;
  const kill = () => {
    if (done || tar.exitCode !== null) return;
    done = true;
    try { tar.stdout.unpipe(res); tar.stdout.destroy(); } catch (e) {}
    try { tar.kill('SIGTERM'); } catch (e) {}
    setTimeout(() => {
      if (tar.exitCode === null) { try { tar.kill('SIGKILL'); } catch (e) {} }
    }, 3000).unref();
    console.log('[backup] دانلود نیمه‌کاره رها شد — tar متوقف شد');
  };

  tar.on('close', () => { done = true; });
  res.on('close', () => { if (!res.writableFinished) kill(); });
  if (req) { req.on('aborted', kill); req.on('close', () => { if (!res.writableFinished) kill(); }); }

  return snap.name;
}

module.exports = { streamArchive, estimate, buildSnapshot, human, MEDIA_DIRS };
