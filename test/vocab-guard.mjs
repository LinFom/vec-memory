// test/vocab-guard.mjs —— 身份面的纯标点守卫（2026-10-09 实测教训）
//
// 事故：有群友的昵称就叫 `...`。它被身份扫描注册成词条 ⇒ 任何含省略号的正文都触发
// NORMALIZE_LEAK（findLeak 认得它），而替换层又换不掉纯标点词条 ⇒ force 重建 fail-closed 卡死。
// 修法：`touch()` 只收「至少含一个字母/汉字/数字」的 surface。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildVocabulary } from '../src/core/vocab.mjs';

function fixture(messages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-vocab-'));
  fs.mkdirSync(path.join(dir, 'messages-cold'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ botName: '测试机器人' }), 'utf8');
  fs.writeFileSync(
    path.join(dir, 'messages-cold', 'group_1.json'),
    JSON.stringify([{ time: Date.now(), senderId: 'u1', senderName: '张三', text: '你好', self: false }, ...messages.map((m) => ({ time: Date.now(), ...m }))]),
    'utf8'
  );
  return dir;
}

test('纯标点昵称（...）不进词表 —— 否则省略号全文变泄漏', () => {
  const dir = fixture([
    { senderId: 'u2', senderName: '...', text: '谢谢', self: false },
    { senderId: 'u3', senderName: '。。。', text: '好的', self: false }
  ]);
  const vocab = buildVocabulary({ dataDir: dir });
  const surfaces = vocab.entities.flatMap((e) => e.surface);
  for (const bad of ['...', '。。。']) {
    assert.ok(!surfaces.includes(bad), `surface 里不许有纯标点「${bad}」；实际：${JSON.stringify(surfaces)}`);
  }
  assert.ok(surfaces.includes('张三'), '正常昵称照常收录');
});

test('带字母/汉字/数字的混合昵称（哦鲸鲸...）保留 —— 只挡纯标点', () => {
  const dir = fixture([{ senderId: 'u4', senderName: '哦鲸鲸...', text: '在吗', self: false }]);
  const vocab = buildVocabulary({ dataDir: dir });
  const surfaces = vocab.entities.flatMap((e) => e.surface);
  assert.ok(surfaces.includes('哦鲸鲸...'), '含汉字的昵称（尾巴带省略号）照常收录');
});
