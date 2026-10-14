chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "INJECT_CODE") {
        chrome.scripting.executeScript({
            target: { tabId: sender.tab.id },
            files: ['main.js'],
            world: 'MAIN'
        })
        .then(() => {
            console.log("✅ اسکریپت اصلی اجرا شد");
            sendResponse({ success: true });
        })
        .catch((error) => {
            console.error("❌ خطا:", error);
            sendResponse({ success: false, error: error.message });
        });
        return true;
    }
});

chrome.runtime.onInstalled.addListener(() => {
    console.log("🎮 اکستنشن نصب شد");
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
