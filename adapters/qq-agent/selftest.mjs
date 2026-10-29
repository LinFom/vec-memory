// memory-vec 自测（裸 node，不需要宿主、不需要向量服务）
//
// 为什么这个文件能存在：0.27.0 把 `index.js` 里的宿主 import 全摘了（见 index.js 文件头 ①）
// ⇒ 插件模块可以直接 import 进来，钩子喂合成载荷就能跑。
// 这就是"注入链路真的走通"的可复现证据 —— 不是"我看代码觉得对"。
//
// 跑法：node plugins/memory-vec/selftest.mjs
// 铁律：临时产物只写 os.tmpdir() 下自己建的那一个目录，退出前自己删；
//       **不碰** <dataDir>（脚本先把 QQ_AGENT_DATA_DIR 指到临时目录，插件按它定位）。
//
// 覆盖的断言（harness 收全部红项，末尾按失败数决定 EXIT —— 遇错即停会掩盖后面的红）：
//   ① setup 注册了两个工具，id 正确（模型看到的是 memory-vec__remember / memory-vec__search）
//   ② before-context 认得**新载荷** MessageEvidence 的 sender:{id,name}
//   ③ before-context 也认得**旧载荷** senderId/senderName（兼容，不回归）
//   ④ before-llm-messages 把人 + 话题带给服务（people[0].id / topic 内容）
//   ⑤ 注入落在**最后一个 user** 上（不是 system 尾），且带哨兵
//   ⑥ 同一 evidenceId 的第二 round 不重复注入（幂等）
//   ⑦ 检查点：every=1 时追加一条【记忆检查点】user 消息
//   ⑧ 检查点不吃"同一轮多 round"（新树 ③ 的核心修复）：同一 evidenceId 只计一次
//   ⑨ after-tool 观测到 memory-vec__remember 时把计数清零
//   ⑩ 服务连不上：读侧静默（无注入块、不抛），但写侧「记人」节是纯本地文本、照常追加
//   ⑩b 「记人」节（0.28.0）：每轮追加到最后一个 user、带独立哨兵 <!--mv-guide-->，
//       同轮多 round 不重复；借读侧哨兵会永远判重 ⇒ 必须独立
//   ⑪ 服务连不上：remember 工具回 isError，并把事实落进 outbox
//   ⑫ outbox 回放：服务回来后补记成功（sent=1，队列清空）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-vec-selftest-'));
process.env.QQ_AGENT_DATA_DIR = TMP;                 // 插件按它定位 outbox / 检查点状态
process.env.MV_DIAG_FILE = path.join(TMP, 'diag.log'); // 留痕也写临时目录
delete process.env.QQ_AGENT_PROFILE;

const failures = [];
let checks = 0;
function ok(name, cond, detail = '') {
  checks += 1;
  if (cond) return;
  failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

// ── 假的 HTTP 面：只实现插件真正调用的两个端点 ──────────────────────────────
const calls = [];
let mode = 'ok';                                     // ok | down
// 服务端真实返回的块**以 `<!--mv-inject-->` 开头**（vec-memory src/core/inject.mjs:579）；
// 这里刻意先给一个**不带哨兵**的块：插件必须自己兜底加（0.27.0 加固），否则幂等判据
// 就押在远端的实现细节上了。⑬ 再反过来验"已有哨兵不重复加"。
let injectBlock = '【记忆参考】林枫 喜欢买断制单机';
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  calls.push({ url: u, body });
  if (mode === 'down') throw new Error('ECONNREFUSED 127.0.0.1:8088');
  if (u.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
  if (u.endsWith('/api/vec/inject')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, injected: true, block: injectBlock, lines: ['林枫 喜欢买断制单机'] }) };
  }
  if (u.endsWith('/api/vec/remember')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, action: 'write', kind: body?.kind || 'preference', text: body?.text }) };
  }
  if (u.endsWith('/api/vec/search')) return { ok: true, status: 200, json: async () => ({ ok: true, hits: [], scanned: 0 }) };
  throw new Error(`unexpected url ${u}`);
};

const mod = await import(pathToFileURL(path.join(HERE, 'index.js')).href);

// ── setup：假宿主 api ──────────────────────────────────────────────────────
const cfg = {
  serviceBaseURL: 'http://127.0.0.1:8088',
  injectEnabled: true,
  rememberCheckpointEnabled: true,
  rememberCheckpointEvery: 0,
  autoStartService: false,        // 自测绝不拉起真服务
  serviceRoot: ''
};
const tools = new Map();
mod.setup({ config: () => cfg, registerTool: (def) => { tools.set(def.id, def); } });

ok('① setup 注册 remember', tools.has('remember'), [...tools.keys()].join(','));
ok('① setup 注册 search', tools.has('search'));
ok('① remember 有 parameters/execute', !!tools.get('remember')?.parameters && typeof tools.get('remember')?.execute === 'function');

// ── ② / ③ before-context：新老载荷都认 ────────────────────────────────────
await mod.hooks['before-context']({
  chatKey: 'group:1001', kind: 'group',
  triggerEntries: [{ sender: { id: '1353446252', name: '林枫' }, text: '我上周搬去成都了，顺便养了只橘猫' }]
});

const ctxMsgs = () => [{ role: 'system', content: '你是小萨' }, { role: 'user', content: '林枫(1353446252): 我上周搬去成都了' }];
/** 取 messages 的全部纯文本（content 可能是字符串或段数组）。 */
const contentTextOf = (messages) => messages.map((m) => (typeof m.content === 'string'
  ? m.content
  : (Array.isArray(m.content) ? m.content.map((p) => (typeof p === 'string' ? p : String(p?.text ?? ''))).join('') : ''))).join('\n');
calls.length = 0;
await mod.hooks['before-llm-messages']({ messages: ctxMsgs(), chatKey: 'group:1001', kind: 'group', evidenceId: 'ev-1', plan: { topic: '' } });

const injectCall = calls.find((c) => c.url.endsWith('/api/vec/inject'));
ok('④ 调到了 /api/vec/inject', !!injectCall);
eq('④ 带上了 people[0].id（新载荷 sender.id）', injectCall?.body?.people?.[0]?.id, '1353446252');
eq('④ 带上了 people[0].name', injectCall?.body?.people?.[0]?.name, '林枫');
ok('④ 话题取了触发批原文', String(injectCall?.body?.topic || '').includes('成都'), String(injectCall?.body?.topic));

{
  const messages = ctxMsgs();
  await mod.hooks['before-llm-messages']({ messages, chatKey: 'group:1001', kind: 'group', evidenceId: 'ev-1', plan: {} });
  const lastUser = messages[messages.length - 1];
  const sys = messages[0];
  ok('⑤ 注入落在最后一个 user 上', String(lastUser.content).includes('【记忆参考】'), String(lastUser.content).slice(0, 60));
  ok('⑤ 注入带哨兵（幂等判据）', String(lastUser.content).includes('<!--mv-inject-->'));
  eq('⑤ system 一字未动', sys.content, '你是小萨');
}

// ⑥ 幂等：同一轮第二个 round 再来一次，不该有第二次 /inject
{
  const messages = ctxMsgs();
  await mod.hooks['before-llm-messages']({ messages, chatKey: 'group:1001', kind: 'group', evidenceId: 'ev-1', plan: {} });
  const before = calls.filter((c) => c.url.endsWith('/api/vec/inject')).length;
  await mod.hooks['before-llm-messages']({ messages, chatKey: 'group:1001', kind: 'group', evidenceId: 'ev-1', plan: {} });
  const after = calls.filter((c) => c.url.endsWith('/api/vec/inject')).length;
  eq('⑥ 同一轮不重复请求注入服务', after, before);
  eq('⑥ 哨兵只出现一次', String(messages[messages.length - 1].content).split('<!--mv-inject-->').length - 1, 1);
}

// ③ 旧载荷兼容
{
  const messages = [{ role: 'user', content: 'hi' }];
  calls.length = 0;
  await mod.hooks['before-context']({ chatKey: 'private:2002', triggerEntries: [{ senderId: '1353446252', senderName: '旧形状' }] });
  await mod.hooks['before-llm-messages']({ messages, chatKey: 'private:2002', kind: 'private', evidenceId: 'ev-old', plan: {} });
  const c = calls.find((x) => x.url.endsWith('/api/vec/inject'));
  eq('③ 旧载荷 senderId 也认', c?.body?.people?.[0]?.id, '1353446252');
}

// ── ⑦ / ⑧ 检查点 ─────────────────────────────────────────────────────────
{
  cfg.rememberCheckpointEvery = 1;
  const messages = [{ role: 'system', content: 'S' }, { role: 'user', content: 'round-1' }];
  await mod.hooks['before-llm-messages']({ messages, chatKey: 'group:3003', kind: 'group', evidenceId: 'ev-cp-1', plan: {} });
  const hasCp = messages.some((m) => m.role === 'user' && String(m.content).includes('【记忆检查点】'));
  ok('⑦ every=1 时追加了检查点', hasCp, JSON.stringify(messages.map((m) => m.role)));
  const count1 = messages.filter((m) => String(m.content).includes('【记忆检查点】')).length;

  // ⑧ 同一 evidenceId 的后续 round（末条已是 tool）不该再计一轮
  messages.push({ role: 'tool', content: 'tool-result' });
  await mod.hooks['before-llm-messages']({ messages, chatKey: 'group:3003', kind: 'group', evidenceId: 'ev-cp-1', plan: {} });
  const count2 = messages.filter((m) => String(m.content).includes('【记忆检查点】')).length;
  eq('⑧ 同一轮多 round 不重复计时/注入', count2, count1);
}

// ⑨ after-tool 清零
{
  const stateFile = path.join(TMP, 'memory-vec-checkpoint-state.json');
  cfg.rememberCheckpointEvery = 5;
  const messages = [{ role: 'user', content: 'a' }];
  await mod.hooks['before-llm-messages']({ messages, chatKey: 'group:4004', kind: 'group', evidenceId: 'ev-r-1', plan: {} });
  const before = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  ok('⑨ 计数已落盘（热重载不清零）', before['group:4004']?.turns >= 1, JSON.stringify(before['group:4004']));
  await mod.hooks['after-tool']({ toolName: 'memory-vec__remember', chatKey: 'group:4004', evidenceId: 'ev-r-1', result: { ok: true } });
  const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  eq('⑨ remember 调用后计数清零', after['group:4004']?.turns, 0);
}

// ── ⑩ 服务连不上：读侧静默 ────────────────────────────────────────────────
// 0.28.0 起断言口径细分：服务挂掉时**读侧**必须静默（无注入块），但写侧「记人」节
// 是纯本地文本、不依赖服务 ⇒ 仍要追加（老人设节同性质：它在 system 里常年挂着）。
// 旧断言「messages 完全不变」把两者一起否了，与 0.28.0 的设计相悖，故改写成两条。
{
  mode = 'down';
  const messages = ctxMsgs();
  let threw = null;
  try {
    await mod.hooks['before-context']({ chatKey: 'group:5005', triggerEntries: [{ sender: { id: '1353446252', name: 'A' }, text: 'x' }] });
    await mod.hooks['before-llm-messages']({ messages, chatKey: 'group:5005', kind: 'group', evidenceId: 'ev-down', plan: {} });
  } catch (error) { threw = error; }
  eq('⑩ 注入失败不抛', threw, null);
  const downText = contentTextOf(messages);
  ok('⑩ 读侧静默：服务挂掉无注入块', !downText.includes('<!--mv-inject-->') && !downText.includes('【记忆参考】'));
  ok('⑩ 写侧不依赖服务：「记人」节照常追加', downText.includes('<!--mv-guide-->') && downText.includes('memory-vec__remember'));
  ok('⑩ 原文消息未被污染（只做尾部追加）', messages.length === 2 && messages[0].role === 'system' && messages[1].content.startsWith('林枫(1353446252): 我上周搬去成都了'));
}

// ── ⑩b 「记人」常驻节（0.28.0）────────────────────────────────────────────
{
  mode = 'ok';
  const m1 = ctxMsgs();
  await mod.hooks['before-context']({ chatKey: 'group:6007', triggerEntries: [{ sender: { id: '1353446252', name: 'A' }, text: 'x' }] });
  await mod.hooks['before-llm-messages']({ messages: m1, chatKey: 'group:6007', kind: 'group', evidenceId: 'ev-g1', plan: {} });
  const t1 = contentTextOf(m1);
  ok('⑩b 每轮追加（首轮即有，与频次无关）', t1.includes('<!--mv-guide-->'));
  ok('⑩b 点名了 remember 工具', t1.includes('memory-vec__remember'));
  ok('⑩b 不教不存在的工具（无 forget/删除）', !/forget|删除/.test(t1));
  ok('⑩b 与读侧哨兵互不误判（两者都在）', t1.includes('<!--mv-inject-->') && t1.includes('<!--mv-guide-->'));
  eq('⑩b 消息条数不变（尾部追加，非新消息）', m1.length, 2);
  // 同 evidenceId 再来一次（同轮多 round）⇒ same-turn return 兜住
  await mod.hooks['before-llm-messages']({ messages: m1, chatKey: 'group:6007', kind: 'group', evidenceId: 'ev-g1', plan: {} });
  eq('⑩b 同轮多 round 只加一次', (contentTextOf(m1).match(/<!--mv-guide-->/g) || []).length, 1);
  // 换 evidenceId（绕过 same-turn return）⇒ 靠 GUIDE_SENTINEL 自身判重
  await mod.hooks['before-llm-messages']({ messages: m1, chatKey: 'group:6007', kind: 'group', evidenceId: 'ev-g2', plan: {} });
  eq('⑩b 独立哨兵判重：换轮也不重复', (contentTextOf(m1).match(/<!--mv-guide-->/g) || []).length, 1);
  mode = 'down';   // ⑪ 依赖 down 模式（remember 失败才写 outbox），用完还给人家
}

// ── ⑪ 服务连不上：写侧不静默 + outbox ────────────────────────────────────
{
  const res = await tools.get('remember').execute({ chatKey: 'group:5005' }, { userId: '1353446252', text: '喜欢买断制单机' });
  eq('⑪ remember 回 isError', res?.isError, true);
  ok('⑪ 失败原因说清了是"没记住"', String(res?.content).startsWith('没记住'), String(res?.content).slice(0, 40));
  const outbox = fs.readFileSync(path.join(TMP, 'memory-vec-outbox.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
  eq('⑪ 事实已入 outbox', outbox.length, 1);
  ok('⑪ outbox 里有正文', outbox[0].includes('喜欢买断制单机'));
}

// ⑫ 回放
{
  mode = 'ok';
  const r = await mod.flushOutbox();
  eq('⑫ 服务回来后补记成功', r.sent, 1);
  eq('⑫ 队列已清空', r.kept, 0);
  eq('⑫ outbox 文件空', fs.readFileSync(path.join(TMP, 'memory-vec-outbox.jsonl'), 'utf8').trim(), '');
}

// ⑬ 服务端自己带哨兵时，不许重复加（否则也会变成"两段哨兵"）
{
  injectBlock = '<!--mv-inject-->\n【人格属性（来自长期记忆，悄悄参考，不要主动提及）】\n林枫 喜欢买断制单机';
  const messages = [{ role: 'user', content: 'hi' }];
  await mod.hooks['before-context']({ chatKey: 'group:6006', triggerEntries: [{ sender: { id: '1353446252', name: 'A' }, text: 'y' }] });
  await mod.hooks['before-llm-messages']({ messages, chatKey: 'group:6006', kind: 'group', evidenceId: 'ev-sent', plan: {} });
  eq('⑬ 服务端已带哨兵时不重复加', String(messages[0].content).split('<!--mv-inject-->').length - 1, 1);
  injectBlock = '【记忆参考】林枫 喜欢买断制单机';
}

// ── ⑭ 面板的条数 / 阈值 / 模式必须真发给服务端（0.27.1 修静默失败）──────────
// 背景：服务端 `/inject` 的决策读的是它**自己的** settings，面板写的是宿主 config.json。
// 不显式透传 ⇒ 面板上「每人最多几条 / 单轮总上限 / 阈值 / 阈值用法」四个控件改了不生效，
// 而界面上还写着「默认 2 / 默认 8」⇒ 用户无从察觉。服务端早支持 body 覆盖，插件只差发。
{
  Object.assign(cfg, { injectPerPerson: 3, injectTotal: 12, injectThreshold: 0.62, injectMode: 'hard' });
  calls.length = 0;
  const messages = [{ role: 'user', content: 'hi' }];
  await mod.hooks['before-context']({
    chatKey: 'group:7007',
    triggerEntries: [{ sender: { id: '1353446252', name: 'A' }, text: '说说看' }]
  });
  await mod.hooks['before-llm-messages']({ messages, chatKey: 'group:7007', kind: 'group', evidenceId: 'ev-ov', plan: {} });
  const b = calls.find((c) => c.url.endsWith('/api/vec/inject'))?.body || {};
  eq('⑭ 每人条数透传', b.perPerson, 3);
  eq('⑭ 单轮总上限透传', b.total, 12);
  eq('⑭ 阈值透传', b.minScore, 0.62);
  eq('⑭ 阈值用法透传', b.mode, 'hard');
}

// ── ⑮ 存量的 0 值 = 「未设」，不许发出去把条数压死 ──────────────────────────
// `router.mjs` 里 `Number(body.total) || 8` —— 传 0 会回落 8，但传 0 与「未设」混同本身
// 就是坑（同族问题见 `core/inject.mjs:440` 的注释）。插件侧一律不发，交给服务端默认。
{
  Object.assign(cfg, { injectPerPerson: 0, injectTotal: 0, injectThreshold: 0, injectMode: 'boost' });
  calls.length = 0;
  const messages = [{ role: 'user', content: 'hi' }];
  await mod.hooks['before-context']({
    chatKey: 'group:8008',
    triggerEntries: [{ sender: { id: '1353446252', name: 'A' }, text: '在吗' }]
  });
  await mod.hooks['before-llm-messages']({ messages, chatKey: 'group:8008', kind: 'group', evidenceId: 'ev-zero', plan: {} });
  const b = calls.find((c) => c.url.endsWith('/api/vec/inject'))?.body || {};
  ok('⑮ 存量为 0 时不发 perPerson', !('perPerson' in b), JSON.stringify(b));
  ok('⑮ 存量为 0 时不发 total', !('total' in b), JSON.stringify(b));
  ok('⑮ 存量为 0 时不发 minScore', !('minScore' in b), JSON.stringify(b));
  eq('⑮ mode 仍照发（下拉框是枚举，不会脏）', b.mode, 'boost');
}

// ── ⑯ 「档案跨场合」开关：false 必须**真发出去**（0.27.2）────────────────────
// 背景：私聊说过「我 21 岁」→ 群里问就答不出。根因是服务端档案段的场合硬闸
// （`core/inject.mjs:profileScopeAllowed`，ADR-0031 §3.8）：私聊学的 trait 不进群。
// 服务端默认已改为跨场合（`profileCrossScope: true`），面板负责能关回去。
//
// ⚠️ 这一条不能套用 ⑮ 的「未设=不发」口径：服务端的判据是 `'profileCrossScope' in body`
//    —— 只有**发出去的 false** 才算"显式覆盖"。不发 ⇒ 服务端用自己的默认 true ⇒
//    用户点了取消、提示"已保存"、行为没变（且全程无报错）。
{
  Object.assign(cfg, { profileCrossScope: false });
  calls.length = 0;
  const messages = [{ role: 'user', content: 'hi' }];
  await mod.hooks['before-context']({
    chatKey: 'group:9009',
    triggerEntries: [{ sender: { id: '1353446252', name: 'A' }, text: '我多大' }]
  });
  await mod.hooks['before-llm-messages']({ messages, chatKey: 'group:9009', kind: 'group', evidenceId: 'ev-cross', plan: {} });
  const b = calls.find((c) => c.url.endsWith('/api/vec/inject'))?.body || {};
  eq('⑯ 关掉跨场合时 false 必须发出去（false = 显式覆盖，不是"未设"）', b.profileCrossScope, false);
  ok('⑯ 键必须真的存在（服务端用 in-body 判据决定是否覆盖）',
    Object.prototype.hasOwnProperty.call(b, 'profileCrossScope'), JSON.stringify(b));
}

// ── ⑰ 未配置时**不发**该键 —— 让服务端用自己的默认（true）──────────────────
{
  delete cfg.profileCrossScope;
  calls.length = 0;
  const messages = [{ role: 'user', content: 'hi' }];
  await mod.hooks['before-context']({
    chatKey: 'group:9109',
    triggerEntries: [{ sender: { id: '1353446252', name: 'A' }, text: '我多大' }]
  });
  await mod.hooks['before-llm-messages']({ messages, chatKey: 'group:9109', kind: 'group', evidenceId: 'ev-cross2', plan: {} });
  const b = calls.find((c) => c.url.endsWith('/api/vec/inject'))?.body || {};
  ok('⑰ 未配置时不发 profileCrossScope（交给服务端默认，避免两份默认值打架）',
    !('profileCrossScope' in b), JSON.stringify(b));
}

// ── ⑱ 面板必须有「按人 / 按标签查」入口（0.27.3）──────────────────────────────
// 服务端加了 `/recall` 而面板不接 ⇒ 用户看不到这个能力（"改了但用不上"）。
// 这条只查结构，不跑浏览器：入口 id、请求路径、动态芯片的**容器代理**、两段标题。
{
  const src = fs.readFileSync(path.join(HERE, 'settings-ui.js'), 'utf8');
  ok('⑱ 面板有「按人 / 按标签查」入口', src.includes('id="mv-rc-go"'), '');
  ok('⑱ 面板真的调 /recall', src.includes('/api/memory-vec/recall'), '');
  ok('⑱ 标签芯片走容器代理（innerHTML 覆盖后逐个 listener 会成垃圾）',
    src.includes("closest('button[data-kind]')"), '');
  ok('⑱ 长期 / 近期分开列（合并成一个列表 = 两个量纲混排）',
    src.includes('长期（结构化事实）') && src.includes('近期（聊天块）'), '');
}

// ── ⑲ 跨会话近况（0.27.4 / ADR-0043）────────────────────────────────────────
// 三个布尔开关全是"安全阀"：任何一个 `false` 发不出去，对应的闸就永远关不上，
// 而且**不会报错**（服务端用 `hasOwnProperty(body,k)` 判显式覆盖）。
// 这里逐个验"false 必须真的发出去"，再验数值键的"未设/越界不发"。
{
  Object.assign(cfg, {
    crossChatEnabled: false, crossChatInPrivate: false, crossChatInGroup: false, crossChatIncludePrivate: false,
    crossChatMinutes: 15, crossChatMaxChats: 3, crossChatMaxChars: 200
  });
  calls.length = 0;
  const messages = [{ role: 'user', content: 'hi' }];
  await mod.hooks['before-context']({
    chatKey: 'private:1353446252',
    triggerEntries: [{ sender: { id: '1353446252', name: 'A' }, text: '群里刚说啥了' }]
  });
  await mod.hooks['before-llm-messages']({ messages, chatKey: 'private:1353446252', kind: 'private', evidenceId: 'ev-cross3', plan: {} });
  const b = calls.find((c) => c.url.endsWith('/api/vec/inject'))?.body || {};
  eq('⑲ 关掉总闸时 crossChatEnabled=false 必须发出去', b.crossChatEnabled, false);
  eq('⑲ 关掉「私聊也收」时 false 必须发出去（否则私聊永远关不掉）', b.crossChatInPrivate, false);
  eq('⑲ 关掉「群聊也收」时 false 必须发出去（否则群侧串味关不掉）', b.crossChatInGroup, false);
  eq('⑲ 「私聊内容可作来源」的 false 必须发出去（这是防泄露那道闸）', b.crossChatIncludePrivate, false);
  eq('⑲ 合法的时间窗要照发', b.crossChatMinutes, 15);
  eq('⑲ 合法的会话数上限要照发', b.crossChatMaxChats, 3);
  eq('⑲ 合法的字符上限要照发', b.crossChatMaxChars, 200);
  for (const k of ['crossChatEnabled', 'crossChatInPrivate', 'crossChatInGroup', 'crossChatIncludePrivate']) {
    ok(`⑲ ${k} 必须真的在 body 里（不是 undefined）`,
      Object.prototype.hasOwnProperty.call(b, k), JSON.stringify(b));
  }
}

// ⑲b 数值键「未设 / 越界」一律不发 —— 让服务端用自己的默认，避免两份默认值打架。
{
  Object.assign(cfg, { crossChatMinutes: 0, crossChatMaxChats: 99, crossChatMaxChars: 1 });
  calls.length = 0;
  const messages = [{ role: 'user', content: 'hi' }];
  await mod.hooks['before-context']({
    chatKey: 'group:9209',
    triggerEntries: [{ sender: { id: '1353446252', name: 'A' }, text: '在吗' }]
  });
  await mod.hooks['before-llm-messages']({ messages, chatKey: 'group:9209', kind: 'group', evidenceId: 'ev-cross4', plan: {} });
  const b = calls.find((c) => c.url.endsWith('/api/vec/inject'))?.body || {};
  ok('⑲b 时间窗 0 不发', !('crossChatMinutes' in b), JSON.stringify(b));
  ok('⑲b 会话数越界不发', !('crossChatMaxChats' in b), JSON.stringify(b));
  ok('⑲b 字符上限越界不发', !('crossChatMaxChars' in b), JSON.stringify(b));
}

// ⑲c 面板三件套必须在：总闸、私聊目标、私聊来源。少一个就等于"能力有了但没入口"。
{
  const src = fs.readFileSync(path.join(HERE, 'settings-ui.js'), 'utf8');
  for (const k of ['crossChatEnabled', 'crossChatInPrivate', 'crossChatInGroup', 'crossChatIncludePrivate']) {
    ok(`⑲c 面板有 ${k} 的开关`, src.includes(`data-key="${k}"`), '');
  }
  ok('⑲c 面板写清了「私聊内容可作来源」的风险（不能只写一行字就放个勾）',
    src.includes('漏进群'), '');
}

// ── 收尾 ──────────────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 自己那一个目录，删不掉也不影响结论 */ }

if (failures.length) {
  console.error(`\n❌ memory-vec selftest：${failures.length} / ${checks} 项失败`);
  for (const f of failures) console.error(`   · ${f}`);
  process.exit(1);
}
console.log(`✅ memory-vec selftest：${checks} 项全过`);
