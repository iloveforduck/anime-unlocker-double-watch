// ===== حالت دابل‌واچ (تماشای دونفره همزمان) =====
// این فایل در ISOLATED WORLD اجرا می‌شود و با main.js (MAIN world) از طریق
// CustomEvent روی document ارتباط برقرار می‌کند.
(function doubleWatch() {
    if (window.__doubleWatchLoaded) return;
    window.__doubleWatchLoaded = true;

    // ⚙️ آدرس سرور همگام‌سازی (Cloudflare Worker — رایگان)
    // برای راه‌اندازی: cloudflare.comWorkers/create → کد worker.js را کپی/Deploy کن
    // و آدرس *.workers.dev را اینجا بگذار، سپس اکستنشن را دوباره بارگذاری کن.
    const SYNC_SERVER_URL = ''; // مثال: 'https://anime-sync.yourname.workers.dev'

    let ws = null;
    let connected = false;
    let isHost = false;          // میزبان = کسی که لینک/کد را ساخته (کنترل پخش/مکث دارد)
    let roomCode = '';
    let joinAttempts = 0;
    let heartbeatTimer = null;
    let reconnectTimer = null;
    let pendingJoin = null;      // {code, pwd} تا وقتی اتصال باز شود
    let lastKnownTs = -1;        // آخرین زمان‌بندی ویدیو (برای صفحه Join)
    let dwPaired = false;        // آیا دو نفر به هم وصل شده‌اند؟
    let suppressBroadcast = false;
    let panelEl = null;
    let statusEl = null;

    // ---------- ورود خودکار روی صفحهٔ ویدیو (از هر دامنه) ----------
    // اگر لینک دابل‌واچ باز شده و کد اتاق در sessionStorage همین دامنه ذخیره است،
    // به‌محض اجرای content script تلاش کن — حتی قبل از ساخته شدن پنل اکستنشن.
    // main.js بعداً با DW_TOGGLE دوباره صدا می‌زند؛ flag از تکرار اتصال جلوگیری می‌کند.
    let autoJoinTried = false;
    function tryAutoJoinOnVideoPage() {
        if (autoJoinTried || connected) return;
        autoJoinTried = true;
        const started = tryAutoJoin();
        if (started) revealExtPanel();
    }
    const dwInitTimer = setInterval(() => {
        if ((connected && dwPaired) || autoJoinTried) { clearInterval(dwInitTimer); return; }
        tryAutoJoinOnVideoPage();
    }, 1500);

    // ---------- پیام به main.js (MAIN world) ----------
    // CustomEvent ها بین ISOLATED/MAIN world مشترک نیستند؛ هر پیام هم روی
    // document و هم روی window dispatch می‌شود تا حتماً به main.js برسد.
    // نام رویداد DW_EXT_MSG است چون listener های main.js روی همین نام هستند.
    // (main.js با فلگ __dwShared از پردازش تکراری جلوگیری می‌کند.)
    function toMain(detail) {
        const ev = new CustomEvent('DW_EXT_MSG', { detail });
        ev.__dwShared = true;
        document.dispatchEvent(ev);
        try { window.dispatchEvent(ev); } catch {}
    }

    // ---------- دریافت پیام از main.js ----------
    function dwExtHandler(e) {
        if (e.__dwShared && e.currentTarget === window) return; // نسخهٔ document پردازش می‌شود
        const m = e.detail || {};
        switch (m.action) {
            case 'DW_TOGGLE':
                buildUI();
                if (!connected && !tryAutoJoin()) openCreateDialog();
                break;
            case 'DW_NEW_TAB': // میزبان: صفحهٔ ویدیو در تب جدید باز شود (دابل‌واچ)
                try { sessionStorage.setItem('dw_host_video_href', location.href); } catch {}
                openInNewTab(location.href);
                setStatus('🗂️ صفحهٔ ویدیو در تب جدید باز شد...', '#8be9fd');
                break;
            case 'DW_JOIN_INFO': // فقط مهمان: اطلاعات پلیر محلی برای صفحه Join
                if (typeof m.currentTime === 'number') lastKnownTs = m.currentTime;
                break;
            case 'DW_DISCONNECT':
                disconnect();
                break;
        }
    }
    document.addEventListener('DW_EXT_MSG', dwExtHandler);
    window.addEventListener('DW_EXT_MSG', dwExtHandler);

    // تشخیص صفحهٔ فرود Worker حتی وقتی آدرس سرور در اکستنشن تنظیم نشده است.
    // هر ساب‌دامنه‌ای که با .workers.dev تمام می‌شود، صفحهٔ Join ماست.
    function isWorkerLandingPage() {
        if (/^https?:$/.test(location.protocol) && /\.workers\.dev$/i.test(location.hostname)) return true;
        // اگر SYNC_SERVER_URL تنظیم شده باشد، همان دامنه هم مجاز است
        const base = (SYNC_SERVER_URL || '').trim();
        if (base) { try { if (location.origin === new URL(base).origin) return true; } catch {} }
        return false;
    }

    // ---------- صفحهٔ فرود Worker: ورود خودکار با کد از لینک ----------
    // کد اتاق می‌تواند در ?c=CODE (لینک جدید)، ?join=CODE یا #CODE (لینک قدیمی) باشد.
    function getLandingCode() {
        try {
            const usp = new URLSearchParams(location.search);
            const c = (usp.get('c') || usp.get('join') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
            if (/^[A-Z0-9]{4,8}$/.test(c)) return c;
        } catch {}
        const m = location.hash.match(/^#([A-Za-z0-9]{4,8})$/);
        if (m) return m[1].toUpperCase();
        return null;
    }

    function autoJoinFromWorkerLanding() {
        if (!isWorkerLandingPage()) return false;
        const code = getLandingCode();
        if (!code) return false;
        // رمز از پارامتر ?p= یا sessionStorage (اگر قبلاً پرسیده شده)
        let pass = '';
        try {
            const usp = new URLSearchParams(location.search);
            pass = usp.get('p') || sessionStorage.getItem('dw_pass_' + code) || '';
            if (!pass) pass = usp.get('pwd') || '';
        } catch { pass = ''; }
        // کد را برای دامنهٔ ویدیو ذخیره کن تا بعد از ریدایرکت، ورود خودکار انجام شود
        try { sessionStorage.setItem('dw_autojoin', JSON.stringify({ code, pass, ts: Date.now() })); } catch {}
        buildUI();
        connect(code, false, pass);
        updateConnButtons('connected');
        setStatus('⏳ ورود خودکار به اتاق ' + code + '...', '#ffb86c');
        // اگر لینک، آدرس ویدیو (?v=) را داشت، بلافاصله (حداکثر ۶۰۰ms) منتقل شو.
        // چون کد در sessionStorage ذخیره شده، روی صفحهٔ ویدیو خودکار وارد اتاق می‌شود.
        let vidTarget = null;
        try {
            const vv = new URLSearchParams(location.search).get('v');
            if (vv && /^https?:\/\//i.test(vv)) vidTarget = vv;
        } catch {}
        if (vidTarget) {
            setTimeout(() => { location.replace(vidTarget); }, 600);
            return true;
        }
        // پنل را وسط صفحه نمایش بده تا کاربر بداند چه خبر است
        setTimeout(() => {
            const sec = document.getElementById('adv-dw-section');
            if (sec && sec.parentElement) {
                sec.style.cssText += ';max-width:420px;margin:40px auto;border:1px solid rgba(189,147,249,.3);border-radius:16px;padding:16px;background:rgba(15,15,35,.95);';
                sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }, 300);
        return true;
    }

    // ورود خودکار مهمان: اگر لینک دابل‌واچ قبلاً باز شده باشد، کد اتاق از
    // sessionStorage (هم‌دامنه با تب ویدیو) خوانده و اتصال خودکار برقرار می‌شود.
    function tryAutoJoin() {
        let raw = null;
        try { raw = sessionStorage.getItem('dw_autojoin'); } catch {}
        // تب تازه sessionStorage خالی دارد — از localStorage (همان origin) بخوان
        if (!raw) {
            try { raw = localStorage.getItem('dw_tabjoin_' + location.origin); } catch {}
            if (raw) { try { localStorage.removeItem('dw_tabjoin_' + location.origin); } catch {} }
        }
        if (!raw) return false;
        let j;
        try { j = JSON.parse(raw); } catch { return false; }
        if (!j || !j.code || (Date.now() - (j.ts || 0)) > 1000 * 60 * 60 * 24) return false;
        buildUI();
        connect(j.code, false, j.pass || '');
        updateConnButtons('connected');
        setStatus('⏳ ورود خودکار به اتاق ' + j.code + '...', '#ffb86c');
        // بعد از موفقیتِ ورود، پاک شود تا با رفرش دوباره وارد نشود؛
        // اگر ورود ناموفق بود، برای تلاش مجدد نگه داشته می‌شود.
        setTimeout(() => {
            if (connected && dwPaired) { try { sessionStorage.removeItem('dw_autojoin'); } catch {} }
        }, 3000);
        return true;
    }

    // ---------- درخواست تب جدید از background (chrome.tabs.create) ----------
    // sessionStorage بین تب‌های تازه مشترک نیست؛ پیش‌از باز کردن تب جدید،
    // کد/رمز را در localStorage هم ذخیره می‌کنیم تا تب تازه (همان origin)
    // بتواند از آن بخواند و خودکار وارد اتاق شود.
    function openInNewTab(url) {
        try {
            localStorage.setItem('dw_tabjoin_' + location.origin,
                JSON.stringify({ code: roomCode, pass: (pendingJoin && pendingJoin.pwd) || '', ts: Date.now() }));
        } catch {}
        try {
            chrome.runtime.sendMessage({ action: 'DW_OPEN_TAB', url }, (res) => {
                if (chrome.runtime.lastError || !res || !res.ok) {
                    // fallback: window.open از خود صفحه
                    try { window.open(url, '_blank'); } catch {}
                }
            });
        } catch {
            try { window.open(url, '_blank'); } catch {}
        }
    }

    // فعال کردن پنل اکستنشن (main.js) و نمایش بخش دابل‌واچ — فقط روی صفحاتی
    // که واقعاً ویدیو دارند و کاربر باید وضعیت اتصال را ببیند.
    function revealExtPanel() {
        const hasVideo = !!(document.querySelector('video') || document.querySelector('.video-js') ||
                            document.querySelector('.app-video-stage') || document.querySelector('.vjs-tech'));
        if (!hasVideo) return;
        const sec = document.getElementById('adv-dw-section');
        if (sec) sec.style.display = 'block';
        toMain({ action: 'DW_TOGGLE' });
    }

    // ---------- WebSocket ----------
    function serverBase() {
        let base = (SYNC_SERVER_URL || '').trim().replace(/\/+$/, '');
        if (!base) { try { base = localStorage.getItem('dw_server_url') || ''; } catch {} }
        return base;
    }

    function wsUrl() {
        const base = serverBase();
        if (!base) return null;
        const u = new URL(base);
        u.protocol = (u.protocol === 'https:') ? 'wss:' : ((u.protocol === 'http:') ? 'ws:' : u.protocol);
        u.pathname = '/sync';
        u.hash = '';
        return u.toString();
    }

    // لینک اشتراک: آدرس سرور + پارامتر c (کد اتاق) + پارامتر v (آدرس صفحهٔ ویدیوی میزبان)
    // توجه: هش (#CODE) در درخواست HTTP به سرور ارسال نمی‌شود، پس کد حتماً باید
    // به‌صورت query-param فرستاده شود تا Worker آن را ببیند. سازگاری با هش هم حفظ شده است.
    function shareLink(code) {
        const base = serverBase();
        if (!base) return 'کد اتاق: ' + code + ' — برای ساخت لینک، آدرس Worker را در پنل وارد کنید.';
        let link = base + '/?c=' + code;
        try {
            const v = sessionStorage.getItem('dw_host_video_href') || location.href;
            if (v && /^https?:\/\//i.test(v) && !/\.workers\.dev/i.test(location.hostname)) {
                link += '&v=' + encodeURIComponent(v);
            }
        } catch {}
        return link;
    }

    function connect(code, asHost, pwd, preferredCode) {
        disconnect();
        roomCode = code;
        isHost = asHost;
        pendingJoin = { code, pwd };

        const url = wsUrl();
        if (!url) {
            setStatus('❌ آدرس سرور تنظیم نشده — در پنل دابل‌واچ، کادر «آدرس سرور» را پر و ذخیره کنید (یا مراحل README.md را ببینید)', '#ff5555');
            return;
        }

        setStatus('⏳ در حال اتصال...', '#ffb86c');
        try { ws = new WebSocket(url); } catch (err) {
            setStatus('❌ خطا در ساخت اتصال: ' + err.message, '#ff5555');
            return;
        }

        ws.onopen = () => {
            connected = true;
            joinAttempts = 0;
            const p = (pendingJoin && pendingJoin.pwd) || '';
            // میزبان کد پیشنهادی خود را می‌فرستد تا لینک نمایش‌داده‌شده همان کد واقعی اتاق باشد
            if (isHost) ws.send(JSON.stringify({ type: 'create', pwd: p, code: preferredCode || undefined }));
            else ws.send(JSON.stringify({ type: 'join', code, pwd: p }));
            startHeartbeat();
        };

        ws.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            handleServerMessage(msg);
        };

        ws.onclose = () => {
            connected = false;
            stopHeartbeat();
            if (reconnectTimer) clearTimeout(reconnectTimer);
            if (joinAttempts < 6) {
                joinAttempts++;
                setStatus(`🔌 قطع شد — تلاش مجدد ${joinAttempts}/6...`, '#ffb86c');
                reconnectTimer = setTimeout(() => {
                    const p = pendingJoin;
                    if (p) connect(p.code, isHost, p.pwd);
                }, Math.min(15000, 1000 * Math.pow(2, joinAttempts)));
            } else {
                setStatus('❌ اتصال برقرار نشد. سرور را بررسی کنید.', '#ff5555');
                toMain({ action: 'DW_STATE', state: 'disconnected' });
            }
        };

        ws.onerror = () => { /* onclose مدیریت می‌کند */ };
    }

    function disconnect() {
        stopHeartbeat();
        dwPaired = false;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (ws) {
            try { ws.onclose = null; ws.close(); } catch {}
            ws = null;
        }
        connected = false;
        pendingJoin = null;
        if (statusEl) {
            statusEl.textContent = '⚪ غیرمتصل';
            statusEl.style.color = '#6272a4';
        }
    }

    function send(obj) {
        if (connected && ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    }

    function startHeartbeat() {
        stopHeartbeat();
        heartbeatTimer = setInterval(() => send({ type: 'ping' }), 25000);
    }
    function stopHeartbeat() {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    }

    // ---------- پردازش پیام‌های سرور ----------
    function handleServerMessage(msg) {
        switch (msg.type) {
            case 'created':
                // میزبان: اتاق ساخته شد — منتظر مهمان
                // اگر سرور کد متفاوتی ساخت (تعارض)، لینک و کد را اصلاح می‌کنیم
                if (msg.code && msg.code !== roomCode) {
                    roomCode = msg.code;
                    pendingJoin = { code: msg.code, pwd: (pendingJoin && pendingJoin.pwd) || '' };
                    try { sessionStorage.setItem('dw_host_code', msg.code); } catch {}
                    const li = document.getElementById('dw-link-input');
                    if (li) li.value = shareLink(msg.code);
                }
                setStatus('✅ متصل — منتظر مهمان... کد اتاق: ' + roomCode, '#50fa7b');
                toMain({ action: 'DW_STATE', state: 'waiting', role: 'host' });
                break;
            case 'joined':
                // مهمان: وارد اتاق شدیم؛ به‌زودی 'paired' می‌رسد
                setStatus('⏳ در انتظار تأیید میزبان...', '#ffb86c');
                break;
            case 'paired':
                // هر دو طرف: اتصال کامل شد
                dwPaired = true;
                setStatus('🎬 وصل شد! (' + (isHost ? 'میزبان' : 'مهمان') + ')', '#50fa7b');
                toMain({ action: 'DW_STATE', state: 'paired', role: isHost ? 'host' : 'guest' });
                if (!isHost) send({ type: 'relay', data: { type: 'request-sync' } });
                break;
            case 'peer_left':
                // طرف مقابل خارج شد — وضعیت UI در main.js به 'disconnected' می‌رود
                dwPaired = false;
                setStatus('⚠️ دوستت از اتاق خارج شد...', '#ffb86c');
                toMain({ action: 'DW_STATE', state: 'waiting', role: isHost ? 'host' : 'guest' });
                break;
            case 'error': {
                const em = msg.message || msg.reason || 'خطا';
                setStatus('❌ ' + em, '#ff5555');
                // اگر رمز لازم/اشتباه باشد، دوباره با رمز اتصال برقرار شود
                if (/رمز/.test(em) && !isHost && roomCode) showPassPrompt(true);
                break;
            }
            case 'relay': {
                const d = msg.data || {};
                if (d.type === 'state') {
                    // مهمان: اعمال کامل وضعیت میزبان
                    if (!isHost) {
                        suppressBroadcast = true;
                        toMain({ action: 'DW_APPLY_STATE', playing: !!d.playing, currentTime: d.currentTime, duration: d.duration });
                        setTimeout(() => { suppressBroadcast = false; }, 1200);
                    }
                } else if (d.type === 'play') {
                    if (!isHost) { suppressBroadcast = true; toMain({ action: 'DW_CTRL', cmd: 'play', t: d.t }); setTimeout(() => suppressBroadcast = false, 1200); }
                } else if (d.type === 'pause') {
                    if (!isHost) { suppressBroadcast = true; toMain({ action: 'DW_CTRL', cmd: 'pause' }); setTimeout(() => suppressBroadcast = false, 1200); }
                } else if (d.type === 'seek') {
                    if (!isHost) { suppressBroadcast = true; toMain({ action: 'DW_CTRL', cmd: 'seek', t: d.t }); setTimeout(() => suppressBroadcast = false, 1200); }
                } else if (d.type === 'sync') {
                    if (!isHost) { suppressBroadcast = true; toMain({ action: 'DW_RESYNC', t: d.t }); setTimeout(() => suppressBroadcast = false, 800); }
                } else if (d.type === 'request-sync') {
                    // مهمان از میزبان وضعیت فعلی را خواسته است
                    if (isHost) toMain({ action: 'DW_REQUEST_STATE' });
                } else if (d.type === 'meta') {
                    if (!isHost) toMain({ action: 'DW_META', title: d.title || '', href: d.href || '' });
                }
                break;
            }
            case 'pong':
                break;
        }
    }

    function relayToPeer(data) {
        if (connected) send({ type: 'relay', data });
    }

    // ---------- گزارش رویدادهای پلیر از main.js ----------
    function dwEventHandler(e) {
        if (e.__dwShared && e.currentTarget === window) return; // از طریق document پردازش می‌شود
        const ev = e.detail || {};
        try { sessionStorage.setItem('dw_host_video_href', location.href); } catch {}
        if (isHost) {
            // میزبان: رویدادهای کاربر را برای مهمان بفرست
            if (ev.kind === 'state') relayToPeer({ type: 'state', playing: !!ev.playing, currentTime: ev.currentTime, duration: ev.duration });
            else if (ev.kind === 'play')  relayToPeer({ type: 'play', t: ev.currentTime });
            else if (ev.kind === 'pause') relayToPeer({ type: 'pause', t: ev.currentTime });
            else if (ev.kind === 'seek')  relayToPeer({ type: 'seek', t: ev.currentTime });
            else if (ev.kind === 'ended') relayToPeer({ type: 'pause', t: ev.currentTime });
        } else if (!suppressBroadcast) {
            // مهمان: فقط «درخواست همگام‌سازی» (با نگه‌داشتن) ارسال می‌شود
            if (ev.kind === 'request-sync') relayToPeer({ type: 'request-sync' });
        }
    }
    document.addEventListener('DW_EVENT', dwEventHandler);
    window.addEventListener('DW_EVENT', dwEventHandler);

    // ---------- همگام‌سازی دوره‌ای (رفع درفتِ پخش) ----------
    setInterval(() => {
        if (!connected || !roomCode || !isHost || !dwPaired) return;
        // میزبان هر ۱۰ ثانیه وضعیت را برای مهمان ارسال می‌کند تا زمان‌بندی قفل بماند
        toMain({ action: 'DW_REQUEST_STATE' });
    }, 10000);

    // ---------- ساخت کد اشتراک ----------
    function genCode(len = 6) {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let s = '';
        const arr = new Uint8Array(len);
        crypto.getRandomValues(arr);
        for (let i = 0; i < len; i++) s += chars[arr[i] % chars.length];
        return s;
    }

    // ---------- UI پنل دابل‌واچ ----------
    const S = {
        box: `background:rgba(255,255,255,0.04);border-radius:10px;padding:10px 12px;margin-bottom:10px;`,
        input: `width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.35);color:#f8f8f2;font-size:12px;outline:none;margin-top:6px;font-family:inherit;`,
        btn: (c) => `flex:1;padding:8px 0;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;background:${c};color:#1a1a2e;transition:all 0.2s ease;font-family:inherit;`,
        ghost: `padding:8px 0;border:1px solid rgba(255,255,255,0.12);border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;background:rgba(255,255,255,0.06);color:white;transition:all 0.2s ease;font-family:inherit;`
    };

    function buildUI() {
        const fresh = !panelEl || !document.body.contains(panelEl);
        panelEl = document.getElementById('adv-dw-body') || document.getElementById('adv-dw-section');
        if (!panelEl) return; // پنل اصلی هنوز ساخته نشده
        if (!fresh) {
            // پنل بازسازی شده — فقط وضعیت اتصال را دوباره در UI نشان بده
            setStatus(connected ? '✅ متصل' : '⚪ غیرمتصل', connected ? '#50fa7b' : '#6272a4');
            updateConnButtons(connected ? 'connected' : 'disconnected');
            if (connected && isHost) restoreConnUI();
            return;
        }
        panelEl.innerHTML = '';

        // --- عنوان ---
        const head = document.createElement('div');
        head.style.cssText = `font-size:12px;color:#bd93f9;font-weight:700;margin-bottom:8px;display:flex;align-items:center;gap:6px;`;
        head.innerHTML = '👥 دابل‌واچ (تماشای دونفره)';
        panelEl.appendChild(head);

        // --- آدرس سرور همگام‌سازی (یک‌بار تنظیم شود، ذخیره می‌ماند) ---
        const srvBox = document.createElement('div');
        srvBox.id = 'dw-server-box';
        srvBox.style.cssText = S.box + 'margin-bottom:10px;';
        const srvLabel = document.createElement('div');
        srvLabel.style.cssText = `font-size:10px;color:#6272a4;margin-bottom:4px;`;
        srvLabel.textContent = 'آدرس سرور (Cloudflare Worker — یک‌بار وارد کنید، ذخیره می‌شود):';
        const srvInput = document.createElement('input');
        srvInput.id = 'dw-server-input';
        srvInput.dir = 'ltr';
        srvInput.placeholder = 'https://dw-sync.xxxxx.workers.dev';
        let savedSrv = '';
        try { savedSrv = localStorage.getItem('dw_server_url') || ''; } catch {}
        srvInput.value = savedSrv || (SYNC_SERVER_URL || '');
        srvInput.style.cssText = S.input;
        const srvSave = document.createElement('button');
        srvSave.innerHTML = '💾 ذخیرهٔ آدرس سرور';
        srvSave.style.cssText = S.btn('#50fa7b') + 'width:100%;margin-top:8px;';
        srvBox.appendChild(srvLabel); srvBox.appendChild(srvInput); srvBox.appendChild(srvSave);
        panelEl.appendChild(srvBox);

        // اگر هنوز آدرسی تنظیم نشده، این کادر را باز نگه دار تا کاربر پر کند
        if (!serverBase()) srvBox.style.display = 'block';
        else srvBox.style.display = 'none';
        srvSave.onclick = () => {
            let v = (srvInput.value || '').trim().replace(/\/+$/, '');
            if (!/^https?:\/\//i.test(v)) { setStatus('❌ آدرس باید با https:// شروع شود', '#ff5555'); return; }
            try { localStorage.setItem('dw_server_url', v); } catch {}
            srvBox.style.display = 'none';
            flash(srvSave, '✅ ذخیره شد');
            setStatus('✅ آدرس سرور ذخیره شد — حالا «ایجاد لینک» یا «ورود با کد» را بزنید', '#50fa7b');
        };

        // --- دکمه‌های ایجاد / پیوستن ---
        const row = document.createElement('div');
        row.style.cssText = `display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px;`;
        const createBtn = document.createElement('button');
        createBtn.innerHTML = '🔗 ایجاد لینک';
        createBtn.style.cssText = S.btn('#bd93f9');
        const joinBtn = document.createElement('button');
        joinBtn.innerHTML = '🚪 ورود با کد';
        joinBtn.style.cssText = S.btn('#8be9fd');
        row.appendChild(createBtn); row.appendChild(joinBtn);
        panelEl.appendChild(row);

        // --- ناحیه لینک میزبان ---
        const linkBox = document.createElement('div');
        linkBox.id = 'dw-link-box';
        linkBox.style.cssText = S.box + 'display:none;direction:ltr;text-align:left;';
        const linkLabel = document.createElement('div');
        linkLabel.style.cssText = `font-size:10px;color:#6272a4;margin-bottom:4px;`;
        linkLabel.textContent = 'این لینک را برای دوستت بفرست:';
        const linkInput = document.createElement('input');
        linkInput.id = 'dw-link-input';
        linkInput.readOnly = true;
        linkInput.dir = 'ltr';
        linkInput.style.cssText = S.input;
        const copyRow = document.createElement('div');
        copyRow.style.cssText = `display:flex;gap:6px;margin-top:8px;`;
        const copyBtn = document.createElement('button');
        copyBtn.innerHTML = '📋 کپی لینک';
        copyBtn.style.cssText = S.ghost + 'flex:1;';
        const pwBtn = document.createElement('button');
        pwBtn.innerHTML = '🔒 رمز';
        pwBtn.title = 'تنظیم رمز اتاق';
        pwBtn.style.cssText = S.ghost + 'flex:1;';
        copyRow.appendChild(copyBtn); copyRow.appendChild(pwBtn);
        linkBox.appendChild(linkLabel); linkBox.appendChild(linkInput); linkBox.appendChild(copyRow);
        panelEl.appendChild(linkBox);

        // --- ناحیه ورود مهمان ---
        const joinBox = document.createElement('div');
        joinBox.id = 'dw-join-box';
        joinBox.style.cssText = S.box + 'display:none;';
        const joinHint = document.createElement('div');
        joinHint.style.cssText = `font-size:10px;color:#6272a4;`;
        joinHint.textContent = 'کد ۶ رقمی اتاق را وارد کنید:';
        const codeInput = document.createElement('input');
        codeInput.id = 'dw-code-input';
        codeInput.maxLength = 8;
        codeInput.placeholder = 'مثلاً A3F7KQ';
        codeInput.dir = 'ltr';
        codeInput.style.cssText = S.input + 'text-transform:uppercase;text-align:center;letter-spacing:2px;font-weight:700;';
        const goBtn = document.createElement('button');
        goBtn.id = 'dw-join-go';
        goBtn.innerHTML = '➜ ورود به اتاق';
        goBtn.style.cssText = S.btn('#8be9fd') + 'width:100%;margin-top:8px;';
        joinBox.appendChild(joinHint); joinBox.appendChild(codeInput); joinBox.appendChild(goBtn);
        panelEl.appendChild(joinBox);

        // --- وضعیت ---
        statusEl = document.createElement('div');
        statusEl.id = 'dw-status';
        statusEl.style.cssText = `text-align:center;font-size:11px;color:#6272a4;padding:6px;border-radius:6px;background:rgba(255,255,255,0.03);font-weight:600;`;
        statusEl.textContent = '⚪ غیرمتصل';
        panelEl.appendChild(statusEl);

        // --- کنترل‌های اتصال ---
        const ctrlRow = document.createElement('div');
        ctrlRow.style.cssText = `display:flex;gap:6px;margin-top:8px;`;
        const syncBtn = document.createElement('button');
        syncBtn.id = 'dw-sync-btn';
        syncBtn.innerHTML = '🔄 همگام‌سازی';
        syncBtn.title = 'همگام با طرف مقابل';
        syncBtn.style.cssText = S.ghost + 'flex:1;display:none;';
        const leaveBtn = document.createElement('button');
        leaveBtn.id = 'dw-leave-btn';
        leaveBtn.innerHTML = '🚪 خروج';
        leaveBtn.style.cssText = S.ghost + 'flex:1;display:none;color:#ff5555;border-color:rgba(255,85,85,0.3);';
        ctrlRow.appendChild(syncBtn); ctrlRow.appendChild(leaveBtn);
        panelEl.appendChild(ctrlRow);

        // --- رویدادها ---
        createBtn.onclick = openCreateDialog;
        joinBtn.onclick = openJoinDialog;
        copyBtn.onclick = () => {
            linkInput.select();
            (navigator.clipboard ? navigator.clipboard.writeText(linkInput.value) : Promise.reject())
                .then(() => flash(copyBtn, '✅ کپی شد'))
                .catch(() => { document.execCommand('copy'); flash(copyBtn, '✅ کپی شد'); });
        };
        pwBtn.onclick = () => {
            const p = prompt('رمز اتاق (خالی = بدون رمز):') ?? '';
            applyPassword(p.trim());
            flash(pwBtn, p.trim() ? '🔒 رمز ست شد' : '🔓 بدون رمز');
        };
        goBtn.onclick = () => {
            const c = (codeInput.value || '').trim().toUpperCase();
            if (c.length < 4) { setStatus('❌ کد معتبر نیست', '#ff5555'); return; }
            const saved = sessionStorage.getItem('dw_pass_' + c) || '';
            closeBoxes();
            connect(c, false, saved);
            updateConnButtons('connected');
        };
        codeInput.onkeydown = (e) => { if (e.key === 'Enter') goBtn.click(); };
        syncBtn.onclick = () => {
            if (isHost) toMain({ action: 'DW_REQUEST_STATE' });
            else send({ type: 'relay', data: { type: 'request-sync' } });
            flash(syncBtn, '🔄 ارسال شد');
        };
        leaveBtn.onclick = () => {
            disconnect();
            toMain({ action: 'DW_STATE', state: 'disconnected' });
            resetUI();
        };

        // اگر از قبل متصلیم، وضعیت را بازگردان
        if (connected) restoreConnUI();
    }

    function flash(btn, text) {
        const old = btn.innerHTML;
        btn.innerHTML = text;
        setTimeout(() => { btn.innerHTML = old; }, 1500);
    }

    function setStatus(text, color) {
        if (!statusEl) buildUI();
        if (statusEl) {
            statusEl.textContent = text;
            if (color) statusEl.style.color = color;
        }
    }

    function closeBoxes() {
        const lb = document.getElementById('dw-link-box');
        const jb = document.getElementById('dw-join-box');
        const sb = document.getElementById('dw-server-box');
        if (lb) lb.style.display = 'none';
        if (jb) jb.style.display = 'none';
        if (sb && serverBase()) sb.style.display = 'none';
    }

    function openCreateDialog() {
        buildUI();
        if (!serverBase()) {
            const sb = document.getElementById('dw-server-box');
            if (sb) { sb.style.display = 'block'; sb.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
            setStatus('❌ اول آدرس سرور (Worker) را در کادر سبز بالا وارد و ذخیره کنید', '#ff5555');
            return;
        }
        // کد اتاق را محلی تولید می‌کنیم تا لینک اشتراک «قبل از پاسخ سرور» قابل کپی باشد.
        // اگر این کد آزاد باشد، سرور همان را می‌پذیرد؛ در غیر این صورت سرور کد جدیدی
        // می‌سازد و پیام 'created' لینک را خودکار اصلاح می‌کند (نگام‌سازی دو لایه).
        const code = genCode();
        try { sessionStorage.setItem('dw_host_video_href', location.href); } catch {}
        const linkInput = document.getElementById('dw-link-input');
        if (linkInput) linkInput.value = shareLink(code);
        document.getElementById('dw-link-box').style.display = 'block';
        document.getElementById('dw-join-box').style.display = 'none';
        sessionStorage.setItem('dw_host_code', code);
        connect(code, true, sessionStorage.getItem('dw_pass_' + code) || '', code);
        updateConnButtons('connected');
    }

    function openJoinDialog() {
        buildUI();
        if (!serverBase()) {
            const sb = document.getElementById('dw-server-box');
            if (sb) { sb.style.display = 'block'; sb.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
            setStatus('❌ اول آدرس سرور (Worker) را در کادر بالا وارد و ذخیره کنید', '#ff5555');
            return;
        }
        document.getElementById('dw-join-box').style.display = 'block';
        document.getElementById('dw-link-box').style.display = 'none';
        const ci = document.getElementById('dw-code-input');
        if (ci) ci.focus();
    }

    function applyPassword(pwd) {
        const code = sessionStorage.getItem('dw_host_code') || roomCode;
        if (code) sessionStorage.setItem('dw_pass_' + code, pwd);
        // سرور فعلی تغییر رمز در لحظه را پشتیبانی نمی‌کند؛ اتاق بازسازی می‌شود.
        // اگر هنوز مهمان وارد نشده، با همان کد اتاق دوباره ساخته شود تا لینک معتبر بماند.
        if (connected && isHost) {
            const li = document.getElementById('dw-link-input');
            connect(code, true, pwd, dwPaired ? undefined : code);
            if (li) li.value = shareLink(code);
            setStatus('🔁 اتاق با رمز جدید ساخته شد — لینک را دوباره بفرست', '#ffb86c');
        } else {
            send({ type: 'relay', data: { type: 'set-pass', pass: pwd } });
        }
    }

    function updateConnButtons(state) {
        const syncBtn = document.getElementById('dw-sync-btn');
        const leaveBtn = document.getElementById('dw-leave-btn');
        if (!syncBtn || !leaveBtn) return;
        const show = (state === 'connected');
        syncBtn.style.display = show ? 'block' : 'none';
        leaveBtn.style.display = show ? 'block' : 'none';
    }

    function restoreConnUI() {
        if (isHost) {
            const lb = document.getElementById('dw-link-box');
            const li = document.getElementById('dw-link-input');
            if (li && roomCode) li.value = shareLink(roomCode);
            if (lb) lb.style.display = 'block';
        }
        updateConnButtons('connected');
    }

    function resetUI() {
        closeBoxes();
        updateConnButtons('disconnected');
        setStatus('⚪ غیرمتصل', '#6272a4');
    }

    function showPassPrompt(reask) {
        const p = prompt(reask ? 'رمز واردشده اشتباه است. دوباره تلاش کنید:' : 'این اتاق رمز دارد. رمز را وارد کنید:');
        if (p === null) { disconnect(); resetUI(); return; }
        pendingJoin = { code: roomCode, pwd: p.trim() };
        sessionStorage.setItem('dw_pass_' + roomCode, p.trim());
        // اتصال مجدد با رمز صحیح
        connect(roomCode, false, p.trim());
    }

    // ---------- صفحهٔ فرود Join (روی دامنهٔ Worker) ----------
    // double-watch.js به‌عنوان content script روی <all_urls> اجرا می‌شود.
    // اگر لینک دابل‌واچ روی دامنهٔ Worker باز شود:
    //   • بدون v  → ورود خودکار به اتاق همین‌جا (اتاق فقط برای چت وضعیت است)
    //   • با v    → پنل تأیید نمایش داده می‌شود؛ با کلیک، تب به صفحهٔ ویدیو
    //               رفته و کد/رمز در sessionStorage مقصد نوشته می‌شود تا
    //               ورود خودکار انجام شود.
    function showLandingConfirm(code, target) {
        const box = document.createElement('div');
        box.id = 'dw-landing-confirm';
        box.style.cssText = `position:fixed;inset:auto 16px 16px auto;z-index:2147483647;direction:rtl;background:rgba(15,15,35,.97);border:1px solid rgba(189,147,249,.4);border-radius:16px;padding:20px 22px;max-width:380px;font-family:'Segoe UI',Tahoma,Arial,sans-serif;color:#f8f8f2;box-shadow:0 12px 48px rgba(0,0,0,.7);`;
        box.innerHTML = `
          <div style="font-size:30px;">🎬👥</div>
          <h3 style="margin:6px 0;color:#bd93f9;font-size:15px;">دابل‌واچ — کد ${code}</h3>
          <p style="font-size:12px;color:#8be9fd;line-height:2;margin:8px 0;">${target ? 'برای تماشای همزمان، این تب به صفحهٔ انیمه می‌رود و اکستنشن خودکار وارد اتاق می‌شود.' : 'اتصال به اتاق برقرار شد ✓ حالا صفحهٔ پخش انیمه را باز کنید و از پنل «ورود با کد» همین کد را بزنید.'}</p>
          ${target ? `<button id="dw-go" style="width:100%;padding:12px;border:none;border-radius:10px;font-size:14px;font-weight:800;cursor:pointer;background:linear-gradient(135deg,#bd93f9,#ff79c6);color:#1a1a2e;">➜ ورود به انیمه و شروع تماشا</button>` : ''}
          <button id="dw-close" style="width:100%;margin-top:8px;padding:8px;border:1px solid rgba(255,255,255,.15);border-radius:10px;font-size:12px;cursor:pointer;background:transparent;color:#6272a4;">بستن</button>`;
        document.documentElement.appendChild(box);
        const closeBtn = box.querySelector('#dw-close');
        closeBtn && closeBtn.addEventListener('click', () => box.remove());
        const goBtn = box.querySelector('#dw-go');
        goBtn && goBtn.addEventListener('click', () => {
            try {
                sessionStorage.setItem('dw_autojoin', JSON.stringify({ code, pass: '', ts: Date.now() }));
            } catch {}
            location.href = target;
        });
    }

    // ---------- بوت استریپ صفحهٔ فرود ----------
    // لینک‌های جدید با ?c=CODE ساخته می‌شوند (نه #CODE)؛ این بخش هر دو حالت را پوشش می‌دهد.
    const landingCode = getLandingCode();
    if (landingCode) {
        const isWorkerPage = /^https?:$/.test(location.protocol) && /\.workers\.dev$/i.test(location.hostname);
        let v = null;
        try {
            const vv = new URLSearchParams(location.search).get('v');
            if (vv && /^https?:\/\//i.test(vv)) v = vv;
        } catch {}

        if (isWorkerPage) {
            // روی دامنهٔ Worker: اتصال + ریدایرکت سریع به صفحهٔ ویدیو (خودکار، بدون کلیک)
            autoJoinFromWorkerLanding();
            if (v) showLandingConfirm(landingCode, v);
        } else {
            // ما روی دامنهٔ Worker نیستیم: کد را برای ورود خودکار ذخیره کن
            try { sessionStorage.setItem('dw_autojoin', JSON.stringify({ code: landingCode, pass: '', ts: Date.now() })); } catch {}
            // اگر پنل اکستنشن در همین صفحه باز باشد، فرم ورود کد را پر کن
            toMain({ action: 'DW_JOIN_PREFILL', code: landingCode });
        }
    }
})();
