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
    let suppressBroadcast = false;
    let panelEl = null;
    let statusEl = null;

    // ---------- پیام به main.js (MAIN world) ----------
    function toMain(detail) {
        document.dispatchEvent(new CustomEvent('DW_MAIN_MSG', { detail }));
    }

    // ---------- دریافت پیام از main.js ----------
    document.addEventListener('DW_EXT_MSG', (e) => {
        const m = e.detail || {};
        switch (m.action) {
            case 'DW_TOGGLE':
                buildUI();
                if (!connected && !tryAutoJoin()) openCreateDialog();
                break;
            case 'DW_JOIN_INFO': // فقط مهمان: اطلاعات پلیر محلی برای صفحه Join
                if (typeof m.currentTime === 'number') lastKnownTs = m.currentTime;
                break;
            case 'DW_DISCONNECT':
                disconnect();
                break;
        }
    });

    // ورود خودکار مهمان: اگر لینک دابل‌واچ قبلاً باز شده باشد، کد اتاق از
    // sessionStorage (هم‌دامنه با تب ویدیو) خوانده و اتصال خودکار برقرار می‌شود.
    function tryAutoJoin() {
        let raw = null;
        try { raw = sessionStorage.getItem('dw_autojoin'); } catch {}
        if (!raw) return false;
        let j;
        try { j = JSON.parse(raw); } catch { return false; }
        if (!j || !j.code || (Date.now() - (j.ts || 0)) > 1000 * 60 * 60 * 24) return false;
        try { sessionStorage.removeItem('dw_autojoin'); } catch {}
        buildUI();
        connect(j.code, false, j.pass || '');
        updateConnButtons('connected');
        setStatus('⏳ ورود خودکار به اتاق ' + j.code + '...', '#ffb86c');
        return true;
    }

    // ---------- WebSocket ----------
    function wsUrl(code) {
        const base = (SYNC_SERVER_URL || '').trim().replace(/\/+$/, '');
        if (!base) return null;
        const u = new URL(base);
        u.protocol = (u.protocol === 'https:') ? 'wss:' : ((u.protocol === 'http:') ? 'ws:' : u.protocol);
        u.pathname = '/room/' + encodeURIComponent(code);
        return u.toString();
    }

    function connect(code, asHost, pwd) {
        disconnect();
        roomCode = code;
        isHost = asHost;
        pendingJoin = { code, pwd };

        const url = wsUrl(code);
        if (!url) {
            setStatus('❌ آدرس سرور تنظیم نشده — در double-watch.js مقدار SYNC_SERVER_URL را پر کنید', '#ff5555');
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
            ws.send(JSON.stringify({ type: 'join', role: isHost ? 'host' : 'guest', pass: (pendingJoin && pendingJoin.pwd) || '' }));
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
            case 'joined':
                if (msg.status === 'waiting') {
                    setStatus('✅ متصل — منتظر مهمان...', '#50fa7b');
                    toMain({ action: 'DW_STATE', state: 'waiting', role: isHost ? 'host' : 'guest' });
                } else if (msg.status === 'paired') {
                    setStatus('🎬 وصل شد! (' + (isHost ? 'میزبان' : 'مهمان') + ')', '#50fa7b');
                    toMain({ action: 'DW_STATE', state: 'paired', role: isHost ? 'host' : 'guest' });
                    if (!isHost) {
                        // مهمان: یک درخواست وضعیت اولیه بفرست
                        send({ type: 'ask-state' });
                    }
                    // میزبان: پاسخ ask-state در سرور با 'request-state' به او برمی‌گردد
                }
                break;
            case 'request-state':
                // سرور از ما (میزبان) وضعیت فعلی خواسته است
                toMain({ action: 'DW_REQUEST_STATE' });
                break;
            case 'rejected':
                setStatus('❌ ' + (msg.reason || 'اتصال رد شد'), '#ff5555');
                break;
            case 'full':
                setStatus('❌ اتاق پر است (حداکثر ۲ نفر)', '#ff5555');
                break;
            case 'peer-left':
                setStatus('👋 طرف مقابل خارج شد', '#ffb86c');
                toMain({ action: 'DW_STATE', state: 'waiting', role: isHost ? 'host' : 'guest' });
                break;
            case 'peer-pass-required':
                showPassPrompt();
                break;
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
                } else if (d.type === 'meta') {
                    if (!isHost) toMain({ action: 'DW_META', title: d.title || '', href: d.href || '' });
                }
                break;
            }
        }
    }

    function relayToPeer(data) {
        if (connected) send({ type: 'relay', data });
    }

    // ---------- گزارش رویدادهای پلیر از main.js ----------
    document.addEventListener('DW_EVENT', (e) => {
        const ev = e.detail || {};
        if (isHost) {
            // میزبان: رویدادهای کاربر را برای مهمان بفرست
            const playing = (ev.kind === 'play' || ev.kind === 'seek') ? true
                          : (ev.kind === 'pause' || ev.kind === 'ended') ? false
                          : undefined; // state → خودش playing دارد
            if (ev.kind === 'state') relayToPeer({ type: 'state', playing: !!ev.playing, currentTime: ev.currentTime, duration: ev.duration });
            else if (ev.kind === 'play')  relayToPeer({ type: 'play', t: ev.currentTime });
            else if (ev.kind === 'pause') relayToPeer({ type: 'pause', t: ev.currentTime });
            else if (ev.kind === 'seek')  relayToPeer({ type: 'seek', t: ev.currentTime });
            else if (ev.kind === 'ended') relayToPeer({ type: 'pause', t: ev.currentTime });
        } else if (!suppressBroadcast) {
            // مهمان: فقط «درخواست همگام‌سازی» (با نگه‌داشتن) ارسال می‌شود
            if (ev.kind === 'request-sync') send({ type: 'ask-state' });
        }
    });

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
        panelEl = document.getElementById('adv-dw-section');
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
            else send({ type: 'ask-state' });
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
        if (lb) lb.style.display = 'none';
        if (jb) jb.style.display = 'none';
    }

    function openCreateDialog() {
        buildUI();
        const code = genCode();
        const base = (SYNC_SERVER_URL || '').trim().replace(/\/+$/, '');
        const joinUrl = base + '/#' + code;
        const linkInput = document.getElementById('dw-link-input');
        if (linkInput) linkInput.value = joinUrl;
        document.getElementById('dw-link-box').style.display = 'block';
        document.getElementById('dw-join-box').style.display = 'none';
        sessionStorage.setItem('dw_host_code', code);
        connect(code, true, sessionStorage.getItem('dw_pass_' + code) || '');
        updateConnButtons('connected');
    }

    function openJoinDialog() {
        buildUI();
        document.getElementById('dw-join-box').style.display = 'block';
        document.getElementById('dw-link-box').style.display = 'none';
        const ci = document.getElementById('dw-code-input');
        if (ci) ci.focus();
    }

    function applyPassword(pwd) {
        const code = sessionStorage.getItem('dw_host_code') || roomCode;
        if (code) sessionStorage.setItem('dw_pass_' + code, pwd);
        send({ type: 'set-pass', pass: pwd });
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
        if (isHost && !document.getElementById('dw-link-box').style.display.includes('block')) {
            const lb = document.getElementById('dw-link-box');
            const li = document.getElementById('dw-link-input');
            if (li && !li.value) li.value = (SYNC_SERVER_URL || '') + '/#' + roomCode;
            if (lb) lb.style.display = 'block';
        }
        updateConnButtons('connected');
    }

    function resetUI() {
        closeBoxes();
        updateConnButtons('disconnected');
        setStatus('⚪ غیرمتصل', '#6272a4');
    }

    function showPassPrompt() {
        const p = prompt('این اتاق رمز دارد. رمز را وارد کنید:');
        if (p === null) { disconnect(); resetUI(); return; }
        send({ type: 'pass', pass: p.trim() });
        sessionStorage.setItem('dw_pass_' + roomCode, p.trim());
    }

    // ---------- صفحه Join (تب دوم مهمان) ----------
    // وقتی دوست لینک را باز می‌کند، این صفحه او را به تب اکستنشن‌دار هدایت می‌کند
    // و کد + رمز را در sessionStorage همان دامنه می‌گذارد تا main.js خودکار بپیوندد.
    if (/^#([A-Z0-9]{4,8})$/i.test(location.hash)) {
        const code = location.hash.slice(1).toUpperCase();
        const m = sessionStorage.getItem('dw_join');
        let pwd = '';
        if (m) { try { const j = JSON.parse(m); if (j.code === code) pwd = j.pass || ''; } catch {} }

        document.documentElement.innerHTML = `
        <head><meta charset="utf-8"><title>دابل‌واچ — پیوستن</title></head>
        <body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1a1a2e,#16213e);font-family:'Segoe UI',Tahoma,Arial,sans-serif;color:#f8f8f2;direction:rtl;">
          <div style="background:rgba(15,15,35,.92);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:34px 40px;max-width:440px;width:90%;box-shadow:0 12px 48px rgba(0,0,0,.6);text-align:center;">
            <div style="font-size:44px;">🎬👥</div>
            <h2 style="margin:12px 0 4px;color:#bd93f9;">حالت دابل‌واچ</h2>
            <p style="color:#6272a4;font-size:13px;line-height:2;margin:8px 0 18px;">
              کد اتاق شما:
              <span dir="ltr" style="display:inline-block;background:rgba(189,147,249,.15);color:#bd93f9;font-weight:800;letter-spacing:3px;padding:4px 14px;border-radius:8px;font-size:18px;">${code}</span>
            </p>
            <div id="info" style="font-size:12px;color:#8be9fd;margin-bottom:18px;line-height:2;"></div>
            <button id="goBtn" style="width:100%;padding:14px;border:none;border-radius:12px;font-size:15px;font-weight:800;cursor:pointer;background:linear-gradient(135deg,#bd93f9,#ff79c6);color:#1a1a2e;box-shadow:0 8px 24px rgba(189,147,249,.35);">➜ ورود به انیمه و شروع تماشا</button>
            <p style="font-size:11px;color:#6272a4;margin-top:16px;line-height:2;">
              ⚠️ هر دو نفر باید همین صفحه را در مرورگری باز کنند که
              <b style="color:#50fa7b;">اکستنشن روی آن نصب است</b>.
              پس از باز شدن صفحه پخش، اکستنشن به‌طور خودکار وارد اتاق می‌شود.
            </p>
          </div>
        </body>`;

        const info = document.getElementById('info');
        const extMissing = !chrome?.runtime?.getURL;
        if (extMissing) {
            info.innerHTML = '⚠️ به نظر می‌رسد اکستنشن روی این مرورگر نصب نیست!<br>آن را نصب کنید و دوباره لینک را باز کنید.';
            info.style.color = '#ff5555';
        } else {
            info.textContent = 'اکستنشن شناسایی شد ✓';
        }

        // ذخیره کد+رمز برای همان دامنه تا تب پخش خودکار وارد شود
        try { sessionStorage.setItem('dw_autojoin', JSON.stringify({ code, pass: pwd, ts: Date.now() })); } catch {}

        document.getElementById('goBtn').onclick = () => {
            // اگر از لینک سرور آمده‌ایم، به آخرین آدرس انیمهٔ ذخیره‌شده برو؛ وگرنه خودِ همین صفحه
            let target = null;
            try {
                const raw = localStorage.getItem('dw_last_video_href'); // از worker/سایت ممکن است نباشد
                if (raw) target = raw;
            } catch {}
            const params = new URLSearchParams(location.search);
            const v = params.get('v');
            if (v && /^https?:\/\//i.test(v)) target = v;
            if (target) location.replace(target);
            else {
                info.innerHTML += '<br>ℹ️ صفحهٔ پخش انیمه را باز کنید (همین تب قابل استفاده است).';
            }
        };
    }
})();
