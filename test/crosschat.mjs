// test/crosschat.mjs — 跨会话近况（ADR-0043）
//
// 这一层全是**静默失败**形态，必须逐条钉住：
//   · 没排除当前会话 ⇒ 她把"自己刚说的话"再念一遍（看起来像记忆，实际是回声）；
//   · 私聊当了来源 ⇒ 私聊内容进群，是社死级泄露，而注入本身不会报错；
//   · 时间窗/条数/字符没夹住 ⇒ 提示词被一整段聊天记录撑爆，且只在账单上涨时才发现；
//   · 空结果不说理由 ⇒ "群里没人说话"与"存档读不到"在提示词里长得一模一样。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectCrossChatRecent, renderCrossChatLines, cleanMessageText, isMediaOnlyText } from '../src/core/crosschat.mjs';
import { renderCombinedBlock } from '../src/core/inject.mjs';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function mkRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-crosschat-'));
  fs.mkdirSync(path.join(d, 'messages'));
  return d;
}
function writeChat(root, chatKey, rows) {
  const name = chatKey.replace(':', '_') + '.json';
  fs.writeFileSync(path.join(root, 'messages', name), JSON.stringify({ chatKey, messages: rows }));
}
function msg(minAgo, senderName, text, over = {}) {
  return { ts: NOW - minAgo * MIN, senderId: senderName, senderName, text, self: false, ...over };
}

test('当前会话必须被排除 —— 否则她会把刚说的话当"别处的动静"再念一遍', () => {
  const root = mkRoot();
  writeChat(root, 'group:111', [msg(1, '甲', '我刚在群里说的话')]);
  writeChat(root, 'group:222', [msg(2, '乙', '别的群在聊')]);
  const { sources } = collectCrossChatRecent({ dataDir: root, now: NOW, excludeChatKey: 'group:111' });
  assert.deepEqual(sources.map((s) => s.chatKey), ['group:222']);
  assert.ok(!JSON.stringify(sources).includes('我刚在群里说的话'));
});

test('时间窗：窗口外的原话不算"近况"', () => {
  const root = mkRoot();
  writeChat(root, 'group:222', [msg(30, '乙', '半小时前的旧话')]);
  const r = collectCrossChatRecent({ dataDir: root, now: NOW, excludeChatKey: 'group:111', minutes: 10 });
  assert.equal(r.sources.length, 0);
  assert.equal(r.reason, 'no-fresh-other-chat', '空结果必须带理由，不能静默返回空气');

  const wide = collectCrossChatRecent({ dataDir: root, now: NOW, excludeChatKey: 'group:111', minutes: 60 });
  assert.equal(wide.sources.length, 1, '窗口放宽后同一条又能看见 —— 证明上面挡它的是窗口不是别的');
});

test('私聊默认不当来源；显式 includePrivate 才放行', () => {
  const root = mkRoot();
  writeChat(root, 'private:999', [msg(1, '甲', '私聊里的悄悄话')]);
  const off = collectCrossChatRecent({ dataDir: root, now: NOW, excludeChatKey: 'group:111' });
  assert.equal(off.sources.length, 0, '默认**绝不**把私聊内容带进别的会话');

  const on = collectCrossChatRecent({ dataDir: root, now: NOW, excludeChatKey: 'group:111', includePrivate: true });
  assert.equal(on.sources.length, 1);
  assert.equal(on.sources[0].kind, 'private');
});

test('maxChats 按"最近活跃"截断，不是按文件名', () => {
  const root = mkRoot();
  writeChat(root, 'group:111', [msg(1, '甲', '当前群')]);
  writeChat(root, 'group:222', [msg(3, '乙', '较早的群')]);
  writeChat(root, 'group:333', [msg(1, '丙', '最新的群')]);
  writeChat(root, 'group:444', [msg(2, '丁', '中间的群')]);
  const { sources } = collectCrossChatRecent({ dataDir: root, now: NOW, excludeChatKey: 'group:111', maxChats: 2 });
  assert.deepEqual(sources.map((s) => s.chatKey), ['group:333', 'group:444']);
});

test('maxChars：每个来源会话的文本不超上限（且不会截出半条记录）', () => {
  const root = mkRoot();
  const long = '这是一句很长的原话，用来撞字符上限，看看会不会把整段提示词撑爆。';
  writeChat(root, 'group:222', [msg(5, '乙', long), msg(4, '丙', long), msg(3, '丁', long)]);
  const { sources } = collectCrossChatRecent({ dataDir: root, now: NOW, excludeChatKey: 'group:111', maxChars: 60 });
  assert.equal(sources.length, 1);
  assert.ok(sources[0].chars <= 60, `实际 ${sources[0].chars} 字，超了上限`);
  assert.ok(sources[0].text.length <= 60);
});

test('空目录 / 目录不存在：三种"没有"理由要分开', () => {
  const root = mkRoot();
  const empty = collectCrossChatRecent({ dataDir: root, now: NOW, excludeChatKey: 'group:111' });
  assert.equal(empty.reason, 'messages-dir-empty', '一条存档都没有 ≠ 有存档但没新鲜内容');

  writeChat(root, 'group:111', [msg(1, '甲', '当前群自己的话')]);
  const noFresh = collectCrossChatRecent({ dataDir: root, now: NOW, excludeChatKey: 'group:111' });
  assert.equal(noFresh.reason, 'no-fresh-other-chat', '只有当前会话有新鲜内容 ⇒ 也算"没有别的"');

  const missing = collectCrossChatRecent({ dataDir: path.join(root, 'nope'), now: NOW });
  assert.equal(missing.reason, 'messages-dir-unreadable');
});

test('一行消息 → 一行文本：换行压平、空文本用媒体占位', () => {
  assert.equal(cleanMessageText({ text: '第一行\n第二行\t 第三行' }), '第一行 第二行 第三行');
  assert.equal(cleanMessageText({ text: '', media: [{ kind: 'image' }] }), '[图片]');
  assert.equal(cleanMessageText({ text: '   ' }), '');
  // 采集时关掉占位：纯媒体行返回空串（调用方据此跳过，避免"她以为自己看见了图"）
  assert.equal(cleanMessageText({ text: '', media: [{ kind: 'image' }] }, 60, { mediaPlaceholder: false }), '');
});

test('渲染：标题写分钟数、来源写成 群「名字」、没有来源就返回空数组', () => {
  const lines = renderCrossChatLines([{ kind: 'group', name: 'Samara家庭', text: '甲：在吗' }], 10);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /最近 10 分钟/);
  assert.match(lines[0], /群「Samara家庭」：甲：在吗/);
  assert.deepEqual(renderCrossChatLines([], 10), []);
});

test('self 行显示为"我"，别人显示名字（拿不到名字退 id 也不错位）', () => {
  const root = mkRoot();
  writeChat(root, 'group:222', [msg(2, '乙', '别群的话', { self: true }), msg(1, '丙', '接一句')]);
  const { sources } = collectCrossChatRecent({ dataDir: root, now: NOW, excludeChatKey: 'group:111' });
  assert.match(sources[0].text, /我：别群的话/);
  assert.match(sources[0].text, /丙：接一句/);
});

test('纯媒体行不收 —— 她看不到那张图，念进提示词只会让她编「我看到图了」', () => {
  const root = mkRoot();
  writeChat(root, 'group:222', [
    msg(3, '乙', '', { media: [{ kind: 'image' }] }),   // 空文本 + media 数组
    msg(2, '丁', '[图片]'),                              // 平台把占位写进了 text（实测两种都有）
    msg(1, '丙', '这句有字')
  ]);
  const { sources } = collectCrossChatRecent({ dataDir: root, now: NOW, excludeChatKey: 'group:111' });
  assert.ok(!sources[0].text.includes('[图片]'), sources[0].text);
  assert.match(sources[0].text, /丙：这句有字/);
  assert.equal(isMediaOnlyText('[图片][图片]'), true);
  assert.equal(isMediaOnlyText('[图片] 顺带说一句'), false);
});

test('合成块：哨兵只出现一次、跨会话段排在最后、没有它时输出与旧版逐字相同', () => {
  const profile = [{ who: '林枫', line: '年龄=21岁' }];
  const attr = [{ who: '林枫', line: '喜欢猫娘百合' }];
  const cross = renderCrossChatLines([{ kind: 'group', name: 'Samurai', text: '甲：在吗' }], 10);

  const withCross = renderCombinedBlock({ profileLines: profile, lines: attr, crossChatLines: cross });
  assert.equal(withCross.split('<!--mv-inject-->').length - 1, 1, '哨兵只能有一个 —— 宿主靠它判重');
  assert.ok(withCross.indexOf('【档案') < withCross.indexOf('【人格属性'), '档案在前');
  assert.ok(withCross.indexOf('【人格属性') < withCross.indexOf('【别处动静'), '跨会话段必须在最后');

  // 不传 crossChatLines ⇒ 与 0.29.0 的输出逐字相同（老用例钉的是这个形状）
  const old = renderCombinedBlock({ profileLines: profile, lines: attr });
  assert.equal(old, '<!--mv-inject-->\n'
    + '【档案（长期固定特征，悄悄参考，不要主动提及）】\n- 林枫：年龄=21岁\n\n'
    + '【人格属性（来自长期记忆，悄悄参考，不要主动提及）】\n- 林枫：喜欢猫娘百合');
});
