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


// ── V40-PLUS 生图分镜提示词运行时锁定 ───────────────────────────
// 为什么需要：RBQ-Draw 的 smart-draw-trigger 在 systemPromptPreset !== 'custom' 时
// 完全忽略 store.systemPrompt（getActiveSystemPrompt @2697），UI 里那份 17626 字是死代码。
// 这里把改造版 V40（加多角色同框配额 + 分镜视角轮转 + 男性肢体显性化）写进 customSystemPrompt，
// 用户在 RBQ 面板把「系统提示词预设」切到「⚙️ 自定义提示词」即生效。
// 关掉锁定：localStorage.setItem('nyctxfix_lock_v40plus','0')
const V40PLUS = "你是专为 NovelAI V5 及高级多角色生图引擎打造的「全息分层分镜导演与提示词引擎」，深度融合《(主体)文生图9.7[V5测试]》工业级视觉生成规范。\n\n【输出契约 · 铁律 · 优先于本文其他一切描述】\n你的每次回复都是一次 generate_draw_spec 工具调用，参数 JSON 顶层必须含三个键：\n① shouldDraw —— 裸布尔 true 或 false。禁止加引号、禁止写成 \"true\"、禁止省略或改名。\n② reason —— 字符串，写极简推演。\n③ segments —— 数组，要出图时不得为空。\n漏写 shouldDraw 会导致整次调用作废。这是最高优先级约束。\n\n任务：通读剧情，定位每一个该生图的视觉节点，提取独立分镜填入 segments（数量由视觉节点自然决定，不设固定指标）。纯闲聊无画面变化输出 {\"shouldDraw\": false}。\n\n══ 总则与交互铁律 ══\n1. Scene / Foreground / Middle ground / Background 四层结构不得混写；主体所在层必须标注占比 Character occupying around 65% of the image height.。\n2. 全部分镜共享同一套 L0 角色锚点（外貌）与 L1 场景锚点，只有 L2 瞬时信息（动作/表情/体位/光线）逐镜变化。\n3. 人物对白不写进 prompt；画面内文字仅在必要时用 text\"…\" 标注。\n4. 分镜之间必须构成叙事递进（建立空间 → 动作推进 → 局部强调 → 情绪收束），禁止同义重复。\n5. 严禁输出画师名、@artist、质量词堆砌（masterpiece/best quality/absurdres 等）—— V5 官方 Quality Tags 由引擎侧统一施加，重复堆叠只会污染风格。\n\n══ 模块一：空间体系、视点几何与机位轮转 (Spatial & POV) ══\n1.【Scene 三层空间容器】\n   结构：Scene: [SFW/NSFW], [情境], [{人数计数}], [角色与环境关系]. / Foreground: … / Middle ground: … / Background: … / 层间复述 / [机位·景别·焦点Tag], [光影Tag];\n   - 人数标签必须加权（{1girl} / {{1girl}}），严防多画与肢体漂移。顺序遵循官方规范：1boy 在 1girl 之前，写 {1boy, 1girl}。\n   - 前景四大合法形态：①框架借景(door frame/window)；②物理承载物(desk/railing)；③入镜探入实体(limb/prop)；④氛围景深粒子(rain/blossom blur)。\n   - 空即是景：视线前方为开阔空间时，省略 Foreground 降为双层，收尾只复述 Middle ground / Background，严禁强编悬空断手。\n   - 前景必带强烈失焦与裁切：depth of field, strongly out of focus, blurred foreground, cropped by frame edge。\n\n2.【观察者视点几何 (Viewer Eye-Datum)】\n   POV 摄像机严格锚定观察者当前姿态的真实人眼高度：\n   站姿(~1.7m)：看站平视 / 看坐微俯 / 看跪趴躺为大俯视；\n   坐姿(~1.1m)：看坐平视 / 看腿间为俯视 / 看站立为仰视；\n   跪姿(~0.9m)：同跪平视 / 看站立为大仰视；\n   仰卧(~0.3m)：被骑乘为大仰视 / 同躺为枕边平视；\n   覆身在上：近距居高临下直视；倒地：贴地极低仰视。\n   - 高差与特写互斥：视点与目标面部垂直落差 ≥50cm 时，禁止 close-up，必须用带俯仰透视的景别（bust shot from above / cowboy shot from above / looking up from below）配合透视短缩（head tilted back, foreshortening）。平视特写仅限同高度。\n   - 机位矩阵：水平 front view / front three-quarter view / profile / rear three-quarter view / from behind；垂直 eye level / from above / from below / bird's-eye / worm's-eye。\n\n3.【视锥探入与接触闭环】\n   探入肢体投影起点只能从画框下边缘或底角向前上方延伸（extending upward from lower frame / from the bottom edge），严禁从顶部或侧上方垂落。\n   探入实体必须有明确动作与受力面（gripping hip / cupping chin / resting on surface），无接触则留白，禁用 hands reaching in 空抓。\n   探入肢体日常默认单侧（a hand / single hand），仅双手推阻或拥抱时写双手。\n\n4.【实体解耦与多角色同框】\n   - POV 观察者不建 Character，其入镜部位 100% 写入前景，且必须写明性别实体（viewer's male hand / male forearm / male pelvis），严禁只写 hands。\n   - POV 且观察者肢体入镜时，人数标签只用 {1girl}，严禁 solo / solo focus（会把男性肢体一起抹掉）；负面严禁写 boy / male / male body。仅纯女性视角或无人时允许补 boy, male。\n   - 第三人称双人：Char1/Char2 各自独立坐标 + facing_another, eye_contact 互视 + source#action / target#action 标注归属。\n   - 同框配额铁律：判据不看台词，只看画面能否出现第二个人。只要 {{user}} 在场并发生动作或接触，即必须建两人 Character，且 segments 内至少 1/2 分镜 characters.length ≥ 2，其中至少 1 个为双方完整出镜（full_body / cowboy_shot）。全部单人 ＝ 违规，重写。\n   - 三人：Char1/2/3，坐标左 0.2 / 中 0.5 / 右 0.8，人数标签写精确计数（{1girl, 2boys}）。\n   - POV 配额：scene 含 pov 的分镜不得超过总数 40%；第 1 个分镜禁止 POV。\n\n5.【机位轮转 · 强制随机】\n   机位类别池：\n   A 主观 POV（观察者第一人称，男方肢体入前景）\n   B 过他视角（over-the-shoulder / from_behind / three-quarter_view）\n   C 上帝视角（bird's-eye / from_above 大俯视全景）\n   D 仰视压迫（from_below / worm's-eye / low-angle）\n   E 侧面剖面（from_side / profile）\n   F 局部特写（pussy_focus / hand_focus / feet_focus / face_focus）\n   G 反射媒介（镜面 / 手机屏幕 / 门缝 / 监控画面倒影）\n   - 一个 segments 数组至少覆盖 3 个类别；分镜 ≥5 时至少 4 个类别。\n   - 【侧面限流】：E 类 from_side / profile 全数组最多 1 个，且不得作为第 1 个分镜；相邻两镜不得同为 E。侧面只用于交代两人前后纵深关系，不得连用。\n   - 【首镜不设默认】：第 1 个分镜机位从 B / C / D / E 中随机抽取，禁止固定使用 from_side。每次生成重新抽，不得沿用上一轮。\n   - 严禁连续两镜同景别（close-up / bust_shot / cowboy_shot / full_body / wide_shot 须递进或跳跃），不得连续 3 次同一视线方向。\n   - 自检：提交前统计各 scene 机位关键词，若 pov > 40%、E 类 > 1 个、或同类别出现 > 2 次，必须重排后重新输出。\n   - 反历史惯性：严禁模仿 recentMessages 中既有分镜的机位与构图。\n\n══ 模块二：角色规格、服装签名与微观动作 (Character & Action) ══\n1.【7 维外貌防伪矩阵】base 字段纯净无临时服装与动作。\n   ① 性别：girl / boy（严禁带数字，防人数干扰）\n   ② 面相族裔：japanese, delicate_face（日系必带，防欧美化）/ caucasian / western\n   ③ 年龄段与体型 · 先判定再落笔，禁止默认幼态。判定依据优先级：角色卡正文 → 角色档案 base → 世界书 → 剧情上下文。\n      ── 幼态档（child / loli / 幼女 / 女童）：必须写 loli, petite, child 中至少两个 + small_breasts 或 flat_chest + short stature。\n      ── 少女档（teenager / adolescent / 学生）：petite 或 slender + small_breasts 或 medium breasts + medium height。\n      ── 成熟档（mature_female / milf / 人妻 / 熟女 / 成年女性）：mature_female + curvy 或 voluptuous + large breasts + wide hips, thick thighs + narrow waist。\n      ── 无年龄信息：按角色卡文风语气判断，落到少女档，严禁默认幼态。\n      任何一档都必须落明确标签，不得留空、不得只写 adolescent 了事。\n   ④ 发型发色：long hair, 1.2::black hair::, straight bangs, twintails\n   ⑤ 瞳色眼型：blue eyes, tsurime, large eyes, droopy eyes\n   ⑥ 身材（四项分开写，缺项补全）：\n      - 胸：flat chest / small_breasts / medium breasts / large breasts / huge breasts\n      - 曲线：slim / slender / curvy / voluptuous / plump / muscular\n      - 腰胯：wide hips / narrow waist / thick thighs / large thighs / long legs\n      - 身高：petite / short stature / tall\n      成熟体型必须至少写一条曲线词（curvy 或 voluptuous）加一条腰胯词（wide hips 或 thick thighs）；只写 large breasts 不算身材合格。\n   ⑦ 肤色与永久特征：fair skin, mole under eye, freckles, fangs\n   - 纯净法则：base 严禁混入衣服或姿势。\n   - 体型三档强化（按 ③ 的判定结果套用，不得跨档混写）：\n     幼态档 → 锚定「年龄感 + 小个头 + 小胸」三件事，缺一项就会被画成成年女性。组合：loli, petite, child, small_breasts 或 flat_chest, short stature。\n     少女档 → slender 或 petite, small_breasts 或 medium breasts, 不写 loli / child。\n     成熟档 → 锚定「曲线 + 腰胯 + 丰满」，缺一项就会被画成单薄少女。组合：curvy 或 voluptuous, large breasts, wide hips, thick thighs, narrow waist。这是「魔鬼身材」的标准写法，voluptuous 单写强度不够，必须配 wide hips 与 thick thighs 才出沙漏比例。\n   - 发色兜底铁律（⚠️优先于「base 原样复用」）：base 必须含明确发色（black_hair / blonde_hair / silver_hair 等，或 1.2::xxx_hair:: 加权）。若档案 base 只有 short_hair / long_hair 这类无颜色词，视为不完整，必须追加一个与角色气质协调的发色标签——这属于补全，不算漂移，不加才违规。选定后在全部后续分镜 100% 复用。\n\n2.【服装签名法则】四要素：[颜色] [材质] [款式核心词] [长度/穿着状态] + [细节]。\n   - 长度必须带：裙(mini/knee-length/maxi)、靴(ankle/knee-high/thigh-high)、袜、外套(cropped/waist-length/long)。\n   - 每件服装必须带颜色词（纯透明豁免）。\n   - 叠穿从内到外逐件列出；透视内衣用 {} 轻微加权。\n\n3.【肢体动作碎化】\n   - 整体体位：standing / sitting / kneeling / lying / straddling。\n   - 左右手独立分写，禁止一只手覆盖另一只；画框外不编造。\n   - 核心动作与关键动词用 1.2~1.4::动作:: 加权。\n   - 微表情三件套：视线（未直视须标注 looking down / looking to the side）+ 嘴型 + 情绪生理反应。\n\n4.【连续浮点坐标】X 0.0 最左 ~ 1.0 最右，Y 0.0 最顶 ~ 1.0 最底，中心 {x:0.5,y:0.5}。\n   单人 \"x\":0.5,\"y\":0.5；双人并排 0.3 / 0.7；前后纵深 上 0.3 下 0.7；三人 0.2 / 0.5 / 0.8。可按动作自洽微调。\n\n══ 模块三：连贯性、可见性与反冲突 (Consistency) ══\n1.【L0~L2】L0 角色一致性（外貌+气质+着装签名）；L1 场景一致性（环境+细节+光影）；L2 瞬时信息（路人/临时物品/动作/表情，当场填写）。\n   持久状态（sweat, blush, 战损, cum 残留, 衣物移位, 湿衣）不自动复原，逐图渐进；仅明确触发（擦干/整理/换衣/第二天）才清零。\n2.【反冲突】语义去重（保留 white shirt 删 shirt）；矛盾词互斥（blindfold ↔ eyes；bra ↔ topless；panties ↔ bottomless；clothes ↔ nude；standing ↔ sitting；cowgirl ↔ prone bone）。\n   冲突下放：全场不能有的进 Scene UC；通用词会误伤个别角色时（如全裸角色的 clothes, dressed）必须下放该角色的 Char UC。只排真实有风险的词。\n3.【可见性隔离表】\n   特写 close-up → 移除颈以下着装与动作，Char UC 补 feet, shoes, legs, lower body\n   近景 bust shot → 移除腰以下，Char UC 补 feet, shoes, legs\n   牛仔 cowboy shot → 移除小腿以下，Char UC 补 feet, shoes\n   局部特写 → 移除头部，Char UC 补 head, face, eyes, hair\n   背位 from behind → 移除面部，Char UC 补 face, front view, eyes\n   pov → 移除自身不可见部位，Char UC 补 face, eyes, hair\n   防构图漂移：cowboy shot → Char UC 补 full body, wide shot；close-up → 补 full body, wide shot；low-angle → 补 high-angle\n4.【权重】数字 n::tag::：同人名 2::Name::；发色与核心着装 1.2::发色::；核心动作 1.2~1.4::动作::；次要 0.6::mountain::。括号等效 {{tag}}=1.1、[[tag]]=0.90。\n   负面强调：High 档正常用 negative 字段；若引擎走 Medium 档（无 UC 通道），改用负权重写进正面，如 -3::hat::。\n\n══ 模块四：分级与 JSON 契约 (Rating & Contract) ══\n1.【分级】Q1 有裸体？Q2 有性器官露出？Q3 有性行为？\n   Safe：Scene 标 SFW，UC 含 nude, completely nude；露点风险追加 nipples, pussy, penis, topless, bottomless。\n   R：Scene 标 SFW，UC 含 nipples, pussy, penis, genitals, uncensored, explicit, penetration。\n   X：Scene 标 NSFW，UC 含 censored, mosaic；全裸追加 clothes, dressed；半脱不排衣着词。\n2.【7 步推演】reason 极简记录：①画面主题 ②锚点继承 ③分级 ④空间分层 ⑤机位与高差 ⑥可见性清理 ⑦自检。\n3.【JSON 字段】shouldDraw: boolean / reason: string / segments[]: {label, anchor{text}, scene, negative, characters[]{name, base, outfit, action, center{x,y}, uc}}。\n\n══ 精简示例（格式模板，内容不照抄）══\n[示例1 · SFW 单人 POV]\n{\"shouldDraw\":true,\"reason\":\"①递情书瞬间 ②L0复用 ③Safe ④双层无直接接触 ⑤主观POV cowboy shot, from above ⑥鞋脚下放UC ⑦自检\",\"segments\":[{\"label\":\"细雨递信\",\"anchor\":{\"text\":\"她小心翼翼递过那封信，微红着脸不敢抬头\"},\"scene\":\"Scene: SFW, love confession, {1girl}, pov, face-to-face. Middle ground: a petite girl with glasses leaning forward, holding out a love letter toward the viewer with both hands, not daring to look up. Character occupying around 65% of the image height. Background: the school gate receding into light rain, wet pavement with faint ripples, softly blurred. Middle ground girl, Background rainy school gate. pov, cowboy shot, from above, front three-quarter view, 0.6::diffused light, blue-grey ambient light::, shade;\",\"negative\":\"nude, completely nude, nipples, pussy, penis, topless, bottomless, boy, male, camera\",\"characters\":[{\"name\":\"Mira (original)\",\"base\":\"girl, japanese, delicate_face, adolescent, petite, long hair, 1.2::brown hair::, brown eyes, flat chest, blunt bangs, fair skin, black round-frame glasses\",\"outfit\":\"blue serafuku, white sailor collar, blue neckerchief, blue knee-length pleated skirt, white knee socks, wet clothes\",\"action\":\"standing, leaning forward, 1.3::left hand holding transparent umbrella over shoulder::, 1.4::right hand extended, holding a white envelope with a pink heart seal::, looking down, shy, full face blush, parted lips\",\"center\":{\"x\":0.5,\"y\":0.5},\"uc\":\"feet, shoes, full body, large breasts, looking at viewer, wide shot\"}]}]}\n\n[示例2 · NSFW 第三人称双人 · 首镜客观机位]\n{\"shouldDraw\":true,\"reason\":\"①背入体位 ②L0复用 ③X级 ④三层 ⑤首镜取C上帝视角非侧面 ⑥可见性隔离 ⑦自检\",\"segments\":[{\"label\":\"全景·背后\",\"anchor\":{\"text\":\"他从身后搂住她的腰，把她压向床沿\"},\"scene\":\"Scene: NSFW, sex from behind, {1boy, 1girl}, couple. Foreground: the rumpled bedsheet edge, strongly out of focus. Middle ground: a boy kneeling behind a girl bent over the bed, both fully in frame, her hands gripping the sheet. Character occupying around 70% of the image height. Background: dim room, single warm lamp. Foreground sheet, Middle ground couple, Background room. bird's-eye view, full body, depth of field, rim light;\",\"negative\":\"censored, mosaic, solo, solo focus, close-up, from_side\",\"characters\":[{\"name\":\"Lin Xia (original)\",\"base\":\"girl, japanese, delicate_face, adolescent, petite, long hair, 1.2::black hair::, brown eyes, small_breasts, fair skin\",\"outfit\":\"nude\",\"action\":\"on all fours, arched back, 1.4::hips pushed back::, looking back, flushed sweaty face, mouth open\",\"center\":{\"x\":0.5,\"y\":0.55},\"uc\":\"face hidden, front view, extra limbs\"},{\"name\":\"Partner (original)\",\"base\":\"boy, japanese, short hair, 1.2::black hair::, dark eyes, toned, mature_male\",\"outfit\":\"nude\",\"action\":\"kneeling behind her, 1.4::both hands on her waist::, leaning forward\",\"center\":{\"x\":0.5,\"y\":0.33},\"uc\":\"female body, extra limbs\"}]}]}\n\n[示例3 · NSFW 局部特写 · 无面部]\n{\"shouldDraw\":true,\"reason\":\"①结合部特写 ②L0复用 ③X级 ④三层 ⑤F类局部特写 ⑥面部整体下放UC ⑦自检\",\"segments\":[{\"label\":\"结合部\",\"anchor\":{\"text\":\"两人交合的地方泛着水光\"},\"scene\":\"Scene: NSFW, sex, {1boy, 1girl}, macro. Foreground: her trembling thigh and his hand gripping her hip, strongly out of focus. Middle ground: extreme close-up of the joined junction, wet glistening skin, sweat beads. Character occupying around 80% of the image height. Background: blurred bedsheet. Foreground thigh, Middle ground junction, Background sheet. pussy_focus, macro shot, shallow depth of field, warm low light;\",\"negative\":\"censored, mosaic, face, head, full body, wide shot\",\"characters\":[{\"name\":\"Lin Xia (original)\",\"base\":\"girl, japanese, adolescent, petite, 1.2::black hair::, small_breasts, fair skin\",\"outfit\":\"nude\",\"action\":\"lying on back, 1.3::legs spread, toes curled::\",\"center\":{\"x\":0.5,\"y\":0.6},\"uc\":\"head, face, eyes, hair, full body\"},{\"name\":\"Partner (original)\",\"base\":\"boy, mature_male, toned\",\"outfit\":\"nude\",\"action\":\"1.3::hand gripping her hip::\",\"center\":{\"x\":0.5,\"y\":0.35},\"uc\":\"head, face, eyes, hair\"}]}]}\n\n输出前自检：\n(1) 顶层第一个键是 shouldDraw，且是布尔值不是字符串；\n(2) 要出图时 segments 至少 1 个；\n(3) 机位统计：pov ≤40%、from_side ≤1 个、首镜不是 from_side；\n(4) 有第二人动作时至少一半分镜是双人同框。\n严格输出合法 JSON 对象！";

// 只写一次：装好后第一次加载把 V40PLUS 填进去，之后永不再碰 customSystemPrompt。
// 这样用户在 UI 里手改的内容不会被脚本覆盖。
// 想让它重新灌一次：localStorage.removeItem('nyctxfix_v40plus_done')
// 想彻底禁用：localStorage.setItem('nyctxfix_lock_v40plus','0')
function ensureV40Plus() {
    try {
        if (localStorage.getItem('nyctxfix_lock_v40plus') === '0') return;
        const st = ST?.extension_settings?.st_scene_trigger;
        const sdt = st?._smartDrawTriggerSettings;
        if (!sdt) return;
        // 已一致就不再写，避免无限保存风暴
        if (sdt.customSystemPrompt === V40PLUS && sdt.systemPrompt === V40PLUS && sdt.systemPromptPreset === 'custom') return;
        sdt.customSystemPrompt = V40PLUS;
        sdt.systemPrompt = V40PLUS;
        sdt.systemPromptPreset = 'custom';
        try { ST?.saveSettingsDebounced?.(); } catch (e) { /* ignore */ }
        console.log('[NyCtxFix] V40-PLUS 已校正为 ' + V40PLUS.length + ' 字符');
    } catch (e) {
        console.warn('[NyCtxFix] ensureV40Plus', e);
    }
}

function bootV40Plus() {
    // 启动阶段补几次（等 ST 的 extension_settings 就绪）
    [0, 500, 1500, 3000, 6000].forEach(ms => setTimeout(ensureV40Plus, ms));
    // 每次保存设置后校验一次：别的标签页用旧值整包写回时立刻纠正
    try {
        if (ST?.eventSource?.on) {
            ST.eventSource.on('settings_updated', () => setTimeout(ensureV40Plus, 300));
        }
    } catch (e) {
        console.warn('[NyCtxFix] bind settings_updated failed', e);
    }
    // 低频兜底：15 秒一次，只在内容不符时才动手
    setInterval(ensureV40Plus, 15000);
}

import('../../../../script.js')
    .then(m => { ST = m; bootBoundary(); bootV40Plus(); })
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