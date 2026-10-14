// ===== content script — ISOLATED world =====
// «دکمهٔ فعال‌سازی» حذف شده است. اکستنشن خودش به‌صورت خودکار:
//   1) main.js را از طریق background در MAIN world تزریق می‌کند
//   2) روی SPA ها (سایت‌هایی که با جاوااسکریپت ویدیو می‌سازند) پلیر را رصد می‌کند
(function autoActivate() {
    if (window.__autoActivateLoaded) return;
    window.__autoActivateLoaded = true;

    // پاکسازی نسخهٔ قدیمی دکمهٔ فعال‌سازی (اگر از قبل در صفحه مانده باشد)
    const oldBtn = document.getElementById('ext-activate-btn');
    if (oldBtn) oldBtn.remove();

    let injected = false;
    function requestInject() {
        if (injected) return;
        injected = true;
        try {
            chrome.runtime.sendMessage({ action: 'AUTO_INJECT' }, () => void chrome.runtime.lastError);
        } catch (e) { injected = false; }
    }

    function hasPlayer() {
        return !!(document.querySelector('video') ||
                  document.querySelector('.video-js') ||
                  document.querySelector('.vjs-tech') ||
                  document.querySelector('.app-video-stage'));
    }

    // اگر همین حالا پلیر هست، فوراً تزریق کن؛ وگرنه صفحات بدون ویدیو دست نخورند
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        if (hasPlayer()) requestInject();
    } else {
        document.addEventListener('DOMContentLoaded', () => { if (hasPlayer()) requestInject(); });
    }

    // رصد SPA: هر وقت تگ <video> اضافه شد، تزریق درخواست شود
    const mo = new MutationObserver(() => {
        if (!injected && hasPlayer()) requestInject();
    });
    function startObserver() { mo.observe(document.documentElement, { childList: true, subtree: true }); }
    if (document.body) startObserver();
    else document.addEventListener('DOMContentLoaded', startObserver);

    console.log('🎮 Video Unlocker Pro: رصد خودکار فعال — بدون دکمه');
})();
