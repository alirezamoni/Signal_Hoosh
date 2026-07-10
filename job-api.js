/**
 * job-api.js — endpoints مارکت کار ایران
 */
const express  = require('express');
const https    = require('https');
const router   = express.Router();
const jobDB    = require('./job-db');
const { crawlJobs } = require('./job-crawler');

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

// تحلیل AI
router.get('/ai-analysis', async (req, res) => {
  const OPENROUTER_KEY = process.env.OPENROUTER_KEY || '';
  if (!OPENROUTER_KEY) return res.json({ analysis: null });

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

  try {
    const settingsDB = require('./settings-db');
    const model = settingsDB.get('ai_model','openai/gpt-oss-20b:free');
    const body = JSON.stringify({model, messages:[{role:'user',content:prompt}], max_tokens:400});
    const result = await new Promise((resolve,reject)=>{
      const req2 = https.request({hostname:'openrouter.ai',path:'/api/v1/chat/completions',method:'POST',
        headers:{'Authorization':`Bearer ${OPENROUTER_KEY}`,'Content-Type':'application/json','HTTP-Referer':'https://signal.ir','Content-Length':Buffer.byteLength(body)}
      },r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});
      req2.on('error',reject);
      req2.setTimeout(25000,()=>{req2.destroy();reject(new Error('timeout'));});
      req2.write(body);req2.end();
    });
    res.json({ analysis: result.choices?.[0]?.message?.content||'' });
  } catch(e) {
    res.json({ analysis: null });
  }
});

router.post('/crawl', async (req, res) => {
  res.json({ message: 'job crawl started' });
  crawlJobs().catch(console.error);
});

module.exports = router;
