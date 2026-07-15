const express = require('express');
const router = express.Router();
const financeDB = require('./finance-db');

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
