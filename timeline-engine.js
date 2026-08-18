/**
 * timeline-engine.js — Event detection + surprise + source reliability + decay + regime + cascades (§5–7)
 *
 * Loops:
 *   fast (60s):  news wave, finance move, fin_tg move, polymarket move
 *   trend (5m):  google trends spike
 *   regime(30m): market regime classification
 *   cascade(2m): root-cause tree assembly + Persian narrative
 *
 * Discovery/graph/predict/learn are lazy-required to avoid circular deps.
 */
const fs = require('fs');
const path = require('path');
const tdb = require('./timeline-db');
const ai = require('./timeline-ai');

const DATA_DIR = path.join(__dirname, 'data');

// existing source dbs (lazy)
function newsDB()  { return require('./news-db'); }
function finDB()   { return require('./finance-db'); }
function polyDB()  { return require('./polymarket-db'); }

// in-memory snapshot maps for diffing
const _prevTrends = new Set();          // keywords seen last trend scan
const _finPrice = new Map();             // symbol -> { price, dir, count }
const _finTgPrice = new Map();           // 'usd'|'coin'|... -> { price, basePrice, baseAt, dir, count, lastMsgAt }
let _finTgLastMsgId = 0;                 // only process new finance telegram messages
const _polySnap = new Map();             // poly_id -> { price, vol24 }
const _polyVolAvg = new Map();           // poly_id -> recent avg volume

// ── helpers ──
function toEn(str) {
  if (str == null) return str;
  return String(str).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function nowIso() { return new Date().toISOString(); }
function minutesAgoIso(m) { return new Date(Date.now() - m * 60000).toISOString(); }

// Persian topic stopwords (light) for keyword clustering
const STOP = new Set(['در','به','از','که','و','را','این','است','بود','برای','با','تا','آن','هم','یا','شد','شده','خواهد','ایران','مردم','روز','سال','امروز','فردا']);

function tokenize(text) {
  if (!text) return new Set();
  const words = (text + '').replace(/[^\u0600-\u06FF\u0030-\u0039A-Za-z\s]/g, ' ')
    .split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
  return new Set(words.slice(0, 20));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

// ════════════════════════════════════════════════════════
//  SURPRISE  (§5.6)
// ════════════════════════════════════════════════════════
function applySurprise(severity, actualValue, expectedValue) {
  if (expectedValue == null || actualValue == null || !isFinite(expectedValue)) return severity;
  const denom = Math.abs(expectedValue) + 0.001;
  const surprise = Math.abs(actualValue - expectedValue) / denom;
  if (surprise > 0.5) return Math.min(severity * (1 + surprise * 0.5), 1.0);
  return severity;
}

// ════════════════════════════════════════════════════════
//  NEWS WAVE  (§5.1)
// ════════════════════════════════════════════════════════
async function detectNewsWave() {
  let items;
  try { items = newsDB().getNewsSince(30); } catch (e) { return; }
  if (!items || !items.length) return;

  // cluster by keyword-set Jaccard > 0.3 (union-find)
  const tokens = items.map(it => tokenize(it.text_fa || it.text || ''));
  const parent = items.map((_, i) => i);
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { parent[find(a)] = find(b); }
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (jaccard(tokens[i], tokens[j]) > 0.3) union(i, j);

  const clusters = {};
  items.forEach((it, i) => { const r = find(i); (clusters[r] = clusters[r] || []).push(it); });

  for (const key in clusters) {
    const cluster = clusters[key];
    const span = cluster.length ? cluster.map(c => new Date(c.published_at).getTime()) : [0];
    const minT = Math.min(...span), maxT = Math.max(...span);
    const within15 = (maxT - minT) <= 15 * 60000;
    const channels = new Set(cluster.map(c => c.channel_id));
    const isWave = (channels.size >= 3 && within15) || cluster.length >= 5;
    if (!isWave) continue;

    // topic extraction via AI (≤5 Persian words)
    const sample = cluster.slice(0, 6).map(c => (c.text_fa || c.text || '').slice(0, 120)).join(' | ');
    let topic = null;
    try {
      const parsed = await ai.callStructured(
        `متن خبری زیر را در یک عبارت موضوعی ۵ کلمه‌ای فارسی خلاصه کن (بدون نقطه).\n${sample}\nفقط JSON: {"topic":"..."}`);
      topic = parsed?.topic || null;
    } catch (e) {}

    // Fallback: keyword-based topic extraction when AI is unavailable (rate-limited)
    if (!topic) {
      const wordCount = {};
      for (const it of cluster) {
        for (const w of (it.text_fa || it.text || '').split(/\s+/)) {
          const w2 = w.replace(/[^\u0600-\u06FFA-Za-z]/g, '');
          if (w2.length < 4 || STOP.has(w2)) continue;
          wordCount[w2] = (wordCount[w2] || 0) + 1;
        }
      }
      const top = Object.entries(wordCount).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
      if (top.length) topic = top.join(' ');
    }

    // dedup against existing event same topic within 30 min
    if (topic && tdb.getLatestByNodeTopic('news', topic, 30)) continue;

    // severity
    const channelDiversity = clamp(channels.size / 5, 0, 1);
    const volume = clamp(cluster.length / 10, 0, 1);
    // source reliability per channel
    let relSum = 0;
    for (const cid of channels) {
      const ch = cluster.find(c => c.channel_id === cid);
      const isAgency = (ch?.channel_title || '').length && /خبرگزاری|IRNA|ISNA|فارس|تسنیم|ایسنا/i.test(ch.channel_title || ch.category || '');
      const st = isAgency ? 'news_agency' : 'telegram_channel';
      relSum += tdb.getReliabilityForSource(st, ch?.channel_username ? '@' + ch.channel_username : null).reliability;
    }
    const avgRel = relSum / Math.max(1, channels.size);
    const authority = clamp(avgRel, 0, 1);
    const rawSev = clamp(0.4 * channelDiversity + 0.2 * volume + 0.4 * authority, 0, 1);
    let severity = rawSev * avgRel; // §5.7: severity × source reliability

    // surprise: rare topic = higher surprise (expected ~ frequency)
    const expectedFreq = 0.5; // baseline expectation of routine topic
    const surprise = topic ? 0 : 0; // placeholder; news surprise handled via rarity below
    severity = clamp(severity, 0, 1);

    const title = topic ? `موج خبری: ${topic}` : 'موج خبری جدید';
    tdb.insertEvent({
      source: 'news', node_key: 'news', event_type: 'news_wave',
      title, topic: topic || null, severity, direction: null, magnitude: cluster.length,
      surprise_score: surprise, expected_value: expectedFreq,
      data: JSON.stringify({ count: cluster.length, channels: channels.size, sample }),
      detected_at: nowIso(),
    });
    // touch source last_event for involved channels
    for (const cid of channels) {
      const ch = cluster.find(c => c.channel_id === cid);
      const st = /خبرگزاری|IRNA|ISNA|فارس|تسنیم|ایسنا/i.test(ch?.channel_title || ch.category || '') ? 'news_agency' : 'telegram_channel';
      const cur = tdb.getReliabilityForSource(st, ch?.channel_username ? '@' + ch.channel_username : null);
      tdb.upsertSourceReliability({ source_type: st, source_key: ch?.channel_username ? '@' + ch.channel_username : null, label: ch?.channel_title, last_event: nowIso() });
    }
  }
}

// ════════════════════════════════════════════════════════
//  TREND SPIKE  (§5.2)
// ════════════════════════════════════════════════════════
function detectTrendSpike() {
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'h4.json'), 'utf8')); } catch (e) { return; }
  const trends = data.trends || [];
  if (!trends.length) return;
  for (const t of trends) {
    const kw = (t.keyword || '').trim();
    if (!kw) continue;
    const isNew = !_prevTrends.has(kw);
    const growth = Number(t.growth) || 0;
    const vol = Number(t.vol) || 0;
    let sev = 0;
    if (isNew) sev = Math.max(sev, 0.6);
    if (growth > 300) sev = Math.max(sev, Math.min(growth / 1000, 1));
    if (vol > 500000) sev = Math.max(sev, 0.8);
    if (!sev) continue;
    // dedup
    if (tdb.getLatestByNodeTopic('trend', kw, 30)) continue;
    const rel = tdb.getReliabilityForSource('rss', null).reliability;
    tdb.insertEvent({
      source: 'trend', node_key: 'trend', event_type: 'trend_spike',
      title: `اسپایک جستجو: ${kw}`, topic: kw, severity: sev * rel, direction: 'up',
      magnitude: growth, surprise_score: isNew ? 1 : 0, expected_value: 0,
      data: JSON.stringify({ keyword: kw, vol, growth, cat: t.cat || null }), detected_at: nowIso(),
    });
  }
  _prevTrends.clear();
  trends.forEach(t => _prevTrends.add((t.keyword || '').trim()));
}

// ════════════════════════════════════════════════════════
//  FINANCE MOVE  (§5.3)
// ════════════════════════════════════════════════════════
const SYMBOLS = ['usd', 'coin', 'gold18', 'tether', 'bitcoin', 'oil_brent', 'stock_market', 'mesghal', 'ounce'];
const SYMBOL_LABEL = {
  usd: 'دلار', coin: 'سکه', gold18: 'طلای ۱۸', tether: 'تتر', bitcoin: 'بیت‌کوین',
  oil_brent: 'نفت', stock_market: 'بورس', mesghal: 'مثقال', ounce: 'انس',
};

function detectFinanceMove() {
  const fdb = finDB();
  for (const sym of SYMBOLS) {
    let latest;
    try { latest = fdb.getLatestBySymbol(sym); } catch (e) { continue; }
    if (!latest || !latest.price) continue;
    // price ~60 min ago
    let history;
    try { history = fdb.getHistory(sym, 2); } catch (e) { history = []; }
    if (!history.length) continue;
    const nowMs = Date.now();
    const target = nowMs - 60 * 60000;
    let ref = null, bestDelta = Infinity;
    for (const r of history) {
      const ms = new Date(r.timestamp).getTime();
      const d = Math.abs(ms - target);
      if (d < bestDelta) { bestDelta = d; ref = r; }
    }
    if (!ref || !ref.price) continue;
    const pct = ((latest.price - ref.price) / ref.price) * 100;
    if (Math.abs(pct) <= 0.3) { _finPrice.set(sym, { price: latest.price, dir: 'flat', count: 0 }); continue; }

    const dir = pct > 0 ? 'up' : 'down';
    const prev = _finPrice.get(sym) || { dir: 'flat', count: 0 };
    const count = prev.dir === dir ? (prev.count || 0) + 1 : 1;
    let sev = clamp(Math.abs(pct) / 3, 0, 1);
    if (count >= 3) sev *= 1.5; // sustained
    // round-number breakout: crossing latest low/high band
    if (latest.high != null && latest.low != null && (latest.price >= latest.high || latest.price <= latest.low)) {
      sev = Math.max(sev, 0.8);
    }
    // surprise vs expected (mean abs pct of recent history)
    const absPcts = [];
    for (let i = 1; i < history.length; i++) {
      if (history[i - 1].price) absPcts.push(Math.abs((history[i].price - history[i - 1].price) / history[i - 1].price * 100));
    }
    const expected = absPcts.length ? absPcts.reduce((a, b) => a + b, 0) / absPcts.length : 0.3;
    const surprise = expected ? Math.abs(pct - expected) / (expected + 0.001) : 0;
    sev = applySurprise(sev, pct, expected);
    sev = clamp(sev, 0, 1) * tdb.getReliabilityForSource('finance_api', null).reliability;

    _finPrice.set(sym, { price: latest.price, dir, count });
    tdb.insertEvent({
      source: 'finance', node_key: sym, event_type: 'price_move',
      title: `${SYMBOL_LABEL[sym] || sym} ${dir === 'up' ? 'صعودی' : 'نزولی'} ${toEn(pct.toFixed(2))}٪`,
      // موضوع باید «درباره‌ی چه چیزی» را بگوید، نه «به کدام سمت». ذخیره‌ی جهت
      // به‌عنوان موضوع، ۱۷٬۵۲۹ رویداد را با topic برابر up/down پر کرده بود و
      // هر گروه‌بندی موضوعی را بی‌معنا می‌کرد. جهت ستون خودش را دارد.
      topic: sym, severity: sev, direction: dir, magnitude: pct,
      surprise_score: surprise, expected_value: expected,
      data: JSON.stringify({ symbol: sym, price: latest.price, ref_price: ref.price }), detected_at: nowIso(),
    });
  }
}

// ════════════════════════════════════════════════════════
//  FINANCE TELEGRAM  (§5.5) — fin_tg node
// ════════════════════════════════════════════════════════
// Messages look like: "دلار فردایی تهران ⏳ 193,800 مـعامله شد✅"
// i.e. keyword, then qualifier text + emoji, THEN the number.
// So we match: keyword, then skip up to 40 non-digit chars, then capture the number.
const TG_KEYWORDS = [
  { re: /دلار[^\d۰-۹]{0,40}?([۰-۹0-9][۰-۹0-9,.\s]{2,16})/, target: 'usd' },
  { re: /سکه[^\d۰-۹]{0,40}?([۰-۹0-9][۰-۹0-9,.\s]{2,16})/, target: 'coin' },
  { re: /طلا(?:ی)?(?:\s*\d*)?[^\d۰-۹]{0,40}?([۰-۹0-9][۰-۹0-9,.\s]{2,16})/, target: 'gold18' },
  { re: /تتر[^\d۰-۹]{0,40}?([۰-۹0-9][۰-۹0-9,.\s]{2,16})/, target: 'tether' },
  { re: /بیت‌?کوین[^\d۰-۹]{0,40}?([۰-۹0-9][۰-۹0-9,.\s]{2,16})/, target: 'bitcoin' },
  { re: /نفت[^\d۰-۹]{0,40}?([۰-۹0-9][۰-۹0-9,.\s]{2,16})/, target: 'oil_brent' },
  { re: /بورس[^\d۰-۹]{0,40}?([۰-۹0-9][۰-۹0-9,.\s]{2,16})/, target: 'stock_market' },
  // also "انس" (ounce) and "مثقال"
  { re: /انس[^\d۰-۹]{0,40}?([۰-۹0-9][۰-۹0-9,.\s]{2,16})/, target: 'ounce' },
  { re: /مثقال[^\d۰-۹]{0,40}?([۰-۹0-9][۰-۹0-9,.\s]{2,16})/, target: 'mesghal' },
];

function parseFinTgPrices(text) {
  if (!text) return [];
  const found = [];
  // reasonable price ranges per target (covers toman + rial scales)
  const RANGES = {
    usd: [100, 500000000], coin: [100, 5000000000], gold18: [100, 500000000],
    tether: [10, 500000000], bitcoin: [100, 500000000], oil_brent: [1, 5000],
    stock_market: [100, 500000000], ounce: [1, 50000], mesghal: [100, 500000000],
  };
  for (const k of TG_KEYWORDS) {
    const m = text.match(k.re);
    if (m) {
      const num = parseFloat(toEn(m[1]).replace(/[,،\s]/g, ''));
      if (!isFinite(num) || num <= 0) continue;
      const range = RANGES[k.target];
      if (range && (num < range[0] || num > range[1])) continue; // discard out-of-range
      found.push({ target: k.target, price: num });
    }
  }
  return found;
}

function detectFinTgMove() {
  const fdb = finDB();
  let msgs;
  try { msgs = fdb.getLatestFinanceMessages(50); } catch (e) { return; }
  if (!msgs || !msgs.length) return;
  // only process NEW messages (id > last seen) — sort oldest-first for chronological baseline
  const newMsgs = msgs.filter(m => m.id > _finTgLastMsgId).sort((a, b) => a.id - b.id);
  if (!newMsgs.length) return;
  _finTgLastMsgId = Math.max(...msgs.map(m => m.id));
  for (const m of newMsgs) {
    const pubMs = new Date(m.published_at).getTime();
    const prices = parseFinTgPrices(m.text_fa || m.text);
    for (const p of prices) {
      const cur = _finTgPrice.get(p.target);
      // set baseline if none, or if baseline is older than 10 min
      if (!cur || !cur.basePrice || pubMs - cur.baseAt > 10 * 60000) {
        _finTgPrice.set(p.target, { price: p.price, basePrice: p.price, baseAt: pubMs, dir: 'flat', count: 0, lastMsgAt: m.published_at });
        continue;
      }
      // compare against the 10-minute baseline (cumulative move)
      const pct = ((p.price - cur.basePrice) / cur.basePrice) * 100;
      if (Math.abs(pct) > 0.25) {
        const dir = pct > 0 ? 'up' : 'down';
        const count = cur.dir === dir ? (cur.count || 0) + 1 : 1;
        let sev = clamp(Math.abs(pct) / 2, 0, 1);
        if (count >= 2) sev *= 1.5;
        const rel = tdb.getReliabilityForSource('finance_tg', m.channel_username ? '@' + m.channel_username : null).reliability;
        sev = clamp(sev, 0, 1) * rel;
        _finTgPrice.set(p.target, { price: p.price, basePrice: p.price, baseAt: pubMs, dir, count, lastMsgAt: m.published_at });
        tdb.insertEvent({
            source: 'fin_tg', node_key: 'fin_tg', source_id: String(m.id), event_type: 'price_move',
            title: `${SYMBOL_LABEL[p.target] || p.target} (${dir === 'up' ? 'صعودی' : 'نزولی'}) — تلگرام`,
            topic: p.target, severity: sev, direction: dir, magnitude: pct,
            surprise_score: 0, expected_value: cur.basePrice,
            data: JSON.stringify({ target: p.target, price: p.price, channel: m.channel_username }), detected_at: m.published_at,
          });
      } else {
        // no significant move — update current price but keep baseline
        _finTgPrice.set(p.target, { ...cur, price: p.price, lastMsgAt: m.published_at });
      }
    }
  }
}

// ════════════════════════════════════════════════════════
//  POLYMARKET MOVE  (§5.4)
// ════════════════════════════════════════════════════════
function detectPolyMove() {
  let rows;
  try { rows = polyDB().getSortedList('trending', 50); } catch (e) { return; }
  if (!rows || !rows.length) return;
  for (const m of rows) {
    const pid = m.poly_id;
    const price = Number(m.price);
    const vol = Number(m.volume24hr) || 0;
    const snap = _polySnap.get(pid);
    if (snap && snap.price != null && isFinite(price)) {
      const dPrice = Math.abs(price - snap.price);
      const volAvg = _polyVolAvg.get(pid) || vol;
      const volSpike = volAvg ? vol / volAvg : 1;
      if (dPrice > 5 || volSpike > 2) {
        const dir = price > snap.price ? 'up' : 'down';
        let sev = clamp(dPrice / 20, 0.1, 1);
        if (volSpike > 2) sev = Math.max(sev, 0.6);
        const rel = tdb.getReliabilityForSource('polymarket', null).reliability;
        sev = clamp(sev, 0, 1) * rel;
        const topic = m.title_fa || m.title || 'پلی‌مارکت';
        tdb.insertEvent({
          source: 'polymarket', node_key: 'poly', source_id: pid, event_type: 'poly_move',
          title: `پلی‌مارکت: ${topic.slice(0, 60)}`, topic, severity: sev, direction: dir,
          magnitude: dPrice, surprise_score: dPrice > 10 ? 1 : 0, expected_value: snap.price,
          data: JSON.stringify({ poly_id: pid, price, vol, volSpike }), detected_at: nowIso(),
        });
      }
    }
    _polySnap.set(pid, { price, vol });
    // rolling avg volume (simple)
    const prevAvg = _polyVolAvg.get(pid) || vol;
    _polyVolAvg.set(pid, prevAvg * 0.8 + vol * 0.2);
  }
}

// ════════════════════════════════════════════════════════
//  REGIME DETECTION  (§7)
// ════════════════════════════════════════════════════════
function heuristicRegime() {
  // news topic frequency from last 24h
  const events = tdb.getEventsSince(60 * 24, 'news');
  const topicCount = {};
  for (const e of events) {
    const t = (e.title || '') + ' ' + (e.topic || '');
    if (/جنگ|حمله|موشک|تهدید|حمله نظامی/.test(t)) topicCount.war = (topicCount.war || 0) + 1;
    if (/انتخابات|رأی|رای|کاندید/.test(t)) topicCount.election = (topicCount.election || 0) + 1;
    if (/تحریم|FATF|فاف|تحریم‌|سازمان ملل/.test(t)) topicCount.sanctions = (topicCount.sanctions || 0) + 1;
    if (/نفت|اوپک|OPEC|بشکه/.test(t)) topicCount.oil = (topicCount.oil || 0) + 1;
  }
  // finance volatility
  const fin = tdb.getEventsSince(120, null).filter(e => e.node_key && SYMBOLS.includes(e.node_key));
  const volMoves = fin.length;
  const usdUp = fin.filter(e => e.node_key === 'usd' && e.direction === 'up').length;

  if (topicCount.war) return 'war';
  if (topicCount.election) return 'election';
  if (topicCount.sanctions) return 'sanctions';
  if (topicCount.oil) return 'oil_shock';
  if (volMoves > 8 && usdUp > 3) return 'currency_crisis';
  return 'normal';
}

async function detectRegime() {
  const heuristic = heuristicRegime();
  // gather context for AI
  const topTopics = (tdb.getEventsSince(60 * 24, 'news') || [])
    .map(e => e.topic).filter(Boolean)
    .reduce((a, t) => { a[t] = (a[t] || 0) + 1; return a; }, {});
  const topList = Object.entries(topTopics).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, c]) => `${t}(${c})`).join('، ');
  const finMoves = (tdb.getEventsSince(120, null) || [])
    .filter(e => SYMBOLS.includes(e.node_key)).slice(0, 8)
    .map(e => `${SYMBOL_LABEL[e.node_key] || e.node_key} ${e.direction} ${e.magnitude?.toFixed(1)}٪`).join('، ');

  const prompt = `داده‌های ۲۴ ساعت اخیر ایران:
پرتکرارترین موضوعات خبری: ${topList || '—'}
نوسان بازار (تعداد حرکت‌های قابل‌توجه ۲ ساعت اخیر): ${finMoves || '—'}
حدس ابتدایی سیستمی: ${heuristic}

فقط JSON برگردان:
{"regime":"normal|war|election|sanctions|currency_crisis|oil_shock","confidence":0.0-1.0,"evidence":"دلیل کوتاه فارسی"}`;

  let regime = heuristic, confidence = 0.6, evidence = '';
  try {
    const parsed = await ai.callStructured(prompt);
    if (parsed && parsed.regime) {
      regime = parsed.regime; confidence = clamp(Number(parsed.confidence) || 0.6, 0, 1);
      evidence = cleanEvidence(parsed.evidence);
    }
  } catch (e) { /* keep heuristic */ }

  const cur = tdb.getCurrentRegime();
  if (cur && cur.regime === regime) {
    // same regime continues — do not rewrite
    return regime;
  }

  // ── ماندگاری حداقلی ────────────────────────────────────────────────
  // رژیم در یک روز چهار بار بین «جنگ» و «عادی» می‌پرید. چون رژیم مستقیماً در
  // اطمینانِ هر پیش‌بینی ضرب می‌شود، این بی‌ثباتی به کل خروجی سرایت می‌کرد.
  // تغییر رژیم یک ادعای بزرگ است و باید شواهد قوی و زمان کافی پشتش باشد.
  if (cur && cur.started_at) {
    const ageMin = (Date.now() - new Date(cur.started_at).getTime()) / 60000;
    const minDwell = tdb.getWeight('regime_min_dwell_min', 12 * 60);
    if (ageMin < minDwell) {
      // فقط شواهد بسیار قوی می‌تواند رژیم تازه را زودتر از موعد جابه‌جا کند
      if (confidence < 0.85) {
        console.log(`[tl-engine] regime ${cur.regime}→${regime} رد شد — فقط ${Math.round(ageMin)} دقیقه از رژیم فعلی گذشته`);
        return cur.regime;
      }
    }
  }

  tdb.insertRegime({ regime, confidence, evidence, started_at: nowIso() });
  console.log(`[tl-engine] regime -> ${regime} (${(confidence * 100).toFixed(0)}%)`);
  return regime;
}

// متن توجیه رژیم باید فارسی باشد. وقتی سهمیه‌ی مدل رایگان ته می‌کشد، خروجی
// چندزبانه‌ی بی‌معنا تولید می‌شود («مرتبط با wypowiedzi … działań نظامی»).
// چنین متنی به کاربر نشان داده می‌شود، پس بهتر است خالی بماند تا بی‌معنا.
function cleanEvidence(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  const letters = s.replace(/[\s\d،؛؟.,;:!?()«»\-–—'"]/g, '');
  if (!letters) return '';
  const persian = (letters.match(/[؀-ۿ]/g) || []).length;
  // دست‌کم ۸۰٪ حروف باید فارسی/عربی باشند
  return (persian / letters.length) >= 0.8 ? s : '';
}

// ════════════════════════════════════════════════════════
//  CASCADE / ROOT-CAUSE TREE ASSEMBLY  (§6.2, §6.3)
// ════════════════════════════════════════════════════════
async function assembleCascades() {
  // cap active chains: archive oldest if more than 5 active
  const activeChains = tdb.getChains('active', 999) || [];
  if (activeChains.length > 5) {
    const toArchive = activeChains.sort((a, b) => new Date(a.started_at) - new Date(b.started_at)).slice(0, activeChains.length - 5);
    toArchive.forEach(c => tdb.resolveChain(c.id));
  }

  const events = tdb.getUnlinkedEvents(2);
  if (!events || events.length < 1) return;
  const edges = tdb.getUsableEdges();
  const BAD_TOPICS = new Set(['up', 'down', 'flat', 'usd', 'coin', 'gold18', 'tether', 'bitcoin', 'oil_brent', 'stock_market', 'mesghal', 'ounce', 'نامشخص']);
  // group events: a cascade = cause-node events that are connected via learned edges to a target-node event within lead_time
  // Build by walking: for each target (finance) event, find cause events in [t-lead, t] window.
  const used = new Set();
  const cascades = [];

  // Only process the 3 most recent finance events to avoid chain spam.
  // یک نماد در هر دور — وگرنه چون نفت بیشترین رویداد قیمتی را می‌سازد، هر سه
  // جای خالی را می‌گیرد و نتیجه‌اش این شد که ۷۳٪ کل زنجیره‌های تاریخی به «نفت»
  // ختم می‌شوند. تنوع هدف را همین‌جا تضمین می‌کنیم، نه بعد از انتشار.
  const seenTarget = new Set();
  const financeEvents = events
    .filter(e => ['usd', 'coin', 'gold18', 'tether', 'bitcoin', 'oil_brent', 'stock_market', 'mesghal', 'ounce'].includes(e.node_key))
    .sort((a, b) => new Date(b.detected_at) - new Date(a.detected_at))
    .filter(e => { if (seenTarget.has(e.node_key)) return false; seenTarget.add(e.node_key); return true; })
    .slice(0, 3);
  for (const fe of financeEvents) {
    // find edges pointing INTO fe.node_key
    const inEdges = edges.filter(ed => ed.to_node === fe.node_key);
    if (!inEdges.length) continue;
    const feT = new Date(fe.detected_at).getTime();
    const roots = [fe.id];
    const edgeList = [];
    for (const ed of inEdges) {
      if (roots.length - 1 >= 5) break; // hard cap: max 5 causes per chain
      const lead = ed.lead_time_min || 30;
      const windowStart = feT - (lead + (ed.lead_time_std || 20)) * 60000;
      // find cause events on ed.from_node within [windowStart, feT]
      let causes = events.filter(e =>
        e.node_key === ed.from_node &&
        !used.has(e.id) && e.id !== fe.id &&
        (() => { const t = new Date(e.detected_at).getTime(); return t >= windowStart && t <= feT; })()
      );
      // only keep TOP 1 by severity per edge (was TOP 3, causing 18+ cause chains)
      if (causes.length > 1) {
        causes = causes.sort((a, b) => (b.severity || 0) - (a.severity || 0)).slice(0, 1);
      }
      for (const c of causes) {
        roots.push(c.id);
        edgeList.push([c.id, fe.id]);
        used.add(c.id);
      }
    }
    if (roots.length > 1) {
      const rootCauseIds = roots.filter(id => id !== fe.id);
      const causeEvents = events.filter(e => rootCauseIds.includes(e.id));

      // ── دروازه‌ی ربط علّی ───────────────────────────────────────────
      // هم‌زمانی، علیت نیست. اسپایک جستجوی «فورتنایت» یا «بایرن مونیخ» با
      // نوسان نفت هم‌زمان می‌شود، ولی ادعای علّی از رویش، همان چیزی است که
      // اعتبار این بخش را از بین برد (۳۶٪ زنجیره‌ها ریشه‌ی صرفاً جستجویی داشتند).
      //
      // قاعده: زنجیره باید دست‌کم یک علت «مرتبط» داشته باشد — یعنی یا از
      // منبعی جز جستجو بیاید (خبر یا قیمت)، یا موضوع جستجویش در دسته‌ای
      // اقتصادی/سیاسی بیفتد. اسپایک جستجوی سرگرمی به‌تنهایی کافی نیست.
      const isRelevantCause = (e) => {
        if (e.node_key !== 'trend') return true;               // خبر یا قیمت، ذاتاً مرتبط
        const cat = tdb.categorizeTopic(e.topic);
        return cat && cat !== 'general' && cat !== 'social';   // جستجو فقط اگر موضوعش اقتصادی/سیاسی باشد
      };
      if (!causeEvents.some(isRelevantCause)) {
        // رویدادها را آزاد کن تا در گروه‌بندی مشاهده‌ای پایین‌تر قابل استفاده بمانند
        rootCauseIds.forEach(id => used.delete(id));
        continue;
      }

      used.add(fe.id);
      const peak = Math.max(fe.severity || 0, ...causeEvents.map(e => e.severity || 0));
      // use the most severe cause's topic, or the finance event's target as topic
      const topCause = causeEvents.sort((a, b) => (b.severity || 0) - (a.severity || 0))[0];
      // avoid using direction/symbol as topic for the title
      const rawTopic = topCause?.topic || fe.topic || 'نامشخص';
      const topic = BAD_TOPICS.has(rawTopic) ? 'رویداد بازار' : rawTopic;
      const title = `زنجیره: ${topic}`;
      const treeRoots = rootCauseIds.length ? rootCauseIds : [fe.id];
      const fullEventIds = { roots: treeRoots, edges: edgeList };

      // Persian narrative via AI (only send top 3 causes to keep prompt short)
      const topCauses = causeEvents.sort((a, b) => (b.severity || 0) - (a.severity || 0)).slice(0, 3);
      const summary = topCauses.map(e => (e.title || '').slice(0, 40)).join(' + ') + ` => ${fe.title}`;
      let narrative = null;
      try {
        narrative = await ai.callNarrative(
          `این زنجیره سیگنال را در یک جمله کوتاه فارسی توضیح بده — کدام علت باعث این نتیجه شد:\n${summary}`);
      } catch (e) {}

      const chainId = tdb.insertChain({
        title, topic, category: 'economic', regime: (tdb.getCurrentRegime() || {}).regime || 'normal',
        status: 'active', event_ids: JSON.stringify(fullEventIds), root_node: topCause?.node_key || fe.node_key,
        root_causes: JSON.stringify(rootCauseIds), ai_analysis: narrative || summary,
        peak_severity: peak, started_at: causeEvents[0]?.detected_at || fe.detected_at,
      });
      cascades.push(chainId);
    }
  }

  // Fallback: only group orphan events that share a REAL topic (not 'up'/'down'/'flat') within a tight window.
  // This catches co-occurring news waves on the same subject. Skip direction-only topics.
  // Grouped by CATEGORY (war/economy/...) because raw keyword topics rarely repeat.
  // NOTE: these are OBSERVATIONAL groupings only — they make no causal claim and
  // never produce a prediction on their own (predictions require a usable edge).
  if (cascades.length === 0 && events.length >= 2) {
    const CAT_LABEL = {
      war: 'تنش و درگیری', sanctions: 'تحریم و مذاکرات', oil: 'نفت و انرژی',
      election: 'انتخابات', economy: 'اقتصاد و بازار', politics: 'سیاست داخلی',
      social: 'اجتماعی', general: 'عمومی',
    };
    const byCat = {};
    for (const e of events) {
      if (used.has(e.id) || !e.topic || BAD_TOPICS.has(e.topic)) continue;
      if (!['news', 'trend'].includes(e.node_key)) continue; // only narrative sources
      const cat = tdb.categorizeTopic(e.topic);
      if (cat === 'general') continue; // too vague to be meaningful
      (byCat[cat] = byCat[cat] || []).push(e);
    }
    for (const cat in byCat) {
      const group = byCat[cat].sort((a, b) => new Date(a.detected_at) - new Date(b.detected_at));
      if (group.length < 2) continue;
      const span = new Date(group[group.length - 1].detected_at) - new Date(group[0].detected_at);
      if (span > 30 * 60000) continue;
      const top = group.sort((a, b) => (b.severity || 0) - (a.severity || 0)).slice(0, 5);
      const ids = top.map(e => e.id);
      top.forEach(e => used.add(e.id));
      const peak = Math.max(...top.map(e => e.severity || 0));
      const label = CAT_LABEL[cat] || cat;
      const headline = (top[0].topic || '').slice(0, 40);
      tdb.insertChain({
        title: `${label}: ${headline}`, topic: top[0].topic, category: cat,
        regime: (tdb.getCurrentRegime() || {}).regime || 'normal', status: 'active',
        event_ids: JSON.stringify({ roots: ids, edges: [] }), root_node: top[0].node_key,
        root_causes: JSON.stringify(ids),
        ai_analysis: `${toFaNum(top.length)} رویداد هم‌زمان در حوزه «${label}». واکنش بازار هنوز تأیید نشده است.`,
        peak_severity: peak, started_at: top[0].detected_at,
      });
    }
  }
  return cascades.length;
}

function toFaNum(n) { return String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]); }

// ════════════════════════════════════════════════════════
//  SCHEDULER
// ════════════════════════════════════════════════════════
let _running = false;
async function fastLoop() {
  if (_running) return;
  _running = true;
  try {
    await detectNewsWave();
    detectFinanceMove();
    detectFinTgMove();
    detectPolyMove();
    // after new events, try generating predictions + bayesian updates
    try { require('./timeline-predict').onNewEvents(); } catch (e) { /* may not be ready */ }
  } catch (e) { console.warn('[tl-engine] fastLoop error:', e.message); }
  finally { _running = false; }
}

function trendLoop() {
  try { detectTrendSpike(); } catch (e) { console.warn('[tl-engine] trendLoop error:', e.message); }
}

async function regimeLoop() {
  try { await detectRegime(); } catch (e) { console.warn('[tl-engine] regimeLoop error:', e.message); }
}

async function cascadeLoop() {
  try { await assembleCascades(); } catch (e) { console.warn('[tl-engine] cascadeLoop error:', e.message); }
}

function graphLoop() {
  try { require('./timeline-graph').runDiscovery(); } catch (e) { console.warn('[tl-engine] graphLoop error:', e.message); }
}

function learnLoop() {
  try { require('./timeline-learn').runValidation(); } catch (e) { console.warn('[tl-engine] learnLoop error:', e.message); }
}

function cleanupLoop() {
  try { tdb.cleanup(); } catch (e) { console.warn('[tl-engine] cleanupLoop error:', e.message); }
}

function startScheduler() {
  if (!process.env.OPENROUTER_KEY) console.warn('[tl-engine] no OPENROUTER_KEY — AI features disabled');
  // initial staggered runs
  setTimeout(() => fastLoop().catch(() => {}), 15000);
  setTimeout(() => trendLoop(), 30000);
  setTimeout(() => regimeLoop().catch(() => {}), 45000);
  setTimeout(() => cascadeLoop().catch(() => {}), 60000);
  setTimeout(() => graphLoop(), 90000);
  setTimeout(() => learnLoop(), 120000);
  setTimeout(() => cleanupLoop(), 180000);

  // intervals
  setInterval(() => fastLoop().catch(() => {}), tdb.getWeight('fast_loop_interval_sec', 60) * 1000);
  setInterval(trendLoop, 5 * 60 * 1000);
  setInterval(() => regimeLoop().catch(() => {}), tdb.getWeight('regime_interval_min', 30) * 60 * 1000);
  setInterval(() => cascadeLoop().catch(() => {}), tdb.getWeight('cascade_interval_min', 2) * 60 * 1000);
  setInterval(graphLoop, tdb.getWeight('graph_discovery_interval_min', 30) * 60 * 1000);
  setInterval(learnLoop, tdb.getWeight('validation_interval_min', 10) * 60 * 1000);
  setInterval(cleanupLoop, 24 * 60 * 60 * 1000);   // روزی یک‌بار، مثل بقیه‌ی دیتابیس‌ها

  console.log('[tl-engine] scheduler started — fast:60s, trend:5m, regime:30m, cascade:2m, graph:30m, learn:10m');
}

module.exports = {
  startScheduler, fastLoop, trendLoop, regimeLoop, cascadeLoop, graphLoop, learnLoop,
  detectNewsWave, detectTrendSpike, detectFinanceMove, detectFinTgMove, detectPolyMove,
  detectRegime, assembleCascades, heuristicRegime, applySurprise, parseFinTgPrices,
};
