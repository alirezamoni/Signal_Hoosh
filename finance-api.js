const express = require('express');
const router = express.Router();
const financeDB = require('./finance-db');
const fs = require('fs');
const path = require('path');

const CHANNELS_FILE = path.join(__dirname, 'data', 'watched_finance_channels.json');

function updateWatchedFinanceChannels() {
  try {
    const channels = financeDB.getFinanceChannels();
    const list = channels.map(c => c.username || c.tg_id).filter(Boolean);
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(list, null, 2));
    console.log('[finance-api] watched_finance_channels updated:', list);
  } catch(e) {
    console.warn('[finance-api] watched_finance_channels update error:', e.message);
  }
}

// ══════════════════════════════════════
//  FINANCE CHANNELS (Telegram) — قبل از /:symbol
// ══════════════════════════════════════

// لیست کانال‌ها
router.get('/channels/list', (req, res) => {
  res.json(financeDB.getFinanceChannels());
});

// فید پیام‌ها
router.get('/messages', (req, res) => {
  const limit      = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset     = parseInt(req.query.offset) || 0;
  const channel_id = req.query.channel ? parseInt(req.query.channel) : null;
  const since      = parseInt(req.query.since) || 0;
  res.json(financeDB.getLatestFinanceMessages(limit, channel_id, offset, since));
});

// افزودن کانال
router.post('/channels', async (req, res) => {
  const { tg_id, username, title, category, photo_url, needs_translation } = req.body;
  if (!tg_id || !title) return res.status(400).json({ error: 'tg_id و title الزامی است' });
  try {
    const nt = needs_translation !== undefined ? !!needs_translation : true;
    const id = financeDB.upsertFinanceChannel(String(tg_id), username||null, title, category||'ارز دیجیتال', photo_url||null, nt);
    updateWatchedFinanceChannels();
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ویرایش کانال
router.patch('/channels/:id', (req, res) => {
  const { username, title, category, photo_url, needs_translation } = req.body;
  if (!title) return res.status(400).json({ error: 'نام الزامی است' });
  try {
    financeDB.updateFinanceChannel(req.params.id, { username: username||null, title, category: category||'ارز دیجیتال', photo_url: photo_url||null, needs_translation });
    updateWatchedFinanceChannels();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// حذف کانال
router.delete('/channels/:id', (req, res) => {
  financeDB.deleteFinanceChannel(req.params.id);
  updateWatchedFinanceChannels();
  res.json({ ok: true });
});

// حذف پیام
router.delete('/messages/:id', (req, res) => {
  financeDB.deleteFinanceMessage(req.params.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════
//  MARKET DATA
// ══════════════════════════════════════

// ── همه آخرین قیمت‌ها + sparkline ──
router.get('/latest', (req, res) => {
  try {
    const latest = financeDB.getLatest();
    const result = latest.map(item => ({
      ...item,
      sparkline: financeDB.getSparkline(item.symbol, 30),
    }));
    res.json({ markets: result, count: result.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── جزئیات یک نماد + تغییرات ──
router.get('/:symbol', (req, res) => {
  const symbol = req.params.symbol;
  try {
    const changes = financeDB.getChanges(symbol);
    if (!changes) return res.status(404).json({ error: 'نماد یافت نشد' });
    res.json(changes);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── تاریخچه یک نماد برای نمودار ──
router.get('/:symbol/history', (req, res) => {
  const symbol = req.params.symbol;
  const hours = parseInt(req.query.hours) || 24;
  try {
    const history = financeDB.getHistory(symbol, Math.min(hours, 8760));
    res.json({ symbol, hours, points: history.length, history });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
