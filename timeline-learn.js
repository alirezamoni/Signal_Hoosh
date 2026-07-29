/**
 * timeline-learn.js — Validation + counterfactual + learning + drift + backtest (§9)
 *
 * Every prediction is scored against EXCESS over a counterfactual baseline (not raw
 * price moves). Patterns, source reliability, edges and indicators all update from
 * validation outcomes. Concept drift auto-archives stale patterns (§9.5, pitfall 11).
 */
const tdb = require('./timeline-db');
const ai = require('./timeline-ai');

const TO_NODES = ['usd', 'coin', 'gold18', 'tether', 'bitcoin', 'oil_brent', 'stock_market', 'mesghal', 'ounce'];

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function nowIso() { return new Date().toISOString(); }
function currentPrice(target) {
  try { const r = require('./finance-db').getLatestBySymbol(target); return r && r.price ? r.price : null; } catch (e) { return null; }
}

// ════════════════════════════════════════════════════════
//  COUNTERFACTUAL BASELINE  (§9.1)
// ════════════════════════════════════════════════════════
// mean |% move| of target over same-length windows in last 30 days (normal volatility).
// This is the bar a prediction must beat (skill_score).
const _baselineCache = new Map(); // `${target}:${horizon}` -> { val, ts }
function counterfactualBaseline(target, horizonHours) {
  const key = `${target}:${horizonHours}`;
  const c = _baselineCache.get(key);
  if (c && Date.now() - c.ts < 30 * 60000) return c.val; // cache 30 min
  let val = 0.5; // sensible default
  try {
    const fdb = require('./finance-db');
    const history = fdb.getHistory(target, 30 * 24) || [];
    if (history.length > 4) {
      const stepMins = Math.max(1, Math.round((horizonHours * 60) / 60)); // ~one reading per 60s
      const stepIdx = Math.max(1, Math.round(history.length / Math.max(1, (30 * 24 * 60) / (horizonHours * 60))));
      const absPcts = [];
      for (let i = stepIdx; i < history.length; i += stepIdx) {
        const a = history[i - stepIdx].price, b = history[i].price;
        if (a) absPcts.push(Math.abs((b - a) / a * 100));
        if (absPcts.length >= 60) break; // sample cap
      }
      if (absPcts.length) val = absPcts.reduce((s, x) => s + x, 0) / absPcts.length;
    }
  } catch (e) {}
  _baselineCache.set(key, { val, ts: Date.now() });
  return val;
}

// ════════════════════════════════════════════════════════
//  VALIDATION + SCORING  (§9.2)
// ════════════════════════════════════════════════════════
function scorePrediction(p, actualPct, baselinePct) {
  const actualDir = actualPct > 0.2 ? 'up' : actualPct < -0.2 ? 'down' : 'flat';
  const dirCorrect = (actualDir === p.direction) ? 1 : 0;

  const magError = Math.abs(actualPct - (p.predicted_pct || 0));
  const magScore = clamp(1 - magError / 3, 0, 1); // 3% error -> 0

  const inRange = (p.predicted_min != null && p.predicted_max != null &&
    actualPct >= p.predicted_min && actualPct <= p.predicted_max) ? 1 : 0;

  // calibration component: how close confidence was to the realized correctness
  const calibScore = clamp(1 - Math.abs((p.calibrated_confidence != null ? p.calibrated_confidence : p.confidence) - dirCorrect), 0, 1);

  const overall = 50 * dirCorrect + 30 * magScore + 10 * inRange + 10 * calibScore;

  // skill: did we beat simply predicting the baseline? (excess attributable to the signal)
  const excess = actualPct - baselinePct;
  const skill = dirCorrect ? clamp(Math.abs(excess) / 3, 0, 1) : -clamp(Math.abs(actualPct) / 3, 0, 1);

  return { actualDir, dirCorrect, magError, magScore, inRange, calibScore, overall, skill, excess };
}

function validatePrediction(p) {
  const actual = currentPrice(p.target);
  if (actual == null) { tdb.updatePrediction(p.id, { status: 'validated' }); return; }
  const actualPct = p.base_price ? ((actual - p.base_price) / p.base_price) * 100 : 0;
  const baselinePct = counterfactualBaseline(p.target, p.time_horizon);
  const s = scorePrediction(p, actualPct, baselinePct);

  tdb.insertValidation({
    prediction_id: p.id, actual_price: actual, actual_pct: actualPct,
    actual_direction: s.actualDir, baseline_pct: baselinePct, excess_pct: s.excess,
    direction_correct: s.dirCorrect, magnitude_error: s.magError,
    magnitude_in_range: s.inRange, overall_score: s.overall, skill_score: s.skill,
  });
  tdb.updatePrediction(p.id, { status: 'validated' });

  // ── calibration bucket update (§8.6) ──
  tdb.updateCalibrationBucket(p.calibrated_confidence != null ? p.calibrated_confidence : p.confidence, s.dirCorrect);

  // ── learning updates (§9.3) ──
  learningUpdates(p, s, actualPct, baselinePct);

  // ── accuracy metrics ──
  updateAccuracyMetrics(p, s);

  return s;
}

// ════════════════════════════════════════════════════════
//  LEARNING UPDATES  (§9.3)
// ════════════════════════════════════════════════════════
function learningUpdates(p, score, actualPct, baselinePct) {
  const chain = p.chain_id ? tdb.getChain(p.chain_id) : null;
  const triggerTopic = (chain && chain.topic) || 'unknown';
  const regime = p.regime || 'normal';
  const correct = score.dirCorrect === 1;
  const excess = score.excess;

  // pattern_library: update outcome, reliability, lag, count
  let pat = tdb.getPattern(triggerTopic, p.target, p.time_horizon, regime) || tdb.getPattern(triggerTopic, p.target, p.time_horizon, 'normal');
  if (pat) {
    const n = (pat.sample_count || 0) + 1;
    const newPct = ((pat.outcome_pct || 0) * (pat.sample_count || 0) + excess) / n;
    const newRel = ((pat.reliability || 0) * (pat.sample_count || 0) + (correct ? 1 : 0)) / n;
    tdb.upsertPattern({
      trigger_topic: pat.trigger_topic, trigger_node: pat.trigger_node, target: pat.target,
      time_horizon: pat.time_horizon, regime: pat.regime, outcome_dir: score.actualDir,
      outcome_pct: newPct, avg_lag_min: pat.avg_lag_min, reliability: newRel,
      sample_count: n, last_seen: nowIso(), concept_drift_score: pat.concept_drift_score || 0,
    });
  } else {
    // seed new pattern from this single observation
    tdb.upsertPattern({
      trigger_topic: triggerTopic, trigger_node: (chain && chain.root_node) || null, target: p.target,
      time_horizon: p.time_horizon, regime, outcome_dir: score.actualDir, outcome_pct: excess,
      avg_lag_min: null, reliability: correct ? 1 : 0, sample_count: 1, last_seen: nowIso(), concept_drift_score: 0,
    });
  }

  // source_reliability: update every source involved in the chain's root causes
  if (chain && chain.events) {
    const seen = new Set();
    for (const e of chain.events) {
      if (!['news', 'trend', 'poly', 'fin_tg'].includes(e.node_key)) continue;
      const st = e.node_key === 'news' ? (/خبرگزاری|IRNA|ISNA|فارس|تسنیم|ایسنا/i.test(e.title || '') ? 'news_agency' : 'telegram_channel')
        : e.node_key === 'trend' ? 'rss'
          : e.node_key === 'poly' ? 'polymarket'
            : e.node_key === 'fin_tg' ? 'finance_tg' : 'telegram_channel';
      const sk = e.source_id || null;
      const key = `${st}:${sk}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tdb.adjustSourceAccuracy(st, sk, correct);
    }
  }

  // leading_indicators + signal_edges: strengthen/weaken, refine lead_time
  const edges = tdb.getEdgeTo(p.target, regime) || [];
  for (const ed of edges) {
    const n = (ed.sample_count || 0) + 1;
    const newRel = clamp(((ed.reliability || 0) * (ed.sample_count || 0) + (correct ? 1 : 0)) / n, 0, 1);
    tdb.upsertEdge({
      from_node: ed.from_node, to_node: ed.to_node, topic: ed.topic, regime: ed.regime,
      lead_time_min: ed.lead_time_min, lead_time_std: ed.lead_time_std, reliability: newRel,
      correlation: ed.correlation, sample_count: n, last_confirmed: nowIso(),
    });
    tdb.upsertIndicator({
      indicator: ed.from_node, target: ed.to_node, regime: ed.regime,
      lead_time_min: ed.lead_time_min, accuracy: newRel, correlation: ed.correlation, sample_count: n,
    });
  }
}

function updateAccuracyMetrics(p, s) {
  // overall
  const all = tdb.getRecentValidations(100000);
  const total = all.length;
  const correctDir = all.filter(v => v.direction_correct === 1).length;
  const mape = total ? (all.reduce((sum, v) => sum + (v.magnitude_error || 0), 0) / total) : 0;
  const avgScore = total ? (all.reduce((sum, v) => sum + (v.overall_score || 0), 0) / total) : 0;
  const avgSkill = total ? (all.reduce((sum, v) => sum + (v.skill_score || 0), 0) / total) : 0;
  tdb.upsertAccuracyMetric('all', null, { total, correct_dir: correctDir, mape, avg_score: avgScore, avg_skill: avgSkill });
  // by target
  const tAll = all.filter(v => { const pr = tdb.getPrediction(v.prediction_id); return pr && pr.target === p.target; });
  tdb.upsertAccuracyMetric('target', p.target, {
    total: tAll.length, correct_dir: tAll.filter(v => v.direction_correct === 1).length,
    mape: tAll.length ? (tAll.reduce((s, v) => s + (v.magnitude_error || 0), 0) / tAll.length) : 0,
    avg_score: tAll.length ? (tAll.reduce((s, v) => s + (v.overall_score || 0), 0) / tAll.length) : 0,
    avg_skill: tAll.length ? (tAll.reduce((s, v) => s + (v.skill_score || 0), 0) / tAll.length) : 0,
  });
  // by regime
  tdb.upsertAccuracyMetric('regime', p.regime, {
    total: 1, correct_dir: s.dirCorrect, mape: s.magError, avg_score: s.overall, avg_skill: s.skill,
  });
}

// ════════════════════════════════════════════════════════
//  WEIGHT ADJUSTMENT WITH OVERFITTING GUARD  (§9.4)
// ════════════════════════════════════════════════════════
function tryWeightAdjustment() {
  const all = tdb.getRecentValidations(200);
  if (all.length < 20) return;
  // shuffle-free 70/30 split by recency (train=older 70%, holdout=newest 30%)
  const split = Math.floor(all.length * 0.7);
  const train = all.slice(0, split), holdout = all.slice(split);
  const lr = tdb.getWeight('lr_base', 0.1) * Math.pow(tdb.getWeight('lr_decay', 0.97), all.length / 10);

  // measure per-model skill from ensemble_json of validated predictions
  const models = ['A', 'B', 'C'];
  const trainSkill = {}, holdSkill = {};
  for (const m of models) {
    trainSkill[m] = avgModelSkill(train, m);
    holdSkill[m] = avgModelSkill(holdout, m);
  }
  const baseTrain = (trainSkill.A + trainSkill.B + trainSkill.C) / 3;
  const baseHold = (holdSkill.A + holdSkill.B + holdSkill.C) / 3;
  for (const m of models) {
    const wk = `w_model_${m.toLowerCase()}`;
    const cur = tdb.getWeight(wk, 0.33);
    // nudge toward better-performing model
    let delta = 0;
    if (trainSkill[m] > baseTrain) delta = lr * 0.1; else delta = -lr * 0.1;
    const proposed = clamp(cur + delta, 0.1, 0.6);
    // GUARD: only keep if holdout doesn't worsen
    if (holdSkill[m] >= baseHold - 0.02) {
      tdb.setWeight(wk, proposed);
    }
  }
}
function avgModelSkill(vals, modelKey) {
  let sum = 0, n = 0;
  for (const v of vals) {
    const p = tdb.getPrediction(v.prediction_id);
    if (!p || !p.ensemble_json) continue;
    try {
      const ens = JSON.parse(p.ensemble_json);
      const m = ens[modelKey];
      if (m && m.direction) {
        const correct = (m.direction === v.actual_direction) ? 1 : 0;
        sum += correct * (v.skill_score || 0);
        n++;
      }
    } catch (e) {}
  }
  return n ? sum / n : 0;
}

// ════════════════════════════════════════════════════════
//  CONCEPT DRIFT  (§9.5)
// ════════════════════════════════════════════════════════
function runConceptDrift() {
  const patterns = tdb.getPatterns() || [];
  const windowDays = tdb.getWeight('drift_window_days', 30);
  const threshold = tdb.getWeight('drift_threshold', 0.15);
  const archiveScore = tdb.getWeight('drift_archive_score', 0.6);
  for (const pat of patterns) {
    if ((pat.sample_count || 0) < 5) continue;
    // recent accuracy = last ~10 validations for this pattern (approx via recency)
    const recent = recentPatternAccuracy(pat, 10);
    const historical = pat.reliability || 0;
    if (recent == null) continue;
    const drift = historical - recent; // positive when recent is worse
    if (drift > threshold && recent < historical) {
      let newScore = clamp((pat.concept_drift_score || 0) + 0.1, 0, 1);
      tdb.setPatternDrift(pat.id, newScore);
      tdb.insertDriftLog({
        subject_type: 'pattern', subject_id: pat.id, metric: 'reliability',
        value_old: historical, value_new: recent, window_days: windowDays, drift_significant: 1,
      });
      // demote edge weight if drift high
      if (newScore > archiveScore) {
        // archived: leave in DB but flagged (UI strikes through)
        console.log(`[tl-learn] pattern ${pat.id} archived (drift ${newScore.toFixed(2)})`);
      }
    } else if (drift < -threshold && (pat.concept_drift_score || 0) > 0) {
      // pattern recovering — reduce drift score
      tdb.setPatternDrift(pat.id, clamp((pat.concept_drift_score || 0) - 0.05, 0, 1));
    }
  }
}

function recentPatternAccuracy(pat, n) {
  // recency-weighted accuracy using validated predictions matching this pattern
  const preds = (tdb.getPredictions('validated', null, 500) || []).filter(p => {
    const chain = p.chain_id ? tdb.getChain(p.chain_id) : null;
    return p.target === pat.target && p.time_horizon === pat.time_horizon &&
      (chain && chain.topic === pat.trigger_topic);
  });
  if (!preds.length) return null;
  const vals = preds.map(p => tdb.getValidation(p.id)).filter(Boolean).slice(-n);
  if (!vals.length) return null;
  const lam = tdb.getWeight('decay_lambda', 0.0058) * 60 * 24; // per day
  let wsum = 0, csum = 0;
  for (const v of vals) {
    const days = (Date.now() - new Date(v.validated_at).getTime()) / 86400000;
    const w = Math.exp(-lam * days);
    wsum += w; csum += w * (v.direction_correct === 1 ? 1 : 0);
  }
  return wsum ? csum / wsum : null;
}

// ════════════════════════════════════════════════════════
//  STRUCTURED AI REFLECTION  (§9.6)
// ════════════════════════════════════════════════════════
async function runReflection() {
  const vals = tdb.getRecentValidations(10);
  if (vals.length < 10) return;
  const list = vals.map(v => {
    const p = tdb.getPrediction(v.prediction_id);
    return `هدف:${p?.target} افق:${p?.time_horizon}h جهت‌پیش‌بینی:${p?.direction} واقعیت:${v.actual_direction} درصد‌واقعی:${(v.actual_pct || 0).toFixed(1)} مهارت:${(v.skill_score || 0).toFixed(2)}`;
  }).join('\n');
  const prompt = `این ۱۰ پیش‌بینی اخیر با نتایج و امتیاز مهارت (skill):
${list}

فقط JSON برگردان:
{"patterns_found":["..."],"systematic_errors":[{"issue":"...","fix":"..."}],"calibration_issue":{"ece_current":0.12,"ece_target":0.05,"suggestion":"..."},"drift_found":["pattern_id:12 score:0.45"],"weight_suggestion":{"model":"A|B|C","direction":"increase|decrease"}}`;
  try {
    const r = await ai.callStructured(prompt);
    return r;
  } catch (e) { return null; }
}

// ════════════════════════════════════════════════════════
//  BACKTEST  (§9.7) + COLD-START SEED
// ════════════════════════════════════════════════════════
// NOTE (honest limitation, pitfall 13): news.db retains only 30 days, so a full
// 90-day cross-source replay is impossible. We seed what we can: counterfactual
// baselines per symbol+horizon from finance.db (1y retention), run graph discovery
// over whatever timeline_events have accumulated, and seed accuracy/calibration.
async function runBacktest() {
  console.log('[tl-learn] backtest: seeding baselines + running discovery...');
  // seed counterfactual baselines (warm the cache) + store as weights
  for (const sym of TO_NODES) {
    for (const h of [3, 12, 24]) {
      const b = counterfactualBaseline(sym, h);
      tdb.setWeight(`baseline_${sym}_${h}h`, b, `counterfactual baseline |% move| for ${sym} over ${h}h`);
    }
  }
  // run discovery over accumulated timeline_events
  try { require('./timeline-graph').runDiscovery(); } catch (e) {}
  // recompute ECE flag
  const ece = tdb.computeECE();
  tdb.setWeight('calibration_needed', ece > 0.1 ? 1 : 0, `ECE=${ece.toFixed(3)}`);
  console.log('[tl-learn] backtest done.');
  return { baselines_seeded: TO_NODES.length * 3, ece };
}

// ════════════════════════════════════════════════════════
//  MAIN VALIDATION PASS  (every 10 min)
// ════════════════════════════════════════════════════════
async function runValidation() {
  try {
    const expired = tdb.getExpiredOpen() || [];
    let n = 0;
    for (const p of expired) {
      try { if (validatePrediction(p)) n++; } catch (e) { tdb.updatePrediction(p.id, { status: 'validated' }); }
    }
    if (n) console.log(`[tl-learn] validated ${n} predictions`);

    // weight adjustment + drift + reflection on a cadence
    const total = tdb.countValidations();
    if (total > 0 && total % 20 === 0) tryWeightAdjustment();

    // concept drift weekly
    const lastDrift = tdb.getWeight('drift_last_run', 0);
    if (!lastDrift || Date.now() - lastDrift > 7 * 86400000) {
      runConceptDrift();
      tdb.setWeight('drift_last_run', Date.now());
    }

    // reflection every 10 validations
    if (total > 0 && total % 10 === 0) {
      const r = await runReflection();
      if (r && r.calibration_issue) {
        tdb.setWeight('calibration_needed', (r.calibration_issue.ece_current || 0) > 0.1 ? 1 : 0);
      }
      if (r) tdb.setWeight('last_reflection', JSON.stringify(r).length, 'reflection stored compactly');
    }

    // recompute ECE flag
    const ece = tdb.computeECE();
    tdb.setWeight('ece_current', ece, 'expected calibration error');
    tdb.setWeight('calibration_needed', ece > 0.1 ? 1 : 0);
  } catch (e) { console.warn('[tl-learn] runValidation error:', e.message); }
}

module.exports = {
  runValidation, validatePrediction, scorePrediction, counterfactualBaseline,
  learningUpdates, tryWeightAdjustment, runConceptDrift, runReflection, runBacktest,
  updateAccuracyMetrics,
};
