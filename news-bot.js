/**
 * news-bot.js — Telegram bot برای دریافت اخبار
 * از polling استفاده می‌کنه (بدون نیاز به webhook/SSL)
 */
const https  = require('https');
const newsDB = require('./news-db');
const settingsDB = require('./settings-db');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || '';

const FREE_MODELS = [
  'openai/gpt-oss-20b:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
];

function getModels() {
  const preferred = settingsDB.get('ai_model', 'openai/gpt-oss-20b:free');
  return [preferred, ...FREE_MODELS.filter(m => m !== preferred)];
}

// کانال‌های پیش‌فرض — بعداً از DB می‌خونه
const DEFAULT_CHANNELS = [];

let lastUpdateId = 0;

// ── Telegram API ─────────────────────────────────────────
function tgRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// ── تشخیص زبان ───────────────────────────────────────────
function detectLang(text) {
  if (!text) return 'fa';
  const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const englishChars = (text.match(/[a-zA-Z]/g) || []).length;
  const totalChars = text.replace(/\s/g, '').length;
  if (totalChars === 0) return 'fa';
  const arabicRatio = arabicChars / totalChars;
  const englishRatio = englishChars / totalChars;
  // فارسی و عربی هر دو از یونیکد عربی استفاده می‌کنن
  // اگه بیشتر از ۵۰٪ انگلیسی بود
  if (englishRatio > 0.5) return 'en';
  // اگه عربی بود ولی فارسی نبود (حروف خاص فارسی)
  const persianChars = (text.match(/[پچژگ]/g) || []).length;
  if (arabicRatio > 0.3 && persianChars === 0 && arabicChars > 10) return 'ar';
  return 'fa';
}

// ── ترجمه با AI ──────────────────────────────────────────
async function translateText(text, fromLang) {
  if (!text || text.length < 10) return null;
  try {
    const sl = fromLang === 'ar' ? 'ar' : fromLang === 'en' ? 'en' : 'auto';
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=fa&dt=t&q=${encodeURIComponent(text.slice(0, 1000))}`;
    const result = await new Promise((resolve, reject) => {
      https.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            const translated = j[0].map(x => x[0]).filter(Boolean).join('');
            resolve(translated || null);
          } catch(e) { reject(e); }
        });
      }).on('error', reject).setTimeout(15000, function(){ this.destroy(); reject(new Error('timeout')); });
    });
    return result;
  } catch(e) {
    console.warn('[news-bot] translate error:', e.message);
    return null;
  }
}

// ── پردازش پیام ──────────────────────────────────────────
async function processMessage(msg, channelInfo) {
  try {
    const text = msg.text || msg.caption || '';
    const lang = detectLang(text);

    // ترجمه اگه غیرفارسیه
    let text_fa = null;
    if (lang !== 'fa' && text.length > 10) {
      text_fa = await translateText(text, lang);
    }

    // media
    let media_type = null;
    let media_url = null;

    if (msg.photo) {
      media_type = 'photo';
      // بزرگترین عکس
      const photo = msg.photo[msg.photo.length - 1];
      try {
        const fileInfo = await tgRequest('getFile', { file_id: photo.file_id });
        if (fileInfo.result?.file_path) {
          media_url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;
        }
      } catch(e) {}
    } else if (msg.video || msg.animation) {
      media_type = msg.video ? 'video' : 'gif';
      const file = msg.video || msg.animation;
      try {
        const fileInfo = await tgRequest('getFile', { file_id: file.file_id });
        if (fileInfo.result?.file_path) {
          media_url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;
        }
      } catch(e) {}
    } else if (msg.document) {
      media_type = 'document';
    }

    // لینک به پیام اصلی
    const username = channelInfo.username?.replace('@', '');
    const tg_link = username ? `https://t.me/${username}/${msg.message_id}` : null;

    const saved = newsDB.saveNews({
      channel_id:   channelInfo.id,
      message_id:   msg.message_id,
      text:         text.slice(0, 4000),
      text_fa,
      lang,
      media_type,
      media_url,
      tg_link,
      published_at: new Date(msg.date * 1000).toISOString(),
    });

    if (saved) console.log(`[news-bot] saved: ${channelInfo.title} #${msg.message_id} (${lang})`);
  } catch(e) {
    console.warn('[news-bot] processMessage error:', e.message);
  }
}

// ── Polling ───────────────────────────────────────────────
async function poll() {
  try {
    const result = await tgRequest('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ['channel_post'],
    });

    if (!result.ok || !result.result?.length) return;

    for (const update of result.result) {
      lastUpdateId = update.update_id;
      const msg = update.channel_post;
      if (!msg) continue;

      const chatId = String(msg.chat.id);
      let channelInfo = newsDB.getChannelByTgId(chatId);

      if (!channelInfo) {
        // کانال جدید — اگه توی لیست مجاز نیست رد کن
        continue;
      }

      // آپدیت اطلاعات کانال
      if (msg.chat.title && msg.chat.title !== channelInfo.title) {
        newsDB.upsertChannel(chatId, msg.chat.username ? '@'+msg.chat.username : null, msg.chat.title);
        channelInfo = newsDB.getChannelByTgId(chatId);
      }

      // فقط پیام‌هایی که متن یا media دارن
      if (msg.text || msg.caption || msg.photo || msg.video || msg.animation) {
        await processMessage(msg, channelInfo);
      }
    }
  } catch(e) {
    if (!e.message?.includes('timeout')) {
      console.warn('[news-bot] poll error:', e.message);
    }
  }
}

// ── اضافه کردن کانال ────────────────────────────────────
async function addChannel(tg_id, username, title) {
  const id = newsDB.upsertChannel(tg_id, username, title);
  console.log(`[news-bot] channel added: ${title} (${tg_id})`);
  return id;
}

// ── گزارش عصر ──────────────────────────────────────────
async function generateDigest() {
  if (!OPENROUTER_KEY) return;
  const news = newsDB.getNewsSince(240);
  if (news.length < 3) { console.log('[news-bot] not enough news for digest'); return; }

  const newsText = news.slice(0, 30).map((n, i) => {
    const text = n.text_fa || n.text || '';
    return `${i+1}. [${n.channel_title}] ${text.slice(0, 200)}`;
  }).join('\n');

  const prompt = `پاسخ را فقط به فارسی بنویس. بدون مقدمه، مستقیم شروع کن.
اخبار ۴ ساعت گذشته از کانال‌های خبری:
${newsText}
---
یک گزارش خبری فشرده و حرفه‌ای در ۵ تا ۷ جمله بنویس:
۱. **مهم‌ترین خبر**: چه اتفاق مهمی افتاده؟
۲. **روند کلی اخبار**: اخبار بیشتر مثبت بود یا منفی؟
۳. **موضوعات داغ**: کدام موضوعات بیشتر پوشش داشتن؟
۴. **جمع‌بندی**: یک جمله خلاصه از وضعیت کلی
---
قوانین: فقط بر اساس اخبار | فارسی روان | بدون کلمه انگلیسی`;

  const freeModels = getModels();

  for (const model of freeModels) {
    try {
      const body = JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 800 });
      const result = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENROUTER_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://signal.ir',
            'X-Title': 'Signal Hoosh',
            'Content-Length': Buffer.byteLength(body),
          },
        }, res => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
        req.write(body); req.end();
      });

      const text = result.choices?.[0]?.message?.content || '';
      if (!text || result.error) { console.warn(`[digest] ${model} failed:`, result.error?.message?.slice(0,50)); continue; }

      const now = new Date().toISOString();
      newsDB.saveDigest(text, new Date(Date.now() - 4*60*60*1000).toISOString(), now);
      console.log(`[news-bot] digest saved (${model})`);
      return;
    } catch(e) {
      console.warn(`[digest] ${model} error:`, e.message);
    }
  }
  console.warn('[digest] all models failed');
}

function startNewsBot() {
  if (!BOT_TOKEN) { console.log('[news-bot] no BOT_TOKEN, skipping'); return; }

  console.log('[news-bot] starting polling...');
  // polling هر ۲ ثانیه
  setInterval(poll, 2000);
  // گزارش عصر هر ۴ ساعت
  setInterval(generateDigest, 4 * 60 * 60 * 1000);
  // cleanup هفتگی
  setInterval(() => newsDB.cleanup(), 24 * 60 * 60 * 1000);
  // اولین digest بعد از ۱ دقیقه
  setTimeout(generateDigest, 60000);
  console.log('[news-bot] polling every 2s, digest every 4h');
}

// تابع مشترک برای ذخیره پیام از Telethon
async function translateAndSave(channel, msg) {
  const text = msg.text || '';
  const lang = detectLang(text);
  let text_fa = null;
  if (lang !== 'fa' && text.length > 10) {
    text_fa = await translateText(text, lang);
  }

  // چندعکسه (آلبوم) → JSON آرایه از data-url ها
  let media_url = msg.media_url || null;
  const mediaList = Array.isArray(msg.media_list) ? msg.media_list.filter(m => m && m.b64) : [];

  if (mediaList.length > 1) {
    media_url = JSON.stringify(mediaList.map(m => `data:${m.mime||'image/jpeg'};base64,${m.b64}`));
  } else if (mediaList.length === 1) {
    media_url = `data:${mediaList[0].mime||'image/jpeg'};base64,${mediaList[0].b64}`;
  } else if (!media_url && msg.media_b64 && msg.media_type) {
    media_url = `data:image/jpeg;base64,${msg.media_b64}`;
  }

  newsDB.saveNews({
    channel_id:   channel.id,
    message_id:   msg.message_id,
    text:         text.slice(0, 4000),
    text_fa,
    lang,
    media_type:   mediaList.length > 1 ? 'gallery' : (msg.media_type || null),
    media_url,
    tg_link:      msg.tg_link || null,
    published_at: msg.published_at || new Date().toISOString(),
  });
}

module.exports = { startNewsBot, addChannel, generateDigest, translateAndSave };
