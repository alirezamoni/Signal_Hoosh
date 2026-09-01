"""
news-listener.py — Telethon listener برای کانال‌های تلگرام
"""
import asyncio, json, os, sys, logging, base64
from urllib.request import urlopen, Request
from telethon import TelegramClient, events
from telethon.tl.types import MessageMediaPhoto, MessageMediaDocument

logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(message)s', datefmt='%H:%M:%S')
log = logging.getLogger('news-listener')

def _require_env(name):
    val = os.environ.get(name)
    if not val:
        log.error(f'{name} در محیط ست نشده (به .env نگاه کنید)')
        sys.exit(1)
    return val

API_ID      = int(_require_env('TELEGRAM_API_ID'))
API_HASH    = _require_env('TELEGRAM_API_HASH')
PHONE       = os.environ.get('TELEGRAM_PHONE', '')
NODE_BASE   = 'http://localhost:3001'
NODE_SECRET = _require_env('NODE_INTERNAL_SECRET')
SESSION     = os.path.join(os.path.dirname(__file__), 'data', 'tg_session')
CHANNELS_F  = os.path.join(os.path.dirname(__file__), 'data', 'watched_channels.json')
FINANCE_CHANNELS_F = os.path.join(os.path.dirname(__file__), 'data', 'watched_finance_channels.json')

def load_channels():
    try:
        if os.path.exists(CHANNELS_F):
            with open(CHANNELS_F) as f:
                return json.load(f)
    except: pass
    return []

def load_finance_channels():
    try:
        if os.path.exists(FINANCE_CHANNELS_F):
            with open(FINANCE_CHANNELS_F) as f:
                return json.load(f)
    except: pass
    return []

def post_node(path, payload, _retry=True):
    """
    ⚠️ مهلت قبلاً ۱۵ ثانیه بود. پیلود خبر شامل عکس یا ویدئوی base64 است و
    روی شبکه‌ی کند، POST وسط ارسالِ بدنه قطع می‌شد — سمت نود
    «BadRequestError: request aborted» و اینجا «HTTP Error 500». حالا مهلت
    ۶۰ ثانیه است و اگر باز هم شکست خورد یک بار بدون مدیا فرستاده می‌شود،
    چون متنِ خبر مهم‌تر از عکسش است.
    """
    try:
        data = json.dumps(payload).encode('utf-8')
        req = Request(NODE_BASE + path, data=data,
            headers={'Content-Type':'application/json','X-Internal-Secret':NODE_SECRET},
            method='POST')
        with urlopen(req, timeout=60) as r:
            return r.status == 200
    except Exception as e:
        log.warning(f'post_node {path} error: {e}')
        if _retry and isinstance(payload, dict) and payload.get('media_list'):
            slim = dict(payload)
            slim['media_list'] = []
            slim['media_type'] = None
            log.info(f'post_node {path}: تلاش دوباره بدون مدیا')
            return post_node(path, slim, _retry=False)
        return False

def get_media_type(message):
    if not message.media:
        return None
    if isinstance(message.media, MessageMediaPhoto):
        return 'photo'
    if isinstance(message.media, MessageMediaDocument):
        mime = getattr(message.media.document, 'mime_type', '')
        if mime.startswith('video/'): return 'video'
        if mime == 'image/gif': return 'gif'
    return None

def detect_mime(data):
    """تشخیص mime type واقعی از magic bytes"""
    if not data or len(data) < 4:
        return 'image/jpeg'
    if data[:3] == b'\xff\xd8\xff':
        return 'image/jpeg'
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return 'image/png'
    if data[:6] in (b'GIF87a', b'GIF89a'):
        return 'image/gif'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'image/webp'
    return 'image/jpeg'

async def download_media_b64(client, message):
    """دانلود مدیا و تبدیل به base64 با mime واقعی"""
    try:
        data = await client.download_media(message, file=bytes)
        if data:
            mime = detect_mime(data)
            return {'b64': base64.b64encode(data).decode(), 'mime': mime}
    except Exception as e:
        log.warning(f'download_media error: {e}')
    return None

async def get_channel_photo_b64(client, chat):
    try:
        data = await client.download_profile_photo(chat, file=bytes)
        if data:
            mime = detect_mime(data)
            return f'data:{mime};base64,' + base64.b64encode(data).decode()
    except Exception as e:
        log.warning(f'channel photo error: {e}')
    return None

async def main():
    if not PHONE:
        log.error('TELEGRAM_PHONE not set!')
        sys.exit(1)

    client = TelegramClient(SESSION, API_ID, API_HASH)
    await client.start(phone=PHONE)
    me = await client.get_me()
    log.info(f'Logged in as: {me.username or me.id}')

    # ⚠️ این بخش قبلاً همین‌جا و به‌صورت مسدودکننده اجرا می‌شد: برای هر ۲۴
    # کانال یک get_entity و یک دانلود عکس پروفایل، بدون هیچ مهلتی. اگر یکی
    # از دانلودها گیر می‌کرد — که ۱ سپتامبر ۲۰۲۶ افتاد — اجرا هرگز به
    # run_until_disconnected نمی‌رسید. پروسه زنده می‌ماند، به تلگرام وصل بود
    # و لاگ می‌داد، PM2 هم online می‌دیدش، ولی ۳٫۷ ساعت هیچ خبری ذخیره نشد.
    #
    # عکس پروفایل کانال تزئینی است و نباید جلوی جریان خبر را بگیرد، پس حالا
    # تسک پس‌زمینه است و هر کانال مهلت مستقل دارد.
    channels = load_channels()
    log.info(f'Watching {len(channels)} news channels: {channels}')
    fin_channels = load_finance_channels()
    log.info(f'Watching {len(fin_channels)} finance channels: {fin_channels}')

    async def _send_channel_info(ch, endpoint, label):
        entity = await client.get_entity(ch)
        chat_id = str(entity.id)
        if not chat_id.startswith('-'):
            chat_id = f'-100{chat_id}'
        username = getattr(entity, 'username', None)
        photo_b64 = await get_channel_photo_b64(client, entity)
        post_node(endpoint, {
            'tg_id': chat_id,
            'channel_title': getattr(entity, 'title', ch),
            'channel_username': f'@{username}' if username else ch,
            'photo_b64': photo_b64,
        })
        log.info(f'{label}: {getattr(entity,"title",ch)} (photo: {"yes" if photo_b64 else "no"})')

    async def bootstrap_channel_info():
        jobs = ([(c, '/internal/channel-info', 'channel info sent') for c in channels] +
                [(c, '/internal/finance-channel-info', 'finance channel info sent') for c in fin_channels])
        for ch, endpoint, label in jobs:
            try:
                await asyncio.wait_for(_send_channel_info(ch, endpoint, label), timeout=20)
            except asyncio.TimeoutError:
                log.warning(f'channel info {ch}: مهلت ۲۰ ثانیه تمام شد — رد شد')
            except Exception as e:
                log.warning(f'channel info {ch}: {e}')
            await asyncio.sleep(1)
        log.info('channel info bootstrap finished')

    # بافر برای آلبوم‌های چندعکسه (grouped_id تلگرام)
    album_buffer = {}  # grouped_id -> {msgs: [], timer: None}

    async def flush_album(grouped_id, client_ref, endpoint='/internal/news'):
        entry = album_buffer.pop(grouped_id, None)
        if not entry:
            return
        msgs = sorted(entry['msgs'], key=lambda m: m.id)
        first = msgs[0]
        chat = entry['chat']
        chat_username = getattr(chat, 'username', None)
        chat_id = str(chat.id)
        if not chat_id.startswith('-'):
            chat_id = f'-100{chat_id}'

        text = ''
        for m in msgs:
            if m.text:
                text = m.text
                break

        media_list = []
        for m in msgs:
            mt = get_media_type(m)
            if mt in ('photo', 'gif'):
                dl = await download_media_b64(client_ref, m)
                if dl:
                    media_list.append({'type': mt, 'b64': dl['b64'], 'mime': dl['mime']})

        tg_link = f'https://t.me/{chat_username}/{first.id}' if chat_username else None
        payload = {
            'tg_id': chat_id,
            'channel_title': getattr(chat, 'title', str(chat_id)),
            'channel_username': f'@{chat_username}' if chat_username else None,
            'message_id': first.id,
            'text': text[:4000],
            'media_type': 'gallery' if len(media_list) > 1 else (media_list[0]['type'] if media_list else None),
            'media_list': media_list,
            'tg_link': tg_link,
            'published_at': first.date.isoformat(),
        }
        ok = post_node(endpoint, payload)
        tag = 'fin' if 'finance' in endpoint else 'news'
        log.info(f'[{tag}:{getattr(chat,"title",chat_id)}] album#{first.id} images={len(media_list)} → {"✓" if ok else "✗"}')

    @client.on(events.NewMessage())
    async def handler(event):
        try:
            channels = load_channels()
            fin_channels = load_finance_channels()

            chat = await event.get_chat()
            chat_username = getattr(chat, 'username', None)
            chat_id = str(chat.id)
            if not chat_id.startswith('-'):
                chat_id = f'-100{chat_id}'

            # چک کن توی لیست خبری هست
            is_news = False
            for ch in channels:
                if ch.startswith('@') and chat_username and ch.lstrip('@').lower() == chat_username.lower():
                    is_news = True; break
                elif ch == chat_id:
                    is_news = True; break

            # چک کن توی لیست مالی هست
            is_finance = False
            for ch in fin_channels:
                if ch.startswith('@') and chat_username and ch.lstrip('@').lower() == chat_username.lower():
                    is_finance = True; break
                elif ch == chat_id:
                    is_finance = True; break

            if not is_news and not is_finance:
                return

            # تعیین endpoint بر اساس نوع کانال
            endpoint = '/internal/finance-message' if is_finance else '/internal/news'
            tag = 'fin' if is_finance else 'news'

            msg = event.message

            # آلبوم چندعکسه — پیام‌ها با grouped_id مشترک هستن
            if msg.grouped_id:
                gid = msg.grouped_id
                if gid not in album_buffer:
                    album_buffer[gid] = {'msgs': [], 'chat': chat, 'timer': None, 'endpoint': endpoint, 'tag': tag}
                album_buffer[gid]['msgs'].append(msg)
                ep = endpoint
                if album_buffer[gid]['timer']:
                    album_buffer[gid]['timer'].cancel()
                loop = asyncio.get_event_loop()
                album_buffer[gid]['timer'] = loop.call_later(
                    1.5, lambda: asyncio.create_task(flush_album(gid, client, ep))
                )
                return

            text = msg.text or ''
            media_type = get_media_type(msg)

            media_dl = None
            if media_type in ('photo', 'gif'):
                media_dl = await download_media_b64(client, msg)

            tg_link = f'https://t.me/{chat_username}/{msg.id}' if chat_username else None

            payload = {
                'tg_id': chat_id,
                'channel_title': getattr(chat, 'title', str(chat_id)),
                'channel_username': f'@{chat_username}' if chat_username else None,
                'message_id': msg.id,
                'text': text[:4000],
                'media_type': media_type,
                'media_list': ([{'type': media_type, 'b64': media_dl['b64'], 'mime': media_dl['mime']}] if media_dl else []),
                'tg_link': tg_link,
                'published_at': msg.date.isoformat(),
            }

            ok = post_node(endpoint, payload)
            log.info(f'[{tag}:{getattr(chat,"title",chat_id)}] msg#{msg.id} media={media_type} → {"✓" if ok else "✗"}')

        except Exception as e:
            log.warning(f'handler error: {e}')

    # اول اعلام آمادگی، بعد کارهای تزئینی. ترتیب اینجا عمدی است: اگر
    # بوت‌استرپ گیر کند، جریان خبر همچنان برقرار است.
    log.info('Listening for new messages...')
    asyncio.create_task(bootstrap_channel_info())
    await client.run_until_disconnected()

if __name__ == '__main__':
    asyncio.run(main())
