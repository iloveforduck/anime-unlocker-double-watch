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