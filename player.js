/* 🎬 Double Watch Player — ساختهٔ خود اکستنشن (chrome-extension://…/player.html)
 * یک تب کاملاً مستقل که:
 *   ۱) ویدیو را با src مستقیم پخش می‌کند (بدون iframe، بدون CORS)
 *   ۲) با کد اتاق ۶ رقمی به هم‌تابی‌اش وصل می‌شود
 *   ۳) از سه لایهٔ ارتباطی استفاده می‌کند:
 *      - BroadcastChannel  (تب‌های هم‌مرورگر، آنی)
 *      - WebSocket سرور Cloudflare Worker (بین دستگاه‌ها)
 *      - chrome.storage.local (پشتیبان)
 * همهٔ کنترل‌ها (play/pause/seek/volume) دوطرفه همگام می‌شوند. */
(function () {
  'use strict';

  // ---------- ابزارها ----------
  const $ = (id) => document.getElementById(id);
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  function genCode() {
    return Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  }
  function validCode(c) { return /^[A-Z0-9]{4,8}$/.test(String(c || '').toUpperCase()); }
  function normServer(raw) {
    let v = String(raw || '').trim().replace(/\/+$/, '');
    if (!v) return null;
    v = v.replace(/^wss?:\/\//i, (m) => (m[1].toLowerCase() === 's' ? 'https://' : 'http://'));
    if (/^https?:\/\//i.test(v)) return v;
    if (/\./.test(v)) return v;
    return 'https://' + v + '.iloveforduck.workers.dev';
  }
  function wsUrl(httpUrl) {
    try {
      const u = new URL(httpUrl);
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      return u.toString().replace(/\/$/, '') + '/sync'; // سرور Worker: مسیر /sync
    } catch { return null; }
  }

  const video = $('video');
  const ui = {
    screen: $('screen'), connect: $('connect'), roomUI: $('roomUI'),
    codeInput: $('codeInput'), passInput: $('passInput'), serverInput: $('serverInput'),
    srcInput: $('srcInput'), status: $('status'), codeShow: $('codeShow'),
    roleShow: $('roleShow'), peerInfo: $('peerInfo'), copyBtn: $('copyBtn'),
    leaveBtn: $('leaveBtn'), hostBtn: $('hostBtn'), joinBtn: $('joinBtn'),
    shareLink: $('shareLink'), timeNow: $('timeNow'), timeDur: $('timeDur'),
    bar: $('bar'), barFill: $('barFill'), volSlider: $('volSlider'),
    muteBtn: $('muteBtn'), fullscreenBtn: $('fullscreenBtn'),
  };

  function setStatus(msg, color) {
    ui.status.textContent = msg;
    ui.status.style.color = color || '#8be9fd';
  }

  // ---------- حالت سراسری ----------
  let roomCode = '';
  let isHost = false;
  let peerPresent = false;
  let applyingRemote = false;   // نگهبان حلقهٔ بی‌نهایت
  let bc = null;                // BroadcastChannel
  let ws = null;                // WebSocket
  let wsTimer = null;
  let lastDriftCheck = 0;
  let connectedAt = 0;
  let remoteState = null;       // آخرین وضعیت دریافتی از هم‌تابی (برای drift)

  // ---------- ذخیره/بازیابی تنظیمات ----------
  function loadServerPrefs() {
    try { chrome.storage.local.get(['dw_server_url'], (r) => {
      if (r && r.dw_server_url && !ui.serverInput.value) ui.serverInput.value = r.dw_server_url;
    }); } catch {}
    try { if (!ui.serverInput.value) ui.serverInput.value = localStorage.getItem('dw_server_url') || ''; } catch {}
  }
  loadServerPrefs();

  function saveServer(u) {
    try { chrome.storage.local.set({ dw_server_url: u }); } catch {}
    try { localStorage.setItem('dw_server_url', u); } catch {}
  }

  // ---------- ارسال رویداد همگام‌سازی (هر سه لایه) ----------
  function sendState(type, data) {
    const msg = Object.assign({ type, code: roomCode, t: Date.now(), from: location.href + '#' + (isHost ? 'H' : 'G') }, data || {});
    try { if (bc) bc.postMessage(msg); } catch {}
    try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(Object.assign({ room: roomCode }, msg))); } catch {}
    try { chrome.storage.local.set({ ['dw_last_' + roomCode]: msg }); } catch {}
  }

  function currentSyncPayload() {
    return {
      time: video.currentTime || 0,
      playing: !video.paused && !video.ended,
      dur: video.duration || 0,
      vol: video.volume,
      muted: video.muted,
      src: video.currentSrc || video.src || '',
    };
  }

  // ---------- دریافت رویداد (از BC / WS / storage) ----------
  function handleRemote(m) {
    if (!m || !m.type) return;
    if (m.code && m.code !== roomCode) return;

    switch (m.type) {
      case 'hello':
        peerPresent = true;
        updatePeerUI();
        // سلام متقابل + وضعیت فعلی برای همگام اولیه
        setTimeout(() => {
          sendState('state', currentSyncPayload());
          sendState('hi-back', {});
        }, 120);
        break;
      case 'hi-back':
        peerPresent = true;
        updatePeerUI();
        break;
      case 'bye':
        peerPresent = false;
        updatePeerUI();
        setStatus('👋 هم‌تابی از اتاق خارج شد.', '#ffb86c');
        break;
      case 'state':
      case 'play':
      case 'pause':
      case 'seek':
      case 'volume':
        applyRemote(m);
        break;
    }
  }

  function applyRemote(m) {
    applyingRemote = true;
    try {
      if (typeof m.time === 'number' && isFinite(m.time)) {
        remoteState = { time: m.time, playing: !!m.playing, at: Date.now() };
      }
      if (typeof m.vol === 'number') { video.volume = Math.min(1, Math.max(0, m.vol)); }
      if (typeof m.muted === 'boolean') video.muted = m.muted;
      if (typeof m.time === 'number' && isFinite(m.time)) {
        // فقط اگر اختلاف زیاد باشد seek کن (جلوگیری از پرش‌های ریز)
        if (Math.abs(video.currentTime - m.time) > (m.type === 'seek' ? 0.4 : 1.2)) {
          try { video.currentTime = m.time; } catch {}
        }
      }
      if (m.playing === true && video.paused) { video.play().catch(() => {}); }
      if (m.playing === false && !video.paused) { video.pause(); }
      updatePeerUI();
      if (m.type === 'state' || m.type === 'seek') setStatus('🔄 همگام با هم‌تابی', '#50fa7b');
    } finally {
      setTimeout(() => { applyingRemote = false; }, 250);
    }
  }

  // ---------- اتصال‌ها ----------
  function openBC(code) {
    closeBC();
    try {
      bc = new BroadcastChannel('dw-player-' + code);
      bc.onmessage = (e) => handleRemote(e.data);
    } catch { bc = null; }
  }
  function closeBC() { try { if (bc) bc.close(); } catch {} bc = null; }

  function openWS(code) {
    closeWS();
    const srv = normServer(ui.serverInput.value);
    const wurl = srv ? wsUrl(srv) : null;
    if (!wurl) return;
    try {
      ws = new WebSocket(wurl);
    } catch { ws = null; return; }
    let registered = false;
    ws.onopen = () => {
      registered = false;
      // حالت register: عضویت مستقیم با کد اتاق (پشتیبانی در dw-sync-worker.js)
      try { ws.send(JSON.stringify({ type: 'register', room: code, role: isHost ? 'host' : 'guest' })); } catch {}
      // پشتیبان: اگر سرور نسخهٔ قدیمی باشد و register را نشناسد، بعد از
      // ۱.۵ ثانیه با پروتکل create/join تلاش می‌کنیم
      setTimeout(() => {
        if (registered || !ws || ws.readyState !== 1) return;
        try {
          if (isHost) ws.send(JSON.stringify({ type: 'create', code, pwd: '' }));
          else ws.send(JSON.stringify({ type: 'join', code, pwd: '' }));
        } catch {}
      }, 1500);
      setStatus('🌐 در حال اتصال به سرور همگام‌سازی...', '#8be9fd');
    };
    ws.onmessage = (e) => {
      let m = null;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m && m.room && m.room !== code) return;
      if (m && m.type === 'registered') { registered = true; setStatus('🌐 سرور همگام‌سازی متصل است.', '#50fa7b'); }
      if (m && (m.type === 'created' || m.type === 'joined')) { registered = true; setStatus('🌐 سرور همگام‌سازی متصل است.', '#50fa7b'); }
      if (m && (m.type === 'paired' || m.type === 'peer_joined')) { peerPresent = true; updatePeerUI(); sendState('state', currentSyncPayload()); }
      if (m && (m.type === 'peer_left')) { peerPresent = false; updatePeerUI(); }
      // پروتکل قدیمی: پیام relay → داخلش data داریم
      if (m && m.type === 'relay' && m.data) { handleRemote(Object.assign({}, m.data, { code })); return; }
      handleRemote(m);
    };
    ws.onclose = () => { ws = null; scheduleWSRetry(code); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  function scheduleWSRetry(code) {
    clearTimeout(wsTimer);
    wsTimer = setTimeout(() => { if (roomCode === code) openWS(code); }, 4000);
  }
  function closeWS() {
    clearTimeout(wsTimer);
    try { if (ws) { ws.onclose = null; ws.close(); } } catch {}
    ws = null;
  }

  // پشتیبان storage: هم‌تابی در همان مرورگر حتی بدون BC
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || !roomCode) return;
      const k = 'dw_last_' + roomCode;
      if (ch[k] && ch[k].newValue) {
        const m = ch[k].newValue;
        if (m && m.from !== location.href + '#' + (isHost ? 'H' : 'G')) handleRemote(m);
      }
    });
  } catch {}

  // ---------- ورود/ساخت اتاق ----------
  function enterRoom(code, host, src) {
    roomCode = String(code).toUpperCase();
    isHost = !!host;
    if (src) {
      video.src = src;
      try { chrome.storage.local.set({ ['dw_src_' + roomCode]: src }); } catch {}
      try { localStorage.setItem('dw_src_' + roomCode, src); } catch {}
    } else {
      let saved = null;
      try { saved = localStorage.getItem('dw_src_' + roomCode); } catch {}
      if (saved) video.src = saved;
    }
    ui.connect.style.display = 'none';
    ui.roomUI.style.display = 'block';
    $('controls').style.display = 'flex';
    ui.codeShow.textContent = roomCode;
    ui.roleShow.textContent = isHost ? 'میزبان' : 'مهمان';
    updatePeerUI();
    openBC(roomCode);
    openWS(roomCode);
    sendState('hello', currentSyncPayload());
    setStatus(isHost ? '🏠 اتاق ساخته شد — منتظر هم‌تابی...' : '⏳ در حال ورود به اتاق...', '#ffb86c');
    connectedAt = Date.now();

    // آدرس اشتراکی: لینک همین صفحهٔ اکستنشن با کد اتاق
    const share = location.origin + location.pathname + '#join=' + roomCode;
    ui.shareLink.value = share;

    // broadcast state دوره‌ای برای همگام ماندن + اصلاح drift
    setInterval(() => {
      if (!roomCode) return;
      if (!video.paused && !applyingRemote) sendState('state', currentSyncPayload());
      // تشخیص drift: اگر زمان محلی با پیش‌بینی وضعیت هم‌تابی بیش از ۳ ثانیه
      // اختلاف داشت، خود را با آن قفل کن (حتی اگر پیام تازه‌ای نرسیده باشد)
      if (peerPresent && remoteState && !applyingRemote && Date.now() - remoteState.at < 30000) {
        const predicted = remoteState.playing ? remoteState.time + (Date.now() - remoteState.at) / 1000 : remoteState.time;
        if (Math.abs((video.currentTime || 0) - predicted) > 3) {
          applyRemote({ type: 'state', time: predicted, playing: remoteState.playing });
        }
      }
    }, 2000);

    try { chrome.storage.local.set({ ['dw_pass_' + roomCode]: ui.passInput.value || '' }); } catch {}
  }

  function leaveRoom() {
    sendState('bye', {});
    closeBC(); closeWS();
    roomCode = ''; peerPresent = false;
    try { video.pause(); } catch {}
    ui.roomUI.style.display = 'none';
    ui.connect.style.display = 'block';
    setStatus('از اتاق خارج شدید.', '#8be9fd');
  }

  function updatePeerUI() {
    ui.peerInfo.textContent = peerPresent ? '🟢 هم‌تابی متصل است' : '⚪ منتظر هم‌تابی...';
    ui.peerInfo.style.color = peerPresent ? '#50fa7b' : '#ffb86c';
  }

  // ---------- کنترل‌های محلی ویدیو ----------
  video.addEventListener('play', () => { if (!applyingRemote) sendState('play', { playing: true, time: video.currentTime }); });
  video.addEventListener('pause', () => { if (!applyingRemote) sendState('pause', { playing: false, time: video.currentTime }); });
  video.addEventListener('seeked', () => { if (!applyingRemote) sendState('seek', { time: video.currentTime, playing: !video.paused }); });
  video.addEventListener('volumechange', () => { if (!applyingRemote) sendState('volume', { vol: video.volume, muted: video.muted }); });
  video.addEventListener('loadedmetadata', () => { ui.timeDur.textContent = fmt(video.duration); });
  video.addEventListener('timeupdate', () => {
    ui.timeNow.textContent = fmt(video.currentTime);
    if (video.duration) ui.barFill.style.width = (video.currentTime / video.duration * 100) + '%';
  });

  function fmt(s) {
    if (!isFinite(s)) return '--:--';
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }

  // نوار پیشرفت قابل کلیک
  ui.bar.addEventListener('click', (e) => {
    if (!video.duration) return;
    const r = ui.bar.getBoundingClientRect();
    const p = (e.clientX - r.left) / r.width;
    video.currentTime = p * video.duration;
  });
  ui.volSlider.addEventListener('input', () => { video.volume = parseFloat(ui.volSlider.value); video.muted = false; });
  ui.muteBtn.addEventListener('click', () => { video.muted = !video.muted; ui.muteBtn.textContent = video.muted ? '🔇' : '🔊'; });
  ui.fullscreenBtn.addEventListener('click', () => {
    const wrap = $('stage');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (wrap.requestFullscreen) wrap.requestFullscreen();
  });

  // ---------- فرم اتصال ----------
  ui.hostBtn.addEventListener('click', () => {
    const src = (ui.srcInput.value || '').trim();
    if (!/^https?:\/\//i.test(src)) { setStatus('❌ برای میزبانی، آدرس مستقیم فایل ویدیو (mp4/webm) را وارد کنید.', '#ff5555'); return; }
    const code = validCode(ui.codeInput.value) ? ui.codeInput.value.trim().toUpperCase() : genCode();
    ui.codeInput.value = code;
    const srv = normServer(ui.serverInput.value);
    if (srv) saveServer(srv);
    enterRoom(code, true, src);
  });
  ui.joinBtn.addEventListener('click', () => {
    const code = (ui.codeInput.value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!validCode(code)) { setStatus('❌ کد اتاق معتبر نیست (۴ تا ۸ حرف انگلیسی/عدد).', '#ff5555'); return; }
    const srv = normServer(ui.serverInput.value);
    if (srv) saveServer(srv);
    enterRoom(code, false, (ui.srcInput.value || '').trim() || null);
  });
  ui.copyBtn.addEventListener('click', () => {
    ui.shareLink.select();
    try { document.execCommand('copy'); navigator.clipboard && navigator.clipboard.writeText(ui.shareLink.value); } catch {}
    setStatus('📋 لینک دعوت کپی شد — برای هم‌تابی بفرستید.', '#50fa7b');
  });
  ui.leaveBtn.addEventListener('click', leaveRoom);

  // ---------- هاش خودکار (#join=CODE&src=... از تب سایت/لینک دعوت) ----------
  function checkHash() {
    if (roomCode) return; // قبلاً وارد اتاقی شده‌ایم — تکرار نکن
    const h = location.hash || '';
    const m = /(?:^#|&)join=([A-Z0-9]{4,8})/i.exec(h);
    const sm = /(?:^#|&)src=([^&]+)/.exec(h);
    if (sm) { try { ui.srcInput.value = decodeURIComponent(sm[1]); } catch {} }
    if (m) {
      ui.codeInput.value = m[1].toUpperCase();
      loadServerPrefs(); // سرور ذخیره‌شده ممکن است تازه تنظیم شده باشد
      ui.joinBtn.click();
    }
  }
  window.addEventListener('hashchange', checkHash);

  // ---------- پیام از content script سایت (DW_PUSH_SRC) ----------
  try {
    chrome.runtime.onMessage.addListener((req) => {
      if (req && req.action === 'DW_SET_SRC' && req.src && /^https?:\/\//i.test(req.src)) {
        ui.srcInput.value = req.src;
        try { localStorage.setItem('dw_src_' + (roomCode || 'site'), req.src); } catch {}
        if (roomCode) { video.src = req.src; sendState('state', currentSyncPayload()); setStatus('📥 ویدیوی جدید از تب سایت دریافت شد.', '#50fa7b'); }
      }
    });
  } catch {}

  // نمایش نوار کنترل وقتی ویدیو بارگذاری می‌شود
  video.addEventListener('loadedmetadata', () => { $('controls').style.display = 'flex'; });

  setStatus('آماده — کد اتاق بسازید یا کد هم‌تابی را وارد کنید.');
  checkHash();
})();
