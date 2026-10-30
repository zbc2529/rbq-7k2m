(function(RBQ, $, toastr) {
    if (!RBQ) return console.error('RBQ Core API 缺失!');

    const MODE_ID = 'grok';

    console.info("🌸 Grok Image Generation Sub-Plugin Loaded! 🌸");




    // Helper: Calculate absolute dimensions for canvas background
    function getCanvasDimensions(ratioName, resolution) {
        const parts = ratioName.split(':').map(Number);
        const wRatio = parts[0];
        const hRatio = parts[1];
        const maxDim = resolution === "2k" ? 2048 : 1024;
        
        let w, h;
        if (wRatio >= hRatio) {
            w = maxDim;
            h = Math.round(maxDim * hRatio / wRatio);
        } else {
            h = maxDim;
            w = Math.round(maxDim * wRatio / hRatio);
        }
        if (w % 2 !== 0) w += 1;
        if (h % 2 !== 0) h += 1;
        return { w, h };
    }

    // Helper: Create offscreen canvas transparent PNG Blob
    function createTransparentBlob(width, height) {
        return new Promise((resolve) => {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, width, height);
            canvas.toBlob((blob) => {
                resolve(blob);
            }, 'image/png');
        });
    }

    // Helper: Convert blob to Base64 data URI
    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    // Helper: Convert Base64 payload back to Blob
    function base64ToBlob(base64, mimeType = 'image/png') {
        const byteCharacters = atob(base64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        return new Blob([byteArray], { type: mimeType });
    }

    // Register Grok drawing mode
    window.RBQ.api.registerMode(MODE_ID, {
        title: 'Grok 生图',
        subtitle: 'Grok 远程生图模式',
        endpointLabel: 'Grok 接口地址',
        keyLabel: 'Grok API Key',
        modelLabel: 'Grok 生图模型',
        accent: 'free',
        settingsFields: [
            {
                id: 'st-scene-trigger-grok-aspect-ratio',
                key: 'grokAspectRatio',
                label: '生图比例 (Aspect Ratio)',
                type: 'select',
                default: '1:1',
                options: [
                    { value: '1:1', text: '1:1 (正方形)' },
                    { value: '16:9', text: '16:9 (宽屏)' },
                    { value: '9:16', text: '9:16 (竖屏)' },
                    { value: '4:3', text: '4:3 (标准横屏)' },
                    { value: '3:4', text: '3:4 (标准竖屏)' },
                    { value: '3:2', text: '3:2 (相片横屏)' },
                    { value: '2:3', text: '2:3 (相片竖屏)' },
                    { value: '2:1', text: '2:1 (超宽屏)' },
                    { value: '1:2', text: '1:2 (超长竖屏)' },
                    { value: '19.5:9', text: '19.5:9 (全面屏横屏)' },
                    { value: '9:19.5', text: '9:19.5 (全面屏竖屏)' },
                    { value: '20:9', text: '20:9 (电影宽屏)' },
                    { value: '9:20', text: '9:20 (电影长竖屏)' }
                ]
            },
            {
                id: 'st-scene-trigger-grok-resolution',
                key: 'grokResolution',
                label: '画面分辨率 (Resolution)',
                type: 'select',
                default: '1k',
                options: [
                    { value: '1k', text: '1K (标准清晰度)' },
                    { value: '2k', text: '2K (超高清 - 消耗更多额度)' }
                ]
            }
        ]
    }, async (params) => {
        const { prompt, settings, connection, image, onProgress } = params;

        if (!connection.apiKey) {
            throw new Error('请先填入 Grok API Key');
        }

        // Determine target endpoint
        let baseUrl = connection.url || 'https://gcpa.rbq.my:8443/v1';
        baseUrl = baseUrl.replace(/\/$/, '');
        let targetUrl = baseUrl;
        if (!targetUrl.endsWith('/images/edits') && !targetUrl.endsWith('/images/generations')) {
            targetUrl = targetUrl + '/images/edits';
        }

        const isOfficial = targetUrl.includes('api.x.ai');

        if (onProgress) onProgress('正在准备提示词...');
        // Map Aspect Ratio and Resolution directly from settings
        const matchedRatio = settings.grokAspectRatio || '1:1';
        
        // Use raw prompt directly
        const optimizedPrompt = prompt;

        // Resolution setting directly from settings
        const resolution = settings.grokResolution || '1k';

        if (onProgress) onProgress('正在生成免密透明底图...');
        // Calculate dimensions and create transparent PNG
        const canvasDims = getCanvasDimensions(matchedRatio, resolution);
        const sizeParam = `${canvasDims.w}x${canvasDims.h}`;
        const transparentBlob = await createTransparentBlob(canvasDims.w, canvasDims.h);

        let response;
        if (onProgress) onProgress('正在与 Grok 建立连接...');

        if (isOfficial) {
            // Official xAI endpoint expects application/json
            const base64Data = await blobToBase64(transparentBlob);
            const jsonBody = {
                model: connection.model || 'grok-imagine-image-quality',
                prompt: optimizedPrompt,
                image: {
                    type: 'image_url',
                    url: base64Data
                },
                aspect_ratio: matchedRatio,
                resolution: resolution,
                n: 1,
                response_format: 'b64_json' // Prefer b64_json directly to avoid CORS issues downloading from CDN
            };

            response = await fetch(targetUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${connection.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(jsonBody)
            });
        } else {
            // Custom proxies (e.g. gcpa.rbq.my) expect multipart/form-data
            const formData = new FormData();
            formData.append('image', transparentBlob, 'transparent.png');
            formData.append('prompt', optimizedPrompt);
            formData.append('model', connection.model || 'grok-imagine-image-quality');
            formData.append('n', '1');
            formData.append('size', sizeParam);
            formData.append('aspect_ratio', matchedRatio);
            formData.append('resolution', resolution);

            response = await fetch(targetUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${connection.apiKey}`
                },
                body: formData
            });
        }

        if (!response.ok) {
            let errMsg = `Grok 接口错误 (${response.status}: ${response.statusText})`;
            try {
                const errJson = await response.json();
                if (errJson?.error?.message) {
                    errMsg = errJson.error.message;
                } else if (errJson?.error) {
                    errMsg = typeof errJson.error === 'string' ? errJson.error : JSON.stringify(errJson.error);
                }
            } catch (e) {
                try {
                    const txt = await response.text();
                    if (txt) errMsg += ` - ${txt}`;
                } catch (e2) {}
            }
            throw new Error(errMsg);
        }

        if (onProgress) onProgress('正在接收并处理生成结果...');
        const data = await response.json();
        const firstDataItem = data?.data?.[0];

        if (!firstDataItem) {
            throw new Error('Grok 返回了无效的数据结构 (Missing data array)');
        }

        let resultBlob;
        if (typeof firstDataItem.b64_json === 'string' && firstDataItem.b64_json) {
            resultBlob = base64ToBlob(firstDataItem.b64_json);
        } else if (typeof firstDataItem.url === 'string' && firstDataItem.url) {
            // Try fetching image from URL
            const imgRes = await fetch(firstDataItem.url);
            if (!imgRes.ok) {
                throw new Error(`无法从图片链接下载结果: ${firstDataItem.url}`);
            }
            resultBlob = await imgRes.blob();
        } else {
            throw new Error('Grok 返回数据中不包含图像 Base64 或链接。');
        }

        return { blob: resultBlob };
    });

    // --- UI model dropdown sync ---
    function syncUiModelList() {
        const modeSelect = document.getElementById('st-scene-trigger-current-mode');
        const modelSelect = document.getElementById('st-scene-trigger-modal-model');
        if (!modeSelect || !modelSelect || modeSelect.value !== MODE_ID) return;
        if (modelSelect.querySelector('option[data-source="grok"]')) return;

        console.info('[Grok-Draw] Injecting model list...');
        modelSelect.innerHTML = '';
        const opt = document.createElement('option');
        opt.value = 'grok-imagine-image-quality';
        opt.textContent = 'grok-imagine-image-quality (当前可用生图模型)';
        opt.setAttribute('data-source', 'grok');
        modelSelect.appendChild(opt);
        modelSelect.value = 'grok-imagine-image-quality';
    }
    setInterval(syncUiModelList, 1000);

})(window.RBQ, jQuery, toastr);
