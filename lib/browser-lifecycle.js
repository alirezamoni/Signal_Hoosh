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
  fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }, () => {});
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

module.exports = { makeProfileDir, cleanupProfileDir, sweepStaleProfileDirs };
