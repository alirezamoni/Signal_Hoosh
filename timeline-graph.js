/**
 * timeline-graph.js — Lead/lag discovery + signal_edges + leading_indicators (§6)
 *
 * The system DISCOVERS which signal leads which, by how much lag, with what
 * reliability — it never assumes News→Trend→Finance. runDiscovery() runs every
 * 30 min and during backtest, cross-correlating node event streams.
 */
const tdb = require('./timeline-db');

const FROM_NODES = ['news', 'trend', 'poly', 'fin_tg'];
const TO_NODES = ['usd', 'coin', 'gold18', 'tether', 'bitcoin', 'oil_brent', 'stock_market', 'mesghal', 'ounce'];

const NODE_META = {
  news:   { label: 'اخبار',      color: '#f05252' },
  trend:  { label: 'جستجو',      color: '#4f83f7' },
  poly:   { label: 'پلی‌مارکت',  color: '#9b7cfc' },
  fin_tg: { label: 'تلگرام قیمت', color: '#0fd17a' },
  usd:    { label: 'دلار',       color: '#22d3ee' },
  coin:   { label: 'سکه',        color: '#f5a623' },
  gold18: { label: 'طلا',        color: '#f5a623' },
  tether: { label: 'تتر',        color: '#22d3ee' },
  bitcoin:{ label: 'بیت‌کوین',    color: '#f472b6' },
  oil_brent: { label: 'نفت',     color: '#f5a623' },
  stock_market: { label: 'بورس', color: '#9b7cfc' },
  mesghal:{ label: 'مثقال',      color: '#f5a623' },
  ounce:  { label: 'انس',        color: '#f5a623' },
};

function nowIso() { return new Date().toISOString(); }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  const den = Math.sqrt(da * db);
  return den ? num / den : 0;
}

// binary search lower bound for ts in sorted array
function lowerBound(arr, ts) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid][0] < ts) lo = mid + 1; else hi = mid; }
  return lo;
}

// Significance threshold for a to_node move. Routine ticks must NOT count as
// "the market reacted". With a small sample, raising the bar to the median would
// discard half of already-scarce data, so the median is only used once we have
// enough events to estimate it meaningfully.
function significanceThreshold(events) {
  const mags = events.map(e => Math.abs(e.magnitude || 0)).filter(m => m > 0).sort((a, b) => a - b);
  if (!mags.length) return 0.3;
  if (mags.length < 20) return 0.3; // floor only — keep the sample usable
  const median = mags[Math.floor(mags.length / 2)];
  return Math.max(median, 0.3);
}

// Does a significant to-event exist in [lo, hi]? Returns it or null.
function findInRange(toSorted, lo, hi) {
  let i = lowerBound(toSorted, lo);
  if (i < toSorted.length && toSorted[i][0] <= hi) return toSorted[i][1];
  return null;
}

// CHANCE LEVEL: probability that a random window of the same width contains a
// significant to-event. Without this, a target that moves constantly (oil scraped
// every 60s) looks perfectly "caused" by anything. This is the anti-spurious core.
function estimateBaseRate(toSorted, widthMin, spanStart, spanEnd, samples) {
  if (spanEnd - spanStart <= widthMin * 60000) return 1;
  let hit = 0, n = samples || 300;
  for (let i = 0; i < n; i++) {
    const t = spanStart + Math.random() * (spanEnd - spanStart - widthMin * 60000);
    if (findInRange(toSorted, t, t + widthMin * 60000)) hit++;
  }
  return hit / n;
}

// DIRECTIONAL SKILL: a target that rises 90% of the time anyway makes "100% up
// after the cause" nearly meaningless. Compare the conditional up-share against
// the target's UNCONDITIONAL up-share and return the excess, in [-1,1].
function directionalSkill(up, down, toEvents) {
  const condTotal = up + down;
  if (!condTotal) return 0;
  const condUp = up / condTotal;
  const baseUpCount = toEvents.filter(e => e.direction === 'up').length;
  const baseTotal = toEvents.filter(e => e.direction === 'up' || e.direction === 'down').length;
  if (!baseTotal) return 0;
  const baseUp = baseUpCount / baseTotal;
  if (condUp >= baseUp) {
    return baseUp >= 1 ? 0 : (condUp - baseUp) / (1 - baseUp);
  }
  return baseUp <= 0 ? 0 : -((baseUp - condUp) / baseUp);
}

const WINDOW_MIN = 14 * 24 * 60; // observation window: 14 days
const HALF = 15;                 // ± minutes tolerance around a lag bucket
const MAX_LAG = 240;
const STEP = 5;

function discoverEdge(fromNode, toNode, regime, topicFilter) {
  let fromEvents = tdb.getEventsSince(WINDOW_MIN, fromNode);
  if (topicFilter) fromEvents = fromEvents.filter(e => e.topic === topicFilter);
  const toAll = tdb.getEventsSince(WINDOW_MIN, toNode);
  const minSamples = tdb.getWeight('MIN_SAMPLES', 5);
  if (fromEvents.length < minSamples || toAll.length < 3) return null;

  // keep only SIGNIFICANT target moves
  const thr = significanceThreshold(toAll);
  const toEvents = toAll.filter(e => Math.abs(e.magnitude || 0) >= thr);
  if (toEvents.length < 3) return null;

  const toSorted = toEvents
    .map(e => [new Date(e.detected_at).getTime(), e])
    .sort((a, b) => a[0] - b[0]);

  // observed span (used for the chance-level estimate)
  const allTimes = [...fromEvents.map(e => new Date(e.detected_at).getTime()), ...toSorted.map(x => x[0])];
  // observation span: first event seen on either stream through now
  const spanStart = Math.min(...allTimes), spanEnd = Math.max(Math.max(...allTimes), Date.now());
  const baseRate = estimateBaseRate(toSorted, 2 * HALF, spanStart, spanEnd, 400);
  if (baseRate >= 0.98) return null; // target moves almost always -> no information possible

  // For each lag bucket count DISTINCT from-events that were followed by a significant move
  const bins = {};
  for (const fe of fromEvents) {
    const t0 = new Date(fe.detected_at).getTime();
    for (let L = STEP; L <= MAX_LAG; L += STEP) {
      const lo = t0 + (L - HALF) * 60000;
      const hi = t0 + (L + HALF) * 60000;
      const found = findInRange(toSorted, lo, hi);
      if (!found) continue;
      const b = bins[L] || (bins[L] = { fromHits: 0, up: 0, down: 0, lags: [] });
      b.fromHits++; // one per from-event per bucket -> hitRate can never exceed 1
      if (found.direction === 'up') b.up++; else if (found.direction === 'down') b.down++;
      b.lags.push((new Date(found.detected_at).getTime() - t0) / 60000);
    }
  }

  // best bucket by SKILL over chance, not raw hit-rate
  let best = null;
  for (const L in bins) {
    const b = bins[L];
    const hitRate = b.fromHits / fromEvents.length;
    const skill = (hitRate - baseRate) / (1 - baseRate); // Peirce-style skill score
    if (!best || skill > best.skill) best = { bucket: Number(L), hitRate, skill, b };
  }
  if (!best || best.skill <= 0.15) return null; // reject spurious / no-better-than-chance edges

  const reliability = clamp(best.skill, 0, 0.9); // never claim certainty
  const lags = best.b.lags;
  const mean = lags.reduce((a, x) => a + x, 0) / lags.length;
  const std = Math.sqrt(lags.reduce((a, x) => a + (x - mean) ** 2, 0) / lags.length);
  // directional bias measured as EXCESS over the target's unconditional direction split
  const dirBias = directionalSkill(best.b.up, best.b.down, toEvents);

  tdb.upsertEdge({
    from_node: fromNode, to_node: toNode, topic: topicFilter || null, regime,
    lead_time_min: best.bucket, lead_time_std: std, reliability,
    correlation: dirBias, sample_count: fromEvents.length, last_confirmed: nowIso(),
  });

  if (reliability >= tdb.getWeight('edge_min_reliability', 0.55) && fromEvents.length >= minSamples) {
    tdb.upsertIndicator({
      indicator: fromNode, target: toNode, regime,
      lead_time_min: best.bucket, accuracy: reliability, correlation: dirBias, sample_count: fromEvents.length,
    });
  }
  return { from_node: fromNode, to_node: toNode, lead_time_min: best.bucket, reliability, correlation: dirBias, sample_count: fromEvents.length, base_rate: baseRate, hit_rate: best.hitRate };
}

function runDiscovery() {
  const regimes = ['normal'];
  const cur = tdb.getCurrentRegime();
  if (cur && cur.regime && cur.regime !== 'normal') regimes.push(cur.regime);
  let found = 0, rejected = 0;
  for (const from of FROM_NODES) {
    for (const to of TO_NODES) {
      for (const regime of regimes) {
        try { if (discoverEdge(from, to, regime)) found++; else rejected++; } catch (e) { rejected++; }
      }
    }
  }
  // category-level edges (e.g. 'war' -> usd). Categories repeat, so samples accumulate.
  try {
    const recent = tdb.getEventsSince(WINDOW_MIN, 'news');
    const cats = {};
    for (const e of recent) {
      const c = tdb.categorizeTopic(e.topic);
      if (c && c !== 'general') cats[c] = (cats[c] || 0) + 1;
    }
    const topCats = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c]) => c);
    for (const cat of topCats) {
      for (const to of TO_NODES) {
        for (const regime of regimes) {
          try { if (discoverCategoryEdge(cat, to, regime)) found++; } catch (e) {}
        }
      }
    }
  } catch (e) {}
  console.log(`[tl-graph] discovery: ${found} edges kept, ${rejected} rejected as chance-level`);
  return found;
}

// category-level edge: news events whose topic maps to `category` -> finance target
function discoverCategoryEdge(category, toNode, regime) {
  const all = tdb.getEventsSince(WINDOW_MIN, 'news');
  const fromEvents = all.filter(e => tdb.categorizeTopic(e.topic) === category);
  const minSamples = tdb.getWeight('MIN_SAMPLES', 5);
  if (fromEvents.length < minSamples) return null;

  const toAll = tdb.getEventsSince(WINDOW_MIN, toNode);
  if (toAll.length < 3) return null;
  const thr = significanceThreshold(toAll);
  const toEvents = toAll.filter(e => Math.abs(e.magnitude || 0) >= thr);
  if (toEvents.length < 3) return null;
  const toSorted = toEvents.map(e => [new Date(e.detected_at).getTime(), e]).sort((a, b) => a[0] - b[0]);

  const allTimes = [...fromEvents.map(e => new Date(e.detected_at).getTime()), ...toSorted.map(x => x[0])];
  // observation span: first event seen on either stream through now
  const spanStart = Math.min(...allTimes), spanEnd = Math.max(Math.max(...allTimes), Date.now());
  const baseRate = estimateBaseRate(toSorted, 2 * HALF, spanStart, spanEnd, 400);
  if (baseRate >= 0.98) return null;

  const bins = {};
  for (const fe of fromEvents) {
    const t0 = new Date(fe.detected_at).getTime();
    for (let L = STEP; L <= MAX_LAG; L += STEP) {
      const found = findInRange(toSorted, t0 + (L - HALF) * 60000, t0 + (L + HALF) * 60000);
      if (!found) continue;
      const b = bins[L] || (bins[L] = { fromHits: 0, up: 0, down: 0, lags: [] });
      b.fromHits++;
      if (found.direction === 'up') b.up++; else if (found.direction === 'down') b.down++;
      b.lags.push((new Date(found.detected_at).getTime() - t0) / 60000);
    }
  }
  let best = null;
  for (const L in bins) {
    const b = bins[L];
    const hitRate = b.fromHits / fromEvents.length;
    const skill = (hitRate - baseRate) / (1 - baseRate);
    if (!best || skill > best.skill) best = { bucket: Number(L), skill, b };
  }
  if (!best || best.skill <= 0.15) return null;

  const reliability = clamp(best.skill, 0, 0.9);
  const lags = best.b.lags;
  const mean = lags.reduce((a, x) => a + x, 0) / lags.length;
  const std = Math.sqrt(lags.reduce((a, x) => a + (x - mean) ** 2, 0) / lags.length);
  const dirBias = directionalSkill(best.b.up, best.b.down, toEvents);

  tdb.upsertEdge({
    from_node: 'news', to_node: toNode, topic: category, regime,
    lead_time_min: best.bucket, lead_time_std: std, reliability, correlation: dirBias,
    sample_count: fromEvents.length, last_confirmed: nowIso(),
  });
  return true;
}

// Graph data for the frontend signal-graph section
function getGraphData() {
  const allEdges = tdb.getEdges();
  const nodeSet = new Set();
  for (const e of allEdges) { nodeSet.add(e.from_node); nodeSet.add(e.to_node); }
  // also always include core nodes so graph isn't empty
  [...FROM_NODES, ...TO_NODES].forEach(n => nodeSet.add(n));

  const nodes = [...nodeSet].map(id => {
    const meta = NODE_META[id] || { label: id, color: '#7c8db5' };
    const touching = allEdges.filter(e => e.from_node === id || e.to_node === id);
    const maxRel = touching.length ? Math.max(...touching.map(e => e.reliability || 0)) : 0.5;
    return { id, label: meta.label, color: meta.color, reliability: maxRel, size: 20 + maxRel * 30 };
  });

  const edgeList = allEdges
    .filter(e => (e.reliability || 0) > 0)
    .map(e => ({
      from: e.from_node, to: e.to_node, topic: e.topic, regime: e.regime,
      lead: e.lead_time_min, reliability: e.reliability, correlation: e.correlation,
      samples: e.sample_count,
    }));

  return { nodes, edges: edgeList };
}

module.exports = { runDiscovery, discoverEdge, discoverCategoryEdge, getGraphData, significanceThreshold, estimateBaseRate, NODE_META, FROM_NODES, TO_NODES, pearson };
