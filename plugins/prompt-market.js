(function (RBQ, $, toastr) {
    if (!RBQ) return console.error('[Prompt Market] RBQ Core API missing');

    const STORAGE_KEY = '_promptMarketSettings';
    const PRESETS_STORAGE_KEY = '_promptPresets';

    // 默认基准测试底模提示词（卡密sama倾情提供）
    const BENCHMARK_POSITIVE_PROMPT = '1girl, solo, cowboy shot, slightly low angle, leaning forward, looking at viewer, platinum blonde hair, pastel pink gradient hair, very long wavy hair, twin side braids, center-parted bangs, parted hair, purple eyes, intricate pupils, gentle smile, parted lips, mole under left eye, black beret, gold hairpin, red hair ribbon, pearl earrings, black ribbon choker, white ruffled blouse, long sleeves, flared cuffs, dark green corset vest, gold trim, lace-up front, high-waisted black pleated skirt, layered frills, leather belt, black thighhighs, one hand tucking hair behind ear, one hand holding open pocket watch, indoors, antique greenhouse, glass ceiling, arched stained glass windows, climbing ivy, potted ferns, blooming white roses, vintage wooden table, scattered parchment papers, hanging brass birdcage, sunbeams';

    const BENCHMARK_NEGATIVE_PROMPT = 'lowres, bad anatomy, bad hands, worst quality, blurry, text, watermark, deformed, ugly';

    const BENCHMARK_CREDIT = '测试提示词由卡密sama提供';
    const KAMI_DEFAULT_PREVIEW = 'https://market.rbq.my/previews/kami-greenhouse-girl.webp';

    // 默认测试底模提示词库 (卡密sama温室少女为官方基准)
    const DEFAULT_TEST_PROMPTS = [
        {
            id: 'kami-greenhouse',
            title: '卡密sama · 温室少女 (官方基准)',
            positive: BENCHMARK_POSITIVE_PROMPT,
            negative: BENCHMARK_NEGATIVE_PROMPT,
            isDefault: true,
            isBuiltin: true
        }
    ];

    // 生成专属创作者个人身份码 (RBQ-U-xxxxxxxxxxxxxxxx，16 位 hex / 64 bit)
    // 1.1.31 起使用 crypto.getRandomValues 且长度由 8 位提升到 16 位；旧的 8 位码仍然有效。
    function generateCreatorKey() {
        const bytes = new Uint8Array(8);
        const c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
        if (c && typeof c.getRandomValues === 'function') {
            c.getRandomValues(bytes);
        } else {
            for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        }
        return 'RBQ-U-' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }

    // NovelAI 官方常用推荐采样器列表
    const NAI_SAMPLERS = [
        { value: 'k_euler_ancestral', label: 'Euler Ancestral (推荐)' },
        { value: 'k_euler', label: 'Euler' },
        { value: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' },
        { value: 'k_dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
        { value: 'k_dpmpp_sde', label: 'DPM++ SDE' },
        { value: 'k_dpmpp_2m', label: 'DPM++ 2M' }
    ];

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // 图片 / 封面地址白名单：只允许 http(s) 与 data:image/(png|jpeg|webp|gif|avif);base64；
    // allowLocal 仅用于本机生图结果 (blob: 与同源 /路径)，社区数据一律不放行。其他协议 (javascript:, data:text/html ...) 返回 fallback。
    function safeImageUrl(url, fallback = '', opts = {}) {
        if (typeof url !== 'string') return fallback;
        const u = url.trim();
        if (!u) return fallback;
        if (/^https?:\/\/[^\s"'<>`\\]+$/i.test(u)) return u;
        if (/^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[a-z0-9+/=]+$/i.test(u)) return u;
        if (opts.allowLocal && /^blob:https?:\/\/[^\s"'<>`\\]+$/i.test(u)) return u;
        if (opts.allowLocal && /^\/(?!\/)[^\s"'<>`\\]*$/.test(u)) return u;
        return fallback;
    }

    // 社区计数字段只按非负整数显示
    function safeCount(v) {
        const n = Math.floor(Number(v));
        return Number.isFinite(n) && n > 0 ? n : 0;
    }

    function safeNumber(v, def) {
        if (v === undefined || v === null || v === '') return def;
        const n = Number(v);
        return Number.isFinite(n) ? n : def;
    }

    function safeTags(tags) {
        return Array.isArray(tags) ? tags.map(t => String(t ?? '').trim()).filter(Boolean) : [];
    }

    // 图片高保真压缩通用函数 (720px / 0.82 WebP，在不支持 WebP 的 Safari/WebKit 环境下智能回退到 high-quality JPEG)
    function compressToWebp(imgObj, maxWidth = 720, quality = 0.82) {
        const canvas = document.createElement('canvas');
        let width = imgObj.width;
        let height = imgObj.height;
        if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        // 填充深色底色，防止 JPEG 回退或透明通道出现杂色/黑色
        ctx.fillStyle = '#07090e';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(imgObj, 0, 0, width, height);

        let format = 'WebP';
        let b64 = canvas.toDataURL('image/webp', quality);
        // Safari/WebKit 会静默忽略 'image/webp' 并回退为无损 png (toDataURL 返回 data:image/png...)
        // 这会导致 1.5MB+ 的超大 PNG base64 拖垮移动端网络传输。若不支持 webp，立即回退为 high-quality jpeg
        if (!b64.startsWith('data:image/webp')) {
            b64 = canvas.toDataURL('image/jpeg', quality);
            format = 'JPEG';
        }
        const approxKb = Math.round((b64.length * 3) / 4 / 1024);
        return { b64, width, height, approxKb, format };
    }

    // 默认配置 (默认直连自建的 market.rbq.my 节点服务)
    const DEFAULT_CONFIG = {
        serverUrl: 'https://market.rbq.my', // 自建工坊服务器
        authorName: '匿名',
        creatorKey: '', // 创作者身份码
        adminKey: '', // 服主管理员密钥
        myUploadedIds: [], // 本机发布的预设 ID 列表
        repo: 'TTWParty/RBQ-Prompt-Market',
        branch: 'main',
        installedIds: [],
        likedIds: [],
        testPrompts: DEFAULT_TEST_PROMPTS
    };

    function getConfig() {
        const s = RBQ.api.getSettings();
        if (!s[STORAGE_KEY]) s[STORAGE_KEY] = { ...DEFAULT_CONFIG };
        // 自动迁移旧的 9.rbq.my 并补充默认 serverUrl
        if (!s[STORAGE_KEY].serverUrl || s[STORAGE_KEY].serverUrl.includes('9.rbq.my')) {
            s[STORAGE_KEY].serverUrl = 'https://market.rbq.my';
        }
        // 默认作者署名严格为「匿名」，用户可随时自行修改；清理历史遗留的脏数据
        if (!s[STORAGE_KEY].authorName || s[STORAGE_KEY].authorName === '卡密' || s[STORAGE_KEY].authorName === '卡密RBQ' || s[STORAGE_KEY].authorName === '卡密sama') {
            s[STORAGE_KEY].authorName = '匿名';
        }
        // 创作者身份码默认留空，由用户在设置中自主创建或手动填入 (绝不静默硬塞)
        if (s[STORAGE_KEY].creatorKey === undefined) {
            s[STORAGE_KEY].creatorKey = '';
        }
        if (s[STORAGE_KEY].adminKey === undefined) s[STORAGE_KEY].adminKey = '';
        if (!Array.isArray(s[STORAGE_KEY].myUploadedIds)) s[STORAGE_KEY].myUploadedIds = [];
        if (!Array.isArray(s[STORAGE_KEY].installedIds)) s[STORAGE_KEY].installedIds = [];
        if (!Array.isArray(s[STORAGE_KEY].likedIds)) s[STORAGE_KEY].likedIds = [];
        if (!Array.isArray(s[STORAGE_KEY].testPrompts) || s[STORAGE_KEY].testPrompts.length === 0) {
            s[STORAGE_KEY].testPrompts = JSON.parse(JSON.stringify(DEFAULT_TEST_PROMPTS));
        }
        return s[STORAGE_KEY];
    }

    function saveConfig() {
        RBQ.api.saveSettings();
    }

    // 测串提示词库操作接口
    function getTestPrompts() {
        const cfg = getConfig();
        if (!Array.isArray(cfg.testPrompts) || cfg.testPrompts.length === 0) {
            cfg.testPrompts = JSON.parse(JSON.stringify(DEFAULT_TEST_PROMPTS));
            saveConfig();
        } else {
            // 自动同步官方基准底模提示词最新更新
            const builtin = cfg.testPrompts.find(tp => tp.id === 'kami-greenhouse' || tp.isBuiltin);
            if (builtin && builtin.positive !== BENCHMARK_POSITIVE_PROMPT) {
                builtin.positive = BENCHMARK_POSITIVE_PROMPT;
                saveConfig();
            }
        }
        return cfg.testPrompts;
    }

    function saveTestPrompts(list) {
        const cfg = getConfig();
        cfg.testPrompts = list;
        saveConfig();
    }

    // 复制剪贴板通用兜底
    const copyToClipboard = async (text) => {
        if (typeof RBQ?.utils?.copyToClipboard === 'function') {
            return RBQ.utils.copyToClipboard(text);
        }
        if (!text) return false;
        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (_e) {}
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const success = document.execCommand('copy');
        document.body.removeChild(textarea);
        return success;
    };

    // 格式化采样器友好名称
    function formatSampler(name) {
        if (!name) return 'Euler A';
        const s = String(name).toLowerCase();
        if (s.includes('euler_ancestral') || s === 'k_euler_a') return 'Euler A';
        if (s.includes('euler')) return 'Euler';
        if (s.includes('dpmpp_2m_sde')) return 'DPM++ 2M SDE';
        if (s.includes('dpmpp_2m')) return 'DPM++ 2M';
        if (s.includes('dpmpp_2s_ancestral') || s.includes('dpmpp_2s_a')) return 'DPM++ 2S A';
        if (s.includes('dpmpp_sde')) return 'DPM++ SDE';
        if (s.includes('ddim')) return 'DDIM';
        return name;
    }

    // 一键同步 NAI 生图参数至酒馆设置
    function applyNaiParams(params) {
        if (!params) return;
        const s = (typeof RBQ?.api?.getSettings === 'function') ? RBQ.api.getSettings() : null;
        if (!s) {
            toastr?.warning?.('未能获取酒馆生图设置');
            return;
        }

        const scale = params.scale !== undefined && params.scale !== null ? Number(params.scale) : 6.0;
        const sampler = params.sampler || 'k_euler_ancestral';
        const steps = params.steps !== undefined && params.steps !== null ? Number(params.steps) : 28;
        const cfgRescale = params.cfgRescale !== undefined && params.cfgRescale !== null ? Number(params.cfgRescale) : 0;
        const noiseSchedule = params.noiseSchedule || s.naiNoiseSchedule || 'karras';

        s.naiScale = scale;
        s.naiSampler = sampler;
        s.naiSteps = steps;
        s.naiCfgRescale = cfgRescale;
        if (params.noiseSchedule) s.naiNoiseSchedule = noiseSchedule;

        // 同步酒馆主界面 DOM（若设置抽屉正处于开启状态）
        const setElemVal = (id, val) => {
            const el = document.getElementById(id);
            if (el) {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        };
        setElemVal('st-scene-trigger-nai-scale', scale);
        const scaleValEl = document.getElementById('st-scene-trigger-nai-scale-val');
        if (scaleValEl) scaleValEl.textContent = scale;
        setElemVal('st-scene-trigger-nai-sampler', sampler);
        setElemVal('st-scene-trigger-nai-steps', steps);
        setElemVal('st-scene-trigger-nai-cfg-rescale', cfgRescale);
        setElemVal('st-scene-trigger-nai-noise-schedule', noiseSchedule);

        if (typeof RBQ?.api?.saveSettings === 'function') {
            RBQ.api.saveSettings();
        }

        toastr?.success?.(`🎉 已成功同步 NAI 生图参数！\nScale: ${scale} | 采样器: ${formatSampler(sampler)} | 步数: ${steps} | Rescale: ${cfgRescale}`);
    }

    // 内置初始预设（默认为空，完全由云端工坊动态分发）
    const BUILTIN_PRESETS = [];

    // 获取云端预设列表 (优先从自建服务器拉取)
    async function fetchCloudIndex() {
        const cfg = getConfig();
        const serverEndpoint = cfg.serverUrl || cfg.workerUrl;

        // 1. 如果有自建服务器地址，优先直连服务器
        if (serverEndpoint) {
            try {
                const res = await fetch(`${serverEndpoint.replace(/\/+$/, '')}/api/presets?_t=${Date.now()}`);
                if (res.ok) {
                    const data = await res.json();
                    if (Array.isArray(data)) return data;
                }
            } catch (err) {
                console.warn('[Prompt Market] 自建服务器获取预设失败，尝试 GitHub CDN 降级:', err);
            }
        }

        // 2. 降级走 GitHub / jsDelivr CDN
        const urls = [
            `https://cdn.jsdelivr.net/gh/${cfg.repo}@${cfg.branch}/index.json?_t=${Date.now()}`,
            `https://raw.githubusercontent.com/${cfg.repo}/${cfg.branch}/index.json`
        ];

        for (const url of urls) {
            try {
                const res = await fetch(url);
                if (res.ok) {
                    const data = await res.json();
                    if (Array.isArray(data)) return data;
                }
            } catch (_e) {}
        }
        return BUILTIN_PRESETS;
    }

    // 获取单条详情
    async function fetchPresetDetail(item) {
        if (item.positive) return item;
        const cfg = getConfig();
        const serverEndpoint = cfg.serverUrl || cfg.workerUrl;
        if (serverEndpoint) {
            try {
                const res = await fetch(`${serverEndpoint.replace(/\/+$/, '')}/api/presets`);
                if (res.ok) {
                    const list = await res.json();
                    const found = list.find(x => x.id === item.id);
                    if (found && found.positive) return found;
                }
            } catch (_e) {}
        }

        const urls = [
            `https://cdn.jsdelivr.net/gh/${cfg.repo}@${cfg.branch}/presets/${item.id}.json`,
            `https://raw.githubusercontent.com/${cfg.repo}/${cfg.branch}/presets/${item.id}.json`
        ];
        for (const url of urls) {
            try {
                const res = await fetch(url);
                if (res.ok) return await res.json();
            } catch (_e) {}
        }
        return item;
    }

    // 安装预设到本地 `_promptPresets`
    function installToLocalPresets(preset) {
        const s = RBQ.api.getSettings();
        if (!s[PRESETS_STORAGE_KEY]) {
            s[PRESETS_STORAGE_KEY] = { activeId: '', position: 'prepend', presets: [] };
        }
        const store = s[PRESETS_STORAGE_KEY];
        if (!Array.isArray(store.presets)) store.presets = [];

        // 检查是否已有同名或相同 ID
        const existingIdx = store.presets.findIndex(p => p.id === preset.id || p.name === preset.title);
        const newPresetObj = {
            id: preset.id || ('pp-' + Date.now().toString(36)),
            name: preset.title || '工坊预设',
            positive: preset.positive || '',
            positiveSuffix: preset.positiveSuffix || '',
            negative: preset.negative || '',
            params: preset.params || {}
        };

        if (existingIdx >= 0) {
            store.presets[existingIdx] = newPresetObj;
        } else {
            store.presets.push(newPresetObj);
        }

        RBQ.api.saveSettings();

        // ── ⚡ 核心修复：即时通知提示词预设插件刷新 UI，彻底告别刷新网页 ──
        if (typeof RBQ?.api?.refreshPromptPresetsUi === 'function') {
            try { RBQ.api.refreshPromptPresetsUi(); } catch (_e) {}
        }
        if (typeof RBQ?.emit === 'function') {
            try { RBQ.emit('presets:updated', { preset: newPresetObj, action: 'installed' }); } catch (_e) {}
        }
        try {
            window.dispatchEvent(new CustomEvent('rbq-presets-updated', { detail: { preset: newPresetObj } }));
        } catch (_e) {}

        // DOM 级实时兜底注入：即使跨版本亦能立刻在主面板下拉框 #rbq-pp-select 与悬浮窗中看到新预设
        try {
            const selectEls = document.querySelectorAll('#rbq-pp-select, #rbq-pp-floating-select');
            selectEls.forEach(sel => {
                let opt = Array.from(sel.options || []).find(o => o.value === String(newPresetObj.id));
                if (!opt) {
                    opt = document.createElement('option');
                    opt.value = newPresetObj.id;
                    opt.textContent = newPresetObj.name;
                    sel.appendChild(opt);
                } else {
                    opt.textContent = newPresetObj.name;
                }
            });
        } catch (_e) {}

        // 记录到已安装列表
        const cfg = getConfig();
        if (!cfg.installedIds.includes(preset.id)) {
            cfg.installedIds.push(preset.id);
            saveConfig();
        }

        // 上报下载量至云端工坊
        const endpoint = (cfg.serverUrl || cfg.workerUrl || '').replace(/\/+$/, '');
        if (endpoint && preset.id) {
            fetch(`${endpoint}/api/download`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: preset.id })
            }).then(r => r.json()).then(data => {
                if (data?.downloads) preset.downloads = data.downloads;
            }).catch(() => {});
        }

        toastr.success(`预设「${preset.title}」已成功装入你的本地预设库！`);
    }

    // 点赞预设 (支持 Toggle 收藏 / 取消收藏)
    async function likePreset(item, likeBtn, countSpan) {
        const cfg = getConfig();
        const endpoint = (cfg.serverUrl || cfg.workerUrl || '').replace(/\/+$/, '');
        const clientId = cfg.creatorKey || cfg.clientId || 'u-tavern';

        if (!endpoint) return;

        try {
            const res = await fetch(`${endpoint}/api/like`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: item.id, clientId })
            });
            const data = await res.json();
            if (data.success) {
                item.likes = data.likes;
                if (countSpan) countSpan.textContent = item.likes;
                if (data.action === 'liked') {
                    if (!cfg.likedIds.includes(item.id)) cfg.likedIds.push(item.id);
                    if (likeBtn) likeBtn.classList.add('is-liked');
                    toastr.success(`已为「${item.title}」点赞 ❤️`);
                } else {
                    cfg.likedIds = cfg.likedIds.filter(x => x !== item.id);
                    if (likeBtn) likeBtn.classList.remove('is-liked');
                    toastr.info(`已取消「${item.title}」的点赞 🤍`);
                }
                saveConfig();
                if (activeModelFilter === 'liked') {
                    renderCards();
                }
            } else {
                toastr.warning(data.error || '点赞操作失败');
            }
        } catch (err) {
            console.warn('[Prompt Market] 点赞网络上报异常:', err);
        }
    }

    // ── 注入 Game-HUD 样式防御系统 ──
    function ensureMarketStyles() {
        if (document.getElementById('rbq-prompt-market-styles')) return;
        const style = document.createElement('style');
        style.id = 'rbq-prompt-market-styles';
        style.textContent = `
            /* 宿主 .menu_button 挤压防御铁律 */
            #rbq-pm-container .menu_button,
            #rbq-pm-upload-dialog .menu_button,
            #rbq-pm-detail-dialog .menu_button,
            #rbq-pm-benchmark-dialog .menu_button,
            #rbq-pm-test-dialog .menu_button,
            #rbq-pm-test-edit-dialog .menu_button,
            #rbq-pm-live-test-dialog .menu_button,
            #rbq-pm-settings-dialog .menu_button {
                display: inline-flex !important;
                flex-direction: row !important;
                align-items: center !important;
                justify-content: center !important;
                gap: 6px !important;
                white-space: nowrap !important;
                box-sizing: border-box !important;
            }

            /* 全局模态 Overlay 防御体系：顶级层叠上下文防御 (宿主酒馆移动端为 999999) */
            #rbq-prompt-market-overlay:not(.rbq-pm-hidden) {
                position: fixed !important;
                inset: 0 !important;
                width: 100vw !important;
                height: 100vh !important;
                height: 100dvh !important;
                z-index: 2147483640 !important;
                background: rgba(5, 7, 13, 0.85) !important;
                backdrop-filter: blur(10px) !important;
                -webkit-backdrop-filter: blur(10px) !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                box-sizing: border-box !important;
                padding: 16px !important;
                overflow-y: auto !important;
                -webkit-overflow-scrolling: touch !important;
            }

            #rbq-pm-upload-dialog,
            #rbq-pm-detail-dialog,
            #rbq-pm-benchmark-dialog,
            #rbq-pm-test-dialog,
            #rbq-pm-settings-dialog,
            #rbq-pm-manage-dialog {
                position: fixed !important;
                inset: 0 !important;
                width: 100vw !important;
                height: 100vh !important;
                height: 100dvh !important;
                z-index: 2147483642 !important;
                background: rgba(5, 7, 13, 0.86) !important;
                backdrop-filter: blur(10px) !important;
                -webkit-backdrop-filter: blur(10px) !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                box-sizing: border-box !important;
                padding: 16px !important;
                overflow-y: auto !important;
                -webkit-overflow-scrolling: touch !important;
            }

            #rbq-pm-edit-dialog,
            #rbq-pm-test-edit-dialog,
            #rbq-pm-live-dialog,
            #rbq-pm-live-test-dialog {
                position: fixed !important;
                inset: 0 !important;
                width: 100vw !important;
                height: 100vh !important;
                height: 100dvh !important;
                z-index: 2147483644 !important;
                background: rgba(5, 7, 13, 0.88) !important;
                backdrop-filter: blur(12px) !important;
                -webkit-backdrop-filter: blur(12px) !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                box-sizing: border-box !important;
                padding: 16px !important;
                overflow-y: auto !important;
                -webkit-overflow-scrolling: touch !important;
            }

            #rbq-pm-lightbox,
            #rbq-pm-zoom-overlay {
                position: fixed !important;
                inset: 0 !important;
                width: 100vw !important;
                height: 100vh !important;
                height: 100dvh !important;
                z-index: 2147483646 !important;
                background: rgba(0, 0, 0, 0.92) !important;
                backdrop-filter: blur(14px) !important;
                -webkit-backdrop-filter: blur(14px) !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                box-sizing: border-box !important;
                cursor: zoom-out !important;
            }

            /* 彻底修复隐藏态无法被 style.display 覆盖的 fatal bug */
            #rbq-prompt-market-overlay.rbq-pm-hidden {
                display: none !important;
                visibility: hidden !important;
                pointer-events: none !important;
            }

            /* 全局与所有子弹窗的关闭按钮极速响应与超大热区标准 (44x44px 人体工学防御) */
            .rbq-pm-close-btn {
                min-width: 44px !important;
                min-height: 44px !important;
                width: 44px !important;
                height: 44px !important;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                padding: 0 !important;
                margin: -6px -6px -6px 0 !important;
                background: transparent !important;
                border: none !important;
                border-radius: 8px !important;
                color: #94a3b8 !important;
                font-size: 20px !important;
                line-height: 1 !important;
                cursor: pointer !important;
                touch-action: manipulation !important;
                -webkit-tap-highlight-color: rgba(255, 255, 255, 0.2) !important;
                user-select: none !important;
                -webkit-user-select: none !important;
                flex-shrink: 0 !important;
                position: relative !important;
                z-index: 30 !important;
                box-sizing: border-box !important;
                transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease !important;
            }

            .rbq-pm-close-btn:hover {
                background: rgba(255, 255, 255, 0.1) !important;
                color: #f1f5f9 !important;
            }

            .rbq-pm-close-btn:active {
                background: rgba(239, 68, 68, 0.25) !important;
                color: #f87171 !important;
                transform: scale(0.92) !important;
            }

            /* 工坊主面板容器防御：边界锁死，严防顶部溢出与被挤出视口 */
            #rbq-pm-container {
                width: min(1080px, 95vw) !important;
                height: min(840px, calc(100dvh - 32px)) !important;
                max-height: min(840px, calc(100dvh - 32px)) !important;
                min-height: 0 !important;
                background: #090d16 !important;
                border: 1px solid rgba(255, 255, 255, 0.14) !important;
                border-radius: 16px !important;
                box-shadow: 0 25px 60px rgba(0, 0, 0, 0.8), 0 0 30px rgba(56, 189, 248, 0.08) !important;
                display: flex !important;
                flex-direction: column !important;
                overflow: hidden !important;
                box-sizing: border-box !important;
                margin: auto !important;
            }

            /* 子弹窗容器高度防御 */
            #rbq-pm-upload-dialog > div,
            #rbq-pm-detail-dialog > div,
            #rbq-pm-benchmark-dialog > div,
            #rbq-pm-test-dialog > div,
            #rbq-pm-test-edit-dialog > div,
            #rbq-pm-live-test-dialog > div,
            #rbq-pm-settings-dialog > div {
                max-height: calc(100dvh - 32px) !important;
                display: flex !important;
                flex-direction: column !important;
                min-height: 0 !important;
                margin: auto !important;
                box-sizing: border-box !important;
                overflow: hidden !important;
            }

            #rbq-pm-header {
                flex-shrink: 0 !important;
                min-height: 48px !important;
            }
            #rbq-pm-toolbar {
                flex-shrink: 0 !important;
            }

            /* 卡片与网格容器 Zero-CLS 防御体系 */
            .rbq-pm-card {
                background: #0f172a;
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 12px;
                overflow: hidden;
                display: flex !important;
                flex-direction: column !important;
                height: auto !important;
                align-self: start !important; /* 坚决禁止 Grid 垂直拉伸与均分压缩，由内容高度真实决定 */
                flex-shrink: 0 !important;
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
                cursor: pointer;
                transform: translateZ(0);
                will-change: transform, box-shadow;
                transition: transform 0.2s cubic-bezier(0.2, 0, 0, 1), box-shadow 0.2s cubic-bezier(0.2, 0, 0, 1), border-color 0.2s ease;
            }
            .rbq-pm-card:hover {
                transform: translateY(-4px);
                border-color: rgba(56, 189, 248, 0.45);
                box-shadow: 0 12px 28px rgba(0, 0, 0, 0.65), 0 0 16px rgba(56, 189, 248, 0.18);
            }

            /* 3:4 竖版立绘专精容器 (智能 15% 面部黄金构图，彻底防止切头与压扁) */
            .rbq-pm-img-wrap {
                width: 100% !important;
                aspect-ratio: 3 / 4 !important;
                flex-shrink: 0 !important; /* 关键：坚决禁止立绘高度在 Flex 列布局中被挤压压缩 */
                position: relative;
                background: #070b13;
                overflow: hidden;
                min-height: 220px; /* 关键：兜底防塌陷安全高度 */
            }
            .rbq-pm-img-wrap img {
                width: 100% !important;
                height: 100% !important;
                object-fit: cover !important;
                object-position: center 15% !important; /* 专为二次元/角色立绘优化：聚焦面部与上半身，绝不切头 */
                display: block !important;
                transition: transform 0.35s ease;
            }
            .rbq-pm-card:hover .rbq-pm-img-wrap img {
                transform: scale(1.05);
            }

            /* 创作者专属「我的」金色标识 */
            .rbq-pm-badge-author-mine {
                display: inline-flex !important;
                align-items: center !important;
                gap: 3px !important;
                background: rgba(234, 179, 8, 0.18) !important;
                border: 1px solid rgba(234, 179, 8, 0.45) !important;
                color: #fde047 !important;
                font-size: 9.5px !important;
                font-weight: 700 !important;
                padding: 1px 5px !important;
                border-radius: 4px !important;
            }

            /* 浮动半透明模型徽章 */
            .rbq-pm-badge-model {
                position: absolute;
                top: 8px;
                left: 8px;
                z-index: 2;
                backdrop-filter: blur(8px);
                -webkit-backdrop-filter: blur(8px);
                font-size: 10px;
                font-weight: 700;
                letter-spacing: 0.5px;
                padding: 2.5px 7px;
                border-radius: 5px;
                display: inline-flex;
                align-items: center;
                gap: 4px;
                text-transform: uppercase;
                box-shadow: 0 2px 6px rgba(0,0,0,0.5);
            }
            .rbq-pm-badge-v5 {
                background: rgba(217, 70, 239, 0.3);
                border: 1px solid rgba(217, 70, 239, 0.6);
                color: #f0abfc;
            }
            .rbq-pm-badge-v45 {
                background: rgba(56, 189, 248, 0.3);
                border: 1px solid rgba(56, 189, 248, 0.6);
                color: #7dd3fc;
            }
            .rbq-pm-badge-gen {
                background: rgba(30, 41, 59, 0.6);
                border: 1px solid rgba(255, 255, 255, 0.2);
                color: #cbd5e1;
            }

            /* 浮动「我的作品」专属 Game HUD 徽章 (立绘右上角红心旁，彻底解决底栏挤压变形) */
            .rbq-pm-badge-mine {
                position: absolute;
                top: 8px;
                right: 48px;
                z-index: 2;
                background: linear-gradient(135deg, rgba(245, 158, 11, 0.95), rgba(217, 119, 6, 0.95));
                border: 1px solid rgba(251, 191, 36, 0.7);
                color: #ffffff;
                font-size: 9.5px;
                font-weight: 700;
                padding: 2.5px 7px;
                border-radius: 12px;
                backdrop-filter: blur(6px);
                -webkit-backdrop-filter: blur(6px);
                display: inline-flex;
                align-items: center;
                gap: 3.5px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.5);
                letter-spacing: 0.3px;
                pointer-events: none;
            }

            /* 浮动半透明点赞按钮 */
            .rbq-pm-card-like {
                position: absolute;
                top: 8px;
                right: 8px;
                z-index: 2;
                backdrop-filter: blur(8px);
                -webkit-backdrop-filter: blur(8px);
                background: rgba(15, 23, 42, 0.7);
                border: 1px solid rgba(255, 255, 255, 0.18);
                color: #cbd5e1;
                border-radius: 6px;
                padding: 3px 8px;
                font-size: 11px;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                gap: 4px;
                box-shadow: 0 2px 6px rgba(0,0,0,0.5);
                transition: all 0.15s ease;
            }
            .rbq-pm-card-like:hover {
                background: rgba(244, 63, 94, 0.25);
                border-color: rgba(244, 63, 94, 0.5);
                color: #fb7185;
            }
            .rbq-pm-card-like.is-liked {
                background: rgba(244, 63, 94, 0.35);
                border-color: #f43f5e;
                color: #fb7185;
            }
            .rbq-pm-card-like.is-liked i {
                color: #f43f5e;
                animation: rbq-heart-pop 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            }
            @keyframes rbq-heart-pop {
                0% { transform: scale(1); }
                50% { transform: scale(1.35); }
                100% { transform: scale(1); }
            }

            /* 卡片信息区排版防护 */
            .rbq-pm-card-info {
                padding: 8px 10px;
                background: #0f172a;
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            .rbq-pm-card-title {
                font-size: 12.5px;
                font-weight: 700;
                color: #f8fafc;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                line-height: 1.35;
            }
            .rbq-pm-card-meta {
                display: flex !important;
                align-items: center !important;
                justify-content: space-between !important;
                gap: 6px !important;
                min-width: 0 !important;
            }
            .rbq-pm-card-author {
                font-size: 11px;
                color: #64748b;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                max-width: 85px;
                display: inline-flex;
                align-items: center;
                gap: 4px;
                flex: 1 1 auto;
                min-width: 0;
            }
            .rbq-pm-card-actions {
                display: flex !important;
                align-items: center !important;
                gap: 4px !important;
                flex-shrink: 0 !important;
            }
            .rbq-pm-card-test-btn,
            .rbq-pm-install-btn {
                font-size: 11px !important;
                font-weight: 600 !important;
                padding: 3px 8px !important;
                border-radius: 6px !important;
                flex-shrink: 0 !important;
                display: inline-flex !important;
                flex-direction: row !important;
                align-items: center !important;
                justify-content: center !important;
                gap: 3.5px !important;
                white-space: nowrap !important;
                box-sizing: border-box !important;
                cursor: pointer !important;
                line-height: 1.2 !important;
                touch-action: manipulation !important;
            }
            .rbq-pm-card-test-btn {
                background: rgba(168, 85, 247, 0.16) !important;
                border: 1px solid rgba(168, 85, 247, 0.45) !important;
                color: #d8b4fe !important;
                transition: all 0.2s ease !important;
            }
            .rbq-pm-card-test-btn:hover {
                background: rgba(168, 85, 247, 0.3) !important;
                color: #f0abfc !important;
                border-color: rgba(217, 70, 239, 0.6) !important;
                box-shadow: 0 0 10px rgba(168, 85, 247, 0.3) !important;
            }

            /* 网格布局：自适应 4~5 列，内置平滑滚动与 flex-shrink: 0 防御 */
            #rbq-pm-card-grid {
                flex: 1 1 0% !important;
                min-height: 0 !important;
                overflow-y: auto !important;
                -webkit-overflow-scrolling: touch !important;
                padding: 16px 20px;
                display: grid !important;
                grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)) !important;
                grid-auto-rows: max-content !important; /* 关键：坚决禁止 Grid 容器平分行高压扁卡片，严格由卡片内容撑开 */
                gap: 16px !important;
                align-content: start !important;
                box-sizing: border-box !important;
            }

            /* ── 📱 移动端与小屏极端工况深度适配 (彻底告别竖排挤压与臃肿) ── */
            @media (max-width: 640px) {
                #rbq-prompt-market-overlay:not(.rbq-pm-hidden),
                #rbq-pm-upload-dialog,
                #rbq-pm-detail-dialog,
                #rbq-pm-benchmark-dialog,
                #rbq-pm-test-dialog,
                #rbq-pm-test-edit-dialog,
                #rbq-pm-live-test-dialog,
                #rbq-pm-settings-dialog {
                    padding: 6px !important;
                }

                #rbq-pm-container {
                    width: calc(100vw - 12px) !important;
                    height: calc(100dvh - 12px) !important;
                    max-height: calc(100dvh - 12px) !important;
                    border-radius: 12px !important;
                }

                #rbq-pm-detail-dialog > div,
                #rbq-pm-upload-dialog > div,
                #rbq-pm-live-test-dialog > div,
                #rbq-pm-test-dialog > div,
                #rbq-pm-test-edit-dialog > div,
                #rbq-pm-benchmark-dialog > div,
                #rbq-pm-settings-dialog > div {
                    width: calc(100vw - 12px) !important;
                    max-height: calc(100dvh - 12px) !important;
                    border-radius: 12px !important;
                }
                
                /* 顶部 HUD 紧凑排版：强制单行不换行，隐藏冗余小标题与英文徽章 */
                #rbq-pm-header {
                    padding: 8px 10px !important;
                    gap: 6px !important;
                }
                #rbq-pm-hdr-title {
                    font-size: 13.5px !important;
                    white-space: nowrap !important;
                }
                #rbq-pm-hdr-sub, #rbq-pm-hdr-badge {
                    display: none !important;
                }
                #rbq-pm-header-actions {
                    gap: 4px !important;
                }
                #rbq-pm-header-actions .menu_button {
                    padding: 4px 7px !important;
                    font-size: 11px !important;
                    gap: 3px !important;
                }
                .rbq-pm-close-btn {
                    width: 44px !important;
                    height: 44px !important;
                    margin: -8px -6px -8px 0 !important;
                }
                .rbq-pm-desktop-only {
                    display: none !important;
                }

                /* 筛选与搜索工具栏：双行流线化紧凑 HUD，节省 100px+ 纵向高度 */
                #rbq-pm-toolbar {
                    padding: 6px 10px !important;
                    gap: 6px !important;
                }
                #rbq-pm-search-input {
                    height: 30px !important;
                    font-size: 11.5px !important;
                }
                #rbq-pm-sort-select {
                    height: 30px !important;
                    font-size: 11px !important;
                    padding: 2px 4px !important;
                }
                #rbq-pm-filter-track {
                    gap: 4px !important;
                }
                .rbq-pm-model-tab {
                    padding: 2.5px 7px !important;
                    font-size: 10px !important;
                }

                /* 卡片网格：精致双列流，保证每屏完整展示 2~3 排卡片并自然滚动 */
                #rbq-pm-card-grid {
                    grid-template-columns: repeat(2, 1fr) !important;
                    grid-auto-rows: max-content !important;
                    gap: 8px !important;
                    padding: 8px !important;
                }
                .rbq-pm-card {
                    border-radius: 8px !important;
                    align-self: start !important;
                    height: auto !important;
                }
                .rbq-pm-img-wrap {
                    min-height: 160px !important;
                }
                .rbq-pm-badge-model {
                    top: 5px !important;
                    left: 5px !important;
                    font-size: 8.5px !important;
                    padding: 1px 4.5px !important;
                    letter-spacing: 0 !important;
                }
                .rbq-pm-card-like {
                    top: 5px !important;
                    right: 5px !important;
                    font-size: 9.5px !important;
                    padding: 2px 5px !important;
                }
                .rbq-pm-badge-mine {
                    top: 5px !important;
                    right: 42px !important;
                    font-size: 8px !important;
                    padding: 1.5px 5px !important;
                }
                .rbq-pm-card-info {
                    padding: 6px 7px !important;
                    gap: 3px !important;
                }
                .rbq-pm-card-title {
                    font-size: 11px !important;
                    line-height: 1.25 !important;
                }
                .rbq-pm-card-meta {
                    gap: 3px !important;
                }
                .rbq-pm-card-author {
                    font-size: 9.5px !important;
                    max-width: 42px !important;
                }
                .rbq-pm-card-actions {
                    gap: 2.5px !important;
                }
                .rbq-pm-card-test-btn,
                .rbq-pm-install-btn {
                    font-size: 9.5px !important;
                    padding: 2px 5px !important;
                    gap: 2px !important;
                }

                /* 详情模态弹窗移动端自适应 */
                .rbq-pm-detail-body {
                    flex-direction: column !important;
                    padding: 10px !important;
                    gap: 10px !important;
                }
                .rbq-pm-detail-left {
                    width: 100% !important;
                    max-width: 180px !important;
                    margin: 0 auto !important;
                }
                .rbq-pm-detail-right {
                    min-width: 0 !important;
                    width: 100% !important;
                    gap: 8px !important;
                }
                .rbq-pm-detail-foot {
                    padding: 8px 10px !important;
                    flex-wrap: wrap !important;
                    gap: 6px !important;
                }
                .rbq-pm-detail-foot .menu_button {
                    font-size: 11.5px !important;
                    padding: 6px 10px !important;
                    flex: 1 1 auto !important;
                }

                /* 上传模态弹窗移动端自适应 */
                .rbq-pm-up-grid-2col {
                    grid-template-columns: 1fr !important;
                    gap: 8px !important;
                }

                /* 试炼台模态弹窗移动端自适应 */
                .rbq-pm-live-body {
                    flex-direction: column !important;
                    padding: 10px !important;
                    gap: 12px !important;
                }
                .rbq-pm-live-left {
                    max-width: 100% !important;
                    min-width: 0 !important;
                }
                #rbq-pm-live-visual-frame {
                    max-height: 250px !important;
                    margin: 0 auto !important;
                }
                .rbq-pm-live-right {
                    min-width: 0 !important;
                    max-width: 100% !important;
                }
                .rbq-pm-live-params-grid,
                .rbq-pm-up-params-grid {
                    grid-template-columns: repeat(2, 1fr) !important;
                    gap: 8px !important;
                }
            }
        `;
        document.head.appendChild(style);
    }

    // ── UI Modal 构建 ──
    let marketModal = null;
    let activeModelFilter = 'all'; // all | v5 | v4.5 | general
    let activeTag = '全部';
    let searchQuery = '';
    let sortMode = 'likes'; // likes | downloads | newest
    let cachedList = [];

    // ── 子弹窗生命周期与防穿透隔离中枢 (根除移动端鬼点与级联误关) ──
    let lastSubModalClosedAt = 0;

    function isAnySubModalOpen() {
        return Boolean(document.querySelector(
            '#rbq-pm-detail-dialog, #rbq-pm-upload-dialog, #rbq-pm-benchmark-dialog, ' +
            '#rbq-pm-test-dialog, #rbq-pm-test-edit-dialog, #rbq-pm-live-dialog, ' +
            '#rbq-pm-live-test-dialog, #rbq-pm-settings-dialog, #rbq-pm-edit-dialog, ' +
            '#rbq-pm-manage-dialog, #rbq-pm-lightbox, #rbq-pm-zoom-overlay'
        ));
    }

    function closeSubDialog(dialogEl) {
        if (!dialogEl) return;
        lastSubModalClosedAt = Date.now();
        try {
            dialogEl.remove();
        } catch (_) {}
    }

    // ── 极速防抖关闭交互助手 (专克移动端 300ms 延迟与手势冲突) ──
    function bindFastClose(el, closeAction) {
        if (!el || typeof closeAction !== 'function') return;
        let lockTime = 0;
        const trigger = (e) => {
            const now = Date.now();
            if (now - lockTime < 350) return;
            lockTime = now;
            if (e) {
                e.preventDefault();
                e.stopPropagation();
                if (e.stopImmediatePropagation) e.stopImmediatePropagation();
            }
            closeAction(e);
        };
        // 采用标准原生点击，配合 touch-action: manipulation 实现 0ms 响应，严禁 pointerup 同步销毁 DOM
        el.onclick = trigger;
    }

    // ── 子弹窗遮罩背景安全点击关闭 (严格双重校验 pointerdown 起点与点击终点) ──
    function bindDialogBackdropClose(dialogOverlay) {
        if (!dialogOverlay) return;
        let downOnSelf = false;
        dialogOverlay.addEventListener('pointerdown', (e) => {
            downOnSelf = (e.target === dialogOverlay);
        });
        dialogOverlay.addEventListener('click', (e) => {
            if (!downOnSelf) return;
            downOnSelf = false;
            if (e.target !== dialogOverlay) return;
            e.preventDefault();
            e.stopPropagation();
            closeSubDialog(dialogOverlay);
        });
    }

    function closeMarketModal() {
        if (!marketModal) return;
        marketModal.classList.add('rbq-pm-hidden');
        marketModal.style.setProperty('display', 'none', 'important');
    }

    function showMarketModal() {
        if (!marketModal) return;
        marketModal.classList.remove('rbq-pm-hidden');
        marketModal.style.setProperty('display', 'flex', 'important');
    }

    function openMarketModal() {
        ensureMarketStyles();

        if (marketModal) {
            document.body.appendChild(marketModal); // 确保始终位于 DOM 最顶层
            showMarketModal();
            loadMarketData();
            return;
        }

        marketModal = document.createElement('div');
        marketModal.id = 'rbq-prompt-market-overlay';
        marketModal.style.cssText = `
            position: fixed; inset: 0; z-index: 2147483640;
            background: rgba(5, 7, 13, 0.85); backdrop-filter: blur(10px);
            display: flex; align-items: center; justify-content: center;
            font-family: inherit; color: #f1f5f9; box-sizing: border-box;
        `;

        marketModal.innerHTML = `
            <div id="rbq-pm-container" style="
                width: 94vw; max-width: 1080px; height: 88vh; max-height: 840px;
                background: #090d16; border: 1px solid rgba(255, 255, 255, 0.14);
                border-radius: 16px; box-shadow: 0 25px 60px rgba(0,0,0,0.75), 0 0 30px rgba(56, 189, 248, 0.08);
                display: flex; flex-direction: column; overflow: hidden;
            ">
                <!-- Header HUD -->
                <div id="rbq-pm-header" style="padding: 10px 16px; background: #0f172a; border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-shrink: 0; min-width: 0;">
                    <div style="display: flex; align-items: center; gap: 8px; min-width: 0; flex-shrink: 0;">
                        <div style="width: 32px; height: 32px; border-radius: 8px; background: linear-gradient(135deg, #0284c7, #8b5cf6); display: flex; align-items: center; justify-content: center; font-size: 15px; color: #fff; box-shadow: 0 4px 10px rgba(2, 132, 199, 0.4); flex-shrink: 0;">
                            <i class="fa-solid fa-store"></i>
                        </div>
                        <div style="min-width: 0;">
                            <div id="rbq-pm-hdr-title" style="font-size: 14.5px; font-weight: 800; display: flex; align-items: center; gap: 6px; white-space: nowrap;">
                                <span style="white-space: nowrap;">提示词<span class="rbq-pm-desktop-only">预设</span>工坊</span>
                                <span id="rbq-pm-hdr-badge" style="font-size: 9.5px; font-weight: 700; background: linear-gradient(135deg, rgba(56, 189, 248, 0.2), rgba(139, 92, 246, 0.2)); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); padding: 1px 5px; border-radius: 4px;">MARKET</span>
                            </div>
                            <div id="rbq-pm-hdr-sub" style="font-size: 10.5px; color: #94a3b8; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">社区画师串与预设中心</div>
                        </div>
                    </div>
                    <div id="rbq-pm-header-actions" style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
                        <button id="rbq-pm-btn-refresh" class="menu_button" title="刷新工坊最新预设与数据" style="background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.35); color: #38bdf8; padding: 5px 9px; font-size: 11.5px; font-weight: 700; border-radius: 6px; cursor: pointer; white-space: nowrap !important;">
                            <i class="fa-solid fa-arrows-rotate"></i>
                            <span class="rbq-pm-desktop-only">刷新</span>
                        </button>
                        <button id="rbq-pm-btn-test-prompts" class="menu_button" title="测串提示词库" style="background: rgba(168, 85, 247, 0.15); border: 1px solid rgba(168, 85, 247, 0.35); color: #c084fc; padding: 5px 9px; font-size: 11.5px; font-weight: 700; border-radius: 6px; cursor: pointer; white-space: nowrap !important;">
                            <i class="fa-solid fa-flask"></i>
                            <span>测串<span class="rbq-pm-desktop-only">词库</span></span>
                        </button>
                        <button id="rbq-pm-btn-upload" class="menu_button" style="background: linear-gradient(135deg, #0284c7, #2563eb); border: none; color: #fff; padding: 5px 11px; font-size: 11.5px; font-weight: 700; border-radius: 6px; cursor: pointer; box-shadow: 0 2px 8px rgba(2, 132, 199, 0.35); white-space: nowrap !important;">
                            <i class="fa-solid fa-cloud-arrow-up"></i>
                            <span>发布<span class="rbq-pm-desktop-only">预设</span></span>
                        </button>
                        <button id="rbq-pm-btn-settings" class="menu_button" title="工坊服务器设置" style="padding: 5px 8px; font-size: 12px; color: #94a3b8; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; white-space: nowrap !important;">
                            <i class="fa-solid fa-gear"></i>
                        </button>
                        <button id="rbq-pm-btn-close" class="rbq-pm-close-btn" title="关闭工坊" aria-label="关闭">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>
                </div>

                <!-- Model Filter & Category Toolbar -->
                <div id="rbq-pm-toolbar" style="padding: 8px 16px; background: #0b1120; border-bottom: 1px solid rgba(255,255,255,0.07); display: flex; flex-direction: column; gap: 6px; flex-shrink: 0;">
                    <!-- Line 1: Search & Sort HUD -->
                    <div style="display: flex; gap: 8px; align-items: center; justify-content: space-between; width: 100%;">
                        <div style="position: relative; flex: 1; min-width: 0;">
                            <i class="fa-solid fa-magnifying-glass" style="position: absolute; left: 10px; top: 50%; transform: translateY(-50%); font-size: 11px; color: #64748b;"></i>
                            <input id="rbq-pm-search-input" type="text" placeholder="搜索画师/预设/标签..." style="width: 100%; box-sizing: border-box; background: #070b13; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 5px 10px 5px 28px; font-size: 12px; color: #fff; outline: none; height: 32px;">
                        </div>
                        <select id="rbq-pm-sort-select" style="background: #070b13; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 4px 8px; font-size: 11.5px; color: #cbd5e1; outline: none; cursor: pointer; flex-shrink: 0; height: 32px;">
                            <option value="likes">❤️ 点赞数</option>
                            <option value="downloads">📥 下载量</option>
                            <option value="newest">🆕 最新</option>
                        </select>
                    </div>

                    <!-- Line 2: Silky Horizontal Scroll Track for Models & Tags -->
                    <div id="rbq-pm-filter-track" style="display: flex; gap: 6px; align-items: center; overflow-x: auto; white-space: nowrap; -webkit-overflow-scrolling: touch; scrollbar-width: none; padding-bottom: 2px;">
                        <!-- Model Tabs -->
                        <div id="rbq-pm-model-tabs" style="display: flex; gap: 5px; align-items: center; flex-shrink: 0;">
                            <button class="rbq-pm-model-tab active" data-model="all" style="padding: 3px 9px; font-size: 11px; font-weight: 600; border-radius: 6px; border: 1px solid #38bdf8; background: rgba(56, 189, 248, 0.18); color: #38bdf8; cursor: pointer; white-space: nowrap;">全部模型</button>
                            <button class="rbq-pm-model-tab" data-model="v5" style="padding: 3px 9px; font-size: 11px; font-weight: 600; border-radius: 6px; border: 1px solid rgba(217, 70, 239, 0.35); background: rgba(255,255,255,0.04); color: #f0abfc; cursor: pointer; white-space: nowrap;"><i class="fa-solid fa-wand-magic-sparkles"></i> NAI V5</button>
                            <button class="rbq-pm-model-tab" data-model="v4.5" style="padding: 3px 9px; font-size: 11px; font-weight: 600; border-radius: 6px; border: 1px solid rgba(56, 189, 248, 0.35); background: rgba(255,255,255,0.04); color: #7dd3fc; cursor: pointer; white-space: nowrap;"><i class="fa-solid fa-bolt"></i> NAI V4/4.5</button>
                            <button class="rbq-pm-model-tab" data-model="general" style="padding: 3px 9px; font-size: 11px; font-weight: 600; border-radius: 6px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.04); color: #cbd5e1; cursor: pointer; white-space: nowrap;">通用</button>
                            <button class="rbq-pm-model-tab" data-model="mine" style="padding: 3px 9px; font-size: 11px; font-weight: 600; border-radius: 6px; border: 1px solid rgba(245, 158, 11, 0.45); background: rgba(255,255,255,0.04); color: #fbbf24; cursor: pointer; white-space: nowrap;"><i class="fa-solid fa-crown"></i> 我的上传</button>
                            <button class="rbq-pm-model-tab" data-model="liked" style="padding: 3px 9px; font-size: 11px; font-weight: 600; border-radius: 6px; border: 1px solid rgba(244, 63, 94, 0.45); background: rgba(255,255,255,0.04); color: #fb7185; cursor: pointer; white-space: nowrap;"><i class="fa-solid fa-heart"></i> 已点赞</button>
                        </div>

                        <!-- Divider -->
                        <span id="rbq-pm-filter-divider" style="color: rgba(255,255,255,0.18); font-size: 12px; margin: 0 1px; flex-shrink: 0;">|</span>

                        <!-- Tag Pills Track -->
                        <div id="rbq-pm-tag-bar" style="display: flex; gap: 5px; align-items: center; flex-shrink: 0;">
                            <!-- Generated by renderTags -->
                        </div>
                    </div>
                </div>

                <!-- Main Content (Cards Grid) -->
                <div id="rbq-pm-card-grid">
                    <!-- Cards will be populated here -->
                </div>
            </div>
        `;

        document.body.appendChild(marketModal);

        // 事件监听 (极速防抖关闭)
        bindFastClose(marketModal.querySelector('#rbq-pm-btn-close'), () => {
            closeMarketModal();
        });

        // 遮罩空白区点击关闭 (防误关与穿透防御体系)
        let marketBackdropPointerDown = false;
        marketModal.addEventListener('pointerdown', (e) => {
            marketBackdropPointerDown = (e.target === marketModal);
        });
        marketModal.addEventListener('click', (e) => {
            if (!marketBackdropPointerDown) return;
            marketBackdropPointerDown = false;
            if (e.target !== marketModal) return;

            // 防御 1: 若当前页面上仍有任何子弹窗存在，严禁关闭工坊底层
            if (isAnySubModalOpen()) return;

            // 防御 2: 若过去 450ms 内刚关闭过子弹窗，彻底拦截合成事件与手势穿透
            if (Date.now() - lastSubModalClosedAt < 450) return;

            e.preventDefault();
            e.stopPropagation();
            closeMarketModal();
        });

        // 刷新工坊数据按钮
        const refreshBtn = marketModal.querySelector('#rbq-pm-btn-refresh');
        if (refreshBtn) {
            refreshBtn.onclick = async () => {
                const icon = refreshBtn.querySelector('i');
                if (icon) icon.classList.add('fa-spin');
                refreshBtn.disabled = true;
                try {
                    await loadMarketData();
                    toastr.success('🎉 工坊预设已刷新至最新！');
                } catch (e) {
                    toastr.error('刷新失败: ' + (e.message || String(e)));
                } finally {
                    if (icon) icon.classList.remove('fa-spin');
                    refreshBtn.disabled = false;
                }
            };
        }

        marketModal.querySelector('#rbq-pm-btn-test-prompts').onclick = () => openTestPromptsDialog();
        marketModal.querySelector('#rbq-pm-btn-upload').onclick = () => openUploadDialog();
        marketModal.querySelector('#rbq-pm-btn-settings').onclick = () => openSettingsDialog();

        // 模型与专属分类 Filter 切换
        marketModal.querySelectorAll('.rbq-pm-model-tab').forEach(tab => {
            tab.onclick = () => {
                marketModal.querySelectorAll('.rbq-pm-model-tab').forEach(t => {
                    t.classList.remove('active');
                    t.style.background = 'rgba(255,255,255,0.04)';
                    t.style.borderColor = (t.dataset.model === 'mine') ? 'rgba(245, 158, 11, 0.45)' : (t.dataset.model === 'liked' ? 'rgba(244, 63, 94, 0.45)' : (t.dataset.model === 'v5' ? 'rgba(217, 70, 239, 0.35)' : (t.dataset.model === 'v4.5' ? 'rgba(56, 189, 248, 0.35)' : 'rgba(255,255,255,0.12)')));
                    t.style.color = (t.dataset.model === 'mine') ? '#fbbf24' : (t.dataset.model === 'liked' ? '#fb7185' : (t.dataset.model === 'v5' ? '#f0abfc' : (t.dataset.model === 'v4.5' ? '#7dd3fc' : (t.dataset.model === 'general' ? '#cbd5e1' : '#38bdf8'))));
                });
                tab.classList.add('active');
                if (tab.dataset.model === 'mine') {
                    tab.style.background = 'rgba(245, 158, 11, 0.22)';
                    tab.style.borderColor = '#f59e0b';
                    tab.style.color = '#fef08a';
                } else if (tab.dataset.model === 'liked') {
                    tab.style.background = 'rgba(244, 63, 94, 0.22)';
                    tab.style.borderColor = '#f43f5e';
                    tab.style.color = '#fda4af';
                } else if (tab.dataset.model === 'v5') {
                    tab.style.background = 'rgba(217, 70, 239, 0.22)';
                    tab.style.borderColor = '#d946ef';
                    tab.style.color = '#f0abfc';
                } else if (tab.dataset.model === 'v4.5') {
                    tab.style.background = 'rgba(56, 189, 248, 0.22)';
                    tab.style.borderColor = '#38bdf8';
                    tab.style.color = '#7dd3fc';
                } else {
                    tab.style.background = 'rgba(56, 189, 248, 0.18)';
                    tab.style.borderColor = '#38bdf8';
                    tab.style.color = '#38bdf8';
                }
                activeModelFilter = tab.dataset.model;
                refreshDynamicTags();
                renderCards();
            };
        });

        const searchInput = marketModal.querySelector('#rbq-pm-search-input');
        searchInput.oninput = (e) => {
            searchQuery = e.target.value.trim().toLowerCase();
            renderCards();
        };

        const sortSelect = marketModal.querySelector('#rbq-pm-sort-select');
        sortSelect.onchange = (e) => {
            sortMode = e.target.value;
            renderCards();
        };

        refreshDynamicTags();
        loadMarketData();
    }

    function refreshDynamicTags() {
        if (!marketModal) return;
        const tagBar = marketModal.querySelector('#rbq-pm-tag-bar');
        const divider = marketModal.querySelector('#rbq-pm-filter-divider');
        if (!tagBar) return;
        tagBar.innerHTML = '';

        // 动态汇总当前选定模型分类中真实存在的标签
        const tagCounts = new Map();
        const cfg = getConfig();
        const modelFilteredList = (cachedList || []).filter(it => {
            if (activeModelFilter === 'mine') {
                return isMyPreset(it, cfg);
            } else if (activeModelFilter === 'liked') {
                return Array.isArray(cfg.likedIds) && cfg.likedIds.includes(it.id);
            } else if (activeModelFilter === 'v5') {
                const m = (it.model || '').toLowerCase();
                const tags = Array.isArray(it.tags) ? it.tags : [];
                return m === 'v5' || tags.some(t => /v5/i.test(t));
            } else if (activeModelFilter === 'v4.5' || activeModelFilter === 'v4') {
                const m = (it.model || '').toLowerCase();
                const tags = Array.isArray(it.tags) ? it.tags : [];
                return m === 'v4.5' || m === 'v4' || m.includes('v4') || tags.some(t => /v4/i.test(t));
            } else if (activeModelFilter === 'general') {
                const m = (it.model || '').toLowerCase();
                return m !== 'v5' && m !== 'v4.5' && m !== 'v4' && !m.includes('v4');
            }
            return true;
        });

        modelFilteredList.forEach(item => {
            if (Array.isArray(item.tags)) {
                item.tags.forEach(t => {
                    const tag = String(t || '').trim();
                    if (tag && tag !== '全部' && tag !== 'NAI V5' && tag !== 'NAI V4.5' && tag !== 'NAI V4') {
                        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
                    }
                });
            }
        });

        // 若当前选中的标签在所有预设中已被删除，自动重置为“全部”
        if (activeTag !== '全部' && !tagCounts.has(activeTag)) {
            activeTag = '全部';
        }

        // 若云端没有任何预设标签，隐藏分隔符并只保留全部
        if (tagCounts.size === 0) {
            if (divider) divider.style.display = 'none';
            return;
        }

        if (divider) divider.style.display = 'inline';

        const availableTags = ['全部', ...Array.from(tagCounts.keys())];

        availableTags.forEach(tag => {
            const btn = document.createElement('button');
            const isActive = tag === activeTag;
            btn.className = 'rbq-pm-tag-pill' + (isActive ? ' active' : '');
            btn.style.cssText = `
                padding: 3px 9px; font-size: 11px; font-weight: 500; border-radius: 12px;
                border: 1px solid ${isActive ? '#38bdf8' : 'rgba(255,255,255,0.08)'};
                background: ${isActive ? 'rgba(56, 189, 248, 0.15)' : 'rgba(255,255,255,0.03)'};
                color: ${isActive ? '#38bdf8' : '#94a3b8'}; cursor: pointer; white-space: nowrap;
            `;
            const count = tagCounts.get(tag);
            btn.textContent = tag + (count ? ` (${count})` : '');
            btn.onclick = () => {
                activeTag = tag;
                refreshDynamicTags();
                renderCards();
            };
            tagBar.appendChild(btn);
        });
    }

    // ── 作品归属判定 ──
    // 1.1.31 起服务器的公开列表不再返回 creatorKey；改为带鉴权头调用 GET /api/my-presets
    // 取回“属于我的预设 id 列表”。旧服务器没有该接口时 (404/网络错误) 退回只用本地 myUploadedIds。
    let serverOwnedIds = new Set();

    function isMyPreset(item, cfg = getConfig()) {
        if (!item || item.id === undefined || item.id === null) return false;
        return serverOwnedIds.has(item.id) || (Array.isArray(cfg.myUploadedIds) && cfg.myUploadedIds.includes(item.id));
    }

    async function refreshMyPresetIds() {
        const cfg = getConfig();
        const key = String(cfg.creatorKey || '').trim();
        const endpoint = String(cfg.serverUrl || cfg.workerUrl || '').replace(/\/+$/, '');
        serverOwnedIds = new Set();
        if (!key || !endpoint) return serverOwnedIds;
        try {
            const res = await fetch(`${endpoint}/api/my-presets?_t=${Date.now()}`, {
                headers: { 'Authorization': `Bearer ${key}` }
            });
            if (!res.ok) return serverOwnedIds;
            const data = await res.json();
            if (data && Array.isArray(data.ids)) {
                serverOwnedIds = new Set(data.ids);
                // 同步到本地，保持“跨端填入个人码即可认领点亮”的旧体验
                if (!Array.isArray(cfg.myUploadedIds)) cfg.myUploadedIds = [];
                let syncedAny = false;
                data.ids.forEach(id => {
                    if (!cfg.myUploadedIds.includes(id)) {
                        cfg.myUploadedIds.push(id);
                        syncedAny = true;
                    }
                });
                if (syncedAny) saveConfig();
            }
        } catch (e) {
            console.warn('[RBQ-Market] 获取我的作品列表失败 (旧版服务器或网络问题)，仅使用本地记录:', e);
        }
        return serverOwnedIds;
    }

    // ── 历史预设静默无感自动认领 ──
    async function silentlyClaimMyHistoricalPresets(list) {
        if (!Array.isArray(list) || list.length === 0) return;
        const cfg = getConfig();
        if (!cfg.creatorKey || !Array.isArray(cfg.myUploadedIds) || cfg.myUploadedIds.length === 0) return;
        const uploadEndpoint = (cfg.serverUrl || cfg.workerUrl || '').replace(/\/+$/, '');
        if (!uploadEndpoint) return;

        // 筛选出本地记录了上传凭据、但云端尚未绑定创作者码的预设
        // 1.1.31+ 服务器只返回 hasOwner 布尔值；旧服务器仍可能返回 creatorKey
        const alreadyBound = (item) => {
            if (serverOwnedIds.has(item.id)) return true;
            if (typeof item.hasOwner === 'boolean') return item.hasOwner;
            return Boolean(item.creatorKey && String(item.creatorKey).trim());
        };
        const unclaimed = list.filter(item => cfg.myUploadedIds.includes(item.id) && !alreadyBound(item));

        if (unclaimed.length === 0) return;

        let claimedAny = false;
        for (const item of unclaimed) {
            try {
                const res = await fetch(`${uploadEndpoint}/api/claim`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        id: item.id,
                        creatorKey: cfg.creatorKey,
                        author: cfg.authorName || ''
                    })
                });
                const data = await res.json();
                if (res.ok && data.success) {
                    item.hasOwner = true;
                    serverOwnedIds.add(item.id);
                    claimedAny = true;
                    console.log(`[RBQ-Market] 静默认领成功: 预设「${item.title}」已永久固化至创作者码`);
                }
            } catch (e) {
                console.warn('[RBQ-Market] 静默认领请求跳过:', e);
            }
        }
        if (claimedAny) {
            renderCards();
        }
    }

    async function loadMarketData() {
        const grid = marketModal.querySelector('#rbq-pm-card-grid');
        grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 60px; color: #64748b;"><i class="fa-solid fa-spinner fa-spin" style="font-size: 26px; margin-bottom: 10px; color: #38bdf8;"></i><div>正在获取社区云端预设工坊...</div></div>';

        try {
            const list = await fetchCloudIndex();
            cachedList = Array.isArray(list) ? list : BUILTIN_PRESETS;
            // 自动同步属于当前创作者个人码的预设，跨端/跨浏览器即时认领点亮 (鉴权接口，不再读公开列表里的 creatorKey)
            await refreshMyPresetIds();
            refreshDynamicTags();
            renderCards();
            silentlyClaimMyHistoricalPresets(cachedList);
        } catch (_err) {
            cachedList = BUILTIN_PRESETS;
            refreshDynamicTags();
            renderCards();
        }
    }

    // ── 卡片 HTML（纯函数：所有社区字段都经过转义 / URL 校验） ──
    function buildCardHtml(item, flags = {}) {
        const { isInstalled = false, isLiked = false, isMyWork = false, isAdmin = false } = flags;
        const previewSrc = safeImageUrl(item.previewUrl, KAMI_DEFAULT_PREVIEW);

        // 模型 Badge 样式判定
        const m = String(item.model || '').toLowerCase();
        const itemTags = safeTags(item.tags);
        let modelBadgeClass = 'rbq-pm-badge-gen';
        let modelBadgeText = '通用';
        let modelBadgeIcon = '';
        if (m === 'v5' || itemTags.includes('NAI V5')) {
            modelBadgeClass = 'rbq-pm-badge-v5';
            modelBadgeText = 'NAI V5';
            modelBadgeIcon = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
        } else if (m === 'v4.5' || itemTags.includes('NAI V4.5')) {
            modelBadgeClass = 'rbq-pm-badge-v45';
            modelBadgeText = 'NAI V4.5';
            modelBadgeIcon = '<i class="fa-solid fa-bolt"></i>';
        }

        return `
            <div class="rbq-pm-img-wrap">
                <img src="${escapeHtml(previewSrc)}" alt="${escapeHtml(item.title)}" loading="lazy">
                <div class="rbq-pm-badge-model ${modelBadgeClass}">${modelBadgeIcon} <span>${modelBadgeText}</span></div>
                ${isMyWork ? '<div class="rbq-pm-badge-mine" title="你发布的作品"><i class="fa-solid fa-crown"></i> <span>我的</span></div>' : ''}
                <button class="rbq-pm-card-like ${isLiked ? 'is-liked' : ''}" title="点赞预设">
                    <i class="fa-${isLiked ? 'solid' : 'regular'} fa-heart"></i>
                    <span class="rbq-pm-like-num">${safeCount(item.likes)}</span>
                </button>
                ${safeImageUrl(item.referenceUrl) ? `
                <div class="rbq-pm-badge-ref" title="附带作者自制效果参考图" style="position:absolute; bottom:6px; left:6px; background:rgba(0,0,0,0.72); backdrop-filter:blur(4px); font-size:9.5px; padding:2px 6px; border-radius:4px; color:#38bdf8; border:1px solid rgba(56,189,248,0.35); z-index:2; display:flex; align-items:center; gap:3px; font-weight:600;">
                    <i class="fa-solid fa-images"></i> 附参考图
                </div>` : ''}
                <div style="position: absolute; bottom: 0; inset-inline: 0; height: 32px; background: linear-gradient(transparent, rgba(15,23,42,0.85)); pointer-events: none;"></div>
            </div>
            <div class="rbq-pm-card-info">
                <div class="rbq-pm-card-title" title="${escapeHtml(item.title)}">
                    ${escapeHtml(item.title)}
                </div>
                <div class="rbq-pm-card-meta">
                    <span class="rbq-pm-card-author" title="${escapeHtml(item.author || '匿名')}">
                        <i class="fa-regular fa-user" style="font-size: 9.5px;"></i>
                        <span>${escapeHtml(item.author || '匿名')}</span>
                        ${(isAdmin && !isMyWork) ? '<span title="管理员巡查模式" style="font-size:9.5px; opacity:0.75;">🛡️</span>' : ''}
                    </span>
                    <div class="rbq-pm-card-actions">
                        <button class="rbq-pm-card-test-btn menu_button" title="现场出图试用此画师串">
                            <i class="fa-solid fa-wand-magic-sparkles"></i>
                            <span>测试</span>
                        </button>
                        <button class="rbq-pm-install-btn menu_button" style="
                            background: ${isInstalled ? 'rgba(34, 197, 94, 0.15)' : 'linear-gradient(135deg, #0284c7, #2563eb)'};
                            border: 1px solid ${isInstalled ? '#22c55e' : 'transparent'};
                            color: ${isInstalled ? '#22c55e' : '#fff'};
                            cursor: pointer;
                        ">
                            <i class="fa-solid ${isInstalled ? 'fa-check' : 'fa-download'}"></i>
                            <span>${isInstalled ? '已装' : '安装'}</span>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    function renderCards() {
        const grid = marketModal.querySelector('#rbq-pm-card-grid');
        grid.innerHTML = '';

        let items = [...cachedList];

        const cfg = getConfig();

        // 模型与专属分类过滤
        if (activeModelFilter !== 'all') {
            if (activeModelFilter === 'mine') {
                items = items.filter(it => {
                    return isMyPreset(it, cfg);
                });
            } else if (activeModelFilter === 'liked') {
                items = items.filter(it => Array.isArray(cfg.likedIds) && cfg.likedIds.includes(it.id));
            } else {
                items = items.filter(it => {
                    const m = (it.model || '').toLowerCase();
                    const tags = Array.isArray(it.tags) ? it.tags : [];
                    if (activeModelFilter === 'v5') return m === 'v5' || tags.some(t => /v5/i.test(t));
                    if (activeModelFilter === 'v4.5' || activeModelFilter === 'v4') return m === 'v4.5' || m === 'v4' || m.includes('v4') || tags.some(t => /v4/i.test(t));
                    if (activeModelFilter === 'general') return m !== 'v5' && m !== 'v4.5' && m !== 'v4' && !m.includes('v4');
                    return true;
                });
            }
        }

        // 标签过滤
        if (activeTag !== '全部') {
            items = items.filter(it => Array.isArray(it.tags) && it.tags.includes(activeTag));
        }

        // 关键词搜索
        if (searchQuery) {
            items = items.filter(it =>
                (it.title || '').toLowerCase().includes(searchQuery) ||
                (it.author || '').toLowerCase().includes(searchQuery) ||
                (it.description || '').toLowerCase().includes(searchQuery) ||
                (Array.isArray(it.tags) && it.tags.some(t => t.toLowerCase().includes(searchQuery)))
            );
        }

        // 排序：点赞数、下载量、最新
        if (sortMode === 'likes') {
            items.sort((a, b) => ((b.likes || 0) - (a.likes || 0)) || (new Date(b.createdAt || 0) - new Date(a.createdAt || 0)));
        } else if (sortMode === 'downloads') {
            items.sort((a, b) => ((b.downloads || 0) - (a.downloads || 0)) || (new Date(b.createdAt || 0) - new Date(a.createdAt || 0)));
        } else if (sortMode === 'newest') {
            items.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        }

        if (items.length === 0) {
            if (activeModelFilter === 'mine') {
                grid.innerHTML = `
                    <div style="grid-column: 1 / -1; display:flex; flex-direction:column; align-items:center; justify-content:center; padding: 60px 20px; color:#94a3b8; text-align:center;">
                        <div style="font-size:38px; margin-bottom:12px; color:#fbbf24;"><i class="fa-solid fa-crown"></i></div>
                        <div style="font-size:15px; font-weight:700; color:#f1f5f9; margin-bottom:6px;">暂未找到你发布的作品</div>
                        <div style="font-size:12px; color:#64748b; max-width:440px; line-height:1.6; margin-bottom:16px;">
                            ${cfg.creatorKey ? `当前创作者身份码为 <code>${escapeHtml(cfg.creatorKey)}</code>，该身份码下暂无作品。` : `如果你曾在本设备或其他设备上绑定过个人码（例如：<code>RBQ-U-d31879f4</code>），点击下方填入即可瞬间认领并管理属于你的全部云端作品！`}
                        </div>
                        <button id="rbq-pm-empty-claim-btn" class="menu_button" style="background:linear-gradient(135deg, #f59e0b, #d97706); border:none; color:#fff; font-size:12px; font-weight:700; padding:6px 18px; border-radius:6px; cursor:pointer;">
                            <i class="fa-solid fa-key"></i> 填入个人码 / 管理作品
                        </button>
                    </div>
                `;
                const claimBtn = grid.querySelector('#rbq-pm-empty-claim-btn');
                if (claimBtn) {
                    claimBtn.onclick = () => openSettingsDialog();
                }
                return;
            }
            if (activeModelFilter === 'liked') {
                grid.innerHTML = `
                    <div style="grid-column: 1 / -1; display:flex; flex-direction:column; align-items:center; justify-content:center; padding: 60px 20px; color:#94a3b8; text-align:center;">
                        <div style="font-size:38px; margin-bottom:12px; color:#fb7185;"><i class="fa-solid fa-heart"></i></div>
                        <div style="font-size:15px; font-weight:700; color:#f1f5f9; margin-bottom:6px;">暂无已点赞预设</div>
                        <div style="font-size:12px; color:#64748b; max-width:440px; line-height:1.6;">
                            在工坊浏览时，点击卡片右上角的 ❤️ 即可将喜欢的预设收藏至此，方便随时重访与一键装入！
                        </div>
                    </div>
                `;
                return;
            }
            const emptyHtml = cachedList.length === 0
                ? '<i class="fa-regular fa-folder-open" style="font-size: 38px; margin-bottom: 14px; color: #475569;"></i><div style="font-size: 13.5px; font-weight: 600; color: #cbd5e1; margin-bottom: 6px;">工坊展厅目前暂无预设</div><div style="font-size: 12px; color: #64748b;">点击右上角「发布预设」，快来成为第一个分享神仙画师串的人吧！</div>'
                : '<i class="fa-regular fa-folder-open" style="font-size: 34px; margin-bottom: 12px; color: #475569;"></i><div style="font-size: 13px; color: #94a3b8;">当前筛选分类下暂无预设</div>';
            grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 70px 20px; color: #64748b;">${emptyHtml}</div>`;
            return;
        }

        items.forEach(item => {
            const isInstalled = cfg.installedIds.includes(item.id);
            const isLiked = cfg.likedIds.includes(item.id);
            const isMyWork = isMyPreset(item, cfg);
            const isAdmin = Boolean(cfg.adminKey && cfg.adminKey.trim());
            const card = document.createElement('div');
            card.className = 'rbq-pm-card';

            card.innerHTML = buildCardHtml(item, { isInstalled, isLiked, isMyWork, isAdmin });

            // 点击卡片直接打开详情 (排除点赞、测试、安装等交互按钮)
            card.onclick = async (e) => {
                if (e.target.closest('.rbq-pm-card-like') || e.target.closest('.rbq-pm-install-btn') || e.target.closest('.rbq-pm-card-test-btn')) return;
                const full = await fetchPresetDetail(item);
                openDetailDialog(full);
            };

            // 点赞
            const likeBtn = card.querySelector('.rbq-pm-card-like');
            const likeNum = card.querySelector('.rbq-pm-like-num');
            likeBtn.onclick = (e) => {
                e.stopPropagation();
                likePreset(item, likeBtn, likeNum);
            };

            // 测试画师串按钮 (免点进详情，直接唤起现场试炼台)
            const testBtn = card.querySelector('.rbq-pm-card-test-btn');
            if (testBtn) {
                testBtn.onclick = async (e) => {
                    e.stopPropagation();
                    const full = await fetchPresetDetail(item);
                    openLiveTestModal(full);
                };
            }

            // 安装按钮
            const installBtn = card.querySelector('.rbq-pm-install-btn');
            installBtn.onclick = async (e) => {
                e.stopPropagation();
                const full = await fetchPresetDetail(item);
                installToLocalPresets(full);
                installBtn.style.background = 'rgba(34, 197, 94, 0.15)';
                installBtn.style.borderColor = '#22c55e';
                installBtn.style.color = '#22c55e';
                installBtn.innerHTML = '<i class="fa-solid fa-check"></i> <span>已装</span>';
            };

            grid.appendChild(card);
        });
    }

    // ── 编辑预设与风格标签弹窗 ──
    function openEditPresetDialog(item, parentOverlay) {
        const cfg = getConfig();
        const overlay = document.createElement('div');
        overlay.id = 'rbq-pm-edit-dialog';
        overlay.style.cssText = 'position:fixed; inset:0; z-index:2147483644; background:rgba(0,0,0,0.88); display:flex; align-items:center; justify-content:center; backdrop-filter:blur(10px);';

        const existingTagsStr = (item.tags || []).join(' ');
        const m = (item.model || 'v5').toLowerCase();

        let editRefBase64 = null; // null: 未改动, '': 清空/移除, 'data:...': 新替换图片
        let editBmBase64 = null;  // null: 未改动, 'data:...': 新替换官方基准图

        const s = (typeof RBQ?.api?.getSettings === 'function') ? RBQ.api.getSettings() : {};
        const p = item.params || {};
        let editScale = p.scale !== undefined && p.scale !== null ? Number(p.scale) : (s.naiScale !== undefined && s.naiScale !== null ? Number(s.naiScale) : 6.0);
        let editSampler = p.sampler || s.naiSampler || 'k_euler_ancestral';
        let editSteps = p.steps !== undefined && p.steps !== null ? Number(p.steps) : (s.naiSteps !== undefined && s.naiSteps !== null ? Number(s.naiSteps) : 28);
        let editCfgRescale = p.cfgRescale !== undefined && p.cfgRescale !== null ? Number(p.cfgRescale) : (s.naiCfgRescale !== undefined && s.naiCfgRescale !== null ? Number(s.naiCfgRescale) : 0);

        overlay.innerHTML = `
            <div style="width:92vw; max-width:640px; max-height:90vh; background:#0f172a; border:1px solid rgba(56,189,248,0.3); border-radius:14px; display:flex; flex-direction:column; overflow:hidden; color:#fff; box-shadow:0 25px 60px rgba(0,0,0,0.85);">
                <div style="padding:14px 18px; background:#1e293b; border-bottom:1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center;">
                    <div style="font-size:15px; font-weight:700; display:flex; align-items:center; gap:8px; color:#38bdf8;">
                        <i class="fa-solid fa-pen-to-square"></i>
                        <span>编辑预设与展示图片</span>
                    </div>
                    <button id="rbq-pm-edit-close" class="rbq-pm-close-btn" title="关闭"><i class="fa-solid fa-xmark"></i></button>
                </div>

                <div style="padding:16px 18px; overflow-y:auto; flex:1; display:flex; flex-direction:column; gap:12px;">
                    <div class="rbq-pm-up-grid-2col" style="display:grid; grid-template-columns: 2fr 1fr; gap:10px;">
                        <div>
                            <label style="font-size:12px; color:#94a3b8; display:block; margin-bottom:4px;">预设标题 *</label>
                            <input id="rbq-pm-edit-title" type="text" value="${escapeHtml(item.title || '')}" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:6px 10px; color:#fff; font-size:12px; box-sizing:border-box;">
                        </div>
                        <div>
                            <label style="font-size:12px; color:#94a3b8; display:block; margin-bottom:4px;">适配模型 *</label>
                            <select id="rbq-pm-edit-model" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:6px; color:#fff; font-size:12px; box-sizing:border-box;">
                                <option value="v5" ${m === 'v5' ? 'selected' : ''}>✨ NAI V5</option>
                                <option value="v4.5" ${m === 'v4.5' ? 'selected' : ''}>⚡ NAI V4.5</option>
                                <option value="general" ${(m !== 'v5' && m !== 'v4.5') ? 'selected' : ''}>🌐 通用 / SDXL</option>
                            </select>
                        </div>
                    </div>

                    <div class="rbq-pm-up-grid-2col" style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
                        <div>
                            <label style="font-size:12px; color:#94a3b8; display:block; margin-bottom:4px;">作者昵称</label>
                            <input id="rbq-pm-edit-author" type="text" placeholder="匿名" value="${escapeHtml(item.author || cfg.authorName || '匿名')}" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:6px 10px; color:#fff; font-size:12px; box-sizing:border-box;">
                        </div>
                        <div>
                            <label style="font-size:12px; color:#fbbf24; font-weight:600; display:block; margin-bottom:4px;">
                                <i class="fa-solid fa-tags"></i> 风格标签 (空格分隔追加)
                            </label>
                            <input id="rbq-pm-edit-tags" type="text" placeholder="例如: 3D 写实 御姐 油光丝袜" value="${escapeHtml(existingTagsStr)}" style="width:100%; background:#1e293b; border:1px solid rgba(245,158,11,0.4); border-radius:6px; padding:6px 10px; color:#fef08a; font-size:12px; box-sizing:border-box;">
                        </div>
                    </div>

                    <div>
                        <label style="font-size:12px; color:#38bdf8; display:block; margin-bottom:4px; font-weight:600;"><i class="fa-solid fa-paintbrush"></i> 用户画师 / 风格预设词 (Positive) *</label>
                        <textarea id="rbq-pm-edit-pos" rows="3" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:8px; color:#fff; font-size:12px; box-sizing:border-box; line-height:1.4;">${escapeHtml(item.positive || '')}</textarea>
                    </div>

                    <div>
                        <label style="font-size:12px; color:#94a3b8; display:block; margin-bottom:4px;">负面提示词 (可选)</label>
                        <textarea id="rbq-pm-edit-neg" rows="2" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:8px; color:#fff; font-size:12px; box-sizing:border-box;">${escapeHtml(item.negative || '')}</textarea>
                    </div>

                    <div>
                        <label style="font-size:12px; color:#94a3b8; display:block; margin-bottom:4px;">预设描述 / 介绍说明 (可选)</label>
                        <input id="rbq-pm-edit-desc" type="text" placeholder="简短描述该画师串的风格特色..." value="${escapeHtml(item.description || '')}" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:6px 10px; color:#fff; font-size:12px; box-sizing:border-box;">
                    </div>

                    <!-- NAI 生图参数设定 (编辑模式) -->
                    <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:10px 12px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:6px;">
                            <span style="font-size:11.5px; color:#c084fc; font-weight:700;"><i class="fa-solid fa-sliders"></i> NAI 生图参数设定</span>
                            <button id="rbq-pm-edit-param-mine-btn" type="button" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; font-size:10.5px; font-weight:600; padding:3px 10px; border-radius:5px; background:linear-gradient(135deg, #0284c7, #2563eb); border:none; color:#fff; cursor:pointer; transition:all 0.15s;" title="快速载入当前酒馆设置中正在生效的 NAI 参数">
                                <i class="fa-solid fa-user-gear"></i> 我的酒馆设置
                            </button>
                        </div>
                        <div class="rbq-pm-up-params-grid" style="display:grid; grid-template-columns: 1fr 1.35fr 1fr 1fr; gap:6px;">
                            <div>
                                <div style="font-size:9.5px; color:#94a3b8; margin-bottom:2px;">Scale (CFG)</div>
                                <input id="rbq-pm-edit-param-scale" type="number" step="0.5" value="${editScale}" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:5px; padding:4px 6px; color:#38bdf8; font-size:11px; font-family:monospace; box-sizing:border-box;">
                            </div>
                            <div>
                                <div style="font-size:9.5px; color:#94a3b8; margin-bottom:2px;">采样器 (Sampler)</div>
                                <select id="rbq-pm-edit-param-sampler" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:5px; padding:4px 6px; color:#f0abfc; font-size:11px; outline:none; cursor:pointer; box-sizing:border-box;">
                                    <!-- populated dynamically -->
                                </select>
                            </div>
                            <div>
                                <div style="font-size:9.5px; color:#94a3b8; margin-bottom:2px;">步数 (Steps)</div>
                                <input id="rbq-pm-edit-param-steps" type="number" step="1" value="${editSteps}" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:5px; padding:4px 6px; color:#4ade80; font-size:11px; font-family:monospace; box-sizing:border-box;">
                            </div>
                            <div>
                                <div style="font-size:9.5px; color:#94a3b8; margin-bottom:2px;">CFG Rescale</div>
                                <input id="rbq-pm-edit-param-rescale" type="number" step="0.05" value="${editCfgRescale}" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:5px; padding:4px 6px; color:#fbbf24; font-size:11px; font-family:monospace; box-sizing:border-box;">
                            </div>
                        </div>
                    </div>

                    <!-- 封面基准图管理卡片 (官方标准) -->
                    <div style="background:linear-gradient(135deg, rgba(217,70,239,0.06), rgba(168,85,247,0.06)); border:1.5px solid rgba(217,70,239,0.3); border-radius:10px; padding:10px 12px; display:flex; flex-direction:column; gap:8px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:4px;">
                            <label style="font-size:12px; color:#f0abfc; font-weight:700; margin:0; display:inline-flex; align-items:center; gap:5px;">
                                <i class="fa-solid fa-flask"></i> 封面基准测试图 (官方基准)
                            </label>
                            <span id="rbq-pm-edit-bm-spec" style="font-size:10px; color:#94a3b8;">720px WebP 封面</span>
                        </div>
                        <div style="display:flex; align-items:center; gap:12px; background:rgba(0,0,0,0.25); border:1px solid rgba(217,70,239,0.3); border-radius:8px; padding:8px 10px;">
                            <div id="rbq-pm-edit-bm-card" style="width:70px; aspect-ratio:3/4; border-radius:6px; overflow:hidden; background:#070b13; border:1px solid rgba(217,70,239,0.5); position:relative; cursor:zoom-in; flex-shrink:0;" title="点击放大">
                                <img id="rbq-pm-edit-bm-img" src="${escapeHtml(safeImageUrl(item.previewUrl, KAMI_DEFAULT_PREVIEW))}" style="width:100%; height:100%; object-fit:cover; display:block;">
                            </div>
                            <div style="flex:1; display:flex; flex-direction:column; gap:6px;">
                                <div id="rbq-pm-edit-bm-status" style="font-size:11px; color:#f0abfc; font-weight:600;">
                                    <i class="fa-solid fa-circle-check"></i> 当前官方基准测试封面
                                </div>
                                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                                    <button type="button" id="rbq-pm-edit-bm-zoom-btn" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); color:#cbd5e1; font-size:10.5px; padding:3px 8px; border-radius:4px; cursor:pointer;">
                                        <i class="fa-solid fa-magnifying-glass-plus"></i> 查看大图
                                    </button>
                                    <button type="button" id="rbq-pm-edit-bm-draw-btn" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; background:linear-gradient(135deg, #a855f7, #ec4899); border:none; color:#fff; font-size:10.5px; font-weight:700; padding:3px 10px; border-radius:4px; cursor:pointer;">
                                        <i class="fa-solid fa-wand-magic-sparkles"></i> 现场重新实测出图
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 自制参考图管理卡片 (可选伴生图) -->
                    <div style="background:linear-gradient(135deg, rgba(56,189,248,0.06), rgba(37,99,235,0.06)); border:1.5px solid rgba(56,189,248,0.3); border-radius:10px; padding:10px 12px; display:flex; flex-direction:column; gap:8px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:4px;">
                            <label style="font-size:12px; color:#7dd3fc; font-weight:700; margin:0; display:inline-flex; align-items:center; gap:5px;">
                                <i class="fa-solid fa-image"></i> 自制效果参考图 (可选伴生图)
                            </label>
                            <span id="rbq-pm-edit-ref-spec" style="font-size:10px; color:#94a3b8;">${item.referenceUrl ? '已绑定' : '未设置 (可选)'}</span>
                        </div>
                        <div style="font-size:11px; color:#cbd5e1; line-height:1.4;">
                            可在详情页与官方基准图无缝切换，用于展示该预设的个性化画面。
                        </div>

                        <!-- 参考图空态 (未设置或已被移除) -->
                        <div id="rbq-pm-edit-ref-empty" style="display:${item.referenceUrl ? 'none' : 'flex'}; flex-direction:column; gap:6px; background:rgba(0,0,0,0.25); border:1.5px dashed rgba(56,189,248,0.4); border-radius:8px; padding:10px; text-align:center; align-items:center; justify-content:center; cursor:pointer;">
                            <div style="font-size:11.5px; color:#7dd3fc; font-weight:600;"><i class="fa-solid fa-cloud-arrow-up"></i> 点击或拖拽上传自制参考图</div>
                            <button id="rbq-pm-edit-pick-ref-btn" type="button" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; background:linear-gradient(135deg, #0284c7, #2563eb); border:none; color:#fff; font-size:11px; font-weight:600; padding:4px 12px; border-radius:5px; cursor:pointer;">
                                <i class="fa-solid fa-folder-open"></i> 选择图片
                            </button>
                            <input id="rbq-pm-edit-file-ref" type="file" accept="image/*" style="display:none;">
                        </div>

                        <!-- 参考图展示态 (已有或新选中) -->
                        <div id="rbq-pm-edit-ref-card-box" style="display:${item.referenceUrl ? 'flex' : 'none'}; align-items:center; gap:12px; background:rgba(0,0,0,0.25); border:1px solid rgba(56,189,248,0.3); border-radius:8px; padding:8px 10px;">
                            <div id="rbq-pm-edit-ref-card" style="width:70px; aspect-ratio:3/4; border-radius:6px; overflow:hidden; background:#070b13; border:1px solid rgba(56,189,248,0.5); position:relative; cursor:zoom-in; flex-shrink:0;" title="点击放大">
                                <img id="rbq-pm-edit-ref-img" src="${escapeHtml(safeImageUrl(item.referenceUrl))}" style="width:100%; height:100%; object-fit:cover; display:block;">
                            </div>
                            <div style="flex:1; display:flex; flex-direction:column; gap:6px;">
                                <div id="rbq-pm-edit-ref-status" style="font-size:11px; color:#7dd3fc; font-weight:600;">
                                    <i class="fa-solid fa-circle-check"></i> ${item.referenceUrl ? '当前已绑定参考图' : '新选中的参考图'}
                                </div>
                                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                                    <button type="button" id="rbq-pm-edit-ref-zoom-btn" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); color:#cbd5e1; font-size:10.5px; padding:3px 8px; border-radius:4px; cursor:pointer;">
                                        <i class="fa-solid fa-magnifying-glass-plus"></i> 查看大图
                                    </button>
                                    <button type="button" id="rbq-pm-edit-ref-change-btn" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; background:rgba(56,189,248,0.18); border:1px solid rgba(56,189,248,0.4); color:#7dd3fc; font-size:10.5px; padding:3px 8px; border-radius:4px; cursor:pointer;">
                                        <i class="fa-solid fa-folder-open"></i> 更换图片
                                    </button>
                                    <button type="button" id="rbq-pm-edit-ref-clear-btn" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.35); color:#fca5a5; font-size:10.5px; padding:3px 8px; border-radius:4px; cursor:pointer;">
                                        <i class="fa-solid fa-trash-can"></i> 移除参考图
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div style="padding:12px 18px; background:#1e293b; border-top:1px solid rgba(255,255,255,0.08); display:flex; justify-content:flex-end; gap:8px;">
                    <button id="rbq-pm-edit-cancel" class="menu_button" style="font-size:12px; padding:6px 14px;">取消</button>
                    <button id="rbq-pm-edit-submit" class="menu_button" style="background:linear-gradient(135deg, #0284c7, #2563eb); border:none; color:#fff; font-size:12px; font-weight:700; padding:6px 18px; cursor:pointer;">
                        <i class="fa-solid fa-floppy-disk"></i> 保存修改
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        bindFastClose(overlay.querySelector('#rbq-pm-edit-close'), () => closeSubDialog(overlay));
        bindFastClose(overlay.querySelector('#rbq-pm-edit-cancel'), () => closeSubDialog(overlay));
        bindDialogBackdropClose(overlay);

        // ── NAI 生图参数交互 (编辑模式) ──
        const editScaleInput = overlay.querySelector('#rbq-pm-edit-param-scale');
        const editSamplerSelect = overlay.querySelector('#rbq-pm-edit-param-sampler');
        const editStepsInput = overlay.querySelector('#rbq-pm-edit-param-steps');
        const editRescaleInput = overlay.querySelector('#rbq-pm-edit-param-rescale');
        const editBtnMine = overlay.querySelector('#rbq-pm-edit-param-mine-btn');

        const populateEditSamplerOptions = (selectedVal) => {
            let optionsHtml = '';
            let matched = false;
            for (const sItem of NAI_SAMPLERS) {
                const isSel = (sItem.value === selectedVal);
                if (isSel) matched = true;
                optionsHtml += `<option value="${sItem.value}" ${isSel ? 'selected' : ''}>${sItem.label}</option>`;
            }
            if (!matched && selectedVal) {
                optionsHtml += `<option value="${escapeHtml(selectedVal)}" selected>${escapeHtml(selectedVal)}</option>`;
            }
            editSamplerSelect.innerHTML = optionsHtml;
        };

        populateEditSamplerOptions(editSampler);

        function getEditedParams() {
            return {
                scale: editScaleInput.value !== '' ? Number(editScaleInput.value) : 6.0,
                sampler: editSamplerSelect.value || 'k_euler_ancestral',
                steps: editStepsInput.value !== '' ? Math.max(1, Math.round(Number(editStepsInput.value))) : 28,
                cfgRescale: editRescaleInput.value !== '' ? Number(editRescaleInput.value) : 0
            };
        }

        if (editBtnMine) {
            editBtnMine.onclick = () => {
                const fresh = (typeof RBQ?.api?.getSettings === 'function') ? RBQ.api.getSettings() : {};
                const myScale = fresh.naiScale !== undefined && fresh.naiScale !== null ? Number(fresh.naiScale) : 6.0;
                const mySampler = fresh.naiSampler || 'k_euler_ancestral';
                const mySteps = fresh.naiSteps !== undefined && fresh.naiSteps !== null ? Number(fresh.naiSteps) : 28;
                const myRescale = fresh.naiCfgRescale !== undefined && fresh.naiCfgRescale !== null ? Number(fresh.naiCfgRescale) : 0;

                editScaleInput.value = myScale;
                populateEditSamplerOptions(mySampler);
                editSamplerSelect.value = mySampler;
                editStepsInput.value = mySteps;
                editRescaleInput.value = myRescale;
                toastr.info('已载入当前酒馆全局生图设置');
            };
        }

        // ── 封面基准图交互 ──
        const editBmImg = overlay.querySelector('#rbq-pm-edit-bm-img');
        const editBmStatus = overlay.querySelector('#rbq-pm-edit-bm-status');
        const editBmSpec = overlay.querySelector('#rbq-pm-edit-bm-spec');
        const editBmZoomBtn = overlay.querySelector('#rbq-pm-edit-bm-zoom-btn');
        const editBmDrawBtn = overlay.querySelector('#rbq-pm-edit-bm-draw-btn');
        const editBmCard = overlay.querySelector('#rbq-pm-edit-bm-card');

        if (editBmCard) editBmCard.onclick = () => { if (editBmImg.src) openImageZoom(editBmImg.src); };
        if (editBmZoomBtn) editBmZoomBtn.onclick = () => { if (editBmImg.src) openImageZoom(editBmImg.src); };

        if (editBmDrawBtn) {
            editBmDrawBtn.onclick = async () => {
                const pos = overlay.querySelector('#rbq-pm-edit-pos').value.trim();
                const neg = overlay.querySelector('#rbq-pm-edit-neg').value.trim();
                if (!pos) {
                    toastr.warning('请先输入正面提示词！');
                    return;
                }
                if (typeof RBQ?.api?.generateImage !== 'function') {
                    toastr.error('酒馆当前未启用 RBQ 生图流水线');
                    return;
                }
                const finalPrompt = [pos, BENCHMARK_POSITIVE_PROMPT].map(p => (p || '').trim().replace(/^,+|,+$/g, '').trim()).filter(Boolean).join(', ');
                const finalNegative = [neg, BENCHMARK_NEGATIVE_PROMPT].map(p => (p || '').trim().replace(/^,+|,+$/g, '').trim()).filter(Boolean).join(', ');

                const origHtml = editBmDrawBtn.innerHTML;
                editBmDrawBtn.disabled = true;
                editBmDrawBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 实测中...';
                try {
                    const ep = getEditedParams();
                    const uploadMeta = {
                        isolate: true,
                        skipPresets: true,
                        skipPrefixSuffix: true,
                        negative: finalNegative,
                        scale: ep.scale,
                        sampler: ep.sampler,
                        steps: ep.steps,
                        cfgRescale: ep.cfgRescale
                    };
                    const drawRes = await RBQ.api.generateImage(finalPrompt, 'market-preset-benchmark-edit', uploadMeta);
                    if (!drawRes || !drawRes.url) throw new Error('生图未返回有效地址');

                    const drawImg = new Image();
                    drawImg.crossOrigin = 'anonymous';
                    drawImg.onload = () => {
                        const { b64, width, height, approxKb, format } = compressToWebp(drawImg);
                        editBmBase64 = b64;
                        editBmImg.src = b64;
                        editBmStatus.innerHTML = '<i class="fa-solid fa-circle-check"></i> 现场重新实测出的基准图';
                        editBmSpec.textContent = `${width}x${height} ${format || 'WebP'} (~${approxKb}KB)`;
                        toastr.success('🎉 现场基准生图成功！保存后生效。');
                    };
                    drawImg.onerror = async () => {
                        try {
                            const blobResp = await fetch(drawRes.url);
                            const blob = await blobResp.blob();
                            const r = new FileReader();
                            r.onload = (e2) => {
                                const bImg = new Image();
                                bImg.onload = () => {
                                    const { b64, width, height, approxKb, format } = compressToWebp(bImg);
                                    editBmBase64 = b64;
                                    editBmImg.src = b64;
                                    editBmStatus.innerHTML = '<i class="fa-solid fa-circle-check"></i> 现场重新实测出的基准图';
                                    editBmSpec.textContent = `${width}x${height} ${format || 'WebP'} (~${approxKb}KB)`;
                                    toastr.success('🎉 现场基准生图成功！保存后生效。');
                                };
                                bImg.src = e2.target.result;
                            };
                            r.readAsDataURL(blob);
                        } catch (err) {
                            toastr.error('读取生图数据失败: ' + err.message);
                        }
                    };
                    drawImg.src = drawRes.url;
                } catch (err) {
                    toastr.error('现场基准生图失败: ' + (err.message || String(err)));
                } finally {
                    editBmDrawBtn.disabled = false;
                    editBmDrawBtn.innerHTML = origHtml;
                }
            };
        }

        // ── 自制参考图交互 ──
        const refEmptyEl = overlay.querySelector('#rbq-pm-edit-ref-empty');
        const refCardBox = overlay.querySelector('#rbq-pm-edit-ref-card-box');
        const refCard = overlay.querySelector('#rbq-pm-edit-ref-card');
        const refImg = overlay.querySelector('#rbq-pm-edit-ref-img');
        const refStatus = overlay.querySelector('#rbq-pm-edit-ref-status');
        const refSpec = overlay.querySelector('#rbq-pm-edit-ref-spec');
        const refFileInput = overlay.querySelector('#rbq-pm-edit-file-ref');
        const refPickBtn = overlay.querySelector('#rbq-pm-edit-pick-ref-btn');
        const refChangeBtn = overlay.querySelector('#rbq-pm-edit-ref-change-btn');
        const refClearBtn = overlay.querySelector('#rbq-pm-edit-ref-clear-btn');
        const refZoomBtn = overlay.querySelector('#rbq-pm-edit-ref-zoom-btn');

        function handleEditRefFile(file) {
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                const img = new Image();
                img.onload = () => {
                    const { b64, width, height, approxKb, format } = compressToWebp(img);
                    editRefBase64 = b64;
                    refImg.src = b64;
                    refEmptyEl.style.display = 'none';
                    refCardBox.style.display = 'flex';
                    refStatus.innerHTML = `<i class="fa-solid fa-circle-check"></i> 新选中的参考图 (${escapeHtml(file.name)})`;
                    refSpec.textContent = `${width}x${height} ${format || 'WebP'} (~${approxKb}KB)`;
                    toastr.success(`🎉 已选择「${file.name}」作为新参考图！`);
                };
                img.src = ev.target.result;
            };
            reader.readAsDataURL(file);
        }

        if (refCard) refCard.onclick = () => { if (refImg.src) openImageZoom(refImg.src); };
        if (refZoomBtn) refZoomBtn.onclick = () => { if (refImg.src) openImageZoom(refImg.src); };
        if (refPickBtn) refPickBtn.onclick = (e) => { e.stopPropagation(); refFileInput.click(); };
        if (refChangeBtn) refChangeBtn.onclick = (e) => { e.stopPropagation(); refFileInput.click(); };

        if (refClearBtn) {
            refClearBtn.onclick = () => {
                editRefBase64 = ''; // 标记清空
                refImg.src = '';
                refCardBox.style.display = 'none';
                refEmptyEl.style.display = 'flex';
                refFileInput.value = '';
                refSpec.textContent = '已移除';
                toastr.info('已将参考图标记为移除（保存修改后生效）');
            };
        }

        refFileInput.onchange = (e) => {
            const file = e.target.files?.[0];
            if (file) handleEditRefFile(file);
        };

        if (refEmptyEl) {
            refEmptyEl.onclick = (e) => {
                if (e.target !== refPickBtn) refFileInput.click();
            };
            refEmptyEl.ondragover = (e) => {
                e.preventDefault();
                refEmptyEl.style.borderColor = '#38bdf8';
                refEmptyEl.style.background = 'rgba(56, 189, 248, 0.16)';
            };
            refEmptyEl.ondragleave = (e) => {
                e.preventDefault();
                refEmptyEl.style.borderColor = 'rgba(56, 189, 248, 0.4)';
                refEmptyEl.style.background = 'rgba(0,0,0,0.25)';
            };
            refEmptyEl.ondrop = (e) => {
                e.preventDefault();
                refEmptyEl.style.borderColor = 'rgba(56, 189, 248, 0.4)';
                refEmptyEl.style.background = 'rgba(0,0,0,0.25)';
                const file = e.dataTransfer?.files?.[0];
                if (file && file.type.startsWith('image/')) {
                    handleEditRefFile(file);
                } else {
                    toastr.warning('请拖拽有效的图片文件 (PNG / JPG / WebP)');
                }
            };
        }

        overlay.querySelector('#rbq-pm-edit-submit').onclick = async () => {
            const title = overlay.querySelector('#rbq-pm-edit-title').value.trim();
            const positive = overlay.querySelector('#rbq-pm-edit-pos').value.trim();
            const author = overlay.querySelector('#rbq-pm-edit-author').value.trim() || '匿名';
            const model = overlay.querySelector('#rbq-pm-edit-model').value || 'v5';
            const negative = overlay.querySelector('#rbq-pm-edit-neg').value.trim();
            const description = overlay.querySelector('#rbq-pm-edit-desc').value.trim();
            const rawTags = overlay.querySelector('#rbq-pm-edit-tags').value.trim();
            const tags = rawTags.split(/[\s,，#]+/).map(t => t.trim()).filter(Boolean);

            if (!title || !positive) {
                toastr.warning('标题与正面预设词不能为空！');
                return;
            }

            const submitBtn = overlay.querySelector('#rbq-pm-edit-submit');
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 保存中...';

            const uploadEndpoint = (cfg.serverUrl || cfg.workerUrl || '').replace(/\/+$/, '');
            try {
                const finalParams = getEditedParams();
                const payload = {
                    id: item.id,
                    creatorKey: cfg.creatorKey,
                    adminKey: cfg.adminKey,
                    originalAuthor: item.author || '',
                    author,
                    title,
                    tags,
                    model,
                    positive,
                    negative,
                    description,
                    params: finalParams
                };
                if (editRefBase64 !== null) {
                    payload.referenceBase64 = editRefBase64;
                }
                if (editBmBase64 !== null) {
                    payload.previewBase64 = editBmBase64;
                }

                const res = await fetch(`${uploadEndpoint}/api/update`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                let data = null;
                try {
                    data = await res.json();
                } catch (_) {}

                if (res.ok && data?.success) {
                    if (data.item) {
                        Object.assign(item, data.item);
                    } else {
                        item.title = title;
                        item.author = author;
                        item.tags = tags;
                        item.model = model;
                        item.positive = positive;
                        item.negative = negative;
                        item.description = description;
                        item.params = finalParams;
                    }
                    if (!item.params) item.params = finalParams;

                    toastr.success('🎉 预设与图片已更新成功！');
                    closeSubDialog(overlay);
                    if (parentOverlay) closeSubDialog(parentOverlay);
                    refreshDynamicTags();
                    renderCards();
                    openDetailDialog(item);
                } else {
                    const errMsg = data?.error || (res.status ? `服务器异常 (HTTP ${res.status})` : '未知错误');
                    toastr.error('更新失败: ' + errMsg);
                }
            } catch (err) {
                toastr.error('网络请求错误: ' + (err.message || String(err)));
            } finally {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> 保存修改';
            }
        };
    }

    // ── 详情弹窗 HTML（纯函数：所有社区字段都经过转义 / URL 校验） ──
    function buildDetailHtml(item, flags = {}) {
        const { isMyWork = false, isAdmin = false } = flags;
        const previewSrc = safeImageUrl(item.previewUrl, KAMI_DEFAULT_PREVIEW);
        const referenceSrc = safeImageUrl(item.referenceUrl);
        const currentViewSrc = previewSrc;
        const hasReference = Boolean(referenceSrc);
        const m = String(item.model || '').toLowerCase();
        const itemTags = safeTags(item.tags);
        let modelBadge = '<span style="font-size:10px; background:rgba(255,255,255,0.1); color:#cbd5e1; padding:2px 7px; border-radius:4px;">通用</span>';
        if (m === 'v5' || itemTags.includes('NAI V5')) {
            modelBadge = '<span style="font-size:10px; background:rgba(217,70,239,0.25); color:#f0abfc; padding:2px 7px; border-radius:4px; border:1px solid rgba(217,70,239,0.5);"><i class="fa-solid fa-wand-magic-sparkles"></i> NAI V5</span>';
        } else if (m === 'v4.5' || itemTags.includes('NAI V4.5')) {
            modelBadge = '<span style="font-size:10px; background:rgba(56,189,248,0.25); color:#7dd3fc; padding:2px 7px; border-radius:4px; border:1px solid rgba(56,189,248,0.5);"><i class="fa-solid fa-bolt"></i> NAI V4.5</span>';
        }

        const p = (item.params && typeof item.params === 'object') ? item.params : {};
        const scaleVal = safeNumber(p.scale, 6.0);
        const samplerVal = String(p.sampler || 'k_euler_ancestral');
        const stepsVal = safeNumber(p.steps, 28);
        const cfgRescaleVal = safeNumber(p.cfgRescale, 0);

        return `
            <div style="width:92vw; max-width:780px; max-height:88vh; background:#0f172a; border:1px solid rgba(255,255,255,0.16); border-radius:14px; display:flex; flex-direction:column; overflow:hidden; color:#fff; box-shadow:0 25px 60px rgba(0,0,0,0.8);">
                <div style="padding:14px 18px; background:#1e293b; border-bottom:1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center;">
                    <div style="font-size:15px; font-weight:700; display:flex; align-items:center; gap:8px;">
                        <span>${escapeHtml(item.title)}</span>
                        ${modelBadge}
                        ${isMyWork ? '<span class="rbq-pm-badge-author-mine"><i class="fa-solid fa-crown"></i> 我的作品</span>' : ''}
                    </div>
                    <button id="rbq-pm-detail-close" class="rbq-pm-close-btn" title="关闭详情" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="rbq-pm-detail-body" style="padding:16px 18px; overflow-y:auto; flex:1; display:flex; flex-wrap:wrap; gap:16px;">
                    <!-- Left Column: Portrait Artwork Preview (Dual-View HUD) -->
                    <div class="rbq-pm-detail-left" style="width:220px; flex-shrink:0; display:flex; flex-direction:column; gap:8px;">
                        ${hasReference ? `
                        <div id="rbq-pm-detail-view-tabs" style="display:flex; background:#0b1120; border:1px solid rgba(255,255,255,0.12); border-radius:8px; padding:3px; gap:4px;">
                            <button id="rbq-pm-detail-tab-bm" class="menu_button active" style="flex:1; font-size:11px; font-weight:700; padding:5px 6px; border-radius:6px; border:none; cursor:pointer; background:linear-gradient(135deg, #a855f7, #ec4899); color:#fff; display:inline-flex; align-items:center; justify-content:center; gap:4px; transition:all 0.2s;">
                                <i class="fa-solid fa-flask"></i> 官方基准图
                            </button>
                            <button id="rbq-pm-detail-tab-ref" class="menu_button" style="flex:1; font-size:11px; font-weight:700; padding:5px 6px; border-radius:6px; border:none; cursor:pointer; background:transparent; color:#94a3b8; display:inline-flex; align-items:center; justify-content:center; gap:4px; transition:all 0.2s;">
                                <i class="fa-solid fa-image"></i> 自制参考图
                            </button>
                        </div>
                        ` : ''}
                        <div id="rbq-pm-detail-img-wrap" style="width:100%; aspect-ratio:3/4; border-radius:10px; overflow:hidden; background:#070b13; border:1px solid rgba(255,255,255,0.12); position:relative; cursor:zoom-in;" title="点击查看高清大图">
                            <div id="rbq-pm-detail-img-loading" style="display:none; position:absolute; inset:0; z-index:3; background:rgba(7,11,19,0.72); backdrop-filter:blur(4px); align-items:center; justify-content:center; flex-direction:column; gap:6px; color:#38bdf8; font-size:11px;">
                                <i class="fa-solid fa-spinner fa-spin" style="font-size:22px;"></i>
                                <span style="font-weight:600;">正在加载展示图...</span>
                            </div>
                            <img id="rbq-pm-detail-main-img" src="${escapeHtml(currentViewSrc)}" style="width:100%; height:100%; object-fit:cover; object-position:center 15%; display:block; transition:opacity 0.25s ease;">
                            <div id="rbq-pm-detail-img-badge" style="position:absolute; top:7px; left:7px; z-index:4; background:linear-gradient(135deg, rgba(168,85,247,0.9), rgba(236,72,153,0.9)); color:#fff; font-size:9.5px; font-weight:700; padding:2px 7px; border-radius:4px; box-shadow:0 2px 6px rgba(0,0,0,0.4);">
                                <i class="fa-solid fa-flask"></i> 官方基准图
                            </div>
                            <div style="position:absolute; bottom:6px; right:6px; z-index:4; background:rgba(0,0,0,0.65); backdrop-filter:blur(4px); font-size:10px; padding:2px 6px; border-radius:4px; color:#cbd5e1;">
                                <i class="fa-solid fa-magnifying-glass-plus"></i> 点击放大
                            </div>
                        </div>
                        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:8px 10px; font-size:11px; color:#94a3b8; display:flex; flex-direction:column; gap:4px;">
                            <div>作者: <strong style="color:#f1f5f9;">${escapeHtml(item.author || '匿名')}</strong></div>
                            <div>获赞: <strong style="color:#fb7185;">${safeCount(item.likes)}</strong> | 下载: ${safeCount(item.downloads)}</div>
                            ${itemTags.length ? `<div>标签: ${itemTags.map(t => '#' + escapeHtml(t)).join(' ')}</div>` : ''}
                        </div>
                    </div>

                    <!-- Right Column: Prompts Inspector & NAI Telemetry -->
                    <div class="rbq-pm-detail-right" style="flex:1; min-width:280px; display:flex; flex-direction:column; gap:12px;">
                        <div>
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
                                <span style="font-size:12px; color:#38bdf8; font-weight:600;"><i class="fa-solid fa-paintbrush"></i> 画师/风格预设串 (Positive)</span>
                                <button id="rbq-pm-copy-pos-only" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); color:#cbd5e1; font-size:11px; padding:2px 7px; border-radius:4px; cursor:pointer;">
                                    <i class="fa-solid fa-copy"></i> 复制预设词
                                </button>
                            </div>
                            <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); border-radius:8px; padding:10px; font-size:12px; color:#e2e8f0; line-height:1.55; word-break:break-word; max-height:110px; overflow-y:auto; user-select:text;">
                                ${escapeHtml(item.positive || '(无)')}
                            </div>
                        </div>

                        ${item.negative ? `
                        <div>
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
                                <span style="font-size:12px; color:#f87171; font-weight:600;"><i class="fa-solid fa-minus-circle"></i> 负向提示词 (Negative)</span>
                                <button id="rbq-pm-copy-neg-only" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); color:#cbd5e1; font-size:11px; padding:2px 7px; border-radius:4px; cursor:pointer;">
                                    <i class="fa-solid fa-copy"></i> 复制负向词
                                </button>
                            </div>
                            <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); border-radius:8px; padding:10px; font-size:12px; color:#fca5a5; line-height:1.55; word-break:break-word; max-height:75px; overflow-y:auto; user-select:text;">
                                ${escapeHtml(item.negative)}
                            </div>
                        </div>` : ''}

                        <!-- NAI 生图参数罗盘 (仅作展示参考) -->
                        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:10px 12px;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                                <span style="font-size:12px; color:#c084fc; font-weight:700; display:inline-flex; align-items:center; gap:6px;">
                                    <i class="fa-solid fa-sliders"></i> 生成时的 NAI 参数
                                </span>
                            </div>
                            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(75px, 1fr)); gap:8px;">
                                <div style="background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.06); border-radius:6px; padding:6px 8px; text-align:center;">
                                    <div style="font-size:10px; color:#94a3b8; margin-bottom:2px;">Scale (CFG)</div>
                                    <div style="font-size:13.5px; font-weight:700; color:#38bdf8; font-family:monospace;">${escapeHtml(scaleVal)}</div>
                                </div>
                                <div style="background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.06); border-radius:6px; padding:6px 8px; text-align:center;" title="${escapeHtml(samplerVal)}">
                                    <div style="font-size:10px; color:#94a3b8; margin-bottom:2px;">采样器</div>
                                    <div style="font-size:11px; font-weight:700; color:#f0abfc; font-family:monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(formatSampler(samplerVal))}</div>
                                </div>
                                <div style="background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.06); border-radius:6px; padding:6px 8px; text-align:center;">
                                    <div style="font-size:10px; color:#94a3b8; margin-bottom:2px;">步数 (Steps)</div>
                                    <div style="font-size:13.5px; font-weight:700; color:#4ade80; font-family:monospace;">${escapeHtml(stepsVal)}</div>
                                </div>
                                <div style="background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.06); border-radius:6px; padding:6px 8px; text-align:center;">
                                    <div style="font-size:10px; color:#94a3b8; margin-bottom:2px;">CFG Rescale</div>
                                    <div style="font-size:13.5px; font-weight:700; color:#fbbf24; font-family:monospace;">${escapeHtml(cfgRescaleVal)}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="rbq-pm-detail-foot" style="padding:12px 18px; background:#1e293b; border-top:1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                    <div style="font-size:11px; color:#64748b; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                        <span>预设ID: <code style="color:#94a3b8; font-size:10.5px;">${escapeHtml(item.id || 'community')}</code></span>
                        ${(isMyWork || isAdmin) ? `
                            <button id="rbq-pm-detail-edit-btn" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; background:rgba(56,189,248,0.18); border:1px solid rgba(56,189,248,0.45); color:#7dd3fc; font-size:11px; padding:4px 10px; border-radius:5px; cursor:pointer;" title="修改预设信息、追加标签或编辑提示词">
                                <i class="fa-solid fa-pen-to-square"></i>
                                <span>编辑预设/标签</span>
                            </button>
                            <button id="rbq-pm-detail-delete-btn" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.4); color:#fca5a5; font-size:11px; padding:4px 10px; border-radius:5px; cursor:pointer;" title="从工坊云端彻底下架删除此预设">
                                <i class="fa-solid fa-trash-can"></i>
                                <span>下架删除${(isAdmin && !isMyWork) ? ' (管理)' : ''}</span>
                            </button>
                        ` : ''}
                    </div>
                    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                        <button id="rbq-pm-btn-live-test" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:6px !important; white-space:nowrap !important; background:linear-gradient(135deg, #a855f7, #ec4899); border:none; color:#fff; font-size:12px; padding:6px 16px; font-weight:700; box-shadow:0 2px 10px rgba(168,85,247,0.35); cursor:pointer;"><i class="fa-solid fa-wand-magic-sparkles"></i> 试用画师串</button>
                        <button id="rbq-pm-install-now" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:6px !important; white-space:nowrap !important; background:#0284c7; border:none; color:#fff; font-size:12px; padding:6px 16px; font-weight:600;"><i class="fa-solid fa-download"></i> 安装至本地预设</button>
                    </div>
                </div>
            </div>
        `;
    }

    // ── 预设详情弹窗 (2-Column 视觉工作台 + NAI 生图参数罗盘) ──
    function openDetailDialog(item) {
        const cfg = getConfig();
        const isMyWork = isMyPreset(item, cfg);
        const isAdmin = Boolean(cfg.adminKey && cfg.adminKey.trim());

        const overlay = document.createElement('div');
        overlay.id = 'rbq-pm-detail-dialog';
        overlay.style.cssText = 'position:fixed; inset:0; z-index:2147483642; background:rgba(0,0,0,0.82); display:flex; align-items:center; justify-content:center; backdrop-filter:blur(8px);';

        const previewSrc = safeImageUrl(item.previewUrl, KAMI_DEFAULT_PREVIEW);
        const referenceSrc = safeImageUrl(item.referenceUrl);
        let currentViewSrc = previewSrc;
        const hasReference = Boolean(referenceSrc);

        overlay.innerHTML = buildDetailHtml(item, { isMyWork, isAdmin });
        document.body.appendChild(overlay);
        bindFastClose(overlay.querySelector('#rbq-pm-detail-close'), () => closeSubDialog(overlay));
        bindDialogBackdropClose(overlay);

        // 预加载作者自制参考图（如果存在），消除切换白屏或等待延迟
        if (hasReference) {
            const preImg = new Image();
            preImg.src = referenceSrc;
        }

        // 双图平滑切换逻辑 (官方基准测试图 vs 作者自制参考图)
        const tabBm = overlay.querySelector('#rbq-pm-detail-tab-bm');
        const tabRef = overlay.querySelector('#rbq-pm-detail-tab-ref');
        const mainImg = overlay.querySelector('#rbq-pm-detail-main-img');
        const imgBadge = overlay.querySelector('#rbq-pm-detail-img-badge');
        const imgLoading = overlay.querySelector('#rbq-pm-detail-img-loading');

        function switchDetailView(targetSrc, isRef) {
            if (!targetSrc) return;
            currentViewSrc = targetSrc;

            if (isRef) {
                tabRef.style.background = 'linear-gradient(135deg, #0284c7, #2563eb)';
                tabRef.style.color = '#fff';
                tabBm.style.background = 'transparent';
                tabBm.style.color = '#94a3b8';
                if (imgBadge) {
                    imgBadge.innerHTML = '<i class="fa-solid fa-image"></i> 自制参考图';
                    imgBadge.style.background = 'linear-gradient(135deg, rgba(56,189,248,0.9), rgba(37,99,235,0.9))';
                }
            } else {
                tabBm.style.background = 'linear-gradient(135deg, #a855f7, #ec4899)';
                tabBm.style.color = '#fff';
                tabRef.style.background = 'transparent';
                tabRef.style.color = '#94a3b8';
                if (imgBadge) {
                    imgBadge.innerHTML = '<i class="fa-solid fa-flask"></i> 官方基准图';
                    imgBadge.style.background = 'linear-gradient(135deg, rgba(168,85,247,0.9), rgba(236,72,153,0.9))';
                }
            }

            if (mainImg.getAttribute('data-loaded-src') === targetSrc) {
                mainImg.src = targetSrc;
                return;
            }

            if (imgLoading) imgLoading.style.display = 'flex';
            mainImg.style.opacity = '0.35';

            const onLoaded = () => {
                if (imgLoading) imgLoading.style.display = 'none';
                mainImg.style.opacity = '1';
                mainImg.setAttribute('data-loaded-src', targetSrc);
            };

            const temp = new Image();
            temp.onload = () => {
                mainImg.src = targetSrc;
                onLoaded();
            };
            temp.onerror = () => {
                if (imgLoading) imgLoading.style.display = 'none';
                mainImg.style.opacity = '1';
                toastr.warning('图片加载超时或异常，请检查网络');
            };
            temp.src = targetSrc;
        }

        if (tabBm && tabRef && mainImg) {
            tabBm.onclick = () => switchDetailView(previewSrc, false);
            tabRef.onclick = () => switchDetailView(referenceSrc, true);
        }

        // 点击预览图放大 Lightbox
        const imgWrap = overlay.querySelector('#rbq-pm-detail-img-wrap');
        if (imgWrap) {
            imgWrap.onclick = () => {
                const lb = document.createElement('div');
                lb.id = 'rbq-pm-lightbox';
                lb.style.cssText = 'position:fixed; inset:0; z-index:2147483646; background:rgba(0,0,0,0.92); display:flex; align-items:center; justify-content:center; cursor:zoom-out; backdrop-filter:blur(10px);';
                lb.innerHTML = `<img src="${escapeHtml(safeImageUrl(currentViewSrc, KAMI_DEFAULT_PREVIEW))}" style="max-width:92vw; max-height:92vh; object-fit:contain; border-radius:8px; box-shadow:0 0 40px rgba(0,0,0,0.9);">`;
                bindFastClose(lb, () => closeSubDialog(lb));
                bindDialogBackdropClose(lb);
                document.body.appendChild(lb);
            };
        }

        // 编辑预设/追加修改标签 (作者本人凭 Creator Key 或 管理员凭 Admin Key 鉴权)
        const editBtn = overlay.querySelector('#rbq-pm-detail-edit-btn');
        if (editBtn) {
            editBtn.onclick = () => {
                openEditPresetDialog(item, overlay);
            };
        }

        // 下架删除操作 (作者本人凭 Creator Key 或 管理员凭 Admin Key 鉴权)
        const deleteBtn = overlay.querySelector('#rbq-pm-detail-delete-btn');
        if (deleteBtn) {
            deleteBtn.onclick = async () => {
                const confirmMsg = (isAdmin && !isMyWork)
                    ? `🛡️ [服主管理] 确定要强制下架删除工坊预设「${item.title}」吗？`
                    : `⚠️ 确定要从云端工坊彻底下架删除你的预设「${item.title}」吗？\n下架后无法撤销，所有社友将不再可见。`;
                if (!confirm(confirmMsg)) return;

                const uploadEndpoint = (cfg.serverUrl || cfg.workerUrl || '').replace(/\/+$/, '');
                if (!uploadEndpoint) {
                    toastr.error('未配置工坊服务器地址，无法执行下架');
                    return;
                }

                deleteBtn.disabled = true;
                deleteBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 下架中...';

                try {
                    const res = await fetch(`${uploadEndpoint}/api/delete`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            id: item.id,
                            creatorKey: cfg.creatorKey,
                            adminKey: cfg.adminKey,
                            author: item.author
                        })
                    });
                    const data = await res.json();
                    if (res.ok && data.success) {
                        toastr.success(`🎉 预设「${item.title}」已成功下架删除！`);
                        cachedList = cachedList.filter(x => x.id !== item.id);
                        if (Array.isArray(cfg.myUploadedIds)) {
                            cfg.myUploadedIds = cfg.myUploadedIds.filter(id => id !== item.id);
                            serverOwnedIds.delete(item.id);
                            saveConfig();
                        }
                        closeSubDialog(overlay);
                        refreshDynamicTags();
                        renderCards();
                    } else {
                        toastr.error('下架失败: ' + (data.error || '权限校验未通过'));
                        deleteBtn.disabled = false;
                        deleteBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i> <span>下架删除</span>';
                    }
                } catch (err) {
                    toastr.error('请求网络错误: ' + (err.message || String(err)));
                    deleteBtn.disabled = false;
                    deleteBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i> <span>下架删除</span>';
                }
            };
        }

        overlay.querySelector('#rbq-pm-copy-pos-only').onclick = async () => {
            await copyToClipboard(item.positive || '');
            toastr.success('预设正面词已复制到剪贴板！');
        };

        if (overlay.querySelector('#rbq-pm-copy-neg-only')) {
            overlay.querySelector('#rbq-pm-copy-neg-only').onclick = async () => {
                await copyToClipboard(item.negative || '');
                toastr.success('预设负面词已复制到剪贴板！');
            };
        }

        overlay.querySelector('#rbq-pm-btn-live-test').onclick = () => {
            openLiveTestModal(item);
        };

        overlay.querySelector('#rbq-pm-install-now').onclick = () => {
            installToLocalPresets(item);
            closeSubDialog(overlay);
            renderCards();
        };
    }

    // ── 测串提示词编辑/新建子弹窗 ──
    function openTestPromptEditModal(itemToEdit, onSave) {
        const isEdit = !!itemToEdit;
        const subOverlay = document.createElement('div');
        subOverlay.id = 'rbq-pm-test-edit-dialog';
        subOverlay.style.cssText = 'position:fixed; inset:0; z-index:2147483644; background:rgba(0,0,0,0.85); display:flex; align-items:center; justify-content:center; backdrop-filter:blur(6px);';

        const initialTitle = itemToEdit?.title || '';
        const initialPos = itemToEdit?.positive || '';
        const initialNeg = itemToEdit?.negative || '';
        const initialDefault = itemToEdit?.isDefault || false;

        subOverlay.innerHTML = `
            <div style="width:90vw; max-width:540px; background:#0f172a; border:1px solid rgba(255,255,255,0.18); border-radius:12px; display:flex; flex-direction:column; overflow:hidden; color:#fff; box-shadow:0 20px 50px rgba(0,0,0,0.9);">
                <div style="padding:12px 16px; background:#1e293b; border-bottom:1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-size:14px; font-weight:700;">${isEdit ? '编辑测串底模' : '新建测串底模'}</span>
                    <button id="rbq-pm-edit-close" class="rbq-pm-close-btn" title="关闭" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div style="padding:14px 16px; display:flex; flex-direction:column; gap:10px; overflow-y:auto;">
                    <div>
                        <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:4px;">底模名称 *</label>
                        <input id="rbq-pm-edit-title" type="text" placeholder="例如: 我的自设OC / 水手服特写 / 动作体态测试" value="${escapeHtml(initialTitle)}" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:6px 10px; color:#fff; font-size:12px; box-sizing:border-box;">
                    </div>
                    <div>
                        <label style="font-size:11px; color:#38bdf8; font-weight:600; display:block; margin-bottom:4px;">正面底模提示词 (Positive) *</label>
                        <textarea id="rbq-pm-edit-pos" rows="5" placeholder="输入主体底模提示词，如: 1girl, solo, silver hair, blue eyes..." style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:8px; color:#fff; font-size:11.5px; font-family:monospace; box-sizing:border-box;">${escapeHtml(initialPos)}</textarea>
                    </div>
                    <div>
                        <label style="font-size:11px; color:#f87171; font-weight:600; display:block; margin-bottom:4px;">负面提示词 (Negative - 可选)</label>
                        <textarea id="rbq-pm-edit-neg" rows="2" placeholder="可选负面提示词，如: lowres, bad anatomy..." style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:8px; color:#fff; font-size:11.5px; font-family:monospace; box-sizing:border-box;">${escapeHtml(initialNeg)}</textarea>
                    </div>
                    <label style="display:flex; align-items:center; gap:8px; font-size:12px; color:#cbd5e1; cursor:pointer; user-select:none; margin-top:2px;">
                        <input id="rbq-pm-edit-is-default" type="checkbox" ${initialDefault ? 'checked' : ''} style="cursor:pointer; accent-color:#a855f7;">
                        <span>设为默认测串底模 (打开试用弹窗时优先选中)</span>
                    </label>
                </div>
                <div style="padding:10px 16px; background:#1e293b; border-top:1px solid rgba(255,255,255,0.08); display:flex; justify-content:flex-end; gap:8px;">
                    <button id="rbq-pm-edit-cancel" class="menu_button" style="font-size:12px; padding:5px 12px;">取消</button>
                    <button id="rbq-pm-edit-save" class="menu_button" style="background:#0284c7; border:none; color:#fff; font-size:12px; font-weight:700; padding:5px 16px;"><i class="fa-solid fa-check"></i> 保存</button>
                </div>
            </div>
        `;
        document.body.appendChild(subOverlay);
        bindFastClose(subOverlay.querySelector('#rbq-pm-edit-close'), () => closeSubDialog(subOverlay));
        bindFastClose(subOverlay.querySelector('#rbq-pm-edit-cancel'), () => closeSubDialog(subOverlay));
        bindDialogBackdropClose(subOverlay);

        subOverlay.querySelector('#rbq-pm-edit-save').onclick = () => {
            const title = subOverlay.querySelector('#rbq-pm-edit-title').value.trim();
            const positive = subOverlay.querySelector('#rbq-pm-edit-pos').value.trim();
            const negative = subOverlay.querySelector('#rbq-pm-edit-neg').value.trim();
            const isDefault = subOverlay.querySelector('#rbq-pm-edit-is-default').checked;

            if (!title) {
                toastr.warning('请输入测串底模名称');
                return;
            }
            if (!positive) {
                toastr.warning('请输入正面底模提示词');
                return;
            }

            const updatedObj = {
                id: itemToEdit?.id || ('tp-' + Date.now().toString(36)),
                title,
                positive,
                negative,
                isDefault,
                isBuiltin: itemToEdit?.isBuiltin || false
            };
            onSave(updatedObj);
            closeSubDialog(subOverlay);
        };
    }

    // ── 测串词卡片 HTML（本地/导入的测串词同样按不可信文本转义） ──
    function buildTestPromptCardHtml(item, idx) {
        return `
        <div class="rbq-pm-test-card" data-idx="${Number(idx)}" style="background:#131c2e; border:1px solid ${item.isDefault ? 'rgba(168,85,247,0.5)' : 'rgba(255,255,255,0.08)'}; border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:8px; box-shadow:0 4px 12px rgba(0,0,0,0.25);">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
                <div style="display:flex; align-items:center; gap:8px;">
                    <span style="font-size:13.5px; font-weight:700; color:#f1f5f9;">${escapeHtml(item.title || '未命名测串词')}</span>
                    ${item.isDefault ? `
                        <span style="font-size:10px; font-weight:700; background:rgba(168,85,247,0.25); color:#d8b4fe; border:1px solid rgba(168,85,247,0.5); padding:1px 6px; border-radius:4px;">
                            <i class="fa-solid fa-star"></i> 默认底模
                        </span>
                    ` : `
                        <button class="rbq-pm-test-set-default menu_button" data-idx="${Number(idx)}" style="background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.12); color:#94a3b8; font-size:10.5px; padding:1.5px 7px; border-radius:4px; cursor:pointer;">
                            设为默认
                        </button>
                    `}
                    ${item.isBuiltin ? `
                        <span style="font-size:10px; background:rgba(56,189,248,0.15); color:#7dd3fc; border:1px solid rgba(56,189,248,0.3); padding:1px 5px; border-radius:4px;">官方基准</span>
                    ` : ''}
                </div>
                <div style="display:flex; align-items:center; gap:6px;">
                    <button class="rbq-pm-test-copy-btn menu_button" data-idx="${Number(idx)}" style="background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); color:#cbd5e1; font-size:11px; padding:2px 7px; border-radius:4px; cursor:pointer;" title="复制正面提示词">
                        <i class="fa-solid fa-copy"></i>
                    </button>
                    <button class="rbq-pm-test-edit-btn menu_button" data-idx="${Number(idx)}" style="background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); color:#38bdf8; font-size:11px; padding:2px 8px; border-radius:4px; cursor:pointer;">
                        <i class="fa-solid fa-pen-to-square"></i> 编辑
                    </button>
                    ${!item.isBuiltin ? `
                        <button class="rbq-pm-test-del-btn menu_button" data-idx="${Number(idx)}" style="background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.3); color:#fca5a5; font-size:11px; padding:2px 8px; border-radius:4px; cursor:pointer;">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    ` : ''}
                </div>
            </div>
            <div style="background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.05); border-radius:6px; padding:8px 10px; font-size:11.5px; color:#cbd5e1; line-height:1.45; word-break:break-word; max-height:60px; overflow-y:auto; font-family:monospace;">
                ${escapeHtml(item.positive || '(无正面提示词)')}
            </div>
            ${item.negative ? `
                <div style="background:rgba(0,0,0,0.25); border:1px solid rgba(239,68,68,0.15); border-radius:6px; padding:6px 10px; font-size:11px; color:#fca5a5; line-height:1.4; word-break:break-word; max-height:45px; overflow-y:auto; font-family:monospace;">
                    <span style="color:#ef4444; font-weight:600;">负面: </span>${escapeHtml(item.negative)}
                </div>
            ` : ''}
        </div>
        `;
    }

    // ── 测串提示词库管理弹窗 ──
    function openTestPromptsDialog(options = {}) {
        let list = getTestPrompts();

        const overlay = document.createElement('div');
        overlay.id = 'rbq-pm-test-dialog';
        overlay.style.cssText = 'position:fixed; inset:0; z-index:2147483642; background:rgba(0,0,0,0.86); display:flex; align-items:center; justify-content:center; backdrop-filter:blur(8px);';

        const renderDialog = () => {
            overlay.innerHTML = `
                <div style="width:94vw; max-width:720px; max-height:88vh; background:#0b1120; border:1px solid rgba(255,255,255,0.16); border-radius:14px; display:flex; flex-direction:column; overflow:hidden; color:#fff; box-shadow:0 25px 60px rgba(0,0,0,0.85);">
                    <!-- Header HUD -->
                    <div style="padding:14px 18px; background:#1e293b; border-bottom:1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center; flex-shrink:0;">
                        <div style="display:flex; align-items:center; gap:9px;">
                            <div style="width:32px; height:32px; border-radius:8px; background:linear-gradient(135deg, #a855f7, #6366f1); display:flex; align-items:center; justify-content:center; color:#fff; font-size:15px;">
                                <i class="fa-solid fa-flask"></i>
                            </div>
                            <div>
                                <div style="font-size:15px; font-weight:800; display:flex; align-items:center; gap:6px;">
                                    <span>测串提示词库</span>
                                    <span style="font-size:9.5px; background:rgba(168,85,247,0.2); color:#c084fc; border:1px solid rgba(168,85,247,0.4); padding:1px 5px; border-radius:4px;">TEST PROMPTS LAB</span>
                                </div>
                                <div style="font-size:11px; color:#94a3b8; margin-top:1px;">管理用于实测各画师串风格的底模提示词 · 现场出图自动叠加</div>
                            </div>
                        </div>
                        <button id="rbq-pm-test-close" class="rbq-pm-close-btn" title="关闭词库" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>
                    </div>

                    <!-- Action Bar -->
                    <div style="padding:10px 18px; background:#0f172a; border-bottom:1px solid rgba(255,255,255,0.06); display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; flex-shrink:0;">
                        <div style="display:flex; gap:8px;">
                            <button id="rbq-pm-test-add-btn" class="menu_button" style="background:linear-gradient(135deg, #0284c7, #2563eb); border:none; color:#fff; font-size:11.5px; font-weight:700; padding:5px 12px; border-radius:6px; cursor:pointer;">
                                <i class="fa-solid fa-plus"></i> 新建测串底模
                            </button>
                            <button id="rbq-pm-test-reset-btn" class="menu_button" style="background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); color:#cbd5e1; font-size:11px; padding:5px 10px; border-radius:6px; cursor:pointer;" title="若误删卡密sama温室少女基准词，可点击补回">
                                <i class="fa-solid fa-rotate-left"></i> 补全官方基准
                            </button>
                        </div>
                        <div style="display:flex; gap:6px;">
                            <button id="rbq-pm-test-export-btn" class="menu_button" style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); color:#94a3b8; font-size:11px; padding:4px 8px; border-radius:5px; cursor:pointer;" title="导出词库 JSON">
                                <i class="fa-solid fa-file-export"></i> 导出
                            </button>
                            <button id="rbq-pm-test-import-btn" class="menu_button" style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); color:#94a3b8; font-size:11px; padding:4px 8px; border-radius:5px; cursor:pointer;" title="导入词库 JSON">
                                <i class="fa-solid fa-file-import"></i> 导入
                            </button>
                            <input id="rbq-pm-test-import-file" type="file" accept=".json,application/json,text/plain" style="display:none;">
                        </div>
                    </div>

                    <!-- Items List -->
                    <div id="rbq-pm-test-list" style="padding:14px 18px; overflow-y:auto; flex:1; display:flex; flex-direction:column; gap:12px;">
                        ${list.map((item, idx) => buildTestPromptCardHtml(item, idx)).join('')}
                    </div>

                    <!-- Footer -->
                    <div style="padding:10px 18px; background:#1e293b; border-top:1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center; flex-shrink:0;">
                        <span style="font-size:11px; color:#64748b;">已存储 ${list.length} 个测串底模 · 自动同步至酒馆本地</span>
                        <button id="rbq-pm-test-done-btn" class="menu_button" style="background:#0284c7; border:none; color:#fff; font-size:12px; font-weight:700; padding:5px 16px; border-radius:6px; cursor:pointer;">完成</button>
                    </div>
                </div>
            `;

            bindFastClose(overlay.querySelector('#rbq-pm-test-close'), () => closeSubDialog(overlay));
            bindFastClose(overlay.querySelector('#rbq-pm-test-done-btn'), () => closeSubDialog(overlay));

            // 设为默认
            overlay.querySelectorAll('.rbq-pm-test-set-default').forEach(btn => {
                btn.onclick = () => {
                    const idx = Number(btn.dataset.idx);
                    list.forEach((item, i) => item.isDefault = (i === idx));
                    saveTestPrompts(list);
                    renderDialog();
                    options.onUpdate?.(list);
                    toastr.success(`已将「${list[idx].title}」设为默认测串底模！`);
                };
            });

            // 复制正面
            overlay.querySelectorAll('.rbq-pm-test-copy-btn').forEach(btn => {
                btn.onclick = async () => {
                    const idx = Number(btn.dataset.idx);
                    await copyToClipboard(list[idx]?.positive || '');
                    toastr.success('已复制正面测串词到剪贴板！');
                };
            });

            // 删除
            overlay.querySelectorAll('.rbq-pm-test-del-btn').forEach(btn => {
                btn.onclick = () => {
                    const idx = Number(btn.dataset.idx);
                    const item = list[idx];
                    if (!confirm(`确定删除测串底模「${item.title}」吗？`)) return;
                    list.splice(idx, 1);
                    if (item.isDefault && list.length > 0) list[0].isDefault = true;
                    saveTestPrompts(list);
                    renderDialog();
                    options.onUpdate?.(list);
                    toastr.info('已删除该测串底模');
                };
            });

            // 编辑
            overlay.querySelectorAll('.rbq-pm-test-edit-btn').forEach(btn => {
                btn.onclick = () => {
                    const idx = Number(btn.dataset.idx);
                    openTestPromptEditModal(list[idx], (updated) => {
                        list[idx] = updated;
                        if (updated.isDefault) {
                            list.forEach((item, i) => { if (i !== idx) item.isDefault = false; });
                        }
                        saveTestPrompts(list);
                        renderDialog();
                        options.onUpdate?.(list);
                        toastr.success('已保存测串底模！');
                    });
                };
            });

            // 新建
            overlay.querySelector('#rbq-pm-test-add-btn').onclick = () => {
                openTestPromptEditModal(null, (created) => {
                    if (created.isDefault) {
                        list.forEach(item => item.isDefault = false);
                    }
                    list.push(created);
                    saveTestPrompts(list);
                    renderDialog();
                    options.onUpdate?.(list);
                    toastr.success('新建测串底模成功！');
                });
            };

            // 补全官方基准
            overlay.querySelector('#rbq-pm-test-reset-btn').onclick = () => {
                const hasKami = list.some(item => item.id === 'kami-greenhouse');
                if (hasKami) {
                    toastr.info('官方基准「卡密sama · 温室少女」已在词库中！');
                    return;
                }
                list.unshift(JSON.parse(JSON.stringify(DEFAULT_TEST_PROMPTS[0])));
                saveTestPrompts(list);
                renderDialog();
                options.onUpdate?.(list);
                toastr.success('已重新补回官方基准底模！');
            };

            // 导出
            overlay.querySelector('#rbq-pm-test-export-btn').onclick = () => {
                const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `rbq-test-prompts-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
                toastr.success('测串词库已成功导出为 JSON 文件！');
            };

            // 导入
            const importFileInput = overlay.querySelector('#rbq-pm-test-import-file');
            overlay.querySelector('#rbq-pm-test-import-btn').onclick = () => importFileInput.click();
            importFileInput.onchange = (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    try {
                        const parsed = JSON.parse(ev.target.result);
                        if (!Array.isArray(parsed) || parsed.length === 0) {
                            throw new Error('导入的 JSON 文件必须为非空提示词数组');
                        }
                        parsed.forEach(p => {
                            if (!p.id) p.id = 'tp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                            list.push(p);
                        });
                        saveTestPrompts(list);
                        renderDialog();
                        options.onUpdate?.(list);
                        toastr.success(`成功导入 ${parsed.length} 个测串底模！`);
                    } catch (err) {
                        toastr.error('导入失败: ' + err.message);
                    }
                };
                reader.readAsText(file);
            };
        };

        renderDialog();
        document.body.appendChild(overlay);
        bindDialogBackdropClose(overlay);
    }

    // ── 画师串现场试炼台 (Live Artist Crucible) ──
    function openLiveTestModal(preset) {
        if (!preset) return;
        const p = preset.params || {};
        const s = (typeof RBQ?.api?.getSettings === 'function') ? RBQ.api.getSettings() : {};

        // 判断预设是否带有作者推荐参数
        const hasPresetParams = Boolean(p && (p.scale !== undefined || p.sampler || p.steps !== undefined || p.cfgRescale !== undefined));
        let paramMode = hasPresetParams ? 'preset' : 'mine';

        let activeScale = (paramMode === 'preset' && p.scale !== undefined && p.scale !== null)
            ? Number(p.scale)
            : (s.naiScale !== undefined && s.naiScale !== null ? Number(s.naiScale) : 6.0);
        let activeSampler = (paramMode === 'preset' && p.sampler)
            ? p.sampler
            : (s.naiSampler || 'k_euler_ancestral');
        let activeSteps = (paramMode === 'preset' && p.steps !== undefined && p.steps !== null)
            ? Number(p.steps)
            : (s.naiSteps !== undefined && s.naiSteps !== null ? Number(s.naiSteps) : 28);
        let activeCfgRescale = (paramMode === 'preset' && p.cfgRescale !== undefined && p.cfgRescale !== null)
            ? Number(p.cfgRescale)
            : (s.naiCfgRescale !== undefined && s.naiCfgRescale !== null ? Number(s.naiCfgRescale) : 0);

        let testPrompts = getTestPrompts();
        let selectedBenchmarkId = testPrompts.find(tp => tp.isDefault)?.id || testPrompts[0]?.id || 'kami-greenhouse';

        let liveImageUrl = '';
        let currentTab = 'original'; // 默认直接呈现工坊原展示图，出图后自动切至现场实测
        let isGenerating = false;

        const originalSrc = safeImageUrl(preset.previewUrl || preset.preview || preset.previewBase64 || preset.image, KAMI_DEFAULT_PREVIEW);

        const overlay = document.createElement('div');
        overlay.id = 'rbq-pm-live-test-dialog';
        overlay.style.cssText = 'position:fixed; inset:0; z-index:2147483644; background:rgba(0,0,0,0.88); display:flex; align-items:center; justify-content:center; backdrop-filter:blur(10px);';

        overlay.innerHTML = `
            <div style="width:95vw; max-width:980px; height:88vh; max-height:840px; background:#090d16; border:1px solid rgba(255,255,255,0.16); border-radius:16px; box-shadow:0 25px 60px rgba(0,0,0,0.85), 0 0 30px rgba(168,85,247,0.1); display:flex; flex-direction:column; overflow:hidden; color:#fff;">
                <!-- Header HUD -->
                <div id="rbq-pm-live-header" style="padding:12px 20px; background:#0f172a; border-bottom:1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center; flex-shrink:0;">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <div style="width:34px; height:34px; border-radius:9px; background:linear-gradient(135deg, #a855f7, #ec4899); display:flex; align-items:center; justify-content:center; color:#fff; font-size:16px; box-shadow:0 3px 10px rgba(168,85,247,0.4); flex-shrink:0;">
                            <i class="fa-solid fa-flask-vial"></i>
                        </div>
                        <div style="min-width:0;">
                            <div style="font-size:15px; font-weight:800; display:flex; align-items:center; gap:7px; white-space:nowrap;">
                                <span>画师串现场试炼台</span>
                                <span class="rbq-pm-desktop-only" style="font-size:9.5px; font-weight:700; background:rgba(217,70,239,0.2); color:#f0abfc; border:1px solid rgba(217,70,239,0.4); padding:1px 6px; border-radius:4px;">LIVE CRUCIBLE</span>
                            </div>
                            <div class="rbq-pm-desktop-only" style="font-size:11px; color:#94a3b8; margin-top:1px;">预设「${escapeHtml(preset.title || '未命名')}」 · 现场合成测串底模实时出图对比</div>
                        </div>
                    </div>
                    <button id="rbq-pm-live-close" class="rbq-pm-close-btn" title="关闭试炼台" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>
                </div>

                <!-- Body (Responsive 2 Columns) -->
                <div class="rbq-pm-live-body" style="display:flex; flex-direction:row; flex-wrap:wrap; flex:1; overflow-y:auto; padding:16px 20px; gap:20px;">
                    <!-- Left Column: Visual Showcase & Comparison -->
                    <div class="rbq-pm-live-left" style="flex:1 1 340px; min-width:280px; max-width:420px; display:flex; flex-direction:column; gap:10px;">
                        <!-- A/B Tab Bar -->
                        <div style="display:flex; background:#0b1120; border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:3px; gap:4px;">
                            <button id="rbq-pm-live-tab-live" class="menu_button" style="flex:1; font-size:11.5px; font-weight:700; padding:6px 10px; border-radius:6px; border:none; cursor:pointer; transition:all 0.2s;">
                                <i class="fa-solid fa-bolt"></i> 现场实测图
                            </button>
                            <button id="rbq-pm-live-tab-orig" class="menu_button" style="flex:1; font-size:11.5px; font-weight:700; padding:6px 10px; border-radius:6px; border:none; cursor:pointer; transition:all 0.2s;">
                                <i class="fa-solid fa-image"></i> 工坊原展示图
                            </button>
                        </div>

                        <!-- 3:4 Frame -->
                        <div id="rbq-pm-live-visual-frame" style="width:100%; aspect-ratio:3/4; max-height:440px; background:#050810; border:1px solid rgba(255,255,255,0.12); border-radius:12px; position:relative; overflow:hidden; display:flex; align-items:center; justify-content:center; box-shadow:0 8px 24px rgba(0,0,0,0.5);">
                            <!-- Dynamic Frame Content -->
                        </div>

                        <!-- Left Controls -->
                        <div style="display:flex; gap:8px; justify-content:space-between; align-items:center;">
                            <button id="rbq-pm-live-zoom-btn" class="menu_button" style="flex:1; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); color:#cbd5e1; font-size:11px; padding:5px 8px; border-radius:6px; cursor:pointer;">
                                <i class="fa-solid fa-magnifying-glass-plus"></i> 查看大图
                            </button>
                            <button id="rbq-pm-live-ab-toggle" class="menu_button" style="flex:1; background:rgba(168,85,247,0.15); border:1px solid rgba(168,85,247,0.35); color:#d8b4fe; font-size:11px; padding:5px 8px; border-radius:6px; cursor:pointer;" title="快速切换实测图与原图对比">
                                <i class="fa-solid fa-repeat"></i> AB 对比
                            </button>
                            <button id="rbq-pm-live-download-btn" class="menu_button" style="flex:1; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); color:#cbd5e1; font-size:11px; padding:5px 8px; border-radius:6px; cursor:pointer;">
                                <i class="fa-solid fa-download"></i> 保存图
                            </button>
                        </div>
                    </div>

                    <!-- Right Column: Crucible Controls -->
                    <div class="rbq-pm-live-right" style="flex:2 1 360px; display:flex; flex-direction:column; gap:12px; min-width:290px;">
                        <!-- Section 1: 画师预设核心词 (正向与负向双展示) -->
                        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:10px 12px;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
                                <span style="font-size:11.5px; color:#38bdf8; font-weight:700;"><i class="fa-solid fa-paintbrush"></i> 画师预设词 (Preset)</span>
                                <div style="display:flex; gap:5px;">
                                    <button id="rbq-pm-live-copy-artist-pos" class="menu_button" style="background:rgba(56,189,248,0.15); border:1px solid rgba(56,189,248,0.3); color:#7dd3fc; font-size:10px; padding:2px 7px; border-radius:4px; cursor:pointer;" title="复制画师正向词">复制正面</button>
                                    ${preset.negative ? `<button id="rbq-pm-live-copy-artist-neg" class="menu_button" style="background:rgba(244,63,94,0.15); border:1px solid rgba(244,63,94,0.3); color:#fda4af; font-size:10px; padding:2px 7px; border-radius:4px; cursor:pointer;" title="复制画师负向词">复制负面</button>` : ''}
                                </div>
                            </div>
                            <div style="display:flex; flex-direction:column; gap:5px;">
                                <div>
                                    <div style="font-size:9.5px; color:#94a3b8; margin-bottom:2px;">正面预设词 (Positive)</div>
                                    <div style="background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.05); border-radius:6px; padding:6px 8px; font-size:11px; color:#cbd5e1; line-height:1.45; max-height:45px; overflow-y:auto; word-break:break-word; font-family:monospace;">
                                        ${escapeHtml(preset.positive || '(无)')}
                                    </div>
                                </div>
                                ${preset.negative ? `
                                <div>
                                    <div style="font-size:9.5px; color:#f43f5e; margin-bottom:2px;">画师专属负面 (Negative)</div>
                                    <div style="background:rgba(0,0,0,0.3); border:1px solid rgba(244,63,94,0.18); border-radius:6px; padding:5px 8px; font-size:11px; color:#fda4af; line-height:1.4; max-height:40px; overflow-y:auto; word-break:break-word; font-family:monospace;">
                                        ${escapeHtml(preset.negative)}
                                    </div>
                                </div>
                                ` : ''}
                            </div>
                        </div>

                        <!-- Section 2: 测串底模选择器 -->
                        <div style="background:linear-gradient(135deg, rgba(168,85,247,0.08), rgba(56,189,248,0.08)); border:1px solid rgba(168,85,247,0.3); border-radius:10px; padding:10px 12px;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                                <span style="font-size:11.5px; color:#d8b4fe; font-weight:700;"><i class="fa-solid fa-flask"></i> 测串底模选择 (Benchmark)</span>
                                <button id="rbq-pm-live-manage-bm-btn" class="menu_button" style="background:rgba(168,85,247,0.2); border:1px solid rgba(168,85,247,0.4); color:#e9d5ff; font-size:10.5px; font-weight:600; padding:2px 8px; border-radius:4px; cursor:pointer;">
                                    <i class="fa-solid fa-gear"></i> 管理/新建词库
                                </button>
                            </div>
                            <select id="rbq-pm-live-bm-select" style="width:100%; background:#0f172a; border:1px solid rgba(255,255,255,0.18); border-radius:6px; padding:6px 8px; color:#fff; font-size:12px; outline:none; cursor:pointer; margin-bottom:6px;">
                                <!-- dynamically populated -->
                            </select>
                            <div id="rbq-pm-live-bm-preview" style="background:rgba(0,0,0,0.25); border:1px solid rgba(255,255,255,0.05); border-radius:6px; padding:6px 8px; font-size:11px; color:#94a3b8; max-height:55px; overflow-y:auto; word-break:break-word; font-family:monospace; line-height:1.4;">
                                <!-- positive & negative preview of selected benchmark -->
                            </div>
                        </div>

                        <!-- Section 3: 最终合成提示词 (正面 + 负面完整呈现) -->
                        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:10px 12px;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                                <span style="font-size:11.5px; color:#f0abfc; font-weight:700;"><i class="fa-solid fa-code-merge"></i> 最终合成提示词 (Merged Prompt)</span>
                                <div style="display:flex; gap:5px;">
                                    <button id="rbq-pm-live-copy-merged-pos" class="menu_button" style="background:rgba(217,70,239,0.18); border:1px solid rgba(217,70,239,0.35); color:#f0abfc; font-size:10px; font-weight:600; padding:2px 7px; border-radius:4px; cursor:pointer;" title="复制最终正向合成词">
                                        <i class="fa-solid fa-copy"></i> 复制正面
                                    </button>
                                    <button id="rbq-pm-live-copy-merged-neg" class="menu_button" style="background:rgba(244,63,94,0.18); border:1px solid rgba(244,63,94,0.35); color:#fda4af; font-size:10px; font-weight:600; padding:2px 7px; border-radius:4px; cursor:pointer;" title="复制最终负向合成词">
                                        <i class="fa-solid fa-copy"></i> 复制负面
                                    </button>
                                </div>
                            </div>
                            <div style="display:flex; flex-direction:column; gap:6px;">
                                <div>
                                    <div style="font-size:9.5px; color:#38bdf8; margin-bottom:2px; font-weight:600;">✨ 正向合成词 (画师串 + 底模正面)</div>
                                    <div id="rbq-pm-live-merged-pos" style="background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.05); border-radius:6px; padding:6px 8px; font-size:11px; color:#e2e8f0; max-height:48px; overflow-y:auto; word-break:break-word; font-family:monospace; line-height:1.35;">
                                        <!-- merged positive -->
                                    </div>
                                </div>
                                <div>
                                    <div style="font-size:9.5px; color:#f43f5e; margin-bottom:2px; font-weight:600;">🛡️ 负向合成词 (画师负面 + 底模负面) <span style="font-weight:normal; color:#94a3b8;">[可直接微调]</span></div>
                                    <textarea id="rbq-pm-live-merged-neg" rows="2" placeholder="合成的负面提示词..." style="width:100%; background:rgba(0,0,0,0.3); border:1px solid rgba(244,63,94,0.22); border-radius:6px; padding:6px 8px; font-size:11px; color:#fca5a5; line-height:1.35; box-sizing:border-box; outline:none; resize:vertical; font-family:monospace;"></textarea>
                                </div>
                            </div>
                        </div>

                        <!-- Section 4: NAI 生图参数设定 (双态切换 + 标准采样器下拉) -->
                        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:10px 12px;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:6px;">
                                <span style="font-size:11.5px; color:#c084fc; font-weight:700;"><i class="fa-solid fa-sliders"></i> NAI 生图参数设定</span>
                                <div style="display:inline-flex; gap:3px; background:rgba(0,0,0,0.4); padding:2px; border-radius:6px; border:1px solid rgba(255,255,255,0.1);">
                                    <button id="rbq-pm-live-param-preset-btn" type="button" class="menu_button" style="font-size:10px; font-weight:600; padding:3px 8px; border-radius:4px; border:none; cursor:pointer; transition:all 0.15s;" title="快速载入预设作者推荐绑定的生图参数">
                                        <i class="fa-solid fa-wand-magic-sparkles"></i> 预设推荐
                                    </button>
                                    <button id="rbq-pm-live-param-mine-btn" type="button" class="menu_button" style="font-size:10px; font-weight:600; padding:3px 8px; border-radius:4px; border:none; cursor:pointer; transition:all 0.15s;" title="快速载入当前酒馆设置中正在生效的 NAI 参数">
                                        <i class="fa-solid fa-user-gear"></i> 我的酒馆设置
                                    </button>
                                </div>
                            </div>
                            <div class="rbq-pm-live-params-grid" style="display:grid; grid-template-columns: 1fr 1.35fr 1fr 1fr; gap:6px;">
                                <div>
                                    <div style="font-size:9.5px; color:#94a3b8; margin-bottom:2px;">Scale (CFG)</div>
                                    <input id="rbq-pm-live-param-scale" type="number" step="0.5" value="${activeScale}" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:5px; padding:4px 6px; color:#38bdf8; font-size:11px; font-family:monospace; box-sizing:border-box;">
                                </div>
                                <div>
                                    <div style="font-size:9.5px; color:#94a3b8; margin-bottom:2px;">采样器 (Sampler)</div>
                                    <select id="rbq-pm-live-param-sampler" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:5px; padding:4px 6px; color:#f0abfc; font-size:11px; outline:none; cursor:pointer; box-sizing:border-box;">
                                        <!-- populated dynamically -->
                                    </select>
                                </div>
                                <div>
                                    <div style="font-size:9.5px; color:#94a3b8; margin-bottom:2px;">步数 (Steps)</div>
                                    <input id="rbq-pm-live-param-steps" type="number" step="1" value="${activeSteps}" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:5px; padding:4px 6px; color:#4ade80; font-size:11px; font-family:monospace; box-sizing:border-box;">
                                </div>
                                <div>
                                    <div style="font-size:9.5px; color:#94a3b8; margin-bottom:2px;">CFG Rescale</div>
                                    <input id="rbq-pm-live-param-rescale" type="number" step="0.05" value="${activeCfgRescale}" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:5px; padding:4px 6px; color:#fbbf24; font-size:11px; font-family:monospace; box-sizing:border-box;">
                                </div>
                            </div>
                        </div>

                        <!-- Section 5: 核心执行按钮 -->
                        <div style="margin-top:auto; padding-top:4px; display:flex; flex-direction:column; gap:8px;">
                            <button id="rbq-pm-live-draw-btn" class="menu_button" style="width:100%; background:linear-gradient(135deg, #a855f7, #ec4899); border:none; color:#fff; font-size:13.5px; font-weight:800; padding:10px 16px; border-radius:8px; cursor:pointer; box-shadow:0 4px 16px rgba(168,85,247,0.45); letter-spacing:0.5px;">
                                <i class="fa-solid fa-wand-magic-sparkles"></i>
                                <span>⚡ 立即出图实测 (画师串 + 测串底模)</span>
                            </button>
                            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                                <span id="rbq-pm-live-draw-hint" style="font-size:11px; color:#94a3b8;"><i class="fa-solid fa-circle-info"></i> 将使用上方设定的 NAI 参数现场生成</span>
                                <button id="rbq-pm-live-install-btn" class="menu_button" style="background:#0284c7; border:none; color:#fff; font-size:11px; font-weight:700; padding:5px 12px; border-radius:6px; cursor:pointer;">
                                    <i class="fa-solid fa-download"></i> 安装此预设至本地库
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        bindFastClose(overlay.querySelector('#rbq-pm-live-close'), () => closeSubDialog(overlay));
        bindDialogBackdropClose(overlay);

        const frame = overlay.querySelector('#rbq-pm-live-visual-frame');
        const tabLive = overlay.querySelector('#rbq-pm-live-tab-live');
        const tabOrig = overlay.querySelector('#rbq-pm-live-tab-orig');
        const drawBtn = overlay.querySelector('#rbq-pm-live-draw-btn');
        const hintSpan = overlay.querySelector('#rbq-pm-live-draw-hint');

        // 渲染视觉展示窗
        const renderVisualFrame = () => {
            // 更新 Tab 高亮态
            if (currentTab === 'live') {
                tabLive.style.background = 'rgba(168,85,247,0.25)';
                tabLive.style.color = '#e9d5ff';
                tabLive.style.border = '1px solid rgba(168,85,247,0.5)';
                tabOrig.style.background = 'transparent';
                tabOrig.style.color = '#94a3b8';
                tabOrig.style.border = '1px solid transparent';
            } else {
                tabOrig.style.background = 'rgba(56,189,248,0.25)';
                tabOrig.style.color = '#7dd3fc';
                tabOrig.style.border = '1px solid rgba(56,189,248,0.5)';
                tabLive.style.background = 'transparent';
                tabLive.style.color = '#94a3b8';
                tabLive.style.border = '1px solid transparent';
            }

            if (currentTab === 'live') {
                if (isGenerating) {
                    frame.innerHTML = `
                        <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; gap:12px; color:#c084fc; padding:20px; text-align:center;">
                            <i class="fa-solid fa-spinner fa-spin" style="font-size:32px;"></i>
                            <div style="font-size:13px; font-weight:700;">画风炼金进行中...</div>
                            <div id="rbq-pm-live-status-text" style="font-size:11.5px; color:#94a3b8;">正在向生图集群排队出图...</div>
                        </div>
                    `;
                } else if (liveImageUrl) {
                    frame.innerHTML = `
                        <div id="rbq-pm-live-img-inner" style="width:100%; height:100%; position:relative; display:flex; align-items:center; justify-content:center; cursor:zoom-in;">
                            <img src="${escapeHtml(safeImageUrl(liveImageUrl, '', { allowLocal: true }))}" style="width:100%; height:100%; object-fit:contain; border-radius:10px;">
                            <div style="position:absolute; top:8px; left:8px; background:rgba(0,0,0,0.7); backdrop-filter:blur(6px); border:1px solid rgba(168,85,247,0.5); color:#d8b4fe; font-size:10.5px; font-weight:700; padding:2px 8px; border-radius:5px;">
                                <i class="fa-solid fa-bolt"></i> 现场实测图 (点击放大)
                            </div>
                        </div>
                    `;
                    frame.querySelector('#rbq-pm-live-img-inner').onclick = () => openImageZoom(liveImageUrl);
                } else {
                    frame.innerHTML = `
                        <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; gap:10px; color:#64748b; padding:24px; text-align:center;">
                            <i class="fa-solid fa-flask-vial" style="font-size:36px; color:#a855f7; opacity:0.6;"></i>
                            <div style="font-size:13px; font-weight:700; color:#cbd5e1;">试炼台就绪</div>
                            <div style="font-size:11px; color:#94a3b8; line-height:1.5;">选择右侧的测串底模，点击「立即出图实测」，即可在此渲染专属画风。</div>
                            <button id="rbq-pm-live-peek-orig" class="menu_button" style="margin-top:4px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); color:#cbd5e1; font-size:11px; padding:3px 10px; border-radius:5px; cursor:pointer;">
                                <i class="fa-solid fa-image"></i> 先看看工坊展示原图
                            </button>
                        </div>
                    `;
                    const peekBtn = frame.querySelector('#rbq-pm-live-peek-orig');
                    if (peekBtn) {
                        peekBtn.onclick = () => {
                            currentTab = 'original';
                            renderVisualFrame();
                        };
                    }
                }
            } else {
                // 原展示图
                frame.innerHTML = `
                    <div id="rbq-pm-live-orig-inner" style="width:100%; height:100%; position:relative; display:flex; align-items:center; justify-content:center; cursor:zoom-in;">
                        <img src="${escapeHtml(originalSrc)}" style="width:100%; height:100%; object-fit:contain; border-radius:10px;">
                        <div style="position:absolute; top:8px; left:8px; background:rgba(0,0,0,0.7); backdrop-filter:blur(6px); border:1px solid rgba(56,189,248,0.5); color:#7dd3fc; font-size:10.5px; font-weight:700; padding:2px 8px; border-radius:5px;">
                            <i class="fa-solid fa-image"></i> 工坊展示原图 (点击放大)
                        </div>
                    </div>
                `;
                frame.querySelector('#rbq-pm-live-orig-inner').onclick = () => openImageZoom(originalSrc);
            }
        };

        // Tab 点击
        tabLive.onclick = () => { currentTab = 'live'; renderVisualFrame(); };
        tabOrig.onclick = () => { currentTab = 'original'; renderVisualFrame(); };

        // AB 切换
        overlay.querySelector('#rbq-pm-live-ab-toggle').onclick = () => {
            currentTab = (currentTab === 'live' ? 'original' : 'live');
            renderVisualFrame();
        };

        // 查看大图
        overlay.querySelector('#rbq-pm-live-zoom-btn').onclick = () => {
            const src = (currentTab === 'live' && liveImageUrl) ? liveImageUrl : originalSrc;
            openImageZoom(src);
        };

        // 保存图片
        overlay.querySelector('#rbq-pm-live-download-btn').onclick = () => {
            const rawTarget = (currentTab === 'live' && liveImageUrl) ? liveImageUrl : originalSrc;
            const targetUrl = safeImageUrl(rawTarget, '', { allowLocal: true });
            if (!targetUrl) return toastr.warning('当前无可用图片');
            const a = document.createElement('a');
            a.href = targetUrl;
            a.download = `rbq-style-test-${preset.title || 'preset'}-${Date.now()}.png`;
            a.target = '_blank';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            toastr.success('已开始保存图片');
        };

        // 测串底模与合成词联动
        const bmSelect = overlay.querySelector('#rbq-pm-live-bm-select');
        const bmPreview = overlay.querySelector('#rbq-pm-live-bm-preview');
        const mergedPos = overlay.querySelector('#rbq-pm-live-merged-pos');
        const mergedNeg = overlay.querySelector('#rbq-pm-live-merged-neg');

        const updateMergedPromptView = () => {
            const curBm = testPrompts.find(tp => tp.id === selectedBenchmarkId) || testPrompts[0] || DEFAULT_TEST_PROMPTS[0];
            if (bmPreview) {
                bmPreview.innerHTML = `
                    <div style="color:#cbd5e1;"><strong style="color:#38bdf8;">正面:</strong> ${escapeHtml(curBm?.positive || '(无)')}</div>
                    ${curBm?.negative ? `<div style="margin-top:3px; color:#fda4af;"><strong style="color:#f43f5e;">负面:</strong> ${escapeHtml(curBm.negative)}</div>` : ''}
                `;
            }
            if (mergedPos) {
                const combinedPos = [preset.positive, curBm?.positive].map(p => (p || '').trim().replace(/^,+|,+$/g, '').trim()).filter(Boolean).join(', ');
                mergedPos.textContent = combinedPos || '(无)';
            }
            if (mergedNeg) {
                const combinedNeg = [preset.negative, curBm?.negative].map(p => (p || '').trim().replace(/^,+|,+$/g, '').trim()).filter(Boolean).join(', ');
                mergedNeg.value = combinedNeg || '';
            }
        };

        const refreshBenchmarkSelect = () => {
            testPrompts = getTestPrompts();
            if (!testPrompts.some(tp => tp.id === selectedBenchmarkId)) {
                selectedBenchmarkId = testPrompts.find(tp => tp.isDefault)?.id || testPrompts[0]?.id || 'kami-greenhouse';
            }
            bmSelect.innerHTML = testPrompts.map(tp => `
                <option value="${escapeHtml(tp.id)}" ${tp.id === selectedBenchmarkId ? 'selected' : ''}>
                    ${escapeHtml(tp.title || '未命名')} ${tp.isDefault ? '⭐' : ''}
                </option>
            `).join('');
            updateMergedPromptView();
        };

        refreshBenchmarkSelect();

        bmSelect.onchange = (e) => {
            selectedBenchmarkId = e.target.value;
            updateMergedPromptView();
        };

        // 管理词库按钮
        overlay.querySelector('#rbq-pm-live-manage-bm-btn').onclick = () => {
            openTestPromptsDialog({
                onUpdate: () => refreshBenchmarkSelect()
            });
        };

        // 复制画师预设正向词
        overlay.querySelector('#rbq-pm-live-copy-artist-pos').onclick = async () => {
            await copyToClipboard(preset.positive || '');
            toastr.success('已复制画师正面预设词！');
        };

        // 复制画师预设负向词（如果存在）
        const copyArtistNegBtn = overlay.querySelector('#rbq-pm-live-copy-artist-neg');
        if (copyArtistNegBtn) {
            copyArtistNegBtn.onclick = async () => {
                await copyToClipboard(preset.negative || '');
                toastr.success('已复制画师负面预设词！');
            };
        }

        // 复制合成正面词
        overlay.querySelector('#rbq-pm-live-copy-merged-pos').onclick = async () => {
            const text = mergedPos.textContent.trim();
            await copyToClipboard(text);
            toastr.success('已复制完整正面合成词！');
        };

        // 复制合成负面词
        overlay.querySelector('#rbq-pm-live-copy-merged-neg').onclick = async () => {
            const text = mergedNeg.value.trim();
            await copyToClipboard(text);
            toastr.success('已复制完整负面合成词！');
        };

        // ── 参数控件与双态来源切换 ──
        const scaleInput = overlay.querySelector('#rbq-pm-live-param-scale');
        const samplerSelect = overlay.querySelector('#rbq-pm-live-param-sampler');
        const stepsInput = overlay.querySelector('#rbq-pm-live-param-steps');
        const rescaleInput = overlay.querySelector('#rbq-pm-live-param-rescale');

        const populateSamplerOptions = (selectedVal) => {
            let optionsHtml = '';
            let matched = false;
            for (const item of NAI_SAMPLERS) {
                const isSel = (item.value === selectedVal);
                if (isSel) matched = true;
                optionsHtml += `<option value="${item.value}" ${isSel ? 'selected' : ''}>${item.label}</option>`;
            }
            if (!matched && selectedVal) {
                optionsHtml += `<option value="${escapeHtml(selectedVal)}" selected>${escapeHtml(selectedVal)}</option>`;
            }
            samplerSelect.innerHTML = optionsHtml;
        };

        populateSamplerOptions(activeSampler);

        const btnPreset = overlay.querySelector('#rbq-pm-live-param-preset-btn');
        const btnMine = overlay.querySelector('#rbq-pm-live-param-mine-btn');

        const updateParamModeButtons = (mode) => {
            if (mode === 'preset') {
                btnPreset.style.background = 'linear-gradient(135deg, #a855f7, #6366f1)';
                btnPreset.style.color = '#fff';
                btnMine.style.background = 'transparent';
                btnMine.style.color = '#94a3b8';
            } else if (mode === 'mine') {
                btnMine.style.background = 'linear-gradient(135deg, #0284c7, #2563eb)';
                btnMine.style.color = '#fff';
                btnPreset.style.background = 'transparent';
                btnPreset.style.color = '#94a3b8';
            } else {
                btnPreset.style.background = 'transparent';
                btnPreset.style.color = '#94a3b8';
                btnMine.style.background = 'transparent';
                btnMine.style.color = '#94a3b8';
            }
        };

        updateParamModeButtons(paramMode);

        btnPreset.onclick = () => {
            const prScale = p.scale !== undefined && p.scale !== null ? Number(p.scale) : 6.0;
            const prSampler = p.sampler || 'k_euler_ancestral';
            const prSteps = p.steps !== undefined && p.steps !== null ? Number(p.steps) : 28;
            const prRescale = p.cfgRescale !== undefined && p.cfgRescale !== null ? Number(p.cfgRescale) : 0;
            scaleInput.value = prScale;
            populateSamplerOptions(prSampler);
            samplerSelect.value = prSampler;
            stepsInput.value = prSteps;
            rescaleInput.value = prRescale;
            updateParamModeButtons('preset');
            hintSpan.innerHTML = `<span style="color:#c084fc;"><i class="fa-solid fa-wand-magic-sparkles"></i> 已载入预设推荐参数 (CFG: ${escapeHtml(prScale)} | 采样器: ${escapeHtml(prSampler)} | 步数: ${escapeHtml(prSteps)})</span>`;
            toastr.info('已载入该预设作者推荐参数');
        };

        btnMine.onclick = () => {
            const fresh = (typeof RBQ?.api?.getSettings === 'function') ? RBQ.api.getSettings() : {};
            const myScale = fresh.naiScale !== undefined && fresh.naiScale !== null ? Number(fresh.naiScale) : 6.0;
            const mySampler = fresh.naiSampler || 'k_euler_ancestral';
            const mySteps = fresh.naiSteps !== undefined && fresh.naiSteps !== null ? Number(fresh.naiSteps) : 28;
            const myRescale = fresh.naiCfgRescale !== undefined && fresh.naiCfgRescale !== null ? Number(fresh.naiCfgRescale) : 0;
            scaleInput.value = myScale;
            populateSamplerOptions(mySampler);
            samplerSelect.value = mySampler;
            stepsInput.value = mySteps;
            rescaleInput.value = myRescale;
            updateParamModeButtons('mine');
            hintSpan.innerHTML = `<span style="color:#38bdf8;"><i class="fa-solid fa-user-gear"></i> 已载入我的酒馆 NAI 设置 (CFG: ${escapeHtml(myScale)} | 采样器: ${escapeHtml(mySampler)} | 步数: ${escapeHtml(mySteps)})</span>`;
            toastr.info('已载入当前酒馆全局生图设置');
        };

        [scaleInput, samplerSelect, stepsInput, rescaleInput].forEach(el => {
            el.addEventListener('input', () => {
                updateParamModeButtons('custom');
                hintSpan.innerHTML = '<span style="color:#cbd5e1;"><i class="fa-solid fa-circle-info"></i> 将使用现场微调参数出图</span>';
            });
            el.addEventListener('change', () => {
                updateParamModeButtons('custom');
                hintSpan.innerHTML = '<span style="color:#cbd5e1;"><i class="fa-solid fa-circle-info"></i> 将使用现场微调参数出图</span>';
            });
        });

        // 安装预设
        overlay.querySelector('#rbq-pm-live-install-btn').onclick = () => {
            installToLocalPresets(preset);
            renderCards();
        };

        // ── 🎨 核心装置：现场立即出图实测 ──
        drawBtn.onclick = async () => {
            const finalPrompt = mergedPos ? mergedPos.textContent.trim() : [preset.positive, curBm?.positive].filter(Boolean).join(', ');
            const finalNegative = mergedNeg ? mergedNeg.value.trim() : [preset.negative, curBm?.negative].filter(Boolean).join(', ');

            if (!finalPrompt) {
                toastr.warning('合成提示词为空，无法生图');
                return;
            }

            if (typeof RBQ?.api?.generateImage !== 'function') {
                toastr.error('酒馆当前未启用 RBQ 生图流水线，请检查生图插件是否正常激活');
                return;
            }

            // 同步当前现场参数
            const liveScale = parseFloat(scaleInput.value);
            const liveSampler = samplerSelect.value.trim();
            const liveSteps = parseInt(stepsInput.value, 10);
            const liveRescale = parseFloat(rescaleInput.value);

            // 快照当前设置，现场出图隔离，finally 中精准还原，不污染全局酒馆配置
            const originalGlobalSettings = {
                naiScale: s.naiScale,
                naiSampler: s.naiSampler,
                naiSteps: s.naiSteps,
                naiCfgRescale: s.naiCfgRescale
            };

            if (!isNaN(liveScale)) s.naiScale = liveScale;
            if (liveSampler) s.naiSampler = liveSampler;
            if (!isNaN(liveSteps)) s.naiSteps = liveSteps;
            if (!isNaN(liveRescale)) s.naiCfgRescale = liveRescale;

            isGenerating = true;
            currentTab = 'live';
            drawBtn.disabled = true;
            const originalBtnHtml = drawBtn.innerHTML;
            drawBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>正在向生图集群排队出图...</span>';
            hintSpan.innerHTML = '<span style="color:#38bdf8;"><i class="fa-solid fa-spinner fa-spin"></i> 正在生成实测图...</span>';
            renderVisualFrame();

            try {
                const meta = {
                    isolate: true,
                    skipPresets: true,
                    skipPrefixSuffix: true,
                    negative: finalNegative,
                    scale: !isNaN(liveScale) ? liveScale : undefined,
                    sampler: liveSampler || undefined,
                    steps: !isNaN(liveSteps) ? liveSteps : undefined,
                    cfgRescale: !isNaN(liveRescale) ? liveRescale : undefined
                };
                const drawRes = await RBQ.api.generateImage(finalPrompt, 'market-live-test', meta, (progress) => {
                    if (progress) {
                        drawBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>${escapeHtml(progress)}</span>`;
                        const statusText = overlay.querySelector('#rbq-pm-live-status-text');
                        if (statusText) statusText.textContent = progress;
                    }
                });

                if (!drawRes || !drawRes.url) {
                    throw new Error('生图服务未返回有效图片地址');
                }

                liveImageUrl = drawRes.url;
                currentTab = 'live';
                hintSpan.innerHTML = '<span style="color:#22c55e; font-weight:700;"><i class="fa-solid fa-circle-check"></i> 实测出图成功！</span>';
                toastr.success(`🎉 预设「${preset.title || '画风'}」实测渲染完成！所见即所得。`);
            } catch (err) {
                hintSpan.innerHTML = `<span style="color:#ef4444;"><i class="fa-solid fa-triangle-exclamation"></i> 生图失败: ${escapeHtml(err.message || String(err))}</span>`;
                toastr.error('实测出图失败: ' + (err.message || String(err)));
            } finally {
                // 安全恢复用户日常生图配置
                if (originalGlobalSettings.naiScale !== undefined) s.naiScale = originalGlobalSettings.naiScale;
                if (originalGlobalSettings.naiSampler !== undefined) s.naiSampler = originalGlobalSettings.naiSampler;
                if (originalGlobalSettings.naiSteps !== undefined) s.naiSteps = originalGlobalSettings.naiSteps;
                if (originalGlobalSettings.naiCfgRescale !== undefined) s.naiCfgRescale = originalGlobalSettings.naiCfgRescale;

                isGenerating = false;
                drawBtn.disabled = false;
                drawBtn.innerHTML = originalBtnHtml;
                renderVisualFrame();
            }
        };

        renderVisualFrame();
    }

    // ── 发布弹窗 (带工坊现场一键生图核心装置 & 官方基准+自制双舱展台) ──
    function openUploadDialog() {
        const cfg = getConfig();
        const uploadEndpoint = (cfg.serverUrl || cfg.workerUrl || '').replace(/\/+$/, '');
        if (!uploadEndpoint) {
            toastr.info('请先在设置中填写你的预设工坊服务器地址');
            openSettingsDialog();
            return;
        }

        // 校验是否已创建创作者个人码
        if (!cfg.creatorKey || !cfg.creatorKey.trim()) {
            toastr.warning('发布预设需要先设置你的专属创作者个人码（用于作品归属认领与随时下架管理）。\n已为你打开设置面板，请先创建个人码。');
            openSettingsDialog();
            return;
        }

        const s = (typeof RBQ?.api?.getSettings === 'function') ? RBQ.api.getSettings() : {};
        const localPresets = s[PRESETS_STORAGE_KEY]?.presets || [];

        let activeScale = s.naiScale !== undefined && s.naiScale !== null ? Number(s.naiScale) : 6.0;
        let activeSampler = s.naiSampler || 'k_euler_ancestral';
        let activeSteps = s.naiSteps !== undefined && s.naiSteps !== null ? Number(s.naiSteps) : 28;
        let activeCfgRescale = s.naiCfgRescale !== undefined && s.naiCfgRescale !== null ? Number(s.naiCfgRescale) : 0;

        // 真实绑定出图时的 NAI 参数（自动抓取，无需用户手动填写）
        let capturedParams = {
            scale: activeScale,
            sampler: activeSampler,
            steps: activeSteps,
            cfgRescale: activeCfgRescale
        };

        const overlay = document.createElement('div');
        overlay.id = 'rbq-pm-upload-dialog';
        overlay.style.cssText = 'position:fixed; inset:0; z-index:2147483643; background:rgba(0,0,0,0.85); display:flex; align-items:center; justify-content:center; backdrop-filter:blur(8px);';
        overlay.innerHTML = `
            <div style="width:92vw; max-width:680px; max-height:88vh; background:#0f172a; border:1px solid rgba(255,255,255,0.16); border-radius:14px; display:flex; flex-direction:column; overflow:hidden; color:#fff; box-shadow:0 25px 60px rgba(0,0,0,0.85);">
                <div style="padding:14px 18px; background:#1e293b; border-bottom:1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center;">
                    <div style="font-size:15px; font-weight:700; display:flex; align-items:center; gap:8px;">
                        <i class="fa-solid fa-cloud-arrow-up" style="color:#38bdf8;"></i>
                        <span>发布预设至工坊</span>
                    </div>
                    <button id="rbq-pm-upload-close" class="rbq-pm-close-btn" title="关闭发布" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div style="padding:16px 18px; overflow-y:auto; flex:1; display:flex; flex-direction:column; gap:12px;">
                    <!-- 快捷填充与导入 -->
                    <div style="display:flex; gap:8px; align-items:center; justify-content:space-between; background:rgba(255,255,255,0.03); padding:8px 12px; border-radius:8px; border:1px solid rgba(255,255,255,0.06);">
                        <div style="flex:1;">
                            <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:3px;">从本地已有预设快速导入</label>
                            <select id="rbq-pm-local-select" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:5px; color:#fff; font-size:11.5px;">
                                <option value="">-- 手动填写或从本地选择 --</option>
                                ${localPresets.map((p, idx) => `<option value="${idx}">${escapeHtml(p.name || p.id)}</option>`).join('')}
                            </select>
                        </div>
                    </div>

                    <div class="rbq-pm-up-grid-2col" style="display:grid; grid-template-columns: 2fr 1fr; gap:10px;">
                        <div>
                            <label style="font-size:12px; color:#94a3b8; display:block; margin-bottom:4px;">预设标题 *</label>
                            <input id="rbq-pm-up-title" type="text" placeholder="例如: Neroma Shin 水光透肉丝袜" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:6px 10px; color:#fff; font-size:12px; box-sizing:border-box;">
                        </div>
                        <div>
                            <label style="font-size:12px; color:#94a3b8; display:block; margin-bottom:4px;">适配模型 *</label>
                            <select id="rbq-pm-up-model" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:6px; color:#fff; font-size:12px; box-sizing:border-box;">
                                <option value="v5" selected>✨ NAI V5 (推荐)</option>
                                <option value="v4.5">⚡ NAI V4.5</option>
                                <option value="general">🌐 通用 / SDXL</option>
                            </select>
                        </div>
                    </div>

                    <div class="rbq-pm-up-grid-2col" style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
                        <div>
                            <label style="font-size:12px; color:#94a3b8; display:block; margin-bottom:4px;">作者昵称</label>
                            <input id="rbq-pm-up-author" type="text" placeholder="匿名" value="${escapeHtml(cfg.authorName || '匿名')}" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:6px 10px; color:#fff; font-size:12px; box-sizing:border-box;">
                        </div>
                        <div>
                            <label style="font-size:12px; color:#94a3b8; display:block; margin-bottom:4px;">风格标签 (空格分隔)</label>
                            <input id="rbq-pm-up-tags" type="text" placeholder="例如: 3D写实 油光丝袜 御姐" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:6px 10px; color:#fff; font-size:12px; box-sizing:border-box;">
                        </div>
                    </div>

                    <!-- 用户自定义画师/风格词 -->
                    <div>
                        <label style="font-size:12px; color:#38bdf8; display:block; margin-bottom:4px; font-weight:600;"><i class="fa-solid fa-paintbrush"></i> 用户画师 / 风格预设词 (Positive) *</label>
                        <textarea id="rbq-pm-up-pos" rows="3" placeholder="在此输入你的画师串或预设词，例如: artist:neroma_shin, 1.4::shiny pantyhose::, 3d game cg" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:8px; color:#fff; font-size:12px; box-sizing:border-box; line-height:1.4;"></textarea>
                    </div>

                    <div>
                        <label style="font-size:12px; color:#94a3b8; display:block; margin-bottom:4px;">负面提示词 (可选)</label>
                        <textarea id="rbq-pm-up-neg" rows="2" placeholder="可选输入针对该风格的负向词，例如: flat color, simplified" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:8px; color:#fff; font-size:12px; box-sizing:border-box;"></textarea>
                    </div>

                    <!-- NAI 生图参数设定 (标准采样器下拉 + 4维参数微调 + 一键同步我的酒馆设置) -->
                    <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:10px 12px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:6px;">
                            <span style="font-size:11.5px; color:#c084fc; font-weight:700;"><i class="fa-solid fa-sliders"></i> NAI 生图参数设定</span>
                            <button id="rbq-pm-up-param-mine-btn" type="button" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; font-size:10.5px; font-weight:600; padding:3px 10px; border-radius:5px; background:linear-gradient(135deg, #0284c7, #2563eb); border:none; color:#fff; cursor:pointer; transition:all 0.15s;" title="快速载入当前酒馆设置中正在生效的 NAI 参数">
                                <i class="fa-solid fa-user-gear"></i> 我的酒馆设置
                            </button>
                        </div>
                        <div class="rbq-pm-up-params-grid" style="display:grid; grid-template-columns: 1fr 1.35fr 1fr 1fr; gap:6px;">
                            <div>
                                <div style="font-size:9.5px; color:#94a3b8; margin-bottom:2px;">Scale (CFG)</div>
                                <input id="rbq-pm-up-param-scale" type="number" step="0.5" value="${activeScale}" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:5px; padding:4px 6px; color:#38bdf8; font-size:11px; font-family:monospace; box-sizing:border-box;">
                            </div>
                            <div>
                                <div style="font-size:9.5px; color:#94a3b8; margin-bottom:2px;">采样器 (Sampler)</div>
                                <select id="rbq-pm-up-param-sampler" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:5px; padding:4px 6px; color:#f0abfc; font-size:11px; outline:none; cursor:pointer; box-sizing:border-box;">
                                    <!-- populated dynamically -->
                                </select>
                            </div>
                            <div>
                                <div style="font-size:9.5px; color:#94a3b8; margin-bottom:2px;">步数 (Steps)</div>
                                <input id="rbq-pm-up-param-steps" type="number" step="1" value="${activeSteps}" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:5px; padding:4px 6px; color:#4ade80; font-size:11px; font-family:monospace; box-sizing:border-box;">
                            </div>
                            <div>
                                <div style="font-size:9.5px; color:#94a3b8; margin-bottom:2px;">CFG Rescale</div>
                                <input id="rbq-pm-up-param-rescale" type="number" step="0.05" value="${activeCfgRescale}" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:5px; padding:4px 6px; color:#fbbf24; font-size:11px; font-family:monospace; box-sizing:border-box;">
                            </div>
                        </div>
                    </div>

                    <!-- 统一基准底模提示框 (说明与复制) -->
                    <div style="background:linear-gradient(135deg, rgba(217,70,239,0.1), rgba(56,189,248,0.1)); border:1px solid rgba(217,70,239,0.3); border-radius:8px; padding:10px 12px; font-size:11.5px;">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <span style="font-weight:700; color:#f0abfc;"><i class="fa-solid fa-vial"></i> 官方基准测试底模 (由卡密sama提供)</span>
                            <button id="rbq-pm-up-copy-bm" type="button" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; background:rgba(217,70,239,0.25); border:1px solid rgba(217,70,239,0.5); color:#f0abfc; font-size:11px; font-weight:600; padding:3px 9px; border-radius:5px; cursor:pointer;" title="点击复制卡密sama基准测试词">
                                <i class="fa-solid fa-copy"></i> 复制基准词
                            </button>
                        </div>
                        <div style="color:#cbd5e1; margin-top:4px; font-size:11px; line-height:1.45;">
                            工坊封面<strong>必须为官方基准测试图</strong>（保障全场预设横向客观对比）；你也可以<strong>额外上传一张自制参考图</strong>展示该预设的个性化画面。
                        </div>
                    </div>

                    <!-- 双舱展示台：槽位 1 官方基准图 (封面 · 必传 *) + 槽位 2 自制参考图 (可选 +) -->
                    <div class="rbq-pm-up-slots-grid" style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:12px;">
                        <!-- 槽位 1: 官方基准测试图 (封面 · 必传 *) -->
                        <div style="background:linear-gradient(135deg, rgba(217,70,239,0.06), rgba(168,85,247,0.06)); border:1.5px solid rgba(217,70,239,0.35); border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:8px;">
                            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:4px;">
                                <div style="font-size:12.5px; color:#f0abfc; font-weight:700; display:inline-flex; align-items:center; gap:5px;">
                                    <i class="fa-solid fa-flask"></i> 封面基准图 (官方 · 必传 *)
                                </div>
                                <span id="rbq-pm-bm-spec" style="font-size:10px; color:#94a3b8;">720px WebP 封面</span>
                            </div>
                            <div style="font-size:11px; color:#cbd5e1; line-height:1.35;">
                                使用卡密sama底模渲染，作为工坊全场统一封面。
                            </div>

                            <!-- 槽位 1 未绑定态 -->
                            <div id="rbq-pm-bm-empty" style="display:flex; flex-direction:column; gap:8px; background:rgba(0,0,0,0.25); border:1.5px dashed rgba(217,70,239,0.4); border-radius:8px; padding:16px 12px; text-align:center; align-items:center; justify-content:center; min-height:160px;">
                                <div style="width:38px; height:38px; border-radius:8px; background:rgba(217,70,239,0.18); border:1px solid rgba(217,70,239,0.35); display:flex; align-items:center; justify-content:center; color:#f0abfc; font-size:18px;">
                                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                                </div>
                                <div style="font-size:12.5px; font-weight:700; color:#f0abfc;">现场生图实测 (官方基准)</div>
                                <div style="font-size:10.5px; color:#94a3b8; line-height:1.4; max-width:240px;">
                                    系统将自动合并官方底模词现场出图，杜绝未验证的伪基准图。
                                </div>
                                <div style="display:flex; flex-direction:column; gap:6px; width:100%; max-width:200px; margin-top:4px;">
                                    <button id="rbq-pm-run-draw" type="button" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:5px !important; white-space:nowrap !important; background:linear-gradient(135deg, #a855f7, #ec4899); border:none; color:#fff; font-size:11.5px; font-weight:700; padding:7px 14px; border-radius:6px; cursor:pointer; box-shadow:0 2px 10px rgba(168,85,247,0.35);">
                                        <i class="fa-solid fa-wand-magic-sparkles"></i> 立即生图实测 (必填封面)
                                    </button>
                                </div>
                            </div>

                            <!-- 槽位 1 已绑定态 -->
                            <div id="rbq-pm-bm-card-box" style="display:none; flex-direction:column; align-items:center; gap:8px;">
                                <div id="rbq-pm-bm-card" style="width:160px; aspect-ratio:3/4; border-radius:10px; overflow:hidden; background:#070b13; border:1.5px solid rgba(217,70,239,0.6); position:relative; cursor:zoom-in; box-shadow:0 8px 24px rgba(0,0,0,0.6);" title="点击放大">
                                    <img id="rbq-pm-bm-img" src="" style="width:100%; height:100%; object-fit:cover; object-position:center 15%; display:block;">
                                    <div style="position:absolute; top:6px; left:6px; background:linear-gradient(135deg, rgba(217,70,239,0.9), rgba(168,85,247,0.9)); color:#fff; font-size:9px; font-weight:700; padding:2px 6px; border-radius:4px;">
                                        <i class="fa-solid fa-flask"></i> 官方基准图 (封面)
                                    </div>
                                    <div style="position:absolute; bottom:6px; right:6px; background:rgba(0,0,0,0.7); backdrop-filter:blur(4px); font-size:9.5px; padding:2px 6px; border-radius:4px; color:#e2e8f0;">
                                        <i class="fa-solid fa-magnifying-glass-plus"></i> 放大
                                    </div>
                                </div>
                                <div id="rbq-pm-bm-status" style="font-size:10.5px; color:#4ade80; text-align:center;"></div>
                                <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; justify-content:center;">
                                    <button type="button" id="rbq-pm-bm-zoom-btn" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); color:#cbd5e1; font-size:10.5px; padding:4px 8px; border-radius:5px; cursor:pointer;">
                                        <i class="fa-solid fa-magnifying-glass-plus"></i> 查看大图
                                    </button>
                                    <button type="button" id="rbq-pm-bm-redraw-btn" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; background:linear-gradient(135deg, #a855f7, #ec4899); border:none; color:#fff; font-size:10.5px; font-weight:700; padding:4px 10px; border-radius:5px; cursor:pointer;">
                                        <i class="fa-solid fa-rotate"></i> 重新实测出图
                                    </button>
                                    <button type="button" id="rbq-pm-bm-clear-btn" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.3); color:#fca5a5; font-size:10.5px; padding:4px 8px; border-radius:5px; cursor:pointer;">
                                        <i class="fa-solid fa-trash-can"></i> 清除重测
                                    </button>
                                </div>
                            </div>
                        </div>

                        <!-- 槽位 2: 作者自制参考图 (作品展示 · 可选 +) -->
                        <div style="background:linear-gradient(135deg, rgba(56,189,248,0.06), rgba(37,99,235,0.06)); border:1.5px solid rgba(56,189,248,0.35); border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:8px;">
                            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:4px;">
                                <div style="font-size:12.5px; color:#7dd3fc; font-weight:700; display:inline-flex; align-items:center; gap:5px;">
                                    <i class="fa-solid fa-image"></i> 自制参考图 (效果展示 · 可选)
                                </div>
                                <span id="rbq-pm-ref-spec" style="font-size:10px; color:#64748b;">支持 PNG/JPG/WebP</span>
                            </div>
                            <div style="font-size:11px; color:#cbd5e1; line-height:1.35;">
                                可选上传一张使用该预设生成的个性化实机美图。
                            </div>

                            <!-- 槽位 2 未绑定态 -->
                            <div id="rbq-pm-ref-empty" style="display:flex; flex-direction:column; gap:8px; background:rgba(0,0,0,0.25); border:1.5px dashed rgba(56,189,248,0.4); border-radius:8px; padding:12px; text-align:center; align-items:center; justify-content:center; min-height:160px; cursor:pointer;">
                                <div style="width:36px; height:36px; border-radius:8px; background:rgba(56,189,248,0.18); border:1px solid rgba(56,189,248,0.35); display:flex; align-items:center; justify-content:center; color:#38bdf8; font-size:16px;">
                                    <i class="fa-solid fa-cloud-arrow-up"></i>
                                </div>
                                <div style="font-size:12px; font-weight:700; color:#7dd3fc;">上传自制参考图 (可选)</div>
                                <div style="font-size:10.5px; color:#94a3b8; line-height:1.35;">拖拽图片至此处，或点选文件<br><span style="color:#64748b; font-size:9.5px;">(不上传亦可正常发布预设)</span></div>
                                <button id="rbq-pm-pick-ref-btn" type="button" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:5px !important; white-space:nowrap !important; background:linear-gradient(135deg, #0284c7, #2563eb); border:none; color:#fff; font-size:11.5px; font-weight:700; padding:6px 14px; border-radius:6px; cursor:pointer;">
                                    <i class="fa-solid fa-folder-open"></i> 选择自制参考图
                                </button>
                                <input id="rbq-pm-file-ref" type="file" accept="image/*" style="display:none;">
                            </div>

                            <!-- 槽位 2 已绑定态 -->
                            <div id="rbq-pm-ref-card-box" style="display:none; flex-direction:column; align-items:center; gap:8px;">
                                <div id="rbq-pm-ref-card" style="width:160px; aspect-ratio:3/4; border-radius:10px; overflow:hidden; background:#070b13; border:1.5px solid rgba(56,189,248,0.6); position:relative; cursor:zoom-in; box-shadow:0 8px 24px rgba(0,0,0,0.6);" title="点击放大">
                                    <img id="rbq-pm-ref-img" src="" style="width:100%; height:100%; object-fit:cover; object-position:center 15%; display:block;">
                                    <div style="position:absolute; top:6px; left:6px; background:linear-gradient(135deg, rgba(56,189,248,0.9), rgba(37,99,235,0.9)); color:#fff; font-size:9px; font-weight:700; padding:2px 6px; border-radius:4px;">
                                        <i class="fa-solid fa-image"></i> 自制参考图
                                    </div>
                                    <div style="position:absolute; bottom:6px; right:6px; background:rgba(0,0,0,0.7); backdrop-filter:blur(4px); font-size:9.5px; padding:2px 6px; border-radius:4px; color:#e2e8f0;">
                                        <i class="fa-solid fa-magnifying-glass-plus"></i> 放大
                                    </div>
                                </div>
                                <div id="rbq-pm-ref-status" style="font-size:10.5px; color:#38bdf8; text-align:center;"></div>
                                <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; justify-content:center;">
                                    <button type="button" id="rbq-pm-ref-zoom-btn" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); color:#cbd5e1; font-size:10.5px; padding:4px 8px; border-radius:5px; cursor:pointer;">
                                        <i class="fa-solid fa-magnifying-glass-plus"></i> 查看大图
                                    </button>
                                    <button type="button" id="rbq-pm-ref-change-btn" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; background:rgba(56,189,248,0.15); border:1px solid rgba(56,189,248,0.35); color:#7dd3fc; font-size:10.5px; padding:4px 8px; border-radius:5px; cursor:pointer;">
                                        <i class="fa-solid fa-folder-open"></i> 更换图片
                                    </button>
                                    <button type="button" id="rbq-pm-ref-clear-btn" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.3); color:#fca5a5; font-size:10.5px; padding:4px 8px; border-radius:5px; cursor:pointer;">
                                        <i class="fa-solid fa-trash-can"></i> 移除参考图
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div style="padding:14px 18px; background:#1e293b; border-top:1px solid rgba(255,255,255,0.08); display:flex; justify-content:flex-end; gap:8px;">
                    <button id="rbq-pm-up-cancel" class="menu_button" style="font-size:12px; padding:6px 14px;">取消</button>
                    <button id="rbq-pm-up-submit" class="menu_button" disabled style="background:#0284c7; border:none; color:#fff; font-size:12px; padding:6px 18px; font-weight:700; opacity:0.45; cursor:not-allowed;" title="必须先获取官方基准测试图作为封面"><i class="fa-solid fa-ban"></i> 需先提供官方基准测试图 (封面)</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        bindFastClose(overlay.querySelector('#rbq-pm-upload-close'), () => closeSubDialog(overlay));
        bindFastClose(overlay.querySelector('#rbq-pm-up-cancel'), () => closeSubDialog(overlay));
        bindDialogBackdropClose(overlay);

        overlay.querySelector('#rbq-pm-up-copy-bm').onclick = async () => {
            await copyToClipboard(BENCHMARK_POSITIVE_PROMPT);
            toastr.success('已复制基准测试底模词！(由卡密sama提供)');
        };

        const localSelect = overlay.querySelector('#rbq-pm-local-select');
        const upScaleInput = overlay.querySelector('#rbq-pm-up-param-scale');
        const upSamplerSelect = overlay.querySelector('#rbq-pm-up-param-sampler');
        const upStepsInput = overlay.querySelector('#rbq-pm-up-param-steps');
        const upRescaleInput = overlay.querySelector('#rbq-pm-up-param-rescale');
        const upBtnMine = overlay.querySelector('#rbq-pm-up-param-mine-btn');

        const populateUpSamplerOptions = (selectedVal) => {
            let optionsHtml = '';
            let matched = false;
            for (const item of NAI_SAMPLERS) {
                const isSel = (item.value === selectedVal);
                if (isSel) matched = true;
                optionsHtml += `<option value="${item.value}" ${isSel ? 'selected' : ''}>${item.label}</option>`;
            }
            if (!matched && selectedVal) {
                optionsHtml += `<option value="${escapeHtml(selectedVal)}" selected>${escapeHtml(selectedVal)}</option>`;
            }
            upSamplerSelect.innerHTML = optionsHtml;
        };

        populateUpSamplerOptions(activeSampler);

        function syncCapturedParams() {
            capturedParams.scale = upScaleInput.value !== '' ? Number(upScaleInput.value) : 6.0;
            capturedParams.sampler = upSamplerSelect.value || 'k_euler_ancestral';
            capturedParams.steps = upStepsInput.value !== '' ? Math.max(1, Math.round(Number(upStepsInput.value))) : 28;
            capturedParams.cfgRescale = upRescaleInput.value !== '' ? Number(upRescaleInput.value) : 0;
        }

        if (upBtnMine) {
            upBtnMine.onclick = () => {
                const fresh = (typeof RBQ?.api?.getSettings === 'function') ? RBQ.api.getSettings() : {};
                const myScale = fresh.naiScale !== undefined && fresh.naiScale !== null ? Number(fresh.naiScale) : 6.0;
                const mySampler = fresh.naiSampler || 'k_euler_ancestral';
                const mySteps = fresh.naiSteps !== undefined && fresh.naiSteps !== null ? Number(fresh.naiSteps) : 28;
                const myRescale = fresh.naiCfgRescale !== undefined && fresh.naiCfgRescale !== null ? Number(fresh.naiCfgRescale) : 0;

                upScaleInput.value = myScale;
                populateUpSamplerOptions(mySampler);
                upSamplerSelect.value = mySampler;
                upStepsInput.value = mySteps;
                upRescaleInput.value = myRescale;
                syncCapturedParams();
                toastr.info('已载入当前酒馆全局生图设置');
            };
        }

        [upScaleInput, upSamplerSelect, upStepsInput, upRescaleInput].forEach(el => {
            if (!el) return;
            el.onchange = () => syncCapturedParams();
            el.oninput = () => syncCapturedParams();
        });

        localSelect.onchange = (e) => {
            const idx = e.target.value;
            if (idx !== '' && localPresets[idx]) {
                const p = localPresets[idx];
                overlay.querySelector('#rbq-pm-up-title').value = p.name || '';
                overlay.querySelector('#rbq-pm-up-pos').value = p.positive || '';
                overlay.querySelector('#rbq-pm-up-neg').value = p.negative || '';
                if (p.params) {
                    if (p.params.scale !== undefined) upScaleInput.value = Number(p.params.scale);
                    if (p.params.sampler) {
                        populateUpSamplerOptions(p.params.sampler);
                        upSamplerSelect.value = p.params.sampler;
                    }
                    if (p.params.steps !== undefined) upStepsInput.value = Number(p.params.steps);
                    if (p.params.cfgRescale !== undefined) upRescaleInput.value = Number(p.params.cfgRescale);
                    syncCapturedParams();
                    toastr.success(`已导入「${p.name || p.id}」及专属生图参数！`);
                } else {
                    toastr.success(`已导入「${p.name || p.id}」！`);
                }
            }
        };

        // 双图状态储存
        let bmCompressedBase64 = ''; // 官方基准测试图 (封面 · 必传)
        let refCompressedBase64 = ''; // 作者自制参考图 (可选)

        const submitBtn = overlay.querySelector('#rbq-pm-up-submit');

        function updateSubmitButtonState() {
            if (!submitBtn) return;
            if (!bmCompressedBase64) {
                submitBtn.disabled = true;
                submitBtn.style.opacity = '0.45';
                submitBtn.style.cursor = 'not-allowed';
                submitBtn.innerHTML = '<i class="fa-solid fa-ban"></i> 需先提供官方基准测试图 (封面)';
            } else {
                submitBtn.disabled = false;
                submitBtn.style.opacity = '1';
                submitBtn.style.cursor = 'pointer';
                submitBtn.innerHTML = refCompressedBase64 
                    ? '<i class="fa-solid fa-paper-plane"></i> 确认发布预设 (含自制参考图)'
                    : '<i class="fa-solid fa-paper-plane"></i> 确认发布预设至工坊';
            }
        }

        // ── 槽位 1 控制绑定：官方基准测试图 (封面) ──
        const bmEmptyEl = overlay.querySelector('#rbq-pm-bm-empty');
        const bmCardBox = overlay.querySelector('#rbq-pm-bm-card-box');
        const bmCard = overlay.querySelector('#rbq-pm-bm-card');
        const bmImg = overlay.querySelector('#rbq-pm-bm-img');
        const bmStatus = overlay.querySelector('#rbq-pm-bm-status');
        const bmSpec = overlay.querySelector('#rbq-pm-bm-spec');
        const bmDrawBtn = overlay.querySelector('#rbq-pm-run-draw');
        const bmRedrawBtn = overlay.querySelector('#rbq-pm-bm-redraw-btn');
        const bmClearBtn = overlay.querySelector('#rbq-pm-bm-clear-btn');
        const bmZoomBtn = overlay.querySelector('#rbq-pm-bm-zoom-btn');

        function bindBenchmarkImage(imgObj, sourceName = '现场实测出图') {
            const { b64, width, height, approxKb, format } = compressToWebp(imgObj);
            bmCompressedBase64 = b64;
            bmImg.src = b64;
            bmEmptyEl.style.display = 'none';
            bmCardBox.style.display = 'flex';
            bmStatus.innerHTML = `<i class="fa-solid fa-circle-check"></i> 已绑定基准封面 (${escapeHtml(sourceName)})`;
            bmSpec.textContent = `${width}x${height} ${format || 'WebP'} (~${approxKb}KB)`;
            updateSubmitButtonState();
        }

        function clearBenchmarkImage() {
            bmCompressedBase64 = '';
            bmImg.src = '';
            bmCardBox.style.display = 'none';
            bmEmptyEl.style.display = 'flex';
            bmSpec.textContent = '720px WebP 封面';
            updateSubmitButtonState();
        }

        if (bmClearBtn) bmClearBtn.onclick = clearBenchmarkImage;
        if (bmZoomBtn) bmZoomBtn.onclick = () => { if (bmCompressedBase64) openImageZoom(bmCompressedBase64); };
        if (bmCard) bmCard.onclick = () => { if (bmCompressedBase64) openImageZoom(bmCompressedBase64); };

        // 槽位 1 现场生图核心逻辑 (与卡密sama底模提示词合并)
        async function runBenchmarkLiveDraw() {
            const pos = overlay.querySelector('#rbq-pm-up-pos').value.trim();
            const neg = overlay.querySelector('#rbq-pm-up-neg').value.trim();
            if (!pos) {
                toastr.warning('请先输入你的正面画师串/预设提示词！');
                return;
            }
            if (typeof RBQ?.api?.generateImage !== 'function') {
                toastr.error('酒馆当前未启用 RBQ 生图流水线，请检查生图插件是否正常激活');
                return;
            }

            const finalPrompt = [pos, BENCHMARK_POSITIVE_PROMPT].map(p => (p || '').trim().replace(/^,+|,+$/g, '').trim()).filter(Boolean).join(', ');
            const finalNegative = [neg, BENCHMARK_NEGATIVE_PROMPT].map(p => (p || '').trim().replace(/^,+|,+$/g, '').trim()).filter(Boolean).join(', ');

            syncCapturedParams();

            const origHtml = bmDrawBtn.innerHTML;
            bmDrawBtn.disabled = true;
            bmDrawBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>正在排队出图...</span>';
            if (bmRedrawBtn) {
                bmRedrawBtn.disabled = true;
                bmRedrawBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 出图中...';
            }

            try {
                const uploadMeta = {
                    isolate: true,
                    skipPresets: true,
                    skipPrefixSuffix: true,
                    negative: finalNegative,
                    scale: capturedParams.scale,
                    sampler: capturedParams.sampler,
                    steps: capturedParams.steps,
                    cfgRescale: capturedParams.cfgRescale
                };
                const drawRes = await RBQ.api.generateImage(finalPrompt, 'market-preset-benchmark', uploadMeta, (progress) => {
                    if (progress) bmDrawBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>${escapeHtml(progress)}</span>`;
                });

                if (!drawRes || !drawRes.url) {
                    throw new Error('生图服务未返回有效图片地址');
                }

                const drawImg = new Image();
                drawImg.crossOrigin = 'anonymous';
                drawImg.onload = () => {
                    bindBenchmarkImage(drawImg, '现场基准实测出图');
                    toastr.success('🎉 官方基准测试图生成成功并已绑定为封面！所见即所得。');
                };
                drawImg.onerror = async () => {
                    try {
                        const blobResp = await fetch(drawRes.url);
                        const blob = await blobResp.blob();
                        const reader = new FileReader();
                        reader.onload = (ev) => {
                            const bImg = new Image();
                            bImg.onload = () => {
                                bindBenchmarkImage(bImg, '现场基准实测出图');
                                toastr.success('🎉 官方基准测试图生成成功并已绑定为封面！');
                            };
                            bImg.src = ev.target.result;
                        };
                        reader.readAsDataURL(blob);
                    } catch (e) {
                        toastr.error('解析生成图片失败: ' + e.message);
                    }
                };
                drawImg.src = drawRes.url;
            } catch (err) {
                toastr.error('现场基准生图失败: ' + (err.message || String(err)));
            } finally {
                bmDrawBtn.disabled = false;
                bmDrawBtn.innerHTML = origHtml;
                if (bmRedrawBtn) {
                    bmRedrawBtn.disabled = false;
                    bmRedrawBtn.innerHTML = '<i class="fa-solid fa-rotate"></i> 重新实测';
                }
            }
        }

        if (bmDrawBtn) bmDrawBtn.onclick = runBenchmarkLiveDraw;
        if (bmRedrawBtn) bmRedrawBtn.onclick = runBenchmarkLiveDraw;

        // ── 槽位 2 控制绑定：作者自制参考图 (可选) ──
        const refEmptyEl = overlay.querySelector('#rbq-pm-ref-empty');
        const refCardBox = overlay.querySelector('#rbq-pm-ref-card-box');
        const refCard = overlay.querySelector('#rbq-pm-ref-card');
        const refImg = overlay.querySelector('#rbq-pm-ref-img');
        const refStatus = overlay.querySelector('#rbq-pm-ref-status');
        const refSpec = overlay.querySelector('#rbq-pm-ref-spec');
        const refFileInput = overlay.querySelector('#rbq-pm-file-ref');
        const refPickBtn = overlay.querySelector('#rbq-pm-pick-ref-btn');
        const refChangeBtn = overlay.querySelector('#rbq-pm-ref-change-btn');
        const refClearBtn = overlay.querySelector('#rbq-pm-ref-clear-btn');
        const refZoomBtn = overlay.querySelector('#rbq-pm-ref-zoom-btn');

        function bindReferenceImage(imgObj, fileName = '自制美图') {
            const { b64, width, height, approxKb, format } = compressToWebp(imgObj);
            refCompressedBase64 = b64;
            refImg.src = b64;
            refEmptyEl.style.display = 'none';
            refCardBox.style.display = 'flex';
            refStatus.innerHTML = `<i class="fa-solid fa-circle-check"></i> 已绑定自制参考图 (${escapeHtml(fileName)})`;
            refSpec.textContent = `${width}x${height} ${format || 'WebP'} (~${approxKb}KB)`;
            updateSubmitButtonState();
        }

        function clearReferenceImage() {
            refCompressedBase64 = '';
            refImg.src = '';
            refCardBox.style.display = 'none';
            refEmptyEl.style.display = 'flex';
            refFileInput.value = '';
            refSpec.textContent = '支持 PNG/JPG/WebP';
            updateSubmitButtonState();
        }

        if (refClearBtn) refClearBtn.onclick = clearReferenceImage;
        if (refZoomBtn) refZoomBtn.onclick = () => { if (refCompressedBase64) openImageZoom(refCompressedBase64); };
        if (refCard) refCard.onclick = () => { if (refCompressedBase64) openImageZoom(refCompressedBase64); };
        if (refPickBtn) refPickBtn.onclick = (e) => { e.stopPropagation(); refFileInput.click(); };
        if (refChangeBtn) refChangeBtn.onclick = (e) => { e.stopPropagation(); refFileInput.click(); };

        if (refEmptyEl) {
            refEmptyEl.onclick = (e) => {
                if (e.target !== refPickBtn) refFileInput.click();
            };
            refEmptyEl.ondragover = (e) => {
                e.preventDefault();
                refEmptyEl.style.borderColor = '#38bdf8';
                refEmptyEl.style.background = 'rgba(56, 189, 248, 0.16)';
            };
            refEmptyEl.ondragleave = (e) => {
                e.preventDefault();
                refEmptyEl.style.borderColor = 'rgba(56, 189, 248, 0.4)';
                refEmptyEl.style.background = 'rgba(0,0,0,0.25)';
            };
            refEmptyEl.ondrop = (e) => {
                e.preventDefault();
                refEmptyEl.style.borderColor = 'rgba(56, 189, 248, 0.4)';
                refEmptyEl.style.background = 'rgba(0,0,0,0.25)';
                const file = e.dataTransfer?.files?.[0];
                if (file && file.type.startsWith('image/')) {
                    handleRefFile(file);
                } else {
                    toastr.warning('请拖拽有效的图片文件 (PNG / JPG / WebP)');
                }
            };
        }

        function handleRefFile(file) {
            if (!file) return;
            const titleInput = overlay.querySelector('#rbq-pm-up-title');
            if (titleInput && !titleInput.value.trim()) {
                const autoTitle = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
                if (autoTitle) titleInput.value = autoTitle;
            }
            const reader = new FileReader();
            reader.onload = (event) => {
                const img = new Image();
                img.onload = () => {
                    bindReferenceImage(img, file.name);
                    toastr.success(`🎉 已成功导入作者自制参考图「${file.name}」！`);
                };
                img.src = event.target.result;
            };
            reader.readAsDataURL(file);
        }

        refFileInput.onchange = (e) => {
            const file = e.target.files?.[0];
            if (file) handleRefFile(file);
        };

        // 提交发布
        overlay.querySelector('#rbq-pm-up-submit').onclick = async () => {
            const title = overlay.querySelector('#rbq-pm-up-title').value.trim();
            const positive = overlay.querySelector('#rbq-pm-up-pos').value.trim();
            const author = overlay.querySelector('#rbq-pm-up-author').value.trim() || '匿名';
            const model = overlay.querySelector('#rbq-pm-up-model').value || 'v5';
            const negative = overlay.querySelector('#rbq-pm-up-neg').value.trim();
            const rawTags = overlay.querySelector('#rbq-pm-up-tags').value.trim();
            const tags = rawTags.split(/[\s,，]+/).filter(Boolean);

            syncCapturedParams();
            const uploadParams = {
                scale: capturedParams.scale !== undefined ? Number(capturedParams.scale) : 6.0,
                sampler: capturedParams.sampler || 'k_euler_ancestral',
                steps: capturedParams.steps !== undefined ? Number(capturedParams.steps) : 28,
                cfgRescale: capturedParams.cfgRescale !== undefined ? Number(capturedParams.cfgRescale) : 0
            };

            if (!title || !positive) {
                toastr.warning('请填写标题和正面画师/预设提示词！');
                return;
            }

            // 严格要求：封面基准测试图为必选！
            if (!bmCompressedBase64) {
                toastr.warning('封面用的官方基准测试图为必传项！请现场生图或上传基准图。');
                return;
            }

            cfg.authorName = author;
            saveConfig();

            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 发布中...';

            const descriptionText = refCompressedBase64 ? '包含官方基准测试封面与作者自制效果参考图' : '官方基准测试封面由「卡密sama」提示词渲染';

            try {
                const res = await fetch(`${uploadEndpoint}/api/upload`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title,
                        author,
                        model,
                        positive,
                        negative,
                        tags,
                        params: uploadParams,
                        description: descriptionText,
                        creatorKey: cfg.creatorKey,
                        previewUrl: '',
                        previewBase64: bmCompressedBase64,
                        referenceBase64: refCompressedBase64 || ''
                    })
                });

                let data = null;
                try {
                    data = await res.json();
                } catch (_) {}

                if (res.ok && data?.success) {
                    if (data.item?.id && !cfg.myUploadedIds.includes(data.item.id)) {
                        cfg.myUploadedIds.push(data.item.id);
                        serverOwnedIds.add(data.item.id);
                        saveConfig();
                    }
                    toastr.success('🎉 发布成功！你的预设已同步至云端工坊！');
                    closeSubDialog(overlay);
                    loadMarketData();
                } else {
                    const errMsg = data?.error || (res.status ? `服务器异常 (HTTP ${res.status})` : '未知错误');
                    toastr.error('发布失败: ' + errMsg);
                }
            } catch (err) {
                toastr.error('请求网络错误: ' + (err.message || String(err)));
            } finally {
                submitBtn.disabled = false;
                updateSubmitButtonState();
            }
        };
    }

    // ── 设置弹窗 (集成创作者身份码与服主管理员密钥体系) ──
    function openSettingsDialog() {
        const cfg = getConfig();
        const overlay = document.createElement('div');
        overlay.id = 'rbq-pm-settings-dialog';
        overlay.style.cssText = 'position:fixed; inset:0; z-index:2147483642; background:rgba(0,0,0,0.85); display:flex; align-items:center; justify-content:center; backdrop-filter:blur(8px);';
        overlay.innerHTML = `
            <div style="width:92vw; max-width:520px; max-height:88vh; background:#0f172a; border:1px solid rgba(255,255,255,0.16); border-radius:14px; display:flex; flex-direction:column; overflow:hidden; color:#fff; box-shadow:0 25px 60px rgba(0,0,0,0.85);">
                <div style="padding:14px 18px; background:#1e293b; border-bottom:1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center;">
                    <div style="font-size:14.5px; font-weight:700; display:flex; align-items:center; gap:8px;">
                        <i class="fa-solid fa-gear" style="color:#38bdf8;"></i>
                        <span>工坊设置与创作者身份</span>
                    </div>
                    <button id="rbq-pm-set-close" class="rbq-pm-close-btn" title="关闭设置" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div style="padding:16px 18px; display:flex; flex-direction:column; gap:14px; overflow-y:auto; flex:1;">
                    <!-- 创作者个人码 (Creator Key) 专区 -->
                    <div style="background:linear-gradient(135deg, rgba(2,132,199,0.1), rgba(139,92,246,0.1)); border:1px solid rgba(56,189,248,0.25); border-radius:10px; padding:12px 14px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                            <span style="font-size:12px; font-weight:700; color:#38bdf8; display:inline-flex; align-items:center; gap:6px;">
                                <i class="fa-solid fa-id-card"></i> 创作者个人码 (Creator Key)
                            </span>
                            <span style="font-size:10px; background:rgba(56,189,248,0.15); color:#7dd3fc; border:1px solid rgba(56,189,248,0.3); padding:1px 5px; border-radius:4px;">可选 · 需发布/删除时使用</span>
                        </div>
                        <div style="display:flex; gap:6px; align-items:center;">
                            <input id="rbq-pm-cfg-creator-key" type="text" value="${escapeHtml(cfg.creatorKey || '')}" placeholder="未设置 (例如: RBQ-U-d31879f4，或点击随机生成)" style="flex:1; background:#070b13; border:1px solid rgba(56,189,248,0.35); border-radius:6px; padding:6px 10px; color:#f0abfc; font-family:monospace; font-size:12px; font-weight:700; outline:none; box-sizing:border-box;">
                            <button id="rbq-pm-cfg-regen-key" type="button" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:#cbd5e1; font-size:11px; padding:6px 10px; border-radius:6px; cursor:pointer;" title="随机生成专属个人身份码">
                                <i class="fa-solid fa-dice"></i> 随机生成
                            </button>
                            <button id="rbq-pm-cfg-copy-key" type="button" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:#cbd5e1; font-size:11px; padding:6px 10px; border-radius:6px; cursor:pointer;" title="复制创作者个人码">
                                <i class="fa-solid fa-copy"></i> 复制
                            </button>
                        </div>
                        <div style="display:flex; gap:6px; align-items:center; margin-top:6px;">
                            <button id="rbq-pm-cfg-rotate-key" type="button" class="menu_button" style="display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:4px !important; white-space:nowrap !important; background:rgba(234,179,8,0.14); border:1px solid rgba(234,179,8,0.45); color:#fde68a; font-size:11px; padding:6px 10px; border-radius:6px; cursor:pointer;" title="生成新的个人码，并把旧码名下的全部作品迁移过去；旧码随即失效">
                                <i class="fa-solid fa-key"></i> 换码 / 重新生成并迁移
                            </button>
                            <span style="font-size:10.5px; color:#a3a3a3; line-height:1.4;">旧码可能已泄露？在上方填入（或粘贴）旧码后点这里，作品会转到新码，旧码立即失效。</span>
                        </div>
                        <div style="font-size:11px; color:#94a3b8; margin-top:6px; line-height:1.45;">
                            ✨ 用于发布预设时的作品归属与<strong>随时下架删除/在线编辑</strong>。输入你的专属身份码（例如：<code>RBQ-U-d31879f4</code>）即可同步认领并管理历史作品；也可点击「随机生成」；复制到其他设备即可漫游！
                        </div>
                    </div>

                    <!-- 基础服务设置 -->
                    <div>
                        <label style="font-size:12px; color:#94a3b8; display:block; margin-bottom:4px;">工坊服务器地址 (API 接口)</label>
                        <input id="rbq-pm-cfg-server" type="text" placeholder="https://market.rbq.my" value="${escapeHtml(cfg.serverUrl || '')}" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:6px 10px; color:#fff; font-size:12px; box-sizing:border-box;">
                        <div style="font-size:11px; color:#64748b; margin-top:3px;">默认直连社区工坊服务器 (https://market.rbq.my)。</div>
                    </div>

                    <div>
                        <label style="font-size:12px; color:#94a3b8; display:block; margin-bottom:4px;">默认作者署名 (发布作品时的默认昵称，可随时修改)</label>
                        <input id="rbq-pm-cfg-author" type="text" placeholder="匿名" value="${escapeHtml(cfg.authorName || '匿名')}" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:6px 10px; color:#fff; font-size:12px; box-sizing:border-box;">
                    </div>

                    <!-- 服主管理员专区 -->
                    <div style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:10px 12px;">
                        <label style="font-size:12px; color:#cbd5e1; display:flex; align-items:center; gap:6px; margin-bottom:4px; font-weight:600;">
                            <i class="fa-solid fa-shield-halved" style="color:#ef4444;"></i> 服主管理密钥 (Admin Key - 普通用户留空)
                        </label>
                        <input id="rbq-pm-cfg-admin-key" type="password" placeholder="未设置 (仅服主/巡查管理员填写)" value="${escapeHtml(cfg.adminKey || '')}" style="width:100%; background:#1e293b; border:1px solid rgba(255,255,255,0.12); border-radius:6px; padding:6px 10px; color:#fca5a5; font-size:12px; box-sizing:border-box;">
                        <div style="font-size:11px; color:#64748b; margin-top:3px;">填入正确的服主密钥后，将激活全局巡查管理权限，可一键下架清理任何违规预设。</div>
                    </div>
                </div>
                <div style="padding:12px 18px; background:#1e293b; border-top:1px solid rgba(255,255,255,0.08); display:flex; justify-content:flex-end; gap:8px;">
                    <button id="rbq-pm-set-cancel" class="menu_button" style="font-size:12px; padding:6px 14px;">取消</button>
                    <button id="rbq-pm-set-save" class="menu_button" style="background:#0284c7; border:none; color:#fff; font-size:12px; font-weight:700; padding:6px 16px;"><i class="fa-solid fa-floppy-disk"></i> 保存设置</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        bindFastClose(overlay.querySelector('#rbq-pm-set-close'), () => closeSubDialog(overlay));
        bindFastClose(overlay.querySelector('#rbq-pm-set-cancel'), () => closeSubDialog(overlay));
        bindDialogBackdropClose(overlay);

        // 复制个人码
        overlay.querySelector('#rbq-pm-cfg-copy-key').onclick = async () => {
            const keyVal = overlay.querySelector('#rbq-pm-cfg-creator-key').value.trim();
            if (!keyVal) {
                toastr.info('当前尚未设置个人码，请先点击「随机生成」或手动输入');
                return;
            }
            await copyToClipboard(keyVal);
            toastr.success('已复制创作者个人码到剪贴板！');
        };

        // 随机生成个人码
        overlay.querySelector('#rbq-pm-cfg-regen-key').onclick = () => {
            const inputEl = overlay.querySelector('#rbq-pm-cfg-creator-key');
            if (inputEl.value.trim() && !confirm('当前已设置个人码，确定要覆盖生成新的身份码吗？\n（旧码发布的作品需用旧码才能删除）')) {
                return;
            }
            const newKey = generateCreatorKey();
            inputEl.value = newKey;
            toastr.success(`已生成专属创作者码「${newKey}」，请点击「保存设置」生效！`);
        };

        // 换码：生成新码 → 服务器把旧码名下的作品全部迁移 → 本地保存新码
        const rotateBtn = overlay.querySelector('#rbq-pm-cfg-rotate-key');
        rotateBtn.onclick = async () => {
            const inputEl = overlay.querySelector('#rbq-pm-cfg-creator-key');
            const oldKey = inputEl.value.trim();
            if (!oldKey) {
                toastr.warning('请先在上方输入框填入（或粘贴）你要更换的旧个人码');
                return;
            }
            const rawServer = overlay.querySelector('#rbq-pm-cfg-server').value.trim() || cfg.serverUrl || 'https://market.rbq.my';
            const endpoint = rawServer.replace(/\/+$/, '');
            if (!confirm(`确定要换码吗？\n\n· 将生成一个新的个人码，并把旧码「${oldKey.slice(0, 10)}…」名下的全部作品迁移到新码。\n· 迁移成功后旧码立即失效：其他设备上的旧码将无法再编辑/下架这些作品，需要改填新码。\n· 新码会自动保存到本机，请务必复制备份！`)) {
                return;
            }
            const newKey = generateCreatorKey();
            rotateBtn.disabled = true;
            try {
                const res = await fetch(`${endpoint}/api/rotate-key`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${oldKey}` },
                    body: JSON.stringify({ oldKey, newKey })
                });
                let data = null;
                try { data = await res.json(); } catch (_) {}
                if (res.status === 404) {
                    toastr.error('当前服务器版本不支持换码 (/api/rotate-key)，请联系服主升级服务器。');
                    return;
                }
                if (!res.ok || !data?.success) {
                    toastr.error('换码失败: ' + (data?.error || `HTTP ${res.status}`));
                    return;
                }
                const moved = Number(data.moved) || 0;
                if (moved === 0 && !confirm('旧码名下没有找到任何作品（可能输错了、或已经换过码）。\n仍然要改用新生成的个人码吗？')) {
                    return;
                }
                inputEl.value = newKey;
                cfg.creatorKey = newKey;
                if (rawServer) cfg.serverUrl = endpoint;
                saveConfig();
                await refreshMyPresetIds();
                if (moved > 0) {
                    toastr.success(`换码成功！已将 ${moved} 个作品迁移到新个人码「${newKey}」，旧码已失效。请复制备份新码。`);
                } else {
                    toastr.success(`已改用新个人码「${newKey}」。请复制备份新码。`);
                }
                if (marketModal) {
                    refreshDynamicTags();
                    renderCards();
                }
            } catch (err) {
                toastr.error('换码请求网络错误: ' + (err.message || String(err)));
            } finally {
                rotateBtn.disabled = false;
            }
        };

        // 保存设置
        overlay.querySelector('#rbq-pm-set-save').onclick = () => {
            const rawServer = overlay.querySelector('#rbq-pm-cfg-server').value.trim();
            const creatorKeyVal = overlay.querySelector('#rbq-pm-cfg-creator-key').value.trim();
            const adminKeyVal = overlay.querySelector('#rbq-pm-cfg-admin-key').value.trim();

            cfg.serverUrl = rawServer ? rawServer.replace(/\/+$/, '') : 'https://market.rbq.my';
            cfg.authorName = overlay.querySelector('#rbq-pm-cfg-author').value.trim() || '匿名';
            cfg.creatorKey = creatorKeyVal; // 尊重用户选择：输入了就保存，留空就保持为空，绝不强塞
            cfg.adminKey = adminKeyVal;

            saveConfig();
            toastr.success('工坊设置已成功保存！');
            closeSubDialog(overlay);
            loadMarketData();
        };
    }

    // ── 大图查看 ──
    function openImageZoom(url) {
        const overlay = document.createElement('div');
        overlay.id = 'rbq-pm-zoom-overlay';
        overlay.style.cssText = 'position:fixed; inset:0; z-index:2147483646; background:rgba(0,0,0,0.92); display:flex; align-items:center; justify-content:center; cursor:zoom-out; backdrop-filter:blur(14px);';
        const safeUrl = safeImageUrl(url, '', { allowLocal: true });
        if (!safeUrl) return;
        overlay.innerHTML = `<img src="${escapeHtml(safeUrl)}" style="max-width:92vw; max-height:92vh; border-radius:8px; box-shadow:0 10px 40px rgba(0,0,0,0.85);">`;
        bindFastClose(overlay, () => closeSubDialog(overlay));
        bindDialogBackdropClose(overlay);
        document.body.appendChild(overlay);
    }

    // ── 注入入口按钮至提示词预设面板 ──
    function injectMarketEntry() {
        const check = () => {
            // 彻底清理悬浮球入口 (避免视觉污染与冗余)
            const oldFloatBtn = document.getElementById('rbq-pm-float-btn');
            if (oldFloatBtn) {
                oldFloatBtn.remove();
            }

            const presetPanel = document.getElementById('rbq-prompt-presets-panel');
            if (presetPanel) {
                // 1. 优先注入在【提示词预设】卡片标题栏右侧 (利用横向留白，最高辨识度且不占纵向高度)
                const header = presetPanel.querySelector('.rbq-pp-header');
                if (header && !document.getElementById('rbq-pm-header-entry-btn')) {
                    const btn = document.createElement('button');
                    btn.id = 'rbq-pm-header-entry-btn';
                    btn.type = 'button';
                    btn.style.cssText = 'background: linear-gradient(135deg, rgba(56, 189, 248, 0.16), rgba(37, 99, 235, 0.22)); border: 1px solid rgba(56, 189, 248, 0.45); color: #38bdf8; padding: 5px 12px; border-radius: 8px; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 7px; cursor: pointer; box-shadow: 0 0 12px rgba(56, 189, 248, 0.18); transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); white-space: nowrap; flex-shrink: 0; outline: none;';
                    btn.innerHTML = '<i class="fa-solid fa-store" style="color: #38bdf8; font-size: 12.5px;"></i><span>预设工坊市场</span><span style="font-size: 9.5px; opacity: 0.75; font-family: monospace; letter-spacing: 0.5px; background: rgba(56,189,248,0.22); padding: 1px 5px; border-radius: 4px; font-weight: 700;">MARKET</span>';
                    
                    btn.onmouseenter = () => {
                        btn.style.borderColor = 'rgba(56, 189, 248, 0.85)';
                        btn.style.boxShadow = '0 0 18px rgba(56, 189, 248, 0.45)';
                        btn.style.transform = 'translateY(-1px)';
                        btn.style.color = '#7dd3fc';
                    };
                    btn.onmouseleave = () => {
                        btn.style.borderColor = 'rgba(56, 189, 248, 0.45)';
                        btn.style.boxShadow = '0 0 12px rgba(56, 189, 248, 0.18)';
                        btn.style.transform = 'none';
                        btn.style.color = '#38bdf8';
                    };
                    btn.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openMarketModal();
                    };
                    header.appendChild(btn);
                }

                // 2. 同时在【预设操作工具栏】注入辅助按钮 (与新建/导入/导出并列)
                const toolbar = presetPanel.querySelector('.rbq-pp-toolbar');
                if (toolbar && !document.getElementById('rbq-pm-toolbar-entry-btn')) {
                    const tbBtn = document.createElement('button');
                    tbBtn.id = 'rbq-pm-toolbar-entry-btn';
                    tbBtn.type = 'button';
                    tbBtn.className = 'rbq-pp-btn rbq-pp-btn-secondary';
                    tbBtn.style.cssText = 'border-color: rgba(56,189,248,0.35); color: #38bdf8; background: rgba(56,189,248,0.08);';
                    tbBtn.innerHTML = '<i class="fa-solid fa-store"></i> <span>工坊市场</span>';
                    tbBtn.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openMarketModal();
                    };
                    const batchDel = toolbar.querySelector('#rbq-pp-batch-delete');
                    if (batchDel) {
                        toolbar.insertBefore(tbBtn, batchDel);
                    } else {
                        toolbar.appendChild(tbBtn);
                    }
                }
            } else {
                // 3. 兜底回退：如果未加载预设插件，尝试注入到提示词面板标题
                const promptPanel = document.querySelector('[data-kite-panel="prompt"]');
                if (promptPanel && !document.getElementById('rbq-pm-fallback-entry-btn')) {
                    const titleEl = promptPanel.querySelector('.st-scene-trigger-panel-title');
                    if (titleEl) {
                        const fbBtn = document.createElement('button');
                        fbBtn.id = 'rbq-pm-fallback-entry-btn';
                        fbBtn.type = 'button';
                        fbBtn.style.cssText = 'margin-left: auto; background: linear-gradient(135deg, rgba(56, 189, 248, 0.16), rgba(37, 99, 235, 0.22)); border: 1px solid rgba(56, 189, 248, 0.45); color: #38bdf8; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; cursor: pointer;';
                        fbBtn.innerHTML = '<i class="fa-solid fa-store"></i> <span>预设工坊市场</span>';
                        fbBtn.onclick = (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            openMarketModal();
                        };
                        titleEl.appendChild(fbBtn);
                    }
                }
            }
        };

        setInterval(check, 1000);
        check();
    }

    // ── 全局 ESC 键关闭任意活动弹窗 (依照反向层级递进退出) ──
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' || e.keyCode === 27) {
            // 先尝试关闭最顶层子弹窗或 Lightbox
            const subOverlays = [
                document.getElementById('rbq-pm-zoom-overlay'),
                document.getElementById('rbq-pm-lightbox'),
                document.getElementById('rbq-pm-edit-dialog'),
                document.getElementById('rbq-pm-test-edit-dialog'),
                document.getElementById('rbq-pm-settings-dialog'),
                document.getElementById('rbq-pm-upload-dialog'),
                document.getElementById('rbq-pm-test-dialog'),
                document.getElementById('rbq-pm-live-test-dialog'),
                document.getElementById('rbq-pm-detail-dialog')
            ];
            for (const sub of subOverlays) {
                if (sub && sub.parentNode) {
                    closeSubDialog(sub);
                    return;
                }
            }
            // 若无子弹窗且工坊主弹窗处于打开状态，则关闭工坊
            if (marketModal && !marketModal.classList.contains('rbq-pm-hidden') && marketModal.style.display !== 'none') {
                closeMarketModal();
            }
        }
    });

    if (RBQ && RBQ.api) {
        RBQ.api.openMarketModal = openMarketModal;
        RBQ.api.closeMarketModal = closeMarketModal;
    }

    injectMarketEntry();
    console.info('🏛️ RBQ Prompt Market (提示词预设工坊) v1.1.33 插件已加载');
})(window.RBQ, window.jQuery, window.toastr);
