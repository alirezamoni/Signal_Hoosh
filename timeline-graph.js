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

function discoverEdge(fromNode, toNode, regime) {
  // last 14 days of events on each node (timeline events persist long-term)
  const fromEvents = tdb.getEventsSince(14 * 24 * 60, fromNode);
  const toEvents = tdb.getEventsSince(14 * 24 * 60, toNode);
  if (fromEvents.length < 3 || toEvents.length < 3) return null;

  const toSorted = toEvents
    .map(e => [new Date(e.detected_at).getTime(), e])
    .sort((a, b) => a[0] - b[0]);

  const MAX_LAG = 240; // minutes
  const STEP = 5;
  const lagBins = {}; // bucket -> {hits, sevList, magList, lags}

  for (const fe of fromEvents) {
    const t0 = new Date(fe.detected_at).getTime();
    const idx = lowerBound(toSorted, t0); // first to-event at/after t0
    for (let i = idx; i < toSorted.length; i++) {
      const [tt, te] = toSorted[i];
      const lag = (tt - t0) / 60000;
      if (lag < 0) continue;
      if (lag > MAX_LAG) break; // sorted ascending -> safe to break
      const bucket = Math.round(lag / STEP) * STEP;
      const b = lagBins[bucket] || (lagBins[bucket] = { hits: 0, sevList: [], magList: [], lags: [] });
      b.hits++;
      b.sevList.push(fe.severity || 0);
      b.magList.push(te.magnitude || 0);
      b.lags.push(lag);
    }
  }

  // pick best bucket by hit-rate
  let best = null;
  for (const bucket in lagBins) {
    const b = lagBins[bucket];
    const rate = b.hits / fromEvents.length;
    if (!best || rate > best.rate) best = { bucket: Number(bucket), rate, b };
  }
  if (!best) return null;

  const reliability = clamp(best.rate, 0, 1);
  const lags = best.b.lags;
  const mean = lags.reduce((a, x) => a + x, 0) / lags.length;
  const variance = lags.reduce((a, x) => a + (x - mean) ** 2, 0) / lags.length;
  const std = Math.sqrt(variance);
  const corr = pearson(best.b.sevList, best.b.magList);

  // store even weak edges (so learning can strengthen them); skip only truly empty
  if (fromEvents.length < tdb.getWeight('MIN_SAMPLES', 5) && reliability < 0.2) return null;

  tdb.upsertEdge({
    from_node: fromNode, to_node: toNode, topic: null, regime,
    lead_time_min: best.bucket, lead_time_std: std, reliability,
    correlation: corr, sample_count: fromEvents.length, last_confirmed: nowIso(),
  });

  // promote winning edges to leading_indicators
  if (reliability >= tdb.getWeight('edge_min_reliability', 0.55) && fromEvents.length >= tdb.getWeight('MIN_SAMPLES', 5)) {
    tdb.upsertIndicator({
      indicator: fromNode, target: toNode, regime,
      lead_time_min: best.bucket, accuracy: reliability, correlation: corr, sample_count: fromEvents.length,
    });
  }
  return { from_node: fromNode, to_node: toNode, lead_time_min: best.bucket, reliability, correlation: corr, sample_count: fromEvents.length };
}

function runDiscovery() {
  const regimes = ['normal'];
  const cur = tdb.getCurrentRegime();
  if (cur && cur.regime && cur.regime !== 'normal') regimes.push(cur.regime);
  let found = 0;
  for (const from of FROM_NODES) {
    for (const to of TO_NODES) {
      for (const regime of regimes) {
        try { if (discoverEdge(from, to, regime)) found++; } catch (e) { /* continue */ }
      }
    }
  }
  // also topic-specific edges for top recent topics
  try {
    const recent = tdb.getEventsSince(60 * 24 * 14, 'news');
    const topics = {};
    for (const e of recent) if (e.topic) topics[e.topic] = (topics[e.topic] || 0) + 1;
    const topTopics = Object.entries(topics).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
    for (const topic of topTopics) {
      for (const to of TO_NODES) {
        try { discoverTopicEdge(topic, to, 'normal'); } catch (e) {}
      }
    }
  } catch (e) {}
  console.log(`[tl-graph] discovery: ${found} edges updated`);
  return found;
}

// topic-specific edge: news events on a topic -> finance target
function discoverTopicEdge(topic, toNode, regime) {
  const fromEvents = tdb.getEventsSince(14 * 24 * 60, 'news').filter(e => e.topic === topic);
  const toEvents = tdb.getEventsSince(14 * 24 * 60, toNode);
  if (fromEvents.length < 3 || toEvents.length < 3) return null;
  const toSorted = toEvents.map(e => [new Date(e.detected_at).getTime(), e]).sort((a, b) => a[0] - b[0]);
  const MAX_LAG = 240, STEP = 5;
  const lagBins = {};
  for (const fe of fromEvents) {
    const t0 = new Date(fe.detected_at).getTime();
    const idx = lowerBound(toSorted, t0);
    for (let i = idx; i < toSorted.length; i++) {
      const [tt, te] = toSorted[i];
      const lag = (tt - t0) / 60000;
      if (lag < 0) continue;
      if (lag > MAX_LAG) break;
      const bucket = Math.round(lag / STEP) * STEP;
      const b = lagBins[bucket] || (lagBins[bucket] = { hits: 0, sevList: [], magList: [], lags: [] });
      b.hits++; b.sevList.push(fe.severity || 0); b.magList.push(te.magnitude || 0); b.lags.push(lag);
    }
  }
  let best = null;
  for (const bucket in lagBins) { const b = lagBins[bucket]; const rate = b.hits / fromEvents.length; if (!best || rate > best.rate) best = { bucket: Number(bucket), rate, b }; }
  if (!best) return null;
  const reliability = clamp(best.rate, 0, 1);
  const corr = pearson(best.b.sevList, best.b.magList);
  const lags = best.b.lags;
  const mean = lags.reduce((a, x) => a + x, 0) / lags.length;
  const std = Math.sqrt(lags.reduce((a, x) => a + (x - mean) ** 2, 0) / lags.length);
  tdb.upsertEdge({
    from_node: 'news', to_node: toNode, topic, regime,
    lead_time_min: best.bucket, lead_time_std: std, reliability, correlation: corr,
    sample_count: fromEvents.length, last_confirmed: nowIso(),
  });
  return true;
}

// Graph data for the frontend signal-graph section
function getGraphData() {
  const edges = tdb.getUsableEdges().concat(tdb.getEdges().filter(e => !tdb.getUsableEdges().includes(e)));
  const allEdges = tdb.getEdges();
  const nodeSet = new Set();
  for (const e of allEdges) { nodeSet.add(e.from_node); nodeSet.add(e.to_node); }
  // also always include core nodes so graph isn't empty
  [...FROM_NODES, ...TO_NODES].forEach(n => nodeSet.add(n));

  const nodes = [...nodeSet].map(id => {
    const meta = NODE_META[id] || { label: id, color: '#7c8db5' };
    // node reliability = max reliability of edges touching it, or source default
    const touching = allEdges.filter(e => e.from_node === id || e.to_node === id);
    const maxRel = touching.length ? Math.max(...touching.map(e => e.reliability || 0)) : 0.5;
    return {
      id, label: meta.label, color: meta.color,
      reliability: maxRel,
      size: 20 + maxRel * 30,
    };
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

module.exports = { runDiscovery, discoverEdge, discoverTopicEdge, getGraphData, NODE_META, FROM_NODES, TO_NODES, pearson };
