/* سیگنال هوش — اسکریپت مشترک (بدون وابستگی) */
(function () {
  'use strict';

  var faDigits = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
  function toFa(s) { return String(s).replace(/[0-9]/g, function (d) { return faDigits[+d]; }); }

  /* ── تم روشن / تیره ── */
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem('sh_theme'); } catch (e) {}

  if (saved === 'light' || saved === 'dark') {
    root.setAttribute('data-theme', saved);
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    root.setAttribute('data-theme', 'light');
  }

  var themeBtn = document.querySelector('.theme-btn');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('sh_theme', next); } catch (e) {}
      themeBtn.setAttribute('aria-label', next === 'light' ? 'تم تیره' : 'تم روشن');
    });
  }

  /* ── ساعت (ارقام فارسی) ── */
  var clock = document.getElementById('clock');
  if (clock) {
    var tick = function () {
      var d = new Date();
      clock.textContent = toFa(
        String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
      );
    };
    tick();
    setInterval(tick, 30000);
  }

  /* ── تب فعال در دید ── */
  var active = document.querySelector('.tab[aria-current="page"]');
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'center' });

  /* ── فیلترها (نمایشی) ── */
  document.querySelectorAll('[data-filters]').forEach(function (group) {
    group.addEventListener('click', function (e) {
      var b = e.target.closest('.filt');
      if (!b || !group.contains(b)) return;
      e.preventDefault();
      group.querySelectorAll('.filt').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
    });
  });

  /* ── بخش‌های بازشونده ── */
  document.querySelectorAll('.collapse-head').forEach(function (h) {
    h.addEventListener('click', function () { h.parentElement.classList.toggle('open'); });
  });

  /* ── ردیف‌های جدول بازشونده (دسته‌های شغلی) ── */
  document.querySelectorAll('.row-toggle').forEach(function (tr) {
    tr.addEventListener('click', function () {
      var detail = tr.nextElementSibling;
      if (!detail || !detail.classList.contains('row-detail')) return;
      var open = tr.classList.toggle('row-open');
      detail.style.display = open ? '' : 'none';
      tr.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });

  /* ── پنل مدیریت: جابه‌جایی بخش‌ها ── */
  var adminNav = document.querySelector('.admin-nav');
  if (adminNav) {
    adminNav.addEventListener('click', function (e) {
      var a = e.target.closest('a[data-sec]');
      if (!a) return;
      e.preventDefault();
      adminNav.querySelectorAll('a').forEach(function (x) { x.classList.remove('on'); });
      a.classList.add('on');
      document.querySelectorAll('.admin-sec').forEach(function (s) { s.classList.remove('on'); });
      var target = document.getElementById(a.dataset.sec);
      if (target) target.classList.add('on');
    });
  }

  /* ── پنل مدیریت: ویرایش کانال ── */
  // در نسخه‌ی نهایی: GET /api/news/channels/:id → پر کردن فرم → PATCH هنگام ذخیره
  var chTitle = document.getElementById('chFormTitle');
  if (chTitle) {
    var setVal = function (id, v) { var el = document.getElementById(id); if (el) el.value = v; };
    var setChk = function (id, v) { var el = document.getElementById(id); if (el) el.checked = v; };

    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-edit-ch]');
      if (b) {
        var name = b.dataset.editCh;
        var row = b.closest('.drow');
        var cat = row ? row.querySelector('.tag') : null;
        chTitle.textContent = 'ویرایش کانال — ' + name;
        setVal('chName', name);
        setVal('chUser', '@' + name.replace(/\s+/g, '').toLowerCase());
        setVal('chSection', cat && cat.textContent.trim() === 'مالی' ? 'ترند بازارهای مالی' : 'ترند اخبار ایران');
        setChk('chTrans', !!(row && row.querySelector('.badge-acc')));
        var del = document.getElementById('chDelete');
        if (del) del.style.display = '';
        chTitle.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }

      if (e.target.id === 'chFormReset') {
        chTitle.textContent = 'افزودن کانال جدید';
        ['chName', 'chUser'].forEach(function (id) { setVal(id, ''); });
        setChk('chTrans', true); setChk('chMedia', true); setChk('chActive', true);
        var d = document.getElementById('chDelete');
        if (d) d.style.display = 'none';
      }
    });
  }

  /* ── فرم تماس ──
     نسخه‌ی قبلی submit را متوقف می‌کرد و فقط پیام موفقیت نشان می‌داد؛ هیچ
     چیزی به سرور نمی‌رفت. مسیر POST /contact از قبل وجود دارد و پیام را در
     دیتابیس می‌نویسد، پس فرم باید طبیعی ارسال شود. اینجا فقط جلوی ارسال
     دوباره با کلیک‌های پیاپی گرفته می‌شود. */
  var form = document.getElementById('contactForm');
  if (form) {
    form.addEventListener('submit', function () {
      var btn = form.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = 'در حال ارسال…'; }
    });
  }

  /* ── پولینگ خبر تازه ──
     هر ۳ ثانیه می‌پرسد «خبری تازه‌تر از این شناسه هست؟» و مستقیم به
     بالای فهرست اضافه می‌کند.

     نکته: افزودن به بالای فهرست، محتوای زیرش را پایین می‌راند و اگر
     کاربر وسط خواندن باشد صفحه می‌پرد. برای همین ارتفاع اضافه‌شده
     اندازه‌گیری و به scroll اضافه می‌شود تا از دید کاربر هیچ‌چیز تکان
     نخورد — خبر جدید بی‌صدا بالای فهرست می‌نشیند. */
  var feedEl = document.getElementById('newsFeed');

  if (feedEl) {
    var latest = parseInt(feedEl.dataset.latest, 10) || 0;
    var chParam = feedEl.dataset.channel ? '&channel=' + feedEl.dataset.channel : '';
    var catParam = feedEl.dataset.cat ? '&cat=' + encodeURIComponent(feedEl.dataset.cat) : '';
    var polling = false;

    var poll = function () {
      if (polling || document.hidden) return;
      polling = true;
      fetch('/news/live/' + latest + '?_=' + Date.now() + chParam + catParam)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          polling = false;
          if (!d || !d.count) return;
          latest = d.maxId;

          var tmp = document.createElement('div');
          tmp.innerHTML = d.html;
          var nodes = Array.prototype.slice.call(tmp.children);
          if (!nodes.length) return;

          var beforeH = feedEl.scrollHeight;
          var atTop = window.scrollY < 120;

          for (var i = nodes.length - 1; i >= 0; i--) {
            feedEl.insertBefore(nodes[i], feedEl.firstChild);
          }

          // اگر کاربر پایین‌تر است، اسکرول را جبران کن تا صفحه نپرد
          if (!atTop) {
            var added = feedEl.scrollHeight - beforeH;
            if (added > 0) window.scrollBy(0, added);
          }
        })
        .catch(function () { polling = false; });
    };

    setInterval(poll, 3000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  }

  /* ── بارگذاری تدریجی فید اخبار ──
     نسخه‌ی قبلی همان ردیف‌های موجود را cloneNode می‌کرد و پنج بار به فهرست
     می‌چسباند — یعنی کاربر ۱۰۰ ردیف می‌دید که ۸۰تایش تکراری بود. حالا
     واقعاً از سرور خبر بعدی گرفته می‌شود. */
  var sentinel = document.getElementById('newsSentinel');

  if (feedEl && sentinel && 'IntersectionObserver' in window) {
    var offset = feedEl.querySelectorAll('.nrow').length;
    var loading = false, done = false;
    var txtEl = sentinel.querySelector('.sentinel-txt');

    var finish = function (msg) {
      done = true;
      obs.disconnect();
      sentinel.classList.add('done');
      if (txtEl) txtEl.textContent = msg;
    };

    var loadMore = function () {
      if (loading || done) return;
      loading = true;

      var qs = '?offset=' + offset;
      if (feedEl.dataset.channel) qs += '&channel=' + feedEl.dataset.channel;
      if (feedEl.dataset.cat) qs += '&cat=' + encodeURIComponent(feedEl.dataset.cat);

      fetch('/news/more' + qs)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          loading = false;
          if (!d) return finish('بارگذاری ادامه‌ی فهرست ممکن نشد');
          if (d.count) {
            var tmp = document.createElement('div');
            tmp.innerHTML = d.html;
            while (tmp.firstChild) feedEl.appendChild(tmp.firstChild);
            offset += d.count;
          }
          if (d.done) finish('به انتهای فهرست رسیدید');
        })
        .catch(function () { loading = false; finish('بارگذاری ادامه‌ی فهرست ممکن نشد'); });
    };

    var obs = new IntersectionObserver(function (en) {
      if (en[0].isIntersecting) loadMore();
    }, { rootMargin: '400px' });

    obs.observe(sentinel);
  }

  /* ── ویدیوی خبر ──
     ویدیوهای تلگرام روی سرور دانلود نشده‌اند، پس خودِ پست تلگرام امبد
     می‌شود. iframe فقط با کلیک ساخته می‌شود تا صفحه سنگین نشود و برای
     کاربرانی که به t.me دسترسی ندارند چیزی معلق نماند. */
  document.querySelectorAll('[data-tg-post]').forEach(function (box) {
    var ph = box.querySelector('.tg-embed-ph');
    if (!ph) return;
    ph.addEventListener('click', function () {
      var dark = document.documentElement.getAttribute('data-theme') !== 'light';
      var f = document.createElement('iframe');
      f.src = 'https://t.me/' + box.dataset.tgPost + '?embed=1&userpic=false' + (dark ? '&dark=1' : '');
      f.setAttribute('frameborder', '0');
      f.setAttribute('scrolling', 'no');
      f.setAttribute('allowfullscreen', '');
      f.style.width = '100%';
      f.style.height = '520px';
      box.innerHTML = '';
      box.appendChild(f);
      box.classList.add('on');
    });
  });

  /* تلگرام ارتفاع واقعی پست را با postMessage می‌فرستد */
  window.addEventListener('message', function (e) {
    if (!/(^|\.)t\.me$/.test((function () {
      try { return new URL(e.origin).hostname; } catch (err) { return ''; }
    })())) return;
    var data;
    try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (err) { return; }
    if (!data || data.event !== 'resize' || !data.height) return;
    document.querySelectorAll('.tg-embed iframe').forEach(function (f) {
      if (f.contentWindow === e.source) f.style.height = data.height + 'px';
    });
  });
})();
