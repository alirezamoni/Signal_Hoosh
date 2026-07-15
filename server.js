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
const { startScheduler, load, loadRssLive } = require('./crawler');
const { startMarketScheduler } = require('./market-crawler');
const marketRouter = require('./market-api');
const { startJobScheduler } = require('./job-crawler');
const jobRouter = require('./job-api');
const { startDigestScheduler, loadDigest, refresh4h, refresh24h } = require('./ai-digest');
const { startNewsBot } = require('./news-bot');
const newsRouter = require('./news-api');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: true, credentials: true }));
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
const { translateAndSave } = require('./news-bot');

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



const settingsDB = require('./settings-db');

const FREE_DEFAULTS = [
  { id: 'openai/gpt-oss-20b:free',                    name: 'GPT-OSS 20B',              free: true, pinned: true },
  { id: 'tencent/hy3:free',                            name: 'Tencent Hy3',              free: true, pinned: true },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free',      name: 'Nemotron 3 Super 120B',   free: true, pinned: true },
  { id: 'meta-llama/llama-3.3-70b-instruct:free',      name: 'Llama 3.3 70B',           free: true, pinned: true },
  { id: 'google/gemma-4-31b-it:free',                 name: 'Gemma 4 31B',             free: true, pinned: true },
  { id: 'nvidia/nemotron-3-nano-30b-a3b:free',          name: 'Nemotron 3 Nano 30B',     free: true, pinned: true },
  { id: 'qwen/qwen3-next-80b-a3b-instruct:free',        name: 'Qwen3 Next 80B',         free: true, pinned: true },
  { id: 'poolside/laguna-m.1:free',                    name: 'Poolside Laguna M.1',     free: true, pinned: true },
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
  res.json({ ...settingsDB.getAll(), ai_model: settingsDB.get('ai_model','openai/gpt-oss-20b:free') });
});

app.post('/api/settings', requireSuperAdmin, (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  settingsDB.set(key, value);
  res.json({ ok: true });
});

app.get('/api/settings/ai-models', requireAuth, async (req, res) => {
  const current = settingsDB.get('ai_model','openai/gpt-oss-20b:free');
  try {
    const all = await fetchOpenRouterModels();
    const pinnedIds = new Set(FREE_DEFAULTS.map(m=>m.id));
    const otherFree = all.filter(m=>m.free && !pinnedIds.has(m.id));
    const paid = all.filter(m=>!m.free);
    res.json({ models:[...FREE_DEFAULTS,...otherFree,...paid], current });
  } catch(e) {
    res.json({ models: FREE_DEFAULTS, current });
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
  const data = loadRssLive();
  if (!data) return res.status(503).json({ error: 'داده RSS آماده نشده' });
  res.json(data);
});

app.get('/api/trends/4h', requireAuth, (req, res) => {
  const data = load('h4');
  if (!data) return res.status(503).json({ error: 'داده آماده نشده' });
  res.json(data);
});

app.get('/api/trends/24h', requireAuth, (req, res) => {
  const data = load('h24');
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

app.listen(PORT, () => {
  console.log(`\nSignal → http://localhost:${PORT}`);
  startScheduler();
  startMarketScheduler();
  startJobScheduler();
  startDigestScheduler();
  startNewsBot();
});
