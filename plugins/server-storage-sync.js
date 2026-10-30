/**
 * RBQ-Draw-Plugins: 服务端图库同步与存储管理 (Gallery Sync & Storage Manager)
 * 插件 ID: rbq-gallery-sync
 * 功能：
 * 1. 双轨省流云同步：生成图片后客户端后台静默生成 ~60KB WebP 预览图并上传至酒馆服务端，实现多端秒开且 98% 省流；
 * 2. 收藏自动原画上传：点击「⭐ 收藏」时自动提取无损原画上传至服务端持久化保存；
 * 3. 大图查看器存储状态指示点 (Storage Dot Badge)：微型圆点标注图片存储归属（本地浏览器/酒馆服务端/绘图后端/省流预览），点击弹出响应式详情卡片；
 * 4. 存储详情与一键操作浮窗：查看真实物理路径、尺寸与大小，支持「上传原图到服务端」、「复制路径」；
 * 5. 网络自适应保护：检测到移动蜂窝数据 (Save-Data) 时自动阻断高清原图加载，杜绝流量偷跑。
 */
(function (RBQ, $, toastr) {
    if (!RBQ) return console.error('[Gallery Sync] RBQ Core API missing');

    const PLUGIN_ID = 'rbq-gallery-sync';
    const PLUGIN_NAME = '服务端图库同步与存储管理';
    const PLUGIN_VERSION = '1.1.20';
    const STORAGE_KEY = '_gallerySyncSettings';

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
                console.warn(`[${PLUGIN_NAME}] navigator.clipboard.writeText 失败，尝试降级:`, err);
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
            console.warn(`[${PLUGIN_NAME}] execCommand 复制降级失败:`, fallbackErr);
        }
        return false;
    };

    const DEFAULT_SETTINGS = {
        enabled: true,
        syncMode: 'stream_only', // 'local' | 'stream_only' | 'full'
        syncFavoritesOriginal: true, // ⭐ 收藏时自动上传高清原画至服务端
        previewQuality: 0.8,
        previewMaxDimension: 768,
        saveDataAware: true,
        enableViewerBadge: true,
        enableSyncToast: false,
    };

    // ── 1. Settings & Store ──
    function getStore() {
        const s = RBQ.api.getSettings();
        if (!s[STORAGE_KEY]) s[STORAGE_KEY] = { ...DEFAULT_SETTINGS };
        const store = s[STORAGE_KEY];
        for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
            if (store[k] === undefined) store[k] = v;
        }
        return store;
    }

    function save() {
        RBQ.api.saveSettings();
    }

    // ── 2. Helpers: Network & Compression ──
    function isCellularOrSaveData() {
        try {
            const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            if (!conn) return false;
            if (conn.saveData) return true;
            if (conn.type === 'cellular' || conn.effectiveType === '2g' || conn.effectiveType === '3g') return true;
        } catch (_e) {}
        return false;
    }

    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const b64 = reader.result;
                if (typeof b64 === 'string') {
                    const commaIdx = b64.indexOf(',');
                    resolve(commaIdx >= 0 ? b64.slice(commaIdx + 1) : b64);
                } else {
                    reject(new Error('转换 Base64 失败'));
                }
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    async function createOptimizedWebpBlob(imageSource, maxDimension = 768, quality = 0.8) {
        let bitmap = null;
        if (imageSource instanceof Blob) {
            try {
                bitmap = await createImageBitmap(imageSource);
            } catch (_e) {
                // Fallback to Image element
                const url = URL.createObjectURL(imageSource);
                bitmap = await new Promise((res, rej) => {
                    const img = new Image();
                    img.onload = () => res(img);
                    img.onerror = rej;
                    img.src = url;
                });
            }
        } else if (imageSource instanceof HTMLImageElement) {
            bitmap = imageSource;
        }

        if (!bitmap) return null;
        const width = bitmap.width || bitmap.naturalWidth || 0;
        const height = bitmap.height || bitmap.naturalHeight || 0;
        if (!width || !height) return null;

        const scale = Math.min(1, maxDimension / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));

        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

        if (typeof bitmap.close === 'function') bitmap.close();

        return new Promise((resolve) => {
            canvas.toBlob((blob) => resolve(blob), 'image/webp', quality);
        });
    }

    // ── 3. Server Upload Pipeline ──
    async function uploadBlobToServer(blob, filename = 'rbq_preview.webp') {
        if (!(blob instanceof Blob) || !blob.size) throw new Error('无效的图片 Blob');

        let safeName = String(filename || 'rbq_preview.webp')
            .replace(/[^a-zA-Z0-9_\-.]/g, '_')
            .replace(/^\.+/, 'img_');
        if (!safeName.includes('.')) safeName += '.webp';

        const rawBase64 = await blobToBase64(blob);
        if (!rawBase64) throw new Error('无法将图片转换为 Base64 编码');

        const payload = JSON.stringify({ name: safeName, data: rawBase64 });
        let lastError = null;

        // 尝试 1: 通过 jQuery.ajax 发送 (SillyTavern 全局预置 $.ajaxPrefilter 会自动注入 X-CSRF-Token)
        const jq = $ || window.jQuery || window.$;
        if (jq && typeof jq.ajax === 'function') {
            try {
                const path = await new Promise((resolve, reject) => {
                    jq.ajax({
                        url: '/api/files/upload',
                        type: 'POST',
                        contentType: 'application/json',
                        data: payload,
                        dataType: 'json',
                        success: (resp) => {
                            let resPath = resp?.path || resp?.url || resp?.filepath;
                            if (resPath) {
                                if (!resPath.startsWith('/') && !resPath.startsWith('http://') && !resPath.startsWith('https://')) {
                                    resPath = '/' + resPath;
                                }
                                resolve(resPath);
                            } else {
                                reject(new Error('服务端上传接口未返回有效文件路径: ' + JSON.stringify(resp)));
                            }
                        },
                        error: (xhr, status, error) => {
                            reject(new Error(`jQuery上传接口失败 (${xhr.status}): ${xhr.responseText || error || status}`));
                        }
                    });
                });
                if (path) return path;
            } catch (err) {
                lastError = err;
                console.warn(`[${PLUGIN_NAME}] jQuery ajax 上传未成功，尝试 Fetch 兜底:`, err);
            }
        }

        // 尝试 2: 通过 fetch 发送 (注入 RBQ.api.getStRequestHeaders / getRequestHeaders CSRF 鉴权头)
        try {
            let headers = { 'Content-Type': 'application/json' };
            const getHeaders = RBQ?.api?.getStRequestHeaders || RBQ?.api?.getRequestHeaders;
            if (typeof getHeaders === 'function') {
                try {
                    const stHeaders = getHeaders();
                    if (stHeaders && typeof stHeaders === 'object') {
                        headers = { ...headers, ...stHeaders };
                    }
                } catch (_e) {}
            }

            const res = await fetch('/api/files/upload', {
                method: 'POST',
                headers,
                body: payload,
            });

            if (!res.ok) {
                const errText = await res.text().catch(() => '');
                throw new Error(`Fetch上传失败 (${res.status}): ${errText || res.statusText}`);
            }

            const data = await res.json();
            let resPath = data?.path || data?.url || data?.filepath;
            if (resPath) {
                if (!resPath.startsWith('/') && !resPath.startsWith('http://') && !resPath.startsWith('https://')) {
                    resPath = '/' + resPath;
                }
                return resPath;
            }
            throw new Error('Fetch上传返回缺少文件路径: ' + JSON.stringify(data));
        } catch (fetchErr) {
            lastError = fetchErr;
            console.warn(`[${PLUGIN_NAME}] Fetch 上传失败:`, fetchErr);
        }

        throw new Error(lastError ? lastError.message : '未找到可用的酒馆服务端图片上传接口 (/api/files/upload)');
    }

    // ── 4. Image Storage Inspector ──
    async function inspectImageStorage(item) {
        if (!item) return { type: 'unknown', text: '未知', title: '未知存储位置', color: '#94a3b8', details: {} };

        const url = String(item.displayUrl || item.url || '');
        const serverUrl = String(item.serverUrl || '');
        const serverPreviewUrl = String(item.serverPreviewUrl || '');
        const serverOriginalUrl = String(item.serverOriginalUrl || '');
        const cacheId = item.cacheId || '';

        let inIndexedDb = false;
        let blobSize = 0;
        let blobType = '';

        if (cacheId && typeof RBQ?.api?.getCachedImageRecord === 'function') {
            try {
                const record = await RBQ.api.getCachedImageRecord(cacheId);
                if (record && record.blob instanceof Blob) {
                    inIndexedDb = true;
                    blobSize = record.blob.size;
                    blobType = record.blob.type;
                }
            } catch (_e) {}
        }

        // 1. 绘图后端直连 (ComfyUI / SD WebUI)
        const isBackendUrl = url.includes('/view?filename=') || url.includes(':8188') || url.includes(':7860');
        if (isBackendUrl || (item.mode === 'comfyui' && !serverUrl && !serverOriginalUrl && !serverPreviewUrl)) {
            return {
                type: 'backend',
                text: '绘图后端',
                title: '绘图工具输出目录 (ComfyUI / SD)',
                color: '#c084fc', // purple
                inIndexedDb,
                blobSize,
                blobType,
                path: url,
                hasLocalOriginal: inIndexedDb,
                hasServerOriginal: false,
                hasServerPreview: false,
                canSync: inIndexedDb || !!url,
                canUploadOriginal: true,
                canLoadServerOriginal: false,
                canMarkPending: false,
                localStatus: inIndexedDb ? `✅ 本地已缓存 (${formatBytes(blobSize)})` : '⚡ 后端实时渲染流',
                serverStatus: '⚪ 绘图后端临时目录',
                localColor: inIndexedDb ? '#4ade80' : '#c084fc',
                serverColor: '#94a3b8',
                serverUrl,
                serverOriginalUrl,
                serverPreviewUrl,
                cacheId,
            };
        }

        // 核心双维度研判:
        // 维度 1: 本地是不是原画
        // 本地持有 IndexedDB 无损 Blob，或持有着非 preview 的本地 blob/data URL
        const hasLocalOriginal = Boolean(
            (inIndexedDb && blobSize > 0) ||
            (url.startsWith('blob:') && !url.includes('_preview.webp')) ||
            (url.startsWith('data:') && !url.includes('_preview.webp'))
        );

        // 维度 2: 云端有没有原画
        const hasServerOriginal = Boolean(
            serverOriginalUrl ||
            (serverUrl && !serverUrl.includes('_preview.webp'))
        );
        const effectiveServerOriginal = serverOriginalUrl || (serverUrl && !serverUrl.includes('_preview.webp') ? serverUrl : '');

        // 维度 3: 云端有没有轻量预览图
        const hasServerPreview = Boolean(
            serverPreviewUrl ||
            (serverUrl && serverUrl.includes('_preview.webp')) ||
            url.includes('_preview.webp')
        );
        const effectiveServerPreview = serverPreviewUrl || (serverUrl && serverUrl.includes('_preview.webp') ? serverUrl : (url.includes('_preview.webp') ? url : ''));

        // 维度 4: 当前视口正在展示的是不是原画
        const isOriginalLoadedInViewer = Boolean(
            item._originalLoaded ||
            hasLocalOriginal ||
            (hasServerOriginal && url === effectiveServerOriginal)
        );

        // ── 组合 A: 本地有原画 + 云端有原画 (双端原画已入库) ──
        if (hasLocalOriginal && hasServerOriginal) {
            return {
                type: 'both_original',
                text: '双端原画已入库',
                title: '本地浏览器与酒馆服务端均已完整保存无损原画',
                color: '#38bdf8', // sky blue
                inIndexedDb,
                blobSize,
                blobType,
                path: effectiveServerOriginal,
                hasLocalOriginal: true,
                hasServerOriginal: true,
                hasServerPreview,
                canSync: false,
                canUploadOriginal: false,
                canLoadServerOriginal: false,
                canMarkPending: false,
                localStatus: `✅ 完整无损原画 (${blobSize ? formatBytes(blobSize) : '本地已存'})`,
                serverStatus: '✅ 无损原画已持久化入库',
                localColor: '#38bdf8',
                serverColor: '#38bdf8',
                serverUrl: effectiveServerOriginal,
                serverOriginalUrl: effectiveServerOriginal,
                serverPreviewUrl: effectiveServerPreview,
                cacheId,
            };
        }

        // ── 组合 B: 本地有原画 + 云端无原画 (本地生成设备最常见场景) ──
        if (hasLocalOriginal && !hasServerOriginal) {
            return {
                type: 'local_original',
                text: hasServerPreview ? '本地原画 · 云端仅预览' : '仅保存在本地',
                title: hasServerPreview
                    ? '当前设备持有无损高清原画；云端已生成轻量预览图供多端秒开，可一键上传原画'
                    : '图片仅存储在当前设备本地缓存中，尚未同步至酒馆服务器',
                color: '#22c55e', // emerald green
                inIndexedDb,
                blobSize,
                blobType,
                path: effectiveServerPreview || `IndexedDB: ${cacheId || 'local_blob'}`,
                hasLocalOriginal: true,
                hasServerOriginal: false,
                hasServerPreview,
                canSync: true,
                canUploadOriginal: true,
                canLoadServerOriginal: false,
                canMarkPending: false,
                localStatus: `✅ 完整无损原画 (${blobSize ? formatBytes(blobSize) : '本地已存'})`,
                serverStatus: hasServerPreview ? '🟡 仅轻量预览图 (~60 KB 省流中)' : '⚪ 未同步到酒馆服务器',
                localColor: '#22c55e',
                serverColor: hasServerPreview ? '#facc15' : '#94a3b8',
                serverUrl: effectiveServerPreview,
                serverOriginalUrl: '',
                serverPreviewUrl: effectiveServerPreview,
                cacheId,
            };
        }

        // ── 组合 C: 本地无原画 + 云端有原画 (非生成端或清空本地缓存后，云端已入库) ──
        if (!hasLocalOriginal && hasServerOriginal) {
            if (isOriginalLoadedInViewer) {
                return {
                    type: 'server_original_loaded',
                    text: '已载入云端原画',
                    title: '当前视口已成功载入酒馆服务器存储的完整无损原画',
                    color: '#38bdf8', // sky blue
                    inIndexedDb,
                    blobSize,
                    blobType,
                    path: effectiveServerOriginal,
                    hasLocalOriginal: false,
                    hasServerOriginal: true,
                    hasServerPreview,
                    canSync: false,
                    canUploadOriginal: false,
                    canLoadServerOriginal: false,
                    canMarkPending: false,
                    localStatus: '✅ 当前已载入云端无损原画',
                    serverStatus: '✅ 无损原画已持久化入库',
                    localColor: '#38bdf8',
                    serverColor: '#38bdf8',
                    serverUrl: effectiveServerOriginal,
                    serverOriginalUrl: effectiveServerOriginal,
                    serverPreviewUrl: effectiveServerPreview,
                    cacheId,
                };
            }
            return {
                type: 'server_original_previewing',
                text: '本地预览 · 云端有原画',
                title: '当前展示轻量预览图 (~60KB 省流中)；云端已有高清原画，点击可一键加载',
                color: '#facc15', // amber
                inIndexedDb,
                blobSize,
                blobType,
                path: effectiveServerPreview || effectiveServerOriginal,
                hasLocalOriginal: false,
                hasServerOriginal: true,
                hasServerPreview,
                canSync: false,
                canUploadOriginal: false,
                canLoadServerOriginal: true,
                canMarkPending: false,
                localStatus: '⚠️ 当前展示轻量预览图 (~60 KB)',
                serverStatus: '✅ 无损原画已入库',
                localColor: '#facc15',
                serverColor: '#38bdf8',
                serverUrl: effectiveServerOriginal,
                serverOriginalUrl: effectiveServerOriginal,
                serverPreviewUrl: effectiveServerPreview,
                cacheId,
            };
        }

        // ── 组合 D: 本地无原画 + 云端无原画 / 仅有预览 (多端同步中，生成设备尚未补传原画) ──
        if (hasServerPreview || item.pendingOriginalUpload) {
            const isPending = Boolean(item.pendingOriginalUpload);
            return {
                type: 'preview_only',
                text: isPending ? '待生成端补传' : '仅有轻量预览',
                title: isPending
                    ? '⭐ 已加入收藏：无损原画将在切回生成设备时自动上传入库'
                    : '当前仅有轻量预览图 (~60KB)；无损原画保留在原生成设备的本地缓存中',
                color: isPending ? '#fb923c' : '#f59e0b', // orange / amber
                inIndexedDb,
                blobSize,
                blobType,
                path: effectiveServerPreview || url,
                hasLocalOriginal: false,
                hasServerOriginal: false,
                hasServerPreview: true,
                canSync: false,
                canUploadOriginal: false,
                canLoadServerOriginal: false,
                canMarkPending: !isPending,
                isPending,
                localStatus: '⚠️ 本机无原画 (仅从云端加载了预览图)',
                serverStatus: isPending
                    ? '⭐ 待补传 (切回原生成设备时自动上传)'
                    : '🟡 仅轻量预览图 (云端暂无原画)',
                localColor: '#fb923c',
                serverColor: isPending ? '#fb923c' : '#f59e0b',
                serverUrl: effectiveServerPreview,
                serverOriginalUrl: '',
                serverPreviewUrl: effectiveServerPreview,
                cacheId,
            };
        }

        // 外部链接或未知
        return {
            type: 'external',
            text: '外部链接',
            title: '外部网络资源',
            color: '#a855f7',
            inIndexedDb,
            blobSize,
            blobType,
            path: url,
            hasLocalOriginal: false,
            hasServerOriginal: false,
            hasServerPreview: false,
            canSync: inIndexedDb || !!url,
            canUploadOriginal: inIndexedDb || !!url,
            canLoadServerOriginal: false,
            canMarkPending: false,
            localStatus: '外部链接资源',
            serverStatus: '⚪ 未同步到酒馆服务器',
            localColor: '#a855f7',
            serverColor: '#94a3b8',
            serverUrl,
            serverOriginalUrl,
            serverPreviewUrl,
            cacheId,
        };
    }

    // ── 5. Universal Sync Application to All Records ──
    async function applySyncedPathToAllRecords(item, path, isOriginal = false) {
        if (!item || !path) return;

        if (isOriginal) {
            item.serverOriginalUrl = path;
            delete item.pendingOriginalUpload;
            item.serverUrl = path;
            if (!item.url || item.url.includes('_preview.webp')) {
                item.url = path;
            }
        } else {
            item.serverPreviewUrl = path;
            if (!item.serverUrl || item.serverUrl.includes('_preview.webp')) {
                item.serverUrl = path;
            }
            if (!item.url) {
                item.url = path;
            }
        }

        // 1. 同步到会话消息 extra (跨设备多端秒级同步的核心路径)
        const ctx = RBQ?.api?.getContext?.();
        let targetMsgId = (item.messageId != null && Number.isFinite(Number(item.messageId))) ? Number(item.messageId) : null;
        if (targetMsgId == null && Array.isArray(ctx?.chat)) {
            // 自动智能回填 messageId：从后向前查找
            for (let i = ctx.chat.length - 1; i >= 0; i--) {
                const m = ctx.chat[i];
                if (!m) continue;
                if (m.extra?.rbq_image?.cacheId === item.cacheId ||
                    (Array.isArray(m.extra?.rbq_images) && m.extra.rbq_images.some(img => img?.cacheId === item.cacheId))) {
                    targetMsgId = i;
                    break;
                }
                if (item.prompt && m.mes && m.mes.includes(item.prompt)) {
                    targetMsgId = i;
                    break;
                }
            }
            if (targetMsgId == null) {
                for (let i = ctx.chat.length - 1; i >= 0; i--) {
                    if (!ctx.chat[i]?.is_user) {
                        targetMsgId = i;
                        break;
                    }
                }
            }
        }

        if (targetMsgId != null && ctx?.chat?.[targetMsgId]) {
            const msg = ctx.chat[targetMsgId];
            if (!msg.extra) msg.extra = {};
            if (!msg.extra.rbq_image) {
                msg.extra.rbq_image = { prompt: item.prompt || '', cacheId: item.cacheId || '' };
            }
            if (isOriginal) {
                msg.extra.rbq_image.serverOriginalUrl = path;
                delete msg.extra.rbq_image.pendingOriginalUpload;
                msg.extra.rbq_image.serverUrl = path;
                if (!msg.extra.rbq_image.url || msg.extra.rbq_image.url.includes('_preview.webp')) {
                    msg.extra.rbq_image.url = path;
                }
            } else {
                msg.extra.rbq_image.serverPreviewUrl = path;
                if (!msg.extra.rbq_image.serverUrl || msg.extra.rbq_image.serverUrl.includes('_preview.webp')) {
                    msg.extra.rbq_image.serverUrl = path;
                }
                if (!msg.extra.rbq_image.url) msg.extra.rbq_image.url = path;
            }

            if (Array.isArray(msg.extra.rbq_images)) {
                for (const img of msg.extra.rbq_images) {
                    if (!img) continue;
                    if ((item.cacheId && img.cacheId === item.cacheId) ||
                        (!item.cacheId && item.prompt && img.prompt === item.prompt)) {
                        if (isOriginal) {
                            img.serverOriginalUrl = path;
                            delete img.pendingOriginalUpload;
                            img.serverUrl = path;
                            if (!img.url || img.url.includes('_preview.webp')) img.url = path;
                        } else {
                            img.serverPreviewUrl = path;
                            if (!img.serverUrl || img.serverUrl.includes('_preview.webp')) img.serverUrl = path;
                            if (!img.url) img.url = path;
                        }
                    }
                }
            }

            // 同步穿透到 SDT 扩展的分镜状态中 (保证跨设备多端在正文卡片中秒开)
            if (msg.extra.rbq_sdt?.segmentStates && typeof msg.extra.rbq_sdt.segmentStates === 'object') {
                for (const segKey of Object.keys(msg.extra.rbq_sdt.segmentStates)) {
                    const st = msg.extra.rbq_sdt.segmentStates[segKey];
                    if (st?.imageResult) {
                        if ((item.cacheId && st.imageResult.cacheId === item.cacheId) ||
                            (!item.cacheId && item.prompt && st.imageResult.prompt === item.prompt)) {
                            if (isOriginal) {
                                st.imageResult.serverOriginalUrl = path;
                                delete st.imageResult.pendingOriginalUpload;
                                st.imageResult.serverUrl = path;
                                if (!st.imageResult.url || st.imageResult.url.includes('_preview.webp')) {
                                    st.imageResult.url = path;
                                }
                            } else {
                                st.imageResult.serverPreviewUrl = path;
                                if (!st.imageResult.serverUrl || st.imageResult.serverUrl.includes('_preview.webp')) {
                                    st.imageResult.serverUrl = path;
                                }
                                if (!st.imageResult.url) st.imageResult.url = path;
                            }
                        }
                    }
                }
            }

            // 立即存盘聊天数据至服务端（确保其他设备秒级可见）
            if (typeof RBQ?.api?.saveChat === 'function') RBQ.api.saveChat();
            else if (typeof RBQ?.api?.saveChatDebounced === 'function') RBQ.api.saveChatDebounced();

            // 实时将已同步图片渲染到当前页面正文卡片中（仅更新与当前 item 匹配的卡片，严禁误伤其他分镜或重新解析卡片）
            try {
                const targetCards = document.querySelectorAll(`.st-scene-trigger-inline-wrap[data-message-id="${targetMsgId}"]`);
                targetCards.forEach(card => {
                    if (!(card instanceof HTMLElement)) return;
                    // 1. 严格跳过非出图卡片（如重新解析/刷新 tag 按钮）
                    if (card.dataset.rbqSdtIsResult === '0' || card.dataset.rbqSdtKey?.endsWith('-reparse') || card.classList.contains('rbq-sdt-reparse')) {
                        return;
                    }
                    // 2. 检查此卡片是否与当前 item 匹配
                    const cardPrompt = String(card.dataset.rbqSdtFinalPrompt || card.dataset.prompt || '').trim().toLowerCase();
                    const itemPrompt = String(item.prompt || '').trim().toLowerCase();
                    const link = card.querySelector('.st-scene-trigger-inline-image-link');
                    const cardCacheId = link?.dataset?.cacheId || card.dataset.cacheId;
                    const cardUrl = link?.dataset?.url || card.dataset.url;

                    let isMatch = false;
                    if (item.cacheId && cardCacheId && item.cacheId === cardCacheId) {
                        isMatch = true;
                    } else if (item.url && cardUrl && (item.url === cardUrl || path === cardUrl)) {
                        isMatch = true;
                    } else if (itemPrompt && cardPrompt && (itemPrompt === cardPrompt || itemPrompt.includes(cardPrompt) || cardPrompt.includes(itemPrompt))) {
                        isMatch = true;
                    } else if (!itemPrompt && !cardPrompt) {
                        isMatch = true;
                    }

                    if (isMatch && typeof RBQ?.api?.renderInlineGeneratedImage === 'function') {
                        // 保护已在卡片展示的本地原画：
                        const existingMedia = card.querySelector('.st-scene-trigger-inline-image') || card.querySelector('img, video');
                        const isShowingOriginal = existingMedia && (
                            existingMedia.tagName === 'VIDEO'
                                ? (existingMedia.readyState >= 1 && !existingMedia.src.includes('_preview.webp'))
                                : (existingMedia.complete && existingMedia.naturalWidth > 0 && !existingMedia.src.includes('_preview.webp'))
                        );
                        if (!isShowingOriginal || isOriginal) {
                            const renderUrl = isOriginal ? path : (item.url || path);
                            RBQ.api.renderInlineGeneratedImage(card, {
                                ...item,
                                url: renderUrl,
                                serverUrl: path,
                                serverOriginalUrl: isOriginal ? path : item.serverOriginalUrl,
                                serverPreviewUrl: item.serverPreviewUrl || (!isOriginal ? path : undefined)
                            });
                        } else {
                            // 卡片已在展示本地高清原画，仅静默记录 dataset，绝不触发 DOM 降级重绘与跳动
                            const link = card.querySelector('.st-scene-trigger-inline-image-link');
                            if (link) {
                                link.dataset.serverPreviewUrl = path;
                                if (isOriginal) link.dataset.serverOriginalUrl = path;
                            }
                            card.dataset.serverPreviewUrl = path;
                        }
                        if (card.classList.contains('rbq-sdt-card')) {
                            card.dataset.rbqSdtStage = 'generated';
                        }
                    }
                });
            } catch (_) {}
        }

        // 2. 同步到全局 settings.history
        const settings = RBQ?.api?.getSettings?.();
        if (Array.isArray(settings?.history)) {
            const matched = settings.history.find(h =>
                (item.cacheId && h.cacheId === item.cacheId) ||
                (item.url && h.url === item.url) ||
                (item.prompt && h.prompt === item.prompt && Math.abs((h.createdAt || 0) - (item.createdAt || 0)) < 15000)
            );
            if (matched) {
                if (isOriginal) {
                    matched.serverOriginalUrl = path;
                    delete matched.pendingOriginalUpload;
                    matched.serverUrl = path;
                    if (!matched.url || matched.url.includes('_preview.webp')) {
                        matched.url = path;
                    }
                } else {
                    matched.serverPreviewUrl = path;
                    if (!matched.serverUrl || matched.serverUrl.includes('_preview.webp')) {
                        matched.serverUrl = path;
                    }
                    if (!matched.url) matched.url = path;
                }
                RBQ.api.saveSettings?.();
            }
        }

        // 3. 实时刷新正在打开的大图查看器与微型状态指示点
        if (currentViewerItem && (currentViewerItem === item || (item.cacheId && currentViewerItem.cacheId === item.cacheId))) {
            if (isOriginal) {
                currentViewerItem.serverOriginalUrl = path;
                delete currentViewerItem.pendingOriginalUpload;
                currentViewerItem.serverUrl = path;
                if (!currentViewerItem.url || currentViewerItem.url.includes('_preview.webp')) {
                    currentViewerItem.url = path;
                }
            } else {
                currentViewerItem.serverPreviewUrl = path;
                if (!currentViewerItem.serverUrl || currentViewerItem.serverUrl.includes('_preview.webp')) {
                    currentViewerItem.serverUrl = path;
                }
                if (!currentViewerItem.url) currentViewerItem.url = path;
            }
            const modal = document.getElementById('st-scene-trigger-image-viewer');
            if (modal) {
                await updateViewerBadge({ modal, current: currentViewerItem });
            }
        }
    }

    // ── 6. Background Auto-Sync Engine ──
    async function triggerAutoSync(item) {
        const store = getStore();
        if (!store.enabled || store.syncMode === 'local') return;
        if (!item) return;

        // 避免重复同步
        if (item.serverOriginalUrl) return;
        if (store.syncMode === 'stream_only' && item.serverPreviewUrl) return;
        if (store.syncMode === 'full' && item.serverUrl && !item.serverUrl.includes('_preview.webp')) return;

        if (item._isSyncing) return;
        item._isSyncing = true;

        // 120ms 防抖，确保 IndexedDB 缓存和 DOM 渲染完毕
        setTimeout(async () => {
            try {
                // 检索图片原始 Blob（带重试机制，确保异步缓存入库）
                let originalBlob = null;
                for (let attempt = 0; attempt < 6; attempt++) {
                    if (item.cacheId && typeof RBQ?.api?.getCachedImageRecord === 'function') {
                        const rec = await RBQ.api.getCachedImageRecord(item.cacheId);
                        if (rec?.blob instanceof Blob) {
                            originalBlob = rec.blob;
                            break;
                        }
                    }
                    if (item.displayUrl && !item.displayUrl.startsWith('data:')) {
                        try {
                            const res = await fetch(item.displayUrl);
                            if (res.ok) { originalBlob = await res.blob(); break; }
                        } catch (_) {}
                    }
                    if (item.url && !item.url.startsWith('data:')) {
                        try {
                            const res = await fetch(item.url);
                            if (res.ok) { originalBlob = await res.blob(); break; }
                        } catch (_) {}
                    }
                    await new Promise((r) => setTimeout(r, 400));
                }

                if (!originalBlob) {
                    console.warn(`[${PLUGIN_NAME}] 自动同步未能获取到图片二进制数据，跳过自动上传`);
                    return;
                }

                const now = Date.now();
                const mode = item.mode || 'rbq';

                if (store.syncMode === 'full') {
                    // 全量原图上传
                    let ext = 'png';
                    if (originalBlob.type === 'image/jpeg' || originalBlob.type === 'image/jpg') ext = 'jpg';
                    else if (originalBlob.type === 'image/webp') ext = 'webp';

                    const filename = `rbq_${mode}_${now}.${ext}`;
                    const uploadedPath = await uploadBlobToServer(originalBlob, filename);
                    if (uploadedPath) {
                        await applySyncedPathToAllRecords(item, uploadedPath, true);
                        console.info(`[${PLUGIN_NAME}] ✅ 原画已自动同步至服务端: ${uploadedPath} (${formatBytes(originalBlob.size)})`);
                    }

                    // 双轨保障：同时上传轻量预览图，保证多端正文秒开与省流
                    if (!item.serverPreviewUrl) {
                        const previewFilename = `rbq_${mode}_${now}_preview.webp`;
                        const previewBlob = await createOptimizedWebpBlob(
                            originalBlob,
                            store.previewMaxDimension || 768,
                            store.previewQuality || 0.8
                        );
                        if (previewBlob) {
                            const previewPath = await uploadBlobToServer(previewBlob, previewFilename);
                            if (previewPath) {
                                await applySyncedPathToAllRecords(item, previewPath, false);
                                console.info(`[${PLUGIN_NAME}] ✅ 轻量预览图已自动同步至服务端: ${previewPath} (${formatBytes(previewBlob.size)})`);
                            }
                        }
                    }

                    if (store.enableSyncToast) {
                        toastr.info(`生图原画已同步至酒馆云端 (${formatBytes(originalBlob.size)})`, PLUGIN_NAME);
                    }
                } else {
                    // 默认 stream_only: 压制 50~80KB 极轻预览图
                    const previewFilename = `rbq_${mode}_${now}_preview.webp`;
                    const previewBlob = await createOptimizedWebpBlob(
                        originalBlob,
                        store.previewMaxDimension || 768,
                        store.previewQuality || 0.8
                    );

                    if (previewBlob) {
                        const uploadedPath = await uploadBlobToServer(previewBlob, previewFilename);
                        if (uploadedPath) {
                            await applySyncedPathToAllRecords(item, uploadedPath, false);
                            console.info(`[${PLUGIN_NAME}] ✅ 轻量预览图已自动同步至服务端: ${uploadedPath} (${formatBytes(previewBlob.size)})`);
                            if (store.enableSyncToast) {
                                toastr.info(`生图已同步至酒馆云端 (${formatBytes(previewBlob.size)})`, PLUGIN_NAME);
                            }
                        }
                    }
                }
            } catch (err) {
                console.warn(`[${PLUGIN_NAME}] 自动同步处理异常:`, err);
            } finally {
                delete item._isSyncing;
            }
        }, 120);
    }

    // 监听生图事件 (即时生图 / 异步缓存完成)
    window.addEventListener('st-scene-trigger:image-generated', (event) => {
        triggerAutoSync(event?.detail?.item);
    });
    window.addEventListener('st-scene-trigger:image-cached', (event) => {
        triggerAutoSync(event?.detail?.item);
    });

    // ── 7. Favorite Auto-Upload Original Handler ──
    async function syncFavoriteOriginal(item) {
        const store = getStore();
        if (!store.enabled || !store.syncFavoritesOriginal) return;
        if (!item) return;

        // 如果已经是服务端原图，无需重复上传
        if (item.serverOriginalUrl) return;
        if (item.serverUrl && !item.serverUrl.includes('_preview.webp')) return;

        try {
            let originalBlob = null;
            if (item.cacheId && typeof RBQ?.api?.getCachedImageRecord === 'function') {
                const rec = await RBQ.api.getCachedImageRecord(item.cacheId);
                if (rec?.blob instanceof Blob) originalBlob = rec.blob;
            }

            // 严禁将远程 _preview.webp 作为原图拉取；必须确保是真实的本地无损原始缓存
            if (!originalBlob && item.url && item.url.startsWith('blob:')) {
                try {
                    const res = await fetch(item.url);
                    if (res.ok) originalBlob = await res.blob();
                } catch (_e) {}
            }
            if (!originalBlob && item.displayUrl && item.displayUrl.startsWith('blob:')) {
                try {
                    const res = await fetch(item.displayUrl);
                    if (res.ok) originalBlob = await res.blob();
                } catch (_e) {}
            }

            if (!originalBlob) {
                console.info(`[${PLUGIN_NAME}] 当前设备无本地无损原画缓存，已标记为待同步，将在切回生成设备时自动上传入库 ⭐`);
                item.pendingOriginalUpload = true;
                item.favorite = true;
                await markPendingOriginalUpload(item);
                toastr.info('⭐ 已加入收藏！无损原画将在切回生成设备时自动同步入库', PLUGIN_NAME);
                return;
            }

            toastr.info('正在将收藏的高清原画同步至酒馆服务端...', PLUGIN_NAME);

            const mode = item.mode || 'rbq';
            const now = Date.now();
            let ext = 'png';
            if (originalBlob.type === 'image/jpeg' || originalBlob.type === 'image/jpg') ext = 'jpg';
            else if (originalBlob.type === 'image/webp') ext = 'webp';

            const filename = `rbq_${mode}_fav_${now}.${ext}`;
            const uploadedPath = await uploadBlobToServer(originalBlob, filename);

            if (uploadedPath) {
                delete item.pendingOriginalUpload;
                await applySyncedPathToAllRecords(item, uploadedPath, true);
                console.info(`[${PLUGIN_NAME}] ⭐ 收藏原画已成功同步至服务端: ${uploadedPath} (${formatBytes(originalBlob.size)})`);

                // 双轨保障：同时确保轻量预览图存在
                if (!item.serverPreviewUrl) {
                    const previewFilename = `rbq_${mode}_fav_${now}_preview.webp`;
                    const previewBlob = await createOptimizedWebpBlob(originalBlob, 768, 0.8);
                    if (previewBlob) {
                        const previewPath = await uploadBlobToServer(previewBlob, previewFilename);
                        if (previewPath) {
                            await applySyncedPathToAllRecords(item, previewPath, false);
                        }
                    }
                }

                toastr.success(`⭐ 收藏原画已持久化至酒馆服务端 (${formatBytes(originalBlob.size)})`, PLUGIN_NAME);
            }
        } catch (err) {
            console.error(`[${PLUGIN_NAME}] 收藏原画同步失败:`, err);
            toastr.error(`收藏原画同步失败: ${err.message || err}`, PLUGIN_NAME);
        }
    }

    // ── 7.1 跨设备待补传原图持久化与扫描同步 ──
    async function markPendingOriginalUpload(item) {
        if (!item) return;
        item.pendingOriginalUpload = true;
        item.favorite = true;

        const ctx = RBQ?.api?.getContext?.();
        let targetMsgId = (item.messageId != null && Number.isFinite(Number(item.messageId))) ? Number(item.messageId) : null;
        if (targetMsgId == null && Array.isArray(ctx?.chat)) {
            for (let i = ctx.chat.length - 1; i >= 0; i--) {
                const m = ctx.chat[i];
                if (!m) continue;
                if (m.extra?.rbq_image?.cacheId === item.cacheId ||
                    (Array.isArray(m.extra?.rbq_images) && m.extra.rbq_images.some(img => img?.cacheId === item.cacheId))) {
                    targetMsgId = i;
                    break;
                }
                if (item.prompt && m.mes && m.mes.includes(item.prompt)) {
                    targetMsgId = i;
                    break;
                }
            }
        }

        if (targetMsgId != null && ctx?.chat?.[targetMsgId]) {
            const msg = ctx.chat[targetMsgId];
            if (!msg.extra) msg.extra = {};
            if (!msg.extra.rbq_image) {
                msg.extra.rbq_image = { prompt: item.prompt || '', cacheId: item.cacheId || '' };
            }
            msg.extra.rbq_image.favorite = true;
            msg.extra.rbq_image.pendingOriginalUpload = true;

            if (Array.isArray(msg.extra.rbq_images)) {
                for (const img of msg.extra.rbq_images) {
                    if (img && ((item.cacheId && img.cacheId === item.cacheId) || (item.prompt && img.prompt === item.prompt))) {
                        img.favorite = true;
                        img.pendingOriginalUpload = true;
                    }
                }
            }

            if (typeof RBQ?.api?.saveChatDebounced === 'function') RBQ.api.saveChatDebounced();
            else if (typeof RBQ?.api?.saveChat === 'function') RBQ.api.saveChat();
        }

        const settings = RBQ?.api?.getSettings?.();
        if (Array.isArray(settings?.history)) {
            const matched = settings.history.find(h =>
                (item.cacheId && h.cacheId === item.cacheId) ||
                (item.url && h.url === item.url) ||
                (item.prompt && h.prompt === item.prompt && Math.abs((h.createdAt || 0) - (item.createdAt || 0)) < 15000)
            );
            if (matched) {
                matched.favorite = true;
                matched.pendingOriginalUpload = true;
                RBQ.api.saveSettings?.();
            }
        }
    }

    let isCheckingPending = false;
    async function syncPendingOriginalUploads() {
        const store = getStore();
        if (!store.enabled || !store.syncFavoritesOriginal) return;
        if (isCheckingPending) return;
        isCheckingPending = true;

        try {
            const settings = RBQ?.api?.getSettings?.();
            const history = Array.isArray(settings?.history) ? settings.history : [];
            const ctx = RBQ?.api?.getContext?.();
            const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];

            // 汇总所有被标记为收藏或待补传原图且服务端尚无原图的候选
            const pendingCandidates = [];
            const seenCacheIds = new Set();

            // 1. 扫描 settings.history
            for (const it of history) {
                if (!it || !it.cacheId || seenCacheIds.has(it.cacheId)) continue;
                if ((it.favorite || it.pendingOriginalUpload) && !it.serverOriginalUrl) {
                    seenCacheIds.add(it.cacheId);
                    pendingCandidates.push(it);
                }
            }

            // 2. 扫描当前聊天各楼层消息 extra
            for (let i = chat.length - 1; i >= 0; i--) {
                const msg = chat[i];
                if (!msg?.extra) continue;
                const list = [];
                if (msg.extra.rbq_image) list.push(msg.extra.rbq_image);
                if (Array.isArray(msg.extra.rbq_images)) list.push(...msg.extra.rbq_images);

                for (const img of list) {
                    if (!img || !img.cacheId || seenCacheIds.has(img.cacheId)) continue;
                    if ((img.favorite || img.pendingOriginalUpload) && !img.serverOriginalUrl) {
                        seenCacheIds.add(img.cacheId);
                        pendingCandidates.push({ ...img, messageId: i });
                    }
                }
            }

            if (!pendingCandidates.length) return;

            let uploadedCount = 0;
            for (const item of pendingCandidates) {
                if (typeof RBQ?.api?.getCachedImageRecord !== 'function') break;
                // 检测当前设备本地 IndexedDB 是否拥有原图物理缓存
                const rec = await RBQ.api.getCachedImageRecord(item.cacheId);
                if (!rec?.blob || !(rec.blob instanceof Blob)) {
                    continue; // 本机无此原图（说明是在其他设备生成的），跳过
                }

                const originalBlob = rec.blob;
                const mode = item.mode || 'rbq';
                const now = Date.now();
                let ext = 'png';
                if (originalBlob.type === 'image/jpeg' || originalBlob.type === 'image/jpg') ext = 'jpg';
                else if (originalBlob.type === 'image/webp') ext = 'webp';

                const filename = `rbq_${mode}_fav_${now}.${ext}`;
                const uploadedPath = await uploadBlobToServer(originalBlob, filename);

                if (uploadedPath) {
                    delete item.pendingOriginalUpload;
                    await applySyncedPathToAllRecords(item, uploadedPath, true);

                    // 双轨保障：同时确保轻量预览图存在
                    if (!item.serverPreviewUrl) {
                        const previewFilename = `rbq_${mode}_fav_${now}_preview.webp`;
                        const previewBlob = await createOptimizedWebpBlob(originalBlob, 768, 0.8);
                        if (previewBlob) {
                            const previewPath = await uploadBlobToServer(previewBlob, previewFilename);
                            if (previewPath) {
                                await applySyncedPathToAllRecords(item, previewPath, false);
                            }
                        }
                    }
                    uploadedCount++;
                }
            }

            if (uploadedCount > 0) {
                console.info(`[${PLUGIN_NAME}] ⭐ 已自动从本机上传 ${uploadedCount} 张在其他设备收藏的高清原画`);
                toastr.success(`⭐ 已自动将其他设备收藏的 ${uploadedCount} 张高清原画从本机同步至服务端！`, PLUGIN_NAME);
            }
        } catch (err) {
            console.warn(`[${PLUGIN_NAME}] 自动补传待处理收藏原图失败:`, err);
        } finally {
            isCheckingPending = false;
        }
    }

    // 监听收藏事件 (st-scene-trigger 主扩展分发)
    window.addEventListener('st-scene-trigger:favorite-toggled', (event) => {
        const item = event.detail?.item;
        const isFav = Boolean(event.detail?.favorite ?? event.detail?.isFavorite ?? item?.favorite);
        if (item && isFav) {
            syncFavoriteOriginal(item);
        }
    });

    // 跨端切回感知：窗口焦点/可见性/会话切换自动检测待补传的原图
    window.addEventListener('focus', () => setTimeout(syncPendingOriginalUploads, 350));
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) setTimeout(syncPendingOriginalUploads, 350);
    });
    if (RBQ?.api?.eventSource && RBQ?.api?.event_types) {
        const es = RBQ.api.eventSource;
        const et = RBQ.api.event_types;
        if (et.CHAT_CHANGED) es.on(et.CHAT_CHANGED, () => setTimeout(syncPendingOriginalUploads, 600));
    }
    window.addEventListener('st-scene-trigger:history-rendered', () => setTimeout(syncPendingOriginalUploads, 400));
    setTimeout(syncPendingOriginalUploads, 2500);

    // ── 7. Storage Badge & Popover in Image Viewer ──
    let currentViewerItem = null;

    function injectStyles() {
        if (document.getElementById('rbq-gallery-sync-style')) return;
        const style = document.createElement('style');
        style.id = 'rbq-gallery-sync-style';
        style.textContent = `
            .rbq-storage-badge-btn {
                position: relative !important;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                width: 38px !important;
                height: 38px !important;
                min-width: 38px !important;
                padding: 0 !important;
                margin: 0 !important;
                border-radius: 10px !important;
                background: rgba(18, 20, 30, 0.72) !important;
                backdrop-filter: blur(12px) !important;
                -webkit-backdrop-filter: blur(12px) !important;
                border: 1px solid rgba(255, 255, 255, 0.12) !important;
                color: #f1f5f9 !important;
                cursor: pointer !important;
                transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1) !important;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.24) !important;
                flex-shrink: 0 !important;
                touch-action: manipulation !important;
                -webkit-tap-highlight-color: transparent !important;
                pointer-events: auto !important;
                user-select: none !important;
                -webkit-user-select: none !important;
            }
            @media (max-width: 900px) {
                .rbq-storage-badge-btn {
                    width: 32px !important;
                    min-width: 32px !important;
                    height: 32px !important;
                    border-radius: 8px !important;
                }
            }
            .rbq-storage-badge-btn::before {
                content: '';
                position: absolute;
                top: 50%;
                left: 50%;
                width: 44px;
                height: 44px;
                transform: translate(-50%, -50%);
                pointer-events: auto;
            }
            .rbq-storage-badge-btn:hover {
                background: rgba(30, 34, 48, 0.9) !important;
                border-color: rgba(255, 255, 255, 0.25) !important;
                transform: translateY(-1px);
            }
            .rbq-storage-dot {
                width: 9px;
                height: 9px;
                border-radius: 50%;
                display: inline-block;
                flex-shrink: 0;
                box-shadow: 0 0 10px currentColor;
                pointer-events: none;
                transition: background-color 0.25s ease;
            }
            .rbq-storage-modal-overlay {
                position: fixed !important;
                top: 0 !important;
                left: 0 !important;
                right: 0 !important;
                bottom: 0 !important;
                width: 100% !important;
                width: 100vw !important;
                height: 100% !important;
                height: 100vh !important;
                height: 100dvh !important;
                inset: 0 !important;
                z-index: 2147483647 !important;
                background: rgba(0, 0, 0, 0.75) !important;
                display: flex !important;
                align-items: flex-start !important;
                justify-content: center !important;
                backdrop-filter: blur(8px) !important;
                -webkit-backdrop-filter: blur(8px) !important;
                padding: max(16px, env(safe-area-inset-top, 16px)) max(16px, env(safe-area-inset-right, 16px)) max(16px, env(safe-area-inset-bottom, 16px)) max(16px, env(safe-area-inset-left, 16px)) !important;
                box-sizing: border-box !important;
                overflow-y: auto !important;
                -webkit-overflow-scrolling: touch !important;
                animation: rbqStorageFadeIn 0.15s ease-out !important;
            }
            @keyframes rbqStorageFadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            .rbq-storage-modal-dialog {
                background: #161a29 !important;
                background: linear-gradient(180deg, #1e2438 0%, #141724 100%) !important;
                border: 1px solid rgba(255, 255, 255, 0.16) !important;
                border-radius: 16px !important;
                width: 100% !important;
                max-width: 440px !important;
                margin: auto !important;
                color: #e2e8f0 !important;
                box-shadow: 0 16px 48px rgba(0, 0, 0, 0.85) !important;
                display: flex !important;
                flex-direction: column !important;
                overflow: hidden !important;
                max-height: calc(min(100dvh, 100vh) - max(32px, env(safe-area-inset-top, 16px) * 2) - max(32px, env(safe-area-inset-bottom, 16px) * 2)) !important;
                pointer-events: auto !important;
                animation: rbqStorageScaleIn 0.18s cubic-bezier(0.16, 1, 0.3, 1) !important;
                box-sizing: border-box !important;
            }
            @keyframes rbqStorageScaleIn {
                from { opacity: 0; transform: scale(0.95); }
                to { opacity: 1; transform: scale(1); }
            }
            .rbq-storage-modal-header {
                padding: 12px 16px !important;
                border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
                display: flex !important;
                justify-content: space-between !important;
                align-items: center !important;
                background: rgba(255, 255, 255, 0.02) !important;
                flex-shrink: 0 !important;
            }
            .rbq-storage-modal-title {
                font-weight: 600 !important;
                font-size: 14px !important;
                color: #f8fafc !important;
                display: flex !important;
                align-items: center !important;
                gap: 8px !important;
            }
            .rbq-storage-modal-close {
                width: 32px !important;
                height: 32px !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                background: transparent !important;
                border: none !important;
                color: #94a3b8 !important;
                cursor: pointer !important;
                border-radius: 8px !important;
                font-size: 16px !important;
                transition: all 0.15s ease !important;
                padding: 0 !important;
            }
            .rbq-storage-modal-close:hover {
                background: rgba(255, 255, 255, 0.08) !important;
                color: #fff !important;
            }
            .rbq-storage-modal-body {
                padding: 16px !important;
                display: flex !important;
                flex-direction: column !important;
                gap: 12px !important;
                overflow-y: auto !important;
                -webkit-overflow-scrolling: touch !important;
                flex: 1 1 auto !important;
                min-height: 0 !important;
                box-sizing: border-box !important;
            }
            .rbq-storage-bottom-badge {
                font-size: 12px !important;
                background: rgba(255, 255, 255, 0.08) !important;
                color: #cbd5e1 !important;
                border: 1px solid rgba(255, 255, 255, 0.16) !important;
                border-radius: 20px !important;
                padding: 4px 12px !important;
                display: inline-flex !important;
                align-items: center !important;
                gap: 6px !important;
                cursor: pointer !important;
                white-space: nowrap !important;
                font-weight: 500 !important;
                flex-shrink: 0 !important;
                transition: all 0.16s ease !important;
            }
            .rbq-storage-bottom-badge:hover {
                background: rgba(255, 255, 255, 0.15) !important;
                color: #fff !important;
                border-color: rgba(255, 255, 255, 0.28) !important;
            }
            .rbq-storage-info-list {
                display: flex;
                flex-direction: column;
                gap: 8px;
                font-size: 12.5px;
            }
            .rbq-storage-info-row {
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: 10px;
                padding: 6px 10px;
                border-radius: 8px;
                background: rgba(255, 255, 255, 0.02);
                border: 1px solid rgba(255, 255, 255, 0.04);
            }
            .rbq-storage-info-label {
                color: #94a3b8;
                flex-shrink: 0;
            }
            .rbq-storage-info-val {
                color: #f1f5f9;
                font-weight: 500;
                text-align: right;
                word-break: break-all;
            }
            .rbq-storage-path-box {
                background: rgba(0, 0, 0, 0.35);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 8px;
                padding: 8px 10px;
                font-size: 11px;
                font-family: ui-monospace, monospace;
                color: #38bdf8;
                max-height: 60px;
                overflow-y: auto;
                word-break: break-all;
                user-select: text;
                -webkit-user-select: text;
            }
            .rbq-storage-actions {
                display: flex;
                flex-direction: column;
                gap: 8px;
                margin-top: 4px;
                border-top: 1px solid rgba(255, 255, 255, 0.08);
                padding-top: 12px;
            }
            .rbq-storage-action-btn {
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                gap: 8px !important;
                width: 100% !important;
                height: 36px !important;
                border-radius: 10px !important;
                font-size: 12.5px !important;
                font-weight: 600 !important;
                cursor: pointer !important;
                transition: all 0.16s ease !important;
                box-sizing: border-box !important;
            }
            .rbq-storage-btn-sync {
                background: linear-gradient(135deg, rgba(56, 189, 248, 0.18), rgba(99, 102, 241, 0.18)) !important;
                border: 1px solid rgba(56, 189, 248, 0.4) !important;
                color: #38bdf8 !important;
            }
            .rbq-storage-btn-sync:hover {
                background: linear-gradient(135deg, rgba(56, 189, 248, 0.28), rgba(99, 102, 241, 0.28)) !important;
                border-color: #38bdf8 !important;
                transform: translateY(-1px);
            }
            .rbq-storage-btn-copy {
                background: rgba(255, 255, 255, 0.06) !important;
                border: 1px solid rgba(255, 255, 255, 0.12) !important;
                color: #e2e8f0 !important;
            }
            .rbq-storage-btn-copy:hover {
                background: rgba(255, 255, 255, 0.12) !important;
                border-color: rgba(255, 255, 255, 0.2) !important;
            }

            /* ── 设置面板现代化样式 ── */
            .rbq-sync-subpanel {
                display: flex;
                flex-direction: column;
                gap: 14px;
                padding: 4px 0;
            }
            .rbq-sync-card {
                background: var(--linear-surface, rgba(22, 27, 46, 0.7));
                border: 1px solid var(--linear-border-standard, rgba(255, 255, 255, 0.08));
                border-radius: 14px;
                padding: 16px;
                display: flex;
                flex-direction: column;
                gap: 12px;
                box-sizing: border-box;
                transition: border-color 0.2s ease, box-shadow 0.2s ease;
            }
            .rbq-sync-card-title {
                font-size: 13.5px;
                font-weight: 600;
                color: var(--linear-text-primary, #f8fafc);
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .rbq-sync-card-desc {
                font-size: 11.5px;
                color: var(--linear-text-secondary, #94a3b8);
                line-height: 1.5;
                margin-top: 2px;
            }
            .rbq-sync-tiles {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
                gap: 10px;
                margin-top: 4px;
            }
            .rbq-sync-tile {
                position: relative;
                display: flex;
                flex-direction: column;
                gap: 8px;
                padding: 14px;
                border-radius: 12px;
                background: rgba(255, 255, 255, 0.025);
                border: 1px solid rgba(255, 255, 255, 0.08);
                cursor: pointer;
                transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
                user-select: none;
                box-sizing: border-box;
            }
            .rbq-sync-tile:hover {
                background: rgba(255, 255, 255, 0.055);
                border-color: rgba(255, 255, 255, 0.18);
                transform: translateY(-1px);
            }
            .rbq-sync-tile.active {
                background: rgba(56, 189, 248, 0.08) !important;
                border-color: #38bdf8 !important;
                box-shadow: 0 0 16px rgba(56, 189, 248, 0.14) !important;
            }
            .rbq-sync-tile-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 6px;
            }
            .rbq-sync-tile-title {
                font-size: 13px;
                font-weight: 600;
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .rbq-sync-badge-pill {
                font-size: 10px;
                font-weight: 600;
                padding: 2px 7px;
                border-radius: 999px;
                letter-spacing: 0.02em;
                white-space: nowrap;
            }
            .rbq-sync-tile-text {
                font-size: 11px;
                line-height: 1.45;
                color: var(--linear-text-secondary, #94a3b8);
            }
            .rbq-sync-tile-features {
                display: flex;
                flex-wrap: wrap;
                gap: 5px;
                margin-top: 2px;
            }
            .rbq-sync-feature-tag {
                background: rgba(255, 255, 255, 0.04);
                border: 1px solid rgba(255, 255, 255, 0.06);
                padding: 2px 6px;
                border-radius: 4px;
                font-size: 10px;
                color: var(--linear-text-muted, #64748b);
                white-space: nowrap;
            }
            .rbq-sync-toggle-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 16px;
                padding: 12px 14px;
                border-radius: 10px;
                background: rgba(255, 255, 255, 0.02);
                border: 1px solid rgba(255, 255, 255, 0.05);
                cursor: pointer;
                transition: background 0.15s ease, border-color 0.15s ease;
                box-sizing: border-box;
            }
            .rbq-sync-toggle-row:hover {
                background: rgba(255, 255, 255, 0.045);
                border-color: rgba(255, 255, 255, 0.1);
            }
            .rbq-sync-toggle-info {
                display: flex;
                flex-direction: column;
                gap: 3px;
                flex: 1;
                min-width: 0;
            }
            .rbq-sync-toggle-title {
                font-size: 12.5px;
                font-weight: 600;
                color: var(--linear-text-primary, #f8fafc);
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .rbq-sync-toggle-desc {
                font-size: 11px;
                color: var(--linear-text-secondary, #94a3b8);
                line-height: 1.4;
            }
            .rbq-switch {
                position: relative;
                display: inline-block;
                width: 44px;
                height: 24px;
                flex-shrink: 0;
                pointer-events: none;
            }
            .rbq-switch input {
                opacity: 0;
                width: 0;
                height: 0;
            }
            .rbq-slider {
                position: absolute;
                cursor: pointer;
                top: 0; left: 0; right: 0; bottom: 0;
                background-color: rgba(255, 255, 255, 0.15);
                border: 1px solid rgba(255, 255, 255, 0.2);
                border-radius: 24px;
                transition: all 0.2s ease;
            }
            .rbq-slider:before {
                position: absolute;
                content: "";
                height: 18px;
                width: 18px;
                left: 2px;
                bottom: 2px;
                background-color: #ffffff;
                border-radius: 50%;
                transition: transform 0.2s ease;
                box-shadow: 0 2px 4px rgba(0,0,0,0.3);
            }
            .rbq-switch input:checked + .rbq-slider {
                background-color: #38bdf8;
                border-color: #38bdf8;
            }
            .rbq-switch input:checked + .rbq-slider:before {
                transform: translateX(20px);
            }
            .rbq-batch-btn {
                width: 100% !important;
                box-sizing: border-box !important;
                white-space: nowrap !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                gap: 8px !important;
                padding: 12px 20px !important;
                font-size: 13px !important;
                font-weight: 600 !important;
                border-radius: 10px !important;
                background: linear-gradient(135deg, rgba(56, 189, 248, 0.15), rgba(99, 102, 241, 0.15)) !important;
                border: 1px solid rgba(56, 189, 248, 0.35) !important;
                color: #38bdf8 !important;
                cursor: pointer !important;
                transition: all 0.2s ease !important;
                box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2) !important;
            }
            .rbq-batch-btn:hover {
                background: linear-gradient(135deg, rgba(56, 189, 248, 0.25), rgba(99, 102, 241, 0.25)) !important;
                border-color: #38bdf8 !important;
                transform: translateY(-1px);
                box-shadow: 0 6px 20px rgba(56, 189, 248, 0.25) !important;
            }
            .rbq-batch-btn:active {
                transform: translateY(0);
            }
            .rbq-save-btn {
                padding: 7px 20px !important;
                font-size: 12.5px !important;
                font-weight: 600 !important;
                border-radius: 8px !important;
                background: linear-gradient(135deg, #0284c7, #0369a1) !important;
                border: 1px solid rgba(56, 189, 248, 0.4) !important;
                color: #ffffff !important;
                cursor: pointer !important;
                display: inline-flex !important;
                align-items: center !important;
                gap: 6px !important;
                white-space: nowrap !important;
                transition: all 0.2s ease !important;
                box-shadow: 0 4px 14px rgba(2, 132, 199, 0.35) !important;
            }
            .rbq-save-btn:hover {
                background: linear-gradient(135deg, #0369a1, #075985) !important;
                box-shadow: 0 6px 18px rgba(2, 132, 199, 0.5) !important;
                transform: translateY(-1px);
            }
        `;
        document.head.appendChild(style);
    }

    function showStorageModal(current, info) {
        document.querySelectorAll('.rbq-storage-modal-overlay').forEach(el => el.remove());

        const sizeStr = info?.blobSize ? formatBytes(info.blobSize) : (info?.hasServerOriginal ? '无损原画' : (current?.url ? '轻量流媒体' : '未知'));
        const dimStr = (current?.width && current?.height) ? `${current.width} × ${current.height}` : '自适应';

        const overlay = document.createElement('div');
        overlay.className = 'rbq-storage-modal-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'rbq-storage-modal-dialog';

        dialog.innerHTML = `
            <div class="rbq-storage-modal-header">
                <div class="rbq-storage-modal-title">
                    <span class="rbq-storage-dot" style="background:${info.color};"></span>
                    <span>${escapeHtml(info.text)}</span>
                </div>
                <button class="rbq-storage-modal-close" type="button" title="关闭">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div class="rbq-storage-modal-body">
                <div class="rbq-storage-info-list">
                    <div class="rbq-storage-info-row">
                        <span class="rbq-storage-info-label">🖥️ 本机状态</span>
                        <span class="rbq-storage-info-val" style="color:${info.localColor || '#e2e8f0'};font-weight:600;">${escapeHtml(info.localStatus)}</span>
                    </div>
                    <div class="rbq-storage-info-row">
                        <span class="rbq-storage-info-label">☁️ 云端状态</span>
                        <span class="rbq-storage-info-val" style="color:${info.serverColor || '#e2e8f0'};font-weight:600;">${escapeHtml(info.serverStatus)}</span>
                    </div>
                    <div class="rbq-storage-info-row">
                        <span class="rbq-storage-info-label">📐 规格尺寸</span>
                        <span class="rbq-storage-info-val">${escapeHtml(dimStr)} (${escapeHtml(sizeStr)})</span>
                    </div>
                    <div style="display:flex;flex-direction:column;gap:4px;margin-top:2px;">
                        <span class="rbq-storage-info-label">🔗 物理路径 / URL：</span>
                        <div class="rbq-storage-path-box">${escapeHtml(info.path || '(内存链接)')}</div>
                    </div>
                </div>
                <div class="rbq-storage-actions">
                    ${info.canUploadOriginal ? `
                        <button id="rbq-action-manual-sync" class="menu_button rbq-storage-action-btn rbq-storage-btn-sync" type="button">
                            <i class="fa-solid fa-cloud-arrow-up"></i> 上传高清原画至酒馆服务器
                        </button>
                    ` : ''}
                    ${info.canLoadServerOriginal ? `
                        <button id="rbq-action-load-original" class="menu_button rbq-storage-action-btn rbq-storage-btn-sync" style="background: linear-gradient(135deg, rgba(250, 204, 21, 0.2), rgba(245, 158, 11, 0.2)) !important; border-color: #facc15 !important; color: #facc15 !important;" type="button">
                            <i class="fa-solid fa-cloud-arrow-down"></i> 加载云端高清原画
                        </button>
                    ` : ''}
                    ${info.canMarkPending ? `
                        <button id="rbq-action-mark-pending" class="menu_button rbq-storage-action-btn rbq-storage-btn-sync" style="background: linear-gradient(135deg, rgba(251, 146, 60, 0.2), rgba(234, 88, 12, 0.2)) !important; border-color: #fb923c !important; color: #fb923c !important;" type="button">
                            <i class="fa-solid fa-star"></i> 标记收藏并在生成端自动上传
                        </button>
                    ` : ''}
                    ${(info.hasLocalOriginal && info.hasServerOriginal) ? `
                        <button class="menu_button rbq-storage-action-btn" style="background: rgba(56, 189, 248, 0.12) !important; border: 1px solid rgba(56, 189, 248, 0.3) !important; color: #38bdf8 !important; cursor: default !important; opacity: 0.9 !important;" type="button" disabled>
                            <i class="fa-solid fa-circle-check"></i> 无损原画已双端持久化
                        </button>
                    ` : ''}
                    <button id="rbq-action-copy-path" class="menu_button rbq-storage-action-btn rbq-storage-btn-copy" type="button">
                        <i class="fa-solid fa-copy"></i> 复制物理路径 / 链接
                    </button>
                    <button id="rbq-action-open-settings" class="menu_button rbq-storage-action-btn rbq-storage-btn-copy" type="button">
                        <i class="fa-solid fa-sliders"></i> 打开云同步设置
                    </button>
                </div>
            </div>
        `;

        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                closeModal();
            }
        };

        const closeModal = () => {
            window.removeEventListener('keydown', handleKeyDown, true);
            overlay.remove();
        };
        overlay.__rbqCleanup = closeModal;
        window.addEventListener('keydown', handleKeyDown, true);

        const closeBtn = dialog.querySelector('.rbq-storage-modal-close');
        if (closeBtn) closeBtn.onclick = closeModal;

        overlay.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
        overlay.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });
        overlay.addEventListener('touchend', (e) => e.stopPropagation(), { passive: true });
        dialog.addEventListener('click', (e) => e.stopPropagation());

        let canClose = false;
        setTimeout(() => { canClose = true; }, 350);
        overlay.addEventListener('click', (e) => {
            if (canClose && e.target === overlay) closeModal();
        });

        // 绑定手动同步按钮
        const syncBtn = dialog.querySelector('#rbq-action-manual-sync');
        if (syncBtn) {
            syncBtn.onclick = async (e) => {
                e.stopPropagation();
                syncBtn.disabled = true;
                syncBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在上传服务端...';

                try {
                    let blobToSync = null;
                    if (current.cacheId && typeof RBQ?.api?.getCachedImageRecord === 'function') {
                        const rec = await RBQ.api.getCachedImageRecord(current.cacheId);
                        if (rec?.blob instanceof Blob) blobToSync = rec.blob;
                    }
                    if (!blobToSync && current.displayUrl && current.displayUrl.startsWith('blob:')) {
                        const res = await fetch(current.displayUrl);
                        if (res.ok) blobToSync = await res.blob();
                    }
                    if (!blobToSync && current.url && current.url.startsWith('blob:')) {
                        const res = await fetch(current.url);
                        if (res.ok) blobToSync = await res.blob();
                    }

                    if (!blobToSync) throw new Error('当前设备本地未找到无损原图缓存');

                    const mode = current.mode || 'rbq';
                    const now = Date.now();
                    let ext = 'png';
                    if (blobToSync.type === 'image/jpeg' || blobToSync.type === 'image/jpg') ext = 'jpg';
                    else if (blobToSync.type === 'image/webp') ext = 'webp';

                    const filename = `rbq_${mode}_manual_${now}.${ext}`;
                    const path = await uploadBlobToServer(blobToSync, filename);

                    await applySyncedPathToAllRecords(current, path, true);

                    // 双轨保障：同时确保轻量预览图存在
                    if (!current.serverPreviewUrl) {
                        const previewFilename = `rbq_${mode}_manual_${now}_preview.webp`;
                        const previewBlob = await createOptimizedWebpBlob(blobToSync, 768, 0.8);
                        if (previewBlob) {
                            const previewPath = await uploadBlobToServer(previewBlob, previewFilename);
                            if (previewPath) {
                                await applySyncedPathToAllRecords(current, previewPath, false);
                            }
                        }
                    }

                    toastr.success(`已成功同步高清原画到酒馆服务端: ${path}`, PLUGIN_NAME);
                    closeModal();
                    updateViewerBadge({ modal: document.getElementById('st-scene-trigger-image-viewer'), current });
                } catch (syncErr) {
                    toastr.error(`同步失败: ${syncErr.message || syncErr}`, PLUGIN_NAME);
                    syncBtn.disabled = false;
                    syncBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i> 重试同步';
                }
            };
        }

        // 绑定加载云端原画按钮
        const loadBtn = dialog.querySelector('#rbq-action-load-original');
        if (loadBtn) {
            loadBtn.onclick = async (e) => {
                e.stopPropagation();
                loadBtn.disabled = true;
                loadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在加载云端原画...';
                try {
                    const originalUrl = info.serverOriginalUrl || info.serverUrl;
                    if (!originalUrl) throw new Error('云端无损原画地址不存在');
                    const isVid = (typeof RBQ?.utils?.isVideoMedia === 'function')
                        ? RBQ.utils.isVideoMedia(current) || RBQ.utils.isVideoMedia(originalUrl)
                        : (/\.(mp4|webm|mov|mkv)/i.test(originalUrl) || current?.mediaType === 'video');
                    if (isVid) {
                        const vidLoader = document.createElement('video');
                        vidLoader.preload = 'auto';
                        vidLoader.src = originalUrl;
                        await new Promise((resolve, reject) => {
                            vidLoader.onloadeddata = resolve;
                            vidLoader.onerror = reject;
                            setTimeout(resolve, 8000);
                        });
                    } else {
                        const imgLoader = new Image();
                        imgLoader.src = originalUrl;
                        await new Promise((resolve, reject) => {
                            imgLoader.onload = resolve;
                            imgLoader.onerror = reject;
                        });
                    }
                    current._originalLoaded = true;
                    current.displayUrl = originalUrl;
                    const viewerMedia = document.querySelector('#st-scene-trigger-image-viewer .st-scene-trigger-viewer-image');
                    if (viewerMedia) viewerMedia.src = originalUrl;
                    const origPill = document.querySelector('#st-viewer-load-original-pill');
                    if (origPill) origPill.style.display = 'none';
                    toastr.success(isVid ? '已载入云端无损高清原视频' : '已载入云端无损高清原图', PLUGIN_NAME);
                    closeModal();
                    updateViewerBadge({ modal: document.getElementById('st-scene-trigger-image-viewer'), current });
                } catch (err) {
                    toastr.error(`加载原画失败: ${err.message || err}`, PLUGIN_NAME);
                    loadBtn.disabled = false;
                    loadBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> 重新尝试加载';
                }
            };
        }

        // 绑定待补传原图收藏标记按钮
        const pendingBtn = dialog.querySelector('#rbq-action-mark-pending');
        if (pendingBtn) {
            pendingBtn.onclick = async (e) => {
                e.stopPropagation();
                await markPendingOriginalUpload(current);
                toastr.success('已标记收藏！切回原生成设备时将自动同步无损原画', PLUGIN_NAME);
                closeModal();
                updateViewerBadge({ modal: document.getElementById('st-scene-trigger-image-viewer'), current });
            };
        }

        // 复制路径
        dialog.querySelector('#rbq-action-copy-path')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            const textToCopy = info.path || current.url || '';
            if (!textToCopy) return toastr.warning('没有可复制的有效路径', PLUGIN_NAME);
            const ok = await copyToClipboard(textToCopy);
            if (ok) {
                toastr.success('路径已成功复制到剪贴板', PLUGIN_NAME);
            } else {
                toastr.warning('复制失败，请手动选取', PLUGIN_NAME);
            }
        });

        // 打开设置
        dialog.querySelector('#rbq-action-open-settings')?.addEventListener('click', (e) => {
            e.stopPropagation();
            closeModal();
            const drawerBtn = document.getElementById('st-scene-trigger-open-from-drawer');
            if (drawerBtn) drawerBtn.click();
            setTimeout(() => {
                document.querySelector('[data-kite-tab="rbq-gallery-sync"]')?.click();
            }, 150);
        });

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    }

    async function updateViewerBadge(detail) {
        const store = getStore();
        if (!store.enableViewerBadge) return;

        const modal = detail?.modal || document.getElementById('st-scene-trigger-image-viewer');
        if (!modal) return;

        const actions = modal.querySelector('.st-scene-trigger-viewer-actions');
        const bottomBar = detail?.bottomBar || modal.querySelector('.st-scene-trigger-viewer-bottom-bar');
        if (!actions && !bottomBar) return;

        const current = detail?.current || currentViewerItem;
        currentViewerItem = current;
        if (!current) return;

        injectStyles();

        // 移除旧版遗留的 popover 与 wrapper 节点
        modal.querySelector('#rbq-storage-popover')?.remove();
        document.getElementById('rbq-storage-popover')?.remove();
        modal.querySelector('#rbq-storage-badge-wrap')?.remove();

        // 1. 顶部操作栏指示点
        let badgeBtn = actions?.querySelector('#rbq-storage-badge-btn');
        if (actions && !badgeBtn) {
            badgeBtn = document.createElement('button');
            badgeBtn.id = 'rbq-storage-badge-btn';
            badgeBtn.className = 'rbq-storage-badge-btn menu_button st-scene-trigger-icon-button';
            badgeBtn.type = 'button';
            badgeBtn.title = '查阅图片存储归属与云端同步详情';
            badgeBtn.innerHTML = '<span id="rbq-storage-dot" class="rbq-storage-dot" style="background:#94a3b8;"></span>';

            // 挂在缩放倍率按钮前面
            const zoomPill = actions.querySelector('.st-scene-trigger-viewer-zoom-pill');
            if (zoomPill) {
                actions.insertBefore(badgeBtn, zoomPill);
            } else {
                actions.prepend(badgeBtn);
            }

            badgeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
            badgeBtn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
        }

        // 2. 底部栏胶囊按钮（手机端与大图极佳访问体验）
        let bottomBadge = bottomBar?.querySelector('#rbq-storage-bottom-badge');
        if (bottomBar && !bottomBadge) {
            bottomBadge = document.createElement('button');
            bottomBadge.id = 'rbq-storage-bottom-badge';
            bottomBadge.className = 'menu_button rbq-storage-bottom-badge';
            bottomBadge.type = 'button';
            bottomBadge.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
            bottomBadge.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });
            bottomBadge.addEventListener('touchend', (e) => e.stopPropagation(), { passive: true });
            bottomBadge.addEventListener('pointerdown', (e) => e.stopPropagation());
            bottomBar.appendChild(bottomBadge);
        }

        // 检测存储物理归属
        const info = await inspectImageStorage(current);

        if (badgeBtn) {
            const dot = badgeBtn.querySelector('#rbq-storage-dot');
            if (dot) dot.style.background = info.color;
            badgeBtn.title = `存储状态: ${info.text} (${info.title}) - 点击查看详情`;
            badgeBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                showStorageModal(current, info);
            };
        }

        if (bottomBadge) {
            bottomBadge.title = `存储状态: ${info.text} (${info.title}) - 点击查看详情`;
            bottomBadge.innerHTML = `<span class="rbq-storage-dot" style="background:${info.color};"></span> 存储: ${escapeHtml(info.text)}`;
            bottomBadge.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                showStorageModal(current, info);
            };
        }
    }

    function escapeHtml(str) {
        return String(str || '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
    }

    window.addEventListener('st-scene-trigger:viewer-rendered', (event) => {
        updateViewerBadge(event?.detail);
    });

    window.addEventListener('rbq-sdt:bottom-bar-rendered', (event) => {
        const modal = event?.detail?.modal || document.getElementById('st-scene-trigger-image-viewer');
        updateViewerBadge({ modal, bottomBar: event?.detail?.bottomBar, current: currentViewerItem });
    });

    window.addEventListener('st-scene-trigger:viewer-closed', () => {
        document.querySelectorAll('.rbq-storage-modal-overlay').forEach(el => {
            if (typeof el.__rbqCleanup === 'function') el.__rbqCleanup(); else el.remove();
        });
        document.getElementById('rbq-storage-popover')?.remove();
    });

    async function batchSyncAllFavorites() {
        const history = RBQ?.api?.getSettings?.()?.history;
        if (!Array.isArray(history) || history.length === 0) {
            return toastr.warning('历史记录为空，没有可同步的收藏图片', PLUGIN_NAME);
        }

        const favItems = history.filter(item => item && (item.favorite === true || item.isFavorite === true));
        if (favItems.length === 0) {
            return toastr.info('暂无收藏的生图记录', PLUGIN_NAME);
        }

        const toSync = favItems.filter(item => !item.serverOriginalUrl);
        if (toSync.length === 0) {
            return toastr.success(`全部 ${favItems.length} 张收藏图片的高清原画已在服务端存档！`, PLUGIN_NAME);
        }

        toastr.info(`发现 ${toSync.length} 张未上云的高清收藏图片，开始自动批量补传...`, PLUGIN_NAME);
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < toSync.length; i++) {
            const item = toSync[i];
            try {
                let blobToSync = null;
                if (item.cacheId && typeof RBQ?.api?.getCachedImageRecord === 'function') {
                    const rec = await RBQ.api.getCachedImageRecord(item.cacheId);
                    if (rec?.blob instanceof Blob) blobToSync = rec.blob;
                }
                if (!blobToSync && item.displayUrl && !item.displayUrl.includes('_preview.webp')) {
                    const res = await fetch(item.displayUrl);
                    if (res.ok) blobToSync = await res.blob();
                }
                if (!blobToSync && item.url && !item.url.includes('_preview.webp')) {
                    const res = await fetch(item.url);
                    if (res.ok) blobToSync = await res.blob();
                }

                if (blobToSync) {
                    const mode = item.mode || 'rbq';
                    const now = Date.now();
                    const cleanExt = blobToSync.type.includes('webp') ? 'webp' : (blobToSync.type.includes('jpeg') || blobToSync.type.includes('jpg') ? 'jpg' : 'png');
                    const filename = `st_draw_fav_sync_${mode}_${now}_${i}.${cleanExt}`;
                    const path = await uploadBlobToServer(blobToSync, filename);
                    if (path) {
                        await applySyncedPathToAllRecords(item, path, true);
                        successCount++;
                    } else {
                        failCount++;
                    }
                } else {
                    failCount++;
                }
            } catch (e) {
                console.warn(`[${PLUGIN_NAME}] 批量同步收藏图片失败:`, e);
                failCount++;
            }
        }

        RBQ.api?.saveSettings?.();
        if (successCount > 0) {
            toastr.success(`批量补传完成！已成功上传 ${successCount} 张高清原画${failCount > 0 ? ` (${failCount} 张本地缓存已释放)` : ''}`, PLUGIN_NAME);
        } else {
            toastr.warning('未成功补传原画，本地缓存可能已被浏览器清理', PLUGIN_NAME);
        }
    }

    // ── 8. Setting Panel Registration ──
    function renderSettings() {
        injectStyles();
        const store = getStore();
        return `
            <div id="rbq-gallery-sync-settings" class="rbq-sync-subpanel">
                <!-- 顶部标题与快速保存 -->
                <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; padding-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.06);">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <div style="width:36px; height:36px; border-radius:10px; background:linear-gradient(135deg, rgba(56,189,248,0.2), rgba(99,102,241,0.2)); border:1px solid rgba(56,189,248,0.3); display:flex; align-items:center; justify-content:center; color:#38bdf8; font-size:16px;">
                            <i class="fa-solid fa-cloud-arrow-up"></i>
                        </div>
                        <div>
                            <div style="font-size:14.5px; font-weight:700; color:#f8fafc; display:flex; align-items:center; gap:8px;">
                                服务端图库同步与存储管理
                                <span style="font-size:11px; padding:1px 7px; border-radius:999px; background:rgba(56,189,248,0.15); color:#38bdf8; border:1px solid rgba(56,189,248,0.3); font-weight:normal;">v${PLUGIN_VERSION}</span>
                            </div>
                            <div style="font-size:11px; color:#94a3b8; margin-top:2px;">双轨省流云同步 · 高清原画智能归档 · 存储状态微型指示</div>
                        </div>
                    </div>
                    <button id="rbq-sync-save-btn" class="rbq-save-btn" type="button">
                        <i class="fa-solid fa-check"></i> 保存配置
                    </button>
                </div>

                <!-- 模块 1: 同步策略选择 -->
                <div class="rbq-sync-card">
                    <div>
                        <div class="rbq-sync-card-title">
                            <i class="fa-solid fa-sliders" style="color:#38bdf8;"></i> 同步策略选择
                        </div>
                        <div class="rbq-sync-card-desc">
                            控制新生成的图片是否持久化至酒馆服务端磁盘，以及多端（手机/平板/电脑）同步时如何最节省流量与带宽。
                        </div>
                    </div>

                    <div class="rbq-sync-tiles">
                        <!-- 极速省流 -->
                        <div class="rbq-sync-tile ${store.syncMode === 'stream_only' ? 'active' : ''}" data-mode="stream_only">
                            <input type="radio" name="rbq-sync-mode" value="stream_only" ${store.syncMode === 'stream_only' ? 'checked' : ''} style="display:none;">
                            <div class="rbq-sync-tile-head">
                                <span class="rbq-sync-tile-title" style="color:#38bdf8;">
                                    <i class="fa-solid fa-bolt-lightning"></i> 极速省流云同步
                                </span>
                                <span class="rbq-sync-badge-pill" style="background:rgba(56,189,248,0.18); color:#38bdf8; border:1px solid rgba(56,189,248,0.35);">强烈推荐</span>
                            </div>
                            <div class="rbq-sync-tile-text">
                                客户端出图后自动压制约 <strong>50~80KB 超轻量 WebP 预览图</strong>至服务端。多端打开秒开秒显，手机流量 0 压力。
                            </div>
                            <div class="rbq-sync-tile-features">
                                <span class="rbq-sync-feature-tag">📱 移动端秒显</span>
                                <span class="rbq-sync-feature-tag">📶 百图仅~6MB</span>
                                <span class="rbq-sync-feature-tag">⭐ 收藏升原画</span>
                            </div>
                        </div>

                        <!-- 纯本地模式 -->
                        <div class="rbq-sync-tile ${store.syncMode === 'local' ? 'active' : ''}" data-mode="local">
                            <input type="radio" name="rbq-sync-mode" value="local" ${store.syncMode === 'local' ? 'checked' : ''} style="display:none;">
                            <div class="rbq-sync-tile-head">
                                <span class="rbq-sync-tile-title" style="color:#4ade80;">
                                    <i class="fa-solid fa-laptop"></i> 纯本地模式
                                </span>
                                <span class="rbq-sync-badge-pill" style="background:rgba(74,222,128,0.15); color:#4ade80; border:1px solid rgba(74,222,128,0.3);">不上云</span>
                            </div>
                            <div class="rbq-sync-tile-text">
                                图片仅保存在当前设备浏览器数据库中，完全不占用服务端磁盘与上行带宽。换设备时无法同步历史图。
                            </div>
                            <div class="rbq-sync-tile-features">
                                <span class="rbq-sync-feature-tag">🔒 零服务端占用</span>
                                <span class="rbq-sync-feature-tag">⚠️ 仅本机可用</span>
                            </div>
                        </div>

                        <!-- 全量原画云存档 -->
                        <div class="rbq-sync-tile ${store.syncMode === 'full' ? 'active' : ''}" data-mode="full">
                            <input type="radio" name="rbq-sync-mode" value="full" ${store.syncMode === 'full' ? 'checked' : ''} style="display:none;">
                            <div class="rbq-sync-tile-head">
                                <span class="rbq-sync-tile-title" style="color:#c084fc;">
                                    <i class="fa-solid fa-gem"></i> 全量原画云存档
                                </span>
                                <span class="rbq-sync-badge-pill" style="background:rgba(192,132,252,0.15); color:#c084fc; border:1px solid rgba(192,132,252,0.3);">千兆局域网</span>
                            </div>
                            <div class="rbq-sync-tile-text">
                                轻量预览图与数兆原始 PNG 原画双轨同步上传至酒馆服务器磁盘，原汁原味永久留存。
                            </div>
                            <div class="rbq-sync-tile-features">
                                <span class="rbq-sync-feature-tag">🖼️ 无损原画存档</span>
                                <span class="rbq-sync-feature-tag">🚀 需家庭千兆/大带宽</span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 模块 2: 存储策略与智能上传 -->
                <div class="rbq-sync-card">
                    <div>
                        <div class="rbq-sync-card-title">
                            <i class="fa-solid fa-shield-halved" style="color:#a78bfa;"></i> 存储策略与智能上传
                        </div>
                        <div class="rbq-sync-card-desc">
                            微调跨端同步行为与原画上传触发机制。
                        </div>
                    </div>

                    <div style="display:flex; flex-direction:column; gap:8px;">
                        <!-- 收藏自动上传 -->
                        <label class="rbq-sync-toggle-row">
                            <div class="rbq-sync-toggle-info">
                                <span class="rbq-sync-toggle-title">
                                    <span style="color:#fbbf24;">⭐</span> 收藏时自动上传高清原画至服务端
                                    <span class="rbq-sync-badge-pill" style="background:rgba(251,191,36,0.15); color:#fbbf24; border:1px solid rgba(251,191,36,0.3); font-size:10px;">推荐</span>
                                </span>
                                <span class="rbq-sync-toggle-desc">在画廊或大图查看器中点击「⭐ 收藏」时，自动提取最高画质原图上传至酒馆服务端永久留存。若在移动端收藏，切回有原图的设备时会自动无感补传。</span>
                            </div>
                            <span class="rbq-switch">
                                <input id="rbq-sync-fav-original" type="checkbox" ${store.syncFavoritesOriginal ? 'checked' : ''}>
                                <span class="rbq-slider"></span>
                            </span>
                        </label>

                        <!-- 移动蜂窝保护 -->
                        <label class="rbq-sync-toggle-row">
                            <div class="rbq-sync-toggle-info">
                                <span class="rbq-sync-toggle-title">
                                    <span style="color:#38bdf8;">📶</span> 移动蜂窝网络流量保护 (Save-Data 感知)
                                </span>
                                <span class="rbq-sync-toggle-desc">检测到当前处于手机 4G/5G 移动蜂窝网络时，自动阻断原画全量拉取与同步，优先使用 50KB 轻量预览图，防止流量意外消耗。</span>
                            </div>
                            <span class="rbq-switch">
                                <input id="rbq-sync-savedata" type="checkbox" ${store.saveDataAware ? 'checked' : ''}>
                                <span class="rbq-slider"></span>
                            </span>
                        </label>

                        <!-- 存储归属指示点 -->
                        <label class="rbq-sync-toggle-row">
                            <div class="rbq-sync-toggle-info">
                                <span class="rbq-sync-toggle-title">
                                    <span style="color:#4ade80;">🏷️</span> 大图查看器显示「存储归属指示点」
                                </span>
                                <span class="rbq-sync-toggle-desc">在大图查看器右上角显示存储状态呼吸圆点（🟢本地 / 🔵服务端原画 / 🟡省流预览 / 🟣绘图后端），点击居中展开规格详情与一键补传。</span>
                            </div>
                            <span class="rbq-switch">
                                <input id="rbq-sync-badge-enable" type="checkbox" ${store.enableViewerBadge ? 'checked' : ''}>
                                <span class="rbq-slider"></span>
                            </span>
                        </label>
                    </div>
                </div>

                <!-- 模块 3: 存量收藏原画补传 -->
                <div class="rbq-sync-card" style="border:1px solid rgba(56,189,248,0.22); background:linear-gradient(135deg, rgba(56,189,248,0.03), rgba(99,102,241,0.03));">
                    <div>
                        <div class="rbq-sync-card-title" style="color:#38bdf8;">
                            <i class="fa-solid fa-cloud-arrow-up"></i> 存量收藏原画一键补传
                        </div>
                        <div class="rbq-sync-card-desc">
                            自动扫描当前设备浏览器中所有带 ⭐ 收藏标记的图片记录。若服务端尚未存档高清原画，一键批量补传，实现跨设备永久留存。
                        </div>
                    </div>

                    <button id="rbq-sync-batch-fav-btn" class="rbq-batch-btn" type="button">
                        <i class="fa-solid fa-cloud-arrow-up"></i> 一键扫描并补传所有已收藏原画至服务端
                    </button>
                </div>
            </div>
        `;
    }

    function initSettingsListeners() {
        const root = document.getElementById('rbq-gallery-sync-settings');
        if (!root) return;

        // 绑定模式卡片单选点击
        const tiles = root.querySelectorAll('.rbq-sync-tile');
        tiles.forEach(tile => {
            tile.onclick = () => {
                tiles.forEach(t => t.classList.remove('active'));
                tile.classList.add('active');
                const radio = tile.querySelector('input[type="radio"]');
                if (radio) {
                    radio.checked = true;
                    saveCurrentSettings(false);
                }
            };
        });

        // 绑定开关行点击
        const toggleRows = root.querySelectorAll('.rbq-sync-toggle-row');
        toggleRows.forEach(row => {
            row.onclick = (e) => {
                if (e.target.tagName === 'INPUT') return;
                const checkbox = row.querySelector('input[type="checkbox"]');
                if (checkbox) {
                    checkbox.checked = !checkbox.checked;
                    saveCurrentSettings(false);
                }
            };
        });

        function saveCurrentSettings(showToast = true) {
            const store = getStore();
            const selectedMode = root.querySelector('input[name="rbq-sync-mode"]:checked')?.value || 'stream_only';
            store.syncMode = selectedMode;
            store.syncFavoritesOriginal = !!root.querySelector('#rbq-sync-fav-original')?.checked;
            store.saveDataAware = !!root.querySelector('#rbq-sync-savedata')?.checked;
            store.enableViewerBadge = !!root.querySelector('#rbq-sync-badge-enable')?.checked;

            save();
            if (showToast) {
                toastr.success('图库同步配置已保存', PLUGIN_NAME);
            }
        }

        const saveBtn = root.querySelector('#rbq-sync-save-btn');
        if (saveBtn) {
            saveBtn.onclick = () => saveCurrentSettings(true);
        }

        const batchFavBtn = root.querySelector('#rbq-sync-batch-fav-btn');
        if (batchFavBtn) {
            batchFavBtn.onclick = async () => {
                batchFavBtn.disabled = true;
                const oldHtml = batchFavBtn.innerHTML;
                batchFavBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在批量补传中...';
                try {
                    await batchSyncAllFavorites();
                } finally {
                    batchFavBtn.disabled = false;
                    batchFavBtn.innerHTML = oldHtml;
                }
            };
        }
    }

    // 注册到 RBQ 主控制台侧边栏
    if (RBQ?.ui?.addSettingPanel) {
        RBQ.ui.addSettingPanel('rbq-gallery-sync', '<i class="fa-solid fa-cloud-arrow-up"></i><span>图库云同步</span>', () => {
            setTimeout(initSettingsListeners, 50);
            return renderSettings();
        });
    }

    // 清理钩子
    if (typeof RBQ?.registerPluginCleanup === 'function') {
        RBQ.registerPluginCleanup(PLUGIN_ID, () => {
            document.getElementById('rbq-gallery-sync-style')?.remove();
            document.getElementById('rbq-storage-badge-btn')?.remove();
            document.getElementById('rbq-storage-badge-wrap')?.remove();
            document.querySelectorAll('.rbq-storage-modal-overlay').forEach(el => el.remove());
            document.getElementById('rbq-storage-popover')?.remove();
            RBQ.ui.removeSettingPanel('rbq-gallery-sync');
        });
    }

    // 暴露 API
    RBQ.api.gallerySync = {
        inspectImageStorage,
        createOptimizedWebpBlob,
        uploadBlobToServer,
        syncFavoriteOriginal,
        getStore,
    };

    console.info(`☁️ [${PLUGIN_NAME} v${PLUGIN_VERSION}] loaded successfully. syncMode="${getStore().syncMode}"`);

})(window.RBQ, window.jQuery || window.$, window.toastr);
