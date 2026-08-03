/**
 * job-api.js — endpoints مارکت کار ایران
 */
const express  = require('express');
const router   = express.Router();
const jobDB    = require('./job-db');
const { crawlJobs } = require('./job-crawler');
const aiClient = require('./lib/ai-client');

const CAT_LABELS = {
  'human-resources':   'منابع انسانی',
  'accounting':        'حسابداری',
  'developer':         'برنامه‌نویسی',
  'data-science':      'هوش مصنوعی و داده',
  'digital-marketing': 'دیجیتال مارکتینگ',
  'driver':            'راننده',
  'civil':             'مهندسی عمران',
};

router.get('/summary', (req, res) => {
  const data = jobDB.getSummary();
  if (!data) return res.status(503).json({ error: 'داده آماده نیست' });
  res.json(data);
});

router.get('/history', (req, res) => {
  const days = parseInt(req.query.days) || 30;
  res.json(jobDB.getTotalHistory(days));
});

router.get('/history/:category', (req, res) => {
  const days = parseInt(req.query.days) || 30;
  res.json(jobDB.getCategoryHistory(req.params.category, days));
});

router.get('/ai-analysis', async (req, res) => {
  const summary = jobDB.getSummary();
  if (!summary) return res.json({ analysis: 'داده کافی موجود نیست' });

  const cats = Object.entries(summary.categories||{}).map(([k,v])=>
    `${CAT_LABELS[k]||k}: ${v.count||0} آگهی`
  ).join('، ');

  const prompt = `پاسخ را فقط به فارسی بنویس. بدون مقدمه مستقیم شروع کن.
داده‌های بازار کار ایران:
- جابینجا: ${summary.sources?.jobinja?.count?.toLocaleString()} فرصت
- جاب‌ویژن: ${summary.sources?.jobvision?.count?.toLocaleString()} آگهی
- مجموع: ${summary.total?.count?.toLocaleString()}
دسته‌ها: ${cats}
در ۳ جمله وضعیت بازار کار ایران را تحلیل کن. فقط بر اساس داده‌ها.`;

  const text = await aiClient.callText(prompt, { max_tokens: 1000, tag: 'job-ai', validate: () => true });
  res.json({ analysis: text });
});

router.post('/crawl', async (req, res) => {
  res.json({ message: 'job crawl started' });
  crawlJobs().catch(console.error);
});

module.exports = router;
