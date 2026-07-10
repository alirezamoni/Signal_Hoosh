#!/bin/bash
# نصب و راه‌اندازی news listener (فقط برای نصب اولیه — session فعلی production را دست نزن)
# قبل از اجرا، این‌ها باید در محیط ست شده باشند (از .env پروژه می‌آیند):
#   TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_PHONE, NODE_INTERNAL_SECRET
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then set -a; source .env; set +a; fi
: "${TELEGRAM_API_ID:?TELEGRAM_API_ID در .env ست نشده}"
: "${TELEGRAM_API_HASH:?TELEGRAM_API_HASH در .env ست نشده}"

echo "=== نصب Telethon ==="
pip3 install telethon --break-system-packages

echo "=== ساخت session ==="
API_ID="$TELEGRAM_API_ID" API_HASH="$TELEGRAM_API_HASH" python3 << 'PYEOF'
import asyncio, os
from telethon import TelegramClient

API_ID   = int(os.environ['API_ID'])
API_HASH = os.environ['API_HASH']
SESSION  = './data/tg_session'

async def create_session():
    client = TelegramClient(SESSION, API_ID, API_HASH)
    await client.start()
    me = await client.get_me()
    print(f'✓ Session created for: {me.username or me.phone}')
    await client.disconnect()

asyncio.run(create_session())
PYEOF

echo "=== شروع listener با PM2 (از ecosystem.config.js که خودش .env را می‌خواند) ==="
pm2 start ecosystem.config.js --only news-listener
pm2 save
echo "=== تمام ==="
