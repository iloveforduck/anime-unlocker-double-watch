(function createFloatingButton() {
    if (document.getElementById('ext-activate-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'ext-activate-btn';
    btn.innerHTML = '🎮 فعال‌سازی';
    btn.style.cssText = `
        position: fixed;
        top: 20px;
        left: 20px;
        z-index: 9999999;
        padding: 12px 24px;
        background: linear-gradient(135deg, #50fa7b, #69ff94);
        color: #1a1a2e;
        border: none;
        border-radius: 12px;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
        box-shadow: 0 8px 24px rgba(80, 250, 123, 0.4);
        transition: all 0.3s ease;
        font-family: 'Segoe UI', Arial, sans-serif;
    `;

    btn.onmouseover = () => {
        btn.style.transform = 'scale(1.05)';
        btn.style.boxShadow = '0 12px 32px rgba(80, 250, 123, 0.6)';
    };
    btn.onmouseout = () => {
        btn.style.transform = 'scale(1)';
        btn.style.boxShadow = '0 8px 24px rgba(80, 250, 123, 0.4)';
    };

    btn.onclick = () => {
        btn.innerHTML = '⏳ در حال اجرا...';
        btn.style.background = 'linear-gradient(135deg, #8be9fd, #69d2e4)';

        chrome.runtime.sendMessage({ action: 'INJECT_CODE' }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('خطا:', chrome.runtime.lastError);
                btn.innerHTML = '❌ خطا';
                btn.style.background = 'linear-gradient(135deg, #ff5555, #ff6b6b)';
                return;
            }

            if (response && response.success) {
                btn.innerHTML = '✅ فعال شد';
                btn.style.background = 'linear-gradient(135deg, #50fa7b, #69ff94)';

                setTimeout(() => {
                    btn.style.opacity = '0';
                    btn.style.transform = 'scale(0.8)';
                    setTimeout(() => btn.remove(), 300);
                }, 2000);
            } else {
                btn.innerHTML = '❌ ناموفق';
                btn.style.background = 'linear-gradient(135deg, #ff5555, #ff6b6b)';
            }
        });
    };

    document.body.appendChild(btn);
    console.log('🎮 دکمه فعال‌سازی اضافه شد');
})();