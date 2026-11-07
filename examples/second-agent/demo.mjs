// [by:WorkBuddy] 票 06：第二个 Agent 接入样例 —— CLI 研究笔记助手。
//
// 这是独立于任何聊天平台 / 宿主 / 第三方打包组件的一个小项目：它有自己的笔记数据
// 格式（notes.jsonl），只用 Node 标准库，并且只通过 vec-memory standalone 的公开
// v1 协议（/api/v1/）访问记忆服务。它不 import 服务内部模块，也不配置任何模型。
//
// 本脚本不是伪代码、不是 mock：在临时 root 上真实 initialize + 起一个 standalone
// HTTP 服务（127.0.0.1 随机端口），用真实 HTTP 依次跑通
//   POST /messages  ->  POST /recall  ->  POST /adoptions
// 三步，任一步失败以非零退出码结束；finally 关闭服务并清理临时目录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initialize} from '../../src/standalone/service.mjs';
import {createStandaloneServer} from '../../src/standalone/server.mjs';

const projectId = 'research-app';
const spaceId = 'research-notes';
const conversationId = 'research-session';
const scope = {kind: 'private', id: 'research-notebook'};

function loadNotes() {
  const raw = fs.readFileSync(new URL('./notes.jsonl', import.meta.url), 'utf8');
  return raw.split('\n').map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-second-agent-'));
  let runtime;
  try {
    const adminToken = initialize(root);
    runtime = createStandaloneServer({root});
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${runtime.server.address().port}`;

    const post = async (route, body) => {
      const response = await fetch(base + route, {
        method: 'POST',
        headers: {authorization: `Bearer ${adminToken}`, 'content-type': 'application/json'},
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) {
        throw new Error(`${route} -> HTTP ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
      }
      return data;
    };

    // 该助手的自有数据格式：把笔记适配成 v1 /messages 的原料（role=user 才能当证据）。
    // 服务不需要认识 notes.jsonl 的任何字段，只认公开协议里的消息形状。
    const notes = loadNotes();
    const messages = notes.map(note => ({
      messageId: note.noteId,
      conversationId,
      actorId: note.author,
      role: 'user',
      timestamp: note.createdAt,
      text: `${note.title}：${note.body}`,
      scope
    }));

    // 管理面：先建项目，再建空间（owner 必须是已存在的项目）。
    await post('/api/v1/admin/projects', {projectId});
    await post('/api/v1/admin/spaces', {spaceId, owner: projectId});

    // 第 1 步：提交真实研究笔记，证明另一个项目的自有数据可经公开写入口落地。
    const ingest = await post(`/api/v1/spaces/${spaceId}/messages`, {messages});
    if (ingest.ok !== true || ingest.accepted !== messages.length) {
      throw new Error(`messages 未全部接收：${JSON.stringify(ingest).slice(0, 400)}`);
    }
    console.error(`[1/3] messages：提交 ${messages.length} 条笔记，accepted=${ingest.accepted}`);

    // 第 2 步：召回。working 层会把同场合的消息无条件纳入 items，
    // 因此无需配置任何模型即可命中刚提交的笔记。
    const recall = await post(`/api/v1/spaces/${spaceId}/recall`,
      {scope, conversationId, query: '检索重排 导入幂等', actorIds: [notes[0].author]});
    const expected = messages.map(message => `message:${message.messageId}`);
    const matched = expected.every(id => (recall.items || []).some(item => item.localId === id))
      && typeof recall.block === 'string' && recall.block.includes(messages[0].text);
    if (recall.ok !== true || !matched || !recall.receiptId) {
      throw new Error(`recall 未命中笔记或未返回收据：${JSON.stringify(recall).slice(0, 500)}`);
    }
    console.error(`[2/3] recall：命中 ${recall.items.length} 项，receiptId=${recall.receiptId}`);

    // 关键语义：recall 的 block 只有「真正加入模型上下文」之后才能确认采用。
    // 真实 Agent 会在这一步把 block 拼进给 LLM 的请求；本样例用一个显式变量表示
    // 这个已发生的事实（不调用任何模型，保持零依赖、零外部费用）。
    const modelContext = `system: 你是研究笔记助手\n${recall.block}`;
    if (!modelContext.includes(recall.block)) throw new Error('block 未加入模型上下文');

    // 第 3 步：内容已进上下文，确认采用（显式确认收据内全部项）。
    const adoption = await post(`/api/v1/spaces/${spaceId}/adoptions`,
      {receiptId: recall.receiptId, itemIds: recall.items.map(item => item.id)});
    if (adoption.ok !== true || !(adoption.adopted > 0)) {
      throw new Error(`adoptions 未确认采用：${JSON.stringify(adoption)}`);
    }
    console.error(`[3/3] adoptions：adopted=${adoption.adopted}，replayed=${adoption.replayed}`);

    // 结构化结果：stdout 每行一个紧凑 JSON 对象，便于 node:test 逐行解析。
    const emit = value => console.log(JSON.stringify(value));
    emit({step: 'messages', ok: ingest.ok, accepted: ingest.accepted,
      duplicates: ingest.duplicates, rejected: ingest.rejected});
    emit({step: 'recall', ok: recall.ok, matched: true, items: recall.items.length,
      actualMode: recall.actualMode, receiptId: recall.receiptId, block: recall.block});
    // adopted 是对真实响应 {ok:true, adopted:N} 的归一化「采用已确认」结论；
    // 服务返回的原始计数保留在 adoptedCount，不伪造、不改写响应含义。
    emit({step: 'adoptions', ok: adoption.ok,
      adopted: adoption.ok === true && adoption.adopted > 0,
      adoptedCount: adoption.adopted, replayed: adoption.replayed});
  } finally {
    if (runtime) {
      runtime.server.closeAllConnections?.();
      await runtime.close();
    }
    fs.rmSync(root, {recursive: true, force: true});
  }
}

try {
  await main();
} catch (error) {
  console.error('second-agent demo 失败：', error);
  process.exitCode = 1;
}
