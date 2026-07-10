/**
 * market-api.js — endpoints مارکت ایران
 */
const express   = require('express');
const router    = express.Router();
const marketDB  = require('./market-db');
const { crawlMarket } = require('./market-crawler');

// لیست محصولات
router.get('/list', (req, res) => {
  const source = req.query.source || 'week';
  const limit  = Math.min(parseInt(req.query.limit) || 50, 100);
  res.json(marketDB.getLatestList(source, limit));
});

// کارت‌های خلاصه
router.get('/summary', (req, res) => {
  const source = req.query.source || 'week';
  res.json(marketDB.getSummaryCards(source));
});

// محصولات داغ
router.get('/hot', (req, res) => {
  const source = req.query.source || 'week';
  res.json(marketDB.getHotProducts(source, 10));
});

// بیشترین افت
router.get('/cold', (req, res) => {
  const source = req.query.source || 'week';
  res.json(marketDB.getColdProducts(source, 10));
});

// تازه‌واردها
router.get('/new-entrants', (req, res) => {
  const source = req.query.source || 'week';
  res.json(marketDB.getNewEntrants(source, 20));
});

// پرفروش ماندگار
router.get('/legends', (req, res) => {
  const source = req.query.source || 'week';
  res.json(marketDB.getLegends(source, 10));
});

// آمار دسته‌بندی
router.get('/categories', (req, res) => {
  const source = req.query.source || 'week';
  res.json(marketDB.getCategoryStats(source));
});

// آمار برند
router.get('/brands', (req, res) => {
  const source = req.query.source || 'week';
  res.json(marketDB.getBrandStats(source, 20));
});

// جزئیات یک محصول
router.get('/product/:id', (req, res) => {
  const source = req.query.source || 'week';
  const days   = parseInt(req.query.days) || 90;
  const history = marketDB.getProductHistory(req.params.id, source, days);
  const stats   = marketDB.getProductStats(req.params.id, source);
  res.json({ history, stats });
});

// trigger دستی crawl (فقط superadmin)
router.post('/crawl', async (req, res) => {
  res.json({ message: 'crawl started' });
  crawlMarket().catch(console.error);
});

module.exports = router;
