/* 🎬 صفحهٔ اتصال دابل‌واچ — ساختهٔ خود اکستنشن (chrome-extension://…/popup.html)
 * کاربر کد اتاق را وارد می‌کند؛ این صفحه:
 *  ۱) آدرس سرور و رمز را ذخیره می‌کند (chrome.storage + localStorage تب‌های سایت)
 *  ۲) از background می‌خواهد آخرین تبِ بازِ سایت را با ?dw=CODE باز/ریفرش کند
 *     تا پلیر همان تب خودکار به اتاق وصل شود.
 * BroadcastChannel بین همهٔ تب‌ها (حتی صفحات سایت) مشترک است، پس همگام‌سازی
 * محلی بدون سرور هم کار می‌کند. */
(() => {
  const $ = (id) => document.getElementById(id);
  const status = (msg, color) => {
    const s = $('status');
    s.textContent = msg;
    s.style.color = color || '#6272a4';
  };

  // ---- بازیابی مقادیر ذخیره‌شده ----
  try {
    chrome.storage.local.get(['dw_server_url'], (r) => {
      if (r && r.dw_server_url && !$('server').value) $('server').value = r.dw_server_url;
    });
  } catch {}
  try { if (!$('server').value) $('server').value = localStorage.getItem('dw_server_url') || ''; } catch {}

  // ---- نرمال‌سازی آدرس سرور (ساب‌دامنه ساده → آدرس کامل workers.dev) ----
  function normalizeServerInput(raw) {
    let v = String(raw || '').trim().replace(/\/+$/, '');
    if (!v) return null;
    v = v.replace(/^wss?:\/\//i, m => (m[1].toLowerCase() === 's' ? 'https://' : 'http://'));
    if (/^https?:\/\//i.test(v)) return v;
    if (/\./.test(v)) return 'https://' + v;
    return 'https://' + v + '.iloveforduck.workers.dev';
  }

  function saveServer(url) {
    try { chrome.storage.local.set({ dw_server_url: url }); } catch {}
    try { localStorage.setItem('dw_server_url', url); } catch {}
  }

  function validCode(c) { return /^[A-Z0-9]{4,8}$/.test(String(c || '').toUpperCase()); }

  // ---- پیدا کردن تب سایت برای باز کردن پلیر ----
  function openPlayerTab(code, pwd) {
    try { if (pwd) chrome.storage.local.set({ ['dw_pass_' + code]: pwd }); } catch {}
    chrome.runtime.sendMessage({ action: 'DW_OPEN_TAB_FROM_POPUP', code, pass: pwd || '' }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        status('⚠️ تب سایتی باز نیست. یک صفحهٔ ویدیو در همین مرورگر باز کن و دوباره «ورود» را بزن.', '#ffb86c');
        return;
      }
      $('codeShow').textContent = code;
      $('codeBox').style.display = 'block';
      status('✅ پلیر در تب سایت باز شد و خودکار وارد اتاق ' + code + ' می‌شود.', '#50fa7b');
    });
  }

  // ---- دکمه ورود مهمان ----
  $('join').onclick = () => {
    const srv = normalizeServerInput($('server').value);
    if (srv) saveServer(srv);
    const code = ($('code').value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!validCode(code)) { status('❌ کد اتاق معتبر نیست (۴ تا ۸ حرف انگلیسی/عدد).', '#ff5555'); return; }
    const pwd = ($('pass').value || '').trim();
    if (pwd) { try { localStorage.setItem('dw_pass_' + code, pwd); } catch {} }
    status('⏳ در حال اتصال...', '#ffb86c');
    openPlayerTab(code, pwd);
  };

  // ---- دکمه میزبان: آدرس سایت را بگیر، لینک بساز، تب جدید با ?dw= باز شود ----
  $('host').onclick = () => {
    const u = $('hosturl');
    u.style.display = u.style.display === 'none' ? 'block' : 'none';
    if (u.style.display === 'block') u.focus();
  };
  $('hosturl').addEventListener('keydown', (e) => { if (e.key === 'Enter') startHost(); });
  $('host').addEventListener('dblclick', startHost);
  function startHost() {
    const srv = normalizeServerInput($('server').value);
    if (srv) saveServer(srv);
    let url = ($('hosturl').value || '').trim();
    if (!/^https?:\/\//i.test(url)) { status('❌ آدرس صفحهٔ ویدیو را کامل (با https://) وارد کنید.', '#ff5555'); return; }
    // ساخت اتاق توسط همان تب سایت: لینک را با پارامتر باز می‌کنیم؛ اکستنشن روی
    // آن صفحه پنل دابل‌واچ را نشان می‌دهد و کاربر «ایجاد لینک» را می‌زند.
    const code = Array.from({ length: 6 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
    try { localStorage.setItem('dw_host_prefill_' + url.split('/')[2], code); } catch {}
    status('📺 تب سایت باز شد — در پنل دابل‌واچ همان تب، گزینهٔ «ایجاد اتاق» را با کد ' + code + ' بزنید.', '#8be9fd');
    chrome.runtime.sendMessage({ action: 'DW_OPEN_TAB', url: url + (/[?&]/.test(url.split('#')[0]) ? '&' : '?') + 'dw=' + code + '&dwrole=host' }, () => {});
  }

  status('آمادهٔ اتصال — کد را وارد کنید.');
})();
