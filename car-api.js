/**
 * car-api.js — endpointهای ترند خودرو ایران
 */
const express = require('express');
const router = express.Router();
const carDB = require('./car-db');
const { crawlCars } = require('./car-crawler');

// وضعیت فعلی همه مدل‌ها + تغییر نسبت به نوبت قبل و دیروز
router.get('/latest', (req, res) => {
  try {
    const models = carDB.getLatest();
    const withData = models.filter(m => m.snapshot);
    const priced = withData.filter(m => m.snapshot.median_price != null);
    const summary = {
      models: models.length,
      with_data: withData.length,
      most_expensive: priced.length
        ? priced.reduce((a, b) => (a.snapshot.median_price > b.snapshot.median_price ? a : b)).slug : null,
      cheapest: priced.length
        ? priced.reduce((a, b) => (a.snapshot.median_price < b.snapshot.median_price ? a : b)).slug : null,
    };
    res.json({ models, summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/momentum', (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 365);
  try { res.json(carDB.getMomentum(days)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/value', (req, res) => {
  try { res.json(carDB.getValueScores()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/stats', (req, res) => {
  try { res.json(carDB.getStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/history/:slug', (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  try { res.json({ slug: req.params.slug, points: carDB.getHistory(req.params.slug, days) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// تنوع زیرمدل‌ها (تریم/سوخت/گیربکس) هر برند — از باکس آماری دیوار، گروه‌بندی‌شده
router.get('/submodels', (req, res) => {
  try {
    const rows = carDB.getLatestSubmodels();
    const grouped = {};
    for (const r of rows) (grouped[r.model_slug] = grouped[r.model_slug] || []).push(r);
    res.json(grouped);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// اجرای دستی کرال (برای وقتی که نمی‌خواهیم ۱۲ ساعت صبر کنیم)
router.post('/crawl', (req, res) => {
  res.json({ message: 'car crawl started' });
  crawlCars().catch(console.error);
});

module.exports = router;
