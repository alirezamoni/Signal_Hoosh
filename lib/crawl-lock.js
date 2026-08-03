/**
 * lib/crawl-lock.js — serializes Puppeteer crawls across the whole process.
 *
 * Four independent crawlers (trend, market, job, finance) each launch their own
 * Chrome. On this 2-core / 3.8GB VPS, two or three overlapping launches starve
 * each other: a finance crawl that takes ~19s alone was blowing its 45s budget
 * when it overlapped the trend crawl, so it failed 4 times and the backoff guard
 * then skipped it entirely. Running them one at a time is both faster overall
 * and far lighter on RAM.
 *
 * A crawl that overruns maxHoldMs releases the lock to the next waiter — the
 * slow one still finishes on its own, we just stop blocking everyone behind it.
 */
let chain = Promise.resolve();

function withCrawlLock(name, fn, maxHoldMs = 5 * 60 * 1000) {
  const result = chain.then(async () => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      const held = Date.now() - t0;
      if (held > 60000) console.log(`[crawl-lock] ${name} held the lock ${Math.round(held / 1000)}s`);
    }
  });

  // Next waiter starts after this one finishes OR after maxHoldMs, whichever comes
  // first, so a single wedged crawl can never block the queue indefinitely.
  chain = Promise.race([
    result.catch(() => {}),
    new Promise(r => setTimeout(r, maxHoldMs)),
  ]);

  return result;
}

module.exports = { withCrawlLock };
