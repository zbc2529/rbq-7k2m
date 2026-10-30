/**
 * 安卓保存修复 (Save Downloads Fix)
 *
 * 修复 TauriTavern 安卓端报「Error invoking saveFileToDownloads: Java exception was raised
 * during method invocation」导致图片/文件无法保存到下载目录的问题。
 *
 * 背景:TauriTavern 安卓端会把所有 <a download> 保存请求劫持到原生桥 saveFileToDownloads,
 * 该 Kotlin 方法内部任一校验失败(暂存文件不存在/路径越界/文件名含路径分隔符/
 * MediaStore 写入失败等)都会以 Chromium 的通用报错抛出,JS 侧看不到具体原因。
 *
 * 本插件在不动主程序与主插件的前提下,从子插件层接管保存流程:
 *   1. 包一层原生桥:调用前自动修正非法文件名,失败时自动用 ASCII 文件名重试;
 *   2. 接管 <a download> 点击(合成 click 与真实点击两条路),自己走完整保存链:
 *      原生直存(原名) → 原生直存(ASCII 名) → 系统另存为(SAF 文档选择器)兜底;
 *   3. 每一步尝试都写入控制台日志,并在 window.__RBQ_SAVE_FIX__.diag 里留档,
 *      方便定位到底是哪一层校验炸了。
 *
 * 桌面端 / 网页端 / iOS 环境下本插件完全静默,不改变任何行为。
 *
 * 兼容:RBQ 子插件加载器以 new Function("RBQ","jQuery","toastr", code) 执行本文件。
 */
(function (RBQ, $, toastr) {
    if (!RBQ) return console.error('安卓保存修复: RBQ Core API 缺失!');

    const TAG = '[RBQ SaveFix]';
    const PLUGIN_VERSION = '1.0.0';
    const BRIDGE_NAME = 'TauriTavernAndroidPublicDownloadBridge';
    const STAGING_ROOT_NAME = 'tauritavern-export-staging';
    const PICKER_RECEIVER = '__TAURITAVERN_PUBLIC_DOWNLOAD_PICKER__';
    const SAF_TIMEOUT_MS = 180000; // 系统另存为窗口最长等待 3 分钟
    const FS_CHUNK_BYTES = 4 * 1024 * 1024; // 与主程序 file-export.js 保持一致的分片大小

    // ---------------------------------------------------------------- 运行环境

    function getTauri() {
        const t = (typeof window !== 'undefined' && window.__TAURI__) || null;
        return (t && t.core && typeof t.core.invoke === 'function') ? t : null;
    }

    function getBridge() {
        return (typeof window !== 'undefined' && window[BRIDGE_NAME]) || null;
    }

    function isAndroidRuntime() {
        return typeof navigator !== 'undefined' && /android/i.test(String(navigator.userAgent || ''));
    }

    // 需要安卓 UA + 原生保存桥 + Tauri(path/fs 可用) 三者齐备才接管
    function supported() {
        if (!isAndroidRuntime()) return false;
        const bridge = getBridge();
        if (!bridge || typeof bridge.saveFileToDownloads !== 'function') return false;
        const t = getTauri();
        if (!t || !t.path) return false;
        return typeof t.path.appCacheDir === 'function' || typeof t.path.tempDir === 'function';
    }

    if (!supported()) {
        console.info(`${TAG} 非 Android/Tauri 环境(或缺原生保存桥),插件保持静默。`);
        return;
    }

    // ------------------------------------------------------------ 诊断留档

    const diagState = {
        version: PLUGIN_VERSION,
        installedAt: new Date().toISOString(),
        lastSaved: null,
        attempts: [],
    };
    window.__RBQ_SAVE_FIX__ = {
        version: PLUGIN_VERSION,
        diag: diagState,
        // 手动兜底入口: window.__RBQ_SAVE_FIX__.saveBlob(blob, '文件名.png')
        saveBlob: null,
    };

    function msgOf(error) {
        if (!error) return '未知错误';
        if (typeof error === 'string') return error;
        if (error.message) return error.message;
        return String(error);
    }

    function extFromMime(mime) {
        const t = String(mime || '');
        if (/png/i.test(t)) return 'png';
        if (/jpe?g/i.test(t)) return 'jpg';
        if (/webp/i.test(t)) return 'webp';
        if (/gif/i.test(t)) return 'gif';
        if (/zip/i.test(t)) return 'zip';
        if (/json/i.test(t)) return 'json';
        return 'bin';
    }

    // 与主程序 file-export.js 相同的文件名清洗规则
    const INVALID_FILENAME_CHARS = /[\\/:*?"<>|]+/g;
    const TRAILING_DOTS_OR_SPACES = /[. ]+$/g;

    function sanitizeName(value) {
        const raw = String(value || '').trim();
        const candidate = raw.replace(INVALID_FILENAME_CHARS, '_').replace(TRAILING_DOTS_OR_SPACES, '').trim();
        return candidate || `rbq-draw-${Date.now()}`;
    }

    // 纯 ASCII 兜底名,规避部分 ROM 对非 ASCII 文件名写入 MediaStore 的兼容问题
    function asciiName(mime) {
        return `rbq-draw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${extFromMime(mime)}`;
    }

    const MIME_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
    const EXT_MIME_MAP = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
        gif: 'image/gif', zip: 'application/zip', json: 'application/json', txt: 'text/plain',
    };

    function resolveMime(blob, fileName) {
        const declared = String((blob && blob.type) || '').split(';')[0].trim().toLowerCase();
        if (MIME_TYPE_PATTERN.test(declared)) return declared;
        const extMatch = /\.([a-z0-9]{1,8})$/i.exec(String(fileName || ''));
        if (extMatch) {
            const mapped = EXT_MIME_MAP[extMatch[1].toLowerCase()];
            if (mapped) return mapped;
        }
        return 'application/octet-stream';
    }

    // ------------------------------------------------------------ Tauri fs 暂存

    let invokeApi = null;
    function fsInvoke() {
        if (!invokeApi) {
            const t = getTauri();
            if (!t) throw new Error('Tauri invoke API 不可用');
            invokeApi = t.core.invoke;
        }
        return invokeApi;
    }

    async function resolveStagingBase() {
        const t = getTauri();
        const candidates = [t.path.appCacheDir, t.path.tempDir].filter(
            (fn) => typeof fn === 'function',
        );
        let lastError = null;
        for (const resolver of candidates) {
            try {
                const dir = await resolver.call(t.path);
                if (typeof dir === 'string' && dir.trim()) return dir;
            } catch (error) {
                lastError = error;
            }
        }
        throw (lastError || new Error('无法解析安卓导出暂存目录'));
    }

    async function createStagingDir() {
        const base = (await resolveStagingBase()).replace(/[\\/]+$/, '');
        const dir = `${base}/${STAGING_ROOT_NAME}/rbqfix-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        await fsInvoke()('plugin:fs|mkdir', { path: dir, options: { recursive: true } });
        return dir;
    }

    async function writeChunk(path, bytes, append) {
        await fsInvoke()('plugin:fs|write_file', bytes, {
            headers: {
                path: encodeURIComponent(path),
                options: JSON.stringify({ append: !!append, create: true }),
            },
        });
    }

    async function stageBlob(dir, name, blob) {
        if (!(blob instanceof Blob)) throw new Error('保存载荷不是 Blob');
        const path = `${dir.replace(/[\\/]+$/, '')}/${name}`;
        if (blob.size === 0) {
            await writeChunk(path, new Uint8Array(0), false);
            return path;
        }
        let append = false;
        let offset = 0;
        while (offset < blob.size) {
            const end = Math.min(offset + FS_CHUNK_BYTES, blob.size);
            const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
            await writeChunk(path, bytes, append);
            append = true;
            offset = end;
        }
        return path;
    }

    async function cleanupDir(dir) {
        try {
            await fsInvoke()('plugin:fs|remove', { path: dir, options: { recursive: true } });
        } catch (error) {
            console.warn(`${TAG} 清理暂存目录失败(不影响保存结果):`, msgOf(error));
        }
    }

    // ------------------------------------------------------------ 原生桥调用

    async function supportsDirectDownloads() {
        const bridge = getBridge();
        try {
            if (typeof bridge.supportsDirectPublicDownloads === 'function') {
                return bridge.supportsDirectPublicDownloads() === true;
            }
        } catch (error) {
            console.warn(`${TAG} 读取直存能力失败,按不支持处理:`, msgOf(error));
        }
        return false;
    }

    function nativeSave(stagedPath, name, mime) {
        const bridge = getBridge();
        const raw = String(origBridgeSave.call(bridge, stagedPath, name, mime) || '').trim();
        if (!raw) throw new Error('原生保存桥返回空结果');
        let result;
        try {
            result = JSON.parse(raw);
        } catch (error) {
            throw new Error(`原生保存桥返回非法结果: ${raw.slice(0, 120)}`);
        }
        const savedPath = String((result && result.saved_path) || '').trim();
        if (!savedPath) throw new Error('原生保存桥未返回保存路径');
        return result;
    }

    // ------------------------------------------------------------ SAF 系统另存为

    /**
     * 等待系统 ACTION_CREATE_DOCUMENT 的结果。
     * 接收器只在本插件等待期间顶替全局位置,结束后立即还原,
     * 主程序自己发起的另存为不受影响。
     * (注:若主程序与本插件同时各开一个另存为窗口,结果可能被串收,
     *  但系统同一时刻只有一个文档选择器,实际不会发生。)
     */
    function waitPickerResult(timeoutMs) {
        return new Promise((resolve, reject) => {
            const existing = window[PICKER_RECEIVER] || null;
            let timer = null;
            let settled = false;

            const cleanup = () => {
                if (timer) clearTimeout(timer);
                try {
                    window[PICKER_RECEIVER] = existing;
                } catch (error) {
                    /* 只读场景忽略 */
                }
            };

            const waiter = (payload) => {
                if (settled) return;
                settled = true;
                cleanup();
                const error = String((payload && payload.error) || '').trim();
                if (error) {
                    reject(new Error(error));
                    return;
                }
                const uri = String((payload && payload.content_uri) || '').trim();
                if (!uri) {
                    reject(new Error('系统另存为未返回目标位置'));
                    return;
                }
                resolve(uri);
            };

            window[PICKER_RECEIVER] = {
                __rbqSaveFix: true,
                onNativeResult: waiter,
            };

            timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error('系统另存为窗口超时(3 分钟未选择)'));
            }, timeoutMs);
        });
    }

    async function saveViaPicker(stagedPath, suggestName, mime) {
        const bridge = getBridge();
        if (typeof bridge.requestCreateDocumentPicker !== 'function') {
            throw new Error('系统另存为桥不可用');
        }
        if (typeof bridge.copyFileToContentUri !== 'function') {
            throw new Error('系统另存为复制桥不可用');
        }
        // 先装好接收器再唤起选择器,保证原生回调不丢
        const waitPromise = waitPickerResult(SAF_TIMEOUT_MS);
        try {
            bridge.requestCreateDocumentPicker(suggestName, mime);
        } catch (error) {
            await waitPromise.catch(() => { });
            throw error;
        }
        const contentUri = await waitPromise;
        const savedTarget = String(bridge.copyFileToContentUri(stagedPath, contentUri) || '').trim();
        return savedTarget || contentUri;
    }

    // ------------------------------------------------------------ 主保存链

    /**
     * 弹性保存:原生直存(原名) → 原生直存(ASCII 名) → 系统另存为(SAF)兜底。
     * 成功返回 { ok: true, savedPath, attempts };失败抛错并把 attempts 挂在 error 上。
     */
    async function saveBlobResilient(blob, rawFileName) {
        const attempts = [];
        const mime = resolveMime(blob, rawFileName);
        const trimmedName = String(rawFileName || '').trim();
        const nameOriginal = trimmedName ? sanitizeName(trimmedName) : asciiName(mime);
        const nameAscii = asciiName(mime);
        const direct = await supportsDirectDownloads();
        const stagingDir = await createStagingDir();

        try {
            if (direct) {
                const stagedPath = await stageBlob(stagingDir, nameOriginal, blob);
                try {
                    const result = nativeSave(stagedPath, nameOriginal, mime);
                    attempts.push({ mode: '原生直存(原名)', ok: true, saved: result.saved_path });
                    return succeed(attempts, result.saved_path);
                } catch (error) {
                    attempts.push({ mode: '原生直存(原名)', ok: false, err: msgOf(error) });
                    console.warn(`${TAG} 原生直存(原名)失败,准备用 ASCII 文件名重试:`, msgOf(error));
                }

                const asciiPath = await stageBlob(stagingDir, nameAscii, blob);
                try {
                    const result = nativeSave(asciiPath, nameAscii, mime);
                    attempts.push({ mode: '原生直存(ASCII名)', ok: true, saved: result.saved_path });
                    return succeed(attempts, result.saved_path);
                } catch (error) {
                    attempts.push({ mode: '原生直存(ASCII名)', ok: false, err: msgOf(error) });
                    console.warn(`${TAG} 原生直存(ASCII名)仍失败,降级到系统另存为:`, msgOf(error));
                }

                // SAF 兜底:直接复用第一次暂存的文件作为数据源
                const saved = await saveViaPicker(stagedPath, nameOriginal, mime);
                attempts.push({ mode: '系统另存为', ok: true, saved });
                return succeed(attempts, saved);
            }

            // Android < 10 或直存能力不可用:直接走系统另存为
            attempts.push({ mode: '原生直存', ok: false, err: 'Android 版本低于 10 或直存能力不可用,跳过' });
            const stagedPath = await stageBlob(stagingDir, nameAscii, blob);
            const saved = await saveViaPicker(stagedPath, nameOriginal, mime);
            attempts.push({ mode: '系统另存为', ok: true, saved });
            return succeed(attempts, saved);
        } catch (error) {
            attempts.push({ mode: '兜底', ok: false, err: msgOf(error) });
            console.error(`${TAG} 所有保存方式均失败,尝试明细:`, attempts);
            error.attempts = attempts;
            throw error;
        } finally {
            await cleanupDir(stagingDir);
        }

        function succeed(list, savedPath) {
            diagState.attempts = list;
            diagState.lastSaved = savedPath;
            console.info(`${TAG} 保存成功: ${savedPath}`, list);
            return { ok: true, savedPath, attempts: list };
        }
    }
    window.__RBQ_SAVE_FIX__.saveBlob = saveBlobResilient;

    // ------------------------------------------------- 1) 包一层原生桥(直调兜底)

    // 有些版本的主插件会直接调 saveFileToDownloads(报错前缀「Error invoking ...」),
    // 这里在桥上做一层透明修正:非法文件名先修正,失败后用 ASCII 名原地重试
    // (此刻暂存文件仍存在,同步重试来得及)。
    const origBridgeSave = (function wrapDirectBridge() {
        const bridge = getBridge();
        if (!bridge || typeof bridge.saveFileToDownloads !== 'function') return null;
        const orig = bridge.saveFileToDownloads;
        bridge.saveFileToDownloads = function (sourcePath, displayName, mimeType) {
            const safeName = sanitizeName(displayName);
            if (safeName !== String(displayName || '')) {
                console.warn(`${TAG} 检测到非法文件名,已自动修正: ${displayName} → ${safeName}`);
            }
            try {
                return orig.call(bridge, sourcePath, safeName, mimeType);
            } catch (error) {
                console.error(`${TAG} 原生 saveFileToDownloads 失败: ${msgOf(error)}`, {
                    sourcePath: String(sourcePath || ''),
                    displayName: String(displayName || ''),
                    mimeType: String(mimeType || ''),
                    userAgent: navigator.userAgent,
                });
                const ascii = asciiName(mimeType);
                try {
                    const raw = orig.call(bridge, sourcePath, ascii, mimeType);
                    console.warn(`${TAG} 已用 ASCII 文件名重试成功: ${ascii}`);
                    return raw;
                } catch (retryError) {
                    console.error(`${TAG} ASCII 文件名重试仍失败: ${msgOf(retryError)},原始异常抛回调用方`);
                    throw error;
                }
            }
        };
        return orig;
    })();

    // ------------------------------------------------- 2) 接管 <a download> 保存

    function resolveAnchorPayload(anchor) {
        if (!anchor || (anchor.hasAttribute && !anchor.hasAttribute('download'))) return null;
        const href = String(anchor.getAttribute('href') || anchor.href || '').trim();
        if (!href) return null;
        if (href.startsWith('blob:') || href.startsWith('data:')) return href;
        try {
            const url = new URL(href, window.location.href);
            if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin === window.location.origin) {
                return url.href;
            }
        } catch (error) {
            /* 非法 href,交给原逻辑处理 */
        }
        return null;
    }

    function takeOverAnchor(anchor) {
        try {
            if (!supported()) return false;
            const payloadHref = resolveAnchorPayload(anchor);
            if (!payloadHref) return false;
            const fileName = anchor.getAttribute('download') || '';

            void (async () => {
                try {
                    const response = await fetch(payloadHref);
                    if (!response || !response.ok) {
                        throw new Error(`读取下载数据失败 (HTTP ${response ? response.status : 'N/A'})`);
                    }
                    const blob = await response.blob();
                    const result = await saveBlobResilient(blob, fileName);
                    const viaSaf = (result.attempts || []).some((a) => a.mode === '系统另存为' && a.ok);
                    toastr.success(
                        viaSaf ? '已通过系统另存为保存' : `已导出到: ${result.savedPath}`,
                        '导出完成',
                    );
                } catch (error) {
                    console.error(`${TAG} 保存失败(含降级尝试明细):`, error && error.attempts, error);
                    toastr.error(
                        `保存失败(已尝试降级修复): ${msgOf(error)}`,
                        '导出失败',
                        { timeOut: 12000 },
                    );
                }
            })();
            return true;
        } catch (error) {
            console.warn(`${TAG} 接管保存请求时出错,回落原逻辑:`, msgOf(error));
            return false;
        }
    }

    // 2a. 合成 click() 路径:主插件普遍用「建 <a> → a.click()」保存,
    //     包住原型上的 click(主程序已打过补丁,这里再包一层,只处理未挂载的临时 <a>)。
    const anchorProto = window.HTMLAnchorElement && window.HTMLAnchorElement.prototype;
    if (anchorProto && typeof anchorProto.click === 'function') {
        const prevClick = anchorProto.click;
        anchorProto.click = function (...args) {
            if (!this.isConnected && takeOverAnchor(this)) {
                return undefined;
            }
            return prevClick.apply(this, args);
        };
    }

    // 2b. 真实点击路径:window 捕获阶段先于主程序 document 上的监听器,
    //     能解析出下载载荷才拦截,否则放行原逻辑。
    window.addEventListener(
        'click',
        function (event) {
            if (!supported()) return;
            const target = event.target;
            if (!target || !(target instanceof window.Element)) return;
            const anchor = target.closest && target.closest('a');
            if (!anchor || (anchor.hasAttribute && !anchor.hasAttribute('download'))) return;
            if (!takeOverAnchor(anchor)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        },
        true,
    );

    console.info(`${TAG} 安卓保存修复 v${PLUGIN_VERSION} 已就绪(原生桥包装 + <a download> 接管 + SAF 兜底)。`);
})(RBQ, jQuery, toastr);
