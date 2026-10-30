(function(RBQ, $, toastr) {
    if (!RBQ) return console.error('[Character Workshop] RBQ Core API missing');

    const PLUGIN_NAME = '角色工坊';
    const VERSION = '2.2.40';
    const CW_KEY = '_characterWorkshop';
    const SDT_KEY = '_smartDrawTrigger';
    const MCC_KEY = '_multiCharComposer';

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

    // ══════════════════════════════════════════════════════════
    //  Utilities
    // ══════════════════════════════════════════════════════════
    function uid(p = 'cw') {
        return `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    }
    function esc(s) {
        if (s == null) return '';
        return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
    }
    function toggleTag(current, tag) {
        if (!current) return tag;
        const list = current.split(',').map(s => s.trim()).filter(Boolean);
        const lo = tag.toLowerCase();
        const has = list.some(t => t.toLowerCase() !== lo);
        return has ? list.filter(t => t.toLowerCase() !== lo).join(', ') : [...list, tag].join(', ');
    }
    function sanitizePromptSegment(s) {
        if (!s) return '';
        return s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().replace(/^[,;\s]+|[,;\s]+$/g, '');
    }
    function cleanLorebookTags(rawText) {
        if (!rawText) return '';
        let s = String(rawText).trim();
        // 1. 剥离行首注释标题，例如 "- 自慰:", "【公主抱】:", "## 动作", "1. ", "- 动作 (哺乳):"
        // 注意：严防误伤 3.0:: 等 NAI 权重语法，且标题内绝不能包含逗号
        s = s.replace(/^[#\-\*\s]*[^,\n:：]{1,40}(?<!:):(?!:)\s*/gm, '');
        // 2. 剥离中段常见的中文标签头 (如 核心特征:, 服饰- 上身服饰:, 身份:, 拓展资料区- 道具/武器:)
        s = s.replace(/(身份|核心特征|固有特征|外貌特征|服饰|上身服饰|下身服饰|拓展资料区|道具|武器|特征|外貌|体态|服装|饰品|装备|常服|战斗服|泳装|睡衣|私服|校服|正装)[-_—－\s]*(上身|下身|头部|面部|手部|足部|道具|武器|服饰)?[:：]\s*/g, ', ');
        // 3. 将斜杠同义词转为逗号
        s = s.replace(/\s*\/\s*/g, ', ');
        // 4. 去掉带有中文的括号说明
        s = s.replace(/[（\(][^\)）]*[\u4e00-\u9fa5][^\)）]*[）\)]/g, '');
        // 5. 保护 NAI 的 :: 权重语法，将孤立冒号转为逗号
        s = s.replace(/::/g, '__DOUBLE_COLON__');
        s = s.replace(/[:：]/g, ', ');
        s = s.replace(/__DOUBLE_COLON__/g, '::');
        // 6. 彻底剔除中文字符
        s = s.replace(/[\u4e00-\u9fa5]/g, '');
        // 7. 清理残余的连接符和破折号
        s = s.replace(/(?:^|\s)-+\s*/g, ' ');
        s = s.replace(/\s*-+(?:\s|$)/g, ' ');
        // 8. 规范标点符号
        s = s.replace(/[-_]{2,}/g, '_');
        s = s.replace(/[,;，；\s]+,/g, ', ');
        s = s.replace(/^[#\-\*\s,;]+|[,\s;]+$/g, '');
        return s.trim();
    }

    // ══════════════════════════════════════════════════════════
    //  Coordinate System (5x5 Stage Grid & Continuous Float Coords)
    // ══════════════════════════════════════════════════════════
    const COLS = ['A', 'B', 'C', 'D', 'E'];
    const ROWS = ['1', '2', '3', '4', '5'];
    const COORD_LABELS = {
        A1: '左上远景', B1: '偏左远景', C1: '居中远景', D1: '偏右远景', E1: '右上远景',
        A2: '左上方',   B2: '左后方',   C2: '正后方',   D2: '右后方',   E2: '右上方',
        A3: '极左侧',   B3: '左侧主角', C3: '画面正中', D3: '右侧主角', E3: '极右侧',
        A4: '左下方',   B4: '左前方',   C4: '正前方',   D4: '右前方',   E4: '右下方',
        A5: '左下特写', B5: '偏左特写', C5: '中央特写', D5: '偏右特写', E5: '右下特写'
    };

    function cwParseCoord(raw) {
        if (!raw) return { x: 0.5, y: 0.5 };
        if (typeof raw === 'object') {
            if ('x' in raw && 'y' in raw) {
                const x = Math.max(0, Math.min(1, parseFloat(raw.x) || 0.5));
                const y = Math.max(0, Math.min(1, parseFloat(raw.y) || 0.5));
                return { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) };
            }
            if (Array.isArray(raw) && raw.length >= 2) {
                const x = Math.max(0, Math.min(1, parseFloat(raw[0]) || 0.5));
                const y = Math.max(0, Math.min(1, parseFloat(raw[1]) || 0.5));
                return { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) };
            }
        }
        if (typeof raw === 'string') {
            const s = raw.trim();
            const gridMatch = s.toUpperCase().match(/^([A-E])([1-5])$/);
            if (gridMatch) {
                const col = gridMatch[1].charCodeAt(0) - 65; // A=0, B=1, C=2, D=3, E=4
                const row = parseInt(gridMatch[2], 10) - 1; // 1=0, 2=1, 3=2, 4=3, 5=4
                const x = Number(((col + 0.5) / 5).toFixed(2));
                const y = Number(((row + 0.5) / 5).toFixed(2));
                return { x, y };
            }
            const numMatch = s.match(/([0-1]?(?:\.\d+)?|\d+)[,\s:x/]+([0-1]?(?:\.\d+)?|\d+)/);
            if (numMatch) {
                let x = parseFloat(numMatch[1]);
                let y = parseFloat(numMatch[2]);
                if (!isNaN(x) && !isNaN(y)) {
                    if (x > 1 && x <= 5) x = (x - 0.5) / 5;
                    if (y > 1 && y <= 5) y = (y - 0.5) / 5;
                    return { x: Number(Math.max(0, Math.min(1, x)).toFixed(2)), y: Number(Math.max(0, Math.min(1, y)).toFixed(2)) };
                }
            }
        }
        return { x: 0.5, y: 0.5 };
    }

    function formatCoordOutput(coord) {
        if (!coord) return '0.50,0.50';
        if (typeof coord === 'string') {
            const s = coord.trim();
            if (/^[A-E][1-5]$/i.test(s)) return s.toUpperCase();
            const pt = cwParseCoord(s);
            return `${pt.x.toFixed(2)},${pt.y.toFixed(2)}`;
        }
        if (typeof coord === 'object') {
            const pt = cwParseCoord(coord);
            return `${pt.x.toFixed(2)},${pt.y.toFixed(2)}`;
        }
        return '0.50,0.50';
    }

    function formatCenterDisplay(coord) {
        if (!coord) return 'X:0.50, Y:0.50';
        if (typeof coord === 'string') {
            const s = coord.trim().toUpperCase();
            if (/^[A-E][1-5]$/.test(s)) return s;
        }
        const pt = cwParseCoord(coord);
        return `X:${pt.x.toFixed(2)}, Y:${pt.y.toFixed(2)}`;
    }

    function coordLabel(c) {
        if (!c) return '正中 (C3)';
        if (typeof c === 'string') {
            const u = c.trim().toUpperCase();
            if (COORD_LABELS[u]) return `${u} (${COORD_LABELS[u]})`;
        }
        const pt = cwParseCoord(c);
        const colIdx = Math.max(0, Math.min(4, Math.floor(pt.x * 5)));
        const rowIdx = Math.max(0, Math.min(4, Math.floor(pt.y * 5)));
        const gridKey = COLS[colIdx] + ROWS[rowIdx];
        return `X:${pt.x.toFixed(2)}, Y:${pt.y.toFixed(2)} (${COORD_LABELS[gridKey] || gridKey})`;
    }

    const COLORS = [
        { hex: '#38bdf8', bg: 'rgba(56,189,248,.15)', bdr: 'rgba(56,189,248,.5)' },
        { hex: '#f472b6', bg: 'rgba(244,114,182,.15)', bdr: 'rgba(244,114,182,.5)' },
        { hex: '#4ade80', bg: 'rgba(74,222,128,.15)',  bdr: 'rgba(74,222,128,.5)' },
        { hex: '#fbbf24', bg: 'rgba(251,191,36,.15)',  bdr: 'rgba(251,191,36,.5)' },
        { hex: '#c084fc', bg: 'rgba(192,132,252,.15)', bdr: 'rgba(192,132,252,.5)' },
        { hex: '#fb7185', bg: 'rgba(251,113,133,.15)', bdr: 'rgba(251,113,133,.5)' },
    ];

    // ══════════════════════════════════════════════════════════
    //  Data Access Layer: Direct SDT characterProfiles Binding
    // ══════════════════════════════════════════════════════════
    let dossierScope = 'chat'; // 'chat' (仅当前会话) | 'all' (角色库：全部会话档案) | 'lorebook'
    let dossierGlobalOnly = false; // 角色库视图中只看⭐全局角色
    let isDossierBatchMode = false;
    const selectedDossierNames = new Set();

    function getChatKey() {
        // 1. 优先尝试 ST 全局 getCurrentChatId()
        try {
            if (typeof window.getCurrentChatId === 'function') {
                const id = window.getCurrentChatId();
                if (id) return String(id);
            }
        } catch (_e) { /* noop */ }
        // 2. 尝试 SillyTavern context (与 smart-draw-trigger 格式完全一致)
        try {
            const ctx = window.SillyTavern?.getContext?.();
            if (ctx?.chatId) return String(ctx.chatId);
            if (ctx?.characterId !== undefined) return `char-${ctx.characterId}`;
            if (ctx?.groupId !== undefined) return `group-${ctx.groupId}`;
        } catch (_e) { /* noop */ }
        // 3. 回退：从聊天元数据元素中读取
        try {
            const chatEl = document.querySelector('#chat');
            const chatFile = chatEl?.closest?.('[chat_id]')?.getAttribute('chat_id') || chatEl?.closest?.('[data-chat-file]')?.dataset?.chatFile;
            if (chatFile) return String(chatFile);
        } catch (_e) { /* noop */ }
        return '_global';
    }

    function getSdtStore() {
        const s = RBQ.api.getSettings();
        if (!s[SDT_KEY] && s['_smartDrawTriggerSettings']) {
            s[SDT_KEY] = s['_smartDrawTriggerSettings'];
        }
        if (!s[SDT_KEY]) s[SDT_KEY] = {};
        s['_smartDrawTriggerSettings'] = s[SDT_KEY];
        return s[SDT_KEY];
    }

    /** SDT 「启用角色外貌记忆」. Undefined = SDT has not filled its defaults yet (new installs default ON since SDT 6.5.48). */
    function isSdtCharacterMemoryOn() {
        return getSdtStore().characterMemoryEnabled !== false;
    }

    /** 「一键打开」: prefer SDT's API (also syncs its checkbox so 「💾 保存智能触发器设置」 can't write the old value back). */
    function enableSdtCharacterMemory() {
        if (typeof RBQ?.api?.setCharacterMemoryEnabled === 'function') {
            RBQ.api.setCharacterMemoryEnabled(true);
        } else {
            getSdtStore().characterMemoryEnabled = true;
            RBQ.api.saveSettings();
            const input = document.getElementById('rbq-sdt-char-memory');
            if (input) input.checked = true;
            document.getElementById('rbq-sdt-char-memory-field')?.setAttribute('aria-checked', 'true');
        }
        return isSdtCharacterMemoryOn();
    }

    function renderMemoryOffBanner() {
        if (isSdtCharacterMemoryOn()) return '';
        return `<div class="cw-memory-off-banner" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:6px 10px 0;padding:8px 12px;border-radius:8px;background:rgba(251,146,60,0.12);border:1px solid rgba(251,146,60,0.5);color:#fdba74;font-size:12.5px">
            <span style="flex:1;min-width:200px">⚠️ 「角色外貌记忆」没有打开：正文生图不会用这里的角色档案、⭐全局角色和锁定。这里的编辑照样会保存，打开后才生效。</span>
            <button type="button" class="cw-btn sm cy" id="cw-enable-memory-btn"><i class="fa-solid fa-power-off"></i> 一键打开</button>
        </div>`;
    }

    function isJunkCharacterName(name) {
        if (!name || typeof name !== 'string') return true;
        const trimmed = name.trim();
        if (!trimmed) return true;
        if (/^(?:Panel|画格|Frame|コマ|Shot)\s*\d+/i.test(trimmed)) return true;
        if (/\b(?:顶部横通栏|中段右侧|中段左侧|底部核心|底部宽画格|全页单格|横通栏|纵长长格|插入格|交代格|主格|反应格|拟声词格|静默格|天头出血)\b/.test(trimmed)) return true;
        if (/^(?:top|middle|bottom|left|right|inset|wide|focal|reaction|establishing)\s+(?:panel|shot)/i.test(trimmed)) return true;
        if (/^(?:scenery|establishing|narrative|sound\s*effects?|sfx|none|null|undefined|blank|empty)$/i.test(trimmed)) return true;
        if (/\b(?:BubbleType|SFX|Layout|Text)[ \t]*[:：]/i.test(trimmed)) return true;
        return false;
    }

    function ensureProfileBucket() {
        const s = RBQ.api.getSettings();
        if (!s[SDT_KEY] && s['_smartDrawTriggerSettings']) {
            s[SDT_KEY] = s['_smartDrawTriggerSettings'];
        }
        if (!s[SDT_KEY]) s[SDT_KEY] = {};
        s['_smartDrawTriggerSettings'] = s[SDT_KEY];
        if (!s[SDT_KEY].characterProfiles) s[SDT_KEY].characterProfiles = {};
        const ck = getChatKey();
        if (!s[SDT_KEY].characterProfiles[ck]) s[SDT_KEY].characterProfiles[ck] = {};
        const bucket = s[SDT_KEY].characterProfiles[ck];
        // 自动净化垃圾画格键
        let changed = false;
        for (const k of Object.keys(bucket)) {
            if (isJunkCharacterName(k)) {
                delete bucket[k];
                changed = true;
            }
        }
        if (changed) RBQ.api.saveSettings();
        return bucket;
    }

    function downloadJsonFile(data, filename) {
        try {
            const jsonStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
            const blob = new Blob([jsonStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 3000);
            return true;
        } catch (e) {
            console.error(`[${PLUGIN_NAME}] 导出 JSON 失败:`, e);
            return false;
        }
    }

    function getCurrentChatProfiles() {
        const sdt = getSdtStore();
        const ck = getChatKey();
        const profiles = (sdt.characterProfiles && sdt.characterProfiles[ck]) || {};
        let changed = false;
        for (const k of Object.keys(profiles)) {
            if (isJunkCharacterName(k)) {
                delete profiles[k];
                changed = true;
            }
        }
        if (changed) RBQ.api.saveSettings();
        return profiles;
    }


    /** Locked base/outfit (or any locked wardrobe preset) — protect from unlocked-clone overwrite. */
    function isProfileContentLocked(p) {
        if (!p || typeof p !== 'object') return false;
        if (p.baseLocked || p.isBaseLocked || p.outfitLocked || p.isOutfitLocked) return true;
        return Array.isArray(p.wardrobe) && p.wardrobe.some(w => w && w.locked);
    }

    /** Same archive identity across chats: matching createdAt. Legacy (missing) never auto-matches. */
    function isSameProfileIdentity(a, b) {
        const ca = Number(a?.createdAt || 0);
        const cb = Number(b?.createdAt || 0);
        return ca > 0 && cb > 0 && ca === cb;
    }

    /** Global list pick: locked > unlocked; else oldest createdAt; same identity → newest updatedAt. */
    function shouldPreferGlobalProfile(candidate, current) {
        if (!current) return true;
        // A copy imported from a ⭐全局角色 is never the archive itself: real archives win over it.
        const candImported = !!candidate?.importedFromGlobal;
        const curImported = !!current?.importedFromGlobal;
        if (candImported !== curImported) return !candImported;
        const candLocked = isProfileContentLocked(candidate);
        const curLocked = isProfileContentLocked(current);
        if (candLocked !== curLocked) return candLocked;
        const candCreated = Number(candidate.createdAt || 0);
        const curCreated = Number(current.createdAt || 0);
        if (candCreated > 0 && curCreated > 0 && candCreated !== curCreated) {
            return candCreated < curCreated;
        }
        if (candCreated > 0 && curCreated > 0 && candCreated === curCreated) {
            return Number(candidate.updatedAt || 0) > Number(current.updatedAt || 0);
        }
        // Legacy / missing createdAt: prefer older updatedAt so a fresh unlocked clone does not win.
        const candUpdated = Number(candidate.updatedAt || 0);
        const curUpdated = Number(current.updatedAt || 0);
        if (candUpdated > 0 && curUpdated > 0 && candUpdated !== curUpdated) {
            return candUpdated < curUpdated;
        }
        if (candCreated > 0 && curCreated === 0) return true;
        return false;
    }

    /** Global sync: same createdAt only; legacy (no createdAt) may still sync; never clobber locked with unlocked.
     *  `source` is the archive being saved (lock intent); do not use merged target which may retain old lock flags. */
    function shouldSyncGlobalCopy(existing, incoming, source = incoming) {
        if (!existing || typeof existing !== 'object') return false;
        if (isProfileContentLocked(existing) && !isProfileContentLocked(source)) return false;
        const ca = Number(existing.createdAt || 0);
        const cb = Number(incoming?.createdAt || 0);
        if (ca > 0 && cb > 0) return ca === cb;
        // Legacy target without createdAt: allow name-based sync (locked guard above). Stamp identity on write.
        if (ca === 0) return true;
        // Target has identity but incoming does not match / lacks one: refuse.
        return false;
    }

    // ══ 三层角色：角色库(全部会话档案) / ⭐全局角色(所有会话常驻发给 LLM) / 当前会话角色 ══
    // sdt.globalCharacters = { [name]: { profile, setAt, updatedAt } }。只由角色工坊手动写入，SDT 解析只读。
    function getGlobalCharacterStore() {
        const sdt = getSdtStore();
        if (!sdt.globalCharacters || typeof sdt.globalCharacters !== 'object' || Array.isArray(sdt.globalCharacters)) sdt.globalCharacters = {};
        return sdt.globalCharacters;
    }

    function isGlobalCharacter(name) {
        if (!name) return false;
        const g = getSdtStore().globalCharacters;
        return !!(g && typeof g === 'object' && g[name] && g[name].profile && typeof g[name].profile === 'object');
    }

    function getGlobalCharacterProfile(name) {
        return isGlobalCharacter(name) ? getSdtStore().globalCharacters[name].profile : null;
    }

    function getGlobalCharacterNames() {
        const g = getSdtStore().globalCharacters;
        return g && typeof g === 'object' ? Object.keys(g).filter(isGlobalCharacter) : [];
    }

    function cloneGlobalSnapshot(p) {
        const c = JSON.parse(JSON.stringify(p || {}));
        for (const k of Object.keys(c)) if (/^manga[A-Z]/.test(k)) delete c[k]; // per-chat floor history
        delete c.importedFromGlobal;
        return c;
    }

    /** Mark/unmark a 角色库 character as 全局角色. Source = explicit profile, else preferred archive (locked > earliest). */
    function setGlobalCharacter(name, enabled, sourceProfile = null) {
        if (!name || isJunkCharacterName(name)) return false;
        const store = getGlobalCharacterStore();
        if (!enabled) {
            if (!store[name]) return false;
            delete store[name];
            RBQ.api.saveSettings();
            return true;
        }
        const src = sourceProfile || getAllGlobalProfiles()[name];
        if (!src || typeof src !== 'object') return false;
        const now = Date.now();
        store[name] = { profile: cloneGlobalSnapshot({ ...src, displayName: src.displayName || name }), setAt: store[name]?.setAt || now, updatedAt: now };
        RBQ.api.saveSettings();
        return true;
    }

    // ── 备份：角色库视图的「导出备份」带上⭐全局角色本体（含没有任何会话副本的全局角色），「导入文件」可恢复 ──
    /** { [name]: { profile, setAt, updatedAt } } for every valid ⭐全局角色 (optionally only `onlyNames`). */
    function buildGlobalCharactersBackup(onlyNames = null) {
        const store = getSdtStore().globalCharacters;
        const out = {};
        for (const n of getGlobalCharacterNames()) {
            if (onlyNames && !onlyNames.has(n)) continue;
            const e = store[n];
            out[n] = { profile: JSON.parse(JSON.stringify(e.profile)), setAt: e.setAt || null, updatedAt: e.updatedAt || null };
        }
        return out;
    }

    /** 「导出备份」payload. Only the 角色库 scope carries globalCharacters/globalNames; other scopes stay as before. */
    function buildDossierBackupPayload(scope, profiles) {
        const characters = JSON.parse(JSON.stringify(profiles || {}));
        const payload = { version: '1.0', type: 'rbq-character-dossier-backup', scope, exportedAt: new Date().toISOString(), count: Object.keys(characters).length, characters };
        if (scope === 'all') {
            const globalCharacters = buildGlobalCharactersBackup();
            const globalNames = Object.keys(globalCharacters);
            if (globalNames.length) {
                payload.version = '1.1';
                payload.globalCharacters = globalCharacters;
                payload.globalNames = globalNames;
                payload.count = new Set([...Object.keys(characters), ...globalNames]).size;
            }
        }
        return payload;
    }

    /** Restore ⭐全局角色 from a backup's globalCharacters (absent in old backups → no-op).
     *  Same-name globals whose body differs are overwritten only after one confirm; cancel keeps the existing ones. */
    function restoreGlobalCharactersFromBackup(raw, confirmFn = (m) => confirm(m)) {
        const result = { restored: [], skipped: [], unchanged: [] };
        const src = raw && typeof raw === 'object' ? raw.globalCharacters : null;
        if (!src || typeof src !== 'object' || Array.isArray(src)) return result;
        const incoming = [];
        for (const [k, entry] of Object.entries(src)) {
            if (!entry || typeof entry !== 'object') continue;
            const prof = (entry.profile && typeof entry.profile === 'object' && !Array.isArray(entry.profile)) ? entry.profile : null;
            if (!prof) continue;
            const name = String(k || prof.displayName || '').trim();
            if (!name || isJunkCharacterName(name)) continue;
            incoming.push({ name, entry, profile: cloneGlobalSnapshot({ ...prof, displayName: prof.displayName || name }) });
        }
        if (!incoming.length) return result;
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        const conflicts = incoming.filter(x => isGlobalCharacter(x.name) && !same(cloneGlobalSnapshot(getGlobalCharacterProfile(x.name)), x.profile));
        let overwrite = true;
        if (conflicts.length) {
            overwrite = !!confirmFn(`备份里的⭐全局角色${conflicts.map(x => `「${x.name}」`).join('')}和现有的同名全局角色内容不同。\n确定用备份覆盖现有的全局角色吗？\n（取消：保留现有的这 ${conflicts.length} 位，其余内容照常导入）`);
        }
        const store = getGlobalCharacterStore();
        const now = Date.now();
        for (const x of incoming) {
            if (isGlobalCharacter(x.name) && same(cloneGlobalSnapshot(getGlobalCharacterProfile(x.name)), x.profile)) { result.unchanged.push(x.name); continue; }
            if (isGlobalCharacter(x.name) && !overwrite) { result.skipped.push(x.name); continue; }
            store[x.name] = { profile: x.profile, setAt: Number(x.entry.setAt) > 0 ? Number(x.entry.setAt) : (store[x.name]?.setAt || now), updatedAt: now };
            result.restored.push(x.name);
        }
        if (result.restored.length) RBQ.api.saveSettings();
        return result;
    }

    /** Parse an 「导入文件」 JSON: profiles go into the current chat (unchanged behaviour); ⭐全局角色 restored if present. */
    function importDossierBackupData(raw, fileName = '', confirmFn = (m) => confirm(m)) {
        let importedCount = 0;
        const baseName = String(fileName || '').replace(/\.json$/i, '');
        if (!raw || typeof raw !== 'object') return { importedCount, globals: { restored: [], skipped: [], unchanged: [] } };
        const globals = restoreGlobalCharactersFromBackup(raw, confirmFn);
        if (raw.character && typeof raw.character === 'object') {
            const char = raw.character;
            const charName = char.displayName || char.name || baseName;
            saveProfile(charName, char, 'chat');
            importedCount = 1;
        } else if (raw.characters && typeof raw.characters === 'object') {
            if (Array.isArray(raw.characters)) {
                for (const char of raw.characters) {
                    if (char && typeof char === 'object') {
                        const charName = char.displayName || char.name;
                        if (charName) {
                            saveProfile(charName, char, 'chat');
                            importedCount++;
                        }
                    }
                }
            } else {
                for (const [k, char] of Object.entries(raw.characters)) {
                    if (char && typeof char === 'object') {
                        const charName = char.displayName || k;
                        saveProfile(charName, char, 'chat');
                        importedCount++;
                    }
                }
            }
        } else if (raw.baseTags !== undefined || raw.wardrobe !== undefined || raw.nameTag !== undefined) {
            const charName = raw.displayName || raw.name || baseName;
            saveProfile(charName, raw, 'chat');
            importedCount = 1;
        } else if (!raw.globalCharacters && Object.keys(raw).length > 0) {
            for (const [k, v] of Object.entries(raw)) {
                if (v && typeof v === 'object' && (v.baseTags !== undefined || v.wardrobe !== undefined || v.displayName)) {
                    const charName = v.displayName || k;
                    saveProfile(charName, v, 'chat');
                    importedCount++;
                }
            }
        }
        return { importedCount, globals };
    }

    function uniqueWardrobeItemName(wardrobe, name) {
        const taken = new Set((Array.isArray(wardrobe) ? wardrobe : []).map(w => String(w?.name || '')));
        if (!taken.has(name)) return name;
        let i = 2;
        while (taken.has(`${name} ${i}`)) i++;
        return `${name} ${i}`;
    }

    /** Every global outfit locked + marked fromGlobal; a current outfit missing from the wardrobe is seeded as a locked 「默认服装」. */
    function buildLockedGlobalWardrobe(copy) {
        const wardrobe = (Array.isArray(copy.wardrobe) ? copy.wardrobe : []).filter(w => w && typeof w === 'object')
            .map(w => ({ ...w, locked: true, fromGlobal: true }));
        const current = String(copy.currentOutfit || '').trim();
        if (current && !wardrobe.some(w => (w.outfit || w.tags || '') === copy.currentOutfit)) {
            const seeded = { id: `w-g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                name: uniqueWardrobeItemName(wardrobe, '默认服装'), outfit: copy.currentOutfit, triggers: [], locked: true, fromGlobal: true, createdAt: Date.now() };
            wardrobe.unshift(seeded);
            copy.currentOutfitId = seeded.id;
        }
        copy.wardrobe = wardrobe;
        if (copy.currentOutfitId && !wardrobe.some(w => w.id === copy.currentOutfitId)) {
            const worn = wardrobe.find(w => (w.outfit || w.tags || '') === copy.currentOutfit);
            if (worn) copy.currentOutfitId = worn.id; else delete copy.currentOutfitId;
        }
        return copy;
    }

    /** Copy of a global character for the current chat: same createdAt, base + every outfit locked (new outfits may still be added). */
    function buildImportedGlobalCopy(name, source) {
        const copy = cloneGlobalSnapshot(source);
        copy.displayName = copy.displayName || name;
        copy.baseLocked = true;
        copy.isBaseLocked = true;
        copy.outfitLocked = true;
        copy.isOutfitLocked = true;
        buildLockedGlobalWardrobe(copy);
        if (!Number(copy.createdAt || 0)) copy.createdAt = Date.now();
        copy.importedFromGlobal = { name, at: Date.now() };
        copy.updatedAt = Date.now();
        return copy;
    }

    // ── 别名冲突：两个⭐全局角色共用姓名/别名时，解析不会导入任何一位（避免认错人）。 ──
    function getCharacterIdentityTerms(name, p) {
        const raw = [name, p?.displayName, ...(Array.isArray(p?.aliases) ? p.aliases : String(p?.aliases || '').split(/[,，、;；\n]+/))];
        return [...new Set(raw.map(v => String(v || '').normalize('NFKC').trim().toLowerCase()).filter(Boolean))];
    }
    /** [{ other, term }] where this character's names/aliases collide with another ⭐全局角色. */
    function findGlobalAliasConflicts(name, profile = null) {
        const mine = getCharacterIdentityTerms(name, profile || getGlobalCharacterProfile(name) || getAllGlobalProfiles()[name]);
        const out = [];
        for (const other of getGlobalCharacterNames()) {
            if (other === name) continue;
            const theirs = new Set(getCharacterIdentityTerms(other, getGlobalCharacterProfile(other)));
            for (const t of mine) if (theirs.has(t)) out.push({ other, term: t });
        }
        return out;
    }
    function warnGlobalAliasConflicts(name, profile = null) {
        const conflicts = findGlobalAliasConflicts(name, profile);
        if (!conflicts.length) return false;
        const text = conflicts.map(c => `「${c.term}」与⭐全局角色「${c.other}」重复`).join('；');
        try { toastr.warning(`${text}。剧情里出现这个名字时不会自动导入任何一位，请改掉其中一个别名。`, PLUGIN_NAME, { timeOut: 9000 }); } catch (_e) { /* noop */ }
        return true;
    }

    // ── [产品决定 B] 角色库里保存⭐全局角色时，可选同步到已导入的各会话副本 ──
    // 更新人设/身份字段和来自全局的服装；各会话自己新增的服装保留。回退：让 isImportedGlobalSyncPromptEnabled() 返回 false。
    function isImportedGlobalSyncPromptEnabled() { return true; }
    function getImportedGlobalCopies(name) {
        const sdt = getSdtStore();
        const out = [];
        for (const [chatKey, dict] of Object.entries(sdt.characterProfiles || {})) {
            if (!dict || typeof dict !== 'object') continue;
            for (const [k, v] of Object.entries(dict)) {
                if (v && typeof v === 'object' && v.importedFromGlobal && (v.importedFromGlobal.name || k) === name) out.push({ chatKey, key: k, profile: v });
            }
        }
        return out;
    }
    function countImportedGlobalCopies(name) { return getImportedGlobalCopies(name).length; }
    /** Returns true if the user wants the copies updated (asked only when there are any). */
    function askSyncImportedGlobalCopies(name) {
        if (!isImportedGlobalSyncPromptEnabled() || !isGlobalCharacter(name)) return false;
        const n = countImportedGlobalCopies(name);
        if (!n) return false;
        return confirm(`同时更新已导入的 ${n} 个对话吗？\n（这些对话里「${name}」的人设和来自全局的服装会改成这次保存的版本；各对话自己新增的服装保留。选「取消」则只改全局角色本体，已导入的对话保持原样）`);
    }
    function syncGlobalToImportedCopies(name, newGlobal, oldGlobal = null) {
        if (!newGlobal || typeof newGlobal !== 'object') return 0;
        const oldIds = new Set((Array.isArray(oldGlobal?.wardrobe) ? oldGlobal.wardrobe : []).map(w => w && w.id).filter(Boolean));
        const fresh = buildLockedGlobalWardrobe(cloneGlobalSnapshot(newGlobal));
        let count = 0;
        for (const { profile: copy } of getImportedGlobalCopies(name)) {
            for (const f of ['displayName', 'nameTag', 'nameTagSource', 'aliases', 'baseTags', 'previousBaseTags', 'avatarUrl']) {
                if (Object.hasOwn(fresh, f)) copy[f] = JSON.parse(JSON.stringify(fresh[f])); else delete copy[f];
            }
            const own = (Array.isArray(copy.wardrobe) ? copy.wardrobe : []).filter(w => w && !w.fromGlobal && !oldIds.has(w.id));
            const wornWasGlobal = !own.some(w => w.id === copy.currentOutfitId);
            copy.wardrobe = [...JSON.parse(JSON.stringify(fresh.wardrobe || [])), ...own];
            if (wornWasGlobal) {
                const keep = copy.wardrobe.find(w => w.fromGlobal && w.id === copy.currentOutfitId);
                const worn = keep || copy.wardrobe.find(w => w.id === fresh.currentOutfitId) || copy.wardrobe.find(w => w.fromGlobal) || null;
                if (worn) { copy.currentOutfitId = worn.id; copy.currentOutfit = worn.outfit || worn.tags || ''; copy.outfitLocked = copy.isOutfitLocked = !!worn.locked; }
                else { delete copy.currentOutfitId; copy.currentOutfit = fresh.currentOutfit || ''; }
            }
            copy.importedFromGlobal = { ...(copy.importedFromGlobal || {}), name, syncedAt: Date.now() };
            copy.updatedAt = Date.now();
            count++;
        }
        if (count) RBQ.api.saveSettings();
        return count;
    }

    function importGlobalCharacterToCurrentChat(name) {
        const src = getGlobalCharacterProfile(name);
        if (!src) return false;
        const bucket = ensureProfileBucket();
        bucket[name] = buildImportedGlobalCopy(name, src);
        RBQ.api.saveSettings();
        return true;
    }

    function getAllGlobalProfiles() {
        const sdt = getSdtStore();
        const fallback = {};
        let changed = false;
        if (sdt.characterProfiles && typeof sdt.characterProfiles === 'object') {
            for (const chatDict of Object.values(sdt.characterProfiles)) {
                if (chatDict && typeof chatDict === 'object') {
                    for (const [k, v] of Object.entries(chatDict)) {
                        if (isJunkCharacterName(k)) {
                            delete chatDict[k];
                            changed = true;
                            continue;
                        }
                        if (v && typeof v === 'object') {
                            if (!fallback[k] || shouldPreferGlobalProfile(v, fallback[k])) {
                                fallback[k] = v;
                            }
                        }
                    }
                }
            }
        }
        if (changed) RBQ.api.saveSettings();
        return fallback;
    }

    let _cachedDoujinProfiles = null;
    let _cachedDoujinSourceId = null;

    function splitCharAndOutfit(title) {
        let t = String(title || '').trim();
        const bracketRegex = /[\s\-_—－]*[\(（\[【]([^\)）\]】]+)[\)）\]】]\s*$/;
        const bm = t.match(bracketRegex);
        if (bm && bm.index > 0) {
            const potentialOutfit = bm[1].trim();
            const charName = t.slice(0, bm.index).trim();
            if (charName.length >= 2 && /(服|装|立绘|衣|裙|袍|制服|校服|泳装|比基尼|睡衣|兔女郎|内衣|战服|和服|旗袍|私服|女仆|礼服|便服|日常|战斗|常服|bikini|swimsuit|pajamas|maid|bunny|casual|battle|combat|underwear|dress|costume)/i.test(potentialOutfit)) {
                return { charName, outfitName: potentialOutfit };
            }
        }
        const sepRegex = /[\s\-_—－]+([\u4e00-\u9fa5a-zA-Z0-9_\-]+?(?:服|装|立绘|衣|裙|袍|制服|校服|泳装|比基尼|睡衣|兔女郎|内衣|战服|和服|旗袍|私服|女仆|礼服|便服|日常|战斗|常服|bikini|swimsuit|pajamas|maid|bunny|casual|battle|combat))\s*$/i;
        const sm = t.match(sepRegex);
        if (sm && sm.index > 0) {
            const potentialOutfit = sm[1].trim();
            const charName = t.slice(0, sm.index).trim();
            if (charName.length >= 2) {
                return { charName, outfitName: potentialOutfit };
            }
        }
        return { charName: t, outfitName: '' };
    }

    function parseMultiOutfits(content) {
        const text = String(content || '').trim();
        const lines = text.split(/\r?\n/);
        const outfits = [];
        let currentOutfit = null;

        const NON_OUTFIT_REGEX = /^[-*#\s]*(角色|人物|身份|核心特征|固有特征|外貌特征|外貌|容貌|身体特征|拓展资料区|道具|武器|装备|说明|介绍|背景)/;
        const OUTFIT_KEYWORD = /(服|装|立绘|衣|裙|袍|制服|校服|泳装|比基尼|睡衣|兔女郎|内衣|战服|和服|旗袍|私服|女仆|礼服|便服|日常|战斗|常服|bikini|swimsuit|pajamas|maid|bunny|casual|battle|combat|underwear|dress|costume)/i;

        const isOutfitLine = (line) => {
            if (NON_OUTFIT_REGEX.test(line)) return { isTerminator: true };
            const m = line.match(/^[-*#\s]*(?:(?:服饰|服装|衣着|装束)[-_—－\s]*)?([【\[]?[\u4e00-\u9fa5a-zA-Z0-9_\-\/]+[\]】]?)\s*[:：]\s*(.*)$/);
            if (!m) {
                const h = line.match(/^#+\s*([^\n]+)$/) || line.match(/^[【\[]([^】\]]+)[\]\]]$/);
                if (h) {
                    const hName = h[1].trim();
                    if (NON_OUTFIT_REGEX.test(hName)) return { isTerminator: true };
                    if (OUTFIT_KEYWORD.test(hName)) return { name: hName, content: '' };
                    return null;
                }
                return null;
            }
            const name = m[1].replace(/^[【\[（\(]+|[】\]）\)]+$/g, '').trim();
            if (!OUTFIT_KEYWORD.test(name)) return null;
            return { name, content: m[2].trim() };
        };

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;
            const oInfo = isOutfitLine(line);
            if (oInfo) {
                if (currentOutfit && currentOutfit.tags.length > 0) {
                    outfits.push({ name: currentOutfit.name, tags: currentOutfit.tags.join(', ') });
                    currentOutfit = null;
                }
                if (!oInfo.isTerminator) {
                    currentOutfit = { name: oInfo.name, tags: oInfo.content ? [oInfo.content] : [] };
                }
            } else if (currentOutfit) {
                currentOutfit.tags.push(line);
            }
        }
        if (currentOutfit && currentOutfit.tags.length > 0) {
            outfits.push({ name: currentOutfit.name, tags: currentOutfit.tags.join(', ') });
        }
        return outfits;
    }

    function parseDoujinProfile(rawContent, fallbackName) {
        let text = String(rawContent || '').trim();

        // 1. 检查是否有明确的多个服装分段（如 服饰- 常服:、服饰- 泳装: 或 # 泳装）
        const multiOutfits = parseMultiOutfits(text);
        if (multiOutfits.length > 1) {
            const lines = text.split(/\r?\n/);
            let firstOutfitIdx = -1;
            const OUTFIT_KW = /(服|装|立绘|衣|裙|袍|制服|校服|泳装|比基尼|睡衣|兔女郎|内衣|战服|和服|旗袍|私服|女仆|礼服|便服|日常|战斗|常服|bikini|swimsuit|pajamas|maid|bunny|casual|battle|combat|underwear|dress|costume)/i;
            for (let i = 0; i < lines.length; i++) {
                const l = lines[i].trim();
                if (/^[-*#\s]*(?:(?:服饰|服装)[-_—－\s]*)?[【\[]?[\u4e00-\u9fa5a-zA-Z0-9_\-\/]+[\]】]?[:：\n]/.test(l) && OUTFIT_KW.test(l)) {
                    firstOutfitIdx = i;
                    break;
                }
            }
            const baseRaw = firstOutfitIdx > 0 ? lines.slice(0, firstOutfitIdx).join('\n') : text;
            const baseClean = cleanLorebookTags(baseRaw) || cleanLorebookTags(text);

            const wardrobe = multiOutfits.map((o, idx) => ({
                id: 'w_' + (idx + 1),
                name: o.name || `服装${idx + 1}`,
                outfit: cleanLorebookTags(o.tags)
            }));

            return { baseTags: baseClean, wardrobe };
        }

        // 2. 单服装或普通语义格式（提取特征、服装和道具/武器）
        const outfitStartRegex = /((?:服饰|服装|衣着|装束)[-_—－\s]*(?:上身|下身)?[:：])/i;
        const propStartRegex = /((?:拓展资料区|拓展资料|道具\/武器|道具|武器|装备)[-_—－\s]*[:：])/i;

        let baseRaw = text;
        let outfitRaw = '';
        let propRaw = '';

        const propMatch = text.match(propStartRegex);
        if (propMatch && propMatch.index !== undefined) {
            propRaw = text.slice(propMatch.index);
            text = text.slice(0, propMatch.index);
        }

        const outfitMatch = text.match(outfitStartRegex);
        if (outfitMatch && outfitMatch.index !== undefined) {
            outfitRaw = text.slice(outfitMatch.index);
            baseRaw = text.slice(0, outfitMatch.index);
        }

        let baseClean = cleanLorebookTags(baseRaw);
        let outfitClean = cleanLorebookTags(outfitRaw);
        let propClean = cleanLorebookTags(propRaw);

        if (!outfitClean && !propClean) {
            baseClean = cleanLorebookTags(rawContent);
        }

        const wardrobe = [];
        if (outfitClean) {
            wardrobe.push({ id: 'w_default', name: '默认服装', outfit: outfitClean });
            if (propClean) {
                wardrobe.push({ id: 'w_combat', name: '全套战斗装 (含武器/道具)', outfit: `${outfitClean}, ${propClean}` });
            }
        } else {
            wardrobe.push({ id: 'w_default', name: '默认立绘', outfit: propClean || '' });
        }

        return {
            baseTags: baseClean,
            wardrobe: wardrobe
        };
    }

    function extractDoujinProfilesFromLorebook(lorebookSource) {
        if (!lorebookSource) return {};
        let entries = [];
        if (typeof RBQ?.api?.getLorebookEntries === 'function') {
            entries = RBQ.api.getLorebookEntries(lorebookSource) || [];
        }
        if ((!entries || entries.length === 0) && lorebookSource.rawJson) {
            try {
                let parsed;
                if (typeof RBQ?.api?.parseLorebookRawJson === 'function') {
                    parsed = RBQ.api.parseLorebookRawJson(lorebookSource.rawJson, lorebookSource.name);
                } else {
                    parsed = JSON.parse(lorebookSource.rawJson);
                }
                const rawEntries = parsed?.entries;
                entries = Array.isArray(rawEntries)
                    ? rawEntries
                    : (rawEntries && typeof rawEntries === 'object' ? Object.values(rawEntries) : []);
            } catch (_e) {
                entries = [];
            }
        }
        if (!Array.isArray(entries) || entries.length === 0) return {};
        const profiles = {};
        const pendingVariantEntries = [];

        for (const e of entries) {
            if (!e || typeof e !== 'object') continue;
            let rawName = String(e.comment || e.displayName || e.name || '').trim();
            if (!rawName) continue;
            rawName = rawName.replace(/^[\*#\s]+/, '');
            rawName = rawName.replace(/^[【\[（\(][^】\]）\)]+[】\]）\)]\s*/, '');
            rawName = rawName.replace(/[-_—－\s]*(new|常规|新版|横图|竖图|自用|测试)$/i, '');
            if (!rawName) continue;

            const content = String(e.content || e.tags || '').trim();
            if (!content) continue;

            const keys = Array.isArray(e.key) ? e.key : (typeof e.key === 'string' ? e.key.split(',') : []);
            
            const { charName, outfitName } = splitCharAndOutfit(rawName);
            if (outfitName && charName && charName !== rawName) {
                pendingVariantEntries.push({ e, charName, outfitName, content, keys });
            } else {
                const parsedProfile = parseDoujinProfile(content, rawName);
                profiles[rawName] = {
                    displayName: rawName,
                    charName: rawName,
                    baseTags: parsedProfile.baseTags,
                    currentOutfit: parsedProfile.wardrobe[0]?.outfit || '',
                    currentOutfitId: parsedProfile.wardrobe[0]?.id || 'w_default',
                    wardrobe: parsedProfile.wardrobe,
                    source: 'lorebook',
                    sourceId: lorebookSource.id,
                    sourceName: lorebookSource.name,
                    keys: keys
                };
            }
        }

        // 第二轮：将独立服装变体条目（如 角色 (泳装)）智能合并到主角色档案的衣柜 (Wardrobe)
        for (const item of pendingVariantEntries) {
            let target = profiles[item.charName];
            if (!target) {
                // 如果还没有主档案，以该变体初始化
                const p = parseDoujinProfile(item.content, item.charName);
                profiles[item.charName] = {
                    displayName: item.charName,
                    charName: item.charName,
                    baseTags: p.baseTags,
                    currentOutfit: p.wardrobe[0]?.outfit || '',
                    currentOutfitId: p.wardrobe[0]?.id || 'w_default',
                    wardrobe: p.wardrobe,
                    source: 'lorebook',
                    sourceId: lorebookSource.id,
                    sourceName: lorebookSource.name,
                    keys: item.keys
                };
                target = profiles[item.charName];
            }

            const pVar = parseDoujinProfile(item.content, item.outfitName);
            const varOutfitTags = pVar.wardrobe[0]?.outfit || pVar.baseTags;
            const existing = target.wardrobe.find(w => w.name.toLowerCase() === item.outfitName.toLowerCase());
            if (!existing && varOutfitTags) {
                target.wardrobe.push({
                    id: 'w_' + uid('outfit'),
                    name: item.outfitName,
                    outfit: cleanLorebookTags(varOutfitTags)
                });
            }
        }

        return profiles;
    }

    function getMountedLorebookSource() {
        const ws = getWs();
        const sources = (typeof RBQ?.api?.getLorebookSources === 'function') 
            ? RBQ.api.getLorebookSources() 
            : (getSdtStore().lorebookSources || []);
        
        if (!Array.isArray(sources) || sources.length === 0) return null;

        if (ws.mountedLorebookId) {
            const found = sources.find(s => s.id === ws.mountedLorebookId);
            if (found) return found;
        }

        const candidate = sources.find(s => {
            const name = (s.name || '').toLowerCase();
            return name.includes('同人') || name.includes('角色') || name.includes('人物') || name.includes('char');
        });
        if (candidate) return candidate;

        return sources[0] || null;
    }

    function getMountedDoujinProfiles() {
        try {
            const src = getMountedLorebookSource();
            if (!src) return {};
            if (_cachedDoujinProfiles && _cachedDoujinSourceId === src.id && _cachedDoujinProfiles.__mtime === (src.updatedAt || src.name)) {
                return _cachedDoujinProfiles;
            }
            const profiles = extractDoujinProfilesFromLorebook(src);
            profiles.__mtime = src.updatedAt || src.name;
            _cachedDoujinProfiles = profiles;
            _cachedDoujinSourceId = src.id;
            return profiles;
        } catch (e) {
            console.warn('[CW] getMountedDoujinProfiles error:', e);
            return {};
        }
    }

    function getAllProfiles() {
        if (dossierScope === 'lorebook') {
            const dp = getMountedDoujinProfiles();
            const copy = { ...dp };
            delete copy.__mtime;
            return copy;
        }
        if (dossierScope === 'all') {
            return getAllGlobalProfiles();
        }
        return getCurrentChatProfiles();
    }

    function getProfile(name) {
        if (!name) return null;
        // Global history view: show/edit the preferred archive (locked / oldest), not the current-chat clone.
        if (dossierScope === 'all') {
            // ⭐ 全局角色：角色库视图展示/编辑的是全局角色本体。
            const globalChar = getGlobalCharacterProfile(name);
            if (globalChar) return globalChar;
            const globalPreferred = getAllGlobalProfiles()[name];
            if (globalPreferred) return globalPreferred;
        }
        if (dossierScope === 'lorebook') {
            const doujinPreferred = getMountedDoujinProfiles()[name];
            if (doujinPreferred) return doujinPreferred;
        }
        const current = getCurrentChatProfiles()[name];
        if (current) return current;
        const globalP = getAllGlobalProfiles()[name];
        if (globalP) return globalP;
        const doujinP = getMountedDoujinProfiles()[name];
        if (doujinP) return doujinP;
        return null;
    }

    function saveProfile(name, data, scope = dossierScope, opts = {}) {
        if (!name || isJunkCharacterName(name)) return;
        const bucket = ensureProfileBucket();
        // ⭐全局角色 saved from 角色库: the global itself is the target; the current chat is only written if it
        // already holds its own (non-imported) copy of her.
        const isGlobalSave = scope === 'all' && (isGlobalCharacter(name) || !!opts.makeGlobal);
        const oldGlobal = isGlobalCharacter(name) ? JSON.parse(JSON.stringify(getGlobalCharacterProfile(name))) : null;
        const writeBucket = !isGlobalSave || !!(bucket[name] && !bucket[name].importedFromGlobal);
        // Editor fields are a partial profile; keep each chat's independent temporal history.
        const profileData = { ...(writeBucket ? bucket[name] : (oldGlobal || bucket[name])), ...data, displayName: data.displayName || name, updatedAt: Date.now() };
        // An explicitly cleared name_tag removes the identity instead of storing an empty string.
        const clearNameTag = Object.hasOwn(data, 'nameTag') && !String(data.nameTag || '').trim();
        // Same for an explicitly cleared aliases list; global-sync copies follow identically.
        const clearAliases = Object.hasOwn(data, 'aliases') && !(Array.isArray(data.aliases) ? data.aliases.length : String(data.aliases || '').trim());
        const dropEmptyNameTag = obj => {
            if (clearNameTag) { delete obj.nameTag; delete obj.nameTagSource; } else if (obj && !obj.nameTagSource) delete obj.nameTagSource;
            if (clearAliases) delete obj.aliases;
            return obj;
        };
        dropEmptyNameTag(profileData);
        // Prefer the identity of the archive being edited (global view) over a current-chat clone's createdAt.
        if (Object.hasOwn(data, 'createdAt') && Number(data.createdAt || 0) > 0) {
            profileData.createdAt = data.createdAt;
        } else if (!profileData.createdAt) {
            profileData.createdAt = Date.now();
        }
        if (!Array.isArray(profileData.wardrobe)) profileData.wardrobe = [];
        if (writeBucket) bucket[name] = profileData;

        // Global save: sync only same-identity copies; never overwrite a locked archive with an unlocked clone.
        let globalData = null;
        if (scope === 'all') {
            const sdt = getSdtStore();
            if (sdt.characterProfiles && typeof sdt.characterProfiles === 'object') {
                for (const chatDict of Object.values(sdt.characterProfiles)) {
                    if (chatDict && typeof chatDict === 'object' && chatDict !== bucket) {
                        if (chatDict[name] || (data.displayName && chatDict[data.displayName])) {
                            const targetKey = chatDict[name] ? name : data.displayName;
                            const existing = chatDict[targetKey];
                            // Copies imported from a ⭐全局角色 are updated only via the explicit sync below.
                            if (isGlobalSave && existing?.importedFromGlobal) continue;
                            const merged = dropEmptyNameTag(JSON.parse(JSON.stringify({ ...existing, ...data,
                                displayName: data.displayName || name, updatedAt: profileData.updatedAt,
                                createdAt: (Object.hasOwn(data, 'createdAt') && Number(data.createdAt || 0) > 0)
                                    ? data.createdAt
                                    : (existing.createdAt || profileData.createdAt) })));
                            if (!shouldSyncGlobalCopy(existing, merged, profileData)) continue;
                            chatDict[targetKey] = merged;
                        }
                    }
                }
            }
            // Manual 角色库 save is the only way a 全局角色 changes (parse never writes it).
            if (isGlobalSave) {
                globalData = dropEmptyNameTag({ ...(oldGlobal || {}), ...data, displayName: data.displayName || name,
                    updatedAt: profileData.updatedAt, createdAt: profileData.createdAt, wardrobe: profileData.wardrobe });
                setGlobalCharacter(name, true, globalData);
                if (opts.syncImported) syncGlobalToImportedCopies(name, getGlobalCharacterProfile(name), oldGlobal);
            }
        }

        RBQ.api.saveSettings();
        return globalData || profileData;
    }


    /** Clone preferred global archive into current chat, replacing any same-name slot. */
    function overwriteCurrentChatFromGlobal(name) {
        if (!name) return false;
        if (isGlobalCharacter(name)) return importGlobalCharacterToCurrentChat(name);
        const globalProfiles = getAllGlobalProfiles();
        const p = globalProfiles[name];
        if (!p || typeof p !== 'object') return false;
        const bucket = ensureProfileBucket();
        // Drop current slot first so saveProfile merge cannot keep parse-only leftovers.
        delete bucket[name];
        saveProfile(name, JSON.parse(JSON.stringify(p)), 'chat');
        return true;
    }

    function deleteProfile(name, scope = dossierScope) {
        if (!name) return false;
        const sdt = getSdtStore();
        let deleted = false;

        const currentChatBucket = ensureProfileBucket();
        // 当前会话删除只看当前会话自己的档案（别的对话里的同名档案不参与匹配）。
        const targetProf = scope === 'all'
            ? (currentChatBucket[name] || getAllGlobalProfiles()[name] || getProfile(name))
            : currentChatBucket[name];
        const targetDisplayName = targetProf?.displayName || '';

        const norm = (s) => String(s || '').trim().toLowerCase();
        const targetNorm = norm(name);
        const targetDisplayNorm = norm(targetDisplayName);

        const isMatch = (k, v) => {
            const kNorm = norm(k);
            if (kNorm === targetNorm) return true;
            if (targetDisplayNorm && kNorm === targetDisplayNorm) return true;
            if (v && typeof v === 'object') {
                const dnNorm = norm(v.displayName);
                if (dnNorm === targetNorm) return true;
                if (targetDisplayNorm && dnNorm === targetDisplayNorm) return true;
            }
            return false;
        };

        if (scope === 'all') {
            // 角色库删除：遍历 sdt.characterProfiles 下所有历史会话桶彻底清理；同名全局角色一并取消
            const gStore = getSdtStore().globalCharacters;
            if (gStore && typeof gStore === 'object') {
                for (const gName of Object.keys(gStore)) {
                    if (isMatch(gName, gStore[gName]?.profile)) { delete gStore[gName]; deleted = true; }
                }
            }
            if (sdt.characterProfiles && typeof sdt.characterProfiles === 'object') {
                for (const [chatKey, chatDict] of Object.entries(sdt.characterProfiles)) {
                    if (chatDict && typeof chatDict === 'object') {
                        for (const [k, v] of Object.entries(chatDict)) {
                            if (isMatch(k, v)) {
                                RBQ.api.forgetMangaCharacterMemory?.(k, chatKey);
                                delete chatDict[k];
                                deleted = true;
                            }
                        }
                    }
                }
            }
        } else {
            // 当前会话删除：只清理当前会话桶；当前会话里没有这个名字就什么都不做（不去别的对话找同名角色删）。
            const ck = getChatKey();
            const bucket = sdt.characterProfiles?.[ck];
            if (bucket && typeof bucket === 'object') {
                for (const [k, v] of Object.entries(bucket)) {
                    if (isMatch(k, v)) {
                        RBQ.api.forgetMangaCharacterMemory?.(k, ck);
                        delete bucket[k];
                        deleted = true;
                    }
                }
            }
            if (bucket && bucket[name]) {
                RBQ.api.forgetMangaCharacterMemory?.(name, ck);
                delete bucket[name];
                deleted = true;
            }
        }

        if (deleted) {
            // 同步清理工作台舞台当前槽位中对该角色的引用
            try {
                const ws = getWs();
                if (ws?.activeComposer?.slots) {
                    let wsChanged = false;
                    ws.activeComposer.slots.forEach(slot => {
                        if (slot && (slot.charName === name || (targetDisplayName && slot.charName === targetDisplayName) || norm(slot.charName) === targetNorm)) {
                            slot.charName = '';
                            slot.outfitId = '';
                            wsChanged = true;
                        }
                    });
                    if (wsChanged) wsSave();
                }
            } catch (_) {}

            RBQ.api.saveSettings();
        }
        return deleted;
    }

    function getOutfitTagsForSlot(profile, outfitId, customOutfit) {
        if (customOutfit) return customOutfit;
        if (!profile) return '';
        if (outfitId && Array.isArray(profile.wardrobe)) {
            const found = profile.wardrobe.find(w => w.id === outfitId);
            if (found) return found.outfit || found.tags || '';
        }
        return profile.currentOutfit || (profile.wardrobe?.[0]?.outfit) || '';
    }

    function isMccEnabled() {
        const s = RBQ.api.getSettings();
        return s[MCC_KEY]?.enabled !== false;
    }

    // ══════════════════════════════════════════════════════════
    //  Local Workspace State (Stage Presets & Active Composer)
    // ══════════════════════════════════════════════════════════
    function getWs() {
        const s = RBQ.api.getSettings();
        if (!s[CW_KEY]) s[CW_KEY] = {};
        const ws = s[CW_KEY];
        if (!Array.isArray(ws.presets)) ws.presets = [];
        if (!ws.activeComposer || typeof ws.activeComposer !== 'object') {
            ws.activeComposer = {
                scene: '', camera: '', atmosphere: '',
                slots: [
                    { charName: '', outfitId: '', customOutfit: '', action: '', uc: '', center: 'B3' },
                    { charName: '', outfitId: '', customOutfit: '', action: '', uc: '', center: 'D3' }
                ],
                activeSlotIndex: 0,
                selectedWbActions: [],
                customActionInput: ''
            };
        }
        if (!Array.isArray(ws.activeComposer.slots)) ws.activeComposer.slots = [];
        if (!Array.isArray(ws.activeComposer.selectedWbActions)) ws.activeComposer.selectedWbActions = [];
        if (typeof ws.activeComposer.customActionInput !== 'string') ws.activeComposer.customActionInput = '';
        // 彻底清除历史旧版本中残留的幽灵 interaction 字段，防止污染生图预览
        if (ws.activeComposer.interaction) {
            delete ws.activeComposer.interaction;
            wsSave();
        }
        // 彻底清除各槽位中残留的历史幽灵 action 字段 (如旧测试残留的折扇/动作)，避免阴魂不散
        if (Array.isArray(ws.activeComposer.slots)) {
            let clearedAction = false;
            ws.activeComposer.slots.forEach(s => {
                if (s && s.action) {
                    s.action = '';
                    clearedAction = true;
                }
            });
            if (clearedAction) wsSave();
        }
        return ws;
    }
    function wsSave() { RBQ.api.saveSettings(); }

    // ══════════════════════════════════════════════════════════
    //  Preset Compositions
    // ══════════════════════════════════════════════════════════
    const TEMPLATES = [
        {
            name: '双人面对面互动',
            desc: '两角色分别位于中左/中右，身体相对',
            scene: 'indoors, cozy room, soft lighting',
            camera: 'from_side, medium shot, eye level',
            slots: [
                { charName: '', outfitId: '', customOutfit: '', action: 'standing, facing right, looking at partner, gentle smile', uc: '', center: 'B3' },
                { charName: '', outfitId: '', customOutfit: '', action: 'standing, facing left, looking at partner, blush', uc: '', center: 'D3' }
            ]
        },
        {
            name: '背靠背战斗分镜',
            desc: '战术背靠背站姿，左右分立有张力',
            scene: 'ruins, embers, dramatic lighting',
            camera: 'dynamic angle, wide shot',
            slots: [
                { charName: '', outfitId: '', customOutfit: '', action: 'fighting stance, back to back, looking at viewer, serious', uc: '', center: 'B3' },
                { charName: '', outfitId: '', customOutfit: '', action: 'holding weapon, back to back, looking away, focused', uc: '', center: 'D3' }
            ]
        },
        {
            name: '主仆/高低位差分镜',
            desc: '一人站立居高临下，一人跪坐/屈膝',
            scene: 'throne room, luxurious, marble floor',
            camera: 'from above, tilted angle',
            slots: [
                { charName: '', outfitId: '', customOutfit: '', action: 'standing, looking down, confident smile, hand on hip', uc: '', center: 'C2' },
                { charName: '', outfitId: '', customOutfit: '', action: 'kneeling, looking up, blush, submissive', uc: '', center: 'C4' }
            ]
        },
        {
            name: '三人同行分镜',
            desc: '三人成三角站位，中间为主视点',
            scene: 'street, sunny day, depth of field',
            camera: 'front view, medium full shot',
            slots: [
                { charName: '', outfitId: '', customOutfit: '', action: 'walking forward, waving hand, cheerful', uc: '', center: 'A3' },
                { charName: '', outfitId: '', customOutfit: '', action: 'standing, center, looking at viewer, smile', uc: '', center: 'C3' },
                { charName: '', outfitId: '', customOutfit: '', action: 'walking, arms crossed, side glance, smirk', uc: '', center: 'E3' }
            ]
        }
    ];

    // ══════════════════════════════════════════════════════════
    //  7-Dimensional Holographic Appearance Formula
    // ══════════════════════════════════════════════════════════
    const TRAITS = [
        {
            g: '性别族裔', c: '#38bdf8',
            t: [
                { n: '1girl', t: '1girl' }, { n: '1boy', t: '1boy' },
                { n: '日系', t: 'japanese' }, { n: '东亚', t: 'east_asian' },
                { n: '西方', t: 'caucasian' }, { n: '中华', t: 'chinese' },
                { n: '动漫风', t: 'delicate_face' }, { n: 'Gyaru', t: 'gyaru' }
            ]
        },
        {
            g: '年龄', c: '#fbbf24',
            t: [
                { n: '少女', t: 'adolescent, young_girl' }, { n: '御姐', t: 'mature_female' },
                { n: '萝莉', t: 'petite, loli' }, { n: '成年男', t: 'mature_male' },
                { n: '正太', t: 'bishounen' }
            ]
        },
        {
            g: '发型发色', c: '#f472b6',
            t: [
                { n: '黑发', t: 'black_hair' }, { n: '银发', t: 'silver_hair' },
                { n: '金发', t: 'blonde_hair' }, { n: '粉发', t: 'pink_hair' },
                { n: '蓝发', t: 'blue_hair' }, { n: '红发', t: 'red_hair' },
                { n: '棕发', t: 'brown_hair' }, { n: '双马尾', t: 'twin_tails' },
                { n: '马尾', t: 'ponytail' }, { n: '长发', t: 'long_hair' },
                { n: '短发', t: 'short_hair' }, { n: '波浪', t: 'wavy_hair' },
                { n: '齐刘海', t: 'blunt_bangs' }, { n: '呆毛', t: 'ahoge' }
            ]
        },
        {
            g: '瞳色', c: '#a855f7',
            t: [
                { n: '红瞳', t: 'red_eyes' }, { n: '蓝瞳', t: 'blue_eyes' },
                { n: '金瞳', t: 'golden_eyes' }, { n: '绿瞳', t: 'green_eyes' },
                { n: '紫瞳', t: 'purple_eyes' }, { n: '异色瞳', t: 'heterochromia' },
                { n: '垂眼', t: 'tareme' }, { n: '吊眼', t: 'tsurime' }
            ]
        },
        {
            g: '身材', c: '#4ade80',
            t: [
                { n: '纤细', t: 'slender' }, { n: '娇小', t: 'petite' },
                { n: '丰满', t: 'curvy' }, { n: '高挑', t: 'tall' },
                { n: '平胸', t: 'flat_chest' }, { n: '小胸', t: 'small_breasts' },
                { n: '中等', t: 'medium_breasts' }, { n: '巨乳', t: 'large_breasts' },
                { n: '爆乳', t: 'huge_breasts' }, { n: '马甲线', t: 'abs' },
                { n: '肉腿', t: 'thick_thighs' }
            ]
        },
        {
            g: '肤色标记', c: '#fb7185',
            t: [
                { n: '冷白', t: 'pale_skin' }, { n: '自然', t: 'fair_skin' },
                { n: '小麦黑皮', t: 'tan, dark_skin' }, { n: '泪痣', t: 'mole_under_eye' },
                { n: '雀斑', t: 'freckles' }, { n: '淫纹', t: 'stomach_tattoo' }
            ]
        },
        {
            g: '种族幻想', c: '#38bdf8',
            t: [
                { n: '猫耳尾', t: 'cat_ears, cat_tail' }, { n: '狐耳尾', t: 'fox_ears, fox_tail' },
                { n: '兔耳尾', t: 'rabbit_ears, rabbit_tail' }, { n: '精灵尖耳', t: 'pointy_ears' },
                { n: '恶魔角翼', t: 'demon_horns, demon_wings' }, { n: '天使光环翼', t: 'halo, angel_wings' },
                { n: '魅魔', t: 'succubus' }, { n: '虎牙', t: 'fangs' }
            ]
        }
    ];

    const OUTFIT_PRESETS = [
        { n: '水手服', t: 'sailor_suit, pleated_skirt' },
        { n: '校服西装', t: 'school_uniform, blazer, necktie' },
        { n: '女仆装', t: 'maid, maid_headdress, apron' },
        { n: '兔女郎', t: 'bunny_suit, bunny_ears' },
        { n: '比基尼', t: 'bikini, micro_bikini' },
        { n: '卫衣服', t: 'hoodie, casual' },
        { n: '露肩毛衣', t: 'off-shoulder_sweater' },
        { n: '旗袍', t: 'china_dress, high_slit' },
        { n: '浴衣/和服', t: 'yukata, kimono' },
        { n: '全裸', t: 'nude, uncensored' }
    ];

    // ══════════════════════════════════════════════════════════
    //  Intelligent Outfit Matching (动作与服装智能自动联动匹配)
    // ══════════════════════════════════════════════════════════
    function findBestMatchingOutfit(actionsStr, wardrobe) {
        if (!actionsStr || !Array.isArray(wardrobe) || wardrobe.length <= 1) return null;
        const act = actionsStr.toLowerCase();

        const rules = [
            {
                actPattern: /(swim|pool|beach|ocean|seaside|bikini|swimsuit|onsen|hot_spring|water|resort|游泳|泳池|海滩|沙滩|温泉|比基尼|戏水)/i,
                outfitPattern: /(泳装|比基尼|泳衣|swimsuit|bikini)/i
            },
            {
                actPattern: /(sleep|bed|pillow|lying|yawning|pajamas|nightgown|futon|blanket|睡觉|卧床|睡衣|床上|起床|赖床)/i,
                outfitPattern: /(睡衣|寝服|pajamas|nightgown|sleepwear)/i
            },
            {
                actPattern: /(maid|serving|tray|cleaning|tea|broom|女仆|侍奉|端茶|打扫)/i,
                outfitPattern: /(女仆|maid)/i
            },
            {
                actPattern: /(bunny|casino|bunny_ears|兔女郎|赌场|兔耳)/i,
                outfitPattern: /(兔女郎|bunny)/i
            },
            {
                actPattern: /(combat|fight|battle|attack|magic|spell|sword|staff|weapon|战斗|施法|攻击|拔剑|迎战|武器)/i,
                outfitPattern: /(战斗|战服|武装|全套|combat|battle|armor)/i
            },
            {
                actPattern: /(running|workout|gym|sport|exercise|bloomers|跑步|运动|锻炼|体操|健身)/i,
                outfitPattern: /(运动|体操|瑜伽|sport|bloomers)/i
            },
            {
                actPattern: /(breast|lactation|sucking|sex|masturbation|naked|nude|lingerie|underwear|哺乳|乳交|性爱|做爱|自慰|全裸|内衣|裸体)/i,
                outfitPattern: /(内衣|清凉|裸体|lingerie|underwear|nude)/i
            }
        ];

        for (const rule of rules) {
            if (rule.actPattern.test(act)) {
                const matched = wardrobe.find(w => rule.outfitPattern.test((w.name + ' ' + (w.outfit || '')).toLowerCase()));
                if (matched) return matched;
            }
        }
        return null;
    }

    function autoMatchOutfitsForActiveComposer() {
        const ws = getWs();
        const comp = ws.activeComposer;
        if (!comp || !Array.isArray(comp.slots)) return;

        const wbActions = Array.isArray(comp.selectedWbActions) ? comp.selectedWbActions : [];
        const actionStr = [
            ...wbActions.map(a => `${a.name || ''} ${a.tags || ''}`),
            comp.customActionInput || '',
            comp.scene || ''
        ].join(' ');

        if (!actionStr.trim()) return;

        comp.slots.forEach(slot => {
            if (!slot.charName) return;
            const prof = getProfile(slot.charName) || getAllProfiles()[slot.charName];
            if (!prof || !Array.isArray(prof.wardrobe) || prof.wardrobe.length <= 1) return;

            if (!slot.customOutfit) {
                const bestOutfit = findBestMatchingOutfit(actionStr, prof.wardrobe);
                if (bestOutfit && slot.outfitId !== bestOutfit.id) {
                    slot.outfitId = bestOutfit.id;
                    toastr.info(`💡 检测到动作分镜，已自动为「${prof.displayName || slot.charName}」切换至【${bestOutfit.name}】！`, PLUGIN_NAME);
                }
            }
        });
    }

    // ══════════════════════════════════════════════════════════
    //  Intelligent Outfit-Camera Conflict Pruning
    //  半身/特写/大腿以上构图时，自动清洗鞋袜/下装冲突词，避免 AI 被鞋子迫使拉远画全身
    // ══════════════════════════════════════════════════════════
    function pruneConflictingOutfitTags(outfit, cameraText) {
        if (!outfit || !cameraText) return outfit;
        const camLower = cameraText.toLowerCase();

        const isCloseUp = /\b(close-up|face focus|headshot|portrait)\b/i.test(camLower);
        const isUpperBody = isCloseUp || /\b(upper body|upper_body)\b/i.test(camLower);
        const isCowboy = isUpperBody || /\b(cowboy shot|cowboy_shot)\b/i.test(camLower);

        if (!isCowboy) return outfit;

        const FOOTWEAR_PATTERN = /\b(loafers|shoes|boots|sneakers|sandals|high heels|high_heels|barefoot|feet|toes|socks|tights|stockings|pantyhose|legwear|kneehighs|thighhighs)\b/i;
        const LOWER_GARMENT_PATTERN = /\b(skirt|pants|shorts|jeans|trousers|panties|thong|underwear|bottomless|leggings)\b/i;

        const rawTags = outfit.split(/[,，;；]+/).map(s => s.trim()).filter(Boolean);
        const resultTags = [];

        for (let tag of rawTags) {
            if (isCowboy && FOOTWEAR_PATTERN.test(tag)) {
                // 剔除鞋袜词汇，但保留可能拼在一起的其他修饰词（如 brown loafers noctchill -> noctchill）
                const cleaned = tag.replace(/\b([a-z_-]+\s+)?(loafers|shoes|boots|sneakers|sandals|high heels|high_heels|barefoot|feet|toes|socks|tights|stockings|pantyhose|legwear|kneehighs|thighhighs)\b/gi, '').trim();
                if (cleaned && cleaned.length > 2) {
                    resultTags.push(cleaned);
                }
                continue;
            }
            if (isCloseUp && LOWER_GARMENT_PATTERN.test(tag)) {
                // 肖像特写下彻底剔除下装（裙子、裤子等）
                continue;
            }
            resultTags.push(tag);
        }

        return resultTags.join(', ');
    }

    // ══════════════════════════════════════════════════════════
    //  Intelligent Action-Camera Conflict Pruning
    //  面部特写/半身/大腿以上构图时，自动清洗动作中与构图相矛盾的姿态词与视角词，
    //  防止 AI 被动作里残留的 full body / legs focus / standing 等强行拉远画面
    // ══════════════════════════════════════════════════════════
    function pruneConflictingActionTags(actionText, cameraText) {
        if (!actionText || !cameraText) return actionText;
        const camLower = cameraText.toLowerCase();

        const isCloseUp = /\b(close-up|close_up|face.?focus|headshot|portrait)\b/i.test(camLower);
        const isUpperBody = isCloseUp || /\b(upper.?body)\b/i.test(camLower);
        const isCowboy = isUpperBody || /\b(cowboy.?shot)\b/i.test(camLower);

        if (!isCowboy) return actionText;

        // 不同构图级别的冲突词库 (从宽到窄)
        // cowboy shot (大腿以上)：剔除全身相关
        const CONFLICT_COWBOY = /\b(full.?body|legs.?focus|legs_focus|feet.?focus|feet_focus)\b/i;
        // upper body (半身)：在 cowboy 基础上再剔除 cowboy shot 自身
        const CONFLICT_UPPER = /\b(full.?body|legs.?focus|legs_focus|feet.?focus|feet_focus|cowboy.?shot)\b/i;
        // close-up / face focus (面部特写)：激进清洗，剔除一切暗示全身/下半身/姿态的构图词
        const CONFLICT_CLOSEUP = /\b(full.?body|upper.?body|cowboy.?shot|legs.?focus|legs_focus|feet.?focus|feet_focus|standing|walking|running|jumping|kicking|back.?view|ass.?view|from.?behind|from.?below)\b/i;

        const tags = actionText.split(/[,，;；]+/).map(s => s.trim()).filter(Boolean);
        const result = [];

        for (const tag of tags) {
            if (isCloseUp && CONFLICT_CLOSEUP.test(tag)) continue;
            if (isUpperBody && !isCloseUp && CONFLICT_UPPER.test(tag)) continue;
            if (isCowboy && !isUpperBody && CONFLICT_COWBOY.test(tag)) continue;
            result.push(tag);
        }

        return result.join(', ');
    }

    // ══════════════════════════════════════════════════════════
    //  Modular Feature Filter (头部/身体/服装特征装配过滤器)
    // ══════════════════════════════════════════════════════════
    const EYE_PATTERN = /\b([a-z_-]+\s+)?(eyes?|pupils?|eyebrows?|heterochromia|tareme|tsurime|sclera|glasses|sunglasses|eyepatch|goggles|monocle|blindfold)\b/i;
    const HAIR_HEAD_PATTERN = /\b([a-z_-]+\s+)?(hair|hairstyle|hair_style|cut|hairband|hairclip|hair_ornament|hair\s+ornament|hair_intakes|hair\s+intakes|ribbon|ahoge|bangs|braid|braids|ponytail|twintails|twin\s*tails|twin_tails|pigtails|bun|buns|hair_buns|hair\s+buns|chignon|drill\s+hair|hime|feather\s+weaving|ears?|cat_ears?|fox_ears?|cat\s+ears?|fox\s+ears?|animal\s+ears?|rabbit_ears?|pointy_ears?|horns?|demon_horns?|halo|floating_halo|floating\s+halo|straight|wavy|curly|short|long|bob|dreadlocks|afro|hat|top_hat|top\s*hat|cap|porkpie_hat|porkpie\s*hat|beret|helmet|headdress|veil)\b/i;
    const FACE_PATTERN = /\b([a-z_-]+\s+)?(face|delicate_face|smile|smirk|blush|mouth|lips|teeth|tongue|tears|gaze|expression|looking_at_viewer|looking\s+at\s+viewer|mask)\b/i;

    const BODY_PATTERN = /\b(breast|breasts|chest|flat_chest|cleavage|bust|petite|slender|curvy|tall|short_stature|abs|muscular|thighs|thick_thighs|legs|bare_legs|bare\s+legs|skin|tan|pale|tattoo|wings|tail|fangs|belly|navel|waist|hips)\b/i;

    const OUTFIT_PATTERN = /\b(shirt|t-shirt|blouse|crop_top|crop\s*top|halterneck|halter_neck|halter\s*neck|sleeveless|tank_top|sweater|turtleneck|hoodie|jacket|coat|tailcoat|shawl|cardigan|vest|suit|uniform|serafuku|sailor|dress|skirt|side_slit|side\s*slit|cleavage_cutout|cleavage\s*cutout|pants|jeans|shorts|trousers|panties|underwear|bra|bikini|swimsuit|leotard|bodysuit|corset|robe|kimono|yukata|qipao|cheongsam|apron|maid|cape|cloak|socks|stockings|thighhighs|thigh_highs|thigh\s*highs|pantyhose|tights|legwear|boots|shoes|sneakers|loafers|heels|high\s*heels|sandals|footwear|barefoot|bare_feet|bare\s+feet|gloves|mittens|gauntlets|wristband|wrist_guard|wrist\s*guard|arm_warmers|sleeves|detached_sleeves|detached\s+sleeves|wide_sleeves|collar|choker|tie|necktie|ascot|bow|bowtie|scarf|belt|garter|garter_straps|garter\s*straps|strap|thigh_strap|thigh\s*strap|armor|pauldrons|breastplate|chest\s*wrap|sarashi|fabric|rings?|bandages?|holster)\b/i;

    function filterBaseTags(baseTags, includeHead, includeBody, includeOutfit) {
        if (!baseTags) return '';
        if (includeHead !== false && includeBody !== false && includeOutfit !== false) return baseTags;

        const tags = baseTags.split(/[,，;；]+/).map(t => t.trim()).filter(Boolean);
        const result = [];

        for (const tag of tags) {
            if (OUTFIT_PATTERN.test(tag)) {
                if (includeOutfit !== false) result.push(tag);
            } else if (EYE_PATTERN.test(tag) || HAIR_HEAD_PATTERN.test(tag) || FACE_PATTERN.test(tag)) {
                if (includeHead !== false) result.push(tag);
            } else if (BODY_PATTERN.test(tag)) {
                if (includeBody !== false) result.push(tag);
            } else {
                // 身份/IP/随身武器/其他未识别项：始终保留
                result.push(tag);
            }
        }
        return result.join(', ');
    }

    // ══════════════════════════════════════════════════════════
    //  Prompt Composition & Multi-Engine Template Adaptation
    // ══════════════════════════════════════════════════════════
    function composeFinalPrompt(comp) {
        const slots = comp?.slots || [];
        const wbActions = Array.isArray(comp?.selectedWbActions) ? comp.selectedWbActions : [];

        // Partition WB actions by classification
        const interactionList = [];
        const soloActionList = [];
        const sceneList = [];
        const tplChar1Actions = [];
        const tplChar2Actions = [];

        wbActions.forEach(act => {
            if (act.type === 'template') {
                if (act.scene) interactionList.push(cleanLorebookTags(act.scene));
                if (act.char1Action) tplChar1Actions.push(cleanLorebookTags(act.char1Action));
                if (act.char2Action) tplChar2Actions.push(cleanLorebookTags(act.char2Action));
            } else if (act.type === 'interaction') {
                const clean = cleanLorebookTags(act.tags || '');
                if (clean) interactionList.push(clean);
            } else if (act.type === 'scene') {
                const clean = cleanLorebookTags(act.tags || '');
                if (clean) sceneList.push(clean);
            } else {
                const clean = cleanLorebookTags(act.tags || '');
                if (clean) soloActionList.push(clean);
            }
        });

        const cameraTags = cleanLorebookTags(comp?.camera || '');
        if (comp?.customActionInput) soloActionList.push(cleanLorebookTags(comp.customActionInput));
        if (comp?.scene) sceneList.push(cleanLorebookTags(comp.scene));
        if (comp?.atmosphere) sceneList.push(cleanLorebookTags(comp.atmosphere));

        const totalInteractions = interactionList.filter(Boolean).join(', ');
        const totalSoloActions = soloActionList.filter(Boolean).join(', ');
        const totalScene = sceneList.filter(Boolean).join(', ');
        const extraChar1Tpl = tplChar1Actions.filter(Boolean).join(', ');
        const extraChar2Tpl = tplChar2Actions.filter(Boolean).join(', ');

        // 关键判断：是否属于双人/多角色语境
        // 判定准则：用户在面板显式配置了2人以上槽位，或者所选模板具有独立的 Char 2 动作，或者动作文本明确声明了多位人物 (1girl, 1boy / 2girls 等)
        const hasDuoContext = slots.length > 1 || !!extraChar2Tpl || /\b(1girl\s*,\s*1boy|1boy\s*,\s*1girl|2girls|2boys|3girls|3boys|multiple\s*(?:girls|boys)|group\s*sex|threesome|gangbang)\b/i.test(totalInteractions + ' ' + totalSoloActions);

        let effectiveSlots;
        if (hasDuoContext) {
            effectiveSlots = slots.length > 1 ? slots : [...slots, { charName: '', outfitId: '', customOutfit: '', action: '', uc: '', center: 'D3' }];
        } else {
            const activeSlots = slots.filter(s => s && (s.charName || s.customOutfit || s.action));
            effectiveSlots = activeSlots.length > 0 ? activeSlots : slots.slice(0, 1);
        }

        const isSolo = effectiveSlots.length <= 1 && !hasDuoContext;

        let girlCount = 0;
        let boyCount = 0;

        const charDetails = effectiveSlots.map((slot, i) => {
            const n = i + 1;
            const profile = slot.charName ? getProfile(slot.charName) : null;
            const rawName = profile?.displayName || slot.charName || '';
            const rawBase = cleanLorebookTags(profile?.baseTags || '');

            // 槽位装配特征开关 (头部/体态/服装)
            const includeHead = slot.includeHead !== false;
            const includeBody = slot.includeBody !== false;
            const includeOutfit = slot.includeOutfit !== false;

            const base = filterBaseTags(rawBase, includeHead, includeBody, includeOutfit);

            let outfit = '';
            if (includeOutfit) {
                outfit = cleanLorebookTags(getOutfitTagsForSlot(profile, slot.outfitId, slot.customOutfit));
                // 智能构图冲突清洗：半身/特写时自动剔除鞋袜，避免 AI 强行拉远画全身以展示鞋子
                if (cameraTags) {
                    outfit = pruneConflictingOutfitTags(outfit, cameraTags);
                }
            }
            const hasTemplate = wbActions.some(act => act.type === 'template');
            const slotAction = hasTemplate ? cleanLorebookTags(slot.action || '') : '';

            // 若名字含有中文字符，严禁作为 Danbooru 提示词标签注入！
            const isChineseName = /[\u4e00-\u9fa5]/.test(rawName);
            const namePrefix = (!isChineseName && rawName && !base.toLowerCase().includes(rawName.toLowerCase())) ? rawName : '';
            const center = slot.center || (i === 0 ? 'B3' : (i === 1 ? 'D3' : 'C3'));
            const centerStr = formatCoordOutput(center);
            const centersSuffix = (comp?.useCoords === true) ? ('|centers:' + centerStr) : '';

            // 模板动作分配给此槽位
            let tplActionForSlot = (i === 0 ? extraChar1Tpl : (i === 1 ? extraChar2Tpl : ''));
            if (tplActionForSlot) {
                tplActionForSlot = tplActionForSlot
                    .replace(/\{\{\s*char(1)?\s*\}\}/gi, rawName ? `${rawName}, ${base}` : base)
                    .replace(/\[\s*char(1)?\s*\]/gi, rawName ? `${rawName}, ${base}` : base)
                    .replace(/\{\{\s*user\s*\}\}/gi, rawName ? `${rawName}, ${base}` : base)
                    .replace(/\{\{\s*char2\s*\}\}/gi, rawName ? `${rawName}, ${base}` : base)
                    .replace(/\[\s*char2\s*\]/gi, rawName ? `${rawName}, ${base}` : base)
                    .replace(/\{\{\s*outfit\s*\}\}/gi, outfit)
                    .replace(/\[\s*outfit\s*\]/gi, outfit);
            }

            // 智能避冲：如果模板自带服装（如 uniform, dress），且用户当前使用的是默认初始服装，避免内衣与制服产生严重冲突
            if (tplActionForSlot && (!slot.outfitId || slot.outfitId === 'w_default') && /\b(uniform|school_uniform|dress|suit|costume|bikini|pajamas|kimono|maid)\b/i.test(tplActionForSlot)) {
                outfit = '';
            }

            // 性别检测 (结合名字、特征、服装与模板动作)
            const combinedLower = (rawName + ' ' + base + ' ' + outfit + ' ' + tplActionForSlot + ' ' + slotAction).toLowerCase();
            const isAssigned = !!(rawName || base || outfit || tplActionForSlot || slotAction);
            if (isAssigned) {
                if (combinedLower.match(/\b(1boy|huge male|faceless male|male|man|guy|boy)\b/)) {
                    boyCount++;
                } else {
                    girlCount++;
                }
            } else {
                // 未分配具体档案的陪衬槽位 (Char 2)：根据全局上下文推断性别，严禁盲目默认成第二位女性！
                const globalDuoText = (totalInteractions + ' ' + totalSoloActions + ' ' + extraChar2Tpl).toLowerCase();
                if (globalDuoText.match(/\b(1boy|huge male|faceless male|male|man|guy|boy|penis|dick|cock|penetration)\b/)) {
                    boyCount++;
                } else if (globalDuoText.match(/\b(2girls|yuri|lesbian|tribadism)\b/)) {
                    girlCount++;
                } else if (girlCount === 1) {
                    boyCount++;
                } else {
                    girlCount++;
                }
            }

            return {
                n,
                rawName,
                namePrefix,
                base,
                outfit,
                slotAction,
                tplActionForSlot,
                center,
                centersSuffix,
                uc: cleanLorebookTags(slot.uc)
            };
        });

        // 空状态保护：当用户既没有选动作、也没有指定任何角色时，展示友好提示，绝不凭空捏造 Prompt
        const hasAnyChar = charDetails.some(c => c.rawName || c.base || c.outfit || c.slotAction || c.tplActionForSlot);
        const hasAnyAction = wbActions.length > 0 || !!comp?.customActionInput;
        if (!hasAnyChar && !hasAnyAction) {
            return '// 💡 动作工坊就绪：请在上方挑选世界书动作/分镜模板，并安排参演角色档案...';
        }

        // ── CASE 1: SOLO MODE ──
        if (isSolo) {
            const char = charDetails[0] || { n: 1, namePrefix: '', base: '', outfit: '', slotAction: '', tplActionForSlot: '', centersSuffix: '', uc: '' };
            let allActions = [char.tplActionForSlot, totalSoloActions, totalInteractions, char.slotAction].filter(Boolean).join(', ');
            let outfit = char.outfit;
            let base = char.base;

            // 第一人称 POV / 互动性动作智能检测：如果动作带有 pov 且包含他人交互器官/肢体，严禁在场景中注入 solo！
            const isPovInteraction = /\b(pov|first-person\s+pov)\b/i.test(allActions) && /\b(1boy|faceless\s+male|penis|dick|cock|hand|grab|penetration|oral|fellatio|throat|deepthroat|cum|sex)\b/i.test(allActions);

            let genderSolo = boyCount > 0 ? '1boy, solo' : '1girl, solo';
            if (isPovInteraction) {
                genderSolo = boyCount > 0 ? '1boy, 1girl, pov' : '1girl, 1boy, pov';
            }

            // 单人模式清洗：自动清洗误入的双人体位/人数标签，以及开头重叠的单人词
            if (!isPovInteraction) {
                allActions = allActions
                    .replace(/\b1girl\s*,\s*1boy\b,?\s*/gi, '')
                    .replace(/\b1boy\s*,\s*1girl\b,?\s*/gi, '')
                    .replace(/\b2girls\b,?\s*/gi, '')
                    .replace(/\b2boys\b,?\s*/gi, '')
                    .replace(/\bfaceless\s+male\b,?\s*/gi, '')
                    .replace(/\bclothed\s+female\s+nude\s+male\b,?\s*/gi, '')
                    .replace(/^(1girl|1boy|solo)\s*,?\s*/gi, '')
                    .replace(/,\s*(1girl|1boy|solo)\s*(?=,|$)/gi, '');
            } else {
                allActions = allActions
                    .replace(/\bsolo\b,?\s*/gi, '')
                    .replace(/\b2::pov::\s*,?\s*/gi, '')
                    .replace(/\bpov\b,?\s*/gi, '')
                    .replace(/^(1girl|1boy)\s*,?\s*/gi, '')
                    .replace(/,\s*(1girl|1boy)\s*(?=,|$)/gi, '');
            }
            allActions = allActions.replace(/^[,;\s]+|[,;\s]+$/g, '').trim();

            // 构图冲突清洗：清除动作中与用户选择的机位相矛盾的构图/姿态词
            // 例如用户选了 face focus + close-up，动作里的 full body / legs focus / standing 等必须被剔除
            if (cameraTags) {
                allActions = pruneConflictingActionTags(allActions, cameraTags);
            }

            // 动作与服装姿态冲突清洗：如坐姿/跪姿/卧姿自动清理服装和外貌里的 standing
            if (allActions.match(/\b(sitting|lying|kneeling|seiza|crawling|on_stomach|on_back|straddle|squatting)\b/i)) {
                outfit = outfit.replace(/\bstanding\b,?\s*/gi, '').trim();
                base = base.replace(/\bstanding\b,?\s*/gi, '').trim();
            }

            // 亲密/身体/非战斗动作自动清理手持武器/法杖，防止 AI 强行画立正持杖图
            if (allActions.match(/\b(breast|lactation|sucking|nipple|fellatio|blowjob|paizuri|sex|penetration|cunnilingus|lying|sleeping|bed|kiss|hug|straddle|kneeling|sitting|on_stomach|on_back)\b/i)) {
                outfit = outfit.replace(/\b(purple\s+magic\s+staff|magic\s+staff|holding\s+staff|holding\s+weapon|staff|weapon|magic\s+wand)\b,?\s*/gi, '').trim();
                base = base.replace(/\b(purple\s+magic\s+staff|magic\s+staff|holding\s+staff|holding\s+weapon|staff|weapon|magic\s+wand)\b,?\s*/gi, '').trim();
            }

            // 单人标准多角色分片结构：Scene: ...; Char1: ...
            // 无论单人还是双人，统一遵循多角色规范！
            // 当开启 5x5 严格坐标时附带 |centers:XY；关闭时由 AI 自主决定站位 (NovelAI V4 原生 Order-based 多角色模式)
            const soloScenePart = [genderSolo, cameraTags, totalScene].filter(Boolean).join(', ');
            const centerSuffix = (comp?.useCoords === true) ? char.centersSuffix : '';
            const charPart = [char.namePrefix, base, outfit, allActions].filter(Boolean).join(', ');
            const res = [`Scene: ${soloScenePart}`, `Char1: ${charPart}${centerSuffix}`];
            if (char.uc) res.push(`Char1 UC: ${char.uc}`);
            return res.join('; ');
        }

        // ── CASE 2: DUO / MULTI-CHARACTER MODE ──
        let countTag = '2girls';
        if (girlCount > 0 && boyCount === 0) {
            countTag = girlCount === 1 ? '1girl' : `${girlCount}girls`;
        } else if (boyCount > 0 && girlCount === 0) {
            countTag = boyCount === 1 ? '1boy' : `${boyCount}boys`;
        } else if (girlCount > 0 && boyCount > 0) {
            countTag = `${girlCount}girl${girlCount > 1 ? 's' : ''}, ${boyCount}boy${boyCount > 1 ? 's' : ''}`;
        }

        // 姿态冲突自动清洗
        const allInteractionText = totalInteractions + ' ' + totalSoloActions;
        charDetails.forEach(char => {
            if ((char.tplActionForSlot + ' ' + allInteractionText).match(/\b(sitting|lying|kneeling|seiza|crawling|on_stomach|on_back|straddle|squatting)\b/i)) {
                char.outfit = char.outfit.replace(/\bstanding\b,?\s*/gi, '').trim();
                char.base = char.base.replace(/\bstanding\b,?\s*/gi, '').trim();
            }
            if ((char.tplActionForSlot + ' ' + allInteractionText).match(/\b(breast|lactation|sucking|nipple|fellatio|blowjob|paizuri|sex|penetration|cunnilingus|lying|sleeping|bed|kiss|hug|straddle|kneeling|sitting|on_stomach|on_back)\b/i)) {
                char.outfit = char.outfit.replace(/\b(purple\s+magic\s+staff|magic\s+staff|holding\s+staff|holding\s+weapon|staff|weapon|magic\s+wand)\b,?\s*/gi, '').trim();
                char.base = char.base.replace(/\b(purple\s+magic\s+staff|magic\s+staff|holding\s+staff|holding\s+weapon|staff|weapon|magic\s+wand)\b,?\s*/gi, '').trim();
            }
        });

        // 彻底杜绝 "2girls, 1girl" 或 "1girl, 1boy, 1girl" 的重叠矛盾：
        // 关键修复：无论是标记为 [👥 互动] 还是普通 [💃 动作]，在双人同框模式下都必须作为共享动作并入，严禁丢弃！
        const allGeneralActions = [totalInteractions, totalSoloActions].filter(Boolean).join(', ');
        let cleanInteractions = allGeneralActions
            .replace(/^(1girl\s*,\s*1boy|1boy\s*,\s*1girl|2girls|2boys|1girl|1boy)\s*,?\s*/gi, '')
            .trim();
        if (cameraTags) {
            cleanInteractions = pruneConflictingActionTags(cleanInteractions, cameraTags);
        }

        // 多角色标准分片结构：Scene: ...; Char1: ...; Char2: ...
        // 当开启 5x5 严格坐标时附带 |centers:XY；关闭时由 AI 自主决定站位 (NovelAI V4 原生 Order-based 多角色模式)
        const scenePart = [countTag, cameraTags, cleanInteractions, totalScene].filter(Boolean).join(', ');
        const parts = [`Scene: ${scenePart}`];

        charDetails.forEach((char, idx) => {
            let slotActions = [char.tplActionForSlot, char.slotAction].filter(Boolean).join(', ');
            let charContent = [char.namePrefix, char.base, char.outfit, slotActions].filter(Boolean).join(', ');

            // 关键修复：如果该槽位未绑定任何具体角色档案（如双人同框中的匿名配角/路人），根据推断性别自动补全占位符，
            // 严禁产生空 Char 或直接漏掉 Char2 导致与 Scene 中的人数不匹配！
            if (!charContent && effectiveSlots.length > 1) {
                if (boyCount > 0 && girlCount > 0 && idx === 1) {
                    charContent = '1boy, faceless male';
                } else if (boyCount > 1) {
                    charContent = '1boy';
                } else {
                    charContent = '1girl';
                }
            }

            if (charContent) {
                const centerSuffix = (comp?.useCoords === true) ? char.centersSuffix : '';
                parts.push(`Char${char.n}: ${charContent}${centerSuffix}`);
                if (char.uc) parts.push(`Char${char.n} UC: ${char.uc}`);
            }
        });

        return parts.join('; ');
    }

    // ══════════════════════════════════════════════════════════
    //  Portrait Test Modes, Suite Generator & Tabbed Gallery
    // ══════════════════════════════════════════════════════════
    const TEST_PRESETS = {
        portrait: {
            title: '肖像特写',
            desc: '上半身特写，检验发色、瞳色、五官细节与发型',
            tags: '1girl, solo, looking_at_viewer, upper_body, portrait, simple_background, best_quality, masterpiece'
        },
        fullbody: {
            title: '全身立绘',
            desc: '站立全景，检验完整服装、鞋袜搭配与身材比例',
            tags: '1girl, solo, looking_at_viewer, full_body, standing, simple_background, best_quality, masterpiece'
        },
        dynamic: {
            title: '动态姿态',
            desc: '微表情与动作姿势，检验角色生动的神态与衣服摆动',
            tags: '1girl, solo, slight_smile, dynamic_pose, upper_body, looking_at_viewer, expressive, simple_background, best_quality, masterpiece'
        }
    };

    function registerSubmodal(modal) {
        if (!modal) return;
        document.body.classList.add('cw-submodal-open');
        if (modal.id === 'cw-image-viewer-modal') {
            document.body.classList.add('cw-viewer-open');
        }
        const checkClose = () => {
            if (!modal.isConnected) {
                if (modal.id === 'cw-image-viewer-modal') {
                    document.body.classList.remove('cw-viewer-open');
                }
                if (!document.querySelector('.cw-modal-mask')) {
                    document.body.classList.remove('cw-submodal-open');
                }
            } else {
                requestAnimationFrame(checkClose);
            }
        };
        requestAnimationFrame(checkClose);
    }

    function openPortraitTestModal(name, baseTags, outfitTags, onSetAvatar = null, triggerBtn = null) {
        const cleanName = (name || 'Character').trim();
        const existing = document.getElementById('cw-test-mode-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'cw-test-mode-modal';
        modal.className = 'cw-modal-mask';
        modal.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;width:100% !important;height:100% !important;height:100dvh !important;inset:0 !important;z-index:2147483647 !important;background:rgba(10,15,29,.96) !important;backdrop-filter:blur(14px) !important;-webkit-backdrop-filter:blur(14px) !important;display:flex !important;align-items:center !important;justify-content:center !important;overflow-y:auto !important;padding:max(16px, env(safe-area-inset-top, 16px)) 12px max(16px, env(safe-area-inset-bottom, 16px)) !important;box-sizing:border-box !important;-webkit-overflow-scrolling:touch !important;';
        modal.innerHTML = `
            <div class="cw-modal" style="width:480px;max-width:96vw;max-height:calc(100dvh - 32px);display:flex;flex-direction:column;min-height:min-content">
                <div class="cw-modal-hd" style="flex-shrink:0">
                    <strong style="color:#38bdf8;font-size:14px"><i class="fa-solid fa-palette"></i> 选择立绘测试视角 · ${esc(cleanName)}</strong>
                    <button class="cw-btn sm" id="cw-test-mode-close">✕</button>
                </div>
                <div class="cw-modal-bd" style="flex:1 1 auto;min-height:min-content;overflow-y:auto;gap:10px;-webkit-overflow-scrolling:touch">
                    <div style="font-size:12px;opacity:.75;margin-bottom:2px">请选择本次测试生成的视角模式或一键全景套图：</div>
                    
                    <button class="cw-btn cw-test-opt" data-mode="portrait" type="button" style="padding:10px 14px;display:flex;align-items:center;justify-content:space-between;text-align:left;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:8px">
                        <div>
                            <div style="font-weight:bold;color:#38bdf8;font-size:13px"><i class="fa-solid fa-user"></i> 👤 肖像特写 (Portrait)</div>
                            <div style="font-size:11px;opacity:.7;margin-top:2px">上半身特写，检验发色、瞳色、五官细节与发型</div>
                        </div>
                        <i class="fa-solid fa-chevron-right" style="opacity:.4"></i>
                    </button>

                    <button class="cw-btn cw-test-opt" data-mode="fullbody" type="button" style="padding:10px 14px;display:flex;align-items:center;justify-content:space-between;text-align:left;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:8px">
                        <div>
                            <div style="font-weight:bold;color:#f472b6;font-size:13px"><i class="fa-solid fa-person-dress"></i> 👗 全身立绘 (Full Body)</div>
                            <div style="font-size:11px;opacity:.7;margin-top:2px">站立全景，检验完整服装、鞋袜搭配与身材比例</div>
                        </div>
                        <i class="fa-solid fa-chevron-right" style="opacity:.4"></i>
                    </button>

                    <button class="cw-btn cw-test-opt" data-mode="dynamic" type="button" style="padding:10px 14px;display:flex;align-items:center;justify-content:space-between;text-align:left;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:8px">
                        <div>
                            <div style="font-weight:bold;color:#4ade80;font-size:13px"><i class="fa-solid fa-person-running"></i> 💃 动态姿态 (Dynamic Pose)</div>
                            <div style="font-size:11px;opacity:.7;margin-top:2px">微表情与动作姿势，检验角色生动的神态与衣服摆动</div>
                        </div>
                        <i class="fa-solid fa-chevron-right" style="opacity:.4"></i>
                    </button>

                    <button class="cw-btn cw-test-opt" data-mode="all" type="button" style="padding:11px 14px;display:flex;align-items:center;justify-content:space-between;text-align:left;background:linear-gradient(135deg, rgba(2,132,199,.25), rgba(56,189,248,.15));border:1px solid rgba(56,189,248,.4);border-radius:8px">
                        <div>
                            <div style="font-weight:bold;color:#fff;font-size:13px"><i class="fa-solid fa-wand-magic-sparkles" style="color:#38bdf8"></i> 📦 一键生成全景套图 (3张)</div>
                            <div style="font-size:11px;opacity:.8;margin-top:2px">依次生成【特写 + 全身 + 动态】3张分镜，在弹窗画廊中对比切换与挑选头像</div>
                        </div>
                        <i class="fa-solid fa-angles-right" style="color:#38bdf8"></i>
                    </button>

                    <div style="margin-top:6px;padding-top:8px;border-top:1px dashed rgba(255,255,255,0.12)">
                        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#38bdf8;cursor:pointer;user-select:none">
                            <input id="cw-test-transparent-bg" type="checkbox" style="cursor:pointer;accent-color:#38bdf8;width:15px;height:15px">
                            <span>✨ 启用透明背景 (NAI V5 原生 32位 RGBA 免抠图立绘)</span>
                        </label>
                    </div>
                </div>
            </div>
        `;

        modal.querySelector('#cw-test-mode-close')?.addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        const transCheckbox = modal.querySelector('#cw-test-transparent-bg');
        if (transCheckbox) {
            transCheckbox.checked = localStorage.getItem('rbq-cw-test-transparent-bg') === '1';
            transCheckbox.addEventListener('change', () => {
                localStorage.setItem('rbq-cw-test-transparent-bg', transCheckbox.checked ? '1' : '0');
            });
        }

        modal.querySelectorAll('.cw-test-opt').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                const isTransparent = Boolean(modal.querySelector('#cw-test-transparent-bg')?.checked);
                modal.remove();
                executePortraitTest(cleanName, baseTags, outfitTags, mode, onSetAvatar, triggerBtn, isTransparent);
            });
        });

        document.body.appendChild(modal);
        registerSubmodal(modal);
    }

    async function executePortraitTest(cleanName, baseTags, outfitTags, mode = 'portrait', onSetAvatar = null, triggerBtn = null, transparentBg = false) {
        const origHtml = triggerBtn ? triggerBtn.innerHTML : '';
        if (triggerBtn) {
            triggerBtn.disabled = true;
            triggerBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 准备生图...';
        }

        try {
            const modesToRun = mode === 'all' ? ['portrait', 'fullbody', 'dynamic'] : [mode];
            const results = [];

            for (let i = 0; i < modesToRun.length; i++) {
                const currentMode = modesToRun[i];
                const preset = TEST_PRESETS[currentMode] || TEST_PRESETS.portrait;

                if (triggerBtn) {
                    triggerBtn.innerHTML = mode === 'all'
                        ? `<i class="fa-solid fa-spinner fa-spin"></i> [${i + 1}/3] ${preset.title}...`
                        : `<i class="fa-solid fa-spinner fa-spin"></i> 生成中...`;
                }

                toastr.info(`正在为「${cleanName}」生成 ${preset.title}${transparentBg ? ' (透明底)' : ''}...`, PLUGIN_NAME);

                let presetTags = preset.tags;
                let suffixTags = [];
                if (transparentBg) {
                    presetTags = presetTags.split(',')
                        .map(t => t.trim())
                        .filter(t => !/^(white_background|white background|simple_background|simple background|grey_background|gray_background|black_background|solid_background|scenery)$/i.test(t))
                        .join(', ');
                    if (currentMode === 'fullbody') {
                        suffixTags = ['2.0::transparent background::', 'has alpha', 'alpha transparency', 'shoes'];
                    } else {
                        suffixTags = ['2.0::transparent background::', 'has alpha', 'alpha transparency'];
                    }
                }

                const cleanOutfit = pruneConflictingOutfitTags(outfitTags, presetTags);
                const prompt = [presetTags, cleanName, baseTags, cleanOutfit, ...suffixTags].filter(Boolean).join(', ');

                const result = await RBQ.api.generateImage(prompt, 'cw-portrait-test', {}, (progress) => {
                    if (triggerBtn && typeof progress === 'string') {
                        const prefix = mode === 'all' ? `[${i + 1}/3] ` : '';
                        triggerBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${prefix}${progress.slice(0, 10)}...`;
                    }
                });

                if (result && result.url) {
                    results.push({
                        title: `${preset.title}${transparentBg ? ' 🌟透明底' : ''}`,
                        modeKey: currentMode,
                        url: result.url,
                        prompt
                    });
                }
            }

            if (results.length === 0) {
                throw new Error('生图未返回有效图片地址');
            }

            showPortraitTestGalleryModal(cleanName, results, onSetAvatar);
            toastr.success(`「${cleanName}」测试生图完成！共生成 ${results.length} 张图片`, PLUGIN_NAME);
        } catch (err) {
            console.error('[Character Workshop] 角色测试生图失败:', err);
            toastr.error('角色测试生图失败: ' + (err.message || String(err)), PLUGIN_NAME);
        } finally {
            if (triggerBtn) {
                triggerBtn.disabled = false;
                triggerBtn.innerHTML = origHtml;
            }
        }
    }

    function showPortraitTestGalleryModal(cleanName, results, onSetAvatar = null) {
        if (!results || results.length === 0) return;

        let activeIndex = 0;
        const hasMultiple = results.length > 1;

        const existing = document.getElementById('cw-image-viewer-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'cw-image-viewer-modal';
        modal.className = 'cw-modal-mask';
        modal.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;width:100% !important;height:100% !important;height:100dvh !important;inset:0 !important;z-index:2147483647 !important;background:rgba(10,15,29,.96) !important;backdrop-filter:blur(14px) !important;-webkit-backdrop-filter:blur(14px) !important;display:flex !important;align-items:center !important;justify-content:center !important;overflow-y:auto !important;padding:max(16px, env(safe-area-inset-top, 16px)) 12px max(16px, env(safe-area-inset-bottom, 16px)) !important;box-sizing:border-box !important;-webkit-overflow-scrolling:touch !important;';

        function renderGallery() {
            const currentItem = results[activeIndex] || results[0];
            const tabsHtml = hasMultiple ? `
                <div class="cw-tabs" style="padding:4px 8px;margin:0 14px;overflow-x:auto;background:rgba(0,0,0,.35)">
                    ${results.map((it, idx) => `
                        <button class="cw-tab ${idx === activeIndex ? 'on' : ''} cw-gallery-tab" data-idx="${idx}" type="button">
                            ${esc(it.title)}
                        </button>
                    `).join('')}
                </div>
            ` : '';

            modal.innerHTML = `
                <div class="cw-modal" style="width:680px;max-width:96vw;max-height:calc(100dvh - 32px);display:flex;flex-direction:column;min-height:min-content">
                    <div class="cw-modal-hd" style="flex-shrink:0">
                        <strong style="color:#38bdf8;font-size:14px"><i class="fa-solid fa-palette"></i> 角色立绘测试画廊 · ${esc(cleanName)} ${hasMultiple ? `(${activeIndex + 1}/${results.length})` : ''}</strong>
                        <button class="cw-btn sm" id="cw-gal-close">✕</button>
                    </div>
                    ${tabsHtml}
                    <div class="cw-modal-bd" style="flex:1 1 auto;min-height:min-content;overflow-y:auto;align-items:center;gap:8px;-webkit-overflow-scrolling:touch">
                        <div style="width:100%;flex:1 1 auto;max-height:48vh;min-height:140px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);border-radius:8px;overflow:hidden">
                            <img src="${esc(currentItem.url)}" style="max-width:100%;max-height:46vh;width:auto;height:auto;object-fit:contain;display:block" alt="Test Result" />
                        </div>
                        <div style="width:100%;background:rgba(0,0,0,0.35);padding:6px 10px;border-radius:6px;font-size:11px;color:rgba(255,255,255,0.7);max-height:65px;overflow-y:auto;word-break:break-all;line-height:1.35">
                            <strong style="color:#38bdf8">【${esc(currentItem.title)}】测试提示词：</strong> ${esc(currentItem.prompt)}
                        </div>
                    </div>
                    <div class="cw-modal-ft" style="justify-content:flex-end;gap:8px;flex-wrap:wrap">
                        <a href="${esc(currentItem.url)}" target="_blank" class="cw-btn sm cy" style="text-decoration:none"><i class="fa-solid fa-arrow-up-right-from-square"></i> 查看原图</a>
                        ${onSetAvatar ? `<button class="cw-btn sm gn" id="cw-gal-set-avatar"><i class="fa-solid fa-user-check"></i> 设为角色头像</button>` : ''}
                        <button class="cw-btn sm" id="cw-gal-copy-prompt"><i class="fa-regular fa-copy"></i> 复制提示词</button>
                        <button class="cw-btn sm pri" id="cw-gal-done">完成</button>
                    </div>
                </div>
            `;

            modal.querySelector('#cw-gal-close')?.addEventListener('click', () => modal.remove());
            modal.querySelector('#cw-gal-done')?.addEventListener('click', () => modal.remove());
            modal.querySelector('#cw-gal-copy-prompt')?.addEventListener('click', async () => {
                const ok = await copyToClipboard(currentItem.prompt);
                if (ok) toastr.success('已复制提示词', PLUGIN_NAME);
                else toastr.warning('复制失败，请手动选取', PLUGIN_NAME);
            });
            if (onSetAvatar) {
                modal.querySelector('#cw-gal-set-avatar')?.addEventListener('click', () => {
                    onSetAvatar(currentItem.url);
                    toastr.success(`已将【${currentItem.title}】设为角色头像！`, PLUGIN_NAME);
                });
            }
            modal.querySelectorAll('.cw-gallery-tab').forEach(b => {
                b.addEventListener('click', () => {
                    activeIndex = +b.dataset.idx;
                    renderGallery();
                });
            });
        }

        renderGallery();
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
        document.body.appendChild(modal);
        registerSubmodal(modal);
    }

    function showGeneratedImageModal(title, prompt, result) {
        const url = result?.url || (typeof result === 'string' ? result : null);
        if (!url) {
            toastr.warning('生图未返回有效图片地址', PLUGIN_NAME);
            return;
        }

        const existing = document.getElementById('cw-image-viewer-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'cw-image-viewer-modal';
        modal.className = 'cw-modal-mask';
        modal.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;width:100% !important;height:100% !important;height:100dvh !important;inset:0 !important;z-index:2147483647 !important;background:rgba(10,15,29,.96) !important;backdrop-filter:blur(14px) !important;-webkit-backdrop-filter:blur(14px) !important;display:flex !important;align-items:center !important;justify-content:center !important;overflow-y:auto !important;padding:max(16px, env(safe-area-inset-top, 16px)) 12px max(16px, env(safe-area-inset-bottom, 16px)) !important;box-sizing:border-box !important;-webkit-overflow-scrolling:touch !important;';
        modal.innerHTML = `
            <div class="cw-modal" style="width:680px;max-width:96vw;max-height:calc(100dvh - 32px);display:flex;flex-direction:column;min-height:min-content">
                <div class="cw-modal-hd" style="flex-shrink:0">
                    <strong style="color:#38bdf8;font-size:14px"><i class="fa-solid fa-image"></i> ${esc(title)}</strong>
                    <button class="cw-btn sm" id="cw-img-close">✕</button>
                </div>
                <div class="cw-modal-bd" style="flex:1 1 auto;min-height:min-content;overflow-y:auto;align-items:center;gap:8px;-webkit-overflow-scrolling:touch">
                    <div style="width:100%;flex:1 1 auto;max-height:50vh;min-height:140px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);border-radius:8px;overflow:hidden">
                        <img src="${esc(url)}" style="max-width:100%;max-height:48vh;width:auto;height:auto;object-fit:contain;display:block" alt="Generated Image" />
                    </div>
                    <div style="width:100%;background:rgba(0,0,0,0.35);padding:6px 10px;border-radius:6px;font-size:11px;color:rgba(255,255,255,0.7);max-height:65px;overflow-y:auto;word-break:break-all;line-height:1.35">
                        <strong style="color:#38bdf8">提示词：</strong> ${esc(prompt)}
                    </div>
                </div>
                <div class="cw-modal-ft" style="justify-content:flex-end;gap:6px;flex-wrap:wrap">
                    <a href="${esc(url)}" target="_blank" class="cw-btn sm cy" style="text-decoration:none"><i class="fa-solid fa-arrow-up-right-from-square"></i> 查看原图</a>
                    <button class="cw-btn sm" id="cw-img-copy-prompt"><i class="fa-regular fa-copy"></i> 复制提示词</button>
                    <button class="cw-btn sm pri" id="cw-img-ok">完成</button>
                </div>
            </div>
        `;

        modal.querySelector('#cw-img-close')?.addEventListener('click', () => modal.remove());
        modal.querySelector('#cw-img-ok')?.addEventListener('click', () => modal.remove());
        modal.querySelector('#cw-img-copy-prompt')?.addEventListener('click', async () => {
            const ok = await copyToClipboard(prompt);
            if (ok) toastr.success('已复制提示词', PLUGIN_NAME);
            else toastr.warning('复制失败，请手动选取', PLUGIN_NAME);
        });
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
        document.body.appendChild(modal);
        registerSubmodal(modal);
    }

    // ══════════════════════════════════════════════════════════
    //  CSS Injection
    // ══════════════════════════════════════════════════════════
    (function injectStyles() {
        const old = document.getElementById('cw-styles-v2');
        if (old) old.remove();
        const s = document.createElement('style');
        s.id = 'cw-styles-v2';
        s.textContent = `
.cw-wrap{display:flex;flex-direction:column;width:100%;max-width:100%;height:100%;color:#f1f5f9;font-family:inherit;overflow-x:hidden;box-sizing:border-box}
.cw-hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(15,23,42,.4);backdrop-filter:blur(12px);gap:10px;flex-wrap:wrap;max-width:100%;box-sizing:border-box}
.cw-logo{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700;color:#38bdf8;flex-shrink:0}
.cw-tabs{display:flex;gap:4px;background:rgba(0,0,0,.3);padding:3px;border-radius:8px;border:1px solid rgba(255,255,255,.06);max-width:100%;box-sizing:border-box}
.cw-tab{background:0 0;border:none;color:rgba(255,255,255,.6);padding:5px 11px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;transition:.2s;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.cw-tab:hover{color:#fff;background:rgba(255,255,255,.08)}
.cw-tab.on{color:#38bdf8;background:rgba(56,189,248,.15);box-shadow:0 2px 8px rgba(56,189,248,.2)}
.cw-tab-short{display:none}
.cw-body{flex:1;overflow-y:auto;overflow-x:hidden;padding:14px;display:flex;flex-direction:column;gap:14px;max-width:100%;box-sizing:border-box}
.cw-card{background:rgba(30,41,59,.45);border:1px solid rgba(255,255,255,.08);border-radius:11px;padding:12px;backdrop-filter:blur(8px);display:flex;flex-direction:column;gap:9px;max-width:100%;box-sizing:border-box;overflow:hidden}
.cw-card-hd{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;max-width:100%;box-sizing:border-box}
.cw-card-tt{font-size:13px;font-weight:700;display:inline-flex;align-items:center;gap:6px;color:#e2e8f0}
.cw-grid5{width:250px;height:250px;background:rgba(15,23,42,.75);border:1.5px solid rgba(56,189,248,.35);border-radius:9px;display:grid;grid-template-columns:repeat(5,1fr);grid-template-rows:repeat(5,1fr);gap:0;padding:0;position:relative;box-shadow:inset 0 0 18px rgba(0,0,0,.5);flex-shrink:0;box-sizing:border-box}
.cw-cell{background:rgba(255,255,255,.02);border:1px dashed rgba(255,255,255,.08);display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;transition:.15s;position:relative;font-size:9.5px;color:rgba(255,255,255,.3);font-weight:bold;box-sizing:border-box}
.cw-cell:hover{background:rgba(56,189,248,.15);border-color:rgba(56,189,248,.5);color:#38bdf8}
.cw-cell.has{border-style:solid}
.cw-pin{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:bold;color:#fff;box-shadow:0 2px 5px rgba(0,0,0,.6);position:absolute;z-index:3;cursor:grab;transition:transform .12s, box-shadow .12s;touch-action:none;user-select:none;-webkit-user-select:none}
.cw-pin:active{cursor:grabbing}
.cw-slot{background:rgba(15,23,42,.55);border:1px solid rgba(255,255,255,.08);border-radius:9px;padding:11px;display:flex;flex-direction:column;gap:9px;transition:.2s;box-sizing:border-box;max-width:100%}
.cw-slot.on{border-color:#38bdf8;box-shadow:0 0 10px rgba(56,189,248,.15)}
.cw-slot-top{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.cw-badge{padding:2px 7px;border-radius:5px;font-size:11px;font-weight:bold}
.cw-slot-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:7px}
.cw-in,.cw-sel,.cw-ta{width:100%;box-sizing:border-box;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.12);border-radius:5px;color:#fff;padding:5px 9px;font-size:12px;font-family:inherit;transition:.2s}
.cw-in:focus,.cw-sel:focus,.cw-ta:focus{outline:none;border-color:#38bdf8;background:rgba(0,0,0,.5)}
.cw-ta{min-height:44px;resize:vertical;font-family:monospace}
.cw-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:5px 11px;border-radius:5px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid transparent;transition:.2s;background:rgba(255,255,255,.08);color:#fff;white-space:nowrap !important;flex-shrink:0 !important}
.cw-btn:hover{filter:brightness(1.2)}
.cw-btn.pri{background:linear-gradient(135deg,#0284c7,#38bdf8);border-color:rgba(56,189,248,.5);box-shadow:0 2px 10px rgba(56,189,248,.3);color:#fff}
.cw-btn.cy{background:rgba(56,189,248,.15);border-color:rgba(56,189,248,.4);color:#38bdf8}
.cw-btn.pk{background:rgba(244,114,182,.15);border-color:rgba(244,114,182,.4);color:#f472b6}
.cw-btn.gn{background:rgba(74,222,128,.15);border-color:rgba(74,222,128,.4);color:#4ade80}
.cw-btn.am{background:rgba(251,191,36,.15);border-color:rgba(251,191,36,.4);color:#fbbf24}
.cw-btn.rd{background:rgba(239,68,68,.15);border-color:rgba(239,68,68,.4);color:#ef4444}
.cw-btn.sm{padding:3px 7px;font-size:11px}
.cw-preview{background:rgba(15,23,42,.7);border:1px solid rgba(56,189,248,.3);border-radius:9px;padding:11px;display:flex;flex-direction:column;gap:7px}
.cw-code{background:rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.08);border-radius:5px;padding:7px 9px;font-family:monospace;font-size:11px;color:#a5f3fc;word-break:break-all;max-height:110px;overflow-y:auto}
.cw-chgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;width:100%;max-width:100%;box-sizing:border-box}
.cw-chcard{background:rgba(30,41,59,.5);border:1px solid rgba(255,255,255,.08);border-radius:11px;padding:11px;display:flex !important;flex-direction:column !important;gap:8px;transition:.2s;position:relative;width:100% !important;max-width:100% !important;box-sizing:border-box !important;overflow:hidden}
.cw-chcard:hover{transform:translateY(-2px);border-color:rgba(56,189,248,.4);box-shadow:0 6px 18px rgba(0,0,0,.4)}
.cw-chcard-actions{display:flex !important;gap:6px !important;justify-content:flex-end !important;align-items:center !important;margin-top:6px !important;flex-wrap:wrap !important;width:100% !important;box-sizing:border-box !important}
.cw-avatar{width:42px;height:42px;border-radius:7px;background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;font-size:18px;overflow:hidden;flex-shrink:0}
.cw-avatar img{width:100%;height:100%;object-fit:cover}
.cw-chip{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:3px;padding:2px 6px;font-size:10.5px;color:rgba(255,255,255,.75);cursor:pointer;transition:.15s;white-space:nowrap !important;flex-shrink:0 !important;user-select:none;display:inline-flex;align-items:center}
.cw-chip:hover{background:rgba(255,255,255,.12);color:#fff}
.cw-chip.on{background:rgba(56,189,248,.2)!important;border-color:rgba(56,189,248,.7)!important;color:#38bdf8!important;font-weight:bold}
.cw-modal-mask{position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100%!important;height:100%!important;height:100dvh!important;inset:0!important;z-index:2147483600!important;background:rgba(10,15,29,.96)!important;backdrop-filter:blur(14px)!important;-webkit-backdrop-filter:blur(14px)!important;display:flex!important;align-items:center!important;justify-content:center!important;overflow-y:auto!important;padding:16px!important;box-sizing:border-box!important;-webkit-overflow-scrolling:touch!important}
#cw-image-viewer-modal{z-index:2147483647!important}
#cw-test-mode-modal{z-index:2147483647!important}
#cw-character-editor-modal{z-index:2147483600!important}
#rbq-sdt-lorebook-search-modal{z-index:2147483610!important}
#rbq-sdt-variant-picker-modal{z-index:2147483620!important}
#rbq-sdt-wb-test-modal{z-index:2147483630!important}
#rbq-sdt-test-mode-modal{z-index:2147483635!important}
#rbq-sdt-test-preview-modal{z-index:2147483640!important}
body.cw-viewer-open #cw-character-editor-modal,
body.cw-viewer-open #cw-test-mode-modal,
body.cw-lorebook-picker-open #cw-character-editor-modal,
body.cw-lorebook-picker-open #cw-test-mode-modal{opacity:0.15!important;filter:blur(5px)!important;pointer-events:none!important;transition:opacity .2s ease,filter .2s ease}
.cw-modal{background:#0f172a!important;border:1px solid rgba(56,189,248,.35)!important;border-radius:13px;width:820px;max-width:96vw;max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);display:flex!important;flex-direction:column!important;min-height:min-content!important;overflow:hidden!important;box-shadow:0 25px 60px rgba(0,0,0,.95)!important;box-sizing:border-box;margin:auto!important;position:relative!important;flex-shrink:0!important}
.cw-modal-hd{display:flex;align-items:center;justify-content:space-between;padding:11px 16px;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(56,189,248,.08);flex-shrink:0!important}
.cw-modal-bd{flex:1 1 auto!important;min-height:min-content!important;overflow-y:auto!important;padding:14px 16px;display:flex;flex-direction:column;gap:12px;box-sizing:border-box;-webkit-overflow-scrolling:touch!important}
.cw-modal-ft{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-top:1px solid rgba(255,255,255,.08);background:rgba(0,0,0,.3);flex-shrink:0!important;flex-wrap:wrap;gap:8px}
.cw-warn{background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.4);border-radius:7px;padding:8px 12px;font-size:12px;color:#fbbf24;display:flex;align-items:center;gap:8px}
.cw-wb-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:6px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);font-size:11.5px;color:#f8fafc;box-sizing:border-box;transition:.15s}
.cw-wb-chip.interaction{background:rgba(244,114,182,.12);border-color:rgba(244,114,182,.45)}
.cw-wb-chip.scene{background:rgba(251,191,36,.12);border-color:rgba(251,191,36,.45)}
.cw-wb-chip.action{background:rgba(56,189,248,.12);border-color:rgba(56,189,248,.45)}
.cw-wb-chip.template{background:rgba(168,85,247,.15);border-color:rgba(168,85,247,.55)}
.cw-wb-badge{font-size:10px;font-weight:bold;padding:1px 5px;border-radius:4px;user-select:none}
.cw-wb-badge.interaction{background:rgba(244,114,182,.25);color:#f472b6}
.cw-wb-badge.scene{background:rgba(251,191,36,.25);color:#fbbf24}
.cw-wb-badge.action{background:rgba(56,189,248,.25);color:#38bdf8}
.cw-wb-badge.template{background:rgba(168,85,247,.3);color:#c084fc}
.cw-wb-tags{font-size:11px;opacity:.7;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace}
.cw-wb-toggle-type{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);border-radius:4px;color:#cbd5e1;cursor:pointer;font-size:11px;padding:1px 5px}
.cw-wb-del{background:transparent;border:none;color:#f87171;cursor:pointer;font-size:12px;padding:0 3px}
.cw-wb-del:hover{color:#ef4444}
.cw-actor-card{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);cursor:pointer;transition:.15s;user-select:none}
.cw-actor-card:hover{background:rgba(255,255,255,.08);border-color:rgba(56,189,248,.35)}
.cw-actor-card.on{background:rgba(56,189,248,.14);border-color:rgba(56,189,248,.6);box-shadow:0 0 10px rgba(56,189,248,.2)}

@media (max-width: 768px) {
  .cw-wrap{min-height:0;flex:1;max-width:100%!important;overflow-x:hidden!important}
  .cw-hdr{padding:6px 8px;gap:6px;flex-shrink:0;width:100%!important;max-width:100%!important;box-sizing:border-box!important}
  .cw-logo{font-size:13px}
  .cw-tabs{width:100%!important;max-width:100%!important;overflow-x:auto!important;-webkit-overflow-scrolling:touch!important;flex-wrap:nowrap!important;scrollbar-width:none;gap:3px;padding:2px;box-sizing:border-box!important}
  .cw-tabs::-webkit-scrollbar{display:none}
  .cw-tab{white-space:nowrap;flex-shrink:0;font-size:11px;padding:4px 7px}
  .cw-tab-full{display:none!important}
  .cw-tab-short{display:inline!important}
  .cw-body{padding:6px 4px;gap:8px;max-width:100%!important;overflow-x:hidden!important}
  .cw-card{padding:8px 7px;gap:8px;max-width:100%!important;width:100%!important;box-sizing:border-box!important}
  .cw-card-hd{gap:6px;flex-direction:column!important;align-items:stretch!important;width:100%!important}
  .cw-card-tt{font-size:12px}
  .cw-scope-box{width:100%!important;display:flex!important;justify-content:space-between!important;overflow-x:auto!important;box-sizing:border-box!important}
  .cw-scope-box .cw-scope-btn{flex:1 1 auto!important;text-align:center!important;justify-content:center!important;padding:3px 4px!important;font-size:10.5px!important;white-space:nowrap!important}
  .cw-archive-tools{display:flex!important;gap:6px!important;width:100%!important;justify-content:stretch!important;box-sizing:border-box!important}
  .cw-archive-tools .cw-btn{flex:1 1 auto!important;justify-content:center!important;padding:4px 8px!important;font-size:11px!important}
  .cw-chgrid{grid-template-columns:100%!important;gap:8px!important;width:100%!important;box-sizing:border-box!important}
  .cw-chcard{padding:8px 9px!important;gap:7px!important;width:100%!important;max-width:100%!important;box-sizing:border-box!important}
  .cw-chcard-actions{display:flex!important;flex-wrap:wrap!important;justify-content:flex-start!important;gap:5px!important;width:100%!important;box-sizing:border-box!important}
  .cw-chcard-actions .cw-btn{flex:1 1 auto!important;min-width:0!important;justify-content:center!important;padding:4px 7px!important;font-size:11px!important;box-sizing:border-box!important}
  .cw-chcard-actions .cw-del-char{flex:0 0 auto!important;width:32px!important;padding:4px 0!important}
  .cw-slots-grid{grid-template-columns:1fr!important;width:100%!important;box-sizing:border-box!important}
  .cw-slot{width:100%!important;max-width:100%!important;box-sizing:border-box!important;padding:8px!important}
  .cw-slot-grid{grid-template-columns:1fr!important;gap:6px!important;width:100%!important}
  .cw-modal-mask{position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100%!important;height:100%!important;height:100dvh!important;inset:0!important;padding:max(12px, env(safe-area-inset-top, 12px)) 8px max(12px, env(safe-area-inset-bottom, 12px))!important;display:flex!important;align-items:center!important;justify-content:center!important;overflow-y:auto!important;background:rgba(10,15,29,.96)!important;z-index:2147483647!important;-webkit-overflow-scrolling:touch!important}
  .cw-modal{width:100%!important;max-width:100%!important;min-height:min-content!important;max-height:calc(100vh - max(24px, env(safe-area-inset-top, 24px)) - max(24px, env(safe-area-inset-bottom, 24px)))!important;max-height:calc(100dvh - max(24px, env(safe-area-inset-top, 24px)) - max(24px, env(safe-area-inset-bottom, 24px)))!important;margin:auto 0!important;display:flex!important;flex-direction:column!important}
  .cw-modal-hd{padding:9px 12px;flex-shrink:0!important}
  .cw-modal-bd{padding:10px 12px;gap:10px;flex:1 1 auto!important;min-height:min-content!important;overflow-y:auto!important;-webkit-overflow-scrolling:touch!important}
  .cw-modal-ft{padding:8px 12px;gap:6px;flex-shrink:0!important;flex-wrap:wrap!important;justify-content:flex-end!important}
  .cw-modal-ft .cw-btn{flex:1 1 auto!important;min-width:0!important;justify-content:center!important;text-align:center!important}
  .cw-composer-actions{width:100%!important;display:flex!important}
  .cw-composer-actions .cw-btn{width:100%!important;justify-content:center!important}
}
`;
        document.head.appendChild(s);
    })();

    // ══════════════════════════════════════════════════════════
    //  Interactive Worldbook Picker Bridge
    // ══════════════════════════════════════════════════════════
    function openWorldbookPicker(title, onSelect, initialCategory = 'all', autoClean = true) {
        if (typeof RBQ?.api?.openLorebookSearchModal === 'function') {
            document.body.classList.add('cw-lorebook-picker-open');

            const handleClose = () => {
                document.body.classList.remove('cw-lorebook-picker-open');
            };

            RBQ.api.openLorebookSearchModal('all', (entry) => {
                handleClose();
                let rawText = typeof entry === 'string' ? entry : (entry?.content || entry?.tags || '');
                if (!rawText) return;
                const finalTags = autoClean ? cleanLorebookTags(rawText) : rawText.trim();
                if (finalTags) {
                    onSelect(finalTags, entry);
                } else {
                    const fallback = rawText.replace(/[\u4e00-\u9fa5]/g, '').trim();
                    if (fallback) onSelect(fallback, entry);
                }
            }, initialCategory);

            // 持续确保世界书搜索弹窗的 z-index 处于合适层级，且在弹窗关闭时自动恢复背景
            const checkPicker = () => {
                const sdtModal = document.getElementById('rbq-sdt-lorebook-search-modal');
                if (sdtModal && sdtModal.isConnected) {
                    sdtModal.style.setProperty('z-index', '2147483610', 'important');
                    requestAnimationFrame(checkPicker);
                } else {
                    handleClose();
                }
            };
            requestAnimationFrame(checkPicker);
        } else {
            toastr.warning('世界书搜索功能不可用，请确保智能生图触发器已启用', PLUGIN_NAME);
        }
    }

    // ══════════════════════════════════════════════════════════
    //  Character Editor Modal
    //  直接读写 SDT characterProfiles — 无中间层
    // ══════════════════════════════════════════════════════════
    /** Switch the 角色档案库 view (当前会话 / 角色库 / 同人库); shared by the scope tabs and the editor's 「去角色库」 link. */
    function setDossierScope(scope) {
        if (!(scope === 'chat' || scope === 'all' || scope === 'lorebook')) return false;
        dossierScope = scope;
        selectedDossierNames.clear();
        return true;
    }

    function openCharacterEditor(editName, onSaved, onOpenLibrary) {
        const isEdit = !!editName;
        const origProfile = isEdit ? getProfile(editName) : null;

        const draft = {
            displayName: origProfile?.displayName || editName || '',
            nameTag: origProfile?.nameTag || '',
            nameTagSource: origProfile?.nameTagSource || '',
            aliasesText: (Array.isArray(origProfile?.aliases) ? origProfile.aliases
                : String(origProfile?.aliases || '').split(/[,，]/)).map(a => String(a).trim()).filter(Boolean).join(', '),
            baseTags: origProfile?.baseTags || '',
            baseLocked: !!(origProfile?.baseLocked || origProfile?.isBaseLocked),
            isBaseLocked: !!(origProfile?.baseLocked || origProfile?.isBaseLocked),
            outfitLocked: !!(origProfile?.outfitLocked || origProfile?.isOutfitLocked),
            isOutfitLocked: !!(origProfile?.outfitLocked || origProfile?.isOutfitLocked),
            previousBaseTags: origProfile?.previousBaseTags,
            currentOutfit: origProfile?.currentOutfit || '',
            currentOutfitId: origProfile?.currentOutfitId || '',
            avatarUrl: origProfile?.avatarUrl || '',
            wardrobe: JSON.parse(JSON.stringify(origProfile?.wardrobe || [])),
        };
        if (draft.wardrobe.length === 0) {
            draft.wardrobe.push({ id: uid('w'), name: '默认服装', outfit: draft.currentOutfit || '', triggers: [], locked: false, createdAt: Date.now() });
        }
        if (!draft.currentOutfitId) {
            draft.currentOutfitId = draft.wardrobe[0]?.id || '';
        }

        let activeWIdx = 0;
        const mask = document.createElement('div');
        mask.id = 'cw-character-editor-modal';
        mask.className = 'cw-modal-mask';
        mask.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;width:100% !important;height:100% !important;height:100dvh !important;inset:0 !important;z-index:2147483600 !important;background:rgba(10,15,29,.96) !important;backdrop-filter:blur(14px) !important;-webkit-backdrop-filter:blur(14px) !important;display:flex !important;align-items:center !important;justify-content:center !important;overflow-y:auto !important;padding:max(16px, env(safe-area-inset-top, 16px)) 12px max(16px, env(safe-area-inset-bottom, 16px)) !important;box-sizing:border-box !important;-webkit-overflow-scrolling:touch !important;';

        function render() {
            const cw = draft.wardrobe[activeWIdx] || draft.wardrobe[0];
            const isCurrentlyWorn = (draft.currentOutfitId ? cw?.id === draft.currentOutfitId : (cw?.outfit && cw?.outfit === draft.currentOutfit));

            mask.innerHTML = `
                <div class="cw-modal" style="width:820px;max-width:96vw;max-height:calc(100dvh - 32px);display:flex;flex-direction:column;min-height:min-content">
                    <div class="cw-modal-hd" style="flex-shrink:0">
                        <strong style="color:#38bdf8;font-size:14px"><i class="fa-solid fa-id-card"></i> ${isEdit ? '编辑角色 · ' + esc(draft.displayName) : '✨ 新建角色档案'}${dossierScope === 'all' ? ' <span style="font-size:11px;font-weight:normal;padding:2px 6px;border-radius:4px;background:rgba(56,189,248,0.18);color:#7dd3fc;border:1px solid rgba(56,189,248,0.35)">📦 角色库模式</span>' : ''}</strong>
                        <button class="cw-btn sm" id="cw-ce-x">✕</button>
                    </div>
                    <div class="cw-modal-bd" style="flex:1 1 auto;min-height:min-content;overflow-y:auto;-webkit-overflow-scrolling:touch">
                        <!-- Name & Avatar -->
                        <div class="cw-card" style="padding:9px 12px">
                            <div style="display:flex;gap:10px;align-items:center">
                                <div class="cw-avatar" style="width:48px;height:48px" id="cw-ce-avatar-box">${draft.avatarUrl ? '<img src="' + esc(draft.avatarUrl) + '"/>' : '👤'}</div>
                                <div style="flex:1;display:flex;flex-direction:column;gap:5px">
                                    <div style="display:flex;gap:7px">
                                        <input id="cw-ce-name" class="cw-in" type="text" placeholder="角色姓名" value="${esc(draft.displayName)}" style="font-weight:bold;font-size:13px" ${isEdit ? 'disabled' : ''} />
                                        <button class="cw-btn am sm" id="cw-ce-import-card" type="button" title="重新提取当前角色卡的外貌，保留已有当前服装"><i class="fa-solid fa-file-import"></i> 从角色卡提取 / 更新外貌</button>
                                    </div>
                                    <div style="display:flex;gap:6px;align-items:center">
                                        <span style="font-size:10.5px;color:rgba(255,255,255,.5);white-space:nowrap">头像 URL:</span>
                                        <input id="cw-ce-avatar-url" class="cw-in" type="text" placeholder="https://... 或测试立绘后一键设为头像" value="${esc(draft.avatarUrl)}" style="font-size:11px;padding:3px 8px" />
                                    </div>
                                    <div style="display:flex;gap:6px;align-items:center">
                                        <span style="font-size:10.5px;color:rgba(255,255,255,.5);white-space:nowrap">英文绘图名 (name_tag):</span>
                                        <input id="cw-ce-name-tag" class="cw-in" type="text" placeholder="如 Hayase Saki (Blue Archive)；原创写 Name (original)；留空由 AI 根据剧情判断" value="${esc(draft.nameTag)}" style="font-size:11px;padding:3px 8px" />
                                    </div>
                                    <div style="display:flex;gap:6px;align-items:center">
                                        <span style="font-size:10.5px;color:rgba(255,255,255,.5);white-space:nowrap">别名:</span>
                                        <input id="cw-ce-aliases" class="cw-in" type="text" placeholder="如 早濑咲, 早瀬ユウカ, 咲" value="${esc(draft.aliasesText)}" style="font-size:11px;padding:3px 8px" />
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Base Tags + 7D Chips -->
                        <div class="cw-card">
                            <div class="cw-card-hd">
                                <span class="cw-card-tt" style="color:#38bdf8"><i class="fa-solid fa-dna"></i> 7 维全息外貌公式 (Base Tags)</span>
                                <div style="display:flex;gap:6px;align-items:center">
                                    <button class="cw-btn sm" id="cw-ce-toggle-base-lock" type="button" style="background:${draft.baseLocked ? 'rgba(163,230,53,0.18)' : 'rgba(255,255,255,0.06)'};border:1px solid ${draft.baseLocked ? 'rgba(163,230,53,0.5)' : 'rgba(255,255,255,0.15)'};color:${draft.baseLocked ? '#a3e635' : '#94a3b8'}" title="锁定人设：生图后绝对不回填篡改人设（吻痕/战损不沉淀至档案）">
                                        <i class="fa-solid ${draft.baseLocked ? 'fa-lock' : 'fa-lock-open'}"></i> ${draft.baseLocked ? '🔒 人设已锁定' : '🔓 锁定人设'}
                                    </button>
                                    <button class="cw-btn cy sm" id="cw-ce-wb-base" type="button"><i class="fa-solid fa-book-open"></i> 从世界书选外貌</button>
                                </div>
                            </div>
                            <div style="display:flex;flex-direction:column;gap:5px;max-height:180px;overflow-y:auto;background:rgba(0,0,0,.25);padding:8px 10px;border-radius:6px">
                                ${TRAITS.map(g => `<div style="display:flex;gap:5px;align-items:flex-start;flex-wrap:wrap">
                                    <span style="font-size:10.5px;font-weight:bold;color:${g.c};min-width:68px;padding-top:2px;flex-shrink:0">${esc(g.g)}:</span>
                                    <div style="display:flex;gap:3px;flex-wrap:wrap;flex:1">${g.t.map(t => `<button class="cw-chip cw-base-chip" data-tag="${esc(t.t)}" type="button">${esc(t.n)}</button>`).join('')}</div>
                                </div>`).join('')}
                            </div>
                            <textarea id="cw-ce-base" class="cw-ta" placeholder="girl, japanese, delicate_face, black_hair, red_eyes, large_breasts, fair_skin">${esc(draft.baseTags)}</textarea>
                        </div>

                        <!-- Wardrobe -->
                        <div class="cw-card">
                            <div class="cw-card-hd">
                                <span class="cw-card-tt" style="color:#ffb86c"><i class="fa-solid fa-shirt"></i> 差分衣柜 (${draft.wardrobe.length} 套)</span>
                                <div style="display:flex;gap:5px">
                                    <button class="cw-btn am sm" id="cw-ce-wb-outfit" type="button"><i class="fa-solid fa-book-open"></i> 从世界书选服装</button>
                                    <button class="cw-btn gn sm" id="cw-ce-add-w" type="button"><i class="fa-solid fa-plus"></i> 新增服装</button>
                                </div>
                            </div>
                            <div class="cw-tabs" style="overflow-x:auto">
                                ${draft.wardrobe.map((w, i) => {
                                    const isWorn = (draft.currentOutfitId ? w.id === draft.currentOutfitId : (w.outfit && w.outfit === draft.currentOutfit));
                                    return `<button class="cw-tab cw-w-tab ${activeWIdx === i ? 'on' : ''}" data-wi="${i}">👗 ${esc(w.name || '套件' + (i + 1))} ${w.locked ? '<span style="color:#f472b6;font-size:10px;margin-left:2px" title="已锁定">🔒</span>' : ''} ${isWorn ? '<span style="color:#4ade80;font-size:10px;margin-left:2px">●穿</span>' : ''}</button>`;
                                }).join('')}
                            </div>
                            <div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap">
                                <input id="cw-ce-wname" class="cw-in" type="text" placeholder="服装名称" value="${esc(cw?.name || '')}" style="width:160px;flex-shrink:0" />
                                ${isCurrentlyWorn ? '<button class="cw-btn gn sm" type="button" disabled style="opacity:0.9"><i class="fa-solid fa-check"></i> ✨ 正在穿着</button>' : '<button class="cw-btn cy sm" id="cw-ce-set-active" type="button"><i class="fa-solid fa-shirt"></i> 设为当前穿着</button>'}
                                <button class="cw-btn sm" id="cw-ce-toggle-w-lock" type="button" style="background:${cw?.locked ? 'rgba(244,114,182,0.18)' : 'rgba(255,255,255,0.06)'};border:1px solid ${cw?.locked ? 'rgba(244,114,182,0.5)' : 'rgba(255,255,255,0.15)'};color:${cw?.locked ? '#f472b6' : '#94a3b8'}" title="锁定此服装预设：生图后绝对不回填篡改此衣服">
                                    <i class="fa-solid ${cw?.locked ? 'fa-lock' : 'fa-lock-open'}"></i> ${cw?.locked ? '🔒 服装已锁定' : '🔓 锁定此衣服'}
                                </button>
                                <div style="display:flex;gap:3px;flex-wrap:wrap;flex:1;overflow-x:auto">${OUTFIT_PRESETS.slice(0, 7).map(o => `<button class="cw-chip cw-outfit-chip" data-tag="${esc(o.t)}" type="button">${esc(o.n)}</button>`).join('')}</div>
                                ${draft.wardrobe.length > 1 ? '<button class="cw-btn rd sm" id="cw-ce-del-w" type="button">✕ 删除此套</button>' : ''}
                            </div>
                            <textarea id="cw-ce-wtags" class="cw-ta" placeholder="sailor_suit, pleated_skirt, white_thighhighs">${esc(cw?.outfit || cw?.tags || '')}</textarea>
                        </div>
                    </div>
                    <div class="cw-modal-ft" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
                        <button class="cw-btn cy" id="cw-ce-test" type="button"><i class="fa-solid fa-wand-magic-sparkles"></i> 🎨 测试单人立绘</button>
                        <div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap">
                            ${dossierScope === 'chat' ? `<span class="cw-ce-chat-only-hint" style="font-size:11.5px;color:rgba(255,255,255,0.65);margin-right:4px">只改本对话；要改所有对话请去<button type="button" class="cw-ce-open-library" title="关闭编辑器（未保存的修改不会保存），切换到角色库" style="background:none;border:none;padding:0 2px;color:#7dd3fc;text-decoration:underline;cursor:pointer;font-size:inherit">角色库</button></span>` : ''}
                            <button class="cw-btn" id="cw-ce-cancel">取消</button>
                            <button class="cw-btn pri" id="cw-ce-save">💾 ${dossierScope === 'all' ? '保存 (同步角色库)' : '保存到 SDT 角色记忆'}</button>
                        </div>
                    </div>
                </div>`;

            const syncChips = () => {
                const base = (mask.querySelector('#cw-ce-base')?.value || '').toLowerCase();
                mask.querySelectorAll('.cw-base-chip').forEach(b => {
                    const tags = (b.dataset.tag || '').toLowerCase().split(',').map(s => s.trim());
                    b.classList.toggle('on', tags.length > 0 && tags.every(t => base.includes(t)));
                });
            };

            mask.querySelector('#cw-ce-x')?.addEventListener('click', () => mask.remove());
            mask.querySelector('#cw-ce-cancel')?.addEventListener('click', () => mask.remove());

            mask.querySelector('#cw-ce-name')?.addEventListener('input', e => { draft.displayName = e.target.value.trim(); });
            mask.querySelector('#cw-ce-aliases')?.addEventListener('input', e => { draft.aliasesText = e.target.value; });
            mask.querySelector('#cw-ce-name-tag')?.addEventListener('input', e => {
                draft.nameTag = e.target.value.trim();
                draft.nameTagSource = 'user';
            });
            mask.querySelector('#cw-ce-avatar-url')?.addEventListener('input', e => {
                draft.avatarUrl = e.target.value.trim();
                const ab = mask.querySelector('#cw-ce-avatar-box');
                if (ab) ab.innerHTML = draft.avatarUrl ? `<img src="${esc(draft.avatarUrl)}"/>` : '👤';
            });
            mask.querySelector('#cw-ce-base')?.addEventListener('input', e => { draft.baseTags = e.target.value; syncChips(); });

            mask.querySelectorAll('.cw-base-chip').forEach(b => b.addEventListener('click', () => {
                const el = mask.querySelector('#cw-ce-base');
                if (el) { el.value = toggleTag(el.value, b.dataset.tag); draft.baseTags = el.value; syncChips(); }
            }));

            // Wardrobe tabs
            mask.querySelectorAll('.cw-w-tab').forEach(b => b.addEventListener('click', () => {
                const wn = mask.querySelector('#cw-ce-wname');
                const wt = mask.querySelector('#cw-ce-wtags');
                if (draft.wardrobe[activeWIdx]) {
                    if (wn) draft.wardrobe[activeWIdx].name = wn.value;
                    if (wt) draft.wardrobe[activeWIdx].outfit = wt.value;
                }
                activeWIdx = +b.dataset.wi;
                render();
            }));
            mask.querySelector('#cw-ce-add-w')?.addEventListener('click', () => {
                draft.wardrobe.push({ id: uid('w'), name: '服装 ' + (draft.wardrobe.length + 1), outfit: '', triggers: [], createdAt: Date.now() });
                activeWIdx = draft.wardrobe.length - 1;
                render();
            });
            mask.querySelector('#cw-ce-del-w')?.addEventListener('click', () => {
                if (draft.wardrobe.length > 1) { draft.wardrobe.splice(activeWIdx, 1); activeWIdx = Math.max(0, activeWIdx - 1); render(); }
            });
            mask.querySelector('#cw-ce-wname')?.addEventListener('input', e => { if (draft.wardrobe[activeWIdx]) draft.wardrobe[activeWIdx].name = e.target.value; });
            mask.querySelector('#cw-ce-wtags')?.addEventListener('input', e => { if (draft.wardrobe[activeWIdx]) draft.wardrobe[activeWIdx].outfit = e.target.value; });

            // Set Active Outfit
            mask.querySelector('#cw-ce-set-active')?.addEventListener('click', () => {
                const wn = mask.querySelector('#cw-ce-wname');
                const wt = mask.querySelector('#cw-ce-wtags');
                if (draft.wardrobe[activeWIdx]) {
                    if (wn) draft.wardrobe[activeWIdx].name = wn.value;
                    if (wt) draft.wardrobe[activeWIdx].outfit = wt.value;
                }
                const curW = draft.wardrobe[activeWIdx];
                draft.currentOutfitId = curW.id;
                draft.currentOutfit = curW.outfit || curW.tags || '';
                draft.isOutfitLocked = !!curW.locked;
                draft.outfitLocked = draft.isOutfitLocked;
                render();
                toastr.success(`已将「${curW.name || '此套服装'}」设为当前穿着！`, PLUGIN_NAME);
            });

            // Toggle Base Lock
            mask.querySelector('#cw-ce-toggle-base-lock')?.addEventListener('click', () => {
                const el = mask.querySelector('#cw-ce-base');
                if (el) draft.baseTags = el.value;
                draft.baseLocked = !draft.baseLocked;
                draft.isBaseLocked = draft.baseLocked;
                render();
                toastr.info(draft.baseLocked ? '已锁定人设（生图后绝对不回填篡改人设）' : '已解锁人设', PLUGIN_NAME);
            });

            // Toggle Outfit Lock for active wardrobe preset
            mask.querySelector('#cw-ce-toggle-w-lock')?.addEventListener('click', () => {
                const wn = mask.querySelector('#cw-ce-wname');
                const wt = mask.querySelector('#cw-ce-wtags');
                if (draft.wardrobe[activeWIdx]) {
                    if (wn) draft.wardrobe[activeWIdx].name = wn.value;
                    if (wt) draft.wardrobe[activeWIdx].outfit = wt.value;
                    draft.wardrobe[activeWIdx].locked = !draft.wardrobe[activeWIdx].locked;
                    if (draft.wardrobe[activeWIdx].id === draft.currentOutfitId) {
                        draft.isOutfitLocked = draft.wardrobe[activeWIdx].locked;
                        draft.outfitLocked = draft.isOutfitLocked;
                    }
                    render();
                    toastr.info(draft.wardrobe[activeWIdx].locked ? `已锁定服装「${draft.wardrobe[activeWIdx].name}」（生图不改写其内容；换装/新服装照常收录）` : `已解锁服装「${draft.wardrobe[activeWIdx].name}」`, PLUGIN_NAME);
                }
            });

            mask.querySelectorAll('.cw-outfit-chip').forEach(b => b.addEventListener('click', () => {
                const el = mask.querySelector('#cw-ce-wtags');
                if (el && draft.wardrobe[activeWIdx]) { el.value = toggleTag(el.value, b.dataset.tag); draft.wardrobe[activeWIdx].outfit = el.value; }
            }));

            // Worldbook pick for base
            mask.querySelector('#cw-ce-wb-base')?.addEventListener('click', () => {
                openWorldbookPicker('挑选外貌特征词条', tags => {
                    const el = mask.querySelector('#cw-ce-base');
                    if (el) { el.value = [el.value, tags].filter(Boolean).join(', '); draft.baseTags = el.value; syncChips(); }
                }, 'appearance');
            });
            // Worldbook pick for outfit
            mask.querySelector('#cw-ce-wb-outfit')?.addEventListener('click', () => {
                openWorldbookPicker('挑选服装词条', tags => {
                    const el = mask.querySelector('#cw-ce-wtags');
                    if (el && draft.wardrobe[activeWIdx]) { el.value = tags; draft.wardrobe[activeWIdx].outfit = tags; }
                }, 'outfit');
            });

            // Import from SillyTavern character card (Full 7D extraction)
            mask.querySelector('#cw-ce-import-card')?.addEventListener('click', async (ev) => {
                const btn = ev.currentTarget;
                const origHtml = btn.innerHTML;
                try {
                    btn.disabled = true;
                    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在提取...';
                    
                    if (typeof RBQ?.api?.importCharacterFromCurrentCard === 'function') {
                        // Group chats: extract the member being edited (SDT asks which member when it can't tell).
                        const imported = await RBQ.api.importCharacterFromCurrentCard({ preferName: draft.displayName });
                        if (imported === false) return; // Failed extraction must not reset an unsaved draft.
                        const ctx = window.RBQ?.api?.getContext?.() || window.SillyTavern?.getContext?.();
                        const cid = ctx?.characterId;
                        const cd = ctx?.characters?.[cid];
                        const charName = imported?.displayName || cd?.name;
                        if (charName) {
                            const updated = imported || getProfile(charName);
                            if (updated) {
                                draft.displayName = updated.displayName || charName;
                                draft.nameTag = updated.nameTag || draft.nameTag;
                                if (updated.nameTag) draft.nameTagSource = updated.nameTagSource || 'user';
                                draft.baseTags = updated.baseTags || draft.baseTags;
                                draft.previousBaseTags = updated.previousBaseTags;
                                draft.currentOutfit = updated.currentOutfit || draft.currentOutfit;
                                draft.currentOutfitId = updated.currentOutfitId || draft.currentOutfitId;
                                draft.avatarUrl = updated.avatarUrl || draft.avatarUrl;
                                draft.wardrobe = JSON.parse(JSON.stringify(updated.wardrobe || draft.wardrobe));
                            }
                        }
                    } else {
                        const ctx = window.RBQ?.api?.getContext?.() || window.SillyTavern?.getContext?.();
                        const cid = ctx?.characterId;
                        const cd = ctx?.characters?.[cid];
                        if (!cd) return toastr.warning('未检测到当前角色卡', PLUGIN_NAME);
                        draft.displayName = cd.name || draft.displayName;
                        draft.avatarUrl = cd.avatar ? '/characters/' + cd.avatar : draft.avatarUrl;
                        toastr.success('已导入「' + draft.displayName + '」基础信息', PLUGIN_NAME);
                    }
                    render();
                } catch (e) {
                    toastr.error('导入失败: ' + e.message, PLUGIN_NAME);
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = origHtml;
                }
            });

            // Test solo portrait with Perspective Selector Modal & Multi-Tab Gallery
            mask.querySelector('#cw-ce-test')?.addEventListener('click', (ev) => {
                const btn = ev.currentTarget;
                const name = draft.displayName || 'Character';
                const outfit = draft.wardrobe[activeWIdx]?.outfit || draft.wardrobe[activeWIdx]?.tags || '';
                if (!draft.baseTags && !outfit) {
                    return toastr.warning('请先输入角色的固有外貌或服装 Tags', PLUGIN_NAME);
                }

                openPortraitTestModal(name, draft.baseTags, outfit, (newAvatarUrl) => {
                    draft.avatarUrl = newAvatarUrl;
                    const urlEl = mask.querySelector('#cw-ce-avatar-url');
                    if (urlEl) urlEl.value = newAvatarUrl;
                    const ab = mask.querySelector('#cw-ce-avatar-box');
                    if (ab) ab.innerHTML = `<img src="${esc(newAvatarUrl)}"/>`;
                }, btn);
            });

            // 当前会话 editor: 「只改本对话；要改所有对话请去角色库」 link closes the editor and opens 角色库.
            mask.querySelector('.cw-ce-open-library')?.addEventListener('click', () => {
                mask.remove();
                if (typeof onOpenLibrary === 'function') onOpenLibrary();
            });

            // Save — write directly to SDT profiles
            mask.querySelector('#cw-ce-save')?.addEventListener('click', () => {
                const wn = mask.querySelector('#cw-ce-wname');
                const wt = mask.querySelector('#cw-ce-wtags');
                if (draft.wardrobe[activeWIdx]) {
                    if (wn) draft.wardrobe[activeWIdx].name = wn.value;
                    if (wt) draft.wardrobe[activeWIdx].outfit = wt.value;
                }

                const name = draft.displayName;
                if (!name) return toastr.warning('请输入角色姓名', PLUGIN_NAME);

                // 当前会话 saves only touch this chat; only the 角色库 editor syncs copies and the ⭐全局角色.
                const targetScope = dossierScope;

                // Renaming a 全局角色 in 角色库 keeps it global under the new name.
                const keepGlobalOnRename = isEdit && editName !== name && targetScope === 'all' && isGlobalCharacter(editName);
                // [产品决定 B] ask before the rename/delete below so the count reflects the copies being edited.
                const syncImported = targetScope === 'all' && !keepGlobalOnRename && (!isEdit || editName === name) && askSyncImportedGlobalCopies(name);
                if (isEdit && editName !== name) deleteProfile(editName, targetScope);

                const activeW = draft.wardrobe.find(w => w.id === draft.currentOutfitId) || draft.wardrobe[0];
                draft.currentOutfit = activeW?.outfit || activeW?.tags || '';
                draft.currentOutfitId = activeW?.id || '';
                if (activeW) {
                    draft.isOutfitLocked = !!activeW.locked;
                    draft.outfitLocked = draft.isOutfitLocked;
                }

                // Manual name_tag is authoritative ('user'); empty clears it so AI decides from the story.
                const nameTagValue = String(draft.nameTag || '').trim();
                // "a, b，c" → trimmed, case-insensitively deduped alias list.
                const aliasSeen = new Set();
                const aliasesValue = String(draft.aliasesText || '').split(/[,，]/).map(v => v.trim())
                    .filter(v => v && !aliasSeen.has(v.toLowerCase()) && aliasSeen.add(v.toLowerCase()));
                saveProfile(name, {
                    displayName: name,
                    nameTag: nameTagValue,
                    aliases: aliasesValue,
                    nameTagSource: nameTagValue ? (draft.nameTagSource || (origProfile?.nameTag === nameTagValue ? '' : 'user')) : '',
                    baseTags: draft.baseTags,
                    baseLocked: draft.baseLocked,
                    isBaseLocked: draft.baseLocked,
                    outfitLocked: draft.isOutfitLocked,
                    isOutfitLocked: draft.isOutfitLocked,
                    previousBaseTags: draft.previousBaseTags,
                    currentOutfit: draft.currentOutfit,
                    currentOutfitId: draft.currentOutfitId,
                    avatarUrl: draft.avatarUrl,
                    wardrobe: draft.wardrobe,
                    // Keep the archive identity so global sync only touches same-createdAt copies.
                    ...(origProfile?.createdAt ? { createdAt: origProfile.createdAt } : {}),
                }, targetScope, { makeGlobal: keepGlobalOnRename, syncImported });
                if (targetScope === 'all' && isGlobalCharacter(name)) warnGlobalAliasConflicts(name);
                toastr.success(targetScope === 'all'
                    ? ('「' + name + '」已保存，并已同步至角色库中同一档案的各会话副本！')
                    : targetScope === 'chat'
                        ? ('「' + name + '」已保存到当前对话（其他对话和⭐全局角色不受影响）')
                        : ('「' + name + '」已保存到 SDT 角色记忆！'), PLUGIN_NAME);
                mask.remove();
                if (onSaved) onSaved(name);
            });

            syncChips();
        }
        render();
        document.body.appendChild(mask);
        registerSubmodal(mask);
    }

    function openMountLorebookModal(onMountedOrImported) {
        const sources = (typeof RBQ?.api?.getLorebookSources === 'function') 
            ? RBQ.api.getLorebookSources() 
            : (getSdtStore().lorebookSources || []);

        if (!Array.isArray(sources) || sources.length === 0) {
            return toastr.warning('当前尚未在「智能触发」中导入任何世界书文件', PLUGIN_NAME);
        }

        const ws = getWs();
        let selectedSourceId = ws.mountedLorebookId || (getMountedLorebookSource()?.id) || sources[0].id;
        let searchQuery = '';
        const selectedNames = new Set();

        const mask = document.createElement('div');
        mask.className = 'cw-modal-mask';
        mask.id = 'cw-mount-lorebook-modal';
        mask.style.cssText = 'position:fixed !important;inset:0 !important;z-index:2147483550 !important;background:rgba(10,15,29,.92) !important;backdrop-filter:blur(10px) !important;-webkit-backdrop-filter:blur(10px) !important;display:flex !important;align-items:center !important;justify-content:center !important;overflow-y:auto !important;padding:max(16px, env(safe-area-inset-top, 16px)) 12px max(16px, env(safe-area-inset-bottom, 16px)) !important;box-sizing:border-box !important;-webkit-overflow-scrolling:touch !important;';

        const closeModal = () => {
            mask.remove();
            if (!document.querySelector('.cw-modal-mask')) {
                document.body.classList.remove('cw-submodal-open');
            }
        };

        const renderModal = () => {
            const currentSrc = sources.find(s => s.id === selectedSourceId) || sources[0];
            const profilesDict = extractDoujinProfilesFromLorebook(currentSrc);
            const allNames = Object.keys(profilesDict);

            const isCurrentlyMounted = (ws.mountedLorebookId === currentSrc.id);

            mask.innerHTML = `
                <div class="cw-modal" style="width:780px;max-width:95vw;height:84vh;display:flex;flex-direction:column" onclick="event.stopPropagation()">
                    <div class="cw-modal-hd">
                        <strong style="color:#c084fc;font-size:14px;display:flex;align-items:center;gap:7px">
                            <i class="fa-solid fa-book-bookmark"></i> 挂载/导入世界书同人库到角色档案库
                        </strong>
                        <button class="cw-btn sm" id="cw-ml-x" type="button">✕</button>
                    </div>

                    <div style="padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.08);background:rgba(0,0,0,0.2);display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                        <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:260px">
                            <span style="font-size:11px;color:rgba(255,255,255,0.7);white-space:nowrap">选择世界书源:</span>
                            <select id="cw-ml-source-sel" class="cw-sel" style="flex:1;font-size:12px">
                                ${sources.map(s => `<option value="${s.id}" ${s.id === currentSrc.id ? 'selected' : ''}>${s.id === ws.mountedLorebookId ? '⭐ [已挂载] ' : '📖 '}${esc(s.name)} (${s.entryCount || 0}条)</option>`).join('')}
                            </select>
                        </div>
                        <div style="display:flex;gap:6px">
                            <button class="cw-btn ${isCurrentlyMounted ? 'gn' : 'cy'} sm" id="cw-ml-toggle-mount" type="button">
                                ${isCurrentlyMounted ? '<i class="fa-solid fa-check"></i> 已设为当前挂载同人库' : '<i class="fa-solid fa-link"></i> 设为当前挂载同人库'}
                            </button>
                        </div>
                    </div>

                    <!-- Search & Selection controls -->
                    <div style="padding:8px 14px;display:flex;gap:8px;align-items:center;border-bottom:1px solid rgba(255,255,255,0.06);background:rgba(0,0,0,0.15)">
                        <input id="cw-ml-search" class="cw-in" type="text" placeholder="🔍 搜索同人角色姓名、外貌特征或触发词 (共 ${allNames.length} 位角色)..." value="${esc(searchQuery)}" style="flex:1" />
                        <button class="cw-btn sm" id="cw-ml-sel-all" type="button">全选当前</button>
                        <button class="cw-btn sm" id="cw-ml-sel-none" type="button">取消全选</button>
                    </div>

                    <!-- Character List -->
                    <div style="flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px" id="cw-ml-list"></div>

                    <!-- Footer with Batch Import -->
                    <div class="cw-modal-ft" style="justify-content:space-between">
                        <span style="font-size:11px;color:rgba(255,255,255,0.6)" id="cw-ml-count-text">
                            已选: <strong style="color:#c084fc">${selectedNames.size}</strong> / ${allNames.length} 位角色
                        </span>
                        <div style="display:flex;gap:8px">
                            <button class="cw-btn" id="cw-ml-close" type="button">关闭</button>
                            <button class="cw-btn pri" id="cw-ml-import-batch" type="button" ${selectedNames.size === 0 ? 'disabled style="opacity:0.5"' : ''}>
                                <i class="fa-solid fa-bolt"></i> 批量导入所选到角色档案库 (${selectedNames.size} 位)
                            </button>
                        </div>
                    </div>
                </div>
            `;

            const bindListEvents = () => {
                mask.querySelectorAll('.cw-ml-chk').forEach(chk => {
                    chk.addEventListener('change', (e) => {
                        const name = e.target.dataset.name;
                        if (e.target.checked) selectedNames.add(name);
                        else selectedNames.delete(name);
                        updateFooterCounts();
                    });
                });

                mask.querySelectorAll('.cw-ml-import-single').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const name = btn.dataset.name;
                        const p = profilesDict[name];
                        if (!p) return;
                        saveProfile(name, p);
                        toastr.success(`已将「${name}」导入为常驻角色档案！`, PLUGIN_NAME);
                        if (onMountedOrImported) onMountedOrImported();
                    });
                });
            };

            const updateFooterCounts = (filteredTotal = null) => {
                const countText = mask.querySelector('#cw-ml-count-text');
                const total = (filteredTotal != null) ? filteredTotal : allNames.length;
                if (countText) {
                    countText.innerHTML = `已选: <strong style="color:#c084fc">${selectedNames.size}</strong> / ${total} 位角色`;
                }
                const btn = mask.querySelector('#cw-ml-import-batch');
                if (btn) {
                    btn.disabled = (selectedNames.size === 0);
                    btn.style.opacity = (selectedNames.size === 0) ? '0.5' : '1';
                    btn.innerHTML = `<i class="fa-solid fa-bolt"></i> 批量导入所选到角色档案库 (${selectedNames.size} 位)`;
                }
            };

            const updateList = () => {
                const filteredNames = allNames.filter(n => {
                    if (!searchQuery) return true;
                    const p = profilesDict[n];
                    const q = searchQuery.toLowerCase();
                    return n.toLowerCase().includes(q) || 
                           (p.displayName && p.displayName.toLowerCase().includes(q)) || 
                           (p.baseTags && p.baseTags.toLowerCase().includes(q)) ||
                           (p.keys && p.keys.some(k => k.toLowerCase().includes(q)));
                });

                const listEl = mask.querySelector('#cw-ml-list');
                if (listEl) {
                    listEl.innerHTML = filteredNames.length === 0 ? `
                        <div style="text-align:center;padding:40px;color:rgba(255,255,255,0.5)">
                            <div><i class="fa-solid fa-filter" style="font-size:24px;opacity:0.4;margin-bottom:8px"></i></div>
                            <div>未在该世界书中找到匹配的角色条目</div>
                        </div>
                    ` : filteredNames.map(n => {
                        const p = profilesDict[n];
                        const isChecked = selectedNames.has(n);
                        return `
                            <div style="display:flex;gap:10px;align-items:center;background:rgba(255,255,255,0.03);border:1px solid ${isChecked ? 'rgba(192,132,252,0.6)' : 'rgba(255,255,255,0.07)'};border-radius:8px;padding:8px 12px;transition:0.15s">
                                <input type="checkbox" class="cw-ml-chk" data-name="${esc(n)}" ${isChecked ? 'checked' : ''} style="transform:scale(1.1);cursor:pointer" />
                                <div style="flex:1;overflow:hidden;display:flex;flex-direction:column;gap:2px">
                                    <div style="display:flex;align-items:center;gap:6px">
                                        <strong style="color:#f8fafc;font-size:13px">${esc(p.displayName || n)}</strong>
                                        ${p.keys?.length > 0 ? `<span style="font-size:10.5px;color:rgba(255,255,255,0.45)">[${esc(p.keys.slice(0, 3).join(', '))}]</span>` : ''}
                                    </div>
                                    <div style="font-size:11px;color:rgba(255,255,255,0.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(p.baseTags)}">
                                        <span style="color:#79e4ff">外貌Tags:</span> ${esc(p.baseTags || '无')}
                                    </div>
                                </div>
                                <button type="button" class="cw-btn xs cw-ml-import-single" data-name="${esc(n)}" style="background:rgba(56,189,248,0.15);border:1px solid rgba(56,189,248,0.3);color:#38bdf8">
                                    <i class="fa-solid fa-file-import"></i> 导入常驻档案
                                </button>
                            </div>
                        `;
                    }).join('');

                    bindListEvents();
                }

                updateFooterCounts(filteredNames.length);

                mask.querySelector('#cw-ml-sel-all')?.addEventListener('click', () => {
                    filteredNames.forEach(n => selectedNames.add(n));
                    updateList();
                });
            };

            mask.querySelector('#cw-ml-x')?.addEventListener('click', closeModal);
            mask.querySelector('#cw-ml-close')?.addEventListener('click', closeModal);

            mask.querySelector('#cw-ml-source-sel')?.addEventListener('change', (e) => {
                selectedSourceId = e.target.value;
                selectedNames.clear();
                renderModal();
            });

            mask.querySelector('#cw-ml-toggle-mount')?.addEventListener('click', () => {
                ws.mountedLorebookId = currentSrc.id;
                _cachedDoujinProfiles = null;
                wsSave();
                toastr.success(`已将「${currentSrc.name}」设为当前挂载同人库！可在档案库中直接浏览或选角。`, PLUGIN_NAME);
                if (onMountedOrImported) onMountedOrImported();
                renderModal();
            });

            mask.querySelector('#cw-ml-search')?.addEventListener('input', (e) => {
                searchQuery = e.target.value;
                updateList();
            });

            mask.querySelector('#cw-ml-sel-none')?.addEventListener('click', () => {
                selectedNames.clear();
                updateList();
            });

            mask.querySelector('#cw-ml-import-batch')?.addEventListener('click', () => {
                if (selectedNames.size === 0) return;
                let count = 0;
                for (const name of selectedNames) {
                    const p = profilesDict[name];
                    if (p) {
                        const toImport = { ...p };
                        delete toImport.source;
                        saveProfile(name, toImport);
                        count++;
                    }
                }
                toastr.success(`成功导入 ${count} 位角色到角色档案库！`, PLUGIN_NAME);
                if (onMountedOrImported) onMountedOrImported();
                closeModal();
            });

            updateList();
        };

        mask.addEventListener('click', (e) => {
            if (e.target === mask) closeModal();
        });

        renderModal();
        document.body.appendChild(mask);
        registerSubmodal(mask);
    }

    // ══════════════════════════════════════════════════════════
    //  Tab 1: 角色档案库 (Dossier)
    // ══════════════════════════════════════════════════════════
    function renderDossierTab() {
        const chatProfiles = getCurrentChatProfiles();
        const globalProfiles = getAllGlobalProfiles();
        const doujinProfiles = getMountedDoujinProfiles();
        const doujinSrc = getMountedLorebookSource();
        const chatCount = Object.keys(chatProfiles).length;
        const allCount = Object.keys(globalProfiles).length;
        const doujinCount = Object.keys(doujinProfiles).filter(k => k !== '__mtime').length;

        const globalNames = getGlobalCharacterNames();
        const globalCount = globalNames.length;
        if (dossierScope !== 'all') dossierGlobalOnly = false;

        const profiles = getAllProfiles();
        if (dossierScope === 'all') {
            // ⭐ 全局角色：显示全局角色本体（即使角色库里已没有任何会话副本）。
            for (const g of globalNames) profiles[g] = getGlobalCharacterProfile(g);
        }
        let names = Object.keys(profiles);
        if (dossierScope === 'all') {
            if (dossierGlobalOnly) names = names.filter(isGlobalCharacter);
            names.sort((a, b) => Number(isGlobalCharacter(b)) - Number(isGlobalCharacter(a)));
        }

        return `<div class="cw-body">
            <div class="cw-card">
                <div class="cw-card-hd" style="flex-wrap:wrap;gap:8px">
                    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                        <span class="cw-card-tt" style="color:#38bdf8"><i class="fa-solid fa-users"></i> SDT 角色档案库 (${names.length} 位)</span>
                        <div class="cw-scope-box" style="display:inline-flex;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:2px;gap:2px">
                            <button type="button" class="cw-btn xs cw-scope-btn ${dossierScope === 'chat' ? 'cy' : ''}" data-scope="chat" style="padding:2px 8px;font-size:11px"><i class="fa-solid fa-comments"></i> 当前会话 (${chatCount})</button>
                            <button type="button" class="cw-btn xs cw-scope-btn ${dossierScope === 'all' ? 'cy' : ''}" data-scope="all" style="padding:2px 8px;font-size:11px" title="角色库：所有会话的角色档案存档，不会自动发给 LLM；可在此把角色设为⭐全局角色"><i class="fa-solid fa-box-archive"></i> 角色库 (${allCount})${globalCount ? ` · ⭐${globalCount}` : ''}</button>
                            <button type="button" class="cw-btn xs cw-scope-btn ${dossierScope === 'lorebook' ? 'cy' : ''}" data-scope="lorebook" style="padding:2px 8px;font-size:11px" title="${doujinSrc ? '已挂载同人库: ' + esc(doujinSrc.name) : '点击查看或挂载同人库'}"><i class="fa-solid fa-book-bookmark"></i> 📖 同人库 (${doujinCount})</button>
                        </div>
                    </div>
                    <div class="cw-archive-tools" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                        ${!isDossierBatchMode ? `
                            ${dossierScope === 'all' ? `<button type="button" class="cw-btn sm ${dossierGlobalOnly ? 'cy' : ''}" id="cw-global-only-btn" title="⭐全局角色在任何会话都会发给 LLM；剧情中登场时自动导入当前会话并锁定"><i class="fa-solid fa-star"></i> ${dossierGlobalOnly ? '显示全部角色' : `只看全局角色 (${globalCount})`}</button>` : ''}
                            <button type="button" class="cw-btn cy sm" id="cw-mount-lorebook-btn" title="挂载或批量导入世界书同人库到角色档案库"><i class="fa-solid fa-book-bookmark"></i> 挂载/导入同人库</button>
                            <button type="button" class="cw-btn sm" id="cw-batch-mode-btn" title="开启批量选择模式：支持批量删除、批量导出与批量导入当前"><i class="fa-solid fa-list-check"></i> 批量管理</button>
                            <button type="button" class="cw-btn sm" id="cw-export-dossier-btn" title="导出当前视图角色档案库为 JSON 备份；在角色库视图导出时包含⭐全局角色（含没有会话副本的）"><i class="fa-solid fa-file-export"></i> 导出备份</button>
                            <button type="button" class="cw-btn sm" id="cw-import-dossier-btn" title="从 JSON 文件导入角色档案到当前会话；角色库备份里的⭐全局角色会一并恢复（覆盖同名全局角色前会先确认）"><i class="fa-solid fa-file-import"></i> 导入文件</button>
                            <input type="file" id="cw-import-dossier-file" accept=".json,application/json,text/plain" style="display:none" />
                            <button type="button" class="cw-btn gn sm" id="cw-create-char"><i class="fa-solid fa-plus"></i> 新建角色档案</button>
                        ` : `
                            <div class="cw-batch-toolbar" style="display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap;background:rgba(56,189,248,0.12);padding:3px 8px;border-radius:6px;border:1px solid rgba(56,189,248,0.35)">
                                <button type="button" class="cw-btn xs" id="cw-batch-toggle-all" style="padding:3px 8px;font-size:11px"><i class="fa-solid fa-check-double"></i> ${selectedDossierNames.size === names.length && names.length > 0 ? '全不选' : '全选'}</button>
                                <span style="font-size:11px;color:#f8fafc">已选 <strong style="color:#38bdf8">${selectedDossierNames.size}</strong>/${names.length}</span>
                                ${(dossierScope === 'all') ? `
                                    <button type="button" class="cw-btn gn xs" id="cw-batch-import-curr" ${selectedDossierNames.size === 0 ? 'disabled' : ''} style="padding:3px 8px;font-size:11px" title="将选中的角色批量克隆并导入到当前会话"><i class="fa-solid fa-file-import"></i> 批量导入当前 (${selectedDossierNames.size})</button>
                                ` : ''}
                                <button type="button" class="cw-btn xs" id="cw-batch-export-btn" ${selectedDossierNames.size === 0 ? 'disabled' : ''} style="padding:3px 8px;font-size:11px" title="将选中的角色打包导出为 JSON 文件"><i class="fa-solid fa-file-export"></i> 批量导出 (${selectedDossierNames.size})</button>
                                <button type="button" class="cw-btn rd xs" id="cw-batch-delete-btn" ${selectedDossierNames.size === 0 ? 'disabled' : ''} style="padding:3px 8px;font-size:11px" title="${dossierScope === 'all' ? '从角色库中彻底删除选中的角色' : '从当前会话中移除选中的角色'}"><i class="fa-solid fa-trash"></i> 批量删除 (${selectedDossierNames.size})</button>
                                <button type="button" class="cw-btn xs" id="cw-batch-exit-btn" style="padding:3px 8px;font-size:11px"><i class="fa-solid fa-xmark"></i> 退出批量</button>
                            </div>
                        `}
                    </div>
                </div>
                <div class="cw-chgrid">
                    ${names.length === 0 ? `
                        <div style="text-align:center;padding:36px 20px;grid-column:1/-1;opacity:.7;display:flex;flex-direction:column;align-items:center;gap:10px">
                            <div><i class="fa-solid fa-user-slash" style="font-size:28px;opacity:0.4"></i></div>
                            <div>${dossierScope === 'lorebook' ? '尚未检测到任何已导入的世界书同人库。请先在「智能触发」中导入同人库文件，或点击右上角「挂载/导入同人库」！' : (dossierScope === 'chat' ? `当前会话暂无角色档案记忆。${(allCount > 0 || globalCount > 0) ? `<div class="cw-empty-chat-library-hint" style="margin-top:6px">之前的角色都还在角色库里${allCount > 0 ? `（${allCount} 位）` : ''}，可直接查看与导入。</div>` : ''}${globalCount > 0 ? ` 已设 ${globalCount} 位⭐全局角色，剧情中登场时会自动导入当前会话。` : ''}` : (dossierGlobalOnly ? '还没有⭐全局角色。在角色库的角色卡上点「设为全局角色」即可。' : '暂无任何角色档案，点击右上角「新建角色档案」开始！'))}</div>
                            ${(dossierScope === 'chat' && (allCount > 0 || globalCount > 0)) ? `<button type="button" class="cw-btn cy sm cw-scope-btn cw-open-library-btn" data-scope="all"><i class="fa-solid fa-box-archive"></i> 打开角色库</button>` : ''}
                        </div>` : names.map(n => {
                        const p = profiles[n];
                        if (!p || typeof p !== 'object') return '';
                        const isFromLorebook = (dossierScope === 'lorebook');
                        const wCount = Array.isArray(p.wardrobe) ? p.wardrobe.length : 0;
                        const activeW = Array.isArray(p.wardrobe) ? (p.wardrobe.find(w => w.id === p.currentOutfitId) || p.wardrobe[0]) : null;
                        const activeOutfitName = activeW?.name || '默认';
                        const isSelected = selectedDossierNames.has(n);
                        const cardBorder = isSelected ? 'border:1px solid rgba(56,189,248,0.7) !important;background:rgba(56,189,248,0.08) !important;box-shadow:0 0 10px rgba(56,189,248,0.2) !important;' : '';

                        return `<div class="cw-chcard ${isDossierBatchMode ? 'cw-batch-card' : ''}" data-name="${esc(n)}" style="${cardBorder};cursor:${isDossierBatchMode ? 'pointer' : 'default'}">
                            <div style="display:flex;gap:10px;align-items:flex-start;min-width:0">
                                ${isDossierBatchMode ? `
                                    <input type="checkbox" class="cw-batch-item-check" data-name="${esc(n)}" ${isSelected ? 'checked' : ''} style="width:17px;height:17px;margin-top:3px;accent-color:#38bdf8;cursor:pointer;flex-shrink:0" />
                                ` : ''}
                                <div class="cw-avatar">${p.avatarUrl ? '<img src="' + esc(p.avatarUrl) + '"/>' : (isFromLorebook ? '📖' : '👤')}</div>
                                <div style="flex:1;min-width:0;overflow:hidden;display:flex;flex-direction:column;gap:2px">
                                    <div style="display:flex;align-items:center;gap:6px">
                                        <span style="font-size:13px;font-weight:700;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.displayName || n)}</span>
                                        ${(p.baseLocked || p.isBaseLocked) ? `<span style="font-size:9.5px;padding:1px 5px;border-radius:4px;background:rgba(163,230,53,0.18);border:1px solid rgba(163,230,53,0.5);color:#bef264" title="人设已锁定防篡改">🔒人设</span>` : ''}
                                        ${(p.outfitLocked || p.isOutfitLocked || activeW?.locked) ? `<span style="font-size:9.5px;padding:1px 5px;border-radius:4px;background:rgba(244,114,182,0.18);border:1px solid rgba(244,114,182,0.5);color:#f472b6" title="服装已锁定防篡改">🔒服装</span>` : ''}
                                        ${(dossierScope === 'all') ? (isGlobalCharacter(n) ? `<span class="cw-lib-status cw-lib-status-global" style="font-size:9.5px;padding:1px 5px;border-radius:4px;background:rgba(250,204,21,0.15);border:1px solid rgba(250,204,21,0.45);color:#fde047;white-space:nowrap" title="⭐全局角色：任何会话都会发给 LLM；剧情中登场时自动导入当前会话并锁定">⭐ 全局使用中</span>` : `<span class="cw-lib-status cw-lib-status-archive" style="font-size:9.5px;padding:1px 5px;border-radius:4px;background:rgba(148,163,184,0.15);border:1px solid rgba(148,163,184,0.4);color:#cbd5e1;white-space:nowrap" title="仅存档：保存在角色库里，不会发给 LLM；点「设为全局角色」后所有会话都会用她">仅存档</span>`) : ''}
                                        ${(dossierScope === 'chat' && p.importedFromGlobal) ? `<span style="font-size:9.5px;padding:1px 5px;border-radius:4px;background:rgba(250,204,21,0.15);border:1px solid rgba(250,204,21,0.45);color:#fde047" title="从⭐全局角色导入（导入时人设与服装默认锁定）；解析只会新增服装，不会改动全局角色。锁定只是不让自动改写，在角色工坊里可以直接编辑；会话里的改动不会同步回全局">⭐ 来自全局</span>` : ''}
                                        ${(p.source === 'lorebook' || p.sourceName || isFromLorebook) ? `<span style="font-size:9.5px;padding:1px 5px;border-radius:4px;background:rgba(192,132,252,0.25);border:1px solid rgba(192,132,252,0.5);color:#e9d5ff">同人库</span>` : ''}
                                    </div>
                                    ${(dossierScope === 'chat' && p.importedFromGlobal) ? `<span class="cw-global-lock-hint" style="font-size:10px;color:rgba(253,224,71,.75);line-height:1.3">🔒 锁定只是不让自动改写，在角色工坊里可以直接编辑；会话里的改动不会同步回全局</span>` : ''}
                                    <span style="font-size:11px;color:rgba(255,255,255,.55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.baseTags)}"><span style="color:#79e4ff">外貌:</span> ${esc(p.baseTags || '未设置')}</span>
                                    <span style="font-size:10.5px;color:#ffb86c;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">👗 当前: <strong>${esc(activeOutfitName)}</strong> <span style="opacity:0.6">(${wCount}套)</span></span>
                                </div>
                            </div>
                            <div class="cw-chcard-actions">
                                <button class="cw-btn sm cw-test-dossier-char" data-name="${esc(n)}" title="测试该角色立绘"><i class="fa-solid fa-wand-magic-sparkles"></i> 测试</button>
                                <button class="cw-btn cy sm cw-go-action" data-name="${esc(n)}" title="为该角色搭配世界书动作生图"><i class="fa-solid fa-person-running"></i> 配动作生图</button>
                                ${isFromLorebook ? `
                                    <button class="cw-btn gn sm cw-import-from-lorebook" data-name="${esc(n)}" title="导入为当前常驻角色档案"><i class="fa-solid fa-file-import"></i> 导入常驻</button>
                                    <button class="cw-btn sm cw-export-single-char" data-name="${esc(n)}" title="导出该角色为独立 JSON 文件"><i class="fa-solid fa-file-export"></i></button>
                                ` : `
                                    ${(dossierScope === 'all') ? `
                                        <button class="cw-btn sm ${isGlobalCharacter(n) ? 'cy' : ''} cw-toggle-global-char" data-name="${esc(n)}" data-global="${isGlobalCharacter(n) ? '1' : '0'}" title="${isGlobalCharacter(n) ? '取消后不再自动发给 LLM，已导入各会话的副本保留' : '设为全局角色：任何会话都会发给 LLM；剧情中登场时自动导入当前会话，人设与服装默认锁定'}"><i class="fa-solid fa-star"></i> ${isGlobalCharacter(n) ? '取消全局角色' : '设为全局角色'}</button>
                                    ` : ''}
                                    ${(dossierScope === 'all') ? (chatProfiles[n] ? `
                                        <button class="cw-btn cy sm cw-overwrite-from-global" data-name="${esc(n)}" title="${isGlobalCharacter(n) ? '用⭐全局角色本体覆盖当前会话中的同名档案（人设与服装锁定）' : '用角色库中的优选档案（锁定优先，其次最早建档）覆盖当前会话中的同名档案'}"><i class="fa-solid fa-rotate"></i> 用全局版本覆盖当前</button>
                                    ` : `
                                        <button class="cw-btn gn sm cw-import-from-global" data-name="${esc(n)}" title="${isGlobalCharacter(n) ? '将⭐全局角色导入到当前会话（人设与服装锁定）' : '将此角色库角色导入到当前会话'}"><i class="fa-solid fa-file-import"></i> 导入当前</button>
                                    `) : ''}
                                    <button class="cw-btn sm cw-edit-char" data-name="${esc(n)}" title="${dossierScope === 'all' ? (isGlobalCharacter(n) ? '编辑⭐全局角色本体，并同步角色库中同一档案的各会话副本' : '编辑角色库档案并同步所有会话副本') : '编辑角色档案'}"><i class="fa-solid fa-pen-to-square"></i> ${dossierScope === 'all' ? '编辑(角色库)' : '编辑'}</button>
                                    <button class="cw-btn sm cw-export-single-char" data-name="${esc(n)}" title="导出该角色为独立 JSON 文件"><i class="fa-solid fa-file-export"></i></button>
                                    <button class="cw-btn rd sm cw-del-char" data-name="${esc(n)}" title="删除档案"><i class="fa-solid fa-trash"></i></button>
                                `}
                            </div>
                        </div>`;
                    }).join('')}
                </div>
            </div>
        </div>`;
    }

    // ══════════════════════════════════════════════════════════
    //  Tab 2: 动作工坊 · 动作分镜 × 角色智能适配
    // ══════════════════════════════════════════════════════════
    function renderComposerTab() {
        const ws = getWs();
        const comp = ws.activeComposer;
        const slots = comp.slots || [];
        if (slots.length === 0) {
            slots.push({ charName: '', outfitId: '', customOutfit: '', action: '', uc: '', center: 'B3' });
        }
        const ai = Math.min(slots.length - 1, Math.max(0, comp.activeSlotIndex || 0));
        const activePt = cwParseCoord(slots[ai]?.center || (ai === 0 ? 'B3' : (ai === 1 ? 'D3' : 'C3')));

        const chatProfiles = getCurrentChatProfiles();
        const globalProfiles = getAllGlobalProfiles();
        const doujinProfiles = getMountedDoujinProfiles();
        const chatNames = Object.keys(chatProfiles);
        const globalOnlyNames = Object.keys(globalProfiles).filter(n => !chatProfiles[n]);
        const doujinOnlyNames = Object.keys(doujinProfiles).filter(n => n !== '__mtime' && !chatProfiles[n] && !globalProfiles[n]);

        const useCoords = comp.useCoords === true;
        const finalPrompt = composeFinalPrompt(comp);

        const wbActions = Array.isArray(comp.selectedWbActions) ? comp.selectedWbActions : [];
        const isSolo = slots.length <= 1;
        const s = typeof RBQ?.api?.getSettings === 'function' ? RBQ.api.getSettings() : {};
        const isNai = s.currentMode === 'nai';

        return `<div class="cw-body">
            <!-- 1. 挑选动作与分镜 (直通世界书) — 动作驱动优先！ -->
            <div class="cw-card">
                <div class="cw-card-hd" style="flex-wrap:wrap;gap:8px">
                    <div style="display:flex;align-items:center;gap:8px">
                        <span class="cw-card-tt" style="color:#f472b6"><i class="fa-solid fa-book-bookmark"></i> ① 挑选动作与分镜 (直通世界书)</span>
                        <span style="font-size:11px;opacity:0.65">已选 ${wbActions.length} 项</span>
                    </div>
                    <div style="display:flex;gap:6px;flex-wrap:wrap">
                        <button class="cw-btn cy sm" id="cw-pick-action-wb" type="button" style="padding:4px 12px;font-size:12px;font-weight:bold">
                            <i class="fa-solid fa-book-open"></i> 📖 从世界书挑选动作/分镜模板
                        </button>
                        <button class="cw-btn sm" id="cw-pick-scene-wb" type="button">
                            <i class="fa-solid fa-mountain-sun"></i> 挑选场景/环境
                        </button>
                        ${wbActions.length > 0 ? `<button class="cw-btn rd sm" id="cw-clear-wb-actions" type="button"><i class="fa-solid fa-trash-can"></i> 清空动作</button>` : ''}
                        <button class="cw-btn sm" id="cw-reset-all" type="button" title="重置全场：清空动作、解绑角色并重置场景" style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#cbd5e1">
                            <i class="fa-solid fa-rotate-left"></i> 重置全场
                        </button>
                    </div>
                </div>

                <!-- 选入词条多态胶囊容器 -->
                <div style="min-height:50px;background:rgba(0,0,0,.25);border:1px dashed rgba(255,255,255,.14);border-radius:8px;padding:8px 10px;display:flex;flex-wrap:wrap;gap:7px;align-items:center">
                    ${wbActions.length === 0 ? `
                        <div style="font-size:11.5px;color:rgba(255,255,255,0.45);display:flex;align-items:center;gap:6px">
                            <i class="fa-solid fa-arrow-pointer"></i> 点击上方「从世界书挑选动作/分镜模板」，选入动作、表情、体位或完整多角色分镜模板！系统将自动拆解分工并适配角色。
                        </div>
                    ` : wbActions.map((act, idx) => `
                        <div class="cw-wb-chip ${esc(act.type || 'action')}" data-id="${esc(act.id)}">
                            <span class="cw-wb-badge ${esc(act.type || 'action')}">
                                ${act.type === 'template' ? '📜 模板' : (act.type === 'interaction' ? '👥 互动' : (act.type === 'scene' ? '🏞️ 场景' : '💃 动作'))}
                            </span>
                            <strong>${esc(act.name)}</strong>
                            <span class="cw-wb-tags" title="${esc(cleanLorebookTags(act.tags))}">${esc(cleanLorebookTags(act.tags))}</span>
                            <button type="button" class="cw-wb-toggle-type" data-idx="${idx}" title="切换分类: 💃单人动作 ⇄ 👥双人互动 ⇄ 🏞️场景 ⇄ 📜模板">⇄</button>
                            <button type="button" class="cw-wb-del" data-idx="${idx}" title="移除">✕</button>
                        </div>
                    `).join('')}
                </div>

                <!-- 动作临时细节补充 -->
                <div style="display:flex;flex-direction:column;gap:4px;margin-top:2px">
                    <label style="font-size:11px;color:rgba(255,255,255,.65);display:flex;align-items:center;gap:5px">
                        <i class="fa-solid fa-pen"></i> 临时动作/细节补充 (可选):
                    </label>
                    <input id="cw-custom-action-tags" class="cw-in" type="text" placeholder="如有额外的临时英文 Tags (如: looking_at_viewer, blushing, wet_clothes...) 可直接在此补充..." value="${esc(comp.customActionInput || '')}" style="font-size:11.5px" />
                </div>
            </div>

            <!-- 2. 安排参演角色与穿搭 -->
            <div class="cw-card">
                <div class="cw-card-hd" style="flex-wrap:wrap;gap:8px">
                    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                        <span class="cw-card-tt" style="color:#38bdf8"><i class="fa-solid fa-users"></i> ② 安排参演角色 (${slots.length} 人槽位)</span>
                        <span class="cw-badge" style="background:${isSolo ? 'rgba(56,189,248,0.2)' : 'rgba(244,114,182,0.2)'};color:${isSolo ? '#38bdf8' : '#f472b6'}">
                            ${isSolo ? '💃 单人演练模式' : '👥 双人同框互动模式'}
                        </span>
                    </div>
                    <div style="display:flex;gap:6px">
                        ${slots.length === 1 ? `<button class="cw-btn pk sm" id="cw-add-duo-slot" type="button"><i class="fa-solid fa-user-plus"></i> ＋ 添加双人同框角色</button>` : ''}
                        ${slots.length > 1 ? `<button class="cw-btn cy sm" id="cw-swap-slots" type="button" title="互换主角与配角先后顺序"><i class="fa-solid fa-arrow-right-arrow-left"></i> 互换主次</button>` : ''}
                        ${slots.length > 1 ? `<button class="cw-btn rd sm" id="cw-reset-to-solo" type="button"><i class="fa-solid fa-user-minus"></i> 切回单人模式</button>` : ''}
                    </div>
                </div>

                <!-- 角色卡片列表 (Slots) -->
                <div class="cw-slots-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px;width:100%;box-sizing:border-box">
                    ${slots.map((slot, i) => {
                        const cl = COLORS[i % COLORS.length];
                        const prof = slot.charName ? (getProfile(slot.charName) || globalProfiles[slot.charName]) : null;
                        const wardrobe = prof?.wardrobe || [];
                        const activeW = wardrobe.find(w => w.id === slot.outfitId) || wardrobe[0];

                        return `<div class="cw-slot" style="border-color:${cl.bdr};background:rgba(15,23,42,.6);position:relative">
                            <div class="cw-slot-top">
                                <div style="display:flex;align-items:center;gap:8px">
                                    <div class="cw-avatar" style="width:34px;height:34px;font-size:16px">
                                        ${prof?.avatarUrl ? `<img src="${esc(prof.avatarUrl)}" />` : '👤'}
                                    </div>
                                    <div>
                                        <div style="display:flex;align-items:center;gap:6px">
                                            <span class="cw-badge" style="background:${cl.bg};color:${cl.hex}">Char ${i + 1}</span>
                                            <strong style="font-size:13px;color:#f8fafc">${esc(prof?.displayName || slot.charName || (i === 0 ? '主角 (未绑定)' : '配角 (未绑定)'))}</strong>
                                        </div>
                                        <div style="font-size:10.5px;color:rgba(255,255,255,.55);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                                            ${esc(prof?.baseTags || '暂无固有特征')}
                                        </div>
                                    </div>
                                </div>
                                ${slots.length > 1 ? `<button class="cw-btn rd sm cw-rm-slot" data-idx="${i}" type="button" title="移除此槽位">✕</button>` : ''}
                            </div>
                            <div class="cw-slot-grid" style="margin-top:4px">
                                <div>
                                    <label style="font-size:10.5px;font-weight:bold;color:#cbd5e1;display:block;margin-bottom:2px">绑定角色档案:</label>
                                    <select class="cw-sel cw-slot-char" data-idx="${i}">
                                        <option value="">👤 [点击选择角色...]</option>
                                        ${chatNames.length > 0 ? `
                                            <optgroup label="💬 当前会话角色 (${chatNames.length} 位)">
                                                ${chatNames.map(n => `<option value="${esc(n)}" ${slot.charName === n ? 'selected' : ''}>👤 ${esc(chatProfiles[n]?.displayName || n)}</option>`).join('')}
                                            </optgroup>
                                        ` : ''}
                                        ${globalOnlyNames.length > 0 ? `
                                            <optgroup label="📦 角色库档案 (${globalOnlyNames.length} 位)">
                                                ${globalOnlyNames.map(n => `<option value="${esc(n)}" ${slot.charName === n ? 'selected' : ''}>👤 ${esc(globalProfiles[n]?.displayName || n)}</option>`).join('')}
                                            </optgroup>
                                        ` : ''}
                                        ${doujinOnlyNames.length > 0 ? `
                                            <optgroup label="📖 世界书同人库 (${doujinOnlyNames.length} 位)">
                                                ${doujinOnlyNames.map(n => `<option value="${esc(n)}" ${slot.charName === n ? 'selected' : ''}>📖 ${esc(doujinProfiles[n]?.displayName || n)}</option>`).join('')}
                                            </optgroup>
                                        ` : ''}
                                    </select>
                                </div>
                                <div>
                                    <label style="font-size:10.5px;font-weight:bold;color:#cbd5e1;display:block;margin-bottom:2px">服装套件 (Wardrobe):</label>
                                    <select class="cw-sel cw-slot-outfit" data-idx="${i}">
                                        <option value="" ${!slot.outfitId && !slot.customOutfit ? 'selected' : ''}>👗 默认服装 (${esc(activeW?.name || '默认')})</option>
                                        ${wardrobe.map(w => `<option value="${esc(w.id)}" ${slot.outfitId === w.id ? 'selected' : ''}>👗 ${esc(w.name)}</option>`).join('')}
                                        <option value="__custom" ${slot.customOutfit ? 'selected' : ''}>✍️ 自定义服装</option>
                                    </select>
                                </div>
                            </div>
                            <div class="cw-slot-components" style="display:flex;align-items:center;gap:12px;margin-top:8px;padding-top:6px;border-top:1px dashed rgba(255,255,255,0.08);flex-wrap:wrap">
                                <span style="font-size:10.5px;color:rgba(255,255,255,0.5);display:flex;align-items:center;gap:4px">
                                    <i class="fa-solid fa-layer-group"></i> 特征装配:
                                </span>
                                <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:${slot.includeHead !== false ? '#38bdf8' : 'rgba(255,255,255,0.4)'};cursor:pointer;user-select:none" title="是否包含头部发型发饰与面容五官（无头尸体可关闭，断头在旁可开启）">
                                    <input type="checkbox" class="cw-slot-toggle-head" data-idx="${i}" ${slot.includeHead !== false ? 'checked' : ''} style="cursor:pointer;margin:0" />
                                    <span>头部面容</span>
                                </label>
                                <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:${slot.includeBody !== false ? '#38bdf8' : 'rgba(255,255,255,0.4)'};cursor:pointer;user-select:none" title="是否包含身材体态与身体标记（胸围、身材、肤色等）">
                                    <input type="checkbox" class="cw-slot-toggle-body" data-idx="${i}" ${slot.includeBody !== false ? 'checked' : ''} style="cursor:pointer;margin:0" />
                                    <span>体态特征</span>
                                </label>
                                <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:${slot.includeOutfit !== false ? '#38bdf8' : 'rgba(255,255,255,0.4)'};cursor:pointer;user-select:none" title="是否包含衣柜服装套件（沐浴/裸体/动作自带全套衣服可关闭）">
                                    <input type="checkbox" class="cw-slot-toggle-outfit" data-idx="${i}" ${slot.includeOutfit !== false ? 'checked' : ''} style="cursor:pointer;margin:0" />
                                    <span>当前服装</span>
                                </label>
                            </div>
                        </div>`;
                    }).join('')}
                </div>
            </div>

            <!-- 3. 空间布局与场景设定 (连续与网格定位) -->
            <div class="cw-card">
                <div class="cw-card-hd" style="flex-wrap:wrap;gap:8px">
                    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                        <span class="cw-card-tt" style="color:#fbbf24"><i class="fa-solid fa-chess-board"></i> ③ 空间布局与场景设定</span>
                        <label style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;cursor:pointer;background:rgba(255,255,255,0.06);padding:3px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);user-select:none" title="关闭后由 AI 自主决定角色构图站位，网格收起；开启后按坐标定位">
                            <input type="checkbox" id="cw-toggle-coords" ${useCoords ? 'checked' : ''} style="margin:0;cursor:pointer" />
                            <span style="color:${useCoords ? '#38bdf8' : 'rgba(255,255,255,0.7)'};font-weight:${useCoords ? 'bold' : 'normal'}">
                                <i class="fa-solid fa-crosshairs"></i> V5 空间坐标定位 (连续/5×5)
                            </span>
                        </label>
                    </div>
                    <div style="font-size:11px;opacity:.65">
                        ${useCoords ? `当前状态: 🎯 空间坐标定位已开启 (支持触控/拖拽无级调节)` : `当前状态: 🤖 由 AI 自行决定自然构图 (面板已折叠收起)`}
                    </div>
                </div>

                <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
                    ${useCoords ? `
                    <!-- 2D Continuous & 5x5 Stage Grid -->
                    <div style="display:flex;flex-direction:column;gap:8px;flex-shrink:0">
                        <div class="cw-grid5" id="cw-stage" style="position:relative;width:250px;height:250px;touch-action:none;user-select:none;cursor:crosshair;overflow:hidden;box-sizing:border-box">
                            ${ROWS.map(r => COLS.map(c => {
                                const coord = c + r;
                                return `<div class="cw-cell" data-coord="${coord}" title="${coord} (${COORD_LABELS[coord]})">
                                    <span>${coord}</span>
                                </div>`;
                            }).join('')).join('')}

                            <!-- Safe-zone guide (inset 10%) -->
                            <div style="position:absolute;left:10%;top:10%;width:80%;height:80%;border:1px dashed rgba(56,189,248,0.3);border-radius:4px;pointer-events:none;z-index:1"></div>

                            <!-- Continuous Draggable Pins for all slots -->
                            ${slots.map((s, i) => {
                                const pt = cwParseCoord(s.center || (i === 0 ? 'B3' : (i === 1 ? 'D3' : 'C3')));
                                const isActive = (ai === i);
                                const col = COLORS[i % COLORS.length];
                                const charTitle = esc(s.charName || `Char ${i + 1}`);
                                return `<div class="cw-pin" data-si="${i}" style="
                                    position: absolute;
                                    left: ${pt.x * 100}%;
                                    top: ${pt.y * 100}%;
                                    transform: translate(-50%, -50%) ${isActive ? 'scale(1.25)' : 'scale(1)'};
                                    background: ${col.hex};
                                    border: 2px solid ${isActive ? '#ffffff' : 'rgba(0,0,0,0.6)'};
                                    box-shadow: ${isActive ? '0 0 12px ' + col.hex + ', 0 2px 6px rgba(0,0,0,0.8)' : '0 2px 5px rgba(0,0,0,0.6)'};
                                    z-index: ${isActive ? 10 : 3};
                                    cursor: grab;
                                    touch-action: none;
                                " title="${charTitle} (${formatCenterDisplay(s.center || pt)})">
                                    ${i + 1}
                                </div>`;
                            }).join('')}
                        </div>

                        <!-- Active Slot Coordinates Controls -->
                        <div style="background:rgba(15,23,42,0.6);border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:6px 8px;display:flex;flex-direction:column;gap:5px;width:250px;box-sizing:border-box">
                            <div style="display:flex;align-items:center;justify-content:space-between">
                                <span style="font-size:11px;font-weight:bold;color:${COLORS[ai % COLORS.length].hex}">
                                    <i class="fa-solid fa-location-dot"></i> Char ${ai + 1} (${esc(slots[ai]?.charName || '未命名')})
                                </span>
                                <button class="cw-btn sm" id="cw-toggle-snap" type="button" style="padding:2px 6px;font-size:10px;background:${comp.snapGrid ? 'rgba(56,189,248,0.25)' : 'rgba(255,255,255,0.06)'};color:${comp.snapGrid ? '#38bdf8' : '#cbd5e1'};border:1px solid ${comp.snapGrid ? 'rgba(56,189,248,0.5)' : 'rgba(255,255,255,0.15)'}">
                                    <i class="fa-solid fa-magnet"></i> 网格吸附: ${comp.snapGrid ? '开' : '关'}
                                </button>
                            </div>
                            <div style="display:flex;align-items:center;gap:6px">
                                <label style="font-size:10.5px;color:#cbd5e1;display:flex;align-items:center;gap:3px;flex:1">
                                    X: <input type="number" step="0.01" min="0" max="1" id="cw-coord-x" class="cw-in" style="padding:2px 5px;font-size:11px;width:100%" value="${activePt.x.toFixed(2)}" />
                                </label>
                                <label style="font-size:10.5px;color:#cbd5e1;display:flex;align-items:center;gap:3px;flex:1">
                                    Y: <input type="number" step="0.01" min="0" max="1" id="cw-coord-y" class="cw-in" style="padding:2px 5px;font-size:11px;width:100%" value="${activePt.y.toFixed(2)}" />
                                </label>
                            </div>
                        </div>

                        <!-- Slot switcher buttons -->
                        <div style="display:flex;gap:4px;flex-wrap:wrap;max-width:250px">
                            ${slots.map((s, i) => {
                                const pt = cwParseCoord(s.center || (i === 0 ? 'B3' : (i === 1 ? 'D3' : 'C3')));
                                return `<button class="cw-btn sm cw-switch-slot ${(comp.activeSlotIndex || 0) === i ? 'cy' : ''}" data-idx="${i}" type="button" style="font-size:10.5px;padding:2px 6px">
                                    Char ${i + 1} (${pt.x.toFixed(2)},${pt.y.toFixed(2)})
                                </button>`;
                            }).join('')}
                        </div>
                    </div>` : ''}

                    <!-- 场景与镜头输入 -->
                    <div style="flex:1;min-width:240px;display:flex;flex-direction:column;gap:10px">
                        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));gap:9px">
                            <div>
                                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px">
                                    <label style="font-size:11px;font-weight:bold;color:#cbd5e1"><i class="fa-solid fa-mountain-sun" style="color:#f1fa8c"></i> 场景环境 (Scene):</label>
                                    <button class="cw-btn sm" id="cw-pick-scene" type="button" style="padding:1px 6px;font-size:10px;background:rgba(241,250,140,.15);border:1px solid rgba(241,250,140,.35);color:#f1fa8c"><i class="fa-solid fa-book"></i> 查世界书场景</button>
                                </div>
                                <input id="cw-scene" class="cw-in" type="text" placeholder="indoors, living room, dark background..." value="${esc(comp.scene || '')}" />
                                <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">
                                    ${[
                                        { label: '室内', tag: 'indoors' },
                                        { label: '卧室', tag: 'bedroom' },
                                        { label: '暗黑背景', tag: 'dark background' },
                                        { label: '简单背景', tag: 'simple background' },
                                        { label: '室外', tag: 'outdoors' },
                                        { label: '夜景', tag: 'night' }
                                    ].map(item => {
                                        const isOn = (comp.scene || '').toLowerCase().includes(item.tag.toLowerCase());
                                        return `<button class="cw-chip ${isOn ? 'on' : ''} cw-quick-scene" data-tag="${item.tag}" type="button">${item.label}</button>`;
                                    }).join('')}
                                </div>
                            </div>
                            <div>
                                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px">
                                    <label style="font-size:11px;font-weight:bold;color:#cbd5e1"><i class="fa-solid fa-camera" style="color:#bd93f9"></i> 视角与光影 (Camera):</label>
                                    <button class="cw-btn sm" id="cw-pick-camera" type="button" style="padding:1px 6px;font-size:10px;background:rgba(189,147,249,.15);border:1px solid rgba(189,147,249,.35);color:#bd93f9"><i class="fa-solid fa-book"></i> 查世界书视角</button>
                                </div>
                                <input id="cw-camera" class="cw-in" type="text" placeholder="from_above, close-up, depth_of_field..." value="${esc(comp.camera || '')}" />
                                <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">
                                    ${[
                                        { label: '立绘', tag: 'standing, full body' },
                                        { label: '肖像', tag: 'portrait' },
                                        { label: '特写', tag: 'close-up' },
                                        { label: '面部特写', tag: 'face focus, close-up' },
                                        { label: '半身', tag: 'upper body' },
                                        { label: '七分身', tag: 'cowboy shot' },
                                        { label: '全身', tag: 'full body' },
                                        { label: '俯视', tag: 'from above' },
                                        { label: '仰视', tag: 'from below' },
                                        { label: '看镜头', tag: 'looking at viewer' },
                                        { label: '男主视角', tag: 'male pov' },
                                        { label: '侧面', tag: 'from side' },
                                        { label: '背面', tag: 'from behind' },
                                        { label: '景深', tag: 'depth of field' },
                                        { label: '电影光', tag: 'cinematic lighting' }
                                    ].map(item => {
                                        const incoming = item.tag.split(/[,，;；]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
                                        const curTags = (comp.camera || '').toLowerCase().split(/[,，;；]+/).map(s => s.trim()).filter(Boolean);
                                        const isOn = incoming.length > 0 && incoming.every(it => curTags.includes(it));
                                        return `<button class="cw-chip ${isOn ? 'on' : ''} cw-quick-camera" data-tag="${item.tag}" type="button">${item.label}</button>`;
                                    }).join('')}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 4. 智能适配提示词实时预览与演练出图 -->
            <div class="cw-preview">
                <div class="cw-card-hd">
                    <div style="display:flex;align-items:center;gap:8px">
                        <span class="cw-card-tt" style="color:#4ade80"><i class="fa-solid fa-wand-magic-sparkles"></i> 智能适配提示词实时预览</span>
                        <span style="font-size:10.5px;opacity:0.65">${isNai ? 'NovelAI V4 多角色模板' : '通用模型融合模板'}</span>
                    </div>
                    <div style="display:flex;gap:5px">
                        <button class="cw-btn sm" id="cw-copy-prompt" type="button"><i class="fa-regular fa-copy"></i> 复制提示词</button>
                        <button class="cw-btn am sm" id="cw-save-preset" type="button"><i class="fa-solid fa-floppy-disk"></i> 保存为预设</button>
                    </div>
                </div>
                <div class="cw-code" id="cw-prompt-preview">${esc(finalPrompt)}</div>
                <div class="cw-composer-actions" style="display:flex;justify-content:flex-end;margin-top:4px">
                    <button class="cw-btn pri" id="cw-generate" type="button" style="padding:8px 24px;font-size:13.5px;font-weight:bold">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> 🚀 立即演练生图
                    </button>
                </div>
            </div>
        </div>`;
    }

    // ══════════════════════════════════════════════════════════
    //  Tab 3: 分镜模板与预设 (Presets)
    // ══════════════════════════════════════════════════════════
    function renderPresetsTab() {
        const ws = getWs();
        const userPresets = ws.presets;

        return `<div class="cw-body">
            <div class="cw-card">
                <div class="cw-card-hd">
                    <span class="cw-card-tt" style="color:#38bdf8"><i class="fa-solid fa-sparkles"></i> 经典分镜模板库 (一键载入空间舞台)</span>
                </div>
                <div class="cw-chgrid">
                    ${TEMPLATES.map((t, i) => `<div class="cw-chcard" style="border-color:rgba(56,189,248,.2)">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start">
                            <strong style="font-size:12.5px;color:#38bdf8">${esc(t.name)}</strong>
                            <span class="cw-badge" style="background:rgba(56,189,248,.15);color:#38bdf8">${t.slots.length} 人</span>
                        </div>
                        <div style="font-size:11px;opacity:.7;line-height:1.4">${esc(t.desc)}</div>
                        <div class="cw-chcard-actions" style="margin-top:auto">
                            <button class="cw-btn gn sm cw-load-tpl" data-idx="${i}"><i class="fa-solid fa-download"></i> 载入舞台</button>
                        </div>
                    </div>`).join('')}
                </div>
            </div>

            <div class="cw-card">
                <div class="cw-card-hd">
                    <span class="cw-card-tt" style="color:#fbbf24"><i class="fa-solid fa-bookmark"></i> 我的自定义预设 (${userPresets.length})</span>
                </div>
                <div class="cw-chgrid">
                    ${userPresets.length === 0 ? '<div style="text-align:center;padding:30px;grid-column:1/-1;opacity:.6">暂无自定义预设。在多角色舞台排布好后，点击「保存为预设」即可存入此处！</div>' : userPresets.map((p, i) => `<div class="cw-chcard">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start">
                            <strong style="font-size:12.5px;color:#f8fafc">${esc(p.name)}</strong>
                            <span class="cw-badge" style="background:rgba(251,191,36,.15);color:#fbbf24">${p.slots?.length || 0} 人</span>
                        </div>
                        <div style="font-size:11px;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.scene || '无场景描述')}</div>
                        <div class="cw-chcard-actions" style="margin-top:auto">
                            <button class="cw-btn gn sm cw-load-preset" data-idx="${i}"><i class="fa-solid fa-download"></i> 载入</button>
                            <button class="cw-btn rd sm cw-del-preset" data-idx="${i}"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </div>`).join('')}
                </div>
            </div>
        </div>`;
    }

    // ══════════════════════════════════════════════════════════
    //  Main Shell & Event Binding
    // ══════════════════════════════════════════════════════════
    // ══════════════════════════════════════════════════════════
    //  Worldbook Template & Classification Bridge
    // ══════════════════════════════════════════════════════════
    function parseWorldbookTemplate(rawContent, entryName) {
        if (!rawContent) return null;
        let s = String(rawContent).trim();

        // Detect structured segments: Char1: / Char2: / Scene:
        const hasChar1 = /\bchar\s*1\s*[:：]/i.test(s);
        const hasChar2 = /\bchar\s*2\s*[:：]/i.test(s);
        const hasScene = /\bscene\s*[:：]/i.test(s);

        if (!hasChar1 && !hasChar2 && !hasScene) {
            return null;
        }

        // Clean out outer comment brackets or titles if present
        s = s.replace(/^[#\*\s]*[【\[][^】\]]+[】\]][:：]?\s*/gm, '');

        let scenePart = '';
        let char1Part = '';
        let char2Part = '';

        // Flatten newlines into semicolons for inline matching
        const flat = s.replace(/\r?\n/g, '; ');

        // Scene match: explicit Scene: or implicit content before first Char1/Char2
        const sMatch = flat.match(/\bscene\s*[:：]\s*([^;]+(?:;(?!\s*(?:char\d|scene)\s*[:：])[^;]+)*)/i);
        if (sMatch) {
            scenePart = cleanLorebookTags(sMatch[1]);
        } else {
            const firstCharIdx = s.search(/\bchar\s*[12]\s*[:：]/i);
            if (firstCharIdx > 0) {
                scenePart = cleanLorebookTags(s.slice(0, firstCharIdx));
            }
        }

        // Char 1 match
        const c1Match = flat.match(/\bchar\s*1\s*[:：]\s*([^;]+(?:;(?!\s*(?:char\d|scene)\s*[:：])[^;]+)*)/i);
        if (c1Match) char1Part = cleanLorebookTags(c1Match[1]);

        // Char 2 match
        const c2Match = flat.match(/\bchar\s*2\s*[:：]\s*([^;]+(?:;(?!\s*(?:char\d|scene)\s*[:：])[^;]+)*)/i);
        if (c2Match) char2Part = cleanLorebookTags(c2Match[1]);

        const previewParts = [];
        if (scenePart) previewParts.push(`Scene: ${scenePart}`);
        if (char1Part) previewParts.push(`Char1: ${char1Part}`);
        if (char2Part) previewParts.push(`Char2: ${char2Part}`);

        return {
            isTemplate: true,
            type: 'template',
            name: entryName || '世界书分镜模板',
            scene: scenePart,
            char1Action: char1Part,
            char2Action: char2Part,
            tags: previewParts.join(' | ') || s
        };
    }

    function classifyWorldbookItem(entry, tags, rawContent) {
        const raw = String(rawContent || entry?.content || tags || '');
        if (/\bchar\s*1\s*[:：]/i.test(raw) || /\bchar\s*2\s*[:：]/i.test(raw)) {
            return 'template';
        }

        const title = (entry?.comment || entry?.name || entry?.key || '').toLowerCase();
        const tagStr = String(tags || '').toLowerCase();
        const combined = (title + ' ' + tagStr + ' ' + raw).toLowerCase();

        // 1. Interaction / Multi-person / Sex Poses (HIGHEST PRIORITY for duo/poses)
        const interactionRegex = /(1girl\s*,\s*1boy|1boy\s*,\s*1girl|2girls|2boys|multiple\s*(?:girls|boys)|group\s*sex|threesome|gangbang|princess_carry|hug|kiss|carrying|holding_hands|lap_pillow|kabedon|back_to_back|straddle|straddling|cowgirl|missionary|doggy|sitting\s*on\s*lap|sex\s*from\s*behind|penetration|cunnilingus|fellatio|blowjob|paizuri|spooning|creampie|faceless\s*male|clothed\s*female\s*nude\s*male|tribadism|frottage|groping|breast_grab|ass_grab|pegging|double_penetration|fingering|handjob|footjob|glory_hole|sumata|titfuck|deepthroat|irrumatio|bukkake|gokkun|prostate|femdom|spanking|bondage|shibari|rope_bondage|体位|骑乘|公主抱|拥抱|接吻|做爱|性爱|后入|传教士|正常位|双人|互动|对视|牵手|壁咚|膝枕|并肩|口交|乳交|群交|轮奸|中出|调教|双飞|胸推|颜射|深吻|舌吻|潮吹|拘束|捆绑|合体|二人|亲密|依偎|摸头|捏脸)/i;

        if (interactionRegex.test(combined)) {
            return 'interaction';
        }

        // 2. Check SDT classification metadata if available
        const mainId = entry?.classification?.mainId;
        if (mainId === 'interaction') {
            return 'interaction';
        }
        if (mainId === 'nsfw') {
            return 'action';
        }
        if (mainId === 'scene') {
            return 'scene';
        }

        // 3. Scene / Environment
        const sceneRegex = /(indoors|outdoors|scenery|landscape|room|bedroom|living_room|bathroom|kitchen|classroom|beach|ocean|sea|forest|mountain|sky|clouds|night|sunset|sunrise|rain|snow|street|cityscape|ruins|dungeon|castle|bed|couch|sofa|table|chair|pool|onsen|hot_spring|library|park|balcony|rooftop|lighting|sunlight|moonlight|depth_of_field|cinematic|scenic|interior|exterior|场景|环境|背景|室内|室外|房间|卧室|客厅|浴室|教室|海滩|街道|城市|星空|夜景|黄昏|夕阳|雨天|雪天|森林|废墟|城堡|泳池|温泉|天台|阳台|图书馆|光影|氛围)/i;
        if (sceneRegex.test(combined)) {
            return 'scene';
        }

        // 4. Default to Action
        return 'action';
    }

    // ══════════════════════════════════════════════════════════
    //  Main Shell & Event Binding
    // ══════════════════════════════════════════════════════════
    let activeTab = 'dossier';

    function renderMain(tab) {
        activeTab = tab || activeTab;
        const profiles = getAllProfiles();
        const pCount = Object.keys(profiles).length;
        const presetCount = getWs().presets.length;

        return `<div class="cw-wrap">
            <div class="cw-hdr">
                <div class="cw-logo"><i class="fa-solid fa-palette"></i> 角色工坊 2.0</div>
                <div class="cw-tabs">
                    <button class="cw-tab cw-main-tab ${activeTab === 'dossier' ? 'on' : ''}" data-tab="dossier"><i class="fa-solid fa-users"></i> <span class="cw-tab-full">角色档案库 (${pCount})</span><span class="cw-tab-short">档案库 (${pCount})</span></button>
                    <button class="cw-tab cw-main-tab ${activeTab === 'composer' ? 'on' : ''}" data-tab="composer"><i class="fa-solid fa-person-running"></i> <span class="cw-tab-full">动作工坊 · 动作分镜×角色适配</span><span class="cw-tab-short">动作工坊</span></button>
                    <button class="cw-tab cw-main-tab ${activeTab === 'presets' ? 'on' : ''}" data-tab="presets"><i class="fa-solid fa-bookmark"></i> <span class="cw-tab-full">分镜模板与预设 (${presetCount})</span><span class="cw-tab-short">预设 (${presetCount})</span></button>
                </div>
            </div>
            ${renderMemoryOffBanner()}
            <div id="cw-tab-content" style="flex:1;overflow:hidden;display:flex;flex-direction:column">
                ${activeTab === 'dossier' ? renderDossierTab() : ''}
                ${activeTab === 'composer' ? renderComposerTab() : ''}
                ${activeTab === 'presets' ? renderPresetsTab() : ''}
            </div>
        </div>`;
    }

    function bindEvents(container, refresh) {
        const ws = getWs();
        const comp = ws.activeComposer;

        // Tab navigation
        container.querySelectorAll('.cw-main-tab').forEach(b => b.addEventListener('click', () => refresh(b.dataset.tab)));

        container.querySelector('#cw-enable-memory-btn')?.addEventListener('click', () => {
            if (enableSdtCharacterMemory()) toastr.success('已打开「角色外貌记忆」并保存：之后生图会用角色工坊里的档案', PLUGIN_NAME);
            refresh(activeTab);
        });

        // ── Action Studio / Composer Events ──
        const updatePromptPreview = () => {
            const el = container.querySelector('#cw-prompt-preview');
            if (el) el.textContent = composeFinalPrompt(comp);
        };

        // Reset all composer data to initial clean slate
        container.querySelector('#cw-reset-all')?.addEventListener('click', () => {
            if (!confirm('确定要清空并重置全场的动作、角色绑定与场景设定吗？')) return;
            comp.selectedWbActions = [];
            comp.customActionInput = '';
            comp.scene = '';
            comp.camera = '';
            comp.atmosphere = '';
            delete comp.interaction;
            comp.slots = [
                { charName: '', outfitId: '', customOutfit: '', action: '', uc: '', center: 'B3' }
            ];
            wsSave();
            refresh('composer');
            toastr.info('已重置全场设定', PLUGIN_NAME);
        });

        // Add duo slot
        container.querySelector('#cw-add-duo-slot')?.addEventListener('click', () => {
            if (comp.slots.length < 2) {
                comp.slots.push({ charName: '', outfitId: '', customOutfit: '', action: '', uc: '', center: 'D3' });
                wsSave();
                refresh('composer');
                toastr.success('已开启双人同框互动槽位！请为 Char 2 选定角色', PLUGIN_NAME);
            }
        });

        // Swap slot 1 & slot 2
        container.querySelector('#cw-swap-slots')?.addEventListener('click', () => {
            if (comp.slots.length >= 2) {
                const temp = comp.slots[0];
                comp.slots[0] = comp.slots[1];
                comp.slots[1] = temp;
                wsSave();
                refresh('composer');
                toastr.info('已互换主角与配角位置！', PLUGIN_NAME);
            }
        });

        // Reset to solo
        container.querySelector('#cw-reset-to-solo')?.addEventListener('click', () => {
            comp.slots = comp.slots.slice(0, 1);
            wsSave();
            refresh('composer');
            toastr.info('已切换回单人演练模式', PLUGIN_NAME);
        });

        // Remove single slot
        container.querySelectorAll('.cw-rm-slot').forEach(b => b.addEventListener('click', () => {
            const idx = +b.dataset.idx;
            if (comp.slots.length > 1) {
                comp.slots.splice(idx, 1);
                wsSave();
                refresh('composer');
            }
        }));

        // Slot char select
        container.querySelectorAll('.cw-slot-char').forEach(sel => sel.addEventListener('change', () => {
            const idx = +sel.dataset.idx;
            if (comp.slots[idx]) {
                comp.slots[idx].charName = sel.value;
                comp.slots[idx].outfitId = '';
                autoMatchOutfitsForActiveComposer();
                wsSave();
                refresh('composer');
            }
        }));

        // Slot outfit select
        container.querySelectorAll('.cw-slot-outfit').forEach(sel => sel.addEventListener('change', () => {
            const idx = +sel.dataset.idx;
            if (comp.slots[idx]) {
                if (sel.value === '__custom') {
                    const custom = prompt('请输入该角色的自定义服装 Prompt:');
                    comp.slots[idx].customOutfit = custom || '';
                    comp.slots[idx].outfitId = '';
                } else {
                    comp.slots[idx].outfitId = sel.value;
                    comp.slots[idx].customOutfit = '';
                }
                wsSave();
                refresh('composer');
            }
        }));

        // 槽位装配特征开关 (头部/面容, 身体/体态, 服装/配饰)
        container.querySelectorAll('.cw-slot-toggle-head').forEach(cb => cb.addEventListener('change', () => {
            const idx = +cb.dataset.idx;
            if (comp.slots[idx]) {
                comp.slots[idx].includeHead = cb.checked;
                wsSave();
                refresh('composer');
            }
        }));
        container.querySelectorAll('.cw-slot-toggle-body').forEach(cb => cb.addEventListener('change', () => {
            const idx = +cb.dataset.idx;
            if (comp.slots[idx]) {
                comp.slots[idx].includeBody = cb.checked;
                wsSave();
                refresh('composer');
            }
        }));
        container.querySelectorAll('.cw-slot-toggle-outfit').forEach(cb => cb.addEventListener('change', () => {
            const idx = +cb.dataset.idx;
            if (comp.slots[idx]) {
                comp.slots[idx].includeOutfit = cb.checked;
                wsSave();
                refresh('composer');
            }
        }));

        // Pick Worldbook Action or Structured Template
        container.querySelector('#cw-pick-action-wb')?.addEventListener('click', () => {
            openWorldbookPicker('从世界书挑选动作/分镜模板', (tags, entry) => {
                const rawContent = typeof entry === 'string' ? entry : (entry?.content || entry?.tags || tags);
                const entryName = (entry?.comment || entry?.name || entry?.key || '世界书条目').replace(/^[#\-\*\s]*[^\n:：]+[:：]\s*/gm, '').trim();

                if (!Array.isArray(comp.selectedWbActions)) comp.selectedWbActions = [];

                // 1. Check if it's a structured template (Scene: or Char1:/Char2:)
                const tpl = parseWorldbookTemplate(rawContent, entryName);
                if (tpl && tpl.isTemplate) {
                    comp.selectedWbActions.push({
                        id: uid('act'),
                        name: entryName,
                        tags: tpl.tags,
                        type: 'template',
                        scene: tpl.scene,
                        char1Action: tpl.char1Action,
                        char2Action: tpl.char2Action
                    });

                    // Auto-add slot 2 if template has Char2 action and we are currently in solo mode!
                    if (tpl.char2Action && comp.slots.length < 2) {
                        comp.slots.push({ charName: '', outfitId: '', customOutfit: '', action: '', uc: '', center: 'D3' });
                        toastr.success(`已载入双人分镜模板「${entryName}」，已自动为你开启双人同框槽位！`, PLUGIN_NAME);
                    } else {
                        toastr.success(`已载入分镜模板「${entryName}」！`, PLUGIN_NAME);
                    }

                    autoMatchOutfitsForActiveComposer();
                    wsSave();
                    refresh('composer');
                    return;
                }

                // 2. Comprehensive classification (template / interaction / scene / action)
                const actType = classifyWorldbookItem(entry, tags, rawContent);
                comp.selectedWbActions.push({
                    id: uid('act'),
                    name: entryName,
                    tags: cleanLorebookTags(tags || rawContent),
                    type: actType
                });

                // 关键自适应：若选入的是双人互动动作/体位，且当前处于单人模式，自动扩充并开启双人同框槽位！
                if (actType === 'interaction') {
                    if (comp.slots.length < 2) {
                        comp.slots.push({ charName: '', outfitId: '', customOutfit: '', action: '', uc: '', center: 'D3' });
                        toastr.success(`已载入双人互动动作「${entryName}」，已自动为你开启双人同框槽位！`, PLUGIN_NAME);
                    } else {
                        toastr.success(`已添加双人动作「${entryName}」`, PLUGIN_NAME);
                    }
                } else if (actType === 'scene') {
                    toastr.success(`已添加场景环境「${entryName}」`, PLUGIN_NAME);
                } else {
                    toastr.success(`已添加单人动作「${entryName}」`, PLUGIN_NAME);
                }

                autoMatchOutfitsForActiveComposer();
                wsSave();
                refresh('composer');
            }, 'all', true);
        });

        // Pick Worldbook Scene
        container.querySelector('#cw-pick-scene-wb')?.addEventListener('click', () => {
            openWorldbookPicker('挑选场景/环境词条', (tags, entry) => {
                const entryName = (entry?.comment || entry?.name || entry?.key || '世界书场景').replace(/^[#\-\*\s]*[^\n:：]+[:：]\s*/gm, '').trim();
                if (!Array.isArray(comp.selectedWbActions)) comp.selectedWbActions = [];
                comp.selectedWbActions.push({
                    id: uid('act'),
                    name: entryName,
                    tags: tags,
                    type: 'scene'
                });
                autoMatchOutfitsForActiveComposer();
                wsSave();
                refresh('composer');
                toastr.success(`已载入场景环境「${entryName}」`, PLUGIN_NAME);
            }, 'scene', true);
        });

        // Clear all WB actions
        container.querySelector('#cw-clear-wb-actions')?.addEventListener('click', () => {
            comp.selectedWbActions = [];
            wsSave();
            refresh('composer');
            toastr.info('已清空动作词条', PLUGIN_NAME);
        });

        // Toggle WB action type (template <-> action <-> interaction <-> scene)
        container.querySelectorAll('.cw-wb-toggle-type').forEach(b => b.addEventListener('click', () => {
            const idx = +b.dataset.idx;
            if (Array.isArray(comp.selectedWbActions) && comp.selectedWbActions[idx]) {
                const cur = comp.selectedWbActions[idx].type || 'action';
                const next = cur === 'template' ? 'action' : (cur === 'action' ? 'interaction' : (cur === 'interaction' ? 'scene' : 'template'));
                comp.selectedWbActions[idx].type = next;
                wsSave();
                refresh('composer');
                const label = next === 'template' ? '📜 分镜模板' : (next === 'interaction' ? '👥 双人互动' : (next === 'scene' ? '🏞️ 场景' : '💃 单人动作'));
                toastr.info(`已将分类切换为: ${label}`, PLUGIN_NAME);
            }
        }));

        // Delete single WB action chip
        container.querySelectorAll('.cw-wb-del').forEach(b => b.addEventListener('click', () => {
            const idx = +b.dataset.idx;
            if (Array.isArray(comp.selectedWbActions)) {
                comp.selectedWbActions.splice(idx, 1);
                wsSave();
                refresh('composer');
            }
        }));

        // Custom action text input
        container.querySelector('#cw-custom-action-tags')?.addEventListener('input', e => {
            comp.customActionInput = e.target.value;
            wsSave();
            updatePromptPreview();
        });

        // Scene & Camera inputs & quick tags
        container.querySelector('#cw-scene')?.addEventListener('input', e => { comp.scene = e.target.value; wsSave(); updatePromptPreview(); });
        container.querySelector('#cw-camera')?.addEventListener('input', e => { comp.camera = e.target.value; wsSave(); updatePromptPreview(); });

        function toggleFieldTag(inputEl, fieldKey, tag) {
            let tags = (comp[fieldKey] || '').split(/[,，;；]+/).map(s => s.trim()).filter(Boolean);
            const incoming = tag.split(/[,，;；]+/).map(s => s.trim()).filter(Boolean);
            const allPresent = incoming.length > 0 && incoming.every(inTag => tags.some(t => t.toLowerCase() === inTag.toLowerCase()));

            if (allPresent) {
                // 全部已存在 -> 取消勾选，移除这批标签
                tags = tags.filter(t => !incoming.some(inTag => inTag.toLowerCase() === t.toLowerCase()));
            } else {
                // 尚未全部存在 -> 补充添加未存在的标签
                for (const inTag of incoming) {
                    if (!tags.some(t => t.toLowerCase() === inTag.toLowerCase())) {
                        tags.push(inTag);
                    }
                }
            }
            comp[fieldKey] = tags.join(', ');
            if (inputEl) inputEl.value = comp[fieldKey];
            wsSave();
            updatePromptPreview();
            refresh('composer');
        }

        container.querySelectorAll('.cw-quick-scene').forEach(btn => {
            btn.addEventListener('click', () => {
                toggleFieldTag(container.querySelector('#cw-scene'), 'scene', btn.dataset.tag);
            });
        });

        container.querySelectorAll('.cw-quick-camera').forEach(btn => {
            btn.addEventListener('click', () => {
                toggleFieldTag(container.querySelector('#cw-camera'), 'camera', btn.dataset.tag);
            });
        });

        container.querySelector('#cw-pick-scene')?.addEventListener('click', () => {
            openWorldbookPicker('选择场景环境', (tags) => {
                if (tags) {
                    const merged = [comp.scene, tags].filter(Boolean).join(', ');
                    comp.scene = merged;
                    wsSave();
                    refresh('composer');
                }
            }, 'scene');
        });

        container.querySelector('#cw-pick-camera')?.addEventListener('click', () => {
            openWorldbookPicker('选择视角与镜头', (tags) => {
                if (tags) {
                    const merged = [comp.camera, tags].filter(Boolean).join(', ');
                    comp.camera = merged;
                    wsSave();
                    refresh('composer');
                }
            }, 'camera');
        });

        // 5x5 / Continuous Coords toggle
        container.querySelector('#cw-toggle-coords')?.addEventListener('change', (e) => {
            comp.useCoords = !!e.target.checked;
            const s = RBQ.api.getSettings();
            if (!s[MCC_KEY]) s[MCC_KEY] = {};
            s[MCC_KEY].useCoords = comp.useCoords;
            wsSave();
            refresh('composer');
            toastr.info(comp.useCoords ? 'V5 空间坐标定位已开启' : '坐标定位已关闭，角色站位将由 AI 自主决定', PLUGIN_NAME);
        });

        // Snap toggle
        container.querySelector('#cw-toggle-snap')?.addEventListener('click', () => {
            comp.snapGrid = !comp.snapGrid;
            wsSave();
            refresh('composer');
        });

        // Slot switcher buttons
        container.querySelectorAll('.cw-switch-slot').forEach(b => b.addEventListener('click', () => {
            comp.activeSlotIndex = +b.dataset.idx;
            wsSave();
            refresh('composer');
        }));

        // Grid cell clicks (snap active slot to clicked cell)
        container.querySelectorAll('.cw-cell').forEach(cell => cell.addEventListener('click', () => {
            const ai = comp.activeSlotIndex || 0;
            if (comp.slots && comp.slots[ai]) {
                const coord = cell.dataset.coord;
                const pt = cwParseCoord(coord);
                comp.slots[ai].center = comp.snapGrid ? coord : { x: pt.x, y: pt.y };
                wsSave();
                refresh('composer');
            }
        }));

        // Draggable pins and continuous stage interaction
        const stage = container.querySelector('#cw-stage');
        if (stage) {
            let activeDragSlot = null;

            const snapValue = (val) => {
                return Math.max(0.1, Math.min(0.9, Math.round((val - 0.1) / 0.2) * 0.2 + 0.1));
            };

            const updateSlotPos = (si, rawX, rawY, saveAndRefresh = false) => {
                let px = Math.max(0, Math.min(1, rawX));
                let py = Math.max(0, Math.min(1, rawY));
                if (comp.snapGrid) {
                    px = snapValue(px);
                    py = snapValue(py);
                }
                const fx = Number(px.toFixed(2));
                const fy = Number(py.toFixed(2));

                if (comp.slots && comp.slots[si]) {
                    comp.slots[si].center = { x: fx, y: fy };
                }

                // Update pin visually
                const pin = stage.querySelector(`.cw-pin[data-si="${si}"]`);
                if (pin) {
                    pin.style.left = `${(fx * 100)}%`;
                    pin.style.top = `${(fy * 100)}%`;
                    pin.setAttribute('title', `${comp.slots[si]?.charName || 'Char ' + (si + 1)} (${formatCenterDisplay(comp.slots[si]?.center)})`);
                }

                // If active slot, update inputs and preview
                if (si === (comp.activeSlotIndex || 0)) {
                    const inX = container.querySelector('#cw-coord-x');
                    const inY = container.querySelector('#cw-coord-y');
                    if (inX) inX.value = fx.toFixed(2);
                    if (inY) inY.value = fy.toFixed(2);
                }

                updatePromptPreview();

                if (saveAndRefresh) {
                    wsSave();
                    refresh('composer');
                }
            };

            stage.querySelectorAll('.cw-pin').forEach(pin => {
                pin.addEventListener('pointerdown', (e) => {
                    e.stopPropagation();
                    const si = parseInt(pin.dataset.si, 10);
                    comp.activeSlotIndex = si;
                    activeDragSlot = si;
                    try { pin.setPointerCapture(e.pointerId); } catch (_) {}
                    // Refresh active highlight immediately
                    stage.querySelectorAll('.cw-pin').forEach(p => {
                        const isCur = parseInt(p.dataset.si, 10) === si;
                        p.style.zIndex = isCur ? '10' : '3';
                        p.style.transform = `translate(-50%, -50%) ${isCur ? 'scale(1.25)' : 'scale(1)'}`;
                        p.style.border = `2px solid ${isCur ? '#ffffff' : 'rgba(0,0,0,0.6)'}`;
                    });
                });

                pin.addEventListener('pointermove', (e) => {
                    if (activeDragSlot === null) return;
                    const rect = stage.getBoundingClientRect();
                    if (!rect.width || !rect.height) return;
                    const rx = (e.clientX - rect.left) / rect.width;
                    const ry = (e.clientY - rect.top) / rect.height;
                    updateSlotPos(activeDragSlot, rx, ry, false);
                });

                const endDrag = (e) => {
                    if (activeDragSlot === null) return;
                    activeDragSlot = null;
                    try { pin.releasePointerCapture(e.pointerId); } catch (_) {}
                    wsSave();
                    refresh('composer');
                };

                pin.addEventListener('pointerup', endDrag);
                pin.addEventListener('pointercancel', endDrag);
            });

            // Stage surface click / drag for active pin
            stage.addEventListener('pointerdown', (e) => {
                if (e.target.classList.contains('cw-pin')) return;
                const ai = comp.activeSlotIndex || 0;
                activeDragSlot = ai;
                try { stage.setPointerCapture(e.pointerId); } catch (_) {}
                const rect = stage.getBoundingClientRect();
                if (!rect.width || !rect.height) return;
                const rx = (e.clientX - rect.left) / rect.width;
                const ry = (e.clientY - rect.top) / rect.height;
                updateSlotPos(ai, rx, ry, false);
            });

            stage.addEventListener('pointermove', (e) => {
                if (activeDragSlot === null || e.target.classList.contains('cw-pin')) return;
                const rect = stage.getBoundingClientRect();
                if (!rect.width || !rect.height) return;
                const rx = (e.clientX - rect.left) / rect.width;
                const ry = (e.clientY - rect.top) / rect.height;
                updateSlotPos(activeDragSlot, rx, ry, false);
            });

            const endStageDrag = (e) => {
                if (activeDragSlot === null || e.target.classList.contains('cw-pin')) return;
                activeDragSlot = null;
                try { stage.releasePointerCapture(e.pointerId); } catch (_) {}
                wsSave();
                refresh('composer');
            };

            stage.addEventListener('pointerup', endStageDrag);
            stage.addEventListener('pointercancel', endStageDrag);

            // Numeric input handlers for active slot
            const inputCoordX = container.querySelector('#cw-coord-x');
            const inputCoordY = container.querySelector('#cw-coord-y');

            const handleCoordInput = () => {
                const ai = comp.activeSlotIndex || 0;
                const vx = parseFloat(inputCoordX?.value || '0.5');
                const vy = parseFloat(inputCoordY?.value || '0.5');
                updateSlotPos(ai, isNaN(vx) ? 0.5 : vx, isNaN(vy) ? 0.5 : vy, false);
                wsSave();
            };

            inputCoordX?.addEventListener('change', () => { handleCoordInput(); refresh('composer'); });
            inputCoordY?.addEventListener('change', () => { handleCoordInput(); refresh('composer'); });
            inputCoordX?.addEventListener('input', handleCoordInput);
            inputCoordY?.addEventListener('input', handleCoordInput);
        }

        // Copy prompt
        container.querySelector('#cw-copy-prompt')?.addEventListener('click', async () => {
            const p = composeFinalPrompt(comp);
            const ok = await copyToClipboard(p);
            if (ok) toastr.success('已复制合成提示词', PLUGIN_NAME);
            else toastr.warning('复制失败，请手动选取', PLUGIN_NAME);
        });

        // Save preset
        container.querySelector('#cw-save-preset')?.addEventListener('click', () => {
            const name = prompt('请输入该动作分镜预设的名称：', '动作预设 ' + new Date().toLocaleDateString());
            if (!name) return;
            ws.presets.push({
                id: uid('preset'),
                name,
                scene: comp.scene || '',
                camera: comp.camera || '',
                selectedWbActions: JSON.parse(JSON.stringify(comp.selectedWbActions || [])),
                slots: JSON.parse(JSON.stringify(comp.slots || []))
            });
            wsSave();
            toastr.success(`预设「${name}」已保存！可在「分镜模板与预设」中随时载入`, PLUGIN_NAME);
        });

        // One-Click Generate Image
        container.querySelector('#cw-generate')?.addEventListener('click', async (ev) => {
            const btn = ev.currentTarget;
            const origHtml = btn.innerHTML;
            const p = composeFinalPrompt(comp);

            const s = RBQ.api.getSettings();
            if (!s[MCC_KEY]) s[MCC_KEY] = {};
            s[MCC_KEY].useCoords = comp.useCoords === true;
            RBQ.api.saveSettings();

            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在生成画作...';
            toastr.info('🚀 正在调用 RBQ 生图引擎演练生成...', PLUGIN_NAME);

            try {
                const result = await RBQ.api.generateImage(p, 'cw-action-test', {}, (progress) => {
                    if (typeof progress === 'string') btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${progress.slice(0, 12)}...`;
                });

                if (result && result.url) {
                    showGeneratedImageModal('动作工坊 · 角色演练画面', p, result);
                    toastr.success('🎉 画面演练完成！', PLUGIN_NAME);
                } else {
                    throw new Error('生图未返回有效图片地址');
                }
            } catch (e) {
                toastr.error('生图失败: ' + (e.message || e), PLUGIN_NAME);
            } finally {
                btn.disabled = false;
                btn.innerHTML = origHtml;
            }
        });

        // Jump from Dossier to Action Studio
        container.querySelectorAll('.cw-go-action').forEach(b => b.addEventListener('click', () => {
            const charName = b.dataset.name;
            if (comp.slots.length === 0) {
                comp.slots.push({ charName, outfitId: '', customOutfit: '', action: '', uc: '', center: 'B3' });
            } else {
                comp.slots[0].charName = charName;
                comp.slots[0].outfitId = '';
            }
            wsSave();
            toastr.info(`已将「${charName}」设为主演角色并进入动作工坊`, PLUGIN_NAME);
            refresh('composer');
        }));

        // ── Dossier Events ──
        const openLibraryFromEditor = () => { if (setDossierScope('all')) refresh('dossier'); };
        container.querySelectorAll('.cw-scope-btn').forEach(b => b.addEventListener('click', () => {
            if (setDossierScope(b.dataset.scope)) refresh('dossier');
        }));

        container.querySelector('#cw-mount-lorebook-btn')?.addEventListener('click', () => {
            openMountLorebookModal(() => {
                refresh('dossier');
            });
        });

        container.querySelectorAll('.cw-import-from-lorebook').forEach(b => b.addEventListener('click', (e) => {
            const name = e.currentTarget.dataset.name;
            const p = getProfile(name);
            if (p) {
                const toImport = { ...p };
                delete toImport.source;
                saveProfile(name, toImport);
                toastr.success(`已成功将「${name}」导入为当前会话常驻角色档案！可在「当前会话」中自由编辑与调教`, PLUGIN_NAME);
                refresh('dossier');
            }
        }));

        container.querySelector('#cw-global-only-btn')?.addEventListener('click', () => {
            dossierGlobalOnly = !dossierGlobalOnly;
            selectedDossierNames.clear();
            refresh('dossier');
        });

        container.querySelectorAll('.cw-toggle-global-char').forEach(b => b.addEventListener('click', (e) => {
            e.stopPropagation();
            const name = e.currentTarget.dataset.name;
            if (isGlobalCharacter(name)) {
                if (!confirm(`确定取消「${name}」的全局角色吗？\n（之后不再自动发给 LLM；已导入各会话的副本保留不变）`)) return;
                setGlobalCharacter(name, false);
                toastr.info(`已取消全局角色「${name}」`, PLUGIN_NAME);
            } else if (setGlobalCharacter(name, true)) {
                if (isSdtCharacterMemoryOn()) {
                    toastr.success(`「${name}」已设为全局角色：任何会话都会发给 LLM，剧情中登场时自动导入当前会话并锁定`, PLUGIN_NAME);
                } else {
                    toastr.warning(`「${name}」已设为全局角色，但「角色外貌记忆」没有打开，现在还不会发给 LLM。点顶部「一键打开」后生效。`, PLUGIN_NAME);
                }
                warnGlobalAliasConflicts(name);
            } else {
                toastr.warning(`未在角色库中找到「${name}」`, PLUGIN_NAME);
            }
            refresh('dossier');
        }));

        container.querySelectorAll('.cw-import-from-global').forEach(b => b.addEventListener('click', (e) => {
            const name = e.currentTarget.dataset.name;
            if (isGlobalCharacter(name) && importGlobalCharacterToCurrentChat(name)) {
                toastr.success(`已将⭐全局角色「${esc(name)}」导入到当前会话（人设与服装已锁定）<br><small style="opacity:.8">锁定只是不让自动改写，在角色工坊里可以直接编辑；会话里的改动不会同步回全局</small>`, PLUGIN_NAME, { escapeHtml: false });
                refresh('dossier');
                return;
            }
            const globalProfiles = getAllGlobalProfiles();
            const p = globalProfiles[name] || getProfile(name);
            if (p) {
                const toImport = JSON.parse(JSON.stringify(p));
                saveProfile(name, toImport, 'chat');
                toastr.success(`已成功将「${name}」导入到当前会话档案库！可在当前会话中直接使用`, PLUGIN_NAME);
                refresh('dossier');
            } else {
                toastr.warning(`未在角色库中找到角色「${name}」`, PLUGIN_NAME);
            }
        }));

        container.querySelectorAll('.cw-overwrite-from-global').forEach(b => b.addEventListener('click', (e) => {
            const name = e.currentTarget.dataset.name;
            const confirmMsg = isGlobalCharacter(name)
                ? `确定用⭐全局角色「${name}」覆盖当前会话中的版本吗？\n（人设与服装将锁定；当前会话里解析出的新内容会被替换）`
                : `确定用角色库中的「${name}」档案覆盖当前会话中的版本吗？\n（将采用锁定优先、其次最早建档的那份档案；当前会话里解析出的新内容会被替换）`;
            if (!confirm(confirmMsg)) return;
            if (overwriteCurrentChatFromGlobal(name)) {
                toastr.success(`已用全局版本覆盖当前会话中的「${name}」档案`, PLUGIN_NAME);
                refresh('dossier');
            } else {
                toastr.warning(`未在角色库中找到角色「${name}」`, PLUGIN_NAME);
            }
        }));

        container.querySelectorAll('.cw-export-single-char').forEach(b => b.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const name = b.dataset.name;
            const p = getProfile(name) || getAllProfiles()[name];
            if (!p) {
                toastr.warning(`未找到角色「${name}」的档案数据`, PLUGIN_NAME);
                return;
            }
            const exportData = {
                version: '1.0',
                type: 'rbq-character-profile',
                exportedAt: new Date().toISOString(),
                character: JSON.parse(JSON.stringify(p))
            };
            const filename = `角色档案-${p.displayName || name}-${new Date().toISOString().slice(0, 10)}.json`;
            if (downloadJsonFile(exportData, filename)) {
                toastr.success(`已成功导出角色「${p.displayName || name}」为 JSON 文件`, PLUGIN_NAME);
            } else {
                toastr.error('导出文件失败，请检查浏览器权限', PLUGIN_NAME);
            }
        }));

        container.querySelector('#cw-export-dossier-btn')?.addEventListener('click', () => {
            const exportData = buildDossierBackupPayload(dossierScope, getAllProfiles());
            const count = exportData.count;
            const globalCount = (exportData.globalNames || []).length;
            if (count === 0) {
                toastr.warning('当前视图没有可导出的角色档案', PLUGIN_NAME);
                return;
            }
            const scopeLabel = dossierScope === 'all' ? '角色库' : (dossierScope === 'lorebook' ? '同人库' : '当前会话');
            const filename = `RBQ角色档案库-${scopeLabel}-${new Date().toISOString().slice(0, 10)}.json`;
            if (downloadJsonFile(exportData, filename)) {
                toastr.success(`已成功导出 ${count} 位角色档案（${scopeLabel}${globalCount ? `，含 ${globalCount} 位⭐全局角色` : ''}）`, PLUGIN_NAME);
            } else {
                toastr.error('导出备份失败', PLUGIN_NAME);
            }
        });

        const dossierFileInput = container.querySelector('#cw-import-dossier-file');
        container.querySelector('#cw-import-dossier-btn')?.addEventListener('click', () => {
            dossierFileInput?.click();
        });
        dossierFileInput?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const raw = JSON.parse(ev.target.result);
                    const { importedCount, globals } = importDossierBackupData(raw, file.name);
                    const globalMsg = [
                        globals.restored.length ? `恢复 ${globals.restored.length} 位⭐全局角色` : '',
                        globals.skipped.length ? `保留现有的⭐全局角色${globals.skipped.map(n => `「${esc(n)}」`).join('')}` : '',
                    ].filter(Boolean).join('，');

                    if (importedCount > 0 || globals.restored.length || globals.skipped.length || globals.unchanged.length) {
                        toastr.success(importedCount > 0
                            ? `成功导入 ${importedCount} 位角色档案到当前会话！${globalMsg ? `<br>${globalMsg}` : ''}`
                            : (globalMsg || '备份里的⭐全局角色与现有的一致，无需恢复'), PLUGIN_NAME, { escapeHtml: false });
                        refresh('dossier');
                    } else {
                        toastr.warning('未在文件中识别到有效的角色档案数据', PLUGIN_NAME);
                    }
                } catch (err) {
                    toastr.error('导入角色档案失败: ' + (err.message || err), PLUGIN_NAME);
                } finally {
                    e.target.value = '';
                }
            };
            reader.readAsText(file);
        });

        // ── Batch Management Listeners ──
        container.querySelector('#cw-batch-mode-btn')?.addEventListener('click', () => {
            isDossierBatchMode = true;
            selectedDossierNames.clear();
            refresh('dossier');
        });

        container.querySelector('#cw-batch-exit-btn')?.addEventListener('click', () => {
            isDossierBatchMode = false;
            selectedDossierNames.clear();
            refresh('dossier');
        });

        container.querySelector('#cw-batch-toggle-all')?.addEventListener('click', () => {
            const currentNames = Object.keys(getAllProfiles());
            if (selectedDossierNames.size === currentNames.length) {
                selectedDossierNames.clear();
            } else {
                currentNames.forEach(n => selectedDossierNames.add(n));
            }
            refresh('dossier');
        });

        container.querySelectorAll('.cw-batch-item-check').forEach(chk => {
            chk.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const name = ev.currentTarget.dataset.name;
                if (ev.currentTarget.checked) {
                    selectedDossierNames.add(name);
                } else {
                    selectedDossierNames.delete(name);
                }
                refresh('dossier');
            });
        });

        container.querySelectorAll('.cw-batch-card').forEach(card => {
            card.addEventListener('click', (ev) => {
                if (ev.target.closest('button') || ev.target.closest('input')) return;
                const name = card.dataset.name;
                if (name) {
                    if (selectedDossierNames.has(name)) {
                        selectedDossierNames.delete(name);
                    } else {
                        selectedDossierNames.add(name);
                    }
                    refresh('dossier');
                }
            });
        });

        container.querySelector('#cw-batch-delete-btn')?.addEventListener('click', () => {
            const count = selectedDossierNames.size;
            if (count === 0) return toastr.warning('请先勾选需要删除的角色', PLUGIN_NAME);
            const isGlobal = (dossierScope === 'all');
            const confirmMsg = isGlobal
                ? `确定从角色库中彻底删除选中的 ${count} 位角色吗？\n（这些角色在所有历史会话中的档案与记忆都将被清理且不可恢复；若是⭐全局角色也会一并取消）`
                : `确定从当前会话中移除选中的 ${count} 位角色吗？`;
            if (confirm(confirmMsg)) {
                for (const n of selectedDossierNames) {
                    deleteProfile(n, dossierScope);
                }
                selectedDossierNames.clear();
                toastr.success(isGlobal ? `已从角色库彻底删除 ${count} 位角色档案！` : `已从当前会话移除 ${count} 位角色档案！`, PLUGIN_NAME);
                refresh('dossier');
            }
        });

        container.querySelector('#cw-batch-import-curr')?.addEventListener('click', () => {
            const count = selectedDossierNames.size;
            if (count === 0) return toastr.warning('请先勾选需要导入的角色', PLUGIN_NAME);
            const globalProfiles = getAllGlobalProfiles();
            let imported = 0;
            for (const n of selectedDossierNames) {
                if (isGlobalCharacter(n) && importGlobalCharacterToCurrentChat(n)) { imported++; continue; }
                const p = globalProfiles[n] || getProfile(n);
                if (p) {
                    saveProfile(n, JSON.parse(JSON.stringify(p)), 'chat');
                    imported++;
                }
            }
            selectedDossierNames.clear();
            toastr.success(`已成功将 ${imported} 位角色批量导入到当前会话！`, PLUGIN_NAME);
            refresh('dossier');
        });

        container.querySelector('#cw-batch-export-btn')?.addEventListener('click', () => {
            const count = selectedDossierNames.size;
            if (count === 0) return toastr.warning('请先勾选需要导出的角色', PLUGIN_NAME);
            const exported = {};
            for (const n of selectedDossierNames) {
                exported[n] = getProfile(n) || getAllProfiles()[n];
            }
            const scopeLabel = dossierScope === 'all' ? '角色库' : (dossierScope === 'lorebook' ? '同人库' : '当前会话');
            const payload = {
                version: '1.0',
                type: 'rbq-character-dossier-backup',
                scope: dossierScope,
                exportedAt: new Date().toISOString(),
                count,
                characters: JSON.parse(JSON.stringify(exported))
            };
            if (dossierScope === 'all') {
                const globalCharacters = buildGlobalCharactersBackup(selectedDossierNames);
                if (Object.keys(globalCharacters).length) Object.assign(payload, { version: '1.1', globalCharacters, globalNames: Object.keys(globalCharacters) });
            }
            const filename = `RBQ角色档案-批量选中-${count}位-${scopeLabel}-${new Date().toISOString().slice(0, 10)}.json`;
            if (downloadJsonFile(payload, filename)) {
                toastr.success(`已成功批量导出 ${count} 位角色档案！`, PLUGIN_NAME);
            } else {
                toastr.error('导出文件失败，请检查浏览器权限', PLUGIN_NAME);
            }
        });

        container.querySelector('#cw-create-char')?.addEventListener('click', () => openCharacterEditor(null, () => refresh('dossier'), openLibraryFromEditor));

        container.querySelectorAll('.cw-test-dossier-char').forEach(b => b.addEventListener('click', (ev) => {
            try {
                const btn = ev.currentTarget;
                const charName = b.dataset.name;
                const p = getProfile(charName) || getAllProfiles()[charName];
                if (!p) {
                    toastr.warning(`未找到角色「${charName}」的档案数据`, PLUGIN_NAME);
                    return;
                }
                const activeW = Array.isArray(p.wardrobe) ? (p.wardrobe.find(w => w.id === p.currentOutfitId) || p.wardrobe[0]) : null;
                const outfit = activeW?.outfit || activeW?.tags || p.currentOutfit || '';
                openPortraitTestModal(p.displayName || charName, p.baseTags, outfit, (newAvatarUrl) => {
                    p.avatarUrl = newAvatarUrl;
                    saveProfile(charName, p, dossierScope);
                    refresh('dossier');
                }, btn);
            } catch (err) {
                console.error('[CW] 测试按钮点击出错:', err);
                toastr.error('启动测试失败: ' + (err.message || err), PLUGIN_NAME);
            }
        }));

        container.querySelectorAll('.cw-send-to-stage').forEach(b => b.addEventListener('click', () => {
            const charName = b.dataset.name;
            const slots = comp.slots;
            const emptySlot = slots.find(s => !s.charName);
            if (emptySlot) {
                emptySlot.charName = charName;
            } else {
                const usedCoords = new Set(slots.map(s => (s.center || '').toUpperCase()));
                const candidateCoords = ['B3', 'D3', 'C3', 'A3', 'E3', 'B2', 'D2', 'C4'];
                const nextCoord = candidateCoords.find(c => !usedCoords.has(c)) || 'C3';
                slots.push({ charName, outfitId: '', customOutfit: '', action: '', uc: '', center: nextCoord });
            }
            wsSave();
            toastr.success(`已将「${charName}」放入空间舞台！`, PLUGIN_NAME);
            refresh('composer');
        }));

        container.querySelectorAll('.cw-edit-char').forEach(b => b.addEventListener('click', () => {
            openCharacterEditor(b.dataset.name, () => refresh('dossier'), openLibraryFromEditor);
        }));

        container.querySelectorAll('.cw-del-char').forEach(b => b.addEventListener('click', () => {
            const charName = b.dataset.name;
            const isGlobal = (dossierScope === 'all');
            const confirmMsg = isGlobal
                ? `确定从角色库中彻底删除角色「${charName}」的档案记忆吗？\n（该角色在所有会话历史中的档案都将被清理；若是⭐全局角色也会一并取消）`
                : `确定从当前会话中移除角色「${charName}」的档案记忆吗？`;
            if (confirm(confirmMsg)) {
                if (deleteProfile(charName, dossierScope)) {
                    toastr.success(isGlobal ? `角色「${charName}」已从角色库彻底删除` : `角色「${charName}」已从当前会话移除`, PLUGIN_NAME);
                } else {
                    toastr.warning(isGlobal ? `角色库里没有找到「${charName}」，没有删除任何内容` : `当前会话里没有找到「${charName}」，没有删除任何内容（其他对话不受影响）`, PLUGIN_NAME);
                }
                refresh('dossier');
            }
        }));

        // ── Presets Events ──
        container.querySelectorAll('.cw-load-tpl').forEach(b => b.addEventListener('click', () => {
            const tpl = TEMPLATES[+b.dataset.idx];
            if (!tpl) return;
            comp.interaction = tpl.interaction || '';
            comp.scene = tpl.scene || '';
            comp.camera = tpl.camera || '';
            const newSlots = tpl.slots.map((ts, i) => {
                const existingChar = comp.slots[i]?.charName || '';
                const existingOutfit = comp.slots[i]?.outfitId || '';
                return {
                    charName: existingChar,
                    outfitId: existingOutfit,
                    customOutfit: '',
                    action: ts.action || '',
                    uc: ts.uc || '',
                    center: ts.center || 'C3'
                };
            });
            comp.slots = newSlots;
            comp.activeSlotIndex = 0;
            wsSave();
            toastr.success(`已载入分镜「${tpl.name}」到舞台（已保留绑定角色）`, PLUGIN_NAME);
            refresh('composer');
        }));

        container.querySelectorAll('.cw-load-preset').forEach(b => b.addEventListener('click', () => {
            const p = ws.presets[+b.dataset.idx];
            if (!p) return;
            comp.interaction = p.interaction || '';
            comp.scene = p.scene || '';
            comp.camera = p.camera || '';
            comp.slots = JSON.parse(JSON.stringify(p.slots || []));
            comp.selectedWbActions = JSON.parse(JSON.stringify(p.selectedWbActions || []));
            comp.activeSlotIndex = 0;
            wsSave();
            toastr.success(`已载入预设「${p.name}」到工坊`, PLUGIN_NAME);
            refresh('composer');
        }));

        container.querySelectorAll('.cw-del-preset').forEach(b => b.addEventListener('click', () => {
            const idx = +b.dataset.idx;
            if (confirm('确定删除该预设吗？')) {
                ws.presets.splice(idx, 1);
                wsSave();
                toastr.info('已删除预设', PLUGIN_NAME);
                refresh('presets');
            }
        }));
    }

    // ══════════════════════════════════════════════════════════
    //  Panel Mount via RBQ.ui.addSettingPanel
    // ══════════════════════════════════════════════════════════
    function mount() {
        if (!RBQ.ui || typeof RBQ.ui.addSettingPanel !== 'function') {
            return console.warn('[CW] RBQ.ui.addSettingPanel not available');
        }

        let refreshMain = null;

        RBQ.ui.addSettingPanel('character-workshop', '<i class="fa-solid fa-palette"></i><span>角色工坊</span>', () => {
            const w = document.createElement('div');
            w.id = 'cw-root-container';
            w.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden';
            const refresh = (tab) => {
                try {
                    w.innerHTML = renderMain(tab);
                    bindEvents(w, refresh);
                } catch (e) {
                    console.error('[CW] refresh error:', e);
                    w.innerHTML = `<div style="padding:20px;color:#ef4444">角色工坊渲染异常: ${e?.message || e}</div>`;
                }
            };
            refreshMain = refresh;
            try {
                refresh(activeTab);
            } catch (e) {
                console.error('[CW] initial render error:', e);
            }

            // 监听面板可见性：每次进入面板时自动根据当前最新会话刷新角色列表
            if (typeof IntersectionObserver !== 'undefined') {
                let isFirst = true;
                const observer = new IntersectionObserver((entries) => {
                    for (const entry of entries) {
                        if (entry.isIntersecting) {
                            if (!isFirst) {
                                refresh(activeTab);
                            }
                            isFirst = false;
                        }
                    }
                }, { threshold: 0.05 });
                observer.observe(w);
            }

            return w;
        });

        // 监听进入角色工坊的各种入口
        const triggerRefresh = () => {
            if (typeof refreshMain === 'function') {
                setTimeout(() => refreshMain(activeTab), 30);
            }
        };

        document.addEventListener('click', (e) => {
            const t = e.target;
            if (t && t.closest && t.closest('[data-kite-tab="character-workshop"], #rbq-sdt-goto-workshop-btn')) {
                triggerRefresh();
            }
        });

        document.addEventListener('rbq-tab-switched', (e) => {
            if (e.detail?.tab === 'character-workshop') {
                triggerRefresh();
            }
        });
    }

    mount();
    console.info('[' + PLUGIN_NAME + '] v' + VERSION + ' loaded — Complete Character & Stage Engine');

})((typeof RBQ !== 'undefined' ? RBQ : (window.RBQ || null)), (typeof jQuery !== 'undefined' ? jQuery : window.$), (typeof toastr !== 'undefined' ? toastr : { success: console.log, warning: console.warn, error: console.error, info: console.info }));
