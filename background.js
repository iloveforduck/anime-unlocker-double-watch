// ===== تزریق خودکار main.js در MAIN world =====
// از این پس «دکمهٔ فعال‌سازی» وجود ندارد؛ اکستنشن خودش روی هر صفحه‌ای که
// ویدیو دارد، main.js را به‌صورت خودکار تزریق می‌کند.
async function injectMain(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['main.js'],
            world: 'MAIN'
        });
        console.log("✅ اسکریپت اصلی (خودکار) اجرا شد — تب", tabId);
    } catch (e) {
        // صفحات special مثل chrome:// ، وب‌استور و... مجاز به تزریق نیستند
    }
}

function hasVideoMarker(srcs) {
    return !!(srcs && srcs.some(s => /(^|\s)(video|\.video-js|\.vjs-tech|\.app-video-stage)(\s|$)/.test(s)));
}

// هنگام باز/بارگذاری شدن تب: اگر ویدیو داشت، فوراً تزریق کن
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;
    if (!/^https?:/.test(tab.url || '')) return;
    if (hasVideoMarker(tab.scripts)) injectMain(tabId);
});

// پشتیبان: content script (double-watch.js) وقتی پلیر پیدا می‌کند، درخواست تزریق می‌دهد
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "AUTO_INJECT" && sender.tab && sender.tab.id != null) {
        injectMain(sender.tab.id);
        sendResponse({ ok: true });
        return;
    }
    // سازگاری با نسخه‌های قدیمی (پیام INJECT_CODE دیگر فرستاده نمی‌شود)
    if (request.action === "INJECT_CODE") {
        injectMain(sender.tab.id).then(() => sendResponse({ success: true }));
        return true;
    }
});

chrome.runtime.onInstalled.addListener(() => {
    console.log("🎮 اکستنشن نصب شد — فعال‌سازی خودکار روشن است (بدون دکمه)");
});
// ===== دابل‌واچ: باز کردن تب جدا برای صفحهٔ ویدیو (درخواست از double-watch.js) =====
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'DW_OPEN_TAB') {
        let url = '';
        try { url = String(request.url || ''); } catch (e) {}
        if (!/^https?:\/\//i.test(url)) { sendResponse({ ok: false }); return; }
        chrome.tabs.create({ url, active: true }, (tab) => {
            sendResponse({ ok: !chrome.runtime.lastError, tabId: tab && tab.id });
        });
        return true; // پاسخ ناهمگام
    }
});
