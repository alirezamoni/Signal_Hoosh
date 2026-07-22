/**
 * polymarket-api.js — endpoints ترندهای Polymarket (ایران)
 */
const express = require('express');
const router = express.Router();
const polyDB = require('./polymarket-db');
const { crawlPolymarket } = require('./polymarket-crawler');

// ترندترین شرط‌بندی‌های مربوط به ایران
router.get('/trending', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  res.json(polyDB.getSortedList('trending', limit));
});

// حجیم‌ترین شرط‌بندی‌های مربوط به ایران
router.get('/volume', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  res.json(polyDB.getSortedList('volume', limit));
});

// وضعیت آخرین crawl
router.get('/status', (req, res) => {
  res.json(polyDB.getStatus());
});

// trigger دستی crawl
router.post('/crawl', (req, res) => {
  res.json({ message: 'crawl started' });
  crawlPolymarket().catch(console.error);
});

module.exports = router;
