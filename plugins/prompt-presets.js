(function (RBQ, $, toastr) {
    if (!RBQ) return console.error('[Prompt Presets] RBQ Core API missing');

    const STORAGE_KEY = '_promptPresets';

    const copyToClipboard = async (text) => {
        if (typeof RBQ?.utils?.copyToClipboard === 'function') {
            return RBQ.utils.copyToClipboard(text);
        }
        if (text === null || text === undefined) return false;
        const str = String(text);
        const isSecure = Boolean(window.isSecureContext || location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
        if (isSecure && navigator?.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(str);
                return true;
            } catch (err) {
                console.warn('[Prompt Presets] navigator.clipboard.writeText 失败，尝试降级:', err);
            }
        }
        try {
            const textarea = document.createElement('textarea');
            textarea.value = str;
            textarea.style.position = 'fixed';
            textarea.style.top = '0';
            textarea.style.left = '0';
            textarea.style.width = '2em';
            textarea.style.height = '2em';
            textarea.style.padding = '0';
            textarea.style.border = 'none';
            textarea.style.outline = 'none';
            textarea.style.boxShadow = 'none';
            textarea.style.background = 'transparent';
            textarea.style.opacity = '0.01';
            textarea.style.zIndex = '-9999';
            textarea.style.fontSize = '16px';
            document.body.appendChild(textarea);
            if (navigator.userAgent.match(/ipad|iphone|ipod/i)) {
                textarea.contentEditable = 'true';
                textarea.readOnly = false;
                const range = document.createRange();
                range.selectNodeContents(textarea);
                const selection = window.getSelection();
                if (selection) {
                    selection.removeAllRanges();
                    selection.addRange(range);
                }
                textarea.setSelectionRange(0, 999999);
            } else {
                textarea.focus({ preventScroll: true });
                textarea.select();
            }
            const success = document.execCommand('copy');
            document.body.removeChild(textarea);
            if (success) return true;
        } catch (fallbackErr) {
            console.warn('[Prompt Presets] execCommand 复制降级失败:', fallbackErr);
        }
        return false;
    };

    // ── Storage ──
    function getStore() {
        const s = RBQ.api.getSettings();
        if (!s[STORAGE_KEY]) s[STORAGE_KEY] = { activeId: '', position: 'prepend', globalPositivePrefix: '', globalPositiveSuffix: '', globalNegative: '', presets: [] };
        const store = s[STORAGE_KEY];
        let mutated = false;
        if (store.globalPositive && !store.globalPositivePrefix) {
            store.globalPositivePrefix = store.globalPositive;
            delete store.globalPositive;
            mutated = true;
        }
        if (typeof store.globalPositivePrefix !== 'string') { store.globalPositivePrefix = ''; mutated = true; }
        if (typeof store.globalPositiveSuffix !== 'string') { store.globalPositiveSuffix = ''; mutated = true; }
        if (typeof store.globalNegative !== 'string') { store.globalNegative = ''; mutated = true; }
        const seenIds = new Set();
        store.presets = (Array.isArray(store.presets) ? store.presets : []).map((item) => {
            if (!item || typeof item !== 'object') return null;
            const preset = { ...item };
            preset.id = String(preset.id || uid());
            if (typeof preset.positive !== 'string') { preset.positive = ''; mutated = true; }
            if (typeof preset.positiveSuffix !== 'string') { preset.positiveSuffix = ''; mutated = true; }
            if (typeof preset.negative !== 'string') { preset.negative = ''; mutated = true; }
            if (seenIds.has(preset.id)) {
                preset.id = uid();
                mutated = true;
            }
            seenIds.add(preset.id);
            if (!item.id) mutated = true;
            return preset;
        }).filter(Boolean);
        if (store.activeId && !store.presets.some(p => p.id === store.activeId)) {
            store.activeId = '';
            mutated = true;
        }
        if (mutated && !isSaving) save();
        return store;
    }

    let renderPresetUi = null;

    // ── 暴露给跨插件生态 (如预设工坊下载/导入后即时触发重绘，无需刷新网页) ──
    if (RBQ && RBQ.api) {
        RBQ.api.refreshPromptPresetsUi = () => {
            if (typeof renderPresetUi === 'function') {
                renderPresetUi();
            }
        };
    }
    if (typeof RBQ?.on === 'function') {
        RBQ.on('presets:updated', () => {
            if (typeof renderPresetUi === 'function') {
                renderPresetUi();
            }
        });
    }
    window.addEventListener('rbq-presets-updated', () => {
        if (typeof renderPresetUi === 'function') {
            renderPresetUi();
        }
    });

    let isSaving = false;
    let isSyncing = false;

    function syncToActiveProfile() {
        if (isSyncing) return;
        isSyncing = true;
        try {
            const activeProfile = RBQ.api.getActiveGlobalProfile?.();
            if (activeProfile && activeProfile.data && typeof activeProfile.data === 'object') {
                const store = getStore();
                activeProfile.data.promptPresetsConfig = {
                    globalPositivePrefix: store.globalPositivePrefix || '',
                    globalPositiveSuffix: store.globalPositiveSuffix || '',
                    globalNegative: store.globalNegative || '',
                    activeId: store.activeId || '',
                    position: store.position || 'prepend',
                };
                activeProfile.updatedAt = Date.now();
            }
        } catch (_e) {}
        finally {
            isSyncing = false;
        }
    }

    function save() {
        if (isSaving) return;
        isSaving = true;
        try {
            syncToActiveProfile();
            RBQ.api.saveSettings();
        } finally {
            isSaving = false;
        }
    }
    function uid() { return 'pp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
    function getActivePreset() {
        const store = getStore();
        return store.activeId ? store.presets.find(p => p.id === store.activeId) || null : null;
    }

    function getCurrentNaiVibes() {
        return Array.isArray(RBQ.api.getNaiVibes?.()) ? RBQ.api.getNaiVibes() : [];
    }

    function compactVibeEntry(item) {
        if (!item || typeof item !== 'object') return null;
        const tensor = String(item.tensor || '').trim();
        const b64 = String(item.b64 || '').trim();
        if (!tensor && !b64) return null;
        return {
            id: String(item.id || uid()),
            tensor: tensor || null,
            b64,
            info: Math.max(0, Math.min(1, Number(item.info) || 1)),
            strength: Math.max(0, Math.min(1, Number(item.strength) || 0.6)),
        };
    }

    function snapshotNaiVibes(mode = 'full') {
        const vibes = getCurrentNaiVibes();
        return vibes.map((item) => {
            const base = compactVibeEntry(item);
            if (!base) return null;
            if (mode === 'compact') {
                return {
                    id: base.id,
                    tensor: base.tensor,
                    b64: '',
                    info: base.info,
                    strength: base.strength,
                };
            }
            return base;
        }).filter(Boolean).slice(0, 6);
    }

    function restorePresetVibesToHost(preset) {
        const vibes = Array.isArray(preset?.vibes) ? preset.vibes : [];
        const currentVibes = getCurrentNaiVibes();
        if (vibes.length === 0 && currentVibes.length === 0) return;
        RBQ.api.setNaiVibes?.(vibes, { source: 'plugin:preset-restore' });
        RBQ.api.refreshNaiVibeUi?.();
    }

    // 弹窗挂载：用 <dialog>.showModal() 进入浏览器顶层 (top layer)。
    // 酒馆 1.19 的 Popup 也是 showModal 的 <dialog>，普通 position:fixed + z-index 再大也会被它盖住且被设为 inert，
    // 所以这里同样走顶层，保证导入/导出/删除弹窗永远在最上面；不支持 <dialog> 时退回 body + fixed。
    function mountRbqPpOverlay(overlay) {
        const host = document.createElement('dialog');
        if (typeof host.showModal !== 'function') {
            document.body.appendChild(overlay);
            return;
        }
        host.className = 'rbq-pp-top-layer';
        host.addEventListener('cancel', (e) => e.preventDefault()); // Esc 交给各弹窗自己的 keydown 处理
        host.appendChild(overlay);
        document.body.appendChild(host);
        try {
            host.showModal();
        } catch (_e) {
            host.remove();
            document.body.appendChild(overlay);
        }
    }

    function unmountRbqPpOverlay(overlay) {
        const host = overlay?.parentElement;
        if (host instanceof HTMLDialogElement && host.classList.contains('rbq-pp-top-layer')) {
            try { host.close(); } catch (_e) { /* noop */ }
            host.remove();
        } else {
            overlay?.remove();
        }
    }

    function ensureDialogStyles() {
        let style = document.getElementById('rbq-pp-dialog-styles');
        if (!style) {
            style = document.createElement('style');
            style.id = 'rbq-pp-dialog-styles';
            document.head.appendChild(style);
        }
        style.textContent = `
            dialog.rbq-pp-top-layer {
                position: fixed !important;
                inset: 0 !important;
                width: 100vw !important;
                height: 100dvh !important;
                max-width: none !important;
                max-height: none !important;
                margin: 0 !important;
                padding: 0 !important;
                border: 0 !important;
                background: transparent !important;
                overflow: visible !important;
                color: inherit;
            }
            dialog.rbq-pp-top-layer::backdrop {
                background: transparent;
            }
            .rbq-pp-dialog-overlay {
                position: fixed !important;
                inset: 0 !important;
                z-index: 2147483647 !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                background: rgba(0, 0, 0, 0.75) !important;
                backdrop-filter: blur(8px) !important;
                -webkit-backdrop-filter: blur(8px) !important;
                box-sizing: border-box !important;
                padding: max(16px, env(safe-area-inset-top, 16px)) 12px max(16px, env(safe-area-inset-bottom, 16px)) !important;
                overflow-y: auto !important;
                overscroll-behavior: contain !important;
                -webkit-overflow-scrolling: touch !important;
            }
            .rbq-pp-dialog-box {
                background: #18191d !important;
                border: 1px solid rgba(255, 255, 255, 0.12) !important;
                border-radius: 14px !important;
                box-shadow: 0 20px 50px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.06) !important;
                width: min(94vw, 520px) !important;
                max-height: min(86dvh, 720px) !important;
                display: flex !important;
                flex-direction: column !important;
                box-sizing: border-box !important;
                overflow: hidden !important;
                color: #f7f8f8 !important;
                margin: auto !important;
            }
            .rbq-pp-dialog-header {
                display: flex !important;
                align-items: center !important;
                justify-content: space-between !important;
                padding: 13px 16px !important;
                border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
                background: rgba(255, 255, 255, 0.02) !important;
                flex-shrink: 0 !important;
                gap: 10px !important;
            }
            .rbq-pp-dialog-title {
                font-size: 14.5px !important;
                font-weight: 600 !important;
                color: #fff !important;
                display: flex !important;
                align-items: center !important;
                gap: 8px !important;
                min-width: 0 !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;
                white-space: nowrap !important;
                flex: 1 !important;
            }
            .rbq-pp-dialog-title i {
                color: #828fff !important;
                flex-shrink: 0 !important;
            }
            .rbq-pp-dialog-close {
                width: 28px !important;
                height: 28px !important;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                border-radius: 6px !important;
                border: none !important;
                background: transparent !important;
                color: rgba(255, 255, 255, 0.45) !important;
                cursor: pointer !important;
                transition: all 0.15s ease !important;
                padding: 0 !important;
                flex-shrink: 0 !important;
                font-size: 14px !important;
            }
            .rbq-pp-dialog-close:hover {
                color: #fff !important;
                background: rgba(255, 255, 255, 0.08) !important;
            }
            .rbq-pp-dialog-toolbar {
                display: flex !important;
                align-items: center !important;
                justify-content: space-between !important;
                padding: 8px 16px !important;
                background: rgba(0, 0, 0, 0.18) !important;
                border-bottom: 1px solid rgba(255, 255, 255, 0.06) !important;
                flex-shrink: 0 !important;
                gap: 8px !important;
            }
            .rbq-pp-dialog-count-badge {
                font-size: 11px !important;
                font-weight: 600 !important;
                padding: 2px 8px !important;
                border-radius: 999px !important;
                background: rgba(94, 106, 210, 0.15) !important;
                color: #a5b4fc !important;
                border: 1px solid rgba(94, 106, 210, 0.3) !important;
                white-space: nowrap !important;
            }
            .rbq-pp-dialog-body {
                flex: 1 1 auto !important;
                min-height: 0 !important;
                overflow-y: auto !important;
                padding: 10px 14px !important;
                display: flex !important;
                flex-direction: column !important;
                gap: 6px !important;
                -webkit-overflow-scrolling: touch !important;
            }
            .rbq-pp-dialog-item {
                display: flex !important;
                align-items: flex-start !important;
                gap: 10px !important;
                padding: 10px 12px !important;
                min-height: 44px !important;
                border-radius: 8px !important;
                background: rgba(255, 255, 255, 0.03) !important;
                border: 1px solid rgba(255, 255, 255, 0.06) !important;
                cursor: pointer !important;
                user-select: none !important;
                -webkit-user-select: none !important;
                transition: background 0.15s ease, border-color 0.15s ease !important;
                box-sizing: border-box !important;
            }
            .rbq-pp-dialog-item:hover {
                background: rgba(255, 255, 255, 0.06) !important;
                border-color: rgba(255, 255, 255, 0.12) !important;
            }
            .rbq-pp-dialog-item.selected {
                background: rgba(94, 106, 210, 0.08) !important;
                border-color: rgba(94, 106, 210, 0.35) !important;
            }
            .rbq-pp-dialog-checkbox {
                margin-top: 2px !important;
                width: 17px !important;
                height: 17px !important;
                accent-color: #5e6ad2 !important;
                cursor: pointer !important;
                flex-shrink: 0 !important;
            }
            .rbq-pp-dialog-item-info {
                flex: 1 1 auto !important;
                min-width: 0 !important;
            }
            .rbq-pp-dialog-item-name {
                font-size: 13px !important;
                font-weight: 500 !important;
                color: #fff !important;
                line-height: 1.4 !important;
                word-break: break-all !important;
            }
            .rbq-pp-dialog-item-tag {
                font-size: 11px !important;
                margin-top: 2px !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;
                white-space: nowrap !important;
                line-height: 1.4 !important;
            }
            .rbq-pp-dialog-item-tag.pos {
                color: rgba(255, 255, 255, 0.55) !important;
            }
            .rbq-pp-dialog-item-tag.neg {
                color: rgba(248, 113, 113, 0.65) !important;
            }
            .rbq-pp-dialog-footer {
                display: flex !important;
                align-items: center !important;
                justify-content: flex-end !important;
                gap: 8px !important;
                padding: 12px 16px !important;
                padding-bottom: max(12px, env(safe-area-inset-bottom, 12px)) !important;
                border-top: 1px solid rgba(255, 255, 255, 0.08) !important;
                background: rgba(255, 255, 255, 0.02) !important;
                flex-shrink: 0 !important;
            }
            .rbq-pp-dialog-btn {
                display: inline-flex !important;
                flex-direction: row !important;
                align-items: center !important;
                justify-content: center !important;
                gap: 6px !important;
                white-space: nowrap !important;
                box-sizing: border-box !important;
                min-height: 40px !important;
                padding: 8px 16px !important;
                font-size: 13px !important;
                font-weight: 500 !important;
                line-height: 1 !important;
                border-radius: 7px !important;
                cursor: pointer !important;
                text-align: center !important;
                text-decoration: none !important;
                border: 1px solid transparent !important;
                transition: all 0.15s ease !important;
                font-family: inherit !important;
            }
            .rbq-pp-dialog-btn:active {
                transform: scale(0.98) !important;
            }
            .rbq-pp-dialog-btn-primary {
                background: linear-gradient(135deg, #5e6ad2, #7170ff) !important;
                color: #ffffff !important;
                box-shadow: 0 2px 6px rgba(94, 106, 210, 0.25) !important;
                border-color: rgba(255, 255, 255, 0.15) !important;
            }
            .rbq-pp-dialog-btn-primary:hover {
                background: linear-gradient(135deg, #6c78e0, #8281ff) !important;
                box-shadow: 0 3px 10px rgba(94, 106, 210, 0.4) !important;
            }
            .rbq-pp-dialog-btn-primary:disabled {
                opacity: 0.5 !important;
                cursor: not-allowed !important;
                transform: none !important;
            }
            .rbq-pp-dialog-btn-secondary {
                background: rgba(255, 255, 255, 0.06) !important;
                border-color: rgba(255, 255, 255, 0.1) !important;
                color: #f7f8f8 !important;
            }
            .rbq-pp-dialog-btn-secondary:hover {
                background: rgba(255, 255, 255, 0.1) !important;
                border-color: rgba(255, 255, 255, 0.18) !important;
            }
            .rbq-pp-dialog-btn-danger {
                background: rgba(239, 68, 68, 0.15) !important;
                border-color: rgba(239, 68, 68, 0.35) !important;
                color: #fca5a5 !important;
            }
            .rbq-pp-dialog-btn-danger:hover {
                background: rgba(239, 68, 68, 0.25) !important;
                border-color: rgba(239, 68, 68, 0.5) !important;
                color: #ef4444 !important;
            }
            .rbq-pp-dialog-btn-danger:disabled {
                opacity: 0.5 !important;
                cursor: not-allowed !important;
                transform: none !important;
            }
        `;
        document.head.appendChild(style);
    }

    function showVibeSaveDialog(onSelect) {
        ensureDialogStyles();
        const overlay = document.createElement('div');
        overlay.className = 'rbq-pp-dialog-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'rbq-pp-dialog-box';
        dialog.style.maxWidth = '460px';

        const closeDialog = () => {
            document.removeEventListener('keydown', onKeyDown);
            unmountRbqPpOverlay(overlay);
        };

        const onKeyDown = (e) => {
            if (e.key === 'Escape') closeDialog();
        };
        document.addEventListener('keydown', onKeyDown);

        dialog.innerHTML = `
            <div class="rbq-pp-dialog-header">
                <div class="rbq-pp-dialog-title">
                    <i class="fa-solid fa-box-archive"></i>
                    <span>保存氛围文件状态</span>
                </div>
                <button type="button" class="rbq-pp-dialog-close" title="关闭"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="rbq-pp-dialog-body" style="gap: 12px; padding: 14px 16px;">
                <div style="font-size:13px;color:rgba(255,255,255,0.85);line-height:1.6;">
                    当前 NAI 面板里检测到氛围文件。请选择保存方式：
                </div>
                <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:10px;">
                    <button id="rbq-pp-save-compact" class="rbq-pp-dialog-btn rbq-pp-dialog-btn-primary" type="button" style="padding:10px 14px;flex-direction:column;gap:4px;">
                        <span style="font-size:13px;font-weight:600;"><i class="fa-solid fa-minimize"></i> 压缩保存</span>
                        <span style="font-size:11px;opacity:0.8;font-weight:normal;">仅存特征，体积轻巧</span>
                    </button>
                    <button id="rbq-pp-save-full" class="rbq-pp-dialog-btn rbq-pp-dialog-btn-secondary" type="button" style="padding:10px 14px;flex-direction:column;gap:4px;">
                        <span style="font-size:13px;font-weight:600;"><i class="fa-solid fa-floppy-disk"></i> 完整保存</span>
                        <span style="font-size:11px;opacity:0.8;font-weight:normal;">保留全量 Base64 数据</span>
                    </button>
                </div>
                <div style="font-size:11.5px;color:rgba(255,255,255,0.5);line-height:1.5;background:rgba(255,255,255,0.03);padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);">
                    压缩保存：优先保留 tensor、strength、info，不保留大图 base64；完整保存：保留当前全部可用数据，体积更大。
                </div>
            </div>
            <div class="rbq-pp-dialog-footer">
                <button id="rbq-pp-save-cancel" class="rbq-pp-dialog-btn rbq-pp-dialog-btn-secondary" type="button">取消</button>
            </div>
        `;

        overlay.appendChild(dialog);
        dialog.addEventListener('click', (e) => e.stopPropagation());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDialog(); });
        overlay.addEventListener('touchmove', (e) => { if (e.target === overlay) e.preventDefault(); }, { passive: false });
        dialog.querySelector('.rbq-pp-dialog-close')?.addEventListener('click', closeDialog);
        dialog.querySelector('#rbq-pp-save-cancel')?.addEventListener('click', closeDialog);
        dialog.querySelector('#rbq-pp-save-compact')?.addEventListener('click', () => { closeDialog(); onSelect('compact'); });
        dialog.querySelector('#rbq-pp-save-full')?.addEventListener('click', () => { closeDialog(); onSelect('full'); });

        mountRbqPpOverlay(overlay);
    }

    // ── Join Logic ──
    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function combineParts(...parts) {
        return parts
            .map(p => (p || '').trim().replace(/^,+|,+$/g, '').trim())
            .filter(Boolean)
            .join(', ');
    }

    function sanitizeNaiWeightSyntax(prompt) {
        if (!prompt || typeof prompt !== 'string') return prompt;
        // 自动纠正 NovelAI 权重块以数字结尾且紧贴闭合 :: 导致的词法解析灾难级权重错误
        // 例如 0.6::artist:dishwasher1910:: 自动注入空格纠正为 0.6::artist:dishwasher1910 ::，避免 1910 被识别为后文权重
        return prompt.replace(/(^|[\s,;|\(\[\{<"'])([-+]?\d+(?:\.\d+)?::|::)((?:(?!::)[\s\S])+?)::/g, (match, prefix, open, content) => {
            if (/\d$/.test(content)) {
                return `${prefix}${open}${content} ::`;
            }
            return match;
        });
    }

    function resolvePositivePrompt(original, presetPre, presetSuf, globalPrefix, globalSuffix, position = 'prepend') {
        // Legacy 5-argument form support: resolvePositivePrompt(orig, presetPos, gPre, gSuf, pos)
        if (typeof globalSuffix === 'undefined' && typeof position === 'string' && (position === 'prepend' || position === 'append')) {
            const legacyPos = position;
            const legacyGSuf = globalPrefix;
            const legacyGPre = presetSuf;
            const legacyPreset = presetPre;
            presetPre = legacyPos === 'append' ? '' : legacyPreset;
            presetSuf = legacyPos === 'append' ? legacyPreset : '';
            globalPrefix = legacyGPre;
            globalSuffix = legacyGSuf;
            position = legacyPos;
        }
        const orig = (original || '').trim();
        let pre = (presetPre || '').trim();
        let suf = (presetSuf || '').trim();
        const gPre = (globalPrefix || '').trim();
        const gSuf = (globalSuffix || '').trim();

        // Fallback for legacy preset where only pre is populated but position was append
        if (position === 'append' && pre && !suf) {
            suf = pre;
            pre = '';
        }

        return sanitizeNaiWeightSyntax(combineParts(gPre, pre, orig, suf, gSuf));
    }

    function resolveNegativePrompt(original, presetText, globalText) {
        const orig = (original || '').trim();
        const preset = (presetText || '').trim();
        const global = (globalText || '').trim();
        if (!preset && !global) return sanitizeNaiWeightSyntax(orig);
        return sanitizeNaiWeightSyntax(combineParts(global, preset, orig));
    }

    function isIsolatedRequest(context) {
        if (!context) return false;
        if (context.meta?.isolate || context.meta?.skipPresets) return true;
        const isolatedReasons = ['market-live-test', 'market-preset-preview', 'benchmark', 'market-test'];
        if (isolatedReasons.includes(context.reason) || isolatedReasons.includes(context.meta?.reason)) return true;
        return false;
    }

    // ── Payload Hooks ──
    RBQ.on('buildNaiV4Payload', (payload, context) => {
        if (isIsolatedRequest(context)) {
            console.info('[Prompt Presets] 🧪 检测到工坊/基准独立测试环境 (Isolated Mode)，纯净跳过本地提示词预设与全局提示词注入');
            return payload;
        }

        const store = getStore();
        const preset = getActivePreset();
        const pos = store.position || 'prepend';
        const gPre = store.globalPositivePrefix || '';
        const gSuf = store.globalPositiveSuffix || '';
        const gNeg = store.globalNegative || '';
        const presetPos = preset ? (preset.positive || '') : '';
        const presetPosSuf = preset ? (preset.positiveSuffix || '') : '';
        const presetNeg = preset ? (preset.negative || '') : '';

        if (gPre || gSuf || presetPos || presetPosSuf) {
            payload.input = resolvePositivePrompt(payload.input, presetPos, presetPosSuf, gPre, gSuf, pos);
            if (payload.parameters?.v4_prompt?.caption) {
                payload.parameters.v4_prompt.caption.base_caption = resolvePositivePrompt(
                    payload.parameters.v4_prompt.caption.base_caption, presetPos, presetPosSuf, gPre, gSuf, pos
                );
            }
        }
        if (gNeg || presetNeg) {
            if (payload.parameters) {
                payload.parameters.negative_prompt = resolveNegativePrompt(
                    payload.parameters.negative_prompt, presetNeg, gNeg
                );
            }
            if (payload.parameters?.v4_negative_prompt?.caption) {
                payload.parameters.v4_negative_prompt.caption.base_caption = resolveNegativePrompt(
                    payload.parameters.v4_negative_prompt.caption.base_caption, presetNeg, gNeg
                );
            }
        }
        console.info('[Prompt Presets] NAI payload modified with presets/global prompts');
        return payload;
    });

    RBQ.on('buildGeneratePayload', (payload, context) => {
        if (isIsolatedRequest(context)) {
            console.info('[Prompt Presets] 🧪 检测到工坊/基准独立测试环境 (Isolated Mode)，纯净跳过本地提示词预设与全局提示词注入');
            return payload;
        }

        const store = getStore();
        const preset = getActivePreset();
        const pos = store.position || 'prepend';
        const gPre = store.globalPositivePrefix || '';
        const gSuf = store.globalPositiveSuffix || '';
        const gNeg = store.globalNegative || '';
        const presetPos = preset ? (preset.positive || '') : '';
        const presetPosSuf = preset ? (preset.positiveSuffix || '') : '';
        const presetNeg = preset ? (preset.negative || '') : '';

        if (gPre || gSuf || presetPos || presetPosSuf) {
            payload.positive_prompt = resolvePositivePrompt(payload.positive_prompt, presetPos, presetPosSuf, gPre, gSuf, pos);
        }
        if (gNeg || presetNeg) {
            payload.negative_prompt = resolveNegativePrompt(payload.negative_prompt, presetNeg, gNeg);
        }
        console.info('[Prompt Presets] Free payload modified with presets/global prompts');
        return payload;
    });

    RBQ.on('buildComfyUiWorkflow', (payload, context) => {
        if (isIsolatedRequest(context)) {
            console.info('[Prompt Presets] 🧪 检测到工坊/基准独立测试环境 (Isolated Mode)，纯净跳过本地提示词预设与全局提示词注入');
            return payload;
        }

        const store = getStore();
        const preset = getActivePreset();
        const pos = store.position || 'prepend';
        const gPre = store.globalPositivePrefix || '';
        const gSuf = store.globalPositiveSuffix || '';
        const gNeg = store.globalNegative || '';
        const presetPos = preset ? (preset.positive || '') : '';
        const presetPosSuf = preset ? (preset.positiveSuffix || '') : '';
        const presetNeg = preset ? (preset.negative || '') : '';

        for (const key of Object.keys(payload)) {
            const node = payload[key];
            if (!node || !node.inputs) continue;
            const cType = String(node.class_type || '');

            // 1. 标准 CLIPTextEncode 节点
            if (cType === 'CLIPTextEncode' && typeof node.inputs.text === 'string') {
                const isNeg = Object.values(payload).some(n =>
                    n?.inputs?.negative && Array.isArray(n.inputs.negative) && n.inputs.negative[0] === key
                ) || node._meta?.title?.toLowerCase()?.includes('negative') || node._meta?.title?.includes('负面') || node._meta?.title?.includes('反向');
                if (isNeg && (gNeg || presetNeg)) {
                    node.inputs.text = resolveNegativePrompt(node.inputs.text, presetNeg, gNeg);
                } else if (!isNeg && (gPre || gSuf || presetPos || presetPosSuf)) {
                    node.inputs.text = resolvePositivePrompt(node.inputs.text, presetPos, presetPosSuf, gPre, gSuf, pos);
                }
            }

            // 2. 支持 WeiLin 全能提示词编辑器 (WeiLinPromptUI) 及具有 positive 文本字段的节点
            if (typeof node.inputs.positive === 'string' && (gPre || gSuf || presetPos || presetPosSuf)) {
                node.inputs.positive = resolvePositivePrompt(node.inputs.positive, presetPos, presetPosSuf, gPre, gSuf, pos);
            }
            if (/WeiLin/i.test(cType) || /PromptUI/i.test(cType)) {
                if (node.inputs.auto_random !== undefined) {
                    node.inputs.auto_random = false;
                }
            }

            // 3. 支持第三方具有 negative 文本字段的节点
            if (typeof node.inputs.negative === 'string' && (gNeg || presetNeg)) {
                node.inputs.negative = resolveNegativePrompt(node.inputs.negative, presetNeg, gNeg);
            }

            // 4. 支持具有 prompt 文本字段的节点 (如 WeiLinPromptToString, CR Prompt Text 等)
            if (typeof node.inputs.prompt === 'string' && (gPre || gSuf || presetPos || presetPosSuf)) {
                const title = node._meta?.title || '';
                const isNeg = /neg|反向|负面/i.test(title);
                if (isNeg && (gNeg || presetNeg)) {
                    node.inputs.prompt = resolveNegativePrompt(node.inputs.prompt, presetNeg, gNeg);
                } else if (!isNeg && (gPre || gSuf || presetPos || presetPosSuf)) {
                    node.inputs.prompt = resolvePositivePrompt(node.inputs.prompt, presetPos, presetPosSuf, gPre, gSuf, pos);
                }
            }
        }
        console.info('[Prompt Presets] ComfyUI workflow modified with presets/global prompts');
        return payload;
    });

    // ── Global Profile Switch Listener ──
    RBQ.on('profile:switched', (event) => {
        const store = getStore();
        if (event?.profile?.data?.promptPresetsConfig) {
            const cfg = event.profile.data.promptPresetsConfig;
            store.globalPositivePrefix = cfg.globalPositivePrefix || '';
            store.globalPositiveSuffix = cfg.globalPositiveSuffix || '';
            store.globalNegative = cfg.globalNegative || '';
            store.activeId = cfg.activeId || '';
            store.position = cfg.position || 'prepend';
        } else {
            const hostStore = RBQ.api.getSettings?.()?.['_promptPresets'];
            store.globalPositivePrefix = hostStore?.globalPositivePrefix || '';
            store.globalPositiveSuffix = hostStore?.globalPositiveSuffix || '';
            store.globalNegative = hostStore?.globalNegative || '';
            store.activeId = hostStore?.activeId || '';
            store.position = hostStore?.position || 'prepend';
        }
        if (typeof renderPresetUi === 'function') {
            renderPresetUi();
        }
        const preset = getActivePreset();
        try {
            if (preset) {
                restorePresetVibesToHost(preset);
            } else {
                RBQ.api.setNaiVibes?.([], { source: 'plugin:preset-clear' });
                RBQ.api.refreshNaiVibeUi?.();
            }
        } catch (_e) {}
    });

    // ── Checkbox Dialog ──
    function showCheckboxDialog(title, items, onConfirm) {
        ensureDialogStyles();
        const overlay = document.createElement('div');
        overlay.className = 'rbq-pp-dialog-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'rbq-pp-dialog-box';

        const isDelete = typeof title === 'string' && title.includes('删除');
        const confirmBtnClass = isDelete ? 'rbq-pp-dialog-btn-danger' : 'rbq-pp-dialog-btn-primary';

        const closeDialog = () => {
            document.removeEventListener('keydown', onKeyDown);
            unmountRbqPpOverlay(overlay);
        };

        const onKeyDown = (e) => {
            if (e.key === 'Escape') closeDialog();
        };
        document.addEventListener('keydown', onKeyDown);

        const header = document.createElement('div');
        header.className = 'rbq-pp-dialog-header';
        header.innerHTML = `
            <div class="rbq-pp-dialog-title" title="${escapeHtml(title)}">
                <i class="fa-solid fa-list-check"></i>
                <span>${escapeHtml(title)}</span>
            </div>
            <button type="button" class="rbq-pp-dialog-close" title="关闭"><i class="fa-solid fa-xmark"></i></button>
        `;
        header.querySelector('.rbq-pp-dialog-close')?.addEventListener('click', closeDialog);

        const toolbar = document.createElement('div');
        toolbar.className = 'rbq-pp-dialog-toolbar';

        const selectAllWrap = document.createElement('label');
        selectAllWrap.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;-webkit-user-select:none;font-size:12px;color:rgba(255,255,255,0.7);margin:0;';
        const selectAllCb = document.createElement('input');
        selectAllCb.type = 'checkbox';
        selectAllCb.className = 'rbq-pp-dialog-checkbox';
        selectAllCb.checked = true;
        const selectAllText = document.createElement('span');
        selectAllText.textContent = '全选 / 取消全选';
        selectAllWrap.append(selectAllCb, selectAllText);

        const countBadge = document.createElement('span');
        countBadge.className = 'rbq-pp-dialog-count-badge';

        toolbar.append(selectAllWrap, countBadge);

        const listDiv = document.createElement('div');
        listDiv.className = 'rbq-pp-dialog-body';

        const checkboxes = [];
        const itemRows = [];

        function updateCounter() {
            const selectedCount = checkboxes.filter(cb => cb.checked).length;
            const totalCount = checkboxes.length;
            countBadge.textContent = `已选 ${selectedCount} / ${totalCount} 项`;
            if (selectedCount === 0) {
                selectAllCb.checked = false;
                selectAllCb.indeterminate = false;
            } else if (selectedCount === totalCount) {
                selectAllCb.checked = true;
                selectAllCb.indeterminate = false;
            } else {
                selectAllCb.checked = false;
                selectAllCb.indeterminate = true;
            }
            if (btnOk) {
                btnOk.disabled = selectedCount === 0;
            }
        }

        let btnOk;

        if (!items || items.length === 0) {
            const emptyEl = document.createElement('div');
            emptyEl.style.cssText = 'text-align:center;padding:24px 0;color:rgba(255,255,255,0.4);font-size:12px;';
            emptyEl.textContent = '无可选项目';
            listDiv.appendChild(emptyEl);
        } else {
            for (const item of items) {
                const row = document.createElement('div');
                row.className = 'rbq-pp-dialog-item selected';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'rbq-pp-dialog-checkbox';
                cb.checked = true;
                cb.dataset.itemId = item.id;

                const info = document.createElement('div');
                info.className = 'rbq-pp-dialog-item-info';

                let infoHtml = `<div class="rbq-pp-dialog-item-name">${escapeHtml(item.name || item.id)}</div>`;
                if (item.positive) {
                    infoHtml += `<div class="rbq-pp-dialog-item-tag pos" title="${escapeHtml(item.positive)}">正前: ${escapeHtml(item.positive.slice(0, 80))}</div>`;
                }
                if (item.positiveSuffix) {
                    infoHtml += `<div class="rbq-pp-dialog-item-tag pos" style="color:rgba(232, 121, 249, 0.7) !important;" title="${escapeHtml(item.positiveSuffix)}">正后: ${escapeHtml(item.positiveSuffix.slice(0, 80))}</div>`;
                }
                if (item.negative) {
                    infoHtml += `<div class="rbq-pp-dialog-item-tag neg" title="${escapeHtml(item.negative)}">负: ${escapeHtml(item.negative.slice(0, 80))}</div>`;
                }
                if (Array.isArray(item.vibes) && item.vibes.length > 0) {
                    infoHtml += `<div class="rbq-pp-dialog-item-tag" style="color:rgba(129, 140, 248, 0.8) !important;"><i class="fa-solid fa-box-archive"></i> 氛围特征 × ${item.vibes.length}</div>`;
                }
                info.innerHTML = infoHtml;

                row.append(cb, info);

                row.addEventListener('click', (e) => {
                    if (e.target !== cb) {
                        cb.checked = !cb.checked;
                    }
                    if (cb.checked) {
                        row.classList.add('selected');
                    } else {
                        row.classList.remove('selected');
                    }
                    updateCounter();
                });

                cb.addEventListener('change', () => {
                    if (cb.checked) {
                        row.classList.add('selected');
                    } else {
                        row.classList.remove('selected');
                    }
                    updateCounter();
                });

                listDiv.appendChild(row);
                checkboxes.push(cb);
                itemRows.push(row);
            }
        }

        selectAllCb.addEventListener('change', () => {
            const isChecked = selectAllCb.checked;
            checkboxes.forEach((cb, idx) => {
                cb.checked = isChecked;
                if (isChecked) {
                    itemRows[idx]?.classList.add('selected');
                } else {
                    itemRows[idx]?.classList.remove('selected');
                }
            });
            updateCounter();
        });

        const footer = document.createElement('div');
        footer.className = 'rbq-pp-dialog-footer';

        const btnCancel = document.createElement('button');
        btnCancel.type = 'button';
        btnCancel.className = 'rbq-pp-dialog-btn rbq-pp-dialog-btn-secondary';
        btnCancel.textContent = '取消';
        btnCancel.onclick = closeDialog;

        btnOk = document.createElement('button');
        btnOk.type = 'button';
        btnOk.className = `rbq-pp-dialog-btn ${confirmBtnClass}`;
        btnOk.textContent = isDelete ? '确认删除' : '确认';
        btnOk.onclick = () => {
            const selectedIds = checkboxes.filter(cb => cb.checked).map(cb => cb.dataset.itemId);
            closeDialog();
            onConfirm(selectedIds);
        };

        footer.append(btnCancel, btnOk);

        updateCounter();

        dialog.append(header, toolbar, listDiv, footer);
        dialog.addEventListener('click', (e) => e.stopPropagation());
        overlay.appendChild(dialog);

        // CRITICAL: stop bubbling from dialog elements too
        overlay.addEventListener('change', (e) => e.stopPropagation());
        overlay.addEventListener('input', (e) => e.stopPropagation());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDialog(); });
        overlay.addEventListener('touchmove', (e) => { if (e.target === overlay) e.preventDefault(); }, { passive: false });

        mountRbqPpOverlay(overlay);
    }

    // ── UI Injection ──
    function waitForPanel(cb) {
        const check = () => {
            const panel = document.querySelector('[data-kite-panel="prompt"]');
            if (panel) return cb(panel);
            setTimeout(check, 300);
        };
        check();
    }

    waitForPanel((panel) => {
        document.getElementById('rbq-prompt-presets-panel')?.remove();

        // ── Scoped Styles ──
        document.getElementById('rbq-pp-styles')?.remove();
        const styleEl = document.createElement('style');
        styleEl.id = 'rbq-pp-styles';
        styleEl.textContent = `
            #rbq-prompt-presets-panel {
                margin-top: 6px;
                display: flex;
                flex-direction: column;
                gap: 10px;
            }
            .rbq-pp-card {
                background: var(--linear-surface, #141517);
                border: 1px solid var(--linear-border-standard, rgba(255, 255, 255, 0.08));
                border-radius: 10px;
                padding: 12px;
                box-sizing: border-box;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
                transition: border-color 0.2s ease, box-shadow 0.2s ease;
            }
            .rbq-pp-card:hover {
                border-color: rgba(255, 255, 255, 0.12);
            }
            .rbq-pp-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
            }
            .rbq-pp-header-title {
                font-size: 13px;
                font-weight: 600;
                color: var(--linear-text-primary, #f7f8f8);
                display: flex;
                align-items: center;
                gap: 8px;
                letter-spacing: -0.2px;
            }
            .rbq-pp-header-icon {
                width: 26px;
                height: 26px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 7px;
                background: linear-gradient(135deg, rgba(94, 106, 210, 0.25), rgba(113, 112, 255, 0.1));
                color: #828fff;
                font-size: 12px;
                border: 1px solid rgba(94, 106, 210, 0.35);
                flex-shrink: 0;
            }
            .rbq-pp-header-badge {
                font-size: 10.5px;
                font-weight: 600;
                padding: 2px 8px;
                border-radius: 999px;
                background: rgba(255, 255, 255, 0.05);
                color: var(--linear-text-muted, #8a8f98);
                border: 1px solid var(--linear-border-subtle, rgba(255, 255, 255, 0.05));
                transition: all 0.2s ease;
            }
            .rbq-pp-collapsible-btn {
                display: flex;
                align-items: center;
                justify-content: space-between;
                width: 100%;
                background: transparent;
                border: none;
                padding: 0;
                color: inherit;
                cursor: pointer;
                font: inherit;
                text-align: left;
            }
            .rbq-pp-chevron {
                transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
                color: var(--linear-text-muted, #8a8f98);
                font-size: 11px;
            }
            .rbq-pp-collapsible-open .rbq-pp-chevron {
                transform: rotate(180deg);
            }
            .rbq-pp-field {
                display: flex;
                flex-direction: column;
                gap: 5px;
            }
            .rbq-pp-field-label {
                font-size: 11.5px;
                font-weight: 500;
                color: var(--linear-text-secondary, #d0d6e0);
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .rbq-pp-field-tag {
                font-size: 10px;
                font-weight: 600;
                padding: 1px 5px;
                border-radius: 4px;
                letter-spacing: 0.3px;
            }
            .rbq-pp-tag-prefix {
                background: rgba(56, 189, 248, 0.15);
                color: #38bdf8;
                border: 1px solid rgba(56, 189, 248, 0.3);
            }
            .rbq-pp-tag-suffix {
                background: rgba(232, 121, 249, 0.15);
                color: #e879f9;
                border: 1px solid rgba(232, 121, 249, 0.3);
            }
            .rbq-pp-tag-neg {
                background: rgba(248, 113, 113, 0.15);
                color: #f87171;
                border: 1px solid rgba(248, 113, 113, 0.3);
            }
            .rbq-pp-textarea, .rbq-pp-input {
                width: 100%;
                box-sizing: border-box;
                background: rgba(0, 0, 0, 0.25) !important;
                border: 1px solid var(--linear-border-standard, rgba(255, 255, 255, 0.08)) !important;
                border-radius: 6px !important;
                padding: 7px 10px !important;
                color: var(--linear-text-primary, #f7f8f8) !important;
                font-size: 12.5px !important;
                line-height: 1.5 !important;
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
                transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease !important;
            }
            .rbq-pp-textarea:focus, .rbq-pp-input:focus {
                outline: none !important;
                border-color: #5e6ad2 !important;
                box-shadow: 0 0 0 2px rgba(94, 106, 210, 0.25) !important;
                background: rgba(0, 0, 0, 0.35) !important;
            }
            .rbq-pp-selector-row {
                display: flex;
                gap: 8px;
                align-items: center;
            }
            .rbq-pp-select-wrap {
                flex: 1;
                position: relative;
                display: flex;
                align-items: center;
            }
            .rbq-pp-select {
                width: 100%;
                appearance: none;
                -webkit-appearance: none;
                background: var(--linear-surface, #191a1b);
                border: 1px solid var(--linear-border-standard, rgba(255, 255, 255, 0.1));
                color: var(--linear-text-primary, #f7f8f8);
                font-size: 12.5px;
                font-weight: 500;
                padding: 7px 28px 7px 10px;
                border-radius: 7px;
                outline: none;
                cursor: pointer;
                transition: all 0.15s ease;
                box-sizing: border-box;
            }
            .rbq-pp-select:hover {
                border-color: rgba(255, 255, 255, 0.2);
                background: var(--linear-surface-hover, #242528);
            }
            .rbq-pp-select:focus {
                border-color: #5e6ad2;
                box-shadow: 0 0 0 2px rgba(94, 106, 210, 0.25);
            }
            .rbq-pp-select-arrow {
                position: absolute;
                right: 10px;
                pointer-events: none;
                color: var(--linear-text-muted, #8a8f98);
                font-size: 10px;
            }

            .rbq-pp-toggle-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 8px 12px;
                background: var(--linear-bg-subtle, rgba(255, 255, 255, 0.02));
                border: 1px solid var(--linear-border-subtle, rgba(255, 255, 255, 0.05));
                border-radius: 8px;
                cursor: pointer;
                transition: background 0.15s ease;
                margin: 0;
            }
            .rbq-pp-toggle-row:hover {
                background: rgba(255, 255, 255, 0.04);
            }
            .rbq-pp-toggle-info {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }
            .rbq-pp-toggle-title {
                font-size: 12.5px;
                font-weight: 500;
                color: var(--linear-text-primary, #f7f8f8);
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .rbq-pp-toggle-sub {
                font-size: 11px;
                color: var(--linear-text-muted, #8a8f98);
            }
            .rbq-pp-switch {
                position: relative;
                display: inline-block;
                width: 36px;
                height: 20px;
                flex-shrink: 0;
            }
            .rbq-pp-switch input {
                opacity: 0;
                width: 0;
                height: 0;
                margin: 0;
            }
            .rbq-pp-slider {
                position: absolute;
                cursor: pointer;
                top: 0; left: 0; right: 0; bottom: 0;
                background-color: rgba(255, 255, 255, 0.15);
                transition: 0.2s cubic-bezier(0.16, 1, 0.3, 1);
                border-radius: 20px;
                border: 1px solid rgba(255, 255, 255, 0.05);
            }
            .rbq-pp-slider:before {
                position: absolute;
                content: "";
                height: 14px;
                width: 14px;
                left: 2px;
                bottom: 2px;
                background-color: #fff;
                transition: 0.2s cubic-bezier(0.16, 1, 0.3, 1);
                border-radius: 50%;
                box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
            }
            .rbq-pp-switch input:checked + .rbq-pp-slider {
                background-color: #5e6ad2;
                border-color: #7170ff;
            }
            .rbq-pp-switch input:checked + .rbq-pp-slider:before {
                transform: translateX(16px);
            }
            .rbq-pp-toolbar {
                display: grid;
                grid-template-columns: repeat(4, minmax(0, 1fr));
                gap: 8px;
            }
            @media (max-width: 520px) {
                .rbq-pp-toolbar {
                    grid-template-columns: repeat(2, minmax(0, 1fr));
                }
            }
            .rbq-pp-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                padding: 6px 10px;
                font-size: 12px;
                font-weight: 500;
                border-radius: 7px;
                cursor: pointer;
                border: 1px solid transparent;
                transition: all 0.15s ease;
                white-space: nowrap;
                text-decoration: none;
                box-sizing: border-box;
            }
            .rbq-pp-btn:active {
                transform: scale(0.98);
            }
            .rbq-pp-btn-primary {
                background: linear-gradient(135deg, #5e6ad2, #7170ff);
                color: #ffffff;
                box-shadow: 0 2px 6px rgba(94, 106, 210, 0.25);
                border-color: rgba(255, 255, 255, 0.15);
            }
            .rbq-pp-btn-primary:hover {
                background: linear-gradient(135deg, #6c78e0, #8281ff);
                box-shadow: 0 3px 10px rgba(94, 106, 210, 0.4);
            }
            .rbq-pp-btn-secondary {
                background: var(--linear-bg-subtle, rgba(255, 255, 255, 0.04));
                border-color: var(--linear-border-standard, rgba(255, 255, 255, 0.08));
                color: var(--linear-text-primary, #f7f8f8);
            }
            .rbq-pp-btn-secondary:hover {
                background: var(--linear-surface-hover, rgba(255, 255, 255, 0.08));
                border-color: rgba(255, 255, 255, 0.15);
            }
            .rbq-pp-btn-danger-ghost {
                background: rgba(239, 68, 68, 0.06);
                border-color: rgba(239, 68, 68, 0.18);
                color: #fca5a5;
            }
            .rbq-pp-btn-danger-ghost:hover {
                background: rgba(239, 68, 68, 0.12);
                border-color: rgba(239, 68, 68, 0.35);
                color: #ef4444;
            }
            #rbq-pp-editor {
                border-top: 2px solid #5e6ad2;
                animation: rbq-pp-fade-in 0.2s ease-out;
            }
            @keyframes rbq-pp-fade-in {
                from { opacity: 0; transform: translateY(-4px); }
                to { opacity: 1; transform: translateY(0); }
            }
            .rbq-pp-terminal {
                background: #0d0e11;
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 10px;
                overflow: hidden;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
            }
            .rbq-pp-terminal-bar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 7px 12px;
                background: rgba(255, 255, 255, 0.02);
                border-bottom: 1px solid rgba(255, 255, 255, 0.06);
                flex-wrap: wrap;
                gap: 6px;
            }
            .rbq-pp-terminal-left {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .rbq-pp-terminal-dots {
                display: flex;
                gap: 5px;
            }
            .rbq-pp-dot {
                width: 9px;
                height: 9px;
                border-radius: 50%;
            }
            .rbq-pp-dot-red { background: #ff5f56; }
            .rbq-pp-dot-yellow { background: #ffbd2e; }
            .rbq-pp-dot-green { background: #27c93f; }
            .rbq-pp-terminal-title {
                font-size: 11px;
                font-weight: 600;
                color: var(--linear-text-secondary, #d0d6e0);
                display: flex;
                align-items: center;
                gap: 6px;
                font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            }
            .rbq-pp-beacon {
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background: #38bdf8;
                box-shadow: 0 0 8px #38bdf8;
                animation: rbq-pp-ping 2s cubic-bezier(0, 0, 0.2, 1) infinite;
            }
            @keyframes rbq-pp-ping {
                0% { transform: scale(0.95); opacity: 0.8; }
                50% { transform: scale(1.3); opacity: 1; box-shadow: 0 0 10px #38bdf8; }
                100% { transform: scale(0.95); opacity: 0.8; }
            }
            .rbq-pp-copy-group {
                display: flex;
                align-items: center;
                background: rgba(255, 255, 255, 0.04);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 6px;
                padding: 2px;
                gap: 2px;
            }
            .rbq-pp-copy-btn {
                background: transparent;
                border: none;
                color: var(--linear-text-muted, #8a8f98);
                font-size: 11px;
                font-weight: 500;
                padding: 2px 7px;
                border-radius: 4px;
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 4px;
                transition: all 0.15s ease;
            }
            .rbq-pp-copy-btn:hover {
                color: var(--linear-text-primary, #f7f8f8);
                background: rgba(255, 255, 255, 0.06);
            }
            .rbq-pp-copy-btn.copied {
                color: #10b981 !important;
                background: rgba(16, 185, 129, 0.15) !important;
                font-weight: 600;
            }
            .rbq-pp-terminal-body {
                padding: 10px 12px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .rbq-pp-flow-bar {
                display: flex;
                align-items: center;
                gap: 5px;
                flex-wrap: wrap;
                padding: 6px 10px;
                background: rgba(0, 0, 0, 0.35);
                border: 1px solid rgba(255, 255, 255, 0.06);
                border-radius: 7px;
                margin-bottom: 2px;
            }
            .rbq-pp-flow-label {
                font-size: 10px;
                font-weight: 700;
                color: var(--linear-text-muted, #8a8f98);
                letter-spacing: 0.5px;
                margin-right: 2px;
                user-select: none;
            }
            .rbq-pp-flow-node {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 2px 7px;
                border-radius: 4px;
                font-size: 10.5px;
                font-weight: 500;
                transition: all 0.15s ease;
                white-space: nowrap;
                user-select: none;
            }
            .rbq-pp-flow-node.active.pre {
                background: rgba(56, 189, 248, 0.14);
                color: #38bdf8;
                border: 1px solid rgba(56, 189, 248, 0.3);
            }
            .rbq-pp-flow-node.active.preset {
                background: rgba(168, 85, 247, 0.14);
                color: #c084fc;
                border: 1px solid rgba(168, 85, 247, 0.3);
            }
            .rbq-pp-flow-node.dynamic {
                background: linear-gradient(135deg, rgba(94, 106, 210, 0.3), rgba(113, 112, 255, 0.2));
                color: #a5b4fc;
                border: 1px solid rgba(94, 106, 210, 0.5);
                font-weight: 600;
            }
            .rbq-pp-flow-node.active.suf {
                background: rgba(244, 114, 182, 0.14);
                color: #f472b6;
                border: 1px solid rgba(244, 114, 182, 0.3);
            }
            .rbq-pp-flow-node.dim {
                background: rgba(255, 255, 255, 0.02);
                color: rgba(255, 255, 255, 0.28);
                border: 1px dashed rgba(255, 255, 255, 0.08);
            }
            .rbq-pp-flow-arrow {
                color: rgba(255, 255, 255, 0.2);
                font-size: 9px;
            }
            .rbq-pp-code-box {
                background: rgba(0, 0, 0, 0.45);
                border: 1px solid rgba(255, 255, 255, 0.06);
                border-radius: 7px;
                padding: 8px 10px;
                font-size: 12px;
                line-height: 20px;
                color: #e2e8f0;
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
                word-break: break-word;
                max-height: 76px; /* 3 lines * 20px + 16px padding = 76px */
                overflow-y: auto;
                scrollbar-width: thin;
                scrollbar-color: rgba(255, 255, 255, 0.15) transparent;
                transition: max-height 0.25s cubic-bezier(0.16, 1, 0.3, 1);
                box-sizing: border-box;
            }
            .rbq-pp-code-box.expanded {
                max-height: 380px !important;
            }
            .rbq-pp-code-box::-webkit-scrollbar {
                width: 4px;
            }
            .rbq-pp-code-box::-webkit-scrollbar-thumb {
                background: rgba(255, 255, 255, 0.15);
                border-radius: 4px;
            }
            .rbq-pp-syntax-section {
                display: inline;
                line-height: inherit;
            }
            .rbq-pp-syntax-section.pre {
                color: #38bdf8;
            }
            .rbq-pp-syntax-section.preset {
                color: #c084fc;
            }
            .rbq-pp-syntax-section.suf {
                color: #f472b6;
            }
            .rbq-pp-syntax-section.neg-global {
                color: #fca5a5;
            }
            .rbq-pp-syntax-section.neg-preset {
                color: #fdba74;
            }
            .rbq-pp-syntax-chip {
                display: inline-flex;
                align-items: center;
                font-size: 9.5px;
                font-weight: 600;
                padding: 0 4px;
                height: 14px;
                line-height: 14px;
                border-radius: 3px;
                margin-right: 4px;
                vertical-align: 1px;
                font-family: system-ui, -apple-system, sans-serif;
                user-select: none;
            }
            .rbq-pp-syntax-chip.chip-pre {
                background: rgba(56, 189, 248, 0.18);
                color: #7dd3fc;
                border: 1px solid rgba(56, 189, 248, 0.35);
            }
            .rbq-pp-syntax-chip.chip-preset {
                background: rgba(168, 85, 247, 0.18);
                color: #d8b4fe;
                border: 1px solid rgba(168, 85, 247, 0.35);
            }
            .rbq-pp-syntax-chip.chip-suf {
                background: rgba(244, 114, 182, 0.18);
                color: #f9a8d4;
                border: 1px solid rgba(244, 114, 182, 0.35);
            }
            .rbq-pp-syntax-chip.chip-neg-global {
                background: rgba(248, 113, 113, 0.18);
                color: #fca5a5;
                border: 1px solid rgba(248, 113, 113, 0.35);
            }
            .rbq-pp-syntax-chip.chip-neg-preset {
                background: rgba(251, 146, 60, 0.18);
                color: #fdba74;
                border: 1px solid rgba(251, 146, 60, 0.35);
            }
            .rbq-pp-syntax-dynamic {
                display: inline-flex;
                align-items: center;
                gap: 3px;
                background: linear-gradient(135deg, rgba(94, 106, 210, 0.35), rgba(113, 112, 255, 0.2));
                color: #c7d2fe;
                border: 1px dashed rgba(129, 140, 248, 0.7);
                border-radius: 4px;
                padding: 0 6px;
                font-weight: 600;
                font-size: 11px;
                letter-spacing: 0.2px;
                vertical-align: 1px;
                margin: 0 2px;
                animation: rbq-pp-pulse-glow 2.5s infinite;
            }
            @keyframes rbq-pp-pulse-glow {
                0%, 100% { box-shadow: 0 0 0 rgba(94, 106, 210, 0); border-color: rgba(129, 140, 248, 0.7); }
                50% { box-shadow: 0 0 8px rgba(94, 106, 210, 0.4); border-color: #818cf8; }
            }
            .rbq-pp-syntax-comma {
                color: rgba(255, 255, 255, 0.35);
                font-weight: bold;
                margin-right: 3px;
            }
            .rbq-pp-copy-btn.active {
                color: #38bdf8 !important;
                background: rgba(56, 189, 248, 0.12) !important;
            }
            .rbq-pp-textarea.expanded {
                min-height: 180px !important;
            }
            .rbq-pp-segmented-tabs {
                display: inline-flex;
                background: rgba(0, 0, 0, 0.35);
                padding: 2px;
                border-radius: 8px;
                border: 1px solid var(--linear-border-standard, rgba(255, 255, 255, 0.08));
                gap: 3px;
            }
            .rbq-pp-tab {
                background: transparent;
                border: 1px solid transparent;
                color: var(--linear-text-muted, #8a8f98);
                font-size: 11px;
                font-weight: 500;
                padding: 3px 9px;
                border-radius: 6px;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                gap: 5px;
                transition: all 0.15s ease;
                user-select: none;
            }
            .rbq-pp-tab:hover {
                color: var(--linear-text-primary, #f7f8f8);
                background: rgba(255, 255, 255, 0.05);
            }
            .rbq-pp-tab.active {
                background: rgba(94, 106, 210, 0.28);
                color: #ffffff;
                font-weight: 600;
                border-color: rgba(94, 106, 210, 0.45);
                box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
            }
            .rbq-pp-tab-dot {
                width: 6px;
                height: 6px;
                border-radius: 50%;
                display: inline-block;
            }
            .rbq-pp-tab-dot.pre {
                background: #38bdf8;
                box-shadow: 0 0 5px #38bdf8;
            }
            .rbq-pp-tab-dot.suf {
                background: #e879f9;
                box-shadow: 0 0 5px #e879f9;
            }
            .rbq-pp-flow-node.active.preset-pre {
                background: rgba(168, 85, 247, 0.14);
                color: #c084fc;
                border: 1px solid rgba(168, 85, 247, 0.3);
            }
            .rbq-pp-flow-node.active.preset-suf {
                background: rgba(232, 121, 249, 0.14);
                color: #e879f9;
                border: 1px solid rgba(232, 121, 249, 0.3);
            }
            .rbq-pp-syntax-chip.chip-preset-pre {
                background: rgba(168, 85, 247, 0.2);
                color: #d8b4fe;
                border: 1px solid rgba(168, 85, 247, 0.35);
            }
            .rbq-pp-syntax-chip.chip-preset-suf {
                background: rgba(232, 121, 249, 0.2);
                color: #f0abfc;
                border: 1px solid rgba(232, 121, 249, 0.35);
            }
        `;
        document.head.appendChild(styleEl);

        const container = document.createElement('div');
        container.className = 'st-scene-trigger-subpanel rbq-pp-root';
        container.id = 'rbq-prompt-presets-panel';
        container.innerHTML = `
            <div class="rbq-pp-header" style="margin-bottom: 2px;">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div class="rbq-pp-header-icon">
                        <i class="fa-solid fa-bookmark"></i>
                    </div>
                    <div>
                        <div class="rbq-pp-header-title">提示词预设 <span style="font-size: 11px; opacity: 0.6; font-weight: 400; font-family: monospace;">Prompt Presets</span></div>
                        <div style="font-size: 11.5px; color: var(--linear-text-muted, #8a8f98); margin-top: 1px;">保存常用提示词组合为预设，生图时自动拼接到主提示词</div>
                    </div>
                </div>
            </div>

            <!-- 全局提示词卡片 (支持折叠收起以节省纵向空间，默认展开) -->
            <div class="rbq-pp-card" id="rbq-pp-global-card" style="padding: 10px 12px;">
                <button type="button" class="rbq-pp-collapsible-btn" id="rbq-pp-global-toggle" title="展开/收起全局提示词">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <i class="fa-solid fa-earth-americas" style="color: #38bdf8; font-size: 13px;"></i>
                        <span style="font-size: 12.5px; font-weight: 600; color: var(--linear-text-primary, #f7f8f8);">全局提示词</span>
                        <span style="font-size: 10.5px; color: var(--linear-text-muted, #8a8f98);">(无论选择何种预设均生效)</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span id="rbq-pp-global-status-badge" class="rbq-pp-header-badge" style="display: none; color: #38bdf8; background: rgba(56,189,248,0.1); border-color: rgba(56,189,248,0.25);">已生效</span>
                        <span class="rbq-pp-copy-btn rbq-pp-global-expand-btn" id="rbq-pp-global-expand-text" style="font-size: 11px; padding: 2px 7px; border-radius: 5px; display: inline-flex; align-items: center; gap: 4px;">
                            <i class="fa-solid fa-up-right-and-down-left-from-center"></i> <span>展开</span>
                        </span>
                        <i class="fa-solid fa-chevron-down rbq-pp-chevron"></i>
                    </div>
                </button>
                <div id="rbq-pp-global-content" style="display: none; flex-direction: column; gap: 10px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--linear-border-subtle, rgba(255, 255, 255, 0.05));">
                    <div class="rbq-pp-field">
                        <div class="rbq-pp-field-label" style="display: flex; justify-content: space-between; align-items: center;">
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <span class="rbq-pp-field-tag rbq-pp-tag-prefix">Prefix 前置</span>
                                <span>全局正面提示词</span>
                            </div>
                            <button type="button" class="rbq-pp-copy-btn rbq-pp-textarea-expand-btn" data-target="rbq-pp-global-pos-prefix" title="展开/收起输入框">
                                <i class="fa-solid fa-up-right-and-down-left-from-center"></i> <span>展开</span>
                            </button>
                        </div>
                        <textarea id="rbq-pp-global-pos-prefix" class="rbq-pp-textarea" data-action="plugin-ignore" rows="2" placeholder="例如: masterpiece, best quality, photorealistic... (始终拼在最前面)"></textarea>
                    </div>
                    <div class="rbq-pp-field">
                        <div class="rbq-pp-field-label" style="display: flex; justify-content: space-between; align-items: center;">
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <span class="rbq-pp-field-tag rbq-pp-tag-suffix">Suffix 后置</span>
                                <span>全局正面提示词</span>
                            </div>
                            <button type="button" class="rbq-pp-copy-btn rbq-pp-textarea-expand-btn" data-target="rbq-pp-global-pos-suffix" title="展开/收起输入框">
                                <i class="fa-solid fa-up-right-and-down-left-from-center"></i> <span>展开</span>
                            </button>
                        </div>
                        <textarea id="rbq-pp-global-pos-suffix" class="rbq-pp-textarea" data-action="plugin-ignore" rows="2" placeholder="例如: year 2025, cinematic lighting... (始终拼在最后面)"></textarea>
                    </div>
                    <div class="rbq-pp-field">
                        <div class="rbq-pp-field-label" style="display: flex; justify-content: space-between; align-items: center;">
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <span class="rbq-pp-field-tag rbq-pp-tag-neg">Negative</span>
                                <span>全局负面提示词</span>
                            </div>
                            <button type="button" class="rbq-pp-copy-btn rbq-pp-textarea-expand-btn" data-target="rbq-pp-global-negative" title="展开/收起输入框">
                                <i class="fa-solid fa-up-right-and-down-left-from-center"></i> <span>展开</span>
                            </button>
                        </div>
                        <textarea id="rbq-pp-global-negative" class="rbq-pp-textarea" data-action="plugin-ignore" rows="2" placeholder="例如: lowres, bad anatomy, worst quality... (自动合并生效)"></textarea>
                    </div>
                </div>
            </div>

            <!-- 预设选择器 -->
            <div class="rbq-pp-selector-row">
                <div class="rbq-pp-select-wrap">
                    <select id="rbq-pp-select" class="rbq-pp-select" data-action="plugin-ignore"></select>
                    <i class="fa-solid fa-chevron-down rbq-pp-select-arrow"></i>
                </div>
            </div>

            <!-- 当前预设编辑画布 (仅在选中预设时展示) -->
            <div id="rbq-pp-editor" class="rbq-pp-card" style="display: none; flex-direction: column; gap: 10px;">
                <div style="display: flex; align-items: center; justify-content: space-between;">
                    <div style="font-size: 12px; font-weight: 600; color: #a78bfa; display: flex; align-items: center; gap: 6px;">
                        <i class="fa-solid fa-sliders"></i>
                        <span>编辑当前预设</span>
                    </div>
                    <span style="font-size: 10.5px; color: var(--linear-text-muted, #8a8f98);">保存时自动记录当前 NAI 氛围图 (Vibe) 状态</span>
                </div>
                <div class="rbq-pp-field">
                    <div class="rbq-pp-field-label">
                        <span>预设名称</span>
                    </div>
                    <input id="rbq-pp-name" class="rbq-pp-input" data-action="plugin-ignore" type="text" placeholder="例如: 高质量通用">
                </div>
                <div class="rbq-pp-field">
                    <!-- 正面词分段切换栏 (前置 / 后置独立编辑且同时生效) -->
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px;">
                        <div class="rbq-pp-segmented-tabs">
                            <button type="button" id="rbq-pp-tab-pre" class="rbq-pp-tab active" data-tab="prepend">
                                <i class="fa-solid fa-arrow-left" style="font-size: 10px;"></i>
                                <span>前置词 (Prepend)</span>
                                <span id="rbq-pp-dot-pre" class="rbq-pp-tab-dot pre" style="display: none;" title="已配置前置词"></span>
                            </button>
                            <button type="button" id="rbq-pp-tab-suf" class="rbq-pp-tab" data-tab="append">
                                <i class="fa-solid fa-arrow-right" style="font-size: 10px;"></i>
                                <span>后置词 (Append)</span>
                                <span id="rbq-pp-dot-suf" class="rbq-pp-tab-dot suf" style="display: none;" title="已配置后置词"></span>
                            </button>
                        </div>
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <span id="rbq-pp-both-indicator" class="rbq-pp-header-badge" style="display: none; color: #4ade80; background: rgba(74, 222, 128, 0.1); border-color: rgba(74, 222, 128, 0.25); font-size: 10.5px;">
                                <i class="fa-solid fa-link" style="font-size: 9px; margin-right: 3px;"></i>前后双置均生效
                            </span>
                            <button type="button" class="rbq-pp-copy-btn rbq-pp-textarea-expand-btn" data-target="rbq-pp-positive" title="展开/收起输入框">
                                <i class="fa-solid fa-up-right-and-down-left-from-center"></i> <span>展开</span>
                            </button>
                        </div>
                    </div>
                    <textarea id="rbq-pp-positive" class="rbq-pp-textarea" data-action="plugin-ignore" rows="3" placeholder="例如: masterpiece, best quality, highly detailed... (拼在正文分镜动态词之前)"></textarea>
                </div>
                <div class="rbq-pp-field">
                    <div class="rbq-pp-field-label" style="display: flex; justify-content: space-between; align-items: center;">
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #f87171; box-shadow: 0 0 6px #f87171;"></span>
                            <span>预设负面提示词</span>
                        </div>
                        <button type="button" class="rbq-pp-copy-btn rbq-pp-textarea-expand-btn" data-target="rbq-pp-negative" title="展开/收起输入框">
                            <i class="fa-solid fa-up-right-and-down-left-from-center"></i> <span>展开</span>
                        </button>
                    </div>
                    <textarea id="rbq-pp-negative" class="rbq-pp-textarea" data-action="plugin-ignore" rows="3" placeholder="例如: lowres, bad anatomy, worst quality..."></textarea>
                </div>
                <div style="display: flex; gap: 8px; justify-content: flex-end; align-items: center; margin-top: 4px; padding-top: 8px; border-top: 1px solid var(--linear-border-subtle, rgba(255, 255, 255, 0.05));">
                    <button id="rbq-pp-delete" type="button" class="rbq-pp-btn rbq-pp-btn-danger-ghost">
                        <i class="fa-solid fa-trash"></i> 删除预设
                    </button>
                    <button id="rbq-pp-save" type="button" class="rbq-pp-btn rbq-pp-btn-primary">
                        <i class="fa-solid fa-floppy-disk"></i> 保存预设
                    </button>
                </div>
            </div>

            <!-- 悬浮球快捷切换 (iOS / Linear 风格 Switch Toggle) -->
            <label class="rbq-pp-toggle-row" for="rbq-pp-show-floating">
                <div class="rbq-pp-toggle-info">
                    <span class="rbq-pp-toggle-title">
                        <i class="fa-solid fa-wand-magic-sparkles" style="color: #a78bfa;"></i>
                        在悬浮球菜单中显示快捷切换
                    </span>
                    <span class="rbq-pp-toggle-sub">生图悬浮球打开后可在子菜单一键切换生效预设</span>
                </div>
                <div class="rbq-pp-switch">
                    <input type="checkbox" id="rbq-pp-show-floating" data-action="plugin-ignore">
                    <span class="rbq-pp-slider"></span>
                </div>
            </label>

            <!-- 操作工具栏 -->
            <div class="rbq-pp-toolbar">
                <button id="rbq-pp-new" type="button" class="rbq-pp-btn rbq-pp-btn-secondary" style="border-color: rgba(94,106,210,0.35); color: #828fff;">
                    <i class="fa-solid fa-plus"></i> 新建预设
                </button>
                <button id="rbq-pp-export" type="button" class="rbq-pp-btn rbq-pp-btn-secondary">
                    <i class="fa-solid fa-file-export"></i> 导出预设
                </button>
                <button id="rbq-pp-import-btn" type="button" class="rbq-pp-btn rbq-pp-btn-secondary">
                    <i class="fa-solid fa-file-import"></i> 导入预设
                </button>
                <button id="rbq-pp-batch-delete" type="button" class="rbq-pp-btn rbq-pp-btn-danger-ghost">
                    <i class="fa-solid fa-trash-can"></i> 批量删除
                </button>
                <input id="rbq-pp-import-file" type="file" accept=".json,application/json,text/plain" hidden>
            </div>

            <!-- 动态合成实时预览卡片 (Terminal Inspector) -->
            <div id="rbq-pp-live-preview-box" class="rbq-pp-terminal">
                <div class="rbq-pp-terminal-bar">
                    <div class="rbq-pp-terminal-left">
                        <div class="rbq-pp-terminal-dots">
                            <span class="rbq-pp-dot rbq-pp-dot-red"></span>
                            <span class="rbq-pp-dot rbq-pp-dot-yellow"></span>
                            <span class="rbq-pp-dot rbq-pp-dot-green"></span>
                        </div>
                        <div class="rbq-pp-terminal-title">
                            <span class="rbq-pp-beacon"></span>
                            <span>LIVE PROMPT PIPELINE</span>
                        </div>
                    </div>
                    <div class="rbq-pp-copy-group">
                        <button id="rbq-pp-expand-toggle" class="rbq-pp-copy-btn" type="button" title="切换完整视图 / 紧凑视图">
                            <i class="fa-solid fa-up-right-and-down-left-from-center"></i> <span>展开</span>
                        </button>
                        <div style="width: 1px; height: 12px; background: rgba(255,255,255,0.1);"></div>
                        <button id="rbq-pp-copy-pos-preview" class="rbq-pp-copy-btn" type="button" title="复制正面提示词合成模板">
                            <i class="fa-regular fa-copy"></i> <span>复制正面</span>
                        </button>
                        <div style="width: 1px; height: 12px; background: rgba(255,255,255,0.1);"></div>
                        <button id="rbq-pp-copy-neg-preview" class="rbq-pp-copy-btn" type="button" title="复制负面提示词合成模板">
                            <i class="fa-regular fa-copy"></i> <span>复制负面</span>
                        </button>
                    </div>
                </div>
                <div class="rbq-pp-terminal-body">
                    <!-- 拼接拓扑指示条 -->
                    <div id="rbq-pp-flow-bar" class="rbq-pp-flow-bar"></div>

                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <div style="font-size: 11px; color: var(--linear-text-muted, #8a8f98); display: flex; align-items: center; justify-content: space-between;">
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <span style="color: #38bdf8; font-weight: 600; font-family: monospace;">[POSITIVE]</span>
                                <span>发送至生图引擎的最终正面提示词：</span>
                            </div>
                            <span id="rbq-pp-pos-count" style="font-size: 10px; color: rgba(255,255,255,0.3); font-family: monospace;"></span>
                        </div>
                        <div id="rbq-pp-preview-positive" class="rbq-pp-code-box"></div>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <div style="font-size: 11px; color: var(--linear-text-muted, #8a8f98); display: flex; align-items: center; justify-content: space-between;">
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <span style="color: #f87171; font-weight: 600; font-family: monospace;">[NEGATIVE]</span>
                                <span>最终负面提示词：</span>
                            </div>
                            <span id="rbq-pp-neg-count" style="font-size: 10px; color: rgba(255,255,255,0.3); font-family: monospace;"></span>
                        </div>
                        <div id="rbq-pp-preview-negative" class="rbq-pp-code-box" style="max-height: 56px;"></div>
                    </div>
                </div>
            </div>
        `;

        const helpBox = panel.querySelector('.st-scene-trigger-help-box');
        if (helpBox) {
            helpBox.parentElement.insertBefore(container, helpBox);
            helpBox.style.display = 'none';
        } else {
            panel.appendChild(container);
        }
        const oldPreviewBox = panel.querySelector('.st-scene-trigger-preview-box');
        if (oldPreviewBox) oldPreviewBox.style.display = 'none';

        // CRITICAL: Stop change events from bubbling out of our plugin UI
        // The host modal has a global 'change' listener that calls saveFromModal(),
        // which would reset the NAI URL to official if triggered from here.
        container.addEventListener('change', (e) => e.stopPropagation());
        container.addEventListener('input', (e) => e.stopPropagation());

        const globalPosPreInput = document.getElementById('rbq-pp-global-pos-prefix');
        const globalPosSufInput = document.getElementById('rbq-pp-global-pos-suffix');
        const globalNegInput = document.getElementById('rbq-pp-global-negative');
        const globalToggle = document.getElementById('rbq-pp-global-toggle');
        const globalContent = document.getElementById('rbq-pp-global-content');
        const globalStatusBadge = document.getElementById('rbq-pp-global-status-badge');
        const globalExpandText = document.getElementById('rbq-pp-global-expand-text');
        const select = document.getElementById('rbq-pp-select');
        const floatingCheckbox = document.getElementById('rbq-pp-show-floating');
        const editor = document.getElementById('rbq-pp-editor');
        const nameInput = document.getElementById('rbq-pp-name');
        const posInput = document.getElementById('rbq-pp-positive');
        const negInput = document.getElementById('rbq-pp-negative');
        const tabPre = document.getElementById('rbq-pp-tab-pre');
        const tabSuf = document.getElementById('rbq-pp-tab-suf');
        const dotPre = document.getElementById('rbq-pp-dot-pre');
        const dotSuf = document.getElementById('rbq-pp-dot-suf');
        const bothBadge = document.getElementById('rbq-pp-both-indicator');

        let activePositiveTab = 'prepend';

        function updateGlobalBadge() {
            const pre = (globalPosPreInput?.value || '').trim();
            const suf = (globalPosSufInput?.value || '').trim();
            const neg = (globalNegInput?.value || '').trim();
            let count = 0;
            if (pre) count++;
            if (suf) count++;
            if (neg) count++;
            if (globalStatusBadge) {
                if (count > 0) {
                    globalStatusBadge.textContent = `已配置 (${count})`;
                    globalStatusBadge.style.display = 'inline-flex';
                } else {
                    globalStatusBadge.style.display = 'none';
                }
            }
        }

        function updateGlobalExpandBtn(expanded) {
            if (!globalExpandText) return;
            const icon = globalExpandText.querySelector('i');
            const span = globalExpandText.querySelector('span');
            if (expanded) {
                if (icon) icon.className = 'fa-solid fa-down-left-and-up-right-to-center';
                if (span) span.textContent = '收起';
                globalExpandText.classList.add('active');
            } else {
                if (icon) icon.className = 'fa-solid fa-up-right-and-down-left-from-center';
                if (span) span.textContent = '展开';
                globalExpandText.classList.remove('active');
            }
        }

        let isGlobalExpanded = getStore().globalExpanded !== false;
        globalToggle?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            isGlobalExpanded = !isGlobalExpanded;
            getStore().globalExpanded = isGlobalExpanded;
            save();
            if (globalContent) globalContent.style.display = isGlobalExpanded ? 'flex' : 'none';
            globalToggle.classList.toggle('rbq-pp-collapsible-open', isGlobalExpanded);
            updateGlobalExpandBtn(isGlobalExpanded);
        });

        // 通用输入框展开/紧凑切换
        container.querySelectorAll('.rbq-pp-textarea-expand-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const targetId = btn.getAttribute('data-target');
                const targetEl = document.getElementById(targetId);
                if (!targetEl) return;
                const isExp = targetEl.classList.toggle('expanded');
                const icon = btn.querySelector('i');
                const span = btn.querySelector('span');
                if (isExp) {
                    if (icon) icon.className = 'fa-solid fa-down-left-and-up-right-to-center';
                    if (span) span.textContent = '收起';
                    btn.classList.add('active');
                } else {
                    if (icon) icon.className = 'fa-solid fa-up-right-and-down-left-from-center';
                    if (span) span.textContent = '展开';
                    btn.classList.remove('active');
                }
            });
        });

        function updateTabDots() {
            const preset = getActivePreset();
            if (!preset) {
                if (dotPre) dotPre.style.display = 'none';
                if (dotSuf) dotSuf.style.display = 'none';
                if (bothBadge) bothBadge.style.display = 'none';
                return;
            }
            const preVal = (activePositiveTab === 'prepend' ? posInput?.value : preset.positive || '').trim();
            const sufVal = (activePositiveTab === 'append' ? posInput?.value : preset.positiveSuffix || '').trim();
            if (dotPre) dotPre.style.display = preVal ? 'inline-block' : 'none';
            if (dotSuf) dotSuf.style.display = sufVal ? 'inline-block' : 'none';
            if (bothBadge) bothBadge.style.display = (preVal && sufVal) ? 'inline-flex' : 'none';
        }

        function switchPositiveTab(targetTab) {
            const preset = getActivePreset();
            if (preset && posInput) {
                if (activePositiveTab === 'prepend') {
                    preset.positive = posInput.value.trim();
                } else {
                    preset.positiveSuffix = posInput.value.trim();
                }
            }
            activePositiveTab = targetTab === 'append' ? 'append' : 'prepend';
            if (tabPre) tabPre.classList.toggle('active', activePositiveTab === 'prepend');
            if (tabSuf) tabSuf.classList.toggle('active', activePositiveTab === 'append');
            if (posInput) {
                if (activePositiveTab === 'prepend') {
                    posInput.value = preset?.positive || '';
                    posInput.placeholder = '例如: masterpiece, best quality, highly detailed... (拼在正文分镜动态词之前)';
                } else {
                    posInput.value = preset?.positiveSuffix || '';
                    posInput.placeholder = '例如: year 2025, cinematic lighting... (拼在正文分镜动态词之后)';
                }
            }
            updateTabDots();
            renderLivePreview();
        }

        tabPre?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            switchPositiveTab('prepend');
        });

        tabSuf?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            switchPositiveTab('append');
        });

        function renderLivePreview() {
            const store = getStore();
            const preset = getActivePreset();
            const pos = store.position || 'prepend';
            const gPre = (globalPosPreInput?.value ?? store.globalPositivePrefix ?? '').trim();
            const gSuf = (globalPosSufInput?.value ?? store.globalPositiveSuffix ?? '').trim();
            const gNeg = (globalNegInput?.value ?? store.globalNegative ?? '').trim();

            let presetPos = '';
            let presetPosSuf = '';
            if (preset) {
                if (activePositiveTab === 'prepend') {
                    presetPos = (posInput?.value ?? preset.positive ?? '').trim();
                    presetPosSuf = (preset.positiveSuffix ?? '').trim();
                } else {
                    presetPos = (preset.positive ?? '').trim();
                    presetPosSuf = (posInput?.value ?? preset.positiveSuffix ?? '').trim();
                }
            }
            const presetNeg = preset ? (negInput?.value ?? preset.negative ?? '').trim() : '';

            // 1. 渲染顶部拼接拓扑指示条
            const flowBar = document.getElementById('rbq-pp-flow-bar');
            if (flowBar) {
                const arrow = `<i class="fa-solid fa-angle-right rbq-pp-flow-arrow"></i>`;
                let flowItems = [];
                flowItems.push(`<span class="rbq-pp-flow-label"><i class="fa-solid fa-timeline"></i> 流向:</span>`);

                if (gPre) {
                    flowItems.push(`<span class="rbq-pp-flow-node active pre" title="全局前缀已启用 (${gPre.length} 字符)"><i class="fa-solid fa-earth-americas"></i> 全局前缀</span>`);
                } else {
                    flowItems.push(`<span class="rbq-pp-flow-node dim" title="未设置全局前缀"><i class="fa-solid fa-earth-americas"></i> (无前缀)</span>`);
                }

                if (presetPos) {
                    flowItems.push(`<span class="rbq-pp-flow-node active preset-pre" title="预设前置: ${escapeHtml(preset?.name || '')} (${presetPos.length} 字符)"><i class="fa-solid fa-bookmark"></i> 预设前置</span>`);
                } else {
                    flowItems.push(`<span class="rbq-pp-flow-node dim" title="当前无预设前置词"><i class="fa-regular fa-bookmark"></i> (无预设前置)</span>`);
                }

                flowItems.push(`<span class="rbq-pp-flow-node dynamic" title="正文剧情/分镜生图时提取的动态提示词"><i class="fa-solid fa-bolt"></i> 动态分镜词</span>`);

                if (presetPosSuf) {
                    flowItems.push(`<span class="rbq-pp-flow-node active preset-suf" title="预设后置: ${escapeHtml(preset?.name || '')} (${presetPosSuf.length} 字符)"><i class="fa-solid fa-bookmark"></i> 预设后置</span>`);
                } else {
                    flowItems.push(`<span class="rbq-pp-flow-node dim" title="当前无预设后置词"><i class="fa-regular fa-bookmark"></i> (无预设后置)</span>`);
                }

                if (gSuf) {
                    flowItems.push(`<span class="rbq-pp-flow-node active suf" title="全局后缀已启用 (${gSuf.length} 字符)"><i class="fa-solid fa-flag"></i> 全局后缀</span>`);
                } else {
                    flowItems.push(`<span class="rbq-pp-flow-node dim" title="未设置全局后缀"><i class="fa-regular fa-flag"></i> (无后缀)</span>`);
                }

                flowBar.innerHTML = flowItems.join(arrow);
            }

            // 2. 渲染正面提示词 (流式语法高亮)
            const posContainer = document.getElementById('rbq-pp-preview-positive');
            if (posContainer) {
                const dummyDynamic = '<span class="rbq-pp-syntax-dynamic" title="动态剧情/分镜生图提示词"><i class="fa-solid fa-bolt" style="font-size:10px;margin-right:3px;"></i>剧情分镜提示词</span>';
                let parts = [];
                let totalChars = 0;

                if (gPre) {
                    parts.push(`<span class="rbq-pp-syntax-section pre" title="全局正面前缀"><span class="rbq-pp-syntax-chip chip-pre">前缀</span>${escapeHtml(gPre)}</span>`);
                    totalChars += gPre.length;
                }
                if (presetPos) {
                    parts.push(`<span class="rbq-pp-syntax-section preset" title="预设正面词 (前置)"><span class="rbq-pp-syntax-chip chip-preset-pre">预设前置</span>${escapeHtml(presetPos)}</span>`);
                    totalChars += presetPos.length;
                }
                parts.push(dummyDynamic);
                if (presetPosSuf) {
                    parts.push(`<span class="rbq-pp-syntax-section preset" title="预设正面词 (后置)"><span class="rbq-pp-syntax-chip chip-preset-suf">预设后置</span>${escapeHtml(presetPosSuf)}</span>`);
                    totalChars += presetPosSuf.length;
                }
                if (gSuf) {
                    parts.push(`<span class="rbq-pp-syntax-section suf" title="全局正面后缀"><span class="rbq-pp-syntax-chip chip-suf">后缀</span>${escapeHtml(gSuf)}</span>`);
                    totalChars += gSuf.length;
                }
                posContainer.innerHTML = parts.join('<span class="rbq-pp-syntax-comma">, </span>');

                const posCountEl = document.getElementById('rbq-pp-pos-count');
                if (posCountEl) {
                    posCountEl.textContent = `${totalChars} 字符 (预置)`;
                }
            }

            // 3. 渲染负面提示词 (流式语法高亮)
            const negContainer = document.getElementById('rbq-pp-preview-negative');
            if (negContainer) {
                let negParts = [];
                let totalNegChars = 0;
                if (gNeg) {
                    negParts.push(`<span class="rbq-pp-syntax-section neg-global" title="全局负面词"><span class="rbq-pp-syntax-chip chip-neg-global">全局</span>${escapeHtml(gNeg)}</span>`);
                    totalNegChars += gNeg.length;
                }
                if (presetNeg) {
                    negParts.push(`<span class="rbq-pp-syntax-section neg-preset" title="预设负面词"><span class="rbq-pp-syntax-chip chip-neg-preset">预设</span>${escapeHtml(presetNeg)}</span>`);
                    totalNegChars += presetNeg.length;
                }
                negContainer.innerHTML = negParts.length
                    ? negParts.join('<span class="rbq-pp-syntax-comma">, </span>')
                    : '<span style="color:rgba(255,255,255,0.25);font-style:italic;">(未设置负面提示词)</span>';

                const negCountEl = document.getElementById('rbq-pp-neg-count');
                if (negCountEl) {
                    negCountEl.textContent = totalNegChars > 0 ? `${totalNegChars} 字符` : '';
                }
            }
        }

        let globalInputTimer = null;
        const debounceSaveGlobal = () => {
            clearTimeout(globalInputTimer);
            globalInputTimer = setTimeout(() => {
                save();
            }, 300);
        };

        globalPosPreInput?.addEventListener('input', () => {
            getStore().globalPositivePrefix = globalPosPreInput.value;
            debounceSaveGlobal();
            updateGlobalBadge();
            renderLivePreview();
        });
        globalPosPreInput?.addEventListener('change', () => {
            clearTimeout(globalInputTimer);
            save();
        });

        globalPosSufInput?.addEventListener('input', () => {
            getStore().globalPositiveSuffix = globalPosSufInput.value;
            debounceSaveGlobal();
            updateGlobalBadge();
            renderLivePreview();
        });
        globalPosSufInput?.addEventListener('change', () => {
            clearTimeout(globalInputTimer);
            save();
        });

        globalNegInput?.addEventListener('input', () => {
            getStore().globalNegative = globalNegInput.value;
            debounceSaveGlobal();
            updateGlobalBadge();
            renderLivePreview();
        });
        globalNegInput?.addEventListener('change', () => {
            clearTimeout(globalInputTimer);
            save();
        });

        posInput?.addEventListener('input', () => {
            const preset = getActivePreset();
            if (preset) {
                if (activePositiveTab === 'prepend') {
                    preset.positive = posInput.value;
                } else {
                    preset.positiveSuffix = posInput.value;
                }
                updateTabDots();
            }
            renderLivePreview();
        });

        negInput?.addEventListener('input', () => {
            renderLivePreview();
        });

        let copyPosTimer = null;
        document.getElementById('rbq-pp-copy-pos-preview')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const store = getStore();
            const preset = getActivePreset();
            const pos = store.position || 'prepend';
            const gPre = (globalPosPreInput?.value ?? store.globalPositivePrefix ?? '').trim();
            const gSuf = (globalPosSufInput?.value ?? store.globalPositiveSuffix ?? '').trim();
            let presetPos = '';
            let presetPosSuf = '';
            if (preset) {
                if (activePositiveTab === 'prepend') {
                    presetPos = (posInput?.value ?? preset.positive ?? '').trim();
                    presetPosSuf = (preset.positiveSuffix ?? '').trim();
                } else {
                    presetPos = (preset.positive ?? '').trim();
                    presetPosSuf = (posInput?.value ?? preset.positiveSuffix ?? '').trim();
                }
            }
            const assembled = resolvePositivePrompt('{prompt}', presetPos, presetPosSuf, gPre, gSuf, pos);

            const showFeedback = () => {
                const icon = btn.querySelector('i');
                const textSpan = btn.querySelector('span');
                if (icon) icon.className = 'fa-solid fa-check';
                if (textSpan) textSpan.textContent = '已复制!';
                btn.classList.add('copied');
                clearTimeout(copyPosTimer);
                copyPosTimer = setTimeout(() => {
                    if (icon) icon.className = 'fa-regular fa-copy';
                    if (textSpan) textSpan.textContent = '复制正面';
                    btn.classList.remove('copied');
                }, 1800);
            };

            const ok = await copyToClipboard(assembled);
            if (ok) {
                showFeedback();
                toastr.success('已复制正面合成模板');
            } else {
                toastr.warning('复制失败，请手动选取', '提示词预设');
            }
        });

        let copyNegTimer = null;
        document.getElementById('rbq-pp-copy-neg-preview')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const store = getStore();
            const preset = getActivePreset();
            const gNeg = (globalNegInput?.value ?? store.globalNegative ?? '').trim();
            const presetNeg = preset ? (negInput?.value ?? preset.negative ?? '').trim() : '';
            const assembled = resolveNegativePrompt('', presetNeg, gNeg);
            if (!assembled) {
                toastr.warning('当前无负面提示词');
                return;
            }

            const showFeedback = () => {
                const icon = btn.querySelector('i');
                const textSpan = btn.querySelector('span');
                if (icon) icon.className = 'fa-solid fa-check';
                if (textSpan) textSpan.textContent = '已复制!';
                btn.classList.add('copied');
                clearTimeout(copyNegTimer);
                copyNegTimer = setTimeout(() => {
                    if (icon) icon.className = 'fa-regular fa-copy';
                    if (textSpan) textSpan.textContent = '复制负面';
                    btn.classList.remove('copied');
                }, 1800);
            };

            const ok = await copyToClipboard(assembled);
            if (ok) {
                showFeedback();
                toastr.success('已复制负面合成结果');
            } else {
                toastr.warning('复制失败，请手动选取', '提示词预设');
            }
        });

        let isPreviewExpanded = false;
        document.getElementById('rbq-pp-expand-toggle')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            isPreviewExpanded = !isPreviewExpanded;
            const posBox = document.getElementById('rbq-pp-preview-positive');
            const negBox = document.getElementById('rbq-pp-preview-negative');
            const btn = document.getElementById('rbq-pp-expand-toggle');
            posBox?.classList.toggle('expanded', isPreviewExpanded);
            negBox?.classList.toggle('expanded', isPreviewExpanded);
            const icon = btn?.querySelector('i');
            const span = btn?.querySelector('span');
            if (isPreviewExpanded) {
                if (icon) icon.className = 'fa-solid fa-down-left-and-up-right-to-center';
                if (span) span.textContent = '收起';
                btn?.classList.add('active');
            } else {
                if (icon) icon.className = 'fa-solid fa-up-right-and-down-left-from-center';
                if (span) span.textContent = '展开';
                btn?.classList.remove('active');
            }
        });

        function applyPresetSelection(nextId) {
            const store = getStore();
            store.activeId = String(nextId || '');
            save();

            // 先同步编辑区与两个选择器，避免后续 Vibe 恢复异常时 UI 停留在旧预设。
            renderSelect();

            const preset = getActivePreset();
            try {
                if (preset) {
                    restorePresetVibesToHost(preset);
                } else {
                    const currentVibes = getCurrentNaiVibes();
                    if (currentVibes.length > 0) {
                        RBQ.api.setNaiVibes?.([], { source: 'plugin:preset-clear' });
                        RBQ.api.refreshNaiVibeUi?.();
                    }
                }
            } catch (err) {
                console.error('[Prompt Presets] Failed to restore preset state:', err);
                toastr.error('切换预设时恢复氛围图失败: ' + (err?.message || String(err)));
            }
        }

        function syncFloatingMenu() {
            const store = getStore();
            let pMenu = document.getElementById('rbq-pp-floating-wrap');

            if (store.showFloating) {
                if (!pMenu) {
                    pMenu = document.createElement('div');
                    pMenu.id = 'rbq-pp-floating-wrap';
                    pMenu.className = 'st-scene-trigger-floating-item';
                    pMenu.style.cssText = 'padding:8px 10px; cursor:default;';
                    pMenu.innerHTML = '<i class="fa-solid fa-bookmark" style="width:14px;"></i><select id="rbq-pp-floating-select" style="background:rgba(0,0,0,0.4);color:inherit;border:1px solid rgba(255,255,255,0.1);border-radius:6px;flex:1;outline:none;padding:2px 4px;font-size:12px;cursor:pointer;" data-action="plugin-ignore"></select>';

                    const menu = document.getElementById('st-scene-trigger-floating-menu');
                    const divider = menu?.querySelector('.st-scene-trigger-floating-divider');
                    if (menu) {
                        if (divider) menu.insertBefore(pMenu, divider);
                        else menu.appendChild(pMenu);
                    }

                    const fSelect = document.getElementById('rbq-pp-floating-select');
                    if (fSelect) {
                        fSelect.addEventListener('change', (e) => {
                            applyPresetSelection(e.target.value);
                        });
                        fSelect.addEventListener('click', e => e.stopPropagation());
                        pMenu.addEventListener('click', e => e.stopPropagation());
                    }
                }

                const fSelect = document.getElementById('rbq-pp-floating-select');
                if (fSelect) {
                    fSelect.innerHTML = '<option value="">-- 不使用预设 --</option>';
                    store.presets.forEach(p => {
                        const opt = document.createElement('option');
                        opt.value = p.id;
                        opt.textContent = p.name || p.id;
                        fSelect.appendChild(opt);
                    });
                    fSelect.value = store.activeId || '';
                }
            } else {
                if (pMenu) pMenu.remove();
            }
        }

        function renderSelect() {
            renderPresetUi = renderSelect;
            const store = getStore();
            if (globalPosPreInput) {
                globalPosPreInput.value = store.globalPositivePrefix || '';
            }
            if (globalPosSufInput) {
                globalPosSufInput.value = store.globalPositiveSuffix || '';
            }
            if (globalNegInput) {
                globalNegInput.value = store.globalNegative || '';
            }
            updateGlobalBadge();
            const isGlobalExpanded = store.globalExpanded !== false;
            if (globalContent) globalContent.style.display = isGlobalExpanded ? 'flex' : 'none';
            if (globalToggle) globalToggle.classList.toggle('rbq-pp-collapsible-open', isGlobalExpanded);
            updateGlobalExpandBtn(isGlobalExpanded);

            floatingCheckbox.checked = !!store.showFloating;
            select.innerHTML = '<option value="">-- 不使用预设 --</option>';
            store.presets.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = p.name || p.id;
                select.appendChild(opt);
            });
            select.value = store.activeId || '';
            loadEditor();
            syncFloatingMenu();
            renderLivePreview();
        }

        function loadEditor() {
            const preset = getActivePreset();
            if (preset) {
                nameInput.value = preset.name || '';
                // Auto switch tab if only positiveSuffix exists
                if (preset.positiveSuffix && !preset.positive) {
                    activePositiveTab = 'append';
                } else {
                    activePositiveTab = 'prepend';
                }
                if (tabPre) tabPre.classList.toggle('active', activePositiveTab === 'prepend');
                if (tabSuf) tabSuf.classList.toggle('active', activePositiveTab === 'append');

                if (posInput) {
                    if (activePositiveTab === 'prepend') {
                        posInput.value = preset.positive || '';
                        posInput.placeholder = '例如: masterpiece, best quality, highly detailed... (拼在正文分镜动态词之前)';
                    } else {
                        posInput.value = preset.positiveSuffix || '';
                        posInput.placeholder = '例如: year 2025, cinematic lighting... (拼在正文分镜动态词之后)';
                    }
                }
                negInput.value = preset.negative || '';
                editor.style.display = 'flex';
                updateTabDots();
            } else {
                nameInput.value = '';
                posInput.value = '';
                negInput.value = '';
                editor.style.display = 'none';
                updateTabDots();
            }
            renderLivePreview();
        }

        select.addEventListener('change', () => {
            applyPresetSelection(select.value);
        });

        floatingCheckbox.addEventListener('change', () => {
            getStore().showFloating = floatingCheckbox.checked;
            save();
            syncFloatingMenu();
        });

        document.getElementById('rbq-pp-new').addEventListener('click', () => {
            const name = window.prompt('输入新预设名称：');
            if (!name) return;
            const store = getStore();
            const id = uid();
            store.presets.push({ id, name, positive: '', positiveSuffix: '', negative: '' });
            store.activeId = id;
            save();
            renderSelect();
            toastr.success('预设已创建: ' + name);
        });

        document.getElementById('rbq-pp-save').addEventListener('click', () => {
            const preset = getActivePreset();
            if (!preset) return;
            preset.name = nameInput.value.trim() || preset.name;
            if (activePositiveTab === 'prepend') {
                preset.positive = posInput.value.trim();
            } else {
                preset.positiveSuffix = posInput.value.trim();
            }
            preset.negative = negInput.value.trim();
            const vibes = getCurrentNaiVibes();
            if (vibes.length > 0) {
                showVibeSaveDialog((mode) => {
                    preset.vibes = snapshotNaiVibes(mode);
                    save();
                    updateTabDots();
                    renderSelect();
                    toastr.success('预设已保存: ' + preset.name);
                });
                return;
            }
            preset.vibes = [];
            save();
            updateTabDots();
            renderSelect();
            toastr.success('预设已保存: ' + preset.name);
        });

        document.getElementById('rbq-pp-delete').addEventListener('click', () => {
            const store = getStore();
            const idx = store.presets.findIndex(p => p.id === store.activeId);
            if (idx === -1) return;
            const name = store.presets[idx].name;
            store.presets.splice(idx, 1);
            store.activeId = '';
            save();
            renderSelect();
            toastr.success('预设已删除: ' + name);
        });

        // ── 选择性导出 ──
        document.getElementById('rbq-pp-export').addEventListener('click', () => {
            const store = getStore();
            if (!store.presets.length) return toastr.warning('没有可导出的预设');
            showCheckboxDialog('选择要导出的预设', store.presets, (selectedIds) => {
                const selected = store.presets.filter(p => selectedIds.includes(p.id));
                if (!selected.length) return toastr.warning('未选择任何预设');
                // Export in compatible format (positivePrompt / positiveSuffix / negativePrompt)
                const exportData = selected.map((p, idx) => ({
                    id: p.id,
                    name: p.name,
                    positivePrompt: p.positive || '',
                    positiveSuffix: p.positiveSuffix || '',
                    negativePrompt: p.negative || '',
                    sequence: idx,
                    referenceImage: null,
                    thumbnail: null,
                    vibes: Array.isArray(p.vibes) ? p.vibes : [],
                }));
                const data = JSON.stringify(exportData, null, 2);
                const blob = new Blob([data], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                const date = new Date().toISOString().slice(0, 10);
                a.href = url;
                a.download = 'prompt-presets-' + date + '.json';
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
                toastr.success('已导出 ' + selected.length + ' 个预设');
            });
        });

        // ── 选择性导入 ──
        document.getElementById('rbq-pp-import-btn').addEventListener('click', () => {
            document.getElementById('rbq-pp-import-file').click();
        });

        document.getElementById('rbq-pp-import-file').addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                const parsed = JSON.parse(text);
                // 兼容三种格式：预设数组 / { presets: [...] } 包装 / 单个预设对象
                let imported;
                if (Array.isArray(parsed)) {
                    imported = parsed;
                } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.presets)) {
                    imported = parsed.presets;
                } else if (parsed && typeof parsed === 'object' && ['name', 'positive', 'positiveSuffix', 'negative', 'positivePrompt', 'positiveSuffixPrompt', 'negativePrompt', 'vibes'].some(k => k in parsed)) {
                    imported = [parsed];
                } else {
                    throw new Error('格式错误：应为预设数组、{ "presets": [...] } 或单个预设对象（含 name / positive / negative 等字段）');
                }
                imported = imported.filter(item => item && typeof item === 'object');
                const candidates = imported.filter(item => item.name || item.positive || item.positiveSuffix || item.negative || item.positivePrompt || item.positiveSuffixPrompt || (Array.isArray(item.vibes) && item.vibes.length));
                if (!candidates.length) throw new Error('文件中没有有效的预设');

                // Normalize items - support both formats:
                // Plugin native: { positive, positiveSuffix, negative }
                // External compat: { positivePrompt, positiveSuffix, negativePrompt, sequence, referenceImage, thumbnail }
                const displayItems = candidates.map((item, idx) => ({
                    id: item.id || uid(),
                    name: item.name || '未命名预设',
                    positive: item.positive || item.positivePrompt || '',
                    positiveSuffix: item.positiveSuffix || item.positiveSuffixPrompt || '',
                    negative: item.negative || item.negativePrompt || '',
                    vibes: Array.isArray(item.vibes) ? item.vibes.map(compactVibeEntry).filter(Boolean).slice(0, 6) : [],
                }));

                showCheckboxDialog('选择要导入的预设 (' + file.name + ')', displayItems, (selectedIds) => {
                    const store = getStore();
                    let count = 0;
                    for (const item of displayItems) {
                        if (!selectedIds.includes(item.id)) continue;
                        // Avoid duplicate IDs
                        if (store.presets.some(p => p.id === item.id)) item.id = uid();
                        store.presets.push(item);
                        count++;
                    }
                    save();
                    renderSelect();
                    toastr.success('成功导入 ' + count + ' 个预设');
                });
            } catch (err) {
                toastr.error('导入失败: ' + err.message);
            }
            e.target.value = '';
        });

        // ── 批量删除 ──
        document.getElementById('rbq-pp-batch-delete').addEventListener('click', () => {
            const store = getStore();
            if (!store.presets.length) return toastr.warning('没有任何预设可删除');
            showCheckboxDialog('选择要删除的预设 (警告：操作不可逆)', store.presets, (selectedIds) => {
                if (!selectedIds.length) return toastr.warning('未选择任何预设');
                if (!window.confirm(`确定要永久删除这 ${selectedIds.length} 个预设吗？`)) return;

                // If active preset is getting deleted, clear activeId
                if (selectedIds.includes(store.activeId)) {
                    store.activeId = '';
                }

                // Filter out the deleted ones
                store.presets = store.presets.filter(p => !selectedIds.includes(p.id));
                save();
                renderSelect();
                toastr.success(`已成功删除 ${selectedIds.length} 个预设`);
            });
        });

        renderSelect();
        console.info('[Prompt Presets] UI mounted');
    });

    // ── Neutralize built-in prefix/suffix/negative ─────────────
    // The host extension has its own prefix/suffix/negative fields that overlap
    // with this plugin's functionality. When this plugin is active, hide those
    // fields and clear their values so they don't double-up with preset hooks.
    function neutralizeBuiltinFields() {
        const s = RBQ.api.getSettings();
        const store = getStore();

        // Back up original values (once) so they're not lost forever
        if (!store._builtinBackup) {
            store._builtinBackup = {
                prefix: s.prefix || '',
                suffix: s.suffix || '',
                negative: s.negative || '',
            };
            if (!store.globalPositivePrefix && s.prefix) {
                store.globalPositivePrefix = s.prefix;
            }
            if (!store.globalPositiveSuffix && s.suffix) {
                store.globalPositiveSuffix = s.suffix;
            }
            if (!store.globalNegative && s.negative) {
                store.globalNegative = s.negative;
            }
        }

        // Clear the extension's built-in values so its joinPrompt logic becomes a no-op
        s.prefix = '';
        s.suffix = '';
        s.negative = '';
        save();

        // Hide the DOM fields AND clear their values (prevents saveFromModal from restoring old data)
        ['st-scene-trigger-modal-prefix', 'st-scene-trigger-modal-suffix', 'st-scene-trigger-modal-negative'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.value = '';
                if (el.closest('label')) el.closest('label').style.display = 'none';
            }
        });

        // Hide legacy static prompt preview and syntax help boxes
        const helpBox = document.querySelector('.st-scene-trigger-help-box');
        if (helpBox) helpBox.style.display = 'none';
        const oldPreviewBox = document.querySelector('.st-scene-trigger-preview-box');
        if (oldPreviewBox) oldPreviewBox.style.display = 'none';
    }

    // Run on load and re-run periodically (in case modal reopens and syncUi refills hidden inputs)
    neutralizeBuiltinFields();
    setInterval(() => {
        const el = document.getElementById('st-scene-trigger-modal-prefix');
        const oldPreviewBox = document.querySelector('.st-scene-trigger-preview-box');
        if (!el && !oldPreviewBox) return;
        // Re-neutralize if label became visible again OR if syncUi refilled the hidden input OR old preview appeared
        if (el?.closest('label')?.style.display !== 'none' || el?.value || (oldPreviewBox && oldPreviewBox.style.display !== 'none')) {
            neutralizeBuiltinFields();
        }
    }, 2000);

    console.info('📋 Prompt Presets plugin loaded');
})(RBQ, jQuery, toastr);
