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

// صفحهٔ فرود کامل و مستقل — حتی بدون اکستنشن هم کار می‌کند:
// کد اتاق از هَش خوانده می‌شود، فرم «ورود کد + رمز» نمایش داده می‌شود،
// اتصال WebSocket مستقیم برقرار شده و پیام‌های play/pause/seek روی
// ویدیویی که کاربر در فیلد «آدرس صفحهٔ انیمه» وارد می‌کند اعمال می‌شود.
// اگر اکستنشن Video Unlocker Pro نصب باشد، double-watch.js این صفحه را
// با پنل زیباتر خودش جایگزین می‌کند (بدون تغییر عملکرد).
function landingHtml() {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>دابل‌واچ — ورود به اتاق</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1a1a2e,#16213e);color:#f8f8f2;font-family:Tahoma,Arial,sans-serif;">
<div style="text-align:center;max-width:460px;width:92%;padding:26px;background:rgba(15,15,35,.92);border:1px solid rgba(255,255,255,.08);border-radius:20px;box-shadow:0 12px 48px rgba(0,0,0,.6);">
<h2 style="margin:6px 0;color:#bd93f9;">🎬👥 دابل‌واچ</h2>
<p id="roomline" style="display:none;color:#8be9fd;font-size:14px;margin:6px 0;">کد اتاق: <b id="roomcode" dir="ltr" style="letter-spacing:3px;"></b></p>
<label style="display:block;text-align:right;font-size:12px;color:#6272a4;margin-top:10px;">کد اتاق:</label>
<input id="code" dir="ltr" maxlength="8" placeholder="مثلاً A3F7KQ" style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.35);color:#f8f8f2;font-size:14px;text-align:center;letter-spacing:2px;text-transform:uppercase;">
<label style="display:block;text-align:right;font-size:12px;color:#6272a4;margin-top:10px;">رمز اتاق (اختیاری):</label>
<input id="pass" type="password" dir="ltr" placeholder="اگر میزبان رمز گذاشته" style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.35);color:#f8f8f2;font-size:14px;">
<label style="display:block;text-align:right;font-size:12px;color:#6272a4;margin-top:10px;">آدرس صفحهٔ انیمه (برای پخش همزمان):</label>
<input id="vurl" dir="ltr" placeholder="https://... (اختیاری)" style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.35);color:#f8f8f2;font-size:12px;word-break:break-all;">
<button id="go" style="width:100%;margin-top:16px;padding:13px;border:none;border-radius:12px;font-size:15px;font-weight:800;cursor:pointer;background:linear-gradient(135deg,#bd93f9,#ff79c6);color:#1a1a2e;">➜ ورود به اتاق</button>
<p id="st" style="font-size:12px;color:#6272a4;margin-top:14px;line-height:2;">آمادهٔ ورود…</p>
<p style="font-size:11px;color:#6272a4;margin-top:10px;line-height:2;">💡 بهترین حالت: اکستنشن <b style="color:#50fa7b;">Video Unlocker Pro</b> را نصب کنید تا کنترل کامل‌تر (پخش/مکث/جستجو) داشته باشید؛ اما این صفحه بدون اکستنشن هم کار می‌کند.</p>
</div>
<script>
(function(){
  var params=new URLSearchParams(location.search);
  var vq=(params.get('v')||'').trim();
  var codeEl=document.getElementById('code'),passEl=document.getElementById('pass'),vEl=document.getElementById('vurl');
  var st=document.getElementById('st'),go=document.getElementById('go');
  var cq=(params.get('c')||params.get('join')||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  var m=location.hash.match(/^#([A-Za-z0-9]{4,8})$/);
  var prefill=/^[A-Z0-9]{4,8}$/.test(cq)?cq:(m?m[1].toUpperCase():'');
  if(prefill){codeEl.value=prefill;document.getElementById('roomline').style.display='block';document.getElementById('roomcode').textContent=prefill;}
  if(vq)vEl.value=vq;
  var ws=null,vid=null,hosted=false,sup=false,timer=null;
  function status(t,c){st.textContent=t;if(c)st.style.color=c;}
  function findVid(){var vs=document.querySelectorAll('video');if(!vs.length)return null;var b=null,bd=-1;for(var i=0;i<vs.length;i++){var r=vs[i].getBoundingClientRect();var d=r.width*r.height;if(d>bd){bd=d;b=vs[i];}}return b;}
  function bindVid(){vid=findVid();if(!vid)return;['play','pause','seeked'].forEach(function(k){vid.addEventListener(k,function(){if(sup||!ws||ws.readyState!==1)return;if(k==='play')ws.send(JSON.stringify({type:'relay',data:{type:'play',t:vid.currentTime}}));else if(k==='pause')ws.send(JSON.stringify({type:'relay',data:{type:'pause',t:vid.currentTime}}));else ws.send(JSON.stringify({type:'relay',data:{type:'seek',t:vid.currentTime}}));});});}
  function apply(d){if(!vid)return;sup=true;setTimeout(function(){sup=false;},1200);
    if(d.type==='state'){try{if(Math.abs(vid.currentTime-(d.currentTime||0))>2)vid.currentTime=d.currentTime;}catch(e){}if(d.playing){vid.play().catch(function(){});}else vid.pause();}
    else if(d.type==='play'){try{vid.currentTime=d.t;}catch(e){}vid.play().catch(function(){});}
    else if(d.type==='pause'){vid.pause();}
    else if(d.type==='seek'){try{vid.currentTime=d.t;}catch(e){}}}
  function connect(code,pwd){
    var u=new URL(location.href);u.protocol=(u.protocol==='https:')?'wss:':'ws:';u.pathname='/sync';u.search='';u.hash='';
    status('⏳ در حال اتصال...','#ffb86c');
    try{ws=new WebSocket(u.toString());}catch(e){status('❌ مرورگر شما از WebSocket پشتیبانی نمی‌کند. اکستنشن را نصب کنید.','#ff5555');return;}
    ws.onopen=function(){hosted=false;ws.send(JSON.stringify({type:'join',code:code,pwd:pwd||''}));};
    ws.onmessage=function(ev){var msg;try{msg=JSON.parse(ev.data);}catch(e){return;}
      if(msg.type==='joined'||msg.type==='paired'){status('✅ متصل به اتاق '+code+' — ویدیو پیدا شد؟',' #50fa7b'.trim());
        if(msg.type==='paired'){bindVid();ws.send(JSON.stringify({type:'relay',data:{type:'request-sync'}}));if(!timer)timer=setInterval(function(){if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:'ping'}));},25000);}}
      else if(msg.type==='error'){status('❌ '+(msg.message||'خطا'),'#ff5555');}
      else if(msg.type==='peer_left'){status('🚪 طرف مقابل خارج شد.','#ffb86c');}
      else if(msg.type==='relay'){if(msg.data&&msg.data.type!=='request-sync')apply(msg.data);}};
    ws.onclose=function(){status('🔌 قطع شد — دوباره «ورود به اتاق» را بزنید.','#ff5555');if(timer){clearInterval(timer);timer=null;}};
  }
  go.onclick=function(){
    var code=(codeEl.value||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    if(code.length<4){status('❌ کد اتاق معتبر نیست (۶ رقمی از میزبان).','#ff5555');return;}
    var vu=(vEl.value||'').trim();
    if(vu&&vu.slice(0,7).toLowerCase()!=='http://'&&vu.slice(0,8).toLowerCase()!=='https://'){status('❌ آدرس ویدیو باید با http شروع شود.','#ff5555');return;}
    if(vu&&new URL(vu).origin!==location.origin){
      try{sessionStorage.setItem('dw_autojoin',JSON.stringify({code:code,pass:passEl.value||'',ts:Date.now()}));}catch(e){}
      location.href=vu;return;}
    go.disabled=true;go.textContent='اتصال...';
    connect(code,passEl.value||'');
    setTimeout(bindVid,1500);setInterval(bindVid,3000);
  };
  if(prefill)status('کد اتاق از لینک پر شد ✓ — دکمهٔ «ورود به اتاق» را بزنید.','#8be9fd');
})();
</script>
</div></body></html>`;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname !== '/sync') {
      // کد اتاق می‌تواند در هش (#CODE — لینک‌های قدیمی) یا پارامتر ?c= باشد
      let code = '';
      const h = (url.hash || '').replace(/^#/, '');
      if (/^[A-Za-z0-9]{4,8}$/.test(h)) code = h.toUpperCase();
      const c = url.searchParams.get('c');
      if (!code && c && /^[A-Za-z0-9]{4,8}$/.test(c)) code = c.toUpperCase();

      const v = url.searchParams.get('v') || '';
      const safeV = /^https?:\/\/[^"'<>\\]+$/i.test(v) ? v.replace(/"/g, '&quot;') : '';

      const html = landingHtml().replace(
        '</body>',
        `<script>(function(){var code=${JSON.stringify(code)};var v=${JSON.stringify(safeV)};` +
        `window.__DW_LANDING__={code:code,v:v};` +
        `try{if(code){sessionStorage.setItem('dw_autojoin',JSON.stringify({code:code,pass:new URLSearchParams(location.search).get('p')||'',ts:Date.now()}));}}catch(e){}` +
        `if(v){setTimeout(function(){location.replace(v);},300);}else{` +
        `var p=document.getElementById('p');if(p&&code)p.textContent='کد اتاق: '+code+' — در تب ویدیو از پنل دابل‌واچ «ورود با کد» را بزنید.';}}})();</script></body>`
      );
      return new Response(html, {
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
        // اگر میزبان کد پیشنهادی فرستاد و آزاد بود، همان را استفاده می‌کنیم
        // تا لینک اشتراک کلاینت (که قبل از پاسخ سرور ساخته شده) معتبر بماند.
        const wanted = String(msg.code || '').toUpperCase().trim();
        let code = (/^[A-Z0-9]{4,8}$/.test(wanted) && !rooms.has(wanted)) ? wanted : randCode();
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
