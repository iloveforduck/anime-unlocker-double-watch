(function advancedController() {
    let isActive = false;
    let video = null;
    let originalPause = null;
    let originalPlay = null;
    let controlPanel = null;
    let savedVolume = 1;
    let savedMuted = false;
    let observer = null;
    let checkInterval = null;
    let debounceTimer = null;
    let isModifyingDOM = false;
    let autoUnlock = true;
    let isFullscreenMode = false;
    let isMinimized = false;
    let minimizedBtn = null;
    let hideTimer = null;

    const ICON_URL = document.querySelector('script[src*="icon"]') ?
        document.querySelector('script[src*="icon"]').src : '';

    // ===== تشخیص صفحه پخش =====
    function isVideoPage() {
        return !!(
            document.querySelector('video') ||
            document.querySelector('.video-js') ||
            document.querySelector('.app-video-stage') ||
            document.querySelector('.vjs-tech')
        );
    }

    // ===== تشخیص فول‌اسکرین =====
    function isFullscreen() {
        return !!(document.fullscreenElement || document.webkitFullscreenElement);
    }

    // ===== تشخیص قفل =====
    function isLocked() {
        return !!(
            document.querySelector('.app-video-lock-overlay:not([style*="display: none"])') ||
            document.querySelector('.app-video-stage--locked') ||
            document.querySelector('.video-lock-panel:not([style*="display: none"])') ||
            document.querySelector('.episode-vip-status:not([style*="display: none"])')
        );
    }

    // ===== حذف لایه قفل =====
    function removeLockOverlay() {
        const lockOverlay = document.querySelector('.app-video-lock-overlay');
        if (lockOverlay) lockOverlay.style.display = 'none';

        const stage = document.querySelector('.app-video-stage');
        if (stage) stage.classList.remove('app-video-stage--locked');

        const vipStatus = document.querySelector('.episode-vip-status');
        if (vipStatus) vipStatus.style.display = 'none';

        document.querySelectorAll('.app-video-lock-overlay, .video-lock-panel, .video-lock-key-badge, .episode-vip-status').forEach(el => {
            el.style.display = 'none';
        });

        fixPlayerButtons();
    }

    // ===== فعال‌سازی دکمه‌های پلیر =====
    function fixPlayerButtons() {
        const container = document.querySelector('.video-js');
        if (!container) return;

        ['.vjs-play-control', '.vjs-volume-panel', '.vjs-fullscreen-control', '.vjs-progress-control'].forEach(sel => {
            const el = container.querySelector(sel);
            if (el) {
                el.classList.remove('vjs-disabled');
                el.removeAttribute('disabled');
                el.style.pointerEvents = 'auto';
                el.style.opacity = '1';
            }
        });

        container.classList.remove('vjs-paused', 'vjs-ended');
        if (video && !video.paused) container.classList.add('vjs-playing');
    }

    // ===== Auto-hide در فول‌اسکرین =====
    function showPanel() {
        if (controlPanel && isFullscreenMode && !isMinimized) {
            controlPanel.style.opacity = '0.85';
            controlPanel.style.pointerEvents = 'auto';
        }
        resetHideTimer();
    }

    function hidePanel() {
        if (controlPanel && isFullscreenMode && !isMinimized) {
            controlPanel.style.opacity = '0';
            controlPanel.style.pointerEvents = 'none';
        }
    }

    function resetHideTimer() {
        clearTimeout(hideTimer);
        if (isFullscreenMode && !isMinimized) {
            hideTimer = setTimeout(hidePanel, 3000);
        }
    }

    // ===== Snap به گوشه‌ها =====
    function snapToCorner(element) {
        const rect = element.getBoundingClientRect();
        const margin = 15;
        const threshold = 80;

        const containerRect = isFullscreenMode
            ? (document.querySelector('.video-js') || document.querySelector('.app-video-stage'))?.getBoundingClientRect()
            : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };

        if (!containerRect) return;

        const nearLeft = (rect.left - containerRect.left) < threshold;
        const nearRight = (containerRect.right - rect.right) < threshold;
        const nearTop = (rect.top - containerRect.top) < threshold;
        const nearBottom = (containerRect.bottom - rect.bottom) < threshold;

        if (nearLeft) { element.style.left = margin + 'px'; element.style.right = 'auto'; }
        else if (nearRight) { element.style.left = 'auto'; element.style.right = margin + 'px'; }

        if (nearTop) { element.style.top = margin + 'px'; element.style.bottom = 'auto'; }
        else if (nearBottom) { element.style.top = 'auto'; element.style.bottom = margin + 'px'; }
    }

    // ===== تنظیم حالت فول‌اسکرین =====
    function handleFullscreenChange() {
        if (!controlPanel) return;

        const playerContainer = document.querySelector('.video-js') || document.querySelector('.app-video-stage');

        if (isFullscreen()) {
            isFullscreenMode = true;
            if (playerContainer && controlPanel.parentElement !== playerContainer && !isMinimized) {
                playerContainer.appendChild(controlPanel);
            }
            controlPanel.style.position = 'absolute';
            controlPanel.style.bottom = '60px';
            controlPanel.style.right = '15px';
            controlPanel.style.top = 'auto';
            controlPanel.style.left = 'auto';
            controlPanel.style.minWidth = '180px';
            controlPanel.style.padding = '12px 16px';
            controlPanel.style.fontSize = '11px';
            controlPanel.style.borderRadius = '12px';
            controlPanel.style.zIndex = '2147483647';
            controlPanel.style.opacity = '0.85';
            controlPanel.style.transform = 'scale(0.9)';
            controlPanel.style.transformOrigin = 'bottom right';
            controlPanel.style.transition = 'opacity 0.3s ease';
            resetHideTimer();
        } else {
            isFullscreenMode = false;
            if (controlPanel.parentElement !== document.body && !isMinimized) {
                document.body.appendChild(controlPanel);
            }
            controlPanel.style.position = 'fixed';
            controlPanel.style.bottom = '100px';
            controlPanel.style.right = '20px';
            controlPanel.style.top = 'auto';
            controlPanel.style.left = 'auto';
            controlPanel.style.minWidth = '220px';
            controlPanel.style.padding = '20px 24px';
            controlPanel.style.fontSize = '13px';
            controlPanel.style.borderRadius = '16px';
            controlPanel.style.zIndex = '999999';
            controlPanel.style.opacity = '1';
            controlPanel.style.transform = 'scale(1)';
            controlPanel.style.transformOrigin = 'bottom right';
            controlPanel.style.pointerEvents = 'auto';
            clearTimeout(hideTimer);
        }
    }

    // ===== مینیمایز کردن =====
    function minimizePanel() {
        isMinimized = true;
        if (controlPanel) controlPanel.style.display = 'none';

        const parentContainer = isFullscreenMode
            ? (document.querySelector('.video-js') || document.querySelector('.app-video-stage') || document.body)
            : document.body;

        minimizedBtn = document.createElement('div');
        minimizedBtn.id = 'minimized-control-btn';
        minimizedBtn.style.cssText = `
            position: ${isFullscreenMode ? 'absolute' : 'fixed'};
            bottom: ${isFullscreenMode ? '60px' : '100px'};
            right: 20px;
            z-index: ${isFullscreenMode ? '2147483647' : '999999'};
            width: 50px;
            height: 50px;
            border-radius: 50%;
            background: rgba(15, 15, 35, 0.95);
            backdrop-filter: blur(16px);
            border: 2px solid rgba(80, 250, 123, 0.4);
            cursor: pointer;
            box-shadow: 0 8px 24px rgba(0,0,0,0.5), 0 0 20px rgba(80, 250, 123, 0.2);
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            padding: 6px;
        `;

        const icon = document.createElement('img');
        icon.src = chrome.runtime ? chrome.runtime.getURL('icon.svg') : 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="80" font-size="80">🎮</text></svg>');
        icon.style.cssText = `width:100%;height:100%;object-fit:contain;pointer-events:none;`;
        minimizedBtn.appendChild(icon);

        minimizedBtn.onmouseover = () => {
            minimizedBtn.style.transform = 'scale(1.1)';
            minimizedBtn.style.boxShadow = '0 8px 32px rgba(80,250,123,0.4), 0 0 30px rgba(80,250,123,0.3)';
            minimizedBtn.style.borderColor = 'rgba(80,250,123,0.8)';
        };
        minimizedBtn.onmouseout = () => {
            minimizedBtn.style.transform = 'scale(1)';
            minimizedBtn.style.boxShadow = '0 8px 24px rgba(0,0,0,0.5), 0 0 20px rgba(80,250,123,0.2)';
            minimizedBtn.style.borderColor = 'rgba(80,250,123,0.4)';
        };

        minimizedBtn.addEventListener('click', () => restorePanel());

        parentContainer.appendChild(minimizedBtn);
        makeDraggable(minimizedBtn, minimizedBtn, true);
        setTimeout(() => snapToCorner(minimizedBtn), 100);
    }

    // ===== بازگرداندن پنل =====
    function restorePanel() {
        isMinimized = false;
        if (minimizedBtn) { minimizedBtn.remove(); minimizedBtn = null; }
        if (controlPanel) {
            controlPanel.style.display = 'block';
            if (isFullscreenMode) {
                const pc = document.querySelector('.video-js') || document.querySelector('.app-video-stage');
                if (pc && controlPanel.parentElement !== pc) pc.appendChild(controlPanel);
            } else {
                if (controlPanel.parentElement !== document.body) document.body.appendChild(controlPanel);
            }
        }
        resetHideTimer();
    }

    // ===== فعال‌سازی =====
    function activate() {
        if (isActive) return;

        const currentVideo = document.querySelector('video');
        if (!currentVideo) {
            console.warn('⚠️ ویدیو پیدا نشد');
            return;
        }

        video = currentVideo;
        removeLockOverlay();

        savedVolume = video.volume;
        savedMuted = video.muted;

        originalPause = video.pause.bind(video);
        originalPlay = video.play.bind(video);

        video.pause = function () {
            const container = this.closest('.video-js');
            if (container) {
                container.classList.remove('vjs-paused');
                container.classList.add('vjs-playing');
            }
            fixPlayerButtons();
            return Promise.resolve();
        };

        video.play = function () {
            removeLockOverlay();
            this.muted = savedMuted;
            this.volume = savedVolume;
            const result = originalPlay();
            const container = this.closest('.video-js');
            if (container) {
                container.classList.remove('vjs-paused', 'vjs-ended');
                container.classList.add('vjs-playing');
            }
            fixPlayerButtons();
            return result;
        };

        video.play().catch(() => {
            video.play().catch(() => {});
        });

        isActive = true;
        updateUI();
        console.log('✅ Override فعال شد | قفل حذف شد');
    }

    // ===== غیرفعال‌سازی =====
    function deactivate() {
        if (!isActive) return;

        const currentVideo = document.querySelector('video');
        if (currentVideo && originalPause && originalPlay) {
            currentVideo.pause = originalPause;
            currentVideo.play = originalPlay;
            currentVideo.pause();
        }

        isActive = false;
        updateUI();
        console.log('⏹️ Override غیرفعال شد');
    }

    // ===== ریست برای ویدیوی جدید =====
    function resetForNewVideo() {
        console.log('🔄 ریست برای ویدیوی جدید');
        isActive = false;
        originalPause = null;
        originalPlay = null;
        video = null;
        updateUI();
    }

    // ===== ساخت پنل کنترل =====
    function createControlPanel() {
        const oldPanel = document.getElementById('advanced-control-panel');
        if (oldPanel) oldPanel.remove();

        controlPanel = document.createElement('div');
        controlPanel.id = 'advanced-control-panel';
        controlPanel.style.cssText = `
            position: fixed;
            bottom: 100px;
            right: 20px;
            z-index: 999999;
            background: rgba(15, 15, 35, 0.92);
            backdrop-filter: blur(16px);
            border-radius: 16px;
            padding: 20px 24px;
            color: white;
            font-family: 'Segoe UI', Arial, sans-serif;
            font-size: 13px;
            box-shadow: 0 12px 48px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06);
            min-width: 220px;
            user-select: none;
            transition: all 0.3s ease;
            border: 1px solid rgba(255,255,255,0.08);
        `;

        const header = document.createElement('div');
        header.style.cssText = `display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;cursor:grab;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.06);`;
        header.id = 'panel-header';

        const title = document.createElement('span');
        title.style.cssText = `font-weight:700;font-size:14px;color:#8be9fd;display:flex;align-items:center;gap:8px;`;
        title.innerHTML = '🎮 کنترل پلیر';
        header.appendChild(title);

        const minimizeBtn = document.createElement('button');
        minimizeBtn.innerHTML = '—';
        minimizeBtn.title = 'مینیمایز';
        minimizeBtn.style.cssText = `background:none;border:none;color:#6272a4;font-size:20px;cursor:pointer;padding:0 4px;transition:color 0.2s;line-height:1;`;
        minimizeBtn.onmouseover = () => minimizeBtn.style.color = '#ffd93d';
        minimizeBtn.onmouseout = () => minimizeBtn.style.color = '#6272a4';
        minimizeBtn.onclick = () => minimizePanel();
        header.appendChild(minimizeBtn);
        controlPanel.appendChild(header);

        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'adv-toggle-btn';
        toggleBtn.style.cssText = `width:100%;padding:12px 0;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;transition:all 0.25s ease;margin-bottom:14px;color:white;`;
        controlPanel.appendChild(toggleBtn);

        const btnRow = document.createElement('div');
        btnRow.style.cssText = `display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:14px;`;

        [{ id: 'adv-play-btn', icon: '▶', label: 'پخش', color: '#50fa7b' },
         { id: 'adv-reset-btn', icon: '🔄', label: 'ریست', color: '#6272a4' }].forEach(btn => {
            const el = document.createElement('button');
            el.id = btn.id;
            el.innerHTML = `${btn.icon} ${btn.label}`;
            el.style.cssText = `padding:8px 0;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;background:rgba(255,255,255,0.06);color:white;transition:all 0.2s ease;`;
            el.onmouseover = () => { el.style.background = btn.color; el.style.color = '#1a1a2e'; };
            el.onmouseout = () => { el.style.background = 'rgba(255,255,255,0.06)'; el.style.color = 'white'; };
            btnRow.appendChild(el);
        });
        controlPanel.appendChild(btnRow);

        const volumeContainer = document.createElement('div');
        volumeContainer.style.cssText = `margin-bottom:14px;padding:10px 12px;background:rgba(255,255,255,0.04);border-radius:10px;`;

        const volumeHeader = document.createElement('div');
        volumeHeader.style.cssText = `display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;`;

        const volumeLabel = document.createElement('span');
        volumeLabel.style.cssText = `font-size:12px;color:#6272a4;font-weight:600;`;
        volumeLabel.textContent = '🔊 صدا';
        volumeHeader.appendChild(volumeLabel);

        const volumeValue = document.createElement('span');
        volumeValue.id = 'adv-volume-value';
        volumeValue.style.cssText = `font-size:12px;color:#8be9fd;font-weight:700;`;
        volumeValue.textContent = '100%';
        volumeHeader.appendChild(volumeValue);
        volumeContainer.appendChild(volumeHeader);

        const volumeSlider = document.createElement('input');
        volumeSlider.id = 'adv-volume-slider';
        volumeSlider.type = 'range';
        volumeSlider.min = '0';
        volumeSlider.max = '100';
        volumeSlider.value = '100';
        volumeSlider.style.cssText = `width:100%;height:4px;-webkit-appearance:none;appearance:none;background:linear-gradient(to right,#50fa7b 100%,#44475a 100%);border-radius:4px;outline:none;cursor:pointer;`;

        const styleTag = document.createElement('style');
        styleTag.textContent = `
            #adv-volume-slider::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#50fa7b;cursor:pointer;box-shadow:0 0 12px rgba(80,250,123,0.4);transition:all 0.2s;}
            #adv-volume-slider::-webkit-slider-thumb:hover{transform:scale(1.15);box-shadow:0 0 20px rgba(80,250,123,0.6);}
            #adv-volume-slider::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:#50fa7b;cursor:pointer;border:none;}
        `;
        document.head.appendChild(styleTag);

        volumeSlider.oninput = function () {
            const val = parseInt(this.value);
            volumeValue.textContent = val + '%';
            this.style.background = `linear-gradient(to right,#50fa7b ${val}%,#44475a ${val}%)`;
            if (video) {
                video.volume = val / 100;
                savedVolume = val / 100;
                video.muted = false;
                savedMuted = false;
            }
        };

        volumeContainer.appendChild(volumeSlider);
        controlPanel.appendChild(volumeContainer);

        const autoUnlockContainer = document.createElement('div');
        autoUnlockContainer.style.cssText = `display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding:10px 12px;background:rgba(255,255,255,0.04);border-radius:10px;`;

        const autoUnlockLabel = document.createElement('span');
        autoUnlockLabel.style.cssText = `font-size:12px;color:#6272a4;font-weight:600;`;
        autoUnlockLabel.textContent = '🔓 باز کردن خودکار قفل';
        autoUnlockContainer.appendChild(autoUnlockLabel);

        const switchWrapper = document.createElement('label');
        switchWrapper.style.cssText = `position:relative;display:inline-block;width:40px;height:20px;cursor:pointer;`;

        const switchInput = document.createElement('input');
        switchInput.type = 'checkbox';
        switchInput.checked = autoUnlock;
        switchInput.style.cssText = `opacity:0;width:0;height:0;`;

        const switchSlider = document.createElement('span');
        switchSlider.style.cssText = `position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background-color:#44475a;transition:0.3s;border-radius:20px;`;

        const switchDot = document.createElement('span');
        switchDot.style.cssText = `position:absolute;height:14px;width:14px;left:3px;bottom:3px;background-color:white;transition:0.3s;border-radius:50%;`;

        switchSlider.appendChild(switchDot);
        switchWrapper.appendChild(switchInput);
        switchWrapper.appendChild(switchSlider);
        autoUnlockContainer.appendChild(switchWrapper);
        controlPanel.appendChild(autoUnlockContainer);

        switchInput.onchange = function () {
            autoUnlock = this.checked;
            if (autoUnlock) {
                switchSlider.style.backgroundColor = '#50fa7b';
                switchDot.style.transform = 'translateX(20px)';
                removeLockOverlay();
            } else {
                switchSlider.style.backgroundColor = '#44475a';
                switchDot.style.transform = 'translateX(0)';
            }
        };

        if (autoUnlock) {
            switchSlider.style.backgroundColor = '#50fa7b';
            switchDot.style.transform = 'translateX(20px)';
        }

        const status = document.createElement('div');
        status.id = 'adv-status';
        status.style.cssText = `text-align:center;font-size:11px;color:#6272a4;padding:6px;border-radius:6px;background:rgba(255,255,255,0.03);font-weight:500;`;
        status.textContent = '⏹ وضعیت: غیرفعال';
        controlPanel.appendChild(status);

        document.body.appendChild(controlPanel);

        toggleBtn.onclick = () => isActive ? deactivate() : activate();

        document.getElementById('adv-play-btn').onclick = () => {
            if (!isActive) activate();
            if (video) {
                video.muted = savedMuted;
                video.volume = savedVolume;
                video.play().catch(() => {});
                fixPlayerButtons();
            }
        };

        document.getElementById('adv-reset-btn').onclick = () => {
            deactivate();
            setTimeout(() => {
                activate();
                if (video) {
                    video.currentTime = 0;
                    video.play().catch(() => {});
                }
            }, 200);
        };

        makeDraggable(controlPanel, header, false);
        updateUI();
    }

    // ===== بروزرسانی UI =====
    function updateUI() {
        const toggleBtn = document.getElementById('adv-toggle-btn');
        const status = document.getElementById('adv-status');
        const panel = document.getElementById('advanced-control-panel');

        if (toggleBtn) {
            toggleBtn.textContent = '⏸ مکث';
            if (isActive) {
                toggleBtn.style.background = 'linear-gradient(135deg,#ff5555,#ff6b6b)';
                toggleBtn.style.color = 'white';
            } else {
                toggleBtn.style.background = 'linear-gradient(135deg,#50fa7b,#69ff94)';
                toggleBtn.style.color = '#1a1a2e';
            }
        }

        if (status) {
            status.textContent = isActive ? '✅ فعال | قفل حذف شد' : '⏹ غیرفعال';
            status.style.color = isActive ? '#50fa7b' : '#ff5555';
        }

        if (panel) {
            panel.style.borderColor = isActive ? 'rgba(80,250,123,0.3)' : 'rgba(255,255,255,0.06)';
        }
    }

    // ===== قابلیت کشیدن =====
    function makeDraggable(element, handle, isMinimizedElement) {
        let isDragging = false;
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        const dragHandle = handle || element;
        dragHandle.style.cursor = 'grab';

        const onMouseDown = (e) => {
            if (e.target.closest('button') && !isMinimizedElement) return;
            isDragging = true;
            pos3 = e.clientX;
            pos4 = e.clientY;
            dragHandle.style.cursor = 'grabbing';
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            e.preventDefault();
        };

        const onMouseMove = (e) => {
            if (!isDragging) return;
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            element.style.top = (element.offsetTop - pos2) + 'px';
            element.style.left = (element.offsetLeft - pos1) + 'px';
            element.style.right = 'auto';
            element.style.bottom = 'auto';
            if (isFullscreenMode) showPanel();
        };

        const onMouseUp = () => {
            isDragging = false;
            dragHandle.style.cursor = 'grab';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            snapToCorner(element);
            if (isFullscreenMode) resetHideTimer();
        };

        dragHandle.addEventListener('mousedown', onMouseDown);

        dragHandle.addEventListener('touchstart', (e) => {
            if (e.target.closest('button') && !isMinimizedElement) return;
            const touch = e.touches[0];
            isDragging = true;
            pos3 = touch.clientX;
            pos4 = touch.clientY;
            document.addEventListener('touchmove', onTouchMove);
            document.addEventListener('touchend', onTouchEnd);
            e.preventDefault();
        });

        const onTouchMove = (e) => {
            if (!isDragging) return;
            const touch = e.touches[0];
            pos1 = pos3 - touch.clientX;
            pos2 = pos4 - touch.clientY;
            pos3 = touch.clientX;
            pos4 = touch.clientY;
            element.style.top = (element.offsetTop - pos2) + 'px';
            element.style.left = (element.offsetLeft - pos1) + 'px';
            element.style.right = 'auto';
            element.style.bottom = 'auto';
            if (isFullscreenMode) showPanel();
        };

        const onTouchEnd = () => {
            isDragging = false;
            document.removeEventListener('touchmove', onTouchMove);
            document.removeEventListener('touchend', onTouchEnd);
            snapToCorner(element);
            if (isFullscreenMode) resetHideTimer();
        };
    }

    // ===== کلیدهای میانبر =====
    document.addEventListener('keydown', function (e) {
        if (e.ctrlKey && e.shiftKey && e.key === 'O') {
            e.preventDefault();
            isActive ? deactivate() : activate();
        }
        if (e.ctrlKey && e.shiftKey && e.key === 'R') {
            e.preventDefault();
            deactivate();
            setTimeout(activate, 200);
        }
        if (e.ctrlKey && e.shiftKey && e.key === 'L') {
            e.preventDefault();
            removeLockOverlay();
        }
    });

    // ===== گوش دادن به فول‌اسکرین =====
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

    // ===== گوش دادن به حرکت موس =====
    document.addEventListener('mousemove', () => {
        if (isFullscreenMode && !isMinimized) showPanel();
    });

    // ===== تابع اصلی نظارت =====
    function checkAndInitialize() {
        if (isModifyingDOM) return;

        const currentVideo = document.querySelector('video');
        const isPageVideo = isVideoPage();

        if (isPageVideo && currentVideo) {
            if (video !== currentVideo) {
                console.log('🎬 ویدیوی جدید شناسایی شد');
                resetForNewVideo();
            }

            if (!document.getElementById('advanced-control-panel') && !document.getElementById('minimized-control-btn')) {
                isModifyingDOM = true;
                removeLockOverlay();
                createControlPanel();
                isModifyingDOM = false;
            }

            if (autoUnlock && isLocked()) {
                removeLockOverlay();
            }

            fixPlayerButtons();
            handleFullscreenChange();
        } else {
            const panel = document.getElementById('advanced-control-panel');
            const minBtn = document.getElementById('minimized-control-btn');
            if (panel || minBtn) {
                isModifyingDOM = true;
                if (panel) panel.remove();
                if (minBtn) minBtn.remove();
                isModifyingDOM = false;
                resetForNewVideo();
            }
        }
    }

    // ===== شروع نظارت =====
    function startMonitoring() {
        checkAndInitialize();
        checkInterval = setInterval(checkAndInitialize, 3000);

        observer = new MutationObserver(() => {
            if (isModifyingDOM) return;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => checkAndInitialize(), 500);
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    startMonitoring();

    console.log('✅ اسکریپت هوشمند فعال شد');
    console.log('📌 کلیدهای میانبر:');
    console.log('   Ctrl+Shift+O : فعال/غیرفعال');
    console.log('   Ctrl+Shift+R : ریست');
    console.log('   Ctrl+Shift+L : حذف قفل');
})();