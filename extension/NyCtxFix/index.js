import { extension_settings } from '../../../extensions.js';

// ── 用户输入自动包裹 ────────────────────────────────────────────
// 把每条 user 消息包成 {...}，让模型能把「用户此刻说的话」和设定资料区分开。
// placement [1] = USER_INPUT，promptOnly = true → 只在组装 prompt 时生效，
// 不改聊天记录里显示的文字。
// 只在整行 ≤60 字、且尚未被花括号包住时才包，长段落不动。
const USERWRAP_ID = 'f8397613-ec18-47f1-8c85-85283de9133c';
const USERWRAP_NAME = 'Ny-用户输入自动包裹';

function ensureUserWrapRegex() {
    try {
        if (!extension_settings) return;
        if (!Array.isArray(extension_settings.regex)) extension_settings.regex = [];
        const exists = extension_settings.regex.some(r => r && (r.id === USERWRAP_ID || r.scriptName === USERWRAP_NAME));
        if (exists) return; // 已存在（哪怕被手动 disable）就不再插手
        extension_settings.regex.push({
            id: USERWRAP_ID,
            scriptName: USERWRAP_NAME,
            findRegex: '/^(?!\\{)([^\\n]{1,60})$/',
            replaceString: '{$1}',
            trimStrings: [],
            placement: [1],
            disabled: false,
            markdownOnly: false,
            promptOnly: true,
            runOnEdit: false,
            substituteRegex: 0,
            minDepth: null,
            maxDepth: null,
        });
    } catch (e) {
        console.warn('[NyCtxFix] ensureUserWrapRegex failed', e);
    }
}

// Ny Context Fix — 防止 SillyTavern 把「上下文大小」滑条钳制到 HTML 默认上限 4095
// 背景：index.html 里 <input id="openai_max_context" min="512" max="4095">
//       当预设/设置注入更大的值（如 100000 / 2000000）时，DOM 会把 value 钳到 4095，
//       随后 input 事件把 oai_settings.openai_max_context 写成 4095。
//       若 openai_max_tokens 仍为 20000 → tokenBudget = 4095 - 20000 < 0
//       → prepareOpenAIMessages 抛 TokenBudgetExceededError
//       → toastr「必要的提示词超过了上下文大小」。
// 本扩展在任何钳制发生之前把 max 属性抬到大值。

const TARGET_CTX = 2000000;
const TARGET_TOK = 128000; // 与 index.html 中 openai_max_tokens 的原生 max 一致，只升不降

function raise(el, target) {
    if (!el) return;
    const cur = Number(el.getAttribute('max'));
    if (!Number.isFinite(cur) || cur < target) {
        el.setAttribute('max', String(target));
    }
}

function apply() {
    raise(document.getElementById('openai_max_context'), TARGET_CTX);
    raise(document.getElementById('openai_max_context_counter'), TARGET_CTX);
    raise(document.getElementById('openai_max_tokens'), TARGET_TOK);
    raise(document.getElementById('openai_max_tokens_counter'), TARGET_TOK);
}


// ── 预设「对话边界」条目运行时锁定 ─────────────────────────────
// 为什么需要：ST 的 oai_settings 常驻浏览器内存，磁盘上的预设文件被改过，
// 只要标签页没关，内存里的旧预设就会在任意一次保存时把磁盘写回去。
// 这里在运行时直接改内存里的 prompts 数组，UI 和发出去的请求都拿新的。
const BOUNDARY_ID = 'a36bd54c-6ed9-4454-b9ee-1991bbf867a3';
const BOUNDARY_TEXT = `//以上latest文字是剧情截断处，本次新剧情生成应当从此处开始。
//【对话边界】<history>中不带角色名前缀、单独成行的短句，或被一对半角花括号 {} 整行包住的内容，＝用户此刻的输入（花括号由系统自动添加，不是写作模板），是本次必须直接回应的对象。直接写角色对该动作或话语的反应与后续，禁止原样复述该句本身；不得跳过、不得只写环境与日常流程。叙述一律使用第三人称，以角色名或「他/她」作主语，不得改用「我」。`;

let ST = null;

function ensureBoundaryPrompt() {
    try {
        if (localStorage.getItem('nyctxfix_lock_boundary') === '0') return;
        const arr = ST?.oai_settings?.prompts;
        if (!Array.isArray(arr)) return;
        const target = arr.find(p => p && p.identifier === BOUNDARY_ID);
        if (!target) return;
        if (target.content !== BOUNDARY_TEXT) target.content = BOUNDARY_TEXT;
    } catch (e) {
        console.warn('[NyCtxFix] ensureBoundaryPrompt', e);
    }
}

function bootBoundary() {
    ensureBoundaryPrompt();
    [0, 300, 1000, 2500].forEach(ms => setTimeout(ensureBoundaryPrompt, ms));
    setInterval(ensureBoundaryPrompt, 2000);
}


// ── V41 内置预设档位锁定（防旧标签页把预设写回 custom） ──────────
// 从 6.5.53 起，V41 提示词已作为 v41_local 档位烧进 smart-draw-trigger 子插件本体，
// 不再需要往 customSystemPrompt 灌文本。这里只做一件事：如果某处把预设切成 custom
// （旧版本扩展 / 旧标签页内存值回写），立刻拉回 v41_local 并清空自定义残留。
// 关掉锁定：localStorage.setItem('nyctxfix_lock_v41','0')
const V41_PRESET_KEY = 'v41_local';

// 为什么不直接写 customSystemPrompt：内置档位一旦被 custom 覆盖，等于把烧进插件的 V41 绕过去了。
// 想彻底禁用：localStorage.setItem('nyctxfix_lock_v41','0')
function ensureV41Preset() {
    try {
        if (localStorage.getItem('nyctxfix_lock_v41') === '0') return;
        const st = ST?.extension_settings?.st_scene_trigger;
        const sdt = st?._smartDrawTriggerSettings;
        if (!sdt) return;
        // 用户主动选了别的内置档（v40 / v35 / consistent…）就尊重，不动
        if (sdt.systemPromptPreset !== 'custom') return;
        sdt.systemPromptPreset = V41_PRESET_KEY;
        sdt.customSystemPrompt = '';
        sdt.systemPrompt = '';
        try { ST?.saveSettingsDebounced?.(); } catch (e) { /* ignore */ }
        console.log('[NyCtxFix] 预设档位已从 custom 拉回 ' + V41_PRESET_KEY);
    } catch (e) {
        console.warn('[NyCtxFix] ensureV41Preset', e);
    }
}

function bootV41Preset() {
    [0, 500, 1500, 3000, 6000].forEach(ms => setTimeout(ensureV41Preset, ms));
    try {
        if (ST?.eventSource?.on) {
            ST.eventSource.on('settings_updated', () => setTimeout(ensureV41Preset, 300));
        }
    } catch (e) {
        console.warn('[NyCtxFix] bind settings_updated failed', e);
    }
    setInterval(ensureV41Preset, 15000);

import('../../../../script.js')
    .then(m => { ST = m; bootBoundary(); bootV41Preset(); })
    .catch(e => console.warn('[NyCtxFix] script.js import failed', e));

function boot() {
    apply();
    ensureUserWrapRegex();
    [0, 200, 800, 2000].forEach(ms => setTimeout(ensureUserWrapRegex, ms));
    // 工具面板是懒加载的，多补几次
    [0, 100, 300, 800, 1500, 3000].forEach(ms => setTimeout(apply, ms));

    // 任何一次 DOM 变化后都补一次（覆盖「重新打开设置面板」「切换预设」等时机）
    const obs = new MutationObserver(() => apply());
    obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['max'] });

    // 版本变化/重连后也补
    document.addEventListener('visibilitychange', apply);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}