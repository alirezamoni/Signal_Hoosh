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
function median(arr) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function nowIso() { return new Date().toISOString(); }

function currentPrice(target) {
  try { const r = require('./finance-db').getLatestBySymbol(target); return r && r.price ? r.price : null; } catch (e) { return null; }
}

// ════════════════════════════════════════════════════════
//  SUB-MODELS
// ════════════════════════════════════════════════════════

// Model A — Historical / Pattern (counterfactual-adjusted)
function patternModel(target, horizon, regime, topic) {
  let p = tdb.getPattern(topic, target, horizon, regime) || tdb.getPattern(topic, target, horizon, 'normal');
  if (!p) { p = (tdb.getPatternsForTopic(topic, target, regime) || [])[0]; }
  if (!p) return null;
  const conf = (p.reliability || 0) * Math.min((p.sample_count || 0) / 10, 1);
  const drift = p.concept_drift_score || 0;
  return {
    direction: p.outcome_dir || 'up', pct: p.outcome_pct || 0,
    confidence: conf * (1 - drift), sample_count: p.sample_count || 0,
  };
}

// Model B — Similarity (nearest historical chains)
function similarityModel(target, horizon, regime, topic) {
  const chains = (tdb.getChains(null, 300) || []).filter(c => c.topic === topic && (c.regime === regime || c.regime === 'normal'));
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
//  ENSEMBLE COMBINE  (§8.3)
// ════════════════════════════════════════════════════════
function combine(A, B, C) {
  const labeled = [['A', A, tdb.getWeight('w_model_a', 0.40)], ['B', B, tdb.getWeight('w_model_b', 0.30)], ['C', C, tdb.getWeight('w_model_c', 0.30)]];
  const active = labeled.filter(([, m]) => m);
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
  const finalPct = median(pctList);
  const agreeCount = active.filter(([, m]) => m.direction === finalDir).length;
  const agreement = agreeCount / active.length;
  const regimeConf = (tdb.getCurrentRegime() || {}).confidence || 0.7;
  let finalConf = confList.reduce((a, b) => a + b, 0) * agreement * regimeConf;
  finalConf = Math.min(finalConf, 0.95);
  // disagreement across the ensemble LOWERS confidence (§14 honesty)
  if (agreement < 0.67) finalConf *= 0.8;
  return { direction: finalDir, pct: finalPct, confidence: finalConf, agreement, regimeConf };
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
  let combo = combine(A, B, C);

  // Cold-start fallback: if all models are null but we have a usable edge,
  // create a low-confidence "hypothesis" prediction from the edge alone.
  if (!combo && bestEdge) {
    const dir = bestEdge.correlation >= 0 ? 'up' : 'down';
    combo = {
      direction: dir,
      pct: dir === 'up' ? 1.0 : -1.0,
      confidence: clamp(bestEdge.reliability * 0.3, 0.1, 0.4), // capped low for hypothesis
      agreement: 0.33, regimeConf: (tdb.getCurrentRegime() || {}).confidence || 0.7,
    };
  }
  if (!combo) return null;

  const regimeConf = combo.regimeConf;
  const attribution = buildAttribution(fullChain, A, B, regimeConf);
  const calibrated = tdb.calibrate(combo.confidence);
  const min = combo.pct * 0.6, max = combo.pct * 1.4;

  const id = tdb.insertPrediction({
    chain_id: chain.id, target, time_horizon: horizon, regime,
    direction: combo.direction, predicted_pct: combo.pct, predicted_min: min, predicted_max: max,
    confidence: combo.confidence, calibrated_confidence: calibrated, prior_confidence: combo.confidence,
    base_price: base,
    ensemble_json: JSON.stringify({ A, B, C }),
    attribution_json: JSON.stringify(attribution),
    status: 'open', created_at: nowIso(),
    expires_at: new Date(Date.now() + horizon * 3600000).toISOString(),
  });
  return id;
}

async function tryGeneratePredictions() {
  const chains = tdb.getChains('active', 30);
  const hasPred = _chainsWithOpenPredictions();
  let made = 0;
  for (const chain of chains) {
    if (hasPred.has(chain.id)) continue;
    const peakDecayed = tdb.decayedWeight(chain.peak_severity || 0, chain.started_at);
    if (peakDecayed < 0.4) continue; // §8.1 threshold
    const full = tdb.getChain(chain.id);
    if (!full || !full.events || !full.events.length) continue;

    const signalNodes = [...new Set(full.events.filter(e => ['news', 'trend', 'poly', 'fin_tg'].includes(e.node_key)).map(e => e.node_key))];
    if (!signalNodes.length) continue;
    const regime = (tdb.getCurrentRegime() || {}).regime || 'normal';
    const triggerTopic = full.topic || chain.topic;

    for (const target of TO_NODES) {
      // need at least one usable edge from a signal node to this target (§8.1)
      const edges = (tdb.getEdgeTo(target, regime) || []).filter(e => signalNodes.includes(e.from_node));
      const hasPattern = (tdb.getPatternsForTopic(triggerTopic, target, regime) || []).length > 0;
      if (!edges.length && !hasPattern) continue;
      const bestEdge = edges.length ? edges[0] : null; // highest reliability (already sorted)
      for (const horizon of HORIZONS) {
        try {
          if (await generatePrediction(chain, full, target, horizon, regime, triggerTopic, bestEdge)) made++;
        } catch (e) { /* continue */ }
      }
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
  for (const p of open) {
    for (const e of newEvents) {
      const edges = (tdb.getEdgeTo(p.target, p.regime) || []).filter(ed => ed.from_node === e.node_key);
      if (!edges.length) continue;
      const edge = edges[0];
      let L = clamp(edge.reliability || 0.5, 0.05, 0.95);
      // if event direction opposes prediction direction, invert likelihood
      if (e.direction && p.direction !== 'flat' && e.direction !== p.direction) L = 1 - L;
      const prior = p.confidence || 0.5;
      const posterior = clamp((prior * L) / (prior * L + (1 - prior) * (1 - L)), 0.01, 0.99);
      // nudge predicted_pct toward edge-inferred magnitude
      const mag = e.magnitude || 0;
      const newPct = (p.predicted_pct || 0) * 0.7 + mag * 0.3;
      const cal = tdb.calibrate(posterior);
      tdb.insertPredictionUpdate({
        prediction_id: p.id, trigger_event_id: e.id, trigger_desc: e.title,
        prev_confidence: prior, new_confidence: posterior,
        prev_calibrated: p.calibrated_confidence, new_calibrated: cal,
        prev_pct: p.predicted_pct, new_pct: newPct, reason: 'به‌روزرسانی بیزی بر اساس رویداد جدید',
      });
      tdb.updatePrediction(p.id, { confidence: posterior, calibrated_confidence: cal, predicted_pct: newPct });
      p.confidence = posterior; p.calibrated_confidence = cal; p.predicted_pct = newPct;
      updates++;
    }
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
  const matches = [];
  for (const target of TO_NODES) {
    for (const horizon of HORIZONS) {
      const pat = tdb.getPattern(topic, target, horizon, regime) || tdb.getPattern(topic, target, horizon, 'normal');
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
  TO_NODES, HORIZONS, SYMBOL_LABEL,
};
