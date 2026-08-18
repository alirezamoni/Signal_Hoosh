/**
 * lib/browser-lifecycle.js — explicit Chrome temp-profile ownership.
 *
 * Root cause of the 2026-08-05 outage: every crawler's safeKillBrowser() does
 * proc.kill('SIGKILL') on the Chrome process. Puppeteer normally deletes its own
 * temp --user-data-dir on process exit, but that cleanup did not fire reliably
 * under SIGKILL (child renderer/GPU processes are left orphaned holding files open
 * in the profile dir, or the exit handler simply doesn't run in time). Verified in
 * production: 1,177 orphaned /tmp/puppeteer_dev_chrome_profile-* directories, 15GB,
 * which filled the disk to 100% and took the whole site down (502s, SQLite
 * "disk is full", every crawler failing to launch Chrome at all).
 *
 * Fix: never let Puppeteer pick its own temp dir. We create it, pass it in via
 * userDataDir, and delete it ourselves after kill — so cleanup does not depend on
 * Puppeteer's internal exit handling at all.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeProfileDir(tag) {
  const dir = path.join(os.tmpdir(), `signal-chrome-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupProfileDir(dir) {
  if (!dir) return;
  // Synchronous on purpose: the async fs.rm callback form does not block, so it can
  // lose the race against the caller exiting right after safeKillBrowser() (a script
  // calling process.exit(), or PM2 sending SIGKILL on a restart) — the delete never
  // gets a chance to finish and the dir is orphaned anyway, defeating the whole fix.
  // Confirmed in production: dirs from finished crawls sitting at 0 open file handles
  // but never removed. A few hundred ms blocked once per crawl is the right trade for
  // guaranteed cleanup, given this is what filled the disk and took the site down.
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* already gone */ }
}

// Safety net: on process start, sweep profile dirs left behind by a previous crash
// (pm2 kill -9, OOM, server reboot) where the in-memory dir reference was lost.
// Anything older than 1 hour with no live Chrome holding it is assumed dead —
// normal crawls finish in minutes, so 1h is well clear of any real in-flight crawl.
function sweepStaleProfileDirs() {
  const tmp = os.tmpdir();
  let entries;
  try { entries = fs.readdirSync(tmp); } catch (e) { return; }
  const cutoff = Date.now() - 60 * 60 * 1000;
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith('signal-chrome-') && !name.startsWith('puppeteer_dev_chrome_profile-')) continue;
    const full = path.join(tmp, name);
    try {
      const st = fs.statSync(full);
      if (st.isDirectory() && st.mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true, maxRetries: 3 });
        removed++;
      }
    } catch (e) { /* already gone, or a real permission issue — either way, skip it */ }
  }
  if (removed) console.log(`[browser-lifecycle] swept ${removed} stale Chrome profile dir(s) from a previous run`);
}

/**
 * Puppeteer ۲۳ متد browser.isConnected() را برداشت و به‌جایش گتر browser.connected
 * را گذاشت. روی puppeteer ۲۵ فراخوانی قدیمی خطای «isConnected is not a function»
 * می‌دهد: در car/finance/trends که داخل try بود بی‌صدا بلعیده می‌شد و هر بار یک
 * Chrome تازه بالا می‌آمد، ولی در job/market که try نداشت کل کرال را می‌انداخت —
 * برای همین بازار کار از ۵ مرداد و کالا از ۲۱ مرداد هیچ داده‌ای ننوشته‌اند.
 * اینجا هر دو شکل پذیرفته می‌شود و اگر هیچ‌کدام نبود false برمی‌گردد، یعنی
 * مرورگر تازه ساخته می‌شود — کندتر ولی هرگز روی یک مرورگر مرده کار نمی‌کند.
 */
function isBrowserAlive(browser) {
  if (!browser) return false;
  try {
    if (typeof browser.connected === 'boolean') return browser.connected;
    if (typeof browser.isConnected === 'function') return browser.isConnected();
  } catch (e) { /* مرورگر در حال مرگ — مرده حساب کن */ }
  return false;
}

module.exports = { makeProfileDir, cleanupProfileDir, sweepStaleProfileDirs, isBrowserAlive };
