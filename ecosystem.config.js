require('dotenv').config({ path: __dirname + '/.env' });

module.exports = {
  apps: [
    {
      name: 'signal',
      script: 'server.js',
      cwd: __dirname,
      env: {
        NODE_ENV: process.env.NODE_ENV || 'production',
        PORT: process.env.PORT || 3001,
        OPENROUTER_KEY: process.env.OPENROUTER_KEY,
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
        NODE_INTERNAL_SECRET: process.env.NODE_INTERNAL_SECRET,
        JWT_SECRET: process.env.JWT_SECRET,
        ADMIN_MOBILE: process.env.ADMIN_MOBILE,
        ADMIN_PASS: process.env.ADMIN_PASS,
      }
    },
    {
      name: 'news-listener',
      script: 'news-listener.py',
      cwd: __dirname,
      interpreter: __dirname + '/venv/bin/python3',
      env: {
        TELEGRAM_PHONE: process.env.TELEGRAM_PHONE,
        TELEGRAM_API_ID: process.env.TELEGRAM_API_ID,
        TELEGRAM_API_HASH: process.env.TELEGRAM_API_HASH,
        NODE_INTERNAL_SECRET: process.env.NODE_INTERNAL_SECRET,
      }
    }
  ]
}
