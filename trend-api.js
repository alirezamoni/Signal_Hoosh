/**
 * trend-api.js — endpointهای تاریخچه ترند جستجو
 * (ترندهای زنده همچنان از /api/trends/4h|24h در server.js می‌آیند؛ این‌ها تاریخی‌اند)
 */
const express = require('express');
const router = express.Router();
const trendDB = require('./trend-db');

function intParam(v, def, max) {
  const n = parseInt(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return max ? Math.min(n, max) : n;
}

router.get('/stats', (req, res) => {
  try { res.json(trendDB.getStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/hall-of-fame', (req, res) => {
  try {
    const limit = intParam(req.query.limit, 50, 200);
    const days = req.query.days ? intParam(req.query.days, 30, 365) : null;
    res.json(trendDB.getHallOfFame(limit, days));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/persistent', (req, res) => {
  try { res.json(trendDB.getMostPersistent(intParam(req.query.limit, 15, 100))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/meteors', (req, res) => {
  try { res.json(trendDB.getMeteors(intParam(req.query.limit, 15, 100))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/timeline', (req, res) => {
  const kw = (req.query.keyword || '').trim();
  if (!kw) return res.status(400).json({ error: 'keyword الزامی است' });
  try { res.json({ keyword: kw, points: trendDB.getKeywordTimeline(kw, intParam(req.query.days, 30, 365)) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/categories', (req, res) => {
  try { res.json(trendDB.getCategoryShare(intParam(req.query.days, 7, 365))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/heatmap', (req, res) => {
  try { res.json(trendDB.getActivityHeatmap(intParam(req.query.days, 14, 90))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
