/**
 * news-api.js — endpoints اخبار تلگرام
 */
const express = require('express');
const router  = express.Router();
const newsDB  = require('./news-db');
const { generateDigest } = require('./news-bot');
const fs   = require('fs');
const path = require('path');

const CHANNELS_FILE = path.join(__dirname, 'data', 'watched_channels.json');

function updateWatchedChannels() {
  try {
    const channels = newsDB.getChannels();
    const list = channels.map(c => c.username || c.tg_id).filter(Boolean);
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(list, null, 2));
    console.log('[news-api] watched_channels updated:', list);
  } catch(e) {
    console.warn('[news-api] watched_channels update error:', e.message);
  }
}

router.get('/feed', (req, res) => {
  const limit      = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset     = parseInt(req.query.offset) || 0;
  const channel_id = req.query.channel ? parseInt(req.query.channel) : null;
  res.json(newsDB.getLatestNews(limit, channel_id, offset));
});

router.get('/channels', (req, res) => {
  res.json(newsDB.getChannels());
});

router.get('/categories', (req, res) => {
  // دسته‌بندی‌ها از DB کانال‌ها ساخته می‌شود
  const channels = newsDB.getChannels();
  const cats = [...new Set(channels.map(c => c.category).filter(Boolean))];
  res.json(cats);
});

// افزودن کانال
router.post('/channels', async (req, res) => {
  const { tg_id, username, title, category, photo_url } = req.body;
  if (!tg_id || !title) return res.status(400).json({ error: 'tg_id و title الزامی است' });
  try {
    const id = newsDB.upsertChannel(String(tg_id), username||null, title, category||'خبرگزاری‌ها', photo_url||null);
    updateWatchedChannels();
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/channels/:id', (req, res) => {
  const { username, title, category, photo_url } = req.body;
  if (!title) return res.status(400).json({ error: 'نام الزامی است' });
  try {
    newsDB.updateChannel(req.params.id, { username: username||null, title, category: category||'خبرگزاری‌ها', photo_url: photo_url||null });
    updateWatchedChannels();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/channels/:id', (req, res) => {
  newsDB.deleteChannel(req.params.id);
  updateWatchedChannels();
  res.json({ ok: true });
});

router.delete('/news/:id', (req, res) => {
  newsDB.deleteNews(req.params.id);
  res.json({ ok: true });
});

router.get('/digest', (req, res) => {
  const digest = newsDB.getLatestDigest();
  if (!digest) return res.status(503).json({ error: 'digest not ready' });
  res.json(digest);
});

router.get('/stats', (req, res) => {
  try {
    res.json(newsDB.getNewsStats());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/digest/generate', async (req, res) => {
  res.json({ message: 'generating...' });
  generateDigest().catch(console.error);
});

module.exports = router;
