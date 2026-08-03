/**
 * timeline-api.js — Express routes for the Causal Discovery Engine (§10)
 * Mounted at /api/timeline with requireAuth (backtest requires superadmin).
 */
const express = require('express');
const router = express.Router();
const tdb = require('./timeline-db');
const graph = require('./timeline-graph');
const predict = require('./timeline-predict');
const learn = require('./timeline-learn');

const SYM_LABEL = predict.SYMBOL_LABEL;

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// ════════════════════════════════════════════════════════
//  INTELLIGENCE — overall short/medium/long forecast (§14 "تحلیل هوشمند")
// ════════════════════════════════════════════════════════
function _summarizeByHorizon(horizon) {
  // aggregate the live (open) predictions for this horizon into a market view
  const open = (tdb.getOpenPredictions() || []).filter(p => p.time_horizon === horizon);
  if (!open.length) return { direction: 'flat', confidence: 0, count: 0, summary: 'پیش‌بینی فعالی برای این افق وجود ندارد.' };
  let up = 0, down = 0, flat = 0, confSum = 0;
  const lines = [];
  for (const p of open) {
    confSum += (p.calibrated_confidence != null ? p.calibrated_confidence : p.confidence);
    if (p.direction === 'up') up++; else if (p.direction === 'down') down++; else flat++;
    lines.push(`${SYM_LABEL[p.target] || p.target}: ${p.direction === 'up' ? 'صعودی' : p.direction === 'down' ? 'نزولی' : 'خنثی'} ${p.predicted_pct != null ? (p.predicted_pct >= 0 ? '+' : '') + Number(p.predicted_pct).toFixed(1) + '٪' : ''}`);
  }
  let direction = 'flat';
  if (up > down && up > flat) direction = 'up';
  else if (down > up && down > flat) direction = 'down';
  const confidence = clamp((Math.max(up, down) / open.length) * (confSum / open.length), 0, 0.95);
  return { direction, confidence: +confidence.toFixed(2), count: open.length, summary: lines.join('، ') };
}

router.get('/intelligence', async (req, res) => {
  try {
    const ai = require('./timeline-ai');
    const regime = (tdb.getCurrentRegime() || {}).regime || 'normal';
    const regimeEv = (tdb.getCurrentRegime() || {}).evidence || '';
    const chains = (tdb.getChains('active', 6) || []).slice(0, 5).map(c => `- ${c.title} (شدت ${Math.round((c.peak_severity || 0) * 100)}٪)`);
    const patterns = (tdb.getPatterns() || []).filter(p => (p.sample_count || 0) >= 3 && (p.concept_drift_score || 0) < 0.6).slice(0, 8)
      .map(p => `- «${p.trigger_topic}» → ${SYM_LABEL[p.target] || p.target} در ${p.time_horizon} ساعت: ${p.outcome_dir === 'up' ? 'صعود' : p.outcome_dir === 'down' ? 'نزول' : 'خنثی'} میانگین ${p.outcome_pct != null ? Number(p.outcome_pct).toFixed(1) : '?'}٪ (دقت ${Math.round((p.reliability || 0) * 100)}٪، ${p.sample_count} نمونه)`);

    const short = _summarizeByHorizon(3);
    const medium = _summarizeByHorizon(12);
    const long = _summarizeByHorizon(24);

    const prompt = `تو یک تحلیلگر مالی-سیاسی هستی. بر اساس داده‌های زنده‌ی سیستم «سیگنال هوش» یک پیش‌بینی کلی از آینده‌ی بازار ایران بده.

رژیم فعلی بازار: ${regime} (${regimeEv || 'بدون توضیح'})
زنجیره‌های فعال:
${chains.join('\n') || '—'}

الگوهای آموخته‌شده‌ی معتبر:
${patterns.join('\n') || '—'}

پیش‌بینی‌های زنده‌ی سیستم:
کوتاه‌مدت (۳ ساعت): ${short.summary}
میان‌مدت (۱۲ ساعت): ${medium.summary}
بلندمدت (۲۴ ساعت): ${long.summary}

فقط JSON برگردان:
{
  "short":{"direction":"up|down|flat","confidence":0.0-1.0,"analysis":"تحلیل فارسی کوتاه ۲-۳ جمله"},
  "medium":{"direction":"up|down|flat","confidence":0.0-1.0,"analysis":"تحلیل فارسی کوتاه ۲-۳ جمله"},
  "long":{"direction":"up|down|flat","confidence":0.0-1.0,"analysis":"تحلیل فارسی کوتاه ۲-۳ جمله"},
  "overall":"جمع‌بندی کلی ۳-۴ جمله فارسی از وضعیت آینده‌ی بازار ایران"
}`;
    const parsed = await ai.callStructured(prompt);
    const model = ai.resolvedModel();
    if (parsed && parsed.short) {
      return res.json({ ...parsed, regime, model });
    }
    // fallback: use the statistical summaries directly if AI failed
    res.json({
      short: { direction: short.direction, confidence: short.confidence, analysis: `بر اساس ${short.count} پیش‌بینی زنده: ${short.summary}` },
      medium: { direction: medium.direction, confidence: medium.confidence, analysis: `بر اساس ${medium.count} پیش‌بینی زنده: ${medium.summary}` },
      long: { direction: long.direction, confidence: long.confidence, analysis: `بر اساس ${long.count} پیش‌بینی زنده: ${long.summary}` },
      overall: 'تحلیل هوشمند در دسترس نیست — نمایش بر اساس پیش‌بینی‌های زنده‌ی سیستم.',
      regime, model, fallback: true,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EVENTS ──
router.get('/events', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const node = req.query.node || null;
    const since = req.query.since || null;
    // recompute decay on read
    const rows = tdb.getEvents(limit, offset, node, since).map(e => ({
      ...e, decayed_weight: tdb.decayedWeight(e.severity, e.detected_at),
    }));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CHAINS ──
router.get('/chains', (req, res) => {
  try {
    const status = req.query.status || null;
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const rows = (tdb.getChains(status, limit) || []).map(c => ({
      ...c, peak_severity_decayed: tdb.decayedWeight(c.peak_severity, c.started_at),
    }));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/chains/:id', (req, res) => {
  try {
    const chain = tdb.getChain(req.params.id);
    if (!chain) return res.status(404).json({ error: 'زنجیره یافت نشد' });
    res.json(chain);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PREDICTIONS ──
router.get('/predictions', (req, res) => {
  try {
    const status = req.query.status || 'open';
    const filter = req.query.filter || null;
    const limit = Math.min(parseInt(req.query.limit) || 100, 300);
    let rows = tdb.getPredictions(status, filter, limit) || [];
    rows = rows.map(p => {
      const v = tdb.getValidation(p.id);
      return {
        ...p,
        calibrated_confidence: p.calibrated_confidence != null ? p.calibrated_confidence : p.confidence,
        validated: v ? { actual_pct: v.actual_pct, actual_direction: v.actual_direction, overall_score: v.overall_score, skill_score: v.skill_score, excess_pct: v.excess_pct } : null,
      };
    });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/predictions/matrix', (req, res) => {
  try { res.json(predict.getPredictionMatrix()); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/predictions/:id/timeline', (req, res) => {
  try {
    const p = tdb.getPrediction(req.params.id);
    if (!p) return res.status(404).json({ error: 'پیش‌بینی یافت نشد' });
    const updates = tdb.getPredictionTimeline(req.params.id) || [];
    // build confidence series: prior -> each update (calibrated)
    const series = [{ t: p.created_at, confidence: p.prior_confidence != null ? p.prior_confidence : p.confidence, calibrated: p.prior_confidence != null ? p.prior_confidence : p.confidence, desc: 'ایجاد پیش‌بینی' }];
    for (const u of updates) {
      series.push({ t: u.updated_at, confidence: u.new_confidence, calibrated: u.new_calibrated != null ? u.new_calibrated : u.new_confidence, desc: u.trigger_desc, delta: (u.new_confidence - u.prev_confidence) });
    }
    res.json({ prediction: p, series });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── WHAT-IF ──
router.post('/whatif', async (req, res) => {
  try {
    const scenario = (req.body && req.body.scenario) || '';
    const result = await predict.whatIf(scenario);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GRAPH ──
router.get('/graph', (req, res) => {
  try { res.json(graph.getGraphData()); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/leading-indicators', (req, res) => {
  try { res.json(tdb.getIndicators(req.query.target || null) || []); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATTERNS ──
router.get('/patterns', (req, res) => {
  try { res.json(tdb.getPatterns() || []); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SOURCE RELIABILITY ──
router.get('/source-reliability', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 2000);
    res.json({ total: tdb.countSourceReliability(), shown: limit, sources: tdb.getSourceReliabilityList(limit) || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CALIBRATION ──
router.get('/calibration', (req, res) => {
  try {
    const ece = tdb.computeECE();
    res.json({ ece: +ece.toFixed(4), well_calibrated: ece < 0.1, buckets: tdb.getBuckets() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DRIFT ──
router.get('/drift', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    res.json(tdb.getDriftLog(limit) || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CONFIDENCE RIBBON ──
router.get('/confidence-ribbon', (req, res) => {
  try {
    const open = tdb.getOpenPredictions() || [];
    if (!open.length) return res.json({ avg_confidence: 0, count: 0, status: 'warming_up' });
    const avg = open.reduce((s, p) => s + (p.calibrated_confidence != null ? p.calibrated_confidence : p.confidence), 0) / open.length;
    let status = 'low';
    if (avg > 0.7) status = 'high'; else if (avg > 0.4) status = 'medium';
    res.json({ avg_confidence: +avg.toFixed(3), count: open.length, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── REGIME ──
router.get('/regime', (req, res) => {
  try {
    const cur = tdb.getCurrentRegime();
    res.json({ current: cur, history: tdb.getRegimeHistory(10) || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ANOMALY RADAR (6 axes, normalized 0-1) ──
function buildAnomalyRadar() {
  // 1) news severity last 30 min
  const news = (tdb.getEventsSince(30, 'news') || []);
  const newsSev = news.length ? clamp(Math.max(...news.map(e => tdb.decayedWeight(e.severity, e.detected_at))) * 1.5, 0, 1) : 0;
  // 2) trend growth (max growth in h4.json)
  let trendGrowth = 0;
  try {
    const fs = require('fs'); const path = require('path');
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'h4.json'), 'utf8'));
    trendGrowth = clamp(Math.max(0, ...((d.trends || []).map(t => Number(t.growth) || 0))) / 1000, 0, 1);
  } catch (e) {}
  // 3) finance % change (max |pct| last 60 min across symbols)
  const fin = (tdb.getEventsSince(60, null) || []).filter(e => predict.TO_NODES.includes(e.node_key));
  const finPct = fin.length ? clamp(Math.max(...fin.map(e => Math.abs(e.magnitude || 0))) / 3, 0, 1) : 0;
  // 4) polymarket volume — use ACTUAL volume from polymarket.db, not timeline events
  let polyVol = 0;
  try {
    const polyDB = require('./polymarket-db');
    const markets = polyDB.getSortedList('trending', 10) || [];
    if (markets.length) {
      const maxVol = Math.max(...markets.map(m => Number(m.volume24hr) || 0));
      // normalize: 500k = low, 5M = high
      polyVol = clamp((maxVol - 500000) / 4500000, 0, 1);
    }
  } catch (e) {}
  // 5) telegram activity (fin_tg events last 30 min)
  const tg = (tdb.getEventsSince(30, 'fin_tg') || []);
  const tgAct = clamp(tg.length / 10, 0, 1);
  // 6) market volatility (finance events last 120 min)
  const fin2 = (tdb.getEventsSince(120, null) || []).filter(e => predict.TO_NODES.includes(e.node_key));
  const vol = clamp(fin2.length / 12, 0, 1);

  const values = [newsSev, trendGrowth, finPct, polyVol, tgAct, vol];
  const threshold = 0.6;
  const overCount = values.filter(v => v > threshold).length;
  const anomaly = overCount >= 4;
  let message = null;
  if (anomaly) message = `ناهنجاری ترکیبی: ${overCount} از ۶ سیگنال هم‌سو شده‌اند`;
  return {
    axes: ['شدت خبر', 'رشد جستجو', 'تغییر قیمت', 'حجم پلی‌مارکت', 'فعالیت تلگرام', 'نوسان بازار'],
    values: values.map(v => +v.toFixed(3)),
    threshold, anomaly_detected: anomaly, message,
  };
}
router.get('/anomaly-radar', (req, res) => {
  try { res.json(buildAnomalyRadar()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ACCURACY (§10 shape) ──
router.get('/accuracy', (req, res) => {
  try {
    const metrics = tdb.getAccuracyMetrics() || [];
    const overall = metrics.find(m => m.scope === 'all') || {};
    const byTarget = {};
    for (const m of metrics.filter(x => x.scope === 'target')) byTarget[m.scope_key] = { direction_accuracy: m.total ? m.correct_dir / m.total : 0, avg_skill: m.avg_skill || 0, mape: m.mape, total: m.total };

    // by horizon + by regime + improvement from validated predictions
    const preds = (tdb.getPredictions('validated', null, 500) || []).map(p => ({ p, v: tdb.getValidation(p.id) })).filter(x => x.v);
    const byHorizon = {}, byRegime = {};
    const skills = preds.map(x => ({ h: x.p.time_horizon, r: x.p.regime, s: x.v.skill_score || 0 })).sort((a, b) => 0);
    for (const x of preds) {
      const h = x.p.time_horizon + 'h';
      byHorizon[h] = byHorizon[h] || { total: 0, correct: 0 };
      byHorizon[h].total++; if (x.v.direction_correct === 1) byHorizon[h].correct++;
      const r = x.p.regime || 'normal';
      byRegime[r] = byRegime[r] || { total: 0, correct: 0 };
      byRegime[r].total++; if (x.v.direction_correct === 1) byRegime[r].correct++;
    }
    const skillArr = preds.map(x => x.v.skill_score || 0);
    const last10 = skillArr.slice(-10), prev10 = skillArr.slice(-20, -10);
    const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
    const lastSkill = avg(last10), prevSkill = avg(prev10);
    const ece = tdb.computeECE();

    // drift summary
    const driftLog = tdb.getDriftLog(20) || [];
    const driftedPatterns = (tdb.getPatterns() || []).filter(p => (p.concept_drift_score || 0) > 0.3);
    const mostDrifted = driftedPatterns.sort((a, b) => (b.concept_drift_score || 0) - (a.concept_drift_score || 0))[0];

    res.json({
      overall: {
        total: overall.total || preds.length,
        direction_accuracy: overall.total ? overall.correct_dir / overall.total : 0,
        avg_score: overall.avg_score || 0, avg_skill: overall.avg_skill || 0, mape: overall.mape || 0,
      },
      by_target: byTarget,
      by_horizon: Object.fromEntries(Object.entries(byHorizon).map(([k, v]) => [k, v.total ? v.correct / v.total : 0])),
      by_regime: Object.fromEntries(Object.entries(byRegime).map(([k, v]) => [k, v.total ? v.correct / v.total : 0])),
      calibration: { ece: +ece.toFixed(3), well_calibrated: ece < 0.1, buckets: tdb.getBuckets() },
      drift: { patterns_with_drift: driftedPatterns.length, most_drifted: mostDrifted ? `${mostDrifted.trigger_topic}→${mostDrifted.target} (score:${(mostDrifted.concept_drift_score || 0).toFixed(2)})` : null, log: driftLog },
      improvement: { last_10_skill: +lastSkill.toFixed(3), prev_10_skill: +prevSkill.toFixed(3), trend: lastSkill > prevSkill ? 'improving' : (lastSkill < prevSkill ? 'declining' : 'stable') },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BACKTEST (superadmin) ──
router.post('/backtest', require('./auth').requireSuperAdmin, async (req, res) => {
  try {
    const result = await learn.runBacktest();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
