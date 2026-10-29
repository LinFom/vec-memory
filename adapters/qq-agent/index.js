import { createProtocolBridge, scopeOf } from './protocol-v1.mjs';
import { randomUUID } from 'node:crypto';
// memory-vec — QQ-Agent 适配层入口（**新树 `refactor/` 版** · 0.27.0）
//
// ── 这一层是什么 ───────────────────────────────────────────────────────────
// 一个**薄适配层**：不含任何向量库代码，只持有一个地址（设置里的 `serviceBaseURL`，
// 默认 `http://127.0.0.1:8088`）。数据面是外接的独立服务（vec-memory 仓），库数据归仓。
// 服务没起/超时/关闭 ⇒ 注入与检索一律静默跳过，绝不影响回复。
//
// ── 0.27.0：从「整合版」搬到「新树 refactor/」，三个实质变化 ─────────────────
//
// ① **零宿主 import**（这条最要紧）
//    旧版靠 `import { getConfig } from '../../src/config.js'` 与
//    `import { isSkillEnabledInConfig } from '../../src/skills/config.js'` 读配置。
//    新树的配置在 `refactor/core/config-store/`、技能开关在
//    `refactor/modules/extensions/skills/` —— 插件去摸这些内部文件，等于把宿主
//    目录结构写成硬依赖（宿主一重构就 `ERR_MODULE_NOT_FOUND`，而且报错发生在
//    **加载期**：整个插件带工具一起消失）。
//    ⇒ 改为 setup(api) 时捕获宿主的**契约出口** `api.config()`
//      （`modules/extensions/plugin-loader.js` 的 `config: () => skillManager.settingsOf(id)`；
//       它已经把 plugin.json 的 `settings` 默认值与 `<dataDir>/config.json` 里的
//       `skills['memory-vec']` 合并好）。
//    额外收益：去掉宿主 import 之后**本文件能在裸 node 里直接 import** ⇒
//    `selftest.mjs` 可以真跑钩子（喂合成 messages、断言注入位置），不用起宿主。
//    ⚠️ 「插件是否启用」不再由本文件判断：新树 `skillManager.isActive()` 先查
//      isLoaded/isEnabled 再看 available()（`skills/manager.js:207-218`）。旧版
//      `available()` 里那句 `isSkillEnabledInConfig` 在新树是**第二道闸**，
//      留着只会让"停用"出现两种口径 ⇒ 已删除，available() 只回答"插件自己"。
//
// ② **钩子载荷换了形状**（这次适配的核心，逐条写清；旧载荷 → 新载荷）
//    · `before-context`：`{ triggerEntries, chatKey, kind, senderId, evidence }`
//      （调用点 `modules/orchestrator/index.js:4084`）。
//      `triggerEntries` 现在是 **MessageEvidence**（`contracts/index.js:151`），
//      说话人在 `sender:{id,name}`，**不再有** `senderId`/`senderName`
//      ⇒ 本文件用 `personOf()` 两种都认（老钩子载荷仍可跑，便于对照）。
//      另外它拿不到 `session`：旧版用 `session.id` 当 pendingTrigger 的键（同群
//      并发多轮要分开），新树**同群互斥**（`refactor/README.md` §3.8）⇒ 用 chatKey。
//    · `before-llm-messages`：`{ messages, chatKey, kind, plan, evidenceId }`
//      （调用点 `modules/orchestrator/compose.js:3803`，**每轮**都调，所以要幂等）。
//      仍然递的是**真数组**（`messages`），可就地改 —— 这是注入的落点。
//      **没有 session** ⇒ 旧版那句 `syncSessionRecord()`（把注入后的 messages 回写
//      会话存档，好让控制台看见真正发出去的那份）在新树里**不需要也不该做**：
//      新树在 llm 调用边界上有一层 `apps/server/ui-preview.js`，它抄的就是钩子改完
//      之后的入参（装配在 `apps/server/assembly.js:1598`）。再写一份 = 两个真相源。
//    · `after-tool`：`{ toolName, result, chatKey, evidenceId, ... }`
//      （调用点 `compose.js:4563`）。`result` 的形状也变了：M10 的行是
//      `{ ok, state, error, data }`，**没有 `isError`** ⇒ 诊断里两种都读。
//
// ③ **写侧检查点按"轮"计数改用 `evidenceId` 判重**
//    旧版靠「末条 role === 'user'」判轮首。新树的 compose 在**同一轮内**还会往
//    末尾追加收尾轮（`compose.js:3736` 的 queueCloseout）与末三轮提醒
//    （`compose.js:3786`）—— 它们的末条也是 user ⇒ 旧判据会把一轮数成两三轮，
//    节律整个偏快。新钩子给了 `evidenceId`（compose 的入参，一轮内恒定，
//    `orchestrator/index.js:4680` 的 `evidenceId: primary.id`）⇒ 同一 evidenceId
//    只计一次；没有 evidenceId 时才退回旧判据（防御，不指望走到）。
//
// ── 不变的部分（照搬，别动）────────────────────────────────────────────────
//   ① 两个模型可调工具：写侧 `remember`（0.12.0）、读侧 `search`（0.13.0）；
//   ② 报告自身可用性；`providers` 占位（让"插件没提供任何 providers/hooks"的告警闭嘴）；
//   ③ `before-context` 收本轮触发批（在场的人 + 话题）→ `before-llm-messages` 注入
//      人格属性句（M2，ADR-0009）；
//   ④ 服务缺席时写侧 outbox 暂存 + 自动拉起数据面服务 + 记忆检查点节律。
//   ⑤ （0.28.0 新增）**「记人」常驻节**：每轮往最后一条 user 尾部追加一节行为指令
//      （该记什么 / 节律 / 怎么查），对齐老 `memory_append` 在宿主人设里的专属节
//      （`refactor/core/config-store/personas.js:193-196`）。为什么加：实测号B
//      1504 次 offered 只换来 5 次调用，新工具在 personas.js 里 0 提及、只在 schema
//      裸奔；0.27.0 的自诊（921-923 行）指明"guide 埋在 system 深处够不着"。
//      独立哨兵 `<!--mv-guide-->`（不能借 `<!--mv-inject-->`：读侧先跑已带该哨兵，
//      借用会让本节永远判重）。服务挂掉也照加（纯本地文本，不依赖数据面）。
//
// ── 为什么 available() 不去探测 8088 ──────────────────────────────────────
// 宿主是**同步**调用这个函数的（`skillManager.isAvailable()` 没有 await），而探测要
// 走网络 ⇒ 同步做不到，硬做只能引入"过期缓存"这种会骗人的状态。职责切开：
// 本函数只说"**插件自己**能不能用"；服务在不在由面板自己判断并给出可操作提示
// （`settings-ui.js` 的 `req()`）。这就是"服务缺席 ⇒ 优雅降级"的落点。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const PLUGIN_ID = 'memory-vec';
/** 插件目录（`<ROOT>/plugins/memory-vec`）。 */
// ⚠️ 必须走 `fileURLToPath`：本仓路径含中文，`new URL(x).pathname` 会把它
//    percent-encode 成 `%E6%95%B4...`，据此拼出的目录**根本不存在**（实测踩过）。
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * 配置读取器。**由 setup(api) 注入**（见文件头 ①）。
 *
 * 为什么不写成 `const readConfig = api.config`：模块级 `hooks` 是**模块导出**，
 * 拿不到 setup 的入参 ⇒ 只能在这里留一个可被 setup 替换的间接层。
 * 默认返回空对象 = "宿主还没接上" ⇒ 各开关走代码里的默认值（注入开、检查点开），
 * 与旧版 `getConfig()` 读不到时的行为一致。
 */
let configReader = () => ({});
function mvCfg() {
  try {
    const v = configReader();
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

let v1Bridge = null;
let v1Timer = null;
let v1Store = null;
function protocolV1() { return mvCfg().protocolV1 === true; }
export const providers = {
  'memory.vec': () => ({
    ok: true,
    sync: v1Bridge?.status() ?? null,
    hint: '向量记忆库：面板在「设置 → 向量记忆库」。数据面是外接的独立服务'
      + '（从 vec-memory 仓的「启动-向量记忆库服务.bat」启动，地址见设置里的 serviceBaseURL）。'
      + '服务没起时面板会提示，不会显示空表。'
  })
};

export function available() {
  // 刻意不在这里探测服务（宿主是同步调用，见文件头）。
  // 「插件是否停用」也不在这里判 —— 新树 `isActive()` 已经查过 config.skills[id].enabled。
  return { ok: true, reason: '' };
}

// ── 小工具 ────────────────────────────────────────────────────────────────
/** 块时间戳 → 可读。实测服务端 `meta.when` 是毫秒数；老的块可能是已格式化字符串。 */
function fmtWhen(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1e12) return s; // 不是"毫秒时刻"就原样用
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return s;
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 会话键 → 只留类型。块文本里的真名/QQ 早已被服务端换成占位符（`〔P7129〕`），
 * 所以这里只负责把 `private:1353446252` 这种**裸会话键**收成「私聊/群」——
 * 模型需要的是"这条记忆是在哪儿说的"，不是原样复读一串 ID。
 */
function shortChatKey(v) {
  const s = String(v ?? '').trim();
  if (s.startsWith('private:')) return '私聊';
  if (s.startsWith('group:')) return '群';
  return s;
}

function baseURLOf(cfg) {
  return String(cfg?.serviceBaseURL || 'http://127.0.0.1:8088').replace(/\/+$/, '');
}

export function setup(api) {
  if (!api || typeof api.registerTool !== 'function') return;

  // ★ 记忆库页签（2026-10-23）：往宿主顶部栏挂一个「记忆库」独立页面（nav.page 插槽）。
  //   页面本体 = vec-memory 仓 `web/memory.html`（iframe 嵌入，见 memory-page.js）；
  //   服务地址由那个页面自己管（同源 fetch /api/vec/*），这里只声明"我要一页"。
  //   宿主不在线 / 旧版宿主没有 registerView ⇒ 静默跳过，插件其余功能照常。
  if (typeof api.registerView === 'function') {
    const okView = api.registerView({
      slot: 'nav.page',
      id: 'memory-page',
      file: 'memory-page.js',
      title: '记忆库',
      order: 10
    });
    if (!okView) diag({ at: 'setup-register-view-rejected', note: 'registerView 返回 false（参数/上限），页签未挂' });
  } else {
    diag({ at: 'setup-no-register-view', note: '宿主无 api.registerView，记忆库页签不可用' });
  }

  // ★ 唯一的"接上宿主"的动作（见文件头 ①）：配置走契约出口，不摸宿主内部路径。
  if (typeof api.config === 'function') {
    configReader = () => api.config();
    // 立刻试读一次：配置读不通时**留痕**，而不是等到某一轮注入莫名不出块。
    try {
      const cfg = api.config();
      diag({
        at: 'setup', pluginId: PLUGIN_ID, keys: Object.keys(cfg || {}).length,
        serviceBaseURL: String(cfg?.serviceBaseURL || ''), injectEnabled: cfg?.injectEnabled !== false
      });
    } catch (error) {
      diag({ at: 'setup-config-err', err: String(error?.message || error) });
    }
  } else {
    diag({ at: 'setup-no-config-api', note: '宿主未提供 api.config()，插件走代码默认值' });
  }

  /** 写侧超时（见下面纪律第 2 条）。 */
  const WRITE_TIMEOUT_MS = 8000;
  /** 读侧超时：要现算查询向量（一次嵌入往返）+ 全库余弦，给够但别无限等。 */
  const SEARCH_TIMEOUT_MS = 8000;

  // ── 写侧：memory-vec__remember（记事实）──────────────────────────────────
  //
  // 由来（用户 2026-10-12 拍板）：要「AI 得到短期内能下结论的事实印象后调用工具、直接
  // 进向量库」，用来**取代**宿主原版的 `memory_append`（对某人的长期印象，写 people/*.json、
  // 不向量化）。取舍是「**只提供新工具，旧工具由谁在工具页面停用**」—— 本插件不改它的实现、
  // 也不动核心，只在工具注册表里多出这一条。
  //
  // 新树里这条"停用"是 `api.tools` 白名单做的：`act.getToolAvailability()`
  // （`modules/act/index.js:982`）对**内置**工具生效、对**技能工具豁免**
  // （`!tool.skillId` 才拦）⇒ 本工具随插件启用/停用自动上线/下线，
  // **不需要**去「工具」页面勾选；那一页写的是 `api.tools`，对技能工具**无效**。
  //
  // 三个必须与读侧（注入钩子）区分开的纪律：
  //   · **写路径不许静默**。读失败顶多少一段背景，静默是对的；写失败而静默 = 模型以为
  //     记住了、实际没有，而且**再没有任何地方会提起这件事**。所以每个失败都 `isError: true`
  //     并带回可行动的原因（服务没起 / 认不出 QQ 号 / 库只读 / 归一化后为空）。
  //   · **超时比读侧宽**：注入 2.5s（热路径，宁可跳过）；写 8s（用户看得见的一次动作，
  //     服务侧还要跑归一化 + 落盘 + 重建索引）。
  //   · **返回永不为空**：宿主把工具结果塞进下一条请求，空串会让那次请求 400、那一轮
  //     静默死掉（与宿主既有工具同一条约束）。
  api.registerTool({
    id: 'remember',                       // 注册后模型看到的是 memory-vec__remember
    name: '记事实',
    description: '记一条关于某个群友的稳定印象 —— 以后相关话题出现时会自动参考（不主动提起）。'
      + '该记：对方自述的固定信息（职业/年龄/所在地/宠物/忌口…）、喜好口味、雷点禁忌、'
      + '说话风格与性格、身份关系、长期约定、反复玩的梗。'
      + '不记：一次性的闲聊、当下的情绪、刚发生的琐事 —— 那些本来就在上下文里。'
      + 'userId 必须是对方的 QQ 号。trait 按属性（attr）并存、speaker_profile 按方面（aspect）并存；'
      + '其余 kind 同一人只留最新一条。',
    category: 'memory',
    icon: '🧠',
    parameters: {
      type: 'object',
      properties: {
        userId: {
          type: ['integer', 'string'],
          description: '**必填**：这条印象关于谁 —— 对方 QQ 号（聊天行「名字(QQ数字)」里的数字）。别只传昵称'
        },
        text: {
          type: 'string',
          description: '一句话，≤80 字。例：喜欢买断制单机、讨厌多人竞技类'
        },
        kind: {
          type: 'string',
          enum: ['trait', 'speaker_profile', 'preference', 'grudge', 'event', 'topic', 'promise', 'joke'],
          description: '默认 preference。trait=固定档案（必须同时给 attr）；speaker_profile=这人是什么样的人'
            + '（风格/性格）；preference=喜好口味；grudge=雷点禁忌；event=关系里的一次具体事件；'
            + 'topic=长期在聊什么；promise=答应过或必须做到的事；joke=反复玩的梗或黑话'
        },
        attr: {
          type: 'string',
          description: '**kind=trait 时必填**：属性名，text 就是它的值。单值属性（年龄/职业/性取向/所在地/'
            + '生日/学历/身高/婚恋）新的覆盖旧的；多值属性（爱好/忌口/语言/技能/宠物/常玩游戏）往后累加。'
            + '不在名单里也能记，近义说法会自动归并（"工作"→职业）'
        },
        aspect: {
          type: 'string',
          description: 'kind=speaker_profile 时可选：这条印象是他**哪一面** —— 说话风格 / 性格脾气 / '
            + '与人相处 / 对某个人的态度 / 在群里的角色。不同方面并存、同一方面覆盖；不填 = 整体'
        },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：支撑这条的消息 id（prompt 里每条消息前的 #数字），可给多个。留空可信度按 0 条算'
        }
      },
      required: ['userId', 'text']
    },

    async execute(ctx, args) {
      if(protocolV1())return toolV1('remember',ctx,args);
      // 暂存队列要用的请求体。⚠️ **必须声明在 try 之外**：网络失败走的是 `catch`，
      // 而 `catch {}` 与 `try {}` 是两个**块作用域** —— try 里 `const` 的东西在
      // catch 里不可见（实测：ReferenceError: payloadReq is not defined，
      // 且只在"服务不在"这条路上炸 ⇒ 恰好把最该工作的那条路打坏）。
      let payloadReq = null;
      try {
        // ① 会话：scope 由它派生（"在哪儿说的"是身份的一部分），缺了不能写。
        const chatKey = String(ctx?.chatKey ?? '').trim();
        if (!chatKey) {
          return { content: '没记住：这次唤醒没有会话标识（chatKey），事实的「在哪儿说的」是身份的一部分，缺了不能写。', isError: true };
        }

        // ② 人：QQ 号必填（负值取绝对值，与宿主 memory_append 同口径兼容）。
        const rawId = String(args?.userId ?? '').trim().replace(/^["']|["']$/g, '');
        let uid = rawId;
        if (/^-?\d{5,15}$/.test(rawId)) uid = String(Math.abs(Number(rawId)));
        if (!/^\d{5,15}$/.test(uid)) {
          return {
            content: `没记住：userId 必须是对方 QQ 号（收到 ${JSON.stringify(rawId)}）。`
              + '从聊天行「名字(QQ数字)」里抄数字 —— 只给昵称以后会对不上人。',
            isError: true
          };
        }

        // ③ 正文。
        const text = String(args?.text ?? '').trim();
        if (!text) return { content: '没记住：text 不能为空。', isError: true };

        const base = baseURLOf(mvCfg());
        payloadReq = { deliveryId: randomUUID(), chatKey, userId: uid, text };
        if (args?.kind) payloadReq.kind = String(args.kind);
        if (args?.attr) payloadReq.attr = String(args.attr);
        if (args?.aspect) payloadReq.aspect = String(args.aspect);
        if (Array.isArray(args?.evidence) && args.evidence.length) {
          payloadReq.evidence = args.evidence.map((x) => String(x)).filter(Boolean);
        }

        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), WRITE_TIMEOUT_MS);
        let r;
        let payload = null;
        try {
          r = await fetch(`${base}/api/vec/remember`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payloadReq),
            signal: ac.signal
          });
          payload = await r.json().catch(() => null);
        } finally {
          clearTimeout(timer);
        }

        if (!r.ok || !payload?.ok) {
          const why = payload?.error || payload?.reason || `HTTP ${r.status}`;
          // 4xx = 语义拒绝（认不出 QQ 号 / kind 非法 / 库只读 / 归一化后为空）：
          // 这些**重试多少次都一样** ⇒ 不入队（入了就是队头阻塞）。
          if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
            return { content: `没记住：${why}`, isError: true };
          }
          // 5xx / 服务自身异常 ⇒ 先存下来，等服务恢复自动补记。
          const n = outboxPark(payloadReq, why);
          if (n < 0) return { content: `没记住：${why}；补发队列也未能保存，请稍后重试。`, isError: true };
          return {
            content: `没记住：${why}（已**暂存**，服务恢复后会自动补记；当前队列 ${n} 条）`,
            isError: true
          };
        }

        const k = payload.kind || 'preference';
        if (payload.action === 'noop') {
          return { content: `这条已经记过了（同一人同一类的同一条，没有重复写）。` };
        }
        // 多值槽（trait 按属性 / speaker_profile 按方面）：只有**这一项**被更新，其它项不受影响。
        // 措辞必须与"整条替换"区分开，否则模型会以为把这个人别的方面也顶掉了
        // （描述与实现不一致 = 静默失败）。服务端从 0.30.0 起回 `itemKey`。
        const itemLabel = payload.itemKey
          ? `${k === 'trait' ? '档案' : '印象'}·${payload.itemKey}`
          : '';
        if (itemLabel && payload.previous?.text) {
          return {
            content: `记下了【${itemLabel}】${payload.text}`
              + `（这一项原来的值「${String(payload.previous.text).slice(0, 40)}」已更新 —— `
              + `这个人的其它${k === 'trait' ? '档案属性' : '方面'}不受影响。）`
          };
        }
        if (itemLabel) return { content: `记下了【${itemLabel}】${payload.text}` };
        if (payload.previous?.text) {
          return {
            content: `记下了【${k}】${payload.text}`
              + `（同一类的旧条目「${String(payload.previous.text).slice(0, 40)}」已被替换 —— `
              + `如果那也是一件要留的事，换个 kind 再记一条。）`
          };
        }
        return { content: `记下了【${k}】${payload.text}` };
      } catch (error) {
        if (error?.name === 'AbortError') {
          const n = payloadReq ? outboxPark(payloadReq, `timeout ${WRITE_TIMEOUT_MS}ms`) : 0;
          if (n < 0) return { content: '没记住：服务超时，补发队列也未能保存，请稍后重试。', isError: true };
          return {
            content: `没记住：向量记忆库服务 ${WRITE_TIMEOUT_MS / 1000} 秒没有响应`
              + (payloadReq
                ? `（已**暂存**，服务恢复后会自动补记；当前队列 ${n} 条）。`
                : '（地址见「设置 → 向量记忆库」的 serviceBaseURL）。'),
            isError: true
          };
        }
        const n = payloadReq ? outboxPark(payloadReq, String(error?.message ?? error)) : 0;
        if (n < 0) return { content: '没记住：服务不可达，补发队列也未能保存，请稍后重试。', isError: true };
        return {
          content: `没记住：连不上向量记忆库服务（${String(error?.message ?? error)}）。`
            + (payloadReq
              ? `已**暂存**，等服务起来后自动补记（当前队列 ${n} 条）；不必重记这一条。`
              : '服务没起时记忆功能整体缺席，面板的「设置 → 向量记忆库」里有状态可看。'),
          isError: true
        };
      }
    }
  });

  // ── 读侧：memory-vec__search（搜旧事）──────────────────────────────────────
  //
  // 由来（用户 2026-10-12 拍板「A + 原先的记忆功能全权为向量记忆库接管」）：
  // 让模型主动翻旧账这条路，原来只有宿主内置的关键词检索（`memory_search` /
  // `memory_archive`）。拍板后那一路**整体下线**，翻旧事只剩本工具 —— 所以它的
  // description 敢写「本机只有这一条检索路」。
  //
  // 新树里"下线"同样靠 `api.tools` 白名单（内置工具受白名单管、技能工具豁免）：
  // 当前 `<dataDir>/config.json` 的 `api.tools` 里没有 `memory_append`/`memory_query`/
  // `memory_remove`，而 `memory-vec__remember`/`memory-vec__search` 在列 ⇒ 口径一致。
  //
  // 与写侧（remember）的不同，也是它敢做成"只读、失败就明说"的理由：
  //   · **读失败顶多这一轮想不起来**，不需要像写侧那样逐条给"为什么没记住"；
  //     但仍要 `isError:true` —— 静默返回空串会让模型把"服务没起"读成"确实没有这段记忆"，
  //     于是它开始编（这正是宿主 prompt 反复叮嘱"搜不到别编"要防的事）。
  //   · **查询侧归一化在服务端做**（ADR-0002 第 4 条）：本工具**不要**自己先脱敏，
  //     否则真名在插件这层就被替成占位符、而服务端还会再归一化一次 —— 两次替代不等价。
  //     本工具只做「传话 + 把 hits 压成模型读得动的短文本」。
  //   · **judgment 要透给模型**：服务端的 `judgment.ok === false` 意思是"这几条分数挨得
  //     太近、名次由浮点噪声决定"。这种时候把 5 条原样端上去，模型会当成"一定是这几条"，
  //     反而比搜不到更糟。所以降级提示必须出现在工具结果里（模型读它，不是人读）。
  api.registerTool({
    id: 'search',
    name: '搜旧事',
    description: '按**语义**翻长期记忆 —— 换了说法也能命中（问「家在哪」能捞到「家在沈阳」）。'
      + '只在上下文不够、被问到很久以前的事、或「你还记得…」时才用；'
      + '要抠准词、按天翻原文用 memory_search。'
      + '返回压缩片段不是完整录像；搜不到就如实说想不起来，**不要编**。',
    category: 'memory',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: {
        q: {
          type: 'string',
          description: '要找的那件事，用**自然说法**写就行 —— 语义检索自己找近义表达，不必抠关键词。'
            + '带上人/时间/事件更好，如「上周谁提过搬家」'
        },
        k: { type: 'number', description: '返回几条，可选，默认 5（1~12）' },
        chatKey: {
          type: 'string',
          description: '可选：只在某个会话里搜，形如 group:群号 / private:QQ号。不填 = 全库'
        }
      },
      required: ['q']
    },

    async execute(ctx, args) {
      if(protocolV1())return toolV1('search',ctx,args);
      try {
        const q = String(args?.q ?? args?.query ?? '').trim();
        if (!q) return { content: '要搜什么？给一句话就行（用自然说法即可，不用抠关键词）。', isError: true };

        const base = baseURLOf(mvCfg());
        const k = Math.min(12, Math.max(1, Number(args?.k) || 5));
        const payloadReq = { q, k };
        if (args?.chatKey) payloadReq.chatKey = String(args.chatKey);

        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), SEARCH_TIMEOUT_MS);
        let r;
        let payload = null;
        try {
          r = await fetch(`${base}/api/vec/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payloadReq),
            signal: ac.signal
          });
          payload = await r.json().catch(() => null);
        } finally {
          clearTimeout(timer);
        }

        if (!r.ok || !payload?.ok) {
          const why = payload?.error || `HTTP ${r.status}`;
          return { content: `检索失败：${why}`, isError: true };
        }

        const hits = Array.isArray(payload.hits) ? payload.hits : [];
        if (!hits.length) {
          return { content: '没有命中长期记忆。换个更宽的说法再试；仍未命中就如实说想不起来，不要编。' };
        }

        const lines = hits.map((h, i) => {
          const tag = [fmtWhen(h.when), shortChatKey(h.chatKey)].filter(Boolean).join(' · ');
          const text = String(h.text || h.title || '').replace(/\s+/g, ' ').trim().slice(0, 160);
          const score = Number.isFinite(Number(h.score)) ? Number(h.score).toFixed(3) : '?';
          return `${i + 1}.${tag ? `[${tag}]` : ''} ${text}（相关度 ${score}）`;
        });

        const head = `语义检索命中 ${hits.length} 条（全库扫了 ${payload.scanned} 块）：`;
        const caveat = payload.judgment && payload.judgment.ok === false
          ? '\n⚠️ 这次几条分数挨得太近，名次不太可靠 —— 可以当作「可能相关」，别当成「一定就是这几条」。'
          : '';
        return { content: `${head}\n${lines.join('\n')}${caveat}` };
      } catch (error) {
        if (error?.name === 'AbortError') {
          return {
            content: `检索超时：向量记忆库服务 ${SEARCH_TIMEOUT_MS / 1000} 秒没响应`
              + '（地址见「设置 → 向量记忆库」的 serviceBaseURL）。',
            isError: true
          };
        }
        return {
          content: `检索失败：连不上向量记忆库服务（${String(error?.message ?? error)}）。`
            + '服务没起时记忆功能整体缺席 —— 此时**别凭印象编旧事**，如实说想不起来。',
          isError: true
        };
      }
    }
  });
}

// ── 自动拉起数据面服务 ─────────────────────────────────────────────────────
//
// 起因是一句「能不能让插件在程序启动时把向量库带起来」。此前 `activate` 是**空实现**，
// 代价是每次重启宿主都得记得手动双击仓里的启动器；忘了的表现是**注入静默消失**——
// 按设计它两处静默（非 200 直接 return、catch 空吞），既不报错也不留日志。
//
// 四条边界（都刻意为之）：
//   · **只拉起本号那一个实例**：端口从 `serviceBaseURL` 取，`--port` 传给启动器
//     ⇒ 单号模式不会把另一个号的库也顺带起了（那是另一个 `sourceRoot`）。
//   · **判据是运行期事实**：先探 `/health`，通了就什么都不做（与服务侧启动器同一条判据：
//     "端口上真有它在答"，而不是"我以为我起过"）。
//   · **失败一律静默**：便携包原样拷到没有 vec-memory 仓的机器上时，`serviceRoot`
//     为空或路径不存在 ⇒ 直接返回，插件照旧优雅降级，不报错、不拖慢宿主启动。
//   · **不在这里关服务**：关闭交给 `--parent-pid`（服务每 5s 看住宿主）。宿主崩溃时
//     `deactivate` 根本不会跑，靠它关等于没关。
const AUTOSTART_GAP_MS = 60000;

/** 从 `serviceBaseURL` 取端口（取不到回 0 ⇒ 调用方退回"不带 --port"）。 */
function portOfService(baseURL) {
  try { return Number(new URL(baseURL).port) || 0; } catch { return 0; }
}

/** 探活：服务在不在。只读 + 短超时，绝不拖慢宿主启动。 */
async function serviceAlive(baseURL) {
  const base = String(baseURL || '').replace(/\/+$/, '');
  if (!base) return false;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 1200);
  try {
    const r = await fetch(`${base}/health`, { signal: ac.signal });
    return !!r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function autostartService() {
  const cfg = mvCfg();
  if (cfg.autoStartService === false) return;          // 用户关了这个开关
  const repo = String(cfg.serviceRoot || '').trim();
  if (!repo) return;                                    // 没配仓路径 ⇒ 便携形态，不猜

  // 热重载会反复调 `activate`：同一进程内 60s 只尝试一次。
  // ⚠️ 存 `globalThis` 而不是模块级变量 —— 热重载换的是模块实例，模块级变量会归零，
  //    于是"服务正在启动（端口还没开）"的那几秒里每次重载都会再 spawn 一个。
  const g = (globalThis.__mvAutostart ||= { at: 0 });
  const now = Date.now();
  if (now - g.at < AUTOSTART_GAP_MS) return;
  g.at = now;

  const base = baseURLOf(cfg);
  if (await serviceAlive(base)) return;                 // 已在跑 ⇒ 不重起

  const tool = path.join(repo, 'tools', 'instances.mjs');
  if (!fs.existsSync(tool)) return;                     // 仓不在这台机器上 ⇒ 静默

  const port = portOfService(base);
  const args = [tool, 'start-silent'];
  if (port) args.push('--port', String(port));
  args.push('--parent-pid', String(process.pid));

  try {
    // `ELECTRON_RUN_AS_NODE=1`：宿主的 execPath 是 electron.exe，不设它就没法跑 .mjs 脚本
    //（与本仓其它"用宿主自带 Node 跑脚本"的地方同一做法；新树的启动器是
    // `node_modules/electron/dist/electron.exe`，`launch.ps1` 起的就是它）。
    spawn(process.execPath, args, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      cwd: repo,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    }).unref();
    diag({ at: 'autostart-spawn', repo, port });
  } catch (error) {
    /* 起不来不是插件的事：下一轮注入照常静默跳过 */
    diag({ at: 'autostart-err', err: String(error?.message || error) });
  }
}

// ── 写侧 outbox：服务缺席时先把事实存下来，回来再补记 ──────────────────────
//
// 起因是一句「它有了新印象和新记忆，但我向量库没开，会暂时存留下来吗？」——
// 那时的答案是**不会**：`remember` 只是一次 `fetch`（连不上就回"没记住"），
// 服务侧也没有排队/重试，于是那条印象**当场丢**，全程没有任何地方会再提起它。
//
// 现在补上这一环：写失败先落 `<DATA_DIR>/memory-vec-outbox.jsonl`，服务回来时自动回放。
//
// 四条边界（都刻意为之）：
//   · **幂等交给服务侧，不自己造去重协议**。回放用的是**同一份 payload**，而服务侧
//     `content` 是**确定性**的（同内容 ⇒ 同指纹 ⇒ noop）⇒ 重复回放只回 `noop`，
//     台账不会膨胀。所以"至少一次投递"在这里是安全的。
//   · **只重试"可能好起来"的失败**：网络/超时/5xx ⇒ 条目留着等下次；**4xx 语义拒绝**
//     ⇒ 重试多少次都一样，**直接丢弃并留痕** —— 否则一个坏条目会堵住队头。
//   · **有上限**：超过 `OUTBOX_MAX` 丢最旧的并留痕。服务长期缺席时，无限增长的文件
//     会把数据盘吃满 —— 那比丢几条旧印象严重得多。
//   · **数据根与宿主同口径**：新树 `core/config-store/data-dir.js:12` 是
//     `QQ_AGENT_DATA_DIR` 优先，否则按 `QQ_AGENT_PROFILE` 落 `data` / `data-<n>`
//     （与旧树 `src/config.js` 逐字相同；新树的 `launch.ps1` 也会显式设它）。
//     这里**照抄这一条规则**而不是去 import 宿主的 data-dir.js：插件要能在
//     **服务缺席时**定位目录，那时问宿主是自相矛盾的；而且多一行 import 就多一个
//     "宿主改目录结构、插件整体起不来"的风险面（见文件头 ①）。
const OUTBOX_MAX = 200;
const OUTBOX_FLUSH_GAP_MS = 3 * 60 * 1000;
const OUTBOX_FILE_NAME = 'memory-vec-outbox.jsonl';

/** 宿主数据根（与 `refactor/core/config-store/data-dir.js` 同口径，必要的最小复制）。 */
function hostDataDir() {
  const env = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  if (env) return env;
  const profile = String(process.env.QQ_AGENT_PROFILE || '').trim();
  const root = path.resolve(PLUGIN_DIR, '..', '..');   // <ROOT>/plugins/memory-vec → <ROOT>
  return path.join(root, /^\d+$/.test(profile) ? `data-${profile}` : 'data');
}

function outboxFile() {
  return path.join(hostDataDir(), OUTBOX_FILE_NAME);
}

/** 读完整队列；坏行或不可读时拒绝改写，保留原文件供恢复。 */
function outboxLoad() {
  let raw = '';
  try { raw = fs.readFileSync(outboxFile(), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const line of String(raw).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (!o?.req || typeof o.req !== 'object') throw new Error('invalid outbox entry');
      out.push(o);
    } catch (e) { throw new Error(`补发队列损坏，保留原文件：${e.message}`); }
  }
  return out;
}

/** 原子重写（tmp + rename）：半截文件不会被下一次启动读成"队列只剩一半"。 */
function outboxSave(list) {
  const f = outboxFile();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    const body = list.map((o) => JSON.stringify(o)).join('\n');
    fs.writeFileSync(tmp, body ? `${body}\n` : '');
    fs.renameSync(tmp, f);
    return true;
  } catch (e) {
    diag({ at: 'outbox-save-err', err: String(e?.message || e) });
    return false;
  }
}

/** 把一条没写进去的事实入队，返回当前队列长度。 */
function outboxPark(req, why) {
  try {
    const list = outboxLoad();
    if (list.length >= OUTBOX_MAX) throw new Error('补发队列已满');
    list.push({ id: randomUUID(), at: new Date().toISOString(), why: String(why || '').slice(0, 200), attempts: 0, req });
    if (!outboxSave(list)) throw new Error('补发队列落盘失败');
    return list.length;
  } catch (e) {
    diag({ at: 'outbox-park-failed', err: String(e.message) });
    return -1;
  }
}

let outboxFlushing = false;
let outboxEpoch = 0;
const outboxControllers = new Set();
let outboxStartupTimer = null;

/**
 * 回放队列。返回 `{ sent, dropped, kept }`。
 * 并发保护：宿主是单进程，但定时器与工具调用可能同时进来 ⇒ 用一个标志串行化，
 * 否则两个回放并发会各自读到同一份队列、各自写回，"丢条目"就是这么发生的。
 */
export async function flushOutbox() {
  if (outboxFlushing) return { sent: 0, dropped: 0, kept: 0, busy: true };
  const epoch = outboxEpoch;
  const list = outboxLoad();
  // Persist IDs before networking; legacy entries acquire IDs exactly once.
  if (list.some(item => !item.id || !item.req.deliveryId)) {
    for (const item of list) { item.id ||= randomUUID(); item.req.deliveryId ||= item.id; }
    if (!outboxSave(list)) return { sent: 0, dropped: 0, kept: list.length, error: 'queue-save-failed' };
  }
  if (!list.length) return { sent: 0, dropped: 0, kept: 0 };
  outboxFlushing = true;
  try {
    const base = baseURLOf(mvCfg());
    let sent = 0;
    let dropped = 0;
    const kept = [];
    for (let i = 0; i < list.length; i++) {
      if (epoch !== outboxEpoch) return { sent, dropped, kept: outboxLoad().length, cancelled: true };
      const item = list[i];
      let r;
      let payload = null;
      try {
        const ac = new AbortController();
        outboxControllers.add(ac);
        const t = setTimeout(() => ac.abort(), 8000);
        try {
          r = await fetch(`${base}/api/vec/remember`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(item.req),
            signal: ac.signal
          });
          payload = await r.json().catch(() => null);
        } finally {
          clearTimeout(t);
          outboxControllers.delete(ac);
        }
      } catch (e) {
        // 连不上/超时 ⇒ 服务还没回来。**整批留到下次**：后面几条同样发不出去，白试。
        kept.push(...list.slice(i));
        diag({ at: 'outbox-defer', err: String(e?.message || e), remain: kept.length });
        break;
      }
      if (r.ok && payload?.ok) { sent++; continue; }        // 记下了 / noop，两种都算送达
      if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {              // 语义拒绝 ⇒ 重试无意义
        dropped++;
        diag({
          at: 'outbox-drop', status: r.status,
          why: String(payload?.error || payload?.reason || '').slice(0, 120),
          text: String(item.req?.text || '').slice(0, 60)
        });
        continue;
      }
      kept.push(item);                                      // 5xx/其它 ⇒ 留着
    }
    if (epoch !== outboxEpoch) return { sent, dropped, kept: outboxLoad().length, cancelled: true };
    const retained = new Set(kept.map(item => item.id));
    const acknowledged = new Set(list.filter(item => !retained.has(item.id)).map(item => item.id));
    const latest = outboxLoad().filter(item => !acknowledged.has(item.id));
    if (!outboxSave(latest)) return { sent, dropped, kept: outboxLoad().length, error: 'queue-save-failed' };
    if (sent || dropped) diag({ at: 'outbox-flush', sent, dropped, remain: latest.length });
    return { sent, dropped, kept: latest.length };
  } finally {
    outboxFlushing = false;
  }
}

let outboxTimer = null;

function startOutboxTimer() {
  if (outboxTimer) return;
  outboxTimer = setInterval(() => { flushOutbox().catch(() => { /* 静默 */ }); }, OUTBOX_FLUSH_GAP_MS);
  // 别让这个定时器把宿主进程钉住（Electron 主进程退出时）
  if (typeof outboxTimer.unref === 'function') outboxTimer.unref();
}

export function activate(ctx = {}) {
  if (protocolV1()) {
    deactivate();
    v1Store = ctx.store;
    v1Bridge = createProtocolBridge({config:mvCfg,dataDir:ctx.dataDir || hostDataDir(),store:v1Store});
    v1Bridge.sync().catch(e=>diag({at:'v1-sync-error',error:String(e.message)}));
    v1Timer=setInterval(()=>v1Bridge?.sync().catch(()=>{}),15000);v1Timer.unref?.();
    return;
  }
  /* 宿主侧唯一的副作用：把数据面服务带起来（异步、静默、可用设置关掉）。 */
  autostartService().catch(() => { /* 静默降级 */ });
  probeFromHost().catch(() => { /* 诊断失败无所谓 */ });
  // 上次服务缺席时暂存的事实，等服务起来后补记；并起一个低频定时器兜住"服务后回来"。
  // 顺序：等 autostart 落地再回放（刚拉起的服务要几秒才 listen，早试只会白费一轮）。
  if (outboxStartupTimer) clearTimeout(outboxStartupTimer);
  outboxStartupTimer = setTimeout(() => { outboxStartupTimer = null; flushOutbox().catch(() => { /* 静默 */ }); }, 6000).unref?.();
  startOutboxTimer();
}

/** 启动诊断只检查 health，不生成或采用记忆。 */
async function probeFromHost() {
  const base = baseURLOf(mvCfg());
  diag({
    at: 'activate', pid: process.pid, fetchType: typeof fetch, base,
    electron: process.versions?.electron || null, node: process.versions?.node || null
  });
  try {
    const r1 = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) });
    diag({ at: 'activate-health', status: r1.status });
  } catch (e) {
    diag({ at: 'activate-health-err', err: String(e?.message || e) });
  }

}

export function deactivate() {
  if(v1Timer)clearInterval(v1Timer);v1Timer=null;
  v1Bridge?.stop();v1Bridge=null;v1Store=null;
  /* 服务**不在这里关** —— 由 `--parent-pid` 看住宿主（见上）。 */
  outboxEpoch++;
  for (const ac of outboxControllers) ac.abort();
  if (outboxStartupTimer) { clearTimeout(outboxStartupTimer); outboxStartupTimer = null; }
  if (outboxTimer) { clearInterval(outboxTimer); outboxTimer = null; }
}

// ── M2 注入（ADR-0009）· before-llm-messages 钩子 ────────────────────────────
//
// 每轮 LLM 请求前，把"人格属性句"追加进提示词。先例是 per-chat-persona
//（同样靠这个钩子零侵入改 messages）。三个用户拍板（2026-10-10）：
//   ① 形态 = 人格属性句（"她怕打雷"式，悄悄参考、不主动提及——服务端块头已带指令）
//   ② 条数对齐宿主"群友印象"机制（每人 2 条，服务端默认）；阈值 0.5（2026-10-13 按实测校准）
//   ③ 全群开（不设会话白名单；关总闸 = 面板里的 injectEnabled）
// ⚠️ 注入位置从 system 尾改为 **user 末尾**：动态内容挂在 system 尾
//    会切断 system 前缀缓存并连带废掉其后整条 user 消息（私聊实测 system LCP 95~98%）。
//    语义不变：都是"本轮在场的人 + 正在聊的话题"的参考句，放 user 尾部同等有效。
//    新树的 `markInitialSystemPrefix()`（compose 调 M4）仍在给 #0 system 打缓存标记
//    ⇒ 这条纪律在新树同样成立，别改回 system。
//
// 纪律：
//   · **热路径**：钩子每轮都被调 ⇒ 幂等（哨兵注释判重）+ 快（2.5s 超时；
//     超时/失败/服务缺席 ⇒ 静默跳过，绝不影响回复）。
//   · **零核心侵入**：只追加文本，不改任何既有消息。
//   · 人名解析只认「名字(QQ数字)」形态（宿主 prompt 的聊天行标准格式），
//     解析不出人就不带 people 调服务（服务端 SELF 属性仍可注入）。

const INJECT_SENTINEL = '<!--mv-inject-->';

/**
 * 轻量诊断落盘（宿主的插件 console 在打包环境里看不到，所以写文件）。
 *
 * 为什么放 `%TEMP%` 而**不放插件目录**：插件目录有文件监听，在里面写日志会触发
 * 热重载 → 重载又执行钩子 → 又写日志 ⇒ **重载风暴**（实测踩过）。
 * 新树的 `watchPlugins()`（`plugin-loader.js:1047`）同样是 `fs.watch(root,{recursive})`
 * ⇒ 这条纪律一字不改地继续有效。
 *
 * 它现在有两个消费方：注入链路的"每跳留痕"（排查"到底注入没有"），
 * 与 outbox 的入队/回放/丢弃记录（排查"没写进去的那条后来怎样了"）。
 *
 * `MV_DIAG_FILE` 只给 selftest 用（把留痕写进临时目录，别污染使用者那份日志）；
 * 生产环境不设它，落点仍是 `%TEMP%/mv-inject-diag.log`。
 */
const DIAG_FILE = String(process.env.MV_DIAG_FILE || '').trim()
  || path.join(os.tmpdir(), 'mv-inject-diag.log');
function diag(o) {
  try {
    if (fs.existsSync(DIAG_FILE) && fs.statSync(DIAG_FILE).size > 512 * 1024) fs.writeFileSync(DIAG_FILE, '');
    fs.appendFileSync(DIAG_FILE, `${JSON.stringify({ t: new Date().toISOString(), ...o })}\n`);
  } catch { /* 诊断失败绝不影响业务 */ }
}

/** 聊天行「名字(QQ数字)」——与宿主 prompt 的历史标注格式对齐。 */
const PERSON_RE = /([^():\n【】〔〕]{1,32})[（(]QQ?(\d{5,11})[)）]/g;
const FETCH_TIMEOUT_MS = 2500;
/** 话题文本取尾部： recent 上下文对"现在聊什么"的代表性最好。 */
const TOPIC_CHARS = 600;
/** 「本轮触发批」的临时存放：`before-context` 写入 → `before-llm-messages` 读取。 */
const pendingTrigger = new Map();
const PENDING_MAX = 200;
const PENDING_TTL_MS = 60000;

/** 从 messages 的 user 侧解析参与者与话题文本（只读，不改 messages）。 */
function extractPeopleAndTopic(messages) {
  const users = (Array.isArray(messages) ? messages : []).filter((m) => m?.role === 'user');
  const text = users.map((m) => String(m.content ?? '')).join('\n');
  const people = [];
  const seen = new Set();
  for (const m of text.matchAll(PERSON_RE)) {
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    people.push({ id, name: m[1].trim() });
    if (people.length >= 12) break;
  }
  return { people, topic: text.slice(-TOPIC_CHARS) };
}

// ── 本轮触发批的临时存放（before-context 收、before-llm-messages 用）─────────
/**
 * Map 键 = chatKey。
 * 旧版用 `session.id`（同一 chatKey 上并发多轮时区分开）。新树**同群互斥**
 * （`refactor/README.md` §3.8 的运行时语义：防抖聚批 → 同群互斥 → 全局并发上限），
 * 且 `before-llm-messages` 的载荷里**没有 session** ⇒ 退到 chatKey，语义等价。
 * 键拼上 evidenceId 没有意义：两个钩子拿到的 id 形态不同（一个在数组里、一个是标量），
 * 而同群互斥已经保证了"一个会话同时只有一轮在跑"。
 */
function pendingKey(ctx = {}) {
  return String(ctx?.chatKey || '');
}

/** 取一条消息证据里的"谁"：新载荷 `sender:{id,name}`，旧载荷 `senderId/senderName` 都认。 */
function personOf(entry) {
  const rawId = String(entry?.sender?.id ?? entry?.senderId ?? '').replace(/^qq:/, '').trim();
  const name = String(entry?.sender?.name ?? entry?.senderName ?? '').trim();
  return { id: rawId, name };
}

/** 触发批 → `{ people, topic }`。people 取发送者 QQ 号，topic 取文本。 */
function collectFromEntries(entries) {
  const people = [];
  const seen = new Set();
  const texts = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const t = String(e?.text ?? '').trim();
    if (t) texts.push(t);
    const { id, name } = personOf(e);
    if (!/^\d{5,15}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    people.push({ id, name });
    if (people.length >= 12) break;   // 刷屏群上限：再多也超不过服务端的 total 名额
  }
  return { people, topic: texts.join('\n') };
}

/** 清理：先删过期的，仍超量就整体清空（宁可少一次精确，不要无界增长）。 */
function prunePending() {
  if (pendingTrigger.size <= PENDING_MAX) return;
  const now = Date.now();
  for (const [k, v] of pendingTrigger) {
    if (now - Number(v?.at || 0) > PENDING_TTL_MS) pendingTrigger.delete(k);
  }
  if (pendingTrigger.size > PENDING_MAX) pendingTrigger.clear();
}

/** content 可能是字符串，也可能是带 `cache_control` 的段数组 ⇒ 统一取纯文本。 */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : String(p?.text ?? ''))).join('');
  }
  return '';
}

/** 最后一条 system 的下标（-1 = 没有）。 */
function lastSystemIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'system') return i;
  }
  return -1;
}

/**
 * 最后一条 user 的下标（-1 = 没有）。注入目标。
 * 注入进 system 尾部 = 每轮变化的内容把 system 前缀缓存切断，
 * 且它后面的整条 user 消息（含冷历史）跟着全部 miss（序列化顺序 system 在前）。
 * 追加到 user 末尾只损失本来就每轮变的 volatile 区。
 */
function lastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

/**
 * 追加到最后一个 user（找不到再退回 system，绝不丢注入）。
 * ⚠️ 两个必须按类型分支的理由（都在"带 `cache_control`"时炸）：
 *   · 数组时**不能** `String(content)` —— 会变成 `'[object Object]'`，人设整个没了；
 *   · 追加进**已有的** text 段会改前缀 ⇒ 白废那块缓存。所以数组时 push **新段**
 *     （前缀不变、缓存仍命中，代价只是新段不缓存 —— 它本来就每轮不同）。
 */
function appendToLastSystem(messages, block) {
  const idx = lastUserIndex(messages) >= 0
    ? lastUserIndex(messages)
    : lastSystemIndex(messages);
  if (idx < 0) {
    // user 和 system 都没有（正常构造下不会）：补到**最前**。
    messages.unshift({ role: 'user', content: block });
    return;
  }
  const m = messages[idx];
  if (Array.isArray(m.content)) {
    m.content.push({ type: 'text', text: `\n\n${block}` });
    return;
  }
  m.content = `${String(m.content ?? '').replace(/\s+$/, '')}\n\n${block}`;
}

// ── 写侧常驻：「记人」节（0.28.0）────────────────────────────────────────────
//
// 问题：`remember` 是唯一产事实的写通路，但实测 `data-2/obs/*.ndjson`（10-17~10-21）
// **1504 次 `model:tool-offered` 只换来 5 次 `model:tool-call`**（号A 69 次 offered / 0 次调用）；
// 检查点 73 分钟催 7 次、0 响应（`%TEMP%/mv-inject-diag.log`）。对照老 `memory_append`：
// 它在 `refactor/core/config-store/personas.js:193-196` 有**人设专属节**
// （「十一、轻量记忆」）—— 每轮常驻、直接点名工具、教什么该记 / 节律 / 怎么查 / 怎么删；
// 而新工具在同文件 grep `memory-vec|remember|记事实` → **0 命中**，只在 schema 裸奔。
//
// 为什么有用：0.27.0 的自诊（见下方检查点注释）说"guide 埋在 system 深处够不着"——
// 本节同样在 system 里，区别是它是**行为指令**（"用 X 记住 Y"）而非能力说明，
// 且每轮常驻 ⇒ 模型每轮都看见一次"该记人"这件事本身。位置选 user 尾部而非 system：
// 动态内容挂 system 尾会切断前缀缓存（754-758 行的既有教训），语义同等有效。
//
// 机制：每轮往最后一条 user 尾部追加一节（与读侧同一条缓存纪律：不改既有消息、
// 不 push 新消息、数组 content 时 push 新段）。判重用**独立哨兵** `GUIDE_SENTINEL`
// —— 不能借用 `INJECT_SENTINEL`：读侧注入先跑、已带该哨兵，借用它会让本节永远判为重。
// 开关：`rememberGuideEnabled === false` 关（与检查点同口径，默认开）。
//
// ⚠️ 文案只许提**真实存在**的工具：`memory-vec__remember` + `memory-vec__search`。
//    本插件**没有** forget / 删除工具 ⇒ 不教"怎么删"（老人设节教 memory_remove，
//    这边没有对应物；写了就是诱导模型调一个不存在的函数）。

const GUIDE_SENTINEL = '<!--mv-guide-->';

const REMEMBER_GUIDE_TEXT = '【记人】（系统维护消息：不需要回复本条，更不要在回复里提起它）\n'
  + '你有一个记忆工具 memory-vec__remember：把关于具体的人的稳定印象记进记忆库，'
  + '以后相关话题里自动参考（不主动提及）。'
  + '该记：对方自述的固定信息、喜好口味、雷点禁忌、风格性格、身份关系、长期约定、反复玩的梗。\n'
  + '节律：聊出印象就顺手记一条，不要每条都记；先记后答，记完继续正常回复。'
  + '想不起某个人的旧事时，先用 memory-vec__search 翻一下再答。';

/**
 * 追加「记人」节到最后一条 user（没有则退 system）。同轮多 round 只加一次
 * （钩子每 round 都被调；`appendToLastSystem` 的分支纪律原样复用：数组时
 * push 新段保前缀缓存，字符串时拼到尾部）。
 */
function appendRememberGuide(messages) {
  const idx = lastUserIndex(messages) >= 0 ? lastUserIndex(messages) : lastSystemIndex(messages);
  if (idx < 0) return false;
  const m = messages[idx];
  if (contentToText(m.content).includes(GUIDE_SENTINEL)) return false; // 本轮已加
  const block = `${GUIDE_SENTINEL}\n${REMEMBER_GUIDE_TEXT}`;
  if (Array.isArray(m.content)) {
    m.content.push({ type: 'text', text: `\n\n${block}` });
    return true;
  }
  m.content = `${String(m.content ?? '').replace(/\s+$/, '')}\n\n${block}`;
  return true;
}

// ── 写侧触发：记忆检查点 ──────────────────────────────────────────────────
//
// 问题：`remember` 是唯一产事实的写通路，但纯靠模型自觉 —— 把 guide 注进 system
// 之后 10 会话 **0 次**调用。原因不是模型不知道有这工具，而是 guide 埋在 system
// 深处够不着，且没有「该记了」的时刻。
//
// 机制：每 chatKey 每 N 轮（`rememberCheckpointEvery`，默认 10）在 messages **末尾**
// 追加一条【记忆检查点】user 消息 —— 近因位置，注意力必达；要求模型先记后答。
// 边界（每条都刻意）：
//   · **按轮计数，不按 round 计数**：同一轮的多个 model round（工具循环、收尾轮、
//     末三轮提醒）只算一轮 —— 新树给了 `evidenceId`（一轮内恒定）作判据，
//     见文件头 ③。没有 evidenceId 时退回旧判据（末条 role==='user'）。
//   · 检查点消息自带 `INJECT_SENTINEL`：复用读侧的幂等检查 —— 否则下一 round 的
//     dup-skip 查 lastUserIndex（已变成检查点消息）查不到哨兵 ⇒ /inject 重复注入。
//     哨兵语义从「本轮已注入」推广为「本轮已处理」。
//   · **不回写会话存档**：它是本次请求的脚手架，落档会让控制台出现一条不存在的
//     用户消息（新树本来也没有要回写的那份存档，见文件头 ②）。
//   · 模型真调了 remember（`after-tool`）⇒ 计数清零：刚响应过提醒，节律重新起算。
//   · 失败一律静默 —— 与读侧同一条纪律：记忆的故障不能变成聊天的故障。

/** 检查点节律默认值（轮）。配置 0/未设 = 用它（「0＝未设」口径）。
 *  0.28.0 10 → 4：实测 10 轮太稀（73 分钟仅 7 次提醒、0 响应），密度提上来让
 *  「该记了」的时刻真的出现；「记人」节（上方）已每轮常驻，检查点保留为强提醒。 */
const CHECKPOINT_EVERY_DEFAULT = 4;

/** 检查点正文。要求：不回复本条、不向任何人提起；先记后答；给出 kind/attr/userId 要点。
 *  0.28.0 文案：去掉「没有值得记的就当没看见本条」的消极台阶（实测该框架下 7 次提醒
 *  0 响应），改成「有⇒先记再答 / 没有⇒直接回复、不要硬编」的二分指令 ——
 *  保留「不要硬编」防滥写，但不再给模型一个"整条可以无视"的心理出口。 */
const CHECKPOINT_TEXT = '【记忆检查点】（系统维护消息：不需要回复本条，更不要在回复里提起它）\n'
  + '回顾最近这段对话：有没有关于某个具体的人的**稳定事实**值得记住 —— 对方自述的固定信息'
  + '（职业/年龄/所在地/宠物/忌口…）、喜好口味、雷点禁忌、风格性格、身份关系、长期约定、反复玩的梗。\n'
  + '有 ⇒ 在正常回复之前先调用 memory-vec__remember 逐条记下（一条一件事；固定信息用 kind:"trait" '
  + '并给 attr；userId 抄聊天行「名字(QQ数字)」括号里的数字），记完继续正常回复。\n'
  + '没有 ⇒ 直接正常回复，不要硬编。';

/**
 * 每 chatKey 的轮计数：`{ [chatKey]: { turns, lastAt, lastEvidenceId } }`。
 * 内存为准，每次计数都落盘（理由见下方）。
 * `lastEvidenceId` 是 0.27.0 新增：同一轮的多 round 只计一次（文件头 ③）。
 */
const checkpointTurns = new Map();

function checkpointStateFile() {
  return path.join(hostDataDir(), 'memory-vec-checkpoint-state.json');
}

/** 原子写（tmp+rename）。状态丢得起：大不了重新计 10 轮，绝不让它影响聊天。 */
function checkpointSave() {
  try {
    const obj = {};
    for (const [k, v] of checkpointTurns) obj[k] = v;
    const f = checkpointStateFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, f);
  } catch { /* 这文件只影响节律，不影响功能 */ }
}

function checkpointLoad() {
  try {
    const obj = JSON.parse(fs.readFileSync(checkpointStateFile(), 'utf8'));
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && Number.isFinite(v.turns) && v.turns > 0) {
        checkpointTurns.set(k, {
          turns: v.turns,
          lastAt: Number(v.lastAt) || 0,
          lastEvidenceId: String(v.lastEvidenceId || '')
        });
      }
    }
  } catch { /* 首次没有 / 损坏 ⇒ 从零开始 */ }
}
checkpointLoad();

/**
 * 轮首判断节律，到点就往 messages 末尾追加检查点。
 * 新树判据 = evidenceId（同一轮多 round 只计一次）；没有 evidenceId 时退回
 * "末条 role==='user'"（旧判据，防御用）。
 */
function maybeCheckpoint(ctx = {}) {
  try {
    const messages = ctx.messages;
    if (!Array.isArray(messages) || !messages.length) return;
    const key = String(ctx.chatKey || '') || '(no-chat)';
    const turnId = String(ctx.evidenceId || '');
    const st = checkpointTurns.get(key) || { turns: 0, lastAt: 0, lastEvidenceId: '' };
    // ★ 同一轮的后续 round（工具循环 / 收尾轮 / 末三轮提醒）→ 已经计过，直接走。
    if (turnId && st.lastEvidenceId === turnId) return;
    if (!turnId) {
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'user') return; // 工具循环的后续 round 末条是 tool
    }
    // 「记人」常驻节（0.28.0）：与检查点频次无关，同轮首 round 追加一次（独立哨兵判重）。
    // 放在 same-turn return 之后 ⇒ 多 round 不重复；独立开关 ⇒ 关检查点不影响它。
    if (mvCfg().rememberGuideEnabled !== false && appendRememberGuide(messages)) {
      diag({ at: 'guide-appended', chatKey: key });
    }
    if (mvCfg().rememberCheckpointEnabled === false) return;
    const n = Number(mvCfg().rememberCheckpointEvery);
    const every = Number.isFinite(n) && n > 0 ? Math.floor(n) : CHECKPOINT_EVERY_DEFAULT;
    st.turns += 1;
    st.lastEvidenceId = turnId;
    // ⚠️ 每次自增都落盘：宿主 `watchPlugins` 对 `plugins/` **递归**监听
    //    （`plugin-loader.js:1078`），任何文件变动都会 `loadPlugins()` 全量重载，
    //    而加载用 `import(?t=Date.now())` 重新求值 ⇒ **模块级 `checkpointTurns` 被清零**。
    //    只在本文件触发时落盘的旧写法 ⇒ 计数活不过一次热重载 ⇒ 真实会话永远攒不到 N 轮。
    //    代价：每轮一条小 JSON 原子写，可忽略。
    if (st.turns < every) { checkpointTurns.set(key, st); checkpointSave(); return; }
    st.turns = 0;
    st.lastAt = Date.now();
    checkpointTurns.set(key, st);
    checkpointSave();
    messages.push({ role: 'user', content: `${INJECT_SENTINEL}\n${CHECKPOINT_TEXT}` });
    diag({ at: 'checkpoint', chatKey: key, every, evidenceId: turnId, msgs: messages.length });
  } catch { /* 与读侧同一条纪律：记忆的故障不能变成聊天的故障 */ }
}

/**
 * 读侧注入主体：把向量记忆的人格属性句追加进最后一个 user。
 * 内部全程 try/catch 静默 —— 注入失败绝不能影响回复。
 * 与写侧检查点共用同一个钩子（先注入再数轮，顺序不能反：检查点会改变
 * lastUserIndex 的指向，且它自带哨兵）。
 */
/**
 * 把面板上的四个「注入条数 / 阈值」键透传给 `/inject`（`0.27.1` 修静默失败）。
 *
 * 为什么必须显式传：服务端 `router.mjs` 里 `const s = rt.settings` —— 决策用的是**服务端自己的**
 * settings，而面板写的是**宿主** config.json（两个文件互不相干）。不传就等于「面板上改了不生效」，
 * 而界面上又写着「默认 2 / 默认 8」，用户没有任何办法察觉改了个寂寞 ⇒ 静默失败。
 * 服务端 `/inject` 的契约（`router.mjs:701`）本来就留了 `perPerson? / total? / minScore? / mode?`
 * 覆盖口，所以这里只需透传，服务端一行都不用动。
 *
 * 「未设」的口径与面板数值框留空、`resolveMinScore`（`n <= 0` 直接跳过）保持一致：
 * 0 / 非数 / 越界一律**不发**，让服务端回落到它自己的默认值（2 / 8 / 0.5 / boost）。
 * 这样历史上存量的 `injectTotal: 0`、`injectPerPerson: 0` 不会反过来把条数压成 1 条。
 */
function injectOverrides(cfg) {
  const o = {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
  const perPerson = num(cfg.injectPerPerson);
  if (perPerson >= 1 && perPerson <= 6) o.perPerson = perPerson;
  const total = num(cfg.injectTotal);
  if (total >= 1 && total <= 24) o.total = total;
  const minScore = num(cfg.injectThreshold);
  if (minScore > 0 && minScore <= 1) o.minScore = minScore;
  // 只有这两个值是合法枚举时才传；面板是下拉框，正常情况下不会脏。
  if (cfg.injectMode === 'hard' || cfg.injectMode === 'boost') o.mode = cfg.injectMode;
  // 档案跨场合（`0.27.2`，2026-10-18 拍板）。**只在它是布尔时才传**：
  // 未配置（undefined）⇒ 不传 ⇒ 服务端用它自己的默认（`profileCrossScope: true`）。
  // ⚠️ 但一旦面板上**取消勾选**，这里必须把 `false` 送出去 —— 服务端用
  //    `'profileCrossScope' in body` 判断「有没有被显式覆盖」，不传 `false` 就关不掉，
  //    而且关的动作**没有任何报错**（档案照旧跨场合注入）。
  //    反过来，如果像上面几个数值键那样「非合法值一律不发」，`false` 会被当成"未设"
  //    ⇒ 用户点了取消、提示"已保存"、行为没变。这是本节唯一不能套用「未设=不发」口径的键。
  if (typeof cfg.profileCrossScope === 'boolean') o.profileCrossScope = cfg.profileCrossScope;
  // ── 跨会话近况（`0.27.4`，`ADR-0043`）────────────────────────────────────────
  // 三个布尔开关**都必须能发出 `false`**（同 `profileCrossScope` 的理由：服务端用
  // `hasOwnProperty(body,k)` 判显式覆盖）。特别是 `crossChatIncludePrivate` ——
  // 它是"私聊内容能不能进群"的那道闸，默认 false 意味着**服务端默认值是 false**，
  // 这里不发也不会出错；但面板一旦勾上再取消，不发 `false` 就永远关不掉。
  for (const k of ['crossChatEnabled', 'crossChatInPrivate', 'crossChatInGroup', 'crossChatIncludePrivate']) {
    if (typeof cfg[k] === 'boolean') o[k] = cfg[k];
  }
  // 三个数值键走「未设=不发」的老口径（0 / 非数 / 越界一律不发，让服务端用默认）。
  const minutes = num(cfg.crossChatMinutes);
  if (minutes >= 1 && minutes <= 240) o.crossChatMinutes = minutes;
  const maxChats = num(cfg.crossChatMaxChats);
  if (maxChats >= 1 && maxChats <= 8) o.crossChatMaxChats = maxChats;
  const maxChars = num(cfg.crossChatMaxChars);
  if (maxChars >= 40 && maxChars <= 600) o.crossChatMaxChars = maxChars;
  return o;
}

async function injectMemories(ctx = {}) {
  const messages = ctx.messages;
  try {
    diag({ at: 'called', chatKey: String(ctx.chatKey || ''), isArr: Array.isArray(messages), msgs: Array.isArray(messages) ? messages.length : -1 });
    if (!Array.isArray(messages) || !messages.length) return;
    const cfg = mvCfg();
    if (cfg.injectEnabled === false) { diag({ at: 'gate-off' }); return; } // 总闸（面板可关）；默认全群开

    // 幂等：同一轮里钩子会被调多次（每个 round 一次），注入过就提前退出
    // —— 既防重复文本，也省掉后续 round 的 /inject 往返。
    // ⚠️ 用 contentToText 而**不是** `String(content)`：带 cache_control 时 content
    //    是数组，`String([obj])` = `'[object Object]'` ⇒ 永远不含哨兵 ⇒ 防重失效。
    {
      const ui = lastUserIndex(messages);
      const checkIdx = ui >= 0 ? ui : lastSystemIndex(messages);
      if (checkIdx >= 0 && contentToText(messages[checkIdx].content).includes(INJECT_SENTINEL)) { diag({ at: 'dup-skip' }); return; }
    }

    // 在场的人 + 话题：优先**触发批**（精确），拿不到才退回从 messages 正则抠。
    const key = pendingKey(ctx);
    const info = key ? pendingTrigger.get(key) : null;
    const fresh = info && Date.now() - Number(info.at || 0) <= PENDING_TTL_MS ? info : null;
    let people = fresh?.people || [];
    let topic = fresh?.topic || '';
    if (!people.length && !topic) {
      const fb = extractPeopleAndTopic(messages);
      people = fb.people;
      topic = fb.topic;
    }
    // 新树的 plan 带一个短话题标签（`ActionPlan.topic`）；只在正则兜底也没捞到文本时用。
    if (!topic && ctx.plan?.topic) topic = String(ctx.plan.topic);

    const base = baseURLOf(cfg);
    const ac = new AbortController();
    const epoch = outboxEpoch;
    outboxControllers.add(ac);
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    let payload;
    try {
      const r = await fetch(`${base}/api/vec/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatKey: String(ctx.chatKey || ''),
          rehearsal: 'deferred',
          topic: topic.slice(-TOPIC_CHARS),
          people,
          ...injectOverrides(cfg) // 面板的条数 / 阈值 / 模式（见 injectOverrides 注释）
        }),
        signal: ac.signal
      });
      if (!r.ok) { diag({ at: 'http-not-ok', status: r.status }); return; } // 非 200 一律静默（服务的问题不该变成群里的故障）
      payload = await r.json();
    } finally {
      clearTimeout(timer);
      outboxControllers.delete(ac);
    }
    if (ac.signal.aborted || epoch !== outboxEpoch) return;
    if (payload?.ok !== true) { diag({ at: 'inject-rejected', reason: payload?.error || 'invalid-envelope' }); return; }
    const rawBlock = String(payload?.block || '');
    if (!rawBlock || !payload?.injected) {
      diag({ at: 'empty', injected: payload?.injected, blockLen: rawBlock.length, simNote: payload?.simNote, people: people.length, topicLen: topic.length,
        // 跨会话段为什么空（`ADR-0043`）：`disabled` / `no-chat-key` / `private-target-off` /
        // `no-fresh-other-chat` / `messages-dir-unreadable`。不回报的话，
        // "群里没人说话"与"存档读不到"在这里长得一模一样。
        crossReason: payload?.crossChat?.reason || null });
      return;
    }

    // ★ 0.27.0 加固：**幂等判据不能押在远端**。
    //   服务端的块本来以 `<!--mv-inject-->` 开头（`vec-memory src/core/inject.mjs:579`），
    //   但那是它的实现细节 —— 哪天它改了块头，这里的 dup-skip 就会静默失效：
    //   同一轮每个 round 都注入一遍 ⇒ 提示词里出现 N 段重复属性、每轮多 N 次 /inject 往返，
    //   而且**没有任何报错**。⇒ 哨兵在本侧兜底加一次（已有就不重复加）。
    const block = rawBlock.includes(INJECT_SENTINEL) ? rawBlock : `${INJECT_SENTINEL}\n${rawBlock}`;

    appendToLastSystem(messages, block); // Adoption = appended to this round's messages.
    if (payload.receipt) {
      // A lost confirmation undercounts rehearsal; it must never delay the reply.
      fetch(`${base}/api/vec/inject/ack`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receipt: payload.receipt, chatKey: String(ctx.chatKey || '') }),
        signal: AbortSignal.timeout(500)
      }).catch(error => diag({ at: 'inject-ack-failed', err: String(error.message) }));
    }
    // ★ 0.27.0：这里**不再**回写会话存档（旧版 syncSessionRecord）。
    //   新树在 llm 调用边界上有 `apps/server/ui-preview.js` 抄的就是改完之后的入参
    //   （装配在 `assembly.js:1598`），钩子只要把 messages 改对，控制台自然看得见。
    diag({ at: 'injected', lines: (payload.lines || []).length, blockLen: block.length, people: people.length,
      crossChat: payload?.crossChat?.applied === true, crossSources: (payload?.crossChat?.sources || []).length });
  } catch (err) {
    /* 静默：注入失败绝不能影响回复本身。 */
    diag({ at: 'error', err: String(err?.message || err) });
  }
}

async function injectV1(ctx) {
  if(!v1Bridge || mvCfg().injectEnabled===false || !Array.isArray(ctx.messages))return;
  if(ctx.messages.some(m=>contentToText(m.content).includes('<!--mv-v1-->')))return;
  const bridge=v1Bridge;
  try {
    const p=await bridge.request('recall',{query:extractPeopleAndTopic(ctx.messages).topic,conversationId:ctx.chatKey,scope:scopeOf(ctx.chatKey)});
    if(bridge!==v1Bridge || !protocolV1())return;
    if(!p.block)return;
    appendToLastSystem(ctx.messages,`<!--mv-v1-->\n${p.block}`);
    if(p.receiptId)bridge.request('adoptions',{receiptId:p.receiptId,itemIds:(p.items||[]).map(x=>x.id)}).catch(()=>{});
  }catch(e){diag({at:'v1-recall-error',error:String(e.message)});}
}
async function toolV1(kind,ctx,args) {
  try {
    if(!v1Bridge)throw Error('通用协议适配层未启动');
    const conversationId=String(ctx.chatKey||'');const scope=scopeOf(conversationId);
    if(kind==='search') {
      const p=await v1Bridge.request('recall',{query:String(args.q||args.query||''),conversationId,scope});
      return {content:p.block||'未找到相关记忆。',isError:false};
    }
    if(!String(args.text||'').trim())throw Error('text 不能为空');
    const p=await v1Bridge.request('memories',{operationId:randomUUID(),conversationId,actorId:String(args.userId||''),scope,text:String(args.text),kind:args.kind||'preference',attr:args.attr,aspect:args.aspect,source:'assistant',evidenceIds:(args.evidence||[]).map(id=>`${conversationId}:${id}`)});
    return {content:JSON.stringify(p),isError:false};
  }catch(e){return {content:`记忆操作失败：${e.message}`,isError:true};}
}

export const hooks = {

  /**
   * 收集本轮触发批（在场的人 + 话题），供下一个钩子精确筛候选。
   *
   * 新载荷：`{ triggerEntries, chatKey, kind, senderId, evidence }`
   * （`orchestrator/index.js:4084`）。**没有 messages**（那要到
   * `before-llm-messages` 才有），所以走模块级 Map 传递。
   * `triggerEntries` 的元素是 MessageEvidence（`sender:{id,name}`），
   * 旧形状（`senderId/senderName`）由 `personOf()` 兼容。
   */
  'before-context': async (ctx = {}) => {
    if(protocolV1()) { v1Bridge?.sync().catch(e=>diag({at:'v1-sync-error',error:String(e.message)})); return; }
    try {
      const key = pendingKey(ctx);
      if (!key) return;
      const got = collectFromEntries(ctx.triggerEntries ?? ctx.evidence);
      if (got.people.length || got.topic) {
        pendingTrigger.set(key, { ...got, at: Date.now() });
        prunePending();
      } else {
        // 本轮没有触发批（主动唤醒 / 空批）：**清掉**旧数据 ——
        // 否则会把**上一轮**的人当成本轮在场的人注入，比少注入更糟。
        pendingTrigger.delete(key);
      }
    } catch { /* 收集失败 ⇒ 退回正则兜底，不影响这轮 */ }
  },

  'before-llm-messages': async (ctx = {}) => {
    if(protocolV1()) { await injectV1(ctx); maybeCheckpoint(ctx); return; }
    await injectMemories(ctx);   // 读侧：人格属性注入（内部全程静默）
    maybeCheckpoint(ctx);        // 写侧：记忆检查点（到点才追加，见上）
  },

  /**
   * after-tool：模型真调了 remember 时的**观测 + 节律清零**。
   * 这是本机制的验收仪表：`diag({at:'remember-call'})` 直接回答「检查点有没有用」。
   * 清零 = 刚响应过提醒，别马上又催。
   * ⚠️ 名字用完整工具名匹配：模型看到的是 `memory-vec__remember`
   * （`plugin-loader.js:537` 把注册 id 加 `skillId__` 前缀后原样作为 OpenAI function name）。
   * ⚠️ 结果形状新老都认：新树 M10 的行是 `{ok, state, error}`，没有 `isError`。
   */
  'after-tool': async (ctx = {}) => {
    try {
      if (String(ctx?.toolName || '') !== 'memory-vec__remember') return;
      const key = String(ctx?.chatKey || '') || '(no-chat)';
      const st = checkpointTurns.get(key);
      if (st) {
        st.turns = 0;
        if (ctx?.evidenceId) st.lastEvidenceId = String(ctx.evidenceId);
      }
      checkpointSave();
      const failed = ctx?.result?.isError === true
        || ctx?.result?.ok === false
        || String(ctx?.result?.state || '') === 'failed';
      diag({ at: 'remember-call', chatKey: key, isError: failed });
    } catch { /* 观测与节律都是附属品，绝不影响工具本身 */ }
  }
};
