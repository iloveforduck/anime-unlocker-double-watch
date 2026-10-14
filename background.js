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
// تب جدید توسط خود اکستنشن ساخته می‌شود؛ کد اتاق همراه لینک است تا ورود
// خودکار انجام شود. اگر سرور همگام‌سازی تنظیم نشده باشد، به‌جای باز کردن
// همان صفحهٔ سایت، یک «صفحهٔ اتصال» داخلی (popup.html) با فرم کد باز می‌شود.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'DW_OPEN_TAB') {
        let url = '';
        try { url = String(request.url || ''); } catch (e) {}
        if (!/^https?:\/\//i.test(url)) { sendResponse({ ok: false }); return; }
        const code = /^[A-Z0-9]{4,8}$/.test(String(request.code || '')) ? String(request.code).toUpperCase() : '';
        if (code) url += (/[\?&]/.test(url.split('#')[0]) ? '&' : '?') + 'dw=' + code;
        chrome.tabs.create({ url, active: true }, (tab) => {
            sendResponse({ ok: !chrome.runtime.lastError, tabId: tab && tab.id });
        });
        return true; // پاسخ ناهمگام
    }
    // از «صفحهٔ اتصال» اکستنشن: یک تب سایتِ باز را با ?dw=CODE ریلود کن تا
    // پلیر خودکار وارد اتاق شود؛ اگر نبود، آخرین تب http را در همان سایت باز کن.
    if (request.action === 'DW_OPEN_TAB_FROM_POPUP') {
        const code = /^[A-Z0-9]{4,8}$/.test(String(request.code || '')) ? String(request.code).toUpperCase() : '';
        if (!code) { sendResponse({ ok: false }); return; }
        try { chrome.storage.local.set({ ['dw_pass_' + code]: String(request.pass || '') }); } catch {}
        chrome.tabs.query({ url: 'http://*/*' }, (httpTabs) => {
            chrome.tabs.query({ url: 'https://*/*' }, (httpsTabs) => {
                const tabs = [].concat(httpTabs || [], httpsTabs || [])
                    .filter(t => t.url && !t.url.startsWith(chrome.runtime.getURL('')));
                // ترجیح: تبی که همین الان فعال است، وگرنه تازه‌ترین تب سایت
                const target = tabs.find(t => t.active) || tabs[tabs.length - 1];
                if (!target) { sendResponse({ ok: false }); return; }
                let u = target.url.split('?')[0].split('#')[0];
                u += '?dw=' + code;
                chrome.tabs.update(target.id, { url: u, active: true }, () => {
                    sendResponse({ ok: !chrome.runtime.lastError, tabId: target.id });
                });
            });
        });
        return true;
    }
    if (request.action === 'DW_OPEN_CONNECT_PAGE') {
        // پلیر خود اکستنشن در تب جدید — با کد اتاق و آدرس ویدیو (در صورت وجود)
        let url = chrome.runtime.getURL('player.html');
        const code = /^[A-Z0-9]{4,8}$/.test(String(request.code || '')) ? String(request.code).toUpperCase() : '';
        const hashParts = [];
        if (code) hashParts.push('join=' + code);
        if (request.src && /^https?:\/\//i.test(request.src)) {
            try { chrome.storage.local.set({ ['dw_src_' + code]: request.src }); } catch {}
            hashParts.push('src=' + encodeURIComponent(request.src));
        }
        if (hashParts.length) url += '#' + hashParts.join('&');
        chrome.tabs.create({ url, active: true }, (tab) => {
            sendResponse({ ok: !chrome.runtime.lastError, tabId: tab && tab.id });
        });
        return true;
    }
    // هم‌تابیِ همان مرورگر: src ویدیوی سایت را به پلیر بازِ اکستنشن بفرست
    if (request.action === 'DW_PUSH_SRC_TO_PLAYER') {
        const src = String(request.src || '');
        if (!/^https?:\/\//i.test(src)) { sendResponse({ ok: false }); return; }
        chrome.tabs.query({ url: chrome.runtime.getURL('player.html') + '*' }, (tabs) => {
            let sent = false;
            for (const t of tabs || []) {
                try { chrome.tabs.sendMessage(t.id, { action: 'DW_SET_SRC', src }, () => { void chrome.runtime.lastError; }); sent = true; } catch {}
            }
            sendResponse({ ok: sent, count: (tabs || []).length });
        });
        return true;
    }
});
