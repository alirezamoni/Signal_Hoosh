/**
 * timeline-db.js — Causal Discovery Engine persistence layer
 * SQLite (better-sqlite3, WAL) at data/timeline.db
 * All schema (§3), default weights, source-reliability seeds, query helpers,
 * time-decay and calibration helpers live here. Other modules import this only.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'timeline.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// ════════════════════════════════════════════════════════
//  SCHEMA
// ════════════════════════════════════════════════════════
db.exec(`
CREATE TABLE IF NOT EXISTS timeline_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  node_key      TEXT NOT NULL,
  source_id     TEXT,
  event_type    TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  topic         TEXT,
  severity      REAL DEFAULT 0,
  decayed_weight REAL DEFAULT 0,
  direction     TEXT,
  magnitude     REAL,
  surprise_score REAL DEFAULT 0,
  expected_value REAL,
  data          TEXT,
  detected_at   TEXT NOT NULL,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS source_reliability (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type   TEXT NOT NULL,
  source_key    TEXT,
  label         TEXT,
  historical_accuracy REAL DEFAULT 0.5,
  bias          TEXT DEFAULT 'unknown',
  update_speed  TEXT DEFAULT 'medium',
  reliability   REAL DEFAULT 0.5,
  sample_count  INTEGER DEFAULT 0,
  last_event    TEXT,
  updated_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(source_type, source_key)
);

CREATE TABLE IF NOT EXISTS signal_edges (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_node     TEXT NOT NULL,
  to_node       TEXT NOT NULL,
  topic         TEXT,
  regime        TEXT DEFAULT 'normal',
  lead_time_min REAL,
  lead_time_std REAL,
  reliability   REAL DEFAULT 0,
  correlation   REAL DEFAULT 0,
  sample_count  INTEGER DEFAULT 0,
  last_confirmed TEXT,
  updated_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(from_node, to_node, topic, regime)
);

CREATE TABLE IF NOT EXISTS signal_chains (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  topic         TEXT NOT NULL,
  category      TEXT,
  regime        TEXT DEFAULT 'normal',
  status        TEXT DEFAULT 'active',
  event_ids     TEXT NOT NULL,
  root_node     TEXT,
  root_causes   TEXT,
  ai_analysis   TEXT,
  peak_severity REAL DEFAULT 0,
  started_at    TEXT NOT NULL,
  resolved_at   TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS predictions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id      INTEGER,
  target        TEXT NOT NULL,
  time_horizon  INTEGER NOT NULL,
  regime        TEXT,
  direction     TEXT NOT NULL,
  predicted_pct REAL,
  predicted_min REAL,
  predicted_max REAL,
  confidence    REAL DEFAULT 0,
  calibrated_confidence REAL,
  prior_confidence REAL,
  base_price    REAL NOT NULL,
  ensemble_json TEXT,
  attribution_json TEXT,
  status        TEXT DEFAULT 'open',
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prediction_updates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  prediction_id INTEGER NOT NULL,
  trigger_event_id INTEGER,
  trigger_desc  TEXT,
  prev_confidence REAL,
  new_confidence  REAL,
  prev_calibrated REAL,
  new_calibrated  REAL,
  prev_pct      REAL,
  new_pct       REAL,
  reason        TEXT,
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prediction_validations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  prediction_id INTEGER NOT NULL UNIQUE,
  actual_price  REAL,
  actual_pct    REAL,
  actual_direction TEXT,
  baseline_pct  REAL,
  excess_pct    REAL,
  direction_correct INTEGER,
  magnitude_error REAL,
  magnitude_in_range INTEGER,
  overall_score REAL,
  skill_score   REAL,
  validated_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calibration_buckets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket_min    REAL NOT NULL,
  bucket_max    REAL NOT NULL,
  total         INTEGER DEFAULT 0,
  correct       INTEGER DEFAULT 0,
  actual_accuracy REAL,
  calibration_error REAL,
  updated_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(bucket_min, bucket_max)
);

CREATE TABLE IF NOT EXISTS pattern_library (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_topic TEXT NOT NULL,
  trigger_node  TEXT,
  target        TEXT NOT NULL,
  time_horizon  INTEGER DEFAULT 24,
  regime        TEXT DEFAULT 'normal',
  outcome_dir   TEXT,
  outcome_pct   REAL,
  avg_lag_min   REAL,
  reliability   REAL DEFAULT 0,
  sample_count  INTEGER DEFAULT 0,
  last_seen     TEXT,
  concept_drift_score REAL DEFAULT 0,
  updated_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(trigger_topic, target, time_horizon, regime)
);

CREATE TABLE IF NOT EXISTS leading_indicators (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  indicator     TEXT NOT NULL,
  target        TEXT NOT NULL,
  regime        TEXT DEFAULT 'normal',
  lead_time_min REAL,
  accuracy      REAL DEFAULT 0,
  correlation   REAL DEFAULT 0,
  sample_count  INTEGER DEFAULT 0,
  updated_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(indicator, target, regime)
);

CREATE TABLE IF NOT EXISTS market_regimes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  regime        TEXT NOT NULL,
  confidence    REAL,
  evidence      TEXT,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS concept_drift_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type  TEXT NOT NULL,
  subject_id    INTEGER NOT NULL,
  metric        TEXT NOT NULL,
  value_old     REAL,
  value_new     REAL,
  window_days   INTEGER,
  drift_significant INTEGER,
  detected_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prediction_weights (
  weight_key    TEXT PRIMARY KEY,
  weight_value  REAL NOT NULL,
  description   TEXT,
  last_adjusted TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accuracy_metrics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  scope         TEXT NOT NULL,
  scope_key     TEXT,
  total         INTEGER DEFAULT 0,
  correct_dir   INTEGER DEFAULT 0,
  mape          REAL,
  avg_score     REAL,
  avg_skill     REAL,
  updated_at    TEXT DEFAULT (datetime('now'))
);
`);

// INDEXES
db.exec(`
CREATE INDEX IF NOT EXISTS idx_ev_detected ON timeline_events(detected_at);
CREATE INDEX IF NOT EXISTS idx_ev_node     ON timeline_events(node_key);
CREATE INDEX IF NOT EXISTS idx_ev_topic    ON timeline_events(topic);
CREATE INDEX IF NOT EXISTS idx_edges_lookup ON signal_edges(from_node, to_node, regime);
CREATE INDEX IF NOT EXISTS idx_chains_topic ON signal_chains(topic);
CREATE INDEX IF NOT EXISTS idx_pred_exp    ON predictions(expires_at, status);
CREATE INDEX IF NOT EXISTS idx_updates_pred ON prediction_updates(prediction_id);
CREATE INDEX IF NOT EXISTS idx_pat_lookup  ON pattern_library(trigger_topic, target, time_horizon, regime);
CREATE INDEX IF NOT EXISTS idx_lead_lookup ON leading_indicators(target, regime);
CREATE INDEX IF NOT EXISTS idx_regime_cur  ON market_regimes(ended_at);
CREATE INDEX IF NOT EXISTS idx_calib_bucket ON calibration_buckets(bucket_min, bucket_max);
CREATE INDEX IF NOT EXISTS idx_drift_lookup ON concept_drift_log(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_src_lookup  ON source_reliability(source_type, source_key);
CREATE INDEX IF NOT EXISTS idx_chain_status ON signal_chains(status);
`);

// ════════════════════════════════════════════════════════
//  SEEDS — default weights + source reliability + calibration buckets
// ════════════════════════════════════════════════════════
const _seedWeight = db.prepare(
  'INSERT OR IGNORE INTO prediction_weights (weight_key, weight_value, description) VALUES (?,?,?)'
);
const DEFAULT_WEIGHTS = [
  ['decay_lambda', 0.0058, 'exponential decay rate per minute (half-life ~120min)'],
  ['MIN_SAMPLES', 5, 'min samples before an edge/pattern is usable'],
  ['edge_min_reliability', 0.55, 'reliability threshold for a usable graph edge'],
  ['calibration_needed', 0, '1 when ECE > 0.1 and recalibration requested'],
  ['drift_penalty_factor', 0.5, 'how aggressively drift reduces edge weight'],
  ['w_model_a', 0.40, 'ensemble weight: historical/pattern model'],
  ['w_model_b', 0.30, 'ensemble weight: similarity model'],
  ['w_model_c', 0.30, 'ensemble weight: LLM reasoning model'],
  ['lr_base', 0.1, 'base learning rate for weight adjustment'],
  ['lr_decay', 0.97, 'learning-rate decay factor per 10 validations'],
  ['drift_window_days', 30, 'window for rolling-window drift comparison'],
  ['drift_threshold', 0.15, 'min |recent-historical| accuracy delta to flag drift'],
  ['drift_archive_score', 0.6, 'concept_drift_score above which a pattern is archived'],
  ['src_acc_win', 0.01, 'source accuracy increment on correct prediction'],
  ['src_acc_loss', 0.02, 'source accuracy decrement on wrong prediction (penalized harder)'],
  ['src_min', 0.05, 'lower cap on source reliability'],
  ['src_max', 0.95, 'upper cap on source reliability'],
  ['validation_interval_min', 10, 'minutes between validation passes'],
  ['fast_loop_interval_sec', 60, 'seconds between event-detection fast loop'],
  ['graph_discovery_interval_min', 30, 'minutes between lead/lag discovery runs'],
  ['cascade_interval_min', 2, 'minutes between cascade assembly runs'],
  ['regime_interval_min', 30, 'minutes between regime classification runs'],
];
const _seedWeights = db.transaction(() => DEFAULT_WEIGHTS.forEach(w => _seedWeight.run(...w)));
_seedWeights();

const _seedSrc = db.prepare(
  `INSERT OR IGNORE INTO source_reliability
   (source_type, source_key, label, historical_accuracy, bias, update_speed, reliability, sample_count)
   VALUES (?,?,?,?,?,?,?,?)`
);
const DEFAULT_SOURCES = [
  ['news_agency', null, 'خبرگزاری‌های رسمی', 0.85, 'neutral', 'fast', 0.85, 0],
  ['telegram_channel', null, 'کانال تلگرامی خبری', 0.50, 'unknown', 'fast', 0.50, 0],
  ['finance_tg', null, 'کانال تلگرامی قیمت', 0.75, 'neutral', 'real_time', 0.75, 0],
  ['rss', null, 'Google Trends RSS', 0.75, 'neutral', 'medium', 0.75, 0],
  ['polymarket', null, 'Polymarket', 0.70, 'neutral', 'medium', 0.70, 0],
  ['finance_api', null, 'tgju.org', 0.90, 'neutral', 'fast', 0.90, 0],
];
// NOTE: UNIQUE(source_type, source_key) cannot dedupe the default rows because
// SQLite treats NULLs as distinct, so every module load would append duplicates.
// Guard explicitly on (source_type, source_key IS NULL).
const _srcDefaultExists = db.prepare('SELECT 1 FROM source_reliability WHERE source_type=? AND source_key IS NULL');
const _seedSrcs = db.transaction(() => DEFAULT_SOURCES.forEach(s => {
  if (!_srcDefaultExists.get(s[0])) _seedSrc.run(...s);
}));
_seedSrcs();

// seed 10 calibration buckets [0.0-0.1 ... 0.9-1.0]
const _seedBucket = db.prepare(
  'INSERT OR IGNORE INTO calibration_buckets (bucket_min, bucket_max, total, correct, actual_accuracy, calibration_error) VALUES (?,?,0,0,0,0)'
);
const _seedBuckets = db.transaction(() => {
  for (let i = 0; i < 10; i++) {
    const lo = i / 10, hi = (i + 1) / 10;
    _seedBucket.run(lo, hi);
  }
});
_seedBuckets();

// ════════════════════════════════════════════════════════
//  WEIGHTS
// ════════════════════════════════════════════════════════
const _getWeight = db.prepare('SELECT weight_value FROM prediction_weights WHERE weight_key=?');
function getWeight(key, fallback) {
  const r = _getWeight.get(key);
  return r ? r.weight_value : (fallback !== undefined ? fallback : null);
}
function setWeight(key, value, description) {
  db.prepare(`INSERT INTO prediction_weights (weight_key, weight_value, description, last_adjusted)
              VALUES (?,?,?,datetime('now'))
              ON CONFLICT(weight_key) DO UPDATE SET weight_value=excluded.weight_value, last_adjusted=datetime('now')`)
    .run(key, value, description || null);
}
function getWeights() {
  return db.prepare('SELECT * FROM prediction_weights').all().reduce((o, r) => { o[r.weight_key] = r.weight_value; return o; }, {});
}

// ════════════════════════════════════════════════════════
//  TIME DECAY  (§4)
// ════════════════════════════════════════════════════════
function decayedWeight(severity, detectedAt, lambda) {
  const lam = lambda != null ? lambda : getWeight('decay_lambda', 0.0058);
  const t = typeof detectedAt === 'string' ? new Date(detectedAt).getTime() : (detectedAt || Date.now());
  let ageMin = (Date.now() - t) / 60000;
  if (!isFinite(ageMin) || ageMin < 0) ageMin = 0;
  return severity * Math.exp(-lam * ageMin);
}

// ════════════════════════════════════════════════════════
//  EVENTS
// ════════════════════════════════════════════════════════
const _insEvent = db.prepare(
  `INSERT INTO timeline_events
   (source,node_key,source_id,event_type,title,description,topic,severity,direction,magnitude,surprise_score,expected_value,data,detected_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
);
function insertEvent(ev) {
  const r = _insEvent.run(
    ev.source, ev.node_key, ev.source_id || null, ev.event_type, ev.title,
    ev.description || null, ev.topic || null, ev.severity || 0,
    ev.direction || null, ev.magnitude || null, ev.surprise_score || 0,
    ev.expected_value || null, ev.data || null, ev.detected_at || new Date().toISOString()
  );
  return r.lastInsertRowid;
}
const _updEventDecay = db.prepare('UPDATE timeline_events SET decayed_weight=? WHERE id=?');
function recomputeDecay(id) {
  const ev = getEvent(id);
  if (!ev) return;
  _updEventDecay.run(decayedWeight(ev.severity, ev.detected_at), id);
}
function getEvent(id) { return db.prepare('SELECT * FROM timeline_events WHERE id=?').get(id); }
function getEventsSince(minutes, nodeKey) {
  // detected_at is ISO-8601 from JS; without datetime() the raw-string compare made
  // every event from today pass, so "last 3 minutes" was returning ~900 rows.
  const params = [`-${minutes} minutes`];
  let sql = `SELECT * FROM timeline_events WHERE datetime(detected_at) >= datetime('now',?)`;
  if (nodeKey) { sql += ' AND node_key=?'; params.push(nodeKey); }
  sql += ' ORDER BY detected_at DESC';
  return db.prepare(sql).all(...params);
}
function getEvents(limit, offset, node, since) {
  const where = []; const params = [];
  if (node) { where.push('node_key=?'); params.push(node); }
  if (since) { where.push('detected_at >= ?'); params.push(since); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  params.push(limit || 50, offset || 0);
  return db.prepare(`SELECT * FROM timeline_events ${w} ORDER BY detected_at DESC LIMIT ? OFFSET ?`).all(...params);
}
function getUnlinkedEvents(hours) {
  // events in last `hours` not referenced by any ACTIVE chain (archived chains release their events)
  return db.prepare(`
    SELECT e.* FROM timeline_events e
    WHERE datetime(e.detected_at) >= datetime('now', ?)
      AND e.id NOT IN (
        SELECT value FROM signal_chains, json_each(json_extract(signal_chains.event_ids,'$.roots')) WHERE signal_chains.status='active'
        UNION
        SELECT value FROM signal_chains, json_each(json_extract(signal_chains.event_ids,'$.edges')) WHERE signal_chains.status='active'
        UNION
        SELECT value FROM signal_chains, json_each(json_extract(signal_chains.root_causes,'$')) WHERE signal_chains.status='active'
      )
    ORDER BY e.detected_at ASC
  `).all(`-${hours || 6} hours`);
}
function getLatestByNodeTopic(nodeKey, topic, minutes) {
  return db.prepare(`
    SELECT * FROM timeline_events
    WHERE node_key=? AND (topic=? OR ? IS NULL)
      AND datetime(detected_at) >= datetime('now',?)
    ORDER BY detected_at DESC LIMIT 1
  `).get(nodeKey, topic, topic, `-${minutes || 30} minutes`);
}
function countEventsByNode(nodeKey, minutes) {
  const r = db.prepare(`
    SELECT COUNT(*) c FROM timeline_events
    WHERE node_key=? AND datetime(detected_at) >= datetime('now',?)
  `).get(nodeKey, `-${minutes || 60} minutes`);
  return r ? r.c : 0;
}

// ════════════════════════════════════════════════════════
//  SOURCE RELIABILITY  (§5.7)
// ════════════════════════════════════════════════════════
const _srcExact = db.prepare('SELECT * FROM source_reliability WHERE source_type=? AND source_key=?');
const _srcDefault = db.prepare('SELECT * FROM source_reliability WHERE source_type=? AND source_key IS NULL');
function getReliabilityForSource(sourceType, sourceKey) {
  if (sourceKey) {
    const r = _srcExact.get(sourceType, sourceKey);
    if (r) return r;
  }
  const d = _srcDefault.get(sourceType);
  return d || { reliability: 0.5, historical_accuracy: 0.5, source_type: sourceType, source_key: null, label: sourceType };
}
function getSourceReliabilityList() {
  return db.prepare('SELECT * FROM source_reliability ORDER BY reliability DESC').all();
}
const _upsertSrc = db.prepare(`
  INSERT INTO source_reliability (source_type,source_key,label,historical_accuracy,bias,update_speed,reliability,sample_count,last_event,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
  ON CONFLICT(source_type,source_key) DO UPDATE SET
    label=COALESCE(excluded.label,label),
    historical_accuracy=excluded.historical_accuracy,
    bias=COALESCE(excluded.bias,bias),
    update_speed=COALESCE(excluded.update_speed,update_speed),
    reliability=excluded.reliability,
    sample_count=excluded.sample_count,
    last_event=excluded.last_event,
    updated_at=datetime('now')
`);
function upsertSourceReliability(src) {
  _upsertSrc.run(
    src.source_type, src.source_key || null, src.label || null,
    src.historical_accuracy != null ? src.historical_accuracy : 0.5,
    src.bias || 'unknown', src.update_speed || 'medium',
    src.reliability != null ? src.reliability : 0.5,
    src.sample_count || 0, src.last_event || null
  );
}
function adjustSourceAccuracy(sourceType, sourceKey, correct) {
  const cur = getReliabilityForSource(sourceType, sourceKey);
  const inc = getWeight('src_acc_win', 0.01);
  const loss = getWeight('src_acc_loss', 0.02);
  let acc = (cur.historical_accuracy || 0.5) + (correct ? inc : -loss);
  acc = Math.max(getWeight('src_min', 0.05), Math.min(getWeight('src_max', 0.95), acc));
  const samples = (cur.sample_count || 0) + 1;
  const days = cur.last_event ? (Date.now() - new Date(cur.last_event).getTime()) / 86400000 : 0;
  const lam = getWeight('decay_lambda', 0.0058) * 60; // per hour-ish baseline
  const recency = Math.exp(-lam * days / 24);
  const reliability = Math.max(getWeight('src_min', 0.05), Math.min(getWeight('src_max', 0.95), acc * recency));
  _upsertSrc.run(sourceType, cur.source_key || sourceKey || null, cur.label,
    acc, cur.bias || 'unknown', cur.update_speed || 'medium', reliability, samples, new Date().toISOString());
  return { accuracy: acc, reliability };
}

// ════════════════════════════════════════════════════════
//  SIGNAL EDGES  (§6.1)
// ════════════════════════════════════════════════════════
const _upsertEdge = db.prepare(`
  INSERT INTO signal_edges (from_node,to_node,topic,regime,lead_time_min,lead_time_std,reliability,correlation,sample_count,last_confirmed,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))
  ON CONFLICT(from_node,to_node,topic,regime) DO UPDATE SET
    lead_time_min=excluded.lead_time_min,
    lead_time_std=excluded.lead_time_std,
    reliability=excluded.reliability,
    correlation=excluded.correlation,
    sample_count=excluded.sample_count,
    last_confirmed=excluded.last_confirmed,
    updated_at=datetime('now')
`);
function upsertEdge(e) {
  _upsertEdge.run(e.from_node, e.to_node, e.topic || null, e.regime || 'normal',
    e.lead_time_min, e.lead_time_std || null, e.reliability || 0, e.correlation || 0,
    e.sample_count || 0, e.last_confirmed || null);
}
function getEdges() { return db.prepare('SELECT * FROM signal_edges ORDER BY reliability DESC').all(); }
function getUsableEdges() {
  const minRel = getWeight('edge_min_reliability', 0.55);
  const minSamp = getWeight('MIN_SAMPLES', 5);
  return db.prepare(`SELECT * FROM signal_edges WHERE reliability >= ? AND sample_count >= ? ORDER BY reliability DESC`)
    .all(minRel, minSamp);
}
function getEdgesFrom(node, regime) {
  return db.prepare(`SELECT * FROM signal_edges WHERE from_node=? AND (regime=? OR regime='normal') ORDER BY reliability DESC`)
    .all(node, regime || 'normal');
}
function getEdgeTo(target, regime) {
  return db.prepare(`SELECT * FROM signal_edges WHERE to_node=? AND (regime=? OR regime='normal') ORDER BY reliability DESC`)
    .all(target, regime || 'normal');
}

// ════════════════════════════════════════════════════════
//  CHAINS (root cause trees)  (§6.2)
// ════════════════════════════════════════════════════════
function insertChain(c) {
  const r = db.prepare(
    `INSERT INTO signal_chains (title,topic,category,regime,status,event_ids,root_node,root_causes,ai_analysis,peak_severity,started_at,resolved_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(c.title, c.topic, c.category || null, c.regime || 'normal', c.status || 'active',
    c.event_ids, c.root_node || null, c.root_causes || null, c.ai_analysis || null,
    c.peak_severity || 0, c.started_at || new Date().toISOString(), c.resolved_at || null);
  return r.lastInsertRowid;
}
function updateChain(id, patch) {
  const cur = db.prepare('SELECT * FROM signal_chains WHERE id=?').get(id);
  if (!cur) return;
  const fields = ['title','topic','category','regime','status','event_ids','root_node','root_causes','ai_analysis','peak_severity','resolved_at'];
  const sets = []; const vals = [];
  for (const f of fields) {
    if (patch[f] !== undefined) { sets.push(`${f}=?`); vals.push(patch[f]); }
  }
  if (!sets.length) return;
  vals.push(id);
  db.prepare(`UPDATE signal_chains SET ${sets.join(', ')} WHERE id=?`).run(...vals);
}
function getChains(status, limit) {
  if (status) return db.prepare('SELECT * FROM signal_chains WHERE status=? ORDER BY started_at DESC LIMIT ?').all(status, limit || 30);
  return db.prepare('SELECT * FROM signal_chains ORDER BY started_at DESC LIMIT ?').all(limit || 30);
}
function getChain(id) {
  const chain = db.prepare('SELECT * FROM signal_chains WHERE id=?').get(id);
  if (!chain) return null;
  let eventIds = { roots: [], edges: [] };
  try { eventIds = JSON.parse(chain.event_ids) || eventIds; } catch (e) {}
  const ids = new Set();
  (eventIds.roots || []).forEach(x => ids.add(x));
  (eventIds.edges || []).forEach(([a, b]) => { ids.add(a); ids.add(b); });
  const events = ids.size ? db.prepare(`SELECT * FROM timeline_events WHERE id IN (${[...ids].map(() => '?').join(',')}) ORDER BY detected_at ASC`).all(...ids) : [];
  const causes = (chain.root_causes ? JSON.parse(chain.root_causes) : (eventIds.roots || []));
  return { ...chain, eventIds, events, root_causes: causes };
}
function resolveChain(id) {
  updateChain(id, { status: 'resolved', resolved_at: new Date().toISOString() });
}

// ════════════════════════════════════════════════════════
//  PREDICTIONS  (§8)
// ════════════════════════════════════════════════════════
function insertPrediction(p) {
  const r = db.prepare(
    `INSERT INTO predictions
     (chain_id,target,time_horizon,regime,direction,predicted_pct,predicted_min,predicted_max,confidence,calibrated_confidence,prior_confidence,base_price,ensemble_json,attribution_json,status,created_at,expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(p.chain_id || null, p.target, p.time_horizon, p.regime || 'normal', p.direction,
    p.predicted_pct, p.predicted_min || null, p.predicted_max || null,
    p.confidence || 0, p.calibrated_confidence != null ? p.calibrated_confidence : p.confidence,
    p.prior_confidence != null ? p.prior_confidence : p.confidence,
    p.base_price, p.ensemble_json || null, p.attribution_json || null, p.status || 'open',
    p.created_at || new Date().toISOString(), p.expires_at);
  return r.lastInsertRowid;
}
function updatePrediction(id, patch) {
  const cur = db.prepare('SELECT * FROM predictions WHERE id=?').get(id);
  if (!cur) return;
  const fields = ['chain_id','target','time_horizon','regime','direction','predicted_pct','predicted_min','predicted_max','confidence','calibrated_confidence','base_price','ensemble_json','attribution_json','status','expires_at'];
  const sets = []; const vals = [];
  for (const f of fields) {
    if (patch[f] !== undefined) { sets.push(`${f}=?`); vals.push(patch[f]); }
  }
  if (!sets.length) return;
  vals.push(id);
  db.prepare(`UPDATE predictions SET ${sets.join(', ')} WHERE id=?`).run(...vals);
}
function getPrediction(id) { return db.prepare('SELECT * FROM predictions WHERE id=?').get(id); }
function getOpenPredictions() {
  return db.prepare("SELECT * FROM predictions WHERE status='open' ORDER BY created_at DESC").all();
}
function getPredictions(status, filter, limit) {
  let sql = 'SELECT * FROM predictions';
  const where = []; const params = [];
  if (status) { where.push('status=?'); params.push(status); }
  sql += where.length ? ' WHERE ' + where.join(' AND ') : '';
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit || 100);
  let rows = db.prepare(sql).all(...params);
  if (filter) {
    rows = rows.filter(p => {
      const v = db.prepare('SELECT * FROM prediction_validations WHERE prediction_id=?').get(p.id);
      if (filter === 'correct') return v && v.direction_correct === 1;
      if (filter === 'wrong') return v && v.direction_correct === 0;
      if (filter === 'high_conf') return (p.calibrated_confidence || p.confidence) >= 0.7;
      return true;
    });
  }
  return rows;
}
function getExpiredOpen() {
  // datetime() on BOTH sides is required: expires_at is written from JS as ISO-8601
  // ("2026-08-03T20:41:11.758Z") while datetime('now') yields "2026-08-03 23:04:12".
  // Compared as raw strings the 'T' (0x54) sorts after the space (0x20), so an expired
  // prediction never satisfied <= and NOTHING was ever validated — the learning loop
  // had been starved since day one.
  return db.prepare("SELECT * FROM predictions WHERE status='open' AND datetime(expires_at) <= datetime('now')").all();
}
function insertPredictionUpdate(u) {
  db.prepare(
    `INSERT INTO prediction_updates (prediction_id,trigger_event_id,trigger_desc,prev_confidence,new_confidence,prev_calibrated,new_calibrated,prev_pct,new_pct,reason)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(u.prediction_id, u.trigger_event_id || null, u.trigger_desc || null,
    u.prev_confidence, u.new_confidence, u.prev_calibrated, u.new_calibrated, u.prev_pct, u.new_pct, u.reason || null);
}
function getPredictionTimeline(id) {
  return db.prepare('SELECT * FROM prediction_updates WHERE prediction_id=? ORDER BY updated_at ASC').all(id);
}

// ════════════════════════════════════════════════════════
//  VALIDATIONS  (§9)
// ════════════════════════════════════════════════════════
function insertValidation(v) {
  db.prepare(
    `INSERT INTO prediction_validations (prediction_id,actual_price,actual_pct,actual_direction,baseline_pct,excess_pct,direction_correct,magnitude_error,magnitude_in_range,overall_score,skill_score)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(prediction_id) DO UPDATE SET
       actual_price=excluded.actual_price, actual_pct=excluded.actual_pct,
       actual_direction=excluded.actual_direction, baseline_pct=excluded.baseline_pct,
       excess_pct=excluded.excess_pct, direction_correct=excluded.direction_correct,
       magnitude_error=excluded.magnitude_error, magnitude_in_range=excluded.magnitude_in_range,
       overall_score=excluded.overall_score, skill_score=excluded.skill_score,
       validated_at=datetime('now')`
  ).run(v.prediction_id, v.actual_price, v.actual_pct, v.actual_direction, v.baseline_pct, v.excess_pct,
    v.direction_correct, v.magnitude_error, v.magnitude_in_range, v.overall_score, v.skill_score);
}
function getValidation(id) { return db.prepare('SELECT * FROM prediction_validations WHERE prediction_id=?').get(id); }
function getRecentValidations(limit) {
  return db.prepare('SELECT * FROM prediction_validations ORDER BY validated_at DESC LIMIT ?').all(limit || 50);
}
function countValidations() { return db.prepare('SELECT COUNT(*) c FROM prediction_validations').get().c; }

// ════════════════════════════════════════════════════════
//  CALIBRATION  (§8.6)
// ════════════════════════════════════════════════════════
function bucketOf(confidence) { return Math.floor((confidence || 0) * 10) / 10; }
const _bumpBucket = db.prepare(
  `UPDATE calibration_buckets SET total=total+1, correct=correct+?, actual_accuracy=CAST(correct AS REAL)/MAX(total,1), updated_at=datetime('now')
   WHERE bucket_min=?`
);
function updateCalibrationBucket(confidence, correct) {
  const lo = bucketOf(confidence);
  _bumpBucket.run(correct ? 1 : 0, lo);
  recomputeBucketAccuracy(lo);
}
function recomputeBucketAccuracy(lo) {
  const b = db.prepare('SELECT * FROM calibration_buckets WHERE bucket_min=?').get(lo);
  if (!b) return;
  const acc = b.total > 0 ? b.correct / b.total : 0;
  const center = lo + 0.05;
  const err = Math.abs(center - acc);
  db.prepare('UPDATE calibration_buckets SET actual_accuracy=?, calibration_error=?, updated_at=datetime(\'now\') WHERE bucket_min=?')
    .run(acc, err, lo);
}
function getBuckets() {
  return db.prepare('SELECT * FROM calibration_buckets ORDER BY bucket_min ASC').all();
}
// Expected Calibration Error
function computeECE() {
  const buckets = getBuckets();
  let total = 0, ece = 0;
  for (const b of buckets) {
    total += b.total;
  }
  if (!total) return 0;
  for (const b of buckets) {
    if (!b.total) continue;
    const center = b.bucket_min + 0.05;
    const weight = b.total / total;
    ece += weight * Math.abs(center - (b.actual_accuracy || 0));
  }
  return ece;
}
// Isotonic regression on validated predictions: returns a function-like map of (raw -> calibrated)
function isotonicCalibrate(rawConfidence) {
  const n = countValidations();
  if (n < 20) return rawConfidence; // Phase 1: not enough data
  const bins = n < 100 ? 5 : 10;
  const rows = db.prepare(`
    SELECT p.confidence AS raw, v.direction_correct AS correct
    FROM predictions p JOIN prediction_validations v ON v.prediction_id=p.id
    ORDER BY p.confidence ASC
  `).all();
  if (rows.length < 20) return rawConfidence;
  const size = Math.ceil(rows.length / bins);
  const points = [];
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    if (!chunk.length) break;
    const avgConf = chunk.reduce((s, r) => s + r.raw, 0) / chunk.length;
    const acc = chunk.reduce((s, r) => s + (r.correct ? 1 : 0), 0) / chunk.length;
    points.push({ avgConf, acc });
  }
  // enforce monotonic non-decreasing via pool-adjacent-violators (simplified)
  for (let i = 1; i < points.length; i++) {
    if (points[i].acc < points[i - 1].acc) points[i].acc = points[i - 1].acc;
  }
  // interpolate
  if (rawConfidence <= points[0].avgConf) return points[0].acc;
  if (rawConfidence >= points[points.length - 1].avgConf) return points[points.length - 1].acc;
  for (let i = 1; i < points.length; i++) {
    if (rawConfidence <= points[i].avgConf) {
      const a = points[i - 1], b = points[i];
      const t = (rawConfidence - a.avgConf) / Math.max(1e-9, b.avgConf - a.avgConf);
      return a.acc + t * (b.acc - a.acc);
    }
  }
  return rawConfidence;
}
// Platt scaling: sigmoid a*raw + b, fit via simple gradient descent on validated rows
let _platt = null;
function fitPlatt() {
  const rows = db.prepare(`
    SELECT p.confidence AS raw, v.direction_correct AS correct
    FROM predictions p JOIN prediction_validations v ON v.prediction_id=p.id
  `).all();
  if (rows.length < 30) return null;
  let a = 0, b = 0; // start: identity-ish
  const lr = 0.05;
  for (let epoch = 0; epoch < 400; epoch++) {
    let ga = 0, gb = 0;
    for (const r of rows) {
      const z = a * r.raw + b;
      const p = 1 / (1 + Math.exp(-z));
      const err = p - (r.correct ? 1 : 0);
      ga += err * r.raw; gb += err;
    }
    a -= lr * ga / rows.length;
    b -= lr * gb / rows.length;
  }
  _platt = { a, b };
  return _platt;
}
function plattCalibrate(rawConfidence) {
  if (!_platt) fitPlatt();
  if (!_platt) return rawConfidence;
  const z = _platt.a * rawConfidence + _platt.b;
  return 1 / (1 + Math.exp(-z));
}
function calibrate(rawConfidence) {
  // Phase 1 (<20): raw. Phase 2 (20-100): isotonic-5. Phase 3 (>100): isotonic-10 OR platt (lower ECE).
  const n = countValidations();
  if (n < 20) return rawConfidence;
  if (n < 100) return isotonicCalibrate(rawConfidence);
  // choose lower-ECE method by quick estimate
  const iso = isotonicCalibrate(rawConfidence);
  const plt = plattCalibrate(rawConfidence);
  // prefer platt if model fit exists and ECE lower (heuristic: closer to bucket actual near this conf)
  const b = db.prepare('SELECT actual_accuracy FROM calibration_buckets WHERE bucket_min=?').get(bucketOf(rawConfidence));
  if (b && b.actual_accuracy != null) {
    return Math.abs(plt - b.actual_accuracy) <= Math.abs(iso - b.actual_accuracy) ? plt : iso;
  }
  return iso;
}

// ════════════════════════════════════════════════════════
//  PATTERN LIBRARY  (§9.3, §9.5)
// ════════════════════════════════════════════════════════
const _upsertPat = db.prepare(`
  INSERT INTO pattern_library (trigger_topic,trigger_node,target,time_horizon,regime,outcome_dir,outcome_pct,avg_lag_min,reliability,sample_count,last_seen,concept_drift_score)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(trigger_topic,target,time_horizon,regime) DO UPDATE SET
    trigger_node=COALESCE(excluded.trigger_node,trigger_node),
    outcome_dir=excluded.outcome_dir, outcome_pct=excluded.outcome_pct,
    avg_lag_min=excluded.avg_lag_min, reliability=excluded.reliability,
    sample_count=excluded.sample_count, last_seen=excluded.last_seen,
    concept_drift_score=excluded.concept_drift_score, updated_at=datetime('now')
`);
function upsertPattern(p) {
  _upsertPat.run(p.trigger_topic, p.trigger_node || null, p.target, p.time_horizon || 24, p.regime || 'normal',
    p.outcome_dir || null, p.outcome_pct, p.avg_lag_min, p.reliability || 0, p.sample_count || 0,
    p.last_seen || new Date().toISOString(), p.concept_drift_score || 0);
}
function getPatterns() { return db.prepare('SELECT * FROM pattern_library ORDER BY sample_count DESC').all(); }
function getPattern(triggerTopic, target, horizon, regime) {
  return db.prepare('SELECT * FROM pattern_library WHERE trigger_topic=? AND target=? AND time_horizon=? AND regime=?')
    .get(triggerTopic, target, horizon, regime);
}
function getPatternsForTopic(topic, target, regime) {
  return db.prepare(`SELECT * FROM pattern_library WHERE trigger_topic LIKE ? AND target=? AND (regime=? OR regime='normal') ORDER BY sample_count DESC`)
    .all(`%${topic}%`, target, regime || 'normal');
}
function setPatternDrift(id, score) {
  db.prepare('UPDATE pattern_library SET concept_drift_score=?, updated_at=datetime(\'now\') WHERE id=?').run(score, id);
}

// ════════════════════════════════════════════════════════
//  LEADING INDICATORS
// ════════════════════════════════════════════════════════
const _upsertInd = db.prepare(`
  INSERT INTO leading_indicators (indicator,target,regime,lead_time_min,accuracy,correlation,sample_count)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(indicator,target,regime) DO UPDATE SET
    lead_time_min=excluded.lead_time_min, accuracy=excluded.accuracy,
    correlation=excluded.correlation, sample_count=excluded.sample_count, updated_at=datetime('now')
`);
function upsertIndicator(i) {
  _upsertInd.run(i.indicator, i.target, i.regime || 'normal', i.lead_time_min, i.accuracy || 0, i.correlation || 0, i.sample_count || 0);
}
function getIndicators(target) {
  if (target) return db.prepare('SELECT * FROM leading_indicators WHERE target=? ORDER BY lead_time_min ASC').all(target);
  return db.prepare('SELECT * FROM leading_indicators ORDER BY lead_time_min ASC').all();
}

// ════════════════════════════════════════════════════════
//  REGIMES
// ════════════════════════════════════════════════════════
function getCurrentRegime() {
  return db.prepare("SELECT * FROM market_regimes WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1").get();
}
function insertRegime(r) {
  // close any open regime first
  db.prepare("UPDATE market_regimes SET ended_at=datetime('now') WHERE ended_at IS NULL").run();
  const res = db.prepare(
    "INSERT INTO market_regimes (regime,confidence,evidence,started_at,ended_at) VALUES (?,?,?,? ,NULL)"
  ).run(r.regime, r.confidence, r.evidence, r.started_at || new Date().toISOString());
  return res.lastInsertRowid;
}
function getRegimeHistory(limit) {
  return db.prepare("SELECT * FROM market_regimes ORDER BY started_at DESC LIMIT ?").all(limit || 20);
}

// ════════════════════════════════════════════════════════
//  DRIFT LOG
// ════════════════════════════════════════════════════════
function insertDriftLog(d) {
  db.prepare(
    `INSERT INTO concept_drift_log (subject_type,subject_id,metric,value_old,value_new,window_days,drift_significant)
     VALUES (?,?,?,?,?,?,?)`
  ).run(d.subject_type, d.subject_id, d.metric, d.value_old, d.value_new, d.window_days, d.drift_significant ? 1 : 0);
}
function getDriftLog(limit) {
  return db.prepare('SELECT * FROM concept_drift_log ORDER BY detected_at DESC LIMIT ?').all(limit || 50);
}

// ════════════════════════════════════════════════════════
//  ACCURACY METRICS
// ════════════════════════════════════════════════════════
function upsertAccuracyMetric(scope, scopeKey, m) {
  const cur = db.prepare('SELECT * FROM accuracy_metrics WHERE scope=? AND (scope_key IS ? OR (scope_key=? AND scope_key IS NOT NULL))')
    .get(scope, scopeKey || null, scopeKey || null);
  if (cur) {
    db.prepare('UPDATE accuracy_metrics SET total=?, correct_dir=?, mape=?, avg_score=?, avg_skill=?, updated_at=datetime(\'now\') WHERE id=?')
      .run(m.total, m.correct_dir, m.mape, m.avg_score, m.avg_skill, cur.id);
  } else {
    db.prepare('INSERT INTO accuracy_metrics (scope,scope_key,total,correct_dir,mape,avg_score,avg_skill) VALUES (?,?,?,?,?,?,?)')
      .run(scope, scopeKey || null, m.total, m.correct_dir, m.mape, m.avg_score, m.avg_skill);
  }
}
function getAccuracyMetrics() { return db.prepare('SELECT * FROM accuracy_metrics').all(); }

// ════════════════════════════════════════════════════════
//  TOPIC CATEGORIZATION
// ════════════════════════════════════════════════════════
// Raw keyword topics ("مقتدی صدر", "امید عالیشاه") almost never repeat, so a
// pattern library keyed on them would stay at sample_count=1 forever and never
// become usable. Patterns are therefore keyed on a stable CATEGORY so evidence
// accumulates across events and predictions can actually improve over time.
const TOPIC_CATEGORIES = [
  ['war',       /جنگ|حمله|موشک|پهپاد|انفجار|شهید|ارتش|نظامی|درگیری|تجاوز|سرنگون|بمب|جنگنده|موشکی|حشد|اسرائیل|تنش/],
  ['sanctions', /تحریم|FATF|برجام|مذاکر|آژانس|هسته|غنی‌?سازی|سازمان ملل|قطعنامه/],
  ['oil',       /نفت|اوپک|OPEC|بشکه|گاز|پالایش|تنگه هرمز|صادرات انرژی/],
  ['election',  /انتخابات|رأی|رای‌?گیری|کاندید|نامزد|مجلس|ریاست‌?جمهوری/],
  ['economy',   /تورم|بورس|ارز|دلار|طلا|سکه|بانک|بودجه|یارانه|قیمت|بازار|اقتصاد|نقدینگی|رشد اقتصادی/],
  ['politics',  /وزیر|رئیس|دولت|سفارت|دیپلمات|عزل|استیضاح|مسئولان|سیاست/],
  ['social',    /اعتراض|تجمع|اعتصاب|زلزله|سیل|حادثه|آتش‌?سوزی|تشییع/],
];
function categorizeTopic(topic) {
  if (!topic) return 'general';
  const t = String(topic);
  for (const [cat, re] of TOPIC_CATEGORIES) {
    if (re.test(t)) return cat;
  }
  return 'general';
}

module.exports = {
  db,
  // weights
  getWeight, setWeight, getWeights,
  // decay
  decayedWeight, recomputeDecay,
  // events
  insertEvent, getEvent, getEvents, getEventsSince, getUnlinkedEvents, getLatestByNodeTopic, countEventsByNode,
  // source reliability
  getReliabilityForSource, getSourceReliabilityList, upsertSourceReliability, adjustSourceAccuracy,
  // edges
  upsertEdge, getEdges, getUsableEdges, getEdgesFrom, getEdgeTo,
  // chains
  insertChain, updateChain, getChains, getChain, resolveChain,
  // predictions
  insertPrediction, updatePrediction, getPrediction, getOpenPredictions, getPredictions, getExpiredOpen,
  insertPredictionUpdate, getPredictionTimeline,
  // validations
  insertValidation, getValidation, getRecentValidations, countValidations,
  // calibration
  updateCalibrationBucket, getBuckets, computeECE, calibrate, fitPlatt, isotonicCalibrate, plattCalibrate, bucketOf,
  // patterns
  upsertPattern, getPatterns, getPattern, getPatternsForTopic, setPatternDrift,
  // indicators
  upsertIndicator, getIndicators,
  // regimes
  getCurrentRegime, insertRegime, getRegimeHistory,
  // drift
  insertDriftLog, getDriftLog,
  // accuracy
  upsertAccuracyMetric, getAccuracyMetrics,
  // topic categorization
  categorizeTopic, TOPIC_CATEGORIES,
};
