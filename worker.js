// ===== سرور همگام‌سازی دابل‌واچ — Cloudflare Worker =====
// رایگان، بدون هزینه. راه‌اندازی از طریق داشبورد (کاملاً دستی):
//   1) وارد dash.cloudflare.com شو → Workers & Pages → Create → Worker
//   2) نام Worker را dw-sync بگذار، کد آماده را پاک کن و این فایل را کامل کپی کن
//   3) دکمهٔ Deploy را بزن
//   4) آدرس نمایش‌داده‌شده (مثل https://dw-sync.username.workers.dev) را
//      در فایل double-watch.js داخل متغیر SYNC_SERVER_URL بگذار
//   5) اکستنشن را در chrome://extensions دوباره Reload کن
// نکته: اگر بعداً هر دو نفر در اتاقی بودند ولی پیام‌ها رد و بدل نشد،
//       یک بار Worker را Redeploy کن تا instanceهای قدیمی ریست شوند.
//
// این Worker دو کار انجام می‌دهد:
//   • مسیر /sync  → WebSocket relay بین دو نفر (اتاق با کد اشتراک + رمز اختیاری)
//   • سایر مسیرها → HTML صفحهٔ فرود Join (اکستنشن روی آن زیباسازی می‌کند)
//
// پروتکل پیام‌ها (JSON روی WebSocket):
//   client -> server : {type:'create', pwd?}
//                      {type:'join', code, pwd?}
//                      {type:'relay', data:{...}}        (پیام همگام‌سازی)
//                      {type:'ping'}
//   server -> client : {type:'created', code}
//                      {type:'joined', code} | {type:'paired', code}
//                      {type:'error', message}
//                      {type:'relay', from, data}
//                      {type:'peer_left'} | {type:'pong'}

const ROOM_TTL_MS = 60 * 60 * 1000; // یک ساعت بعد از آخرین فعالیت، اتاق منقضی می‌شود

// اتاق‌ها در حافظهٔ هر instance نگه داشته می‌شوند؛ برای دونفره کافی است.
const rooms = new Map(); // code -> { host: ws|null, guest: ws|null, pwd: string, lastTs: number }

function randCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  for (let i = 0; i < len; i++) s += chars[arr[i] % chars.length];
  return s;
}

function cleanupRoom(code) {
  const r = rooms.get(code);
  if (!r) return;
  if (!r.host && !r.guest) rooms.delete(code);
}

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (e) { /* noop */ }
}

function closeQuietly(ws) {
  try { ws.close(1000); } catch (e) { /* noop */ }
}

// تمیزکاری اتاق‌های رهاشده — lazy، بدون setInterval/unref
// در Cloudflare Workers نیازی به تایمر سراسری نیست؛ هر ۵ دقیقه که یک پیام
// جدید می‌رسد، اتاق‌های قدیمی همان‌جا پاک می‌شوند. این روش هیچ خطای TS
// (مثل TS2339 روی unref) ایجاد نمی‌کند و کاملاً با Workers سازگار است.
let lastCleanup = Date.now();
function maybeCleanup() {
  const now = Date.now();
  if (now - lastCleanup < 5 * 60 * 1000) return;
  lastCleanup = now;
  for (const [code, r] of rooms) {
    if (now - r.lastTs > ROOM_TTL_MS) {
      closeQuietly(r.host);
      closeQuietly(r.guest);
      rooms.delete(code);
    }
  }
}

// HTML حداقلی صفحهٔ فرود — double-watch.js (content script) آن را زیباسازی می‌کند.
function landingHtml() {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<title>دابل‌واچ — پیوستن</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1a1a2e;color:#f8f8f2;font-family:Tahoma,Arial,sans-serif;">
<div style="text-align:center;max-width:440px;padding:24px;">
<h2>🎬👥 دابل‌واچ</h2>
<p id="p">در حال بارگذاری… اگر اکستنشن Video Unlocker Pro نصب نیست، آن را نصب کنید و لینک را دوباره باز کنید.</p>
</div></body></html>`;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname !== '/sync') {
      return new Response(landingHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    ctx.waitUntil(handle(server));
    return new Response(null, { status: 101, webSocket: client });
  }
};

function handle(ws) {
  ws.accept();
  let room = null;      // کد اتاقی که این اتصال در آن عضو است
  let role = null;      // 'host' | 'guest'

  const handoff = () => {
    if (!room) return;
    const r = rooms.get(room);
    if (!r) return;
    if (role === 'host') r.host = null; else r.guest = null;
    const peerSock = role === 'host' ? r.guest : r.host;
    if (peerSock) send(peerSock, { type: 'peer_left' });
    cleanupRoom(room);
  };

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    maybeCleanup();
    const r = room ? rooms.get(room) : null;
    if (r) r.lastTs = Date.now();

    switch (msg.type) {

      case 'create': {
        if (room) return; // قبلاً عضو اتاقی هستیم
        let code = randCode();
        while (rooms.has(code)) code = randCode();
        rooms.set(code, { host: ws, guest: null, pwd: String(msg.pwd || ''), lastTs: Date.now() });
        room = code; role = 'host';
        send(ws, { type: 'created', code });
        break;
      }

      case 'join': {
        if (room) return;
        const code = String(msg.code || '').toUpperCase().trim();
        const target = rooms.get(code);
        if (!target || !target.host) return send(ws, { type: 'error', message: 'اتاقی با این کد پیدا نشد (ممکن است میزبان خارج شده یا منقضی شده باشد).' });
        if (target.guest) return send(ws, { type: 'error', message: 'این اتاق پر است؛ فقط دو نفر می‌توانند همزمان ببینند.' });
        if (target.pwd && target.pwd !== String(msg.pwd || '')) {
          return send(ws, { type: 'error', message: 'رمز اتاق اشتباه است.' });
        }
        target.guest = ws;
        target.lastTs = Date.now();
        room = code; role = 'guest';
        send(ws, { type: 'joined', code });
        send(target.host, { type: 'paired', code });
        send(ws, { type: 'paired', code });
        break;
      }

      case 'relay': {
        // پیام همگام‌سازی را برای طرف مقابل فوروارد می‌کنیم
        if (!r) return;
        const peerSock = role === 'host' ? r.guest : r.host;
        if (peerSock) send(peerSock, { type: 'relay', from: role, data: msg.data });
        break;
      }

      case 'ping':
        send(ws, { type: 'pong' });
        break;
    }
  });

  ws.addEventListener('close', handoff);
  ws.addEventListener('error', handoff);
}
