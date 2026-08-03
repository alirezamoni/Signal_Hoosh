/**
 * timeline-predict.js — Ensemble (A historical / B similarity / C LLM) + Bayesian
 * updating + attribution + calibrated confidence (§8).
 *
 * A prediction is a LIVING probability: every new graph-connected event revises it
 * (prediction_updates) until its horizon closes. Confidence shown to the user is
 * ALWAYS calibrated (Platt / isotonic) — raw confidence is internal only (§8.6, pitfall 10).
 */
const tdb = require('./timeline-db');
const ai = require('./timeline-ai');

const TO_NODES = ['usd', 'coin', 'gold18', 'tether', 'bitcoin', 'oil_brent', 'stock_market', 'mesghal', 'ounce'];
const HORIZONS = [3, 12, 24];
const SYMBOL_LABEL = {
  usd: 'دلار', coin: 'سکه', gold18: 'طلای ۱۸', tether: 'تتر', bitcoin: 'بیت‌کوین',
  oil_brent: 'نفت', stock_market: 'بورس', mesghal: 'مثقال', ounce: 'انس',
};

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// ±40% band around the point estimate. Must use min/max, not [pct*0.6, pct*1.4]:
// for a negative pct that ordering flips (-0.6 > -1.4) and NO outcome can ever fall
// inside the band, so magnitude_in_range scored 0 on every bearish prediction.
function pctRange(pct) {
  const a = pct * 0.6, b = pct * 1.4;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

// `magnitude` is NOT a common unit across event types: news_wave stores an article
// count (3..303), trend_spike a search-growth percent (50..1000), fin_tg sometimes a
// raw price. Only price_move events on a real finance symbol carry something that is
// actually a price-change percentage and can be blended into predicted_pct.
function magnitudeAsPricePct(event) {
  if (!event || event.event_type !== 'price_move') return null;
  if (!TO_NODES.includes(event.node_key)) return null;
  const m = Number(event.magnitude);
  return Number.isFinite(m) ? m : null;
}
function median(arr) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function nowIso() { return new Date().toISOString(); }

function currentPrice(target) {
  try { const r = require('./finance-db').getLatestBySymbol(target); return r && r.price ? r.price : null; } catch (e) { return null; }
}

// ════════════════════════════════════════════════════════
//  SUB-MODELS
// ════════════════════════════════════════════════════════

// Model A — Historical / Pattern (counterfactual-adjusted)
// `topic` is expected to be a CATEGORY (see tdb.categorizeTopic) so samples accumulate.
function patternModel(target, horizon, regime, topic) {
  const cat = tdb.categorizeTopic(topic);
  let p = tdb.getPattern(cat, target, horizon, regime) || tdb.getPattern(cat, target, horizon, 'normal');
  if (!p) { p = (tdb.getPatternsForTopic(cat, target, regime) || [])[0]; }
  if (!p) return null;
  const conf = (p.reliability || 0) * Math.min((p.sample_count || 0) / 10, 1);
  const drift = p.concept_drift_score || 0;
  return {
    direction: p.outcome_dir || 'up', pct: p.outcome_pct || 0,
    confidence: conf * (1 - drift), sample_count: p.sample_count || 0,
  };
}

// Model B — Similarity (nearest historical chains, matched by category)
function similarityModel(target, horizon, regime, topic) {
  const cat = tdb.categorizeTopic(topic);
  const chains = (tdb.getChains(null, 300) || []).filter(c => tdb.categorizeTopic(c.topic) === cat && (c.regime === regime || c.regime === 'normal'));
  const chainIds = new Set(chains.map(c => c.id));
  const preds = (tdb.getPredictions('validated', null, 300) || []).filter(p => chainIds.has(p.chain_id) && p.target === target && p.time_horizon === horizon);
  const vals = preds.map(p => tdb.getValidation(p.id)).filter(Boolean);
  if (!vals.length) return null;
  const excess = vals.map(v => v.excess_pct || 0);
  const dirUp = excess.filter(x => x > 0).length;
  const dirDown = excess.filter(x => x < 0).length;
  let direction = 'flat';
  if (dirUp > dirDown) direction = 'up';
  else if (dirDown > dirUp) direction = 'down';
  const med = median(excess);
  const agreement = Math.max(dirUp, dirDown) / vals.length;
  const sufficiency = Math.min(vals.length / 5, 1);
  return { direction, pct: med, confidence: agreement * sufficiency, sample_count: vals.length };
}

// Model C — LLM Reasoning (structured)
async function llmModel(chain, target, horizon, regime, A, B) {
  const prompt = `زنجیره فعلی: ${chain.ai_analysis || chain.title || '—'}
مدل A (الگوی تاریخی): ${A ? JSON.stringify({ direction: A.direction, pct: +(A.pct || 0).toFixed(2), confidence: +(A.confidence || 0).toFixed(2) }) : 'نامشخص'}
مدل B (رویدادهای مشابه): ${B ? JSON.stringify({ direction: B.direction, pct: +(B.pct || 0).toFixed(2), confidence: +(B.confidence || 0).toFixed(2) }) : 'نامشخص'}
رژیم فعلی: ${regime}
نماد هدف: ${SYMBOL_LABEL[target] || target} | افق: ${horizon} ساعت

فقط JSON برگردان:
{"direction":"up|down|flat","pct":عدد,"confidence":0.0-1.0,"key_reason":"دلیل اصلی فارسی"}`;
  try {
    const r = await ai.callStructured(prompt);
    if (!r) return null;
    return { direction: r.direction || 'flat', pct: Number(r.pct) || 0, confidence: clamp(Number(r.confidence) || 0, 0, 1), reason: r.key_reason || '' };
  } catch (e) { return null; }
}

// ════════════════════════════════════════════════════════
//  MODEL D — DOMAIN PRIOR  (cold-start only)
// ════════════════════════════════════════════════════════
// Everything above is learned from data. With only a handful of validations the
// learned models are noise: production was publishing "دلار ▼ احتمال نزول" during
// a `war` regime off a SINGLE historical sample with reliability 0, which is the
// opposite of how the Iranian market actually behaves under conflict.
//
// This is a documented domain prior, NOT a discovered pattern. It only fires when
// the learned models have nothing to say, its confidence is capped low, and the
// API labels it so the UI can mark it as a prior rather than a learned signal.
const REGIME_PRIORS = {
  war:              { usd: 'up', gold18: 'up', coin: 'up', mesghal: 'up', ounce: 'up', oil_brent: 'up', stock_market: 'down' },
  sanctions:        { usd: 'up', gold18: 'up', coin: 'up', mesghal: 'up', tether: 'up' },
  currency_crisis:  { usd: 'up', gold18: 'up', coin: 'up', mesghal: 'up', tether: 'up' },
  oil_shock:        { oil_brent: 'up', usd: 'up' },
};
const PRIOR_CONFIDENCE = 0.30;   // deliberately low — this is a heuristic, not evidence
const PRIOR_PCT = { up: 0.8, down: -0.8 };

function priorModel(target, regime) {
  const dir = (REGIME_PRIORS[regime] || {})[target];
  if (!dir) return null;
  return {
    direction: dir,
    pct: PRIOR_PCT[dir] || 0,
    confidence: PRIOR_CONFIDENCE,
    is_prior: true,
    reason: `پیش‌فرض دامنه‌ای: در رژیم «${regime}» رفتار تاریخی بازار ایران برای ${SYMBOL_LABEL[target] || target} ${dir === 'up' ? 'صعودی' : 'نزولی'} است`,
  };
}

// A learned model only counts as real evidence if it has both confidence and samples.
function hasEvidence(m) {
  if (!m) return false;
  if (m.is_prior) return true;
  if (!(m.confidence > 0.02)) return false;
  if (m.sample_count != null && m.sample_count < 3) return false;
  return true;
}

// ════════════════════════════════════════════════════════
//  ENSEMBLE COMBINE  (§8.3)
// ════════════════════════════════════════════════════════
function combine(A, B, C, D) {
  const labeled = [
    ['A', A, tdb.getWeight('w_model_a', 0.40)],
    ['B', B, tdb.getWeight('w_model_b', 0.30)],
    ['C', C, tdb.getWeight('w_model_c', 0.30)],
    ['D', D, tdb.getWeight('w_model_d', 0.20)],
  ];
  // Models with no real evidence must not vote. Previously a model with
  // confidence 0 still won the direction argmax (all scores tied at 0), which is
  // how a single zero-reliability sample became a published forecast.
  const active = labeled.filter(([, m]) => hasEvidence(m));
  if (!active.length) return null;
  const wsum = active.reduce((s, [, , w]) => s + w, 0) || 1;

  const dirScore = { up: 0, down: 0, flat: 0 };
  let pctList = [], confList = [];
  for (const [, m, w] of active) {
    dirScore[m.direction] = (dirScore[m.direction] || 0) + (w / wsum) * (m.confidence || 0.5);
    pctList.push(m.pct || 0);
    confList.push((m.confidence || 0) * (w / wsum));
  }
  const finalDir = Object.entries(dirScore).sort((a, b) => b[1] - a[1])[0][0];
  // no side actually scored -> no direction to publish
  if (!(dirScore[finalDir] > 0)) return null;
  const finalPct = median(pctList);
  const agreeCount = active.filter(([, m]) => m.direction === finalDir).length;
  const agreement = agreeCount / active.length;
  const regimeConf = (tdb.getCurrentRegime() || {}).confidence || 0.7;
  let finalConf = confList.reduce((a, b) => a + b, 0) * agreement * regimeConf;
  finalConf = Math.min(finalConf, 0.95);
  // disagreement across the ensemble LOWERS confidence (§14 honesty)
  if (agreement < 0.67) finalConf *= 0.8;
  // Below this the arrow is indistinguishable from a coin flip; publishing it as a
  // directional call is what made the whole panel untrustworthy.
  if (finalConf < 0.05) return null;
  const priorOnly = active.length === 1 && active[0][1].is_prior;
  return {
    direction: finalDir, pct: finalPct, confidence: finalConf, agreement, regimeConf,
    basis: priorOnly ? 'prior' : 'learned',
    basis_note: priorOnly ? (active[0][1].reason || 'پیش‌فرض دامنه‌ای') : null,
  };
}

// ════════════════════════════════════════════════════════
//  ATTRIBUTION  (§8.4)
// ════════════════════════════════════════════════════════
function buildAttribution(chain, A, B, regimeConf) {
  const hist = ((A ? A.confidence : 0) + (B ? B.confidence : 0)) / 2;
  const sev = chain.peak_severity || 0;
  const trend = (chain.events || []).some(e => e.node_key === 'trend') ? 0.5 : 0.1;
  const mkt = regimeConf || 0.3;
  const total = hist + sev + trend + mkt || 1;
  return {
    historical_similarity: +(hist / total).toFixed(3),
    news_severity: +(sev / total).toFixed(3),
    trend_confirmation: +(trend / total).toFixed(3),
    market_context: +(mkt / total).toFixed(3),
  };
}

// ════════════════════════════════════════════════════════
//  PREDICTION GENERATION  (§8.1)
// ════════════════════════════════════════════════════════
function _chainsWithOpenPredictions() {
  return new Set((tdb.getOpenPredictions() || []).map(p => p.chain_id).filter(Boolean));
}

async function generatePrediction(chain, fullChain, target, horizon, regime, triggerTopic, bestEdge) {
  const base = currentPrice(target);
  if (base == null) return null; // pitfall 9: base_price required

  const A = patternModel(target, horizon, regime, triggerTopic);
  const B = similarityModel(target, horizon, regime, triggerTopic);
  const C = await llmModel(fullChain, target, horizon, regime, A, B);
  // D only participates when A/B/C carry no real evidence (cold start / AI quota out)
  const D = (hasEvidence(A) || hasEvidence(B) || hasEvidence(C)) ? null : priorModel(target, regime);
  let combo = combine(A, B, C, D);

  // Cold-start fallback: if all models are null but we have a usable edge,
  // create a low-confidence "hypothesis" prediction from the edge alone.
  // edge.correlation now holds a real DIRECTIONAL BIAS in [-1,1] from discovery.
  if (!combo && bestEdge) {
    const bias = bestEdge.correlation || 0;
    const dir = Math.abs(bias) < 0.15 ? 'flat' : (bias > 0 ? 'up' : 'down');
    if (dir === 'flat') return null; // no directional information -> don't guess
    combo = {
      direction: dir,
      pct: dir === 'up' ? 1.0 : -1.0,
      // scale by both edge skill and how one-sided the direction was
      confidence: clamp(bestEdge.reliability * (0.3 + 0.4 * Math.abs(bias)), 0.1, 0.4),
      agreement: 0.33, regimeConf: (tdb.getCurrentRegime() || {}).confidence || 0.7,
      basis: 'edge', basis_note: 'فرضیه بر پایه یال کشف‌شده، بدون الگوی تأییدشده',
    };
  }
  if (!combo) return null;

  const regimeConf = combo.regimeConf;
  const attribution = buildAttribution(fullChain, A, B, regimeConf);
  const calibrated = tdb.calibrate(combo.confidence);
  const { min, max } = pctRange(combo.pct);

  const id = tdb.insertPrediction({
    chain_id: chain.id, target, time_horizon: horizon, regime,
    direction: combo.direction, predicted_pct: combo.pct, predicted_min: min, predicted_max: max,
    confidence: combo.confidence, calibrated_confidence: calibrated, prior_confidence: combo.confidence,
    base_price: base,
    ensemble_json: JSON.stringify({ A, B, C, D, basis: combo.basis, basis_note: combo.basis_note }),
    attribution_json: JSON.stringify(attribution),
    status: 'open', created_at: nowIso(),
    expires_at: new Date(Date.now() + horizon * 3600000).toISOString(),
  });
  return id;
}

async function tryGeneratePredictions() {
  const MAX_OPEN = 6; // hard cap: never more than 6 open predictions
  const existing = tdb.getOpenPredictions() || [];
  if (existing.length >= MAX_OPEN) return 0; // enough already

  // track existing target+horizon combos — don't create duplicates
  const existingCombos = new Set(existing.map(p => `${p.target}_${p.time_horizon}_${p.direction}`));

  const chains = tdb.getChains('active', 30);
  const hasPred = _chainsWithOpenPredictions();
  let made = 0;
  for (const chain of chains) {
    if (existing.length + made >= MAX_OPEN) break; // stop at cap
    if (hasPred.has(chain.id)) continue;
    const peakDecayed = tdb.decayedWeight(chain.peak_severity || 0, chain.started_at);
    if (peakDecayed < 0.4) continue; // §8.1 threshold
    const full = tdb.getChain(chain.id);
    if (!full || !full.events || !full.events.length) continue;

    const signalNodes = [...new Set(full.events.filter(e => ['news', 'trend', 'poly', 'fin_tg'].includes(e.node_key)).map(e => e.node_key))];
    if (!signalNodes.length) continue;
    const regime = (tdb.getCurrentRegime() || {}).regime || 'normal';
    const triggerTopic = full.topic || chain.topic;

    // only generate ONE prediction per chain: the best target+horizon combination
    // (highest edge reliability × shortest horizon for most actionable result)
    let best = null;
    for (const target of TO_NODES) {
      const edges = (tdb.getEdgeTo(target, regime) || []).filter(e => signalNodes.includes(e.from_node));
      if (!edges.length) continue;
      const edge = edges[0];
      const bias = edge.correlation || 0;
      if (Math.abs(bias) < 0.15) continue; // no directional signal — skip this target
      const dir = bias > 0 ? 'up' : 'down';
      const comboKey = `${target}_3_${dir}`;
      if (existingCombos.has(comboKey)) continue; // skip if already predicted
      const score = (edge.reliability || 0) * Math.abs(bias) + (currentPrice(target) ? 0.1 : 0);
      if (!best || score > best.score) best = { target, edge, score, dir };
    }
    if (best) {
      existingCombos.add(`${best.target}_3_${best.dir}`); // mark combo as used
      try {
        if (await generatePrediction(chain, full, best.target, 3, regime, triggerTopic, best.edge)) made++;
      } catch (e) { /* continue */ }
    }
  }
  if (made) console.log(`[tl-predict] generated ${made} predictions`);
  return made;
}

// ════════════════════════════════════════════════════════
//  BAYESIAN UPDATING  (§8.5)
// ════════════════════════════════════════════════════════
function reviseOpenPredictions(newEvents) {
  const open = tdb.getOpenPredictions() || [];
  if (!open.length || !newEvents || !newEvents.length) return;
  let updates = 0;
  // the loop already visits each open prediction at most once
  let perPredictionRevised = 0;
  for (const p of open) {
    // getEdgeTo() depends only on the prediction, not on the event, but used to be called
    // once per event: 6 open predictions x ~650 recent events = ~3900 queries at ~12ms each,
    // so this single loop took over 2 minutes while fastLoop runs every 60s — the process
    // never caught up and pinned a core, starving the HTTP server. Fetch once, index by node.
    const edgeByNode = new Map();
    for (const ed of (tdb.getEdgeTo(p.target, p.regime) || [])) {
      if (!edgeByNode.has(ed.from_node)) edgeByNode.set(ed.from_node, ed);
    }
    // only consider the MOST RECENT significant event for this prediction's target
    let bestEvent = null, bestEdge = null;
    for (const e of newEvents) {
      const edge = edgeByNode.get(e.node_key);
      if (!edge) continue;
      // pick the highest-reliability edge event
      if (!bestEvent || (edge.reliability || 0) > (bestEdge?.reliability || 0)) {
        bestEvent = e; bestEdge = edge;
      }
    }
    if (!bestEvent || !bestEdge) continue;
    const e = bestEvent, edge = bestEdge;
    // cap L at 0.85 — nothing is 100% certain; edges with reliability=1.0 are cold-start overfitting
    let L = clamp(edge.reliability || 0.5, 0.05, 0.85);
    // if event direction opposes prediction direction, invert likelihood
    if (e.direction && p.direction !== 'flat' && e.direction !== p.direction) L = 1 - L;
    const prior = p.confidence || 0.5;
    let posterior = clamp((prior * L) / (prior * L + (1 - prior) * (1 - L)), 0.01, 0.95);
    // during cold-start (no validations yet), cap confidence at 0.5 — don't show fake high confidence
    if (tdb.countValidations() < 20) posterior = Math.min(posterior, 0.5);
    // Only nudge predicted_pct when the trigger carries a comparable price-percentage.
    // A news wave ("magnitude" = 12 articles) or a trend spike ("magnitude" = 100% search
    // growth) used to be blended straight into the price forecast, which dragged bearish
    // predictions up to the +5 clamp. Those events still revise confidence, just not pct.
    const mag = magnitudeAsPricePct(e);
    const newPct = mag == null
      ? p.predicted_pct
      : clamp((p.predicted_pct || 0) * 0.7 + clamp(mag, -5, 5) * 0.3, -5, 5);
    const cal = tdb.calibrate(posterior);
    tdb.insertPredictionUpdate({
      prediction_id: p.id, trigger_event_id: e.id, trigger_desc: e.title,
      prev_confidence: prior, new_confidence: posterior,
      prev_calibrated: p.calibrated_confidence, new_calibrated: cal,
      prev_pct: p.predicted_pct, new_pct: newPct, reason: 'به‌روزرسانی بیزی بر اساس رویداد جدید',
    });
    // keep the band in sync with the point estimate — it used to stay frozen at the
    // original value while pct drifted, so pct often sat outside its own min/max
    const patch = { confidence: posterior, calibrated_confidence: cal, predicted_pct: newPct };
    if (newPct !== p.predicted_pct) {
      const band = pctRange(newPct);
      patch.predicted_min = band.min;
      patch.predicted_max = band.max;
    }
    tdb.updatePrediction(p.id, patch);
    p.confidence = posterior; p.calibrated_confidence = cal; p.predicted_pct = newPct;
    perPredictionRevised++;
    updates++;
  }
  if (updates) console.log(`[tl-predict] ${updates} Bayesian revisions`);
  return updates;
}

// Called by the engine after each detection pass
async function onNewEvents() {
  try {
    await tryGeneratePredictions();
    const recent = tdb.getEventsSince(3) || [];
    reviseOpenPredictions(recent);
  } catch (e) { console.warn('[tl-predict] onNewEvents error:', e.message); }
}

// ════════════════════════════════════════════════════════
//  MULTI-ASSET MATRIX  (§10, §12.8d)
// ════════════════════════════════════════════════════════
function getPredictionMatrix() {
  const open = tdb.getOpenPredictions() || [];
  const rows = TO_NODES.map(target => ({ target, label: SYMBOL_LABEL[target] || target, cells: { 3: null, 12: null, 24: null } }));
  for (const p of open) {
    const row = rows.find(r => r.target === p.target);
    if (!row) continue;
    const h = p.time_horizon;
    if (!HORIZONS.includes(h)) continue;
    const conf = p.calibrated_confidence != null ? p.calibrated_confidence : p.confidence;
    if (!row.cells[h] || conf > (row.cells[h].conf || 0)) {
      row.cells[h] = { dir: p.direction, pct: p.predicted_pct, conf, id: p.id };
    }
  }
  return { rows };
}

// ════════════════════════════════════════════════════════
//  WHAT-IF SIMULATOR  (§12.8a)
// ════════════════════════════════════════════════════════
async function whatIf(scenario) {
  if (!scenario) return { error: 'سناریو خالی است' };
  // AI extracts topic from scenario
  let topic = scenario;
  try {
    const r = await ai.callStructured(`این سناریوی فرضی را در یک عبارت موضوعی ۵ کلمه‌ای فارسی خلاصه کن:\n${scenario}\nفقط JSON: {"topic":"..."}`);
    if (r && r.topic) topic = r.topic;
  } catch (e) {}
  const regime = (tdb.getCurrentRegime() || {}).regime || 'normal';
  const cat = tdb.categorizeTopic(topic);
  const matches = [];
  for (const target of TO_NODES) {
    for (const horizon of HORIZONS) {
      const pat = tdb.getPattern(cat, target, horizon, regime) || tdb.getPattern(cat, target, horizon, 'normal');
      if (!pat) continue;
      const conf = (pat.reliability || 0) * Math.min((pat.sample_count || 0) / 10, 1) * (1 - (pat.concept_drift_score || 0));
      matches.push({
        target, label: SYMBOL_LABEL[target] || target, horizon,
        direction: pat.outcome_dir || 'flat', pct: pat.outcome_pct || 0,
        confidence: conf, sample_count: pat.sample_count || 0, drift: pat.concept_drift_score || 0,
      });
    }
  }
  // similar historical chains
  const similar = (tdb.getChains(null, 50) || []).filter(c => topic && c.topic && (c.topic === topic || c.topic.includes(topic) || topic.includes(c.topic))).slice(0, 5).map(c => ({ id: c.id, title: c.title, topic: c.topic, regime: c.regime, peak_severity: c.peak_severity }));
  return { scenario, topic, matches, similar_chains: similar };
}

module.exports = {
  onNewEvents, tryGeneratePredictions, reviseOpenPredictions, generatePrediction,
  getPredictionMatrix, whatIf, patternModel, similarityModel, llmModel, combine, buildAttribution,
  pctRange, magnitudeAsPricePct, priorModel, hasEvidence,
  TO_NODES, HORIZONS, SYMBOL_LABEL, REGIME_PRIORS,
};
