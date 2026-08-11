/**
 * server.js — Signal API + Auth + Crawler
 */

require('dotenv').config();

// ── اسرار الزامی — بدون این‌ها اپ نباید بالا بیاید ──
['JWT_SECRET', 'NODE_INTERNAL_SECRET'].forEach(key => {
  if (!process.env[key]) {
    console.error(`\n✗ متغیر محیطی ${key} ست نشده. اپ متوقف می‌شود (به .env نگاه کنید).\n`);
    process.exit(1);
  }
});

const express  = require('express');
const cors     = require('cors');
const cookieParser = require('cookie-parser');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const db       = require('./db');
const { signToken, requireAuth, requireSuperAdmin } = require('./auth');
let _crawlers = {};
try { _crawlers.scheduler = require('./crawler'); _crawlers.scheduler.startScheduler; } catch(e) { console.warn('[warn] crawler not loaded:', e.message); }
try { _crawlers.market = require('./market-crawler'); } catch(e) { console.warn('[warn] market-crawler not loaded:', e.message); }
const marketRouter = require('./market-api');
const financeRouter = require('./finance-api');
const financeDB = require('./finance-db');
let financeCrawler;
try { financeCrawler = require('./finance-crawler'); } catch(e) { console.warn('[warn] finance-crawler not loaded:', e.message); }
try { _crawlers.job = require('./job-crawler'); } catch(e) { console.warn('[warn] job-crawler not loaded:', e.message); }
const jobRouter = require('./job-api');
const { startPolymarketScheduler } = require('./polymarket-crawler');
const polymarketRouter = require('./polymarket-api');
const timelineRouter = require('./timeline-api');
const trendRouter = require('./trend-api');
const carRouter = require('./car-api');
let carCrawler;
try { carCrawler = require('./car-crawler'); } catch(e) { console.warn('[warn] car-crawler not loaded:', e.message); }
const { startDigestScheduler, loadDigest, refresh4h, refresh24h } = require('./ai-digest');
const { startNewsBot } = require('./news-bot');
const newsRouter = require('./news-api');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: true, credentials: true }));
app.use((req, res, next) => {
  const host = (req.headers.host || '').split(':')[0];
  if (host === '81.168.119.67' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return res.redirect(301, 'https://signalhoosh.site' + req.originalUrl);
  }
  next();
});
app.use(cookieParser());
app.use(express.json({ limit: '40mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════
//  ONLINE USERS TRACKING (in-memory)
// ════════════════════════════════════
const _onlineUsers = new Map(); // userId → { id, name, mobile, role, lastSeen, ip, currentTab }
const ONLINE_TIMEOUT = 2 * 60 * 1000; // ۲ دقیقه بدون فعالیت = آفلاین

function trackOnlineUser(req) {
  if (!req.user) return;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
  _onlineUsers.set(req.user.id, {
    id: req.user.id,
    name: req.user.name || req.user.mobile,
    mobile: req.user.mobile,
    role: req.user.role,
    lastSeen: Date.now(),
    ip,
    currentTab: req.headers['x-current-tab'] || null,
  });
}

// پاکسازی کاربران آفلاین هر ۳۰ ثانیه
setInterval(() => {
  const now = Date.now();
  for (const [id, u] of _onlineUsers) {
    if (now - u.lastSeen > ONLINE_TIMEOUT) _onlineUsers.delete(id);
  }
}, 30000);

// ════════════════════════════════════
//  AUTH
// ════════════════════════════════════

app.post('/api/auth/login', (req, res) => {
  const { mobile, password } = req.body;
  if (!mobile || !password)
    return res.status(400).json({ error: 'شماره موبایل و پسورد الزامی است' });
  const user = db.verifyPassword(mobile.trim(), password);
  if (!user)
    return res.status(401).json({ error: 'شماره موبایل یا پسورد اشتباه است' });
  const token = signToken(user);
  res.json({ token, user: { id: user.id, name: user.name, mobile: user.mobile, role: user.role } });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  trackOnlineUser(req);
  const user = db.findById(req.user.id);
  if (!user) return res.status(401).json({ error: 'کاربر یافت نشد' });
  res.json(user);
});

// heartbeat — فرانت هر ۳۰ ثانیه صدا می‌زنه
app.post('/api/heartbeat', requireAuth, (req, res) => {
  if (req.body?.tab) {
    // ذخیره تب فعلی
    const existing = _onlineUsers.get(req.user.id);
    if (existing) existing.currentTab = req.body.tab;
  }
  trackOnlineUser(req);
  res.json({ ok: true });
});

// ════════════════════════════════════
//  SUPERADMIN — مدیریت کاربران
// ════════════════════════════════════

app.get('/api/admin/users', requireSuperAdmin, (req, res) => {
  res.json(db.getAllUsers());
});

app.post('/api/admin/users', requireSuperAdmin, (req, res) => {
  const { mobile, password, name, role } = req.body;
  if (!mobile || !password)
    return res.status(400).json({ error: 'موبایل و پسورد الزامی است' });
  if (!/^09\d{9}$/.test(mobile.trim()))
    return res.status(400).json({ error: 'فرمت موبایل اشتباه است (مثال: 09123456789)' });
  if (password.length < 6)
    return res.status(400).json({ error: 'پسورد حداقل ۶ کاراکتر' });
  try {
    const user = db.createUser({
      mobile: mobile.trim(), password,
      name: (name || '').trim() || mobile.trim(),
      role: role === 'superadmin' ? 'superadmin' : 'user',
    });
    res.status(201).json(user);
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.delete('/api/admin/users/:id', requireSuperAdmin, (req, res) => {
  if (req.params.id === req.user.id)
    return res.status(400).json({ error: 'نمی‌توانید حساب خودتان را حذف کنید' });
  try { db.deleteUser(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(404).json({ error: e.message }); }
});

app.patch('/api/admin/users/:id/toggle', requireSuperAdmin, (req, res) => {
  if (req.params.id === req.user.id)
    return res.status(400).json({ error: 'نمی‌توانید حساب خودتان را غیرفعال کنید' });
  try {
    const user = db.toggleActive(req.params.id, !!req.body.active);
    res.json(user);
  } catch (e) { res.status(404).json({ error: e.message }); }
});

// ── کاربران آنلاین (فقط ادمین‌ها) ──
app.get('/api/admin/online-users', requireSuperAdmin, (req, res) => {
  const now = Date.now();
  const online = [];
  for (const [, u] of _onlineUsers) {
    if (now - u.lastSeen <= ONLINE_TIMEOUT) {
      online.push({
        id: u.id,
        name: u.name,
        mobile: u.mobile,
        role: u.role,
        currentTab: u.currentTab,
        lastSeen: new Date(u.lastSeen).toISOString(),
        idleSeconds: Math.floor((now - u.lastSeen) / 1000),
      });
    }
  }
  res.json({ count: online.length, users: online });
});

// ════════════════════════════════════
//  MARKET ایران
// ════════════════════════════════════
app.use('/api/market', requireAuth, marketRouter);
app.use('/api/jobs', requireAuth, jobRouter);
app.use('/api/news', requireAuth, newsRouter);
app.use('/api/finance', requireAuth, financeRouter);
app.use('/api/polymarket', requireAuth, polymarketRouter);
app.use('/api/timeline', requireAuth, timelineRouter);
app.use('/api/trend-history', requireAuth, trendRouter);
app.use('/api/cars', requireAuth, carRouter);

// media proxy برای عکس/ویدیو تلگرام
app.get('/api/news/media', requireAuth, (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith('https://api.telegram.org/file/')) return res.status(400).end();
  const https = require('https');
  https.get(url, r => {
    res.setHeader('Content-Type', r.headers['content-type'] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public,max-age=86400');
    r.pipe(res);
  }).on('error', () => res.status(502).end());
});

// ════════════════════════════════════
//  INTERNAL — از Telethon Python
// ════════════════════════════════════
const INTERNAL_SECRET = process.env.NODE_INTERNAL_SECRET;
const newsDB = require('./news-db');
const { translateAndSave, migrateMediaToDisk } = require('./news-bot');

app.post('/internal/channel-info', (req, res) => {
  if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) return res.status(401).end();
  const { tg_id, channel_title, channel_username, photo_b64 } = req.body;
  if (!tg_id) return res.status(400).end();
  try {
    const channel = newsDB.getChannelByTgId(String(tg_id));
    if (channel) {
      let photo_url = channel.photo_url;
      if (photo_b64) {
        const photoDir = path.join(__dirname, 'public', 'channel-photos');
        if (!require('fs').existsSync(photoDir)) require('fs').mkdirSync(photoDir, {recursive:true});
        const b64data = photo_b64.replace(/^data:image\/\w+;base64,/,'');
        require('fs').writeFileSync(path.join(photoDir, `${channel.id}.jpg`), Buffer.from(b64data,'base64'));
        photo_url = `/channel-photos/${channel.id}.jpg`;
      }
      newsDB.updateChannel(channel.id, {
        username: channel_username || channel.username,
        title: channel.title, // اسم دستی کاربر رو حفظ کن
        category: channel.category || 'خبرگزاری‌ها',
        photo_url,
      });
      console.log(`[channel-info] updated: ${channel.title} photo: ${photo_url||'none'}`);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/news', (req, res) => {
  if (req.headers['x-internal-secret'] !== INTERNAL_SECRET)
    return res.status(401).json({ error: 'unauthorized' });

  const msg = req.body;
  if (!msg?.tg_id || !msg?.message_id) return res.status(400).json({ error: 'invalid' });

  // upsert channel اگه نبود
  let channel = newsDB.getChannelByTgId(String(msg.tg_id));
  if (!channel) {
    // کانال جدید — با دسته‌بندی پیش‌فرض ذخیره کن
    newsDB.upsertChannel(String(msg.tg_id), msg.channel_username||null, msg.channel_title||msg.tg_id, 'خبرگزاری‌ها', null);
    channel = newsDB.getChannelByTgId(String(msg.tg_id));
  }
  if (!channel) return res.status(500).json({ error: 'channel error' });

  // ذخیره و ترجمه async
  translateAndSave(channel, msg).catch(console.error);

  res.json({ ok: true });
});

// ── INTERNAL: finance channels (از Telethon Python) ──
const FINANCE_MEDIA_DIR = path.join(__dirname, 'public', 'finance-media');
function ensureFinanceMediaDir() {
  if (!fs.existsSync(FINANCE_MEDIA_DIR)) fs.mkdirSync(FINANCE_MEDIA_DIR, { recursive: true });
}
function saveFinanceBase64Image(dataUrl, baseName) {
  try {
    const m = dataUrl.match(/^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/s);
    if (!m) return null;
    ensureFinanceMediaDir();
    const ext = m[1].includes('png') ? 'png' : m[1].includes('webp') ? 'webp' : m[1].includes('gif') ? 'gif' : 'jpg';
    const fname = `${baseName}.${ext}`;
    fs.writeFileSync(path.join(FINANCE_MEDIA_DIR, fname), Buffer.from(m[2], 'base64'));
    return `/finance-media/${fname}`;
  } catch (e) { console.warn('[finance] saveBase64Image error:', e.message); return null; }
}
function _detectLang(text) {
  if (!text) return 'fa';
  const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const englishChars = (text.match(/[a-zA-Z]/g) || []).length;
  const totalChars = text.replace(/\s/g, '').length;
  if (totalChars === 0) return 'fa';
  if (englishChars / totalChars > 0.5) return 'en';
  const persianChars = (text.match(/[پچژگ]/g) || []).length;
  if (arabicChars / totalChars > 0.3 && persianChars === 0 && arabicChars > 10) return 'ar';
  return 'fa';
}
async function _translateText(text, fromLang) {
  if (!text || text.length < 10) return null;
  try {
    const sl = fromLang === 'ar' ? 'ar' : fromLang === 'en' ? 'en' : 'auto';
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=fa&dt=t&q=${encodeURIComponent(text.slice(0, 1000))}`;
    return await new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)[0].map(x => x[0]).filter(Boolean).join('') || null); } catch(e) { reject(e); } });
      }).on('error', reject).setTimeout(15000, function(){ this.destroy(); reject(new Error('timeout')); });
    });
  } catch(e) { console.warn('[finance] translate error:', e.message); return null; }
}

async function translateAndSaveFinance(channel, msg) {
  const text = msg.text || '';
  const lang = _detectLang(text);
  let text_fa = null;
  if (channel.needs_translation !== 0 && lang !== 'fa' && text.length > 10) {
    text_fa = await _translateText(text, lang);
  }
  let media_url = null;
  const mediaList = Array.isArray(msg.media_list) ? msg.media_list.filter(m => m && m.b64) : [];
  if (mediaList.length > 1) {
    const paths = [];
    mediaList.forEach((m, i) => {
      const p = saveFinanceBase64Image(`data:${m.mime||'image/jpeg'};base64,${m.b64}`, `${channel.id}_${msg.message_id}_${i}`);
      if (p) paths.push(p);
    });
    media_url = paths.length ? JSON.stringify(paths) : null;
  } else if (mediaList.length === 1) {
    media_url = saveFinanceBase64Image(`data:${mediaList[0].mime||'image/jpeg'};base64,${mediaList[0].b64}`, `${channel.id}_${msg.message_id}_0`);
  }
  financeDB.saveFinanceMessage({
    channel_id: channel.id, message_id: msg.message_id,
    text: text.slice(0, 4000), text_fa, lang,
    media_type: mediaList.length > 1 ? 'gallery' : (msg.media_type || null),
    media_url, tg_link: msg.tg_link || null,
    published_at: msg.published_at || new Date().toISOString(),
  });
}

app.post('/internal/finance-channel-info', (req, res) => {
  if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) return res.status(401).end();
  const { tg_id, channel_title, channel_username, photo_b64 } = req.body;
  if (!tg_id) return res.status(400).end();
  try {
    let channel = financeDB.getFinanceChannelByTgId(String(tg_id));
    if (channel_username) {
      const byUsername = financeDB.getFinanceChannelByTgId(String(channel_username));
      if (byUsername && (!channel || byUsername.id !== channel.id)) {
        if (channel) {
          financeDB.deleteFinanceChannel(channel.id);
        }
        channel = byUsername;
        financeDB.updateFinanceChannel(channel.id, { tg_id: String(tg_id), username: channel_username });
      }
    }
    if (channel) {
      let photo_url = channel.photo_url;
      if (photo_b64) {
        const photoDir = path.join(__dirname, 'public', 'channel-photos');
        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, {recursive:true});
        const b64data = photo_b64.replace(/^data:image\/\w+;base64,/,'');
        fs.writeFileSync(path.join(photoDir, `fin_${channel.id}.jpg`), Buffer.from(b64data,'base64'));
        photo_url = `/channel-photos/fin_${channel.id}.jpg`;
      }
      financeDB.updateFinanceChannel(channel.id, {
        username: channel_username || channel.username,
        tg_id: String(tg_id),
        title: channel.title, category: channel.category || 'ارز دیجیتال', photo_url,
      });
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/finance-message', (req, res) => {
  if (req.headers['x-internal-secret'] !== INTERNAL_SECRET)
    return res.status(401).json({ error: 'unauthorized' });
  const msg = req.body;
  if (!msg?.tg_id || !msg?.message_id) return res.status(400).json({ error: 'invalid' });
  let channel = financeDB.getFinanceChannelByTgId(String(msg.tg_id));
  if (!channel) {
    financeDB.upsertFinanceChannel(String(msg.tg_id), msg.channel_username||null, msg.channel_title||msg.tg_id, 'ارز دیجیتال', null);
    channel = financeDB.getFinanceChannelByTgId(String(msg.tg_id));
  }
  if (!channel) return res.status(500).json({ error: 'channel error' });
  translateAndSaveFinance(channel, msg).catch(console.error);
  res.json({ ok: true });
});



const settingsDB = require('./settings-db');

const FREE_DEFAULTS = [
  { id: 'google/gemma-4-26b-a4b-it:free',              name: 'Gemma 4 26B',             free: true, pinned: true },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free',      name: 'Nemotron 3 Super 120B',   free: true, pinned: true },
  { id: 'nvidia/nemotron-3-nano-30b-a3b:free',          name: 'Nemotron 3 Nano 30B',     free: true, pinned: true },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free',       name: 'Nemotron 3 Ultra 550B',   free: true, pinned: true },
  { id: 'openai/gpt-oss-20b:free',                    name: 'GPT-OSS 20B',              free: true, pinned: true },
];

let _modelsCache = null;
let _modelsCacheTime = 0;

async function fetchOpenRouterModels() {
  if (_modelsCache && Date.now() - _modelsCacheTime < 30*60*1000) return _modelsCache;
  return new Promise(resolve => {
    const KEY = process.env.OPENROUTER_KEY || '';
    require('https').get({
      hostname:'openrouter.ai',
      path:'/api/v1/models?output_modalities=text&sort=most-popular',
      headers:{'Authorization':'Bearer '+KEY}
    }, res => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{
        try {
          const models = (JSON.parse(d).data||[]).map(m=>({
            id: m.id, name: m.name||m.id,
            free: m.pricing?.completion==='0' && m.pricing?.prompt==='0',
            context: m.context_length,
          }));
          _modelsCache = models; _modelsCacheTime = Date.now();
          resolve(models);
        } catch(e){ resolve([]); }
      });
    }).on('error',()=>resolve([]));
  });
}

app.get('/api/settings', requireSuperAdmin, (req, res) => {
  res.json({ ...settingsDB.getAll(), ai_model: settingsDB.get('ai_model','google/gemma-4-26b-a4b-it:free') });
});

app.post('/api/settings', requireSuperAdmin, (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  settingsDB.set(key, value);
  res.json({ ok: true });
});

app.post('/api/settings/ai-model', requireAuth, (req, res) => {
  const { modelId } = req.body;
  if (!modelId) return res.status(400).json({ error: 'modelId required' });
  settingsDB.set('ai_model', modelId);
  console.log(`[settings] ai_model set to ${modelId} by user ${req.user.id}`);
  res.json({ ok: true });
});

app.post('/api/settings/timeline-ai-model', requireAuth, (req, res) => {
  const { modelId } = req.body;
  // empty modelId = clear, fall back to general model
  if (modelId === '') { settingsDB.set('timeline_ai_model', ''); }
  else if (modelId) { settingsDB.set('timeline_ai_model', modelId); }
  else return res.status(400).json({ error: 'modelId required' });
  console.log(`[settings] timeline_ai_model set to "${modelId||'(use general)'}" by user ${req.user.id}`);
  res.json({ ok: true });
});

app.get('/api/settings/ai-models', requireAuth, async (req, res) => {
  const current = settingsDB.get('ai_model','google/gemma-4-26b-a4b-it:free');
  const tlRaw = settingsDB.get('timeline_ai_model','');
  const timeline_current = tlRaw ? tlRaw : current; // empty => falls back to general
  try {
    const all = await fetchOpenRouterModels();
    const pinnedIds = new Set(FREE_DEFAULTS.map(m=>m.id));
    const otherFree = all.filter(m=>m.free && !pinnedIds.has(m.id));
    const paid = all.filter(m=>!m.free);
    res.json({ models:[...FREE_DEFAULTS,...otherFree,...paid], current, timeline_current });
  } catch(e) {
    res.json({ models: FREE_DEFAULTS, current, timeline_current });
  }
});

app.post('/api/digest/:type/refresh', requireAuth, async (req, res) => {
  const { type } = req.params;
  res.json({ ok: true });
  if (type === '4h') refresh4h().catch(console.error);
  else if (type === '24h') refresh24h().catch(console.error);
});

app.get('/api/digest/:type', requireAuth, (req, res) => {
  const type = req.params.type;
  if (!['4h','24h'].includes(type)) return res.status(400).json({ error: 'invalid type' });
  const data = loadDigest(type);
  if (!data) return res.status(503).json({ error: 'digest not ready' });
  res.json(data);
});

app.get('/api/rss/live', requireAuth, (req, res) => {
  const data = _crawlers.scheduler?.loadRssLive?.();
  if (!data) return res.status(503).json({ error: 'داده RSS آماده نشده' });
  res.json(data);
});

app.get('/api/trends/4h', requireAuth, (req, res) => {
  const data = _crawlers.scheduler?.load?.('h4');
  if (!data) return res.status(503).json({ error: 'داده آماده نشده' });
  res.json(data);
});

app.get('/api/trends/24h', requireAuth, (req, res) => {
  const data = _crawlers.scheduler?.load?.('h24');
  if (!data) return res.status(503).json({ error: 'داده آماده نشده' });
  res.json(data);
});

app.get('/api/status', requireAuth, (req, res) => {
  const h4  = path.join(__dirname, 'data', 'h4.json');
  const h24 = path.join(__dirname, 'data', 'h24.json');
  res.json({
    ok: fs.existsSync(h4) && fs.existsSync(h24),
    h4:  { exists: fs.existsSync(h4),  lastModified: fs.existsSync(h4)  ? fs.statSync(h4).mtime  : null },
    h24: { exists: fs.existsSync(h24), lastModified: fs.existsSync(h24) ? fs.statSync(h24).mtime : null },
  });
});

// ════════════════════════════════════
//  RSS PROXY — Google Trends Iran
// ════════════════════════════════════

app.get('/api/rss', requireAuth, (req, res) => {
  const url = 'https://trends.google.com/trending/rss?geo=IR';
  https.get(url, { headers: { 'Accept-Language': 'fa-IR,fa;q=0.9', 'User-Agent': 'Mozilla/5.0' } }, (rssRes) => {
    let xml = '';
    rssRes.on('data', chunk => xml += chunk);
    rssRes.on('end', () => {
      try {
        const items = [];
        const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
        for (const match of itemMatches) {
          const block = match[1];
          const title         = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || block.match(/<title>(.*?)<\/title>/))?.[1]?.trim() || '';
          const link          = block.match(/<link>(.*?)<\/link>/)?.[1]?.trim() || '';
          const description   = (block.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || block.match(/<description>(.*?)<\/description>/))?.[1]?.trim() || '';
          const pubDate       = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim() || '';
          const image         = block.match(/<ht:picture>(.*?)<\/ht:picture>/)?.[1]?.trim() || '';
          const approxTraffic = block.match(/<ht:approx_traffic>(.*?)<\/ht:approx_traffic>/)?.[1]?.trim() || '';
          if (title) items.push({ title, link, description, pubDate, image, approxTraffic });
        }
        res.json({ items, fetchedAt: new Date().toISOString() });
      } catch(e) {
        res.status(500).json({ error: 'parse error', items: [] });
      }
    });
  }).on('error', (e) => {
    res.status(500).json({ error: e.message, items: [] });
  });
});

// ════════════════════════════════════
//  SPA fallback
// ════════════════════════════════════

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ════════════════════════════════════
//  START
// ════════════════════════════════════

db.seedSuperAdmin();

// Safety net for the 2026-08-05 disk-full outage: if the process was killed
// mid-crawl (crash, OOM, `pm2 kill`), the in-memory reference to that crawl's
// Chrome profile dir is lost and it leaks forever. Sweep anything stale on boot.
try { require('./lib/browser-lifecycle').sweepStaleProfileDirs(); } catch (e) { console.warn('[warn] profile-dir sweep failed:', e.message); }

app.listen(PORT, () => {
  console.log(`\nSignal → http://localhost:${PORT}`);
  _crawlers.scheduler?.startScheduler?.();
  _crawlers.market?.startMarketScheduler?.();
  _crawlers.job?.startJobScheduler?.();
  startPolymarketScheduler();
  require('./gold-crawler').startGoldScheduler(10);
  startDigestScheduler();
  if (financeCrawler) financeCrawler.startScheduler();
  if (carCrawler) carCrawler.startCarScheduler();
  startNewsBot();
  migrateMediaToDisk().catch(console.error);
  try { require('./timeline-engine').startScheduler(); } catch(e) { console.warn('[warn] timeline-engine not started:', e.message); }
});
