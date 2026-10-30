/**
 * RBQ-Draw-Plugins Sub-Plugin: 图片隐私模式 (Image Privacy Mode)
 * Version: 1.0.12
 * Author: TTWP-09
 * Description: 支持纯净画廊（正文零插图）、折叠收起、剧透毛玻璃遮罩等多种展示形态，在阅读小说或公共场合优雅隐藏图片与视频，智能继承保留分镜描述并支持大图画廊与伴生一键重绘。安装后在通用设置中切换。
 */
(function(RBQ, $, toastr) {
    'use strict';
    if (!RBQ) return console.error('[Image Privacy Mode] RBQ Core API missing');

    const PLUGIN_ID = 'rbq-image-privacy';
    if (typeof window.__rbqPrivacyCleanup === 'function') {
        try {
            window.__rbqPrivacyCleanup();
        } catch (e) {
            console.warn('[Image Privacy Mode] Previous cleanup error:', e);
        }
    }

    const PLUGIN_NAME = '图片隐私模式';
    const STORAGE_KEY = 'rbq_image_privacy_mode';
    const STYLE_ID = 'rbq-image-privacy-styles';
    const SETTING_CONTAINER_ID = 'rbq-image-privacy-setting';

    const MODE_NAMES = {
        normal: '🖼️ 标准直出',
        gallery: '🕶️ 纯净画廊',
        collapse: '🙈 折叠模式',
        spoiler: '🌫️ 剧透遮罩',
    };

    // ── 1. 设置存取 ──
    function getStoredMode() {
        try {
            const s = RBQ.api?.getSettings?.();
            if (s && s._imagePrivacyMode) return s._imagePrivacyMode;
        } catch (_e) {}
        try {
            return localStorage.getItem(STORAGE_KEY) || 'normal';
        } catch (_e) {
            return 'normal';
        }
    }

    function setStoredMode(val) {
        try {
            const s = RBQ.api?.getSettings?.();
            if (s) {
                s._imagePrivacyMode = val;
                RBQ.api?.saveSettings?.();
            }
        } catch (_e) {}
        try {
            localStorage.setItem(STORAGE_KEY, val);
        } catch (_e) {}
    }

    // ── 2. 注入动态样式 ──
    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            /* 隐私模式通用与操作栏 */
            .rbq-privacy-hidden-btn {
                display: none !important;
            }
            .rbq-privacy-hidden-image {
                display: none !important;
            }
            .rbq-privacy-bar {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                vertical-align: middle;
                max-width: 100%;
                box-sizing: border-box;
                flex-wrap: nowrap;
            }
            .rbq-privacy-bar .rbq-privacy-view-btn,
            .rbq-privacy-bar .rbq-privacy-collapse-toggle {
                flex: 0 1 auto;
                min-width: 0 !important;
                max-width: 100% !important;
                overflow: hidden !important;
                white-space: nowrap !important;
                box-sizing: border-box !important;
                justify-content: flex-start !important;
                text-align: left !important;
                padding: 6px 14px !important;
            }
            .rbq-privacy-bar .rbq-privacy-label-text,
            .rbq-privacy-bar .rbq-privacy-collapse-toggle > span,
            .rbq-privacy-bar .rbq-privacy-view-btn > span {
                display: block !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;
                white-space: nowrap !important;
                min-width: 0 !important;
                max-width: 100% !important;
                pointer-events: none;
            }
            .rbq-privacy-bar .st-scene-trigger-inline-button {
                min-height: 34px;
                padding: 6px 14px;
                box-sizing: border-box;
            }
            .rbq-privacy-regen-btn {
                flex: 0 0 34px !important;
                flex-shrink: 0 !important;
                min-width: 34px !important;
                width: 34px !important;
                height: 34px !important;
                padding: 0 !important;
                box-sizing: border-box !important;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                border-radius: 10px !important;
                background: var(--linear-bg-subtle, rgba(255, 255, 255, 0.08)) !important;
                border: 1px solid var(--linear-border-standard, rgba(255, 255, 255, 0.15)) !important;
                color: var(--linear-text-secondary, rgba(255, 255, 255, 0.75)) !important;
                cursor: pointer !important;
                transition: all 0.2s ease !important;
            }
            .rbq-privacy-regen-btn:hover {
                background: var(--linear-bg-card-hover, rgba(255, 255, 255, 0.16)) !important;
                color: var(--linear-text-primary, #ffffff) !important;
                border-color: var(--linear-border-strong, rgba(255, 255, 255, 0.3)) !important;
            }
            .rbq-privacy-regen-btn:hover i {
                transform: rotate(90deg);
                transition: transform 0.3s ease;
            }
            @media (max-width: 768px) {
                .rbq-privacy-bar {
                    max-width: 100%;
                }
                .rbq-privacy-bar .st-scene-trigger-inline-button {
                    min-height: 36px;
                    touch-action: manipulation;
                }
                .rbq-privacy-regen-btn {
                    flex: 0 0 36px !important;
                    min-width: 36px !important;
                    width: 36px !important;
                    height: 36px !important;
                    touch-action: manipulation;
                }
            }
            .st-scene-trigger-inline-wrap.is-generating .rbq-privacy-bar,
            .st-scene-trigger-inline-wrap[data-rbq-sdt-stage="generating-image"] .rbq-privacy-bar,
            .st-scene-trigger-inline-wrap[data-rbq-sdt-stage="parsing"] .rbq-privacy-bar,
            .st-scene-trigger-inline-ui:has(.st-scene-trigger-inline-loader[style*="flex"]) .rbq-privacy-bar {
                display: none !important;
            }

            /* 折叠动画 */
            .st-scene-trigger-inline-result {
                overflow: hidden;
                max-height: 2400px;
                opacity: 1;
                transition: max-height 0.38s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.28s ease, margin 0.35s ease;
            }
            .st-scene-trigger-inline-result.rbq-privacy-collapsed {
                max-height: 0 !important;
                opacity: 0 !important;
                margin-top: 0 !important;
                margin-bottom: 0 !important;
                padding-top: 0 !important;
                padding-bottom: 0 !important;
                pointer-events: none !important;
            }

            /* 剧透毛玻璃遮罩 */
            .rbq-privacy-spoiler-wrap {
                position: relative;
                display: block;
                width: 100%;
                border-radius: 14px;
                overflow: hidden;
            }
            .rbq-privacy-spoiler-mask {
                position: absolute;
                inset: 0;
                z-index: 15;
                display: flex;
                align-items: center;
                justify-content: center;
                backdrop-filter: blur(24px) saturate(150%);
                -webkit-backdrop-filter: blur(24px) saturate(150%);
                background: rgba(10, 14, 24, 0.72);
                cursor: pointer;
                transition: opacity 0.32s cubic-bezier(0.4, 0, 0.2, 1), backdrop-filter 0.32s ease;
                user-select: none;
            }
            .rbq-privacy-spoiler-badge {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                padding: 10px 18px;
                background: rgba(255, 255, 255, 0.12);
                border: 1px solid rgba(255, 255, 255, 0.22);
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.38);
                border-radius: 9999px;
                color: #ffffff;
                font-size: 13px;
                font-weight: 600;
                letter-spacing: 0.02em;
                transition: transform 0.2s ease, background 0.2s ease;
            }
            .rbq-privacy-spoiler-mask:hover .rbq-privacy-spoiler-badge {
                transform: scale(1.04);
                background: rgba(255, 255, 255, 0.18);
                border-color: rgba(255, 255, 255, 0.35);
            }
            .rbq-privacy-spoiler-wrap.is-revealed .rbq-privacy-spoiler-mask {
                opacity: 0;
                pointer-events: none;
            }
            .rbq-privacy-spoiler-rehide-btn {
                position: absolute;
                top: 10px;
                right: 10px;
                z-index: 20;
                display: none;
                align-items: center;
                gap: 6px;
                padding: 5px 12px;
                font-size: 11px;
                font-weight: 600;
                border-radius: 8px;
                background: rgba(15, 18, 26, 0.78);
                border: 1px solid rgba(255, 255, 255, 0.2);
                color: rgba(255, 255, 255, 0.9);
                cursor: pointer;
                backdrop-filter: blur(8px);
                -webkit-backdrop-filter: blur(8px);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
                transition: all 0.2s ease;
            }
            .rbq-privacy-spoiler-rehide-btn:hover {
                background: rgba(15, 18, 26, 0.95);
                color: #ffffff;
                border-color: rgba(255, 255, 255, 0.4);
                transform: translateY(-1px);
            }
            .rbq-privacy-spoiler-wrap.is-revealed .rbq-privacy-spoiler-rehide-btn {
                display: inline-flex;
            }
        `;
        document.head.appendChild(style);
    }

    // ── 3. 提取分镜/卡片剧情描述 ──
    function getCardSceneLabel(wrapper) {
        if (!wrapper) return '';
        let label = wrapper.dataset?.rbqSdtOrigLabel;
        if (!label && wrapper.dataset?.label && wrapper.dataset.label !== 'external') {
            label = wrapper.dataset.label;
        }
        if (!label) {
            const btn = wrapper.querySelector('.rbq-sdt-run-image') || wrapper.querySelector('.st-scene-trigger-generate');
            if (btn) {
                const rawText = btn.textContent || '';
                const clean = rawText.replace(/^[\u{1F300}-\u{1FAD6}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\s]+/gu, '').trim();
                const blacklist = ['生成图片', '重新生成', '生成中...', '自动生成中...', '等待自动生图...', '查看大图', '展开图片', '收起图片', '收起'];
                if (clean && !blacklist.includes(clean)) {
                    const subMatch = clean.match(/^(?:查看|展开|收起)[:：]\s*(.+)$/);
                    if (subMatch) {
                        label = subMatch[1].trim();
                    } else {
                        label = clean;
                    }
                }
            }
        }
        if (label) {
            label = label.replace(/^[\u{1F300}-\u{1FAD6}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\s]+/gu, '').trim();
            const subMatch = label.match(/^(?:查看|展开|收起)[:：]\s*(.+)$/);
            if (subMatch) label = subMatch[1].trim();
            if (['生成图片', '重新生成', '大图', '图片'].includes(label)) {
                label = '';
            }
            if (label.length > 30) {
                label = label.slice(0, 29) + '…';
            }
        }
        return label || '';
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // ── 4. 渲染双段隐私操作栏 ──
    function renderPrivacyBar(wrapper, mode) {
        if (!(wrapper instanceof HTMLElement)) return;
        const ui = wrapper.querySelector('.st-scene-trigger-inline-ui');
        if (!(ui instanceof HTMLElement)) return;

        let bar = ui.querySelector('.rbq-privacy-bar');
        if (!bar) {
            bar = document.createElement('span');
            bar.className = 'rbq-privacy-bar';
            const loader = ui.querySelector('.st-scene-trigger-inline-loader');
            if (loader) ui.insertBefore(bar, loader);
            else ui.appendChild(bar);
        }

        const label = getCardSceneLabel(wrapper);
        const container = wrapper.querySelector('.st-scene-trigger-inline-result');
        const isCollapsed = container ? container.classList.contains('rbq-privacy-collapsed') : true;

        // 【关键防死循环与幂等保护】：如果状态完全未变，绝不修改 innerHTML，避免触发 DOM 重绘与 MutationObserver
        if (
            bar.dataset.mode === mode &&
            bar.dataset.label === label &&
            (mode !== 'collapse' || bar.dataset.collapsed === String(isCollapsed))
        ) {
            return;
        }

        bar.dataset.mode = mode;
        bar.dataset.label = label || '';
        bar.dataset.collapsed = String(isCollapsed);

        if (mode === 'gallery') {
            const viewText = label ? `🖼️ 查看: ${label}` : '🖼️ 查看大图';
            bar.innerHTML = `
              <button type="button" class="menu_button st-scene-trigger-inline-button rbq-privacy-view-btn" title="${escapeHtml(viewText)} (点击查看全屏大图)">
                <span class="rbq-privacy-label-text">${escapeHtml(viewText)}</span>
              </button>
              <button type="button" class="menu_button st-scene-trigger-inline-button rbq-privacy-regen-btn" title="重新生成该图片">
                <i class="fa-solid fa-arrows-rotate"></i>
              </button>
            `;
        } else if (mode === 'collapse') {
            const toggleText = isCollapsed
                ? (label ? `👁️ 展开: ${label}` : '👁️ 展开图片')
                : (label ? `🙈 收起: ${label}` : '🙈 收起');
            bar.innerHTML = `
              <button type="button" class="menu_button st-scene-trigger-inline-button rbq-privacy-collapse-toggle" title="${escapeHtml(toggleText)}">
                <span class="rbq-privacy-label-text">${escapeHtml(toggleText)}</span>
              </button>
              <button type="button" class="menu_button st-scene-trigger-inline-button rbq-privacy-regen-btn" title="重新生成该图片">
                <i class="fa-solid fa-arrows-rotate"></i>
              </button>
            `;
        }

        // 继承宿主卡片的色调风格
        const rawBtn = wrapper.querySelector('.rbq-sdt-run-image') || wrapper.querySelector('.st-scene-trigger-generate');
        const primaryBtn = bar.querySelector('.rbq-privacy-view-btn') || bar.querySelector('.rbq-privacy-collapse-toggle');
        if (primaryBtn instanceof HTMLElement && rawBtn instanceof HTMLElement) {
            if (rawBtn.style.background) primaryBtn.style.background = rawBtn.style.background;
            if (rawBtn.style.backgroundImage) primaryBtn.style.backgroundImage = rawBtn.style.backgroundImage;
            if (rawBtn.style.color) primaryBtn.style.color = rawBtn.style.color;
            if (rawBtn.style.boxShadow) primaryBtn.style.boxShadow = rawBtn.style.boxShadow;
        }
    }

    // ── 5. 清除卡片隐私状态（恢复原始状态） ──
    function cleanCardPrivacyState(wrapper, container) {
        delete wrapper.dataset.rbqPrivacyAppliedMode;
        delete wrapper.dataset.rbqPrivacyAppliedLabel;
        delete wrapper.dataset.rbqPrivacyAppliedCollapsed;
        if (container?.dataset?.rbqHasImage) delete container.dataset.rbqHasImage;
        container?.classList.remove('rbq-privacy-hidden-image', 'rbq-privacy-collapsed');
        wrapper.querySelector('.rbq-privacy-bar')?.remove();
        const rawBtn = wrapper.querySelector('.rbq-sdt-run-image') || wrapper.querySelector('.st-scene-trigger-generate');
        if (rawBtn instanceof HTMLElement) {
            rawBtn.classList.remove('rbq-privacy-hidden-btn');
            if (rawBtn.classList.contains('rbq-sdt-run-image') && wrapper.dataset?.rbqSdtIsResult === '1') {
                rawBtn.style.display = '';
            }
        }
        if (container) removeSpoilerMask(container);
    }

    // ── 6. 应用展示模式到单个卡片 ──
    function applyCardMode(wrapper, mode) {
        if (!(wrapper instanceof HTMLElement)) return;
        const container = wrapper.querySelector('.st-scene-trigger-inline-result');
        if (!(container instanceof HTMLElement)) return;

        // 仅在已有生成媒体时生效：必须真实存在具有有效链接的 img 或 video 节点
        const media = container.querySelector('img, video');
        const hasValidMedia = !!(media && (media.getAttribute('src') || media.src));
        if (!hasValidMedia) {
            cleanCardPrivacyState(wrapper, container);
            return;
        }
        container.dataset.rbqHasImage = '1';

        const label = getCardSceneLabel(wrapper);
        const isCollapsed = !wrapper.dataset.rbqManualExpanded;

        // 幂等性守卫：如果卡片已应用过且状态完全一致，绝不重复操作 DOM
        if (
            wrapper.dataset.rbqPrivacyAppliedMode === mode &&
            wrapper.dataset.rbqPrivacyAppliedLabel === label &&
            (mode !== 'collapse' || wrapper.dataset.rbqPrivacyAppliedCollapsed === String(isCollapsed))
        ) {
            return;
        }

        const ui = wrapper.querySelector('.st-scene-trigger-inline-ui');
        const rawBtn = wrapper.querySelector('.rbq-sdt-run-image') || wrapper.querySelector('.st-scene-trigger-generate');

        if (mode === 'gallery') {
            container.classList.add('rbq-privacy-hidden-image');
            container.classList.remove('rbq-privacy-collapsed');
            removeSpoilerMask(container);

            if (rawBtn instanceof HTMLElement) {
                rawBtn.classList.add('rbq-privacy-hidden-btn');
            }
            renderPrivacyBar(wrapper, 'gallery');
        } else if (mode === 'collapse') {
            container.classList.remove('rbq-privacy-hidden-image');
            removeSpoilerMask(container);

            if (isCollapsed) {
                container.classList.add('rbq-privacy-collapsed');
            } else {
                container.classList.remove('rbq-privacy-collapsed');
            }

            if (rawBtn instanceof HTMLElement) {
                rawBtn.classList.add('rbq-privacy-hidden-btn');
            }
            renderPrivacyBar(wrapper, 'collapse');
        } else if (mode === 'spoiler') {
            container.classList.remove('rbq-privacy-hidden-image', 'rbq-privacy-collapsed');
            ui?.querySelector('.rbq-privacy-bar')?.remove();

            if (rawBtn instanceof HTMLElement) {
                rawBtn.classList.remove('rbq-privacy-hidden-btn');
            }
            ensureSpoilerMask(wrapper, container);
        } else {
            // normal
            container.classList.remove('rbq-privacy-hidden-image', 'rbq-privacy-collapsed');
            ui?.querySelector('.rbq-privacy-bar')?.remove();
            removeSpoilerMask(container);

            if (rawBtn instanceof HTMLElement) {
                rawBtn.classList.remove('rbq-privacy-hidden-btn');
            }
        }

        wrapper.dataset.rbqPrivacyAppliedMode = mode;
        wrapper.dataset.rbqPrivacyAppliedLabel = label || '';
        wrapper.dataset.rbqPrivacyAppliedCollapsed = String(isCollapsed);
    }

    function ensureSpoilerMask(wrapper, container) {
        let spoilerWrap = container.querySelector('.rbq-privacy-spoiler-wrap');
        if (!spoilerWrap) {
            const link = container.querySelector('.st-scene-trigger-inline-image-link') || container.querySelector('img, video');
            if (!link) return;
            spoilerWrap = document.createElement('div');
            spoilerWrap.className = 'rbq-privacy-spoiler-wrap';
            link.parentNode.insertBefore(spoilerWrap, link);
            spoilerWrap.appendChild(link);
        }

        let mask = spoilerWrap.querySelector('.rbq-privacy-spoiler-mask');
        if (!mask) {
            const label = getCardSceneLabel(wrapper);
            const badgeText = label ? `剧透遮罩: ${label} (点击解密)` : '剧透遮罩 (点击解密)';

            mask = document.createElement('div');
            mask.className = 'rbq-privacy-spoiler-mask';
            mask.innerHTML = `
                <div class="rbq-privacy-spoiler-badge">
                    <i class="fa-solid fa-eye-slash"></i>
                    <span>${escapeHtml(badgeText)}</span>
                </div>
            `;
            spoilerWrap.appendChild(mask);

            const rehideBtn = document.createElement('button');
            rehideBtn.type = 'button';
            rehideBtn.className = 'rbq-privacy-spoiler-rehide-btn';
            rehideBtn.title = '重新模糊遮罩';
            rehideBtn.innerHTML = '<i class="fa-solid fa-eye-slash"></i> 重新隐藏';
            spoilerWrap.appendChild(rehideBtn);
        }
    }

    function removeSpoilerMask(container) {
        const spoilerWrap = container.querySelector('.rbq-privacy-spoiler-wrap');
        if (spoilerWrap) {
            const link = spoilerWrap.querySelector('.st-scene-trigger-inline-image-link') || spoilerWrap.querySelector('img, video');
            if (link) {
                container.insertBefore(link, spoilerWrap);
            }
            spoilerWrap.remove();
        }
    }

    // ── 7. 批量应用与防重入调度 ──
    let isApplying = false;
    function applyModeToAllCards(mode) {
        if (isApplying) return;
        isApplying = true;
        try {
            const curMode = mode || getStoredMode();
            const wrappers = document.querySelectorAll('.st-scene-trigger-inline-wrap');
            for (let i = 0; i < wrappers.length; i++) {
                applyCardMode(wrappers[i], curMode);
            }
        } finally {
            isApplying = false;
        }
    }

    let scheduledRaf = null;
    function requestApplyMode(mode) {
        if (scheduledRaf !== null) return;
        scheduledRaf = requestAnimationFrame(() => {
            scheduledRaf = null;
            applyModeToAllCards(mode);
        });
    }

    // ── 8. 全局点击事件委托 ──
    document.addEventListener('click', function(event) {
        const viewBtn = event.target.closest('.rbq-privacy-view-btn');
        const collapseBtn = event.target.closest('.rbq-privacy-collapse-toggle');
        const regenBtn = event.target.closest('.rbq-privacy-regen-btn');
        const spoilerMask = event.target.closest('.rbq-privacy-spoiler-mask');
        const rehideBtn = event.target.closest('.rbq-privacy-spoiler-rehide-btn');

        if (rehideBtn) {
            event.preventDefault();
            event.stopPropagation();
            const spoilerWrap = rehideBtn.closest('.rbq-privacy-spoiler-wrap');
            if (spoilerWrap) spoilerWrap.classList.remove('is-revealed');
            return;
        }

        if (spoilerMask) {
            event.preventDefault();
            event.stopPropagation();
            const spoilerWrap = spoilerMask.closest('.rbq-privacy-spoiler-wrap');
            if (spoilerWrap) spoilerWrap.classList.add('is-revealed');
            return;
        }

        if (viewBtn) {
            event.preventDefault();
            event.stopPropagation();
            const wrapper = viewBtn.closest('.st-scene-trigger-inline-wrap');
            if (wrapper) {
                const imgLink = wrapper.querySelector('.st-scene-trigger-inline-image-link');
                if (imgLink) {
                    imgLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                } else {
                    const media = wrapper.querySelector('img, video');
                    if (media && (media.getAttribute('src') || media.src)) {
                        const mSrc = media.getAttribute('src') || media.src;
                        const prompt = wrapper.dataset?.prompt || '';
                        const messageId = Number(wrapper.dataset?.messageId);
                        const fakeLink = document.createElement('a');
                        fakeLink.className = 'st-scene-trigger-inline-image-link';
                        fakeLink.href = mSrc;
                        fakeLink.dataset.prompt = prompt;
                        fakeLink.dataset.url = mSrc;
                        fakeLink.dataset.messageId = Number.isFinite(messageId) ? String(messageId) : '';
                        wrapper.appendChild(fakeLink);
                        fakeLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                        fakeLink.remove();
                    }
                }
            }
            return;
        }

        if (collapseBtn) {
            event.preventDefault();
            event.stopPropagation();
            const wrapper = collapseBtn.closest('.st-scene-trigger-inline-wrap');
            if (wrapper) {
                const container = wrapper.querySelector('.st-scene-trigger-inline-result');
                if (container) {
                    const isCollapsed = container.classList.contains('rbq-privacy-collapsed');
                    const label = getCardSceneLabel(wrapper);
                    if (isCollapsed) {
                        container.classList.remove('rbq-privacy-collapsed');
                        wrapper.dataset.rbqManualExpanded = '1';
                        wrapper.dataset.rbqPrivacyAppliedCollapsed = 'false';
                        const bar = wrapper.querySelector('.rbq-privacy-bar');
                        if (bar) bar.dataset.collapsed = 'false';
                        const collapseText = label ? `收起: ${label}` : '收起';
                        collapseBtn.innerHTML = `<i class="fa-solid fa-eye-slash"></i> ${escapeHtml(collapseText)}`;
                        collapseBtn.title = collapseText;
                    } else {
                        container.classList.add('rbq-privacy-collapsed');
                        delete wrapper.dataset.rbqManualExpanded;
                        wrapper.dataset.rbqPrivacyAppliedCollapsed = 'true';
                        const bar = wrapper.querySelector('.rbq-privacy-bar');
                        if (bar) bar.dataset.collapsed = 'true';
                        const expandText = label ? `展开: ${label}` : '展开图片';
                        collapseBtn.innerHTML = `<i class="fa-solid fa-eye"></i> ${escapeHtml(expandText)}`;
                        collapseBtn.title = expandText;
                    }
                }
            }
            return;
        }

        if (regenBtn) {
            event.preventDefault();
            event.stopPropagation();
            const wrapper = regenBtn.closest('.st-scene-trigger-inline-wrap');
            if (wrapper) {
                const targetBtn = wrapper.querySelector('.rbq-sdt-run-image') || wrapper.querySelector('.st-scene-trigger-generate');
                if (targetBtn && targetBtn !== regenBtn) {
                    targetBtn.click();
                }
            }
            return;
        }
    }, true);

    // ── 9. 注入设置到宿主通用设置面板 ──
    function injectSettingUi() {
        let container = document.getElementById(SETTING_CONTAINER_ID);
        if (container) {
            const select = container.querySelector('#rbq-image-privacy-select');
            if (select) {
                const currentChoice = getStoredMode();
                if (select.value !== currentChoice) {
                    select.value = currentChoice;
                }
            }
            return true;
        }

        const target = document.querySelector('.st-scene-trigger-field[data-setting-key="singleGenerationOnly"]')
            || document.querySelector('.st-scene-trigger-field[data-setting-key="showFloatingButton"]');
        if (!target || !target.parentNode) return false;

        const currentChoice = getStoredMode();
        container = document.createElement('label');
        container.className = 'st-scene-trigger-field';
        container.id = SETTING_CONTAINER_ID;
        container.innerHTML = `
            <span>图片展示模式</span>
            <select id="rbq-image-privacy-select" title="选择正文中生成图片的展示与隐私隐藏方式">
                <option value="normal"${currentChoice === 'normal' ? ' selected' : ''}>🖼️ 标准直出 (默认直接插图)</option>
                <option value="gallery"${currentChoice === 'gallery' ? ' selected' : ''}>🕶️ 纯净画廊 (正文不插图，点击看大图)</option>
                <option value="collapse"${currentChoice === 'collapse' ? ' selected' : ''}>🙈 折叠模式 (生图后默认收起，点击展开)</option>
                <option value="spoiler"${currentChoice === 'spoiler' ? ' selected' : ''}>🌫️ 剧透遮罩 (毛玻璃模糊，点击解密)</option>
            </select>
        `;

        target.parentNode.insertBefore(container, target.nextSibling);

        const select = container.querySelector('#rbq-image-privacy-select');
        if (select) {
            select.addEventListener('change', function(e) {
                const val = e.target.value;
                setStoredMode(val);
                // 切换模式时清空已应用缓存标记，使所有卡片重新计算一次
                document.querySelectorAll('.st-scene-trigger-inline-wrap').forEach((wrapper) => {
                    delete wrapper.dataset.rbqPrivacyAppliedMode;
                    delete wrapper.dataset.rbqPrivacyAppliedLabel;
                    delete wrapper.dataset.rbqPrivacyAppliedCollapsed;
                });
                applyModeToAllCards(val);
                if (typeof toastr !== 'undefined' && toastr?.success) {
                    toastr.success(`已切换为: ${MODE_NAMES[val] || val}`, PLUGIN_NAME);
                }
            });
        }
        return true;
    }

    // ── 10. DOM 监听与初始化 ──
    ensureStyles();

    // 初始卡片应用
    applyModeToAllCards();

    let privacyObserver = null;
    let origRender = null;
    let injectSettingTimer = null;
    let clickListener = null;

    // 安全的 DOM 变更监听：使用 RAF 节流调度，并彻底排除插件自身 UI 与无关容器
    const observer = new MutationObserver(function(mutations) {
        if (isApplying) return;

        let hasRelevantChange = false;
        for (let i = 0; i < mutations.length; i++) {
            const m = mutations[i];
            const target = m.target;
            if (target instanceof Element) {
                // 排除插件内部操作栏、毛玻璃遮罩、Toast 通知、控制台模态窗变动
                if (target.closest('.rbq-privacy-bar, .rbq-privacy-spoiler-wrap, #toast-container, #st-scene-trigger-modal')) {
                    continue;
                }
            }
            if (m.addedNodes && m.addedNodes.length > 0) {
                for (let j = 0; j < m.addedNodes.length; j++) {
                    const node = m.addedNodes[j];
                    if (node instanceof Element) {
                        if (
                            node.classList.contains('st-scene-trigger-inline-wrap') ||
                            node.classList.contains('st-scene-trigger-inline-result') ||
                            node.classList.contains('mes') ||
                            node.querySelector?.('.st-scene-trigger-inline-wrap, .st-scene-trigger-inline-result, img, video')
                        ) {
                            hasRelevantChange = true;
                            break;
                        }
                    }
                }
            }
            if (hasRelevantChange) break;
        }

        if (hasRelevantChange) {
            requestApplyMode();
        }
    });

    const chatContainer = document.getElementById('chat') || document.body;
    observer.observe(chatContainer, {
        childList: true,
        subtree: true,
    });
    privacyObserver = observer;

    // 拦截 RBQ 生图渲染接口（安全解构防多重闭包嵌套）
    if (RBQ.api && typeof RBQ.api.renderInlineGeneratedImage === 'function') {
        origRender = RBQ.api.renderInlineGeneratedImage.__origRender || RBQ.api.renderInlineGeneratedImage;
        const patchedRender = function(wrapper, result) {
            const res = origRender.apply(this, arguments);
            setTimeout(() => {
                applyCardMode(wrapper, getStoredMode());
            }, 0);
            return res;
        };
        patchedRender.__origRender = origRender;
        RBQ.api.renderInlineGeneratedImage = patchedRender;
    }

    // 设置面板注入守护
    if (!injectSettingUi()) {
        injectSettingTimer = setInterval(function() {
            if (injectSettingUi()) {
                clearInterval(injectSettingTimer);
                injectSettingTimer = null;
            }
        }, 500);
        setTimeout(function() {
            if (injectSettingTimer) {
                clearInterval(injectSettingTimer);
                injectSettingTimer = null;
            }
        }, 30000);
    }

    // 页面点击交互时保证设置面板就位
    clickListener = function() {
        setTimeout(injectSettingUi, 50);
    };
    document.addEventListener('click', clickListener);

    function cleanupInstance() {
        console.info(`[${PLUGIN_NAME}] 正在执行实例清理...`);
        if (privacyObserver) {
            try { privacyObserver.disconnect(); } catch (_e) {}
            privacyObserver = null;
        }
        if (injectSettingTimer) {
            clearInterval(injectSettingTimer);
            injectSettingTimer = null;
        }
        if (clickListener) {
            document.removeEventListener('click', clickListener);
            clickListener = null;
        }
        if (origRender && RBQ?.api) {
            RBQ.api.renderInlineGeneratedImage = origRender;
            origRender = null;
        }
        document.getElementById(STYLE_ID)?.remove();
        document.getElementById(SETTING_CONTAINER_ID)?.remove();
        document.querySelectorAll('.rbq-privacy-bar').forEach(el => el.remove());
        document.querySelectorAll('.st-scene-trigger-inline-wrap').forEach((wrapper) => {
            delete wrapper.dataset.rbqPrivacyAppliedMode;
            delete wrapper.dataset.rbqPrivacyAppliedLabel;
            delete wrapper.dataset.rbqPrivacyAppliedCollapsed;
        });
        try {
            applyModeToAllCards('normal');
        } catch (_e) {}
    }

    window.__rbqPrivacyCleanup = cleanupInstance;
    if (RBQ?.registerCleanup) {
        RBQ.registerCleanup(PLUGIN_ID, cleanupInstance);
    }

    console.info(`[RBQ Plugin] ${PLUGIN_NAME} v1.0.4 loaded.`);
})(
    (typeof RBQ !== 'undefined' ? RBQ : (window.RBQ || null)),
    (typeof jQuery !== 'undefined' ? jQuery : window.$),
    (typeof toastr !== 'undefined' ? toastr : console)
);
