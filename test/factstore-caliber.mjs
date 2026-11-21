// test/factstore-caliber.mjs —— 聚合口径（`ADR-0007`，2026-10-09 拍板）
//
// 覆盖四件事：
//   ① resolveSlotRows 纯函数：evidence_n 最大者赢，平票取 rev 最新
//   ② open()：legacy 行（无 caliber 字段）也按口径选，不再是"最后一行赢"
//   ③ slotCredibility：evidence_n × legacy 0.5 折减（拍板：过往数据可信度调低）
//   ④ versionsOf(key)：全版本可查（"查找更多证据"），isWinner 标注
//
// 纪律：不 mock 存储 —— 用临时目录走**真 jsonl**（append-only 真值是本模块的根）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SLOT_CALIBER, LEGACY_CREDIBILITY_FACTOR, MULTI_ITEM_CRED,
  resolveSlotRows, slotCredibility, openFactStore
} from '../src/core/factstore.mjs';
import { factSlotKey } from '../src/core/facts.mjs';

const scopeStub = { scopeLabel: (ck) => `group:C${String(ck).replace(/\D/g, '') || '1'}` };
const K1 = factSlotKey('SELF', '〔P1〕', 'pattern', 'group:C1');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-caliber-'));
  return { dir, store: openFactStore(dir, { normalizer: scopeStub }) };
}

function writeRows(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'slots.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function legacyRow(over = {}) {
  return {
    key: K1, speaker: 'SELF', target: '〔P1〕', fact_kind: 'pattern', scope: 'group:C1',
    content: 'c', logic_version: '5', content_fingerprint: `fp-${Math.random()}`,
    evidence_set_hash: 'esh', evidence_n: 1, rev: 1,
    derived_from: { pstamp: 'p', params: {}, rev: 1, at: '2026-10-09T00:00:00.000Z' },
    ...over
  };
}

test('resolveSlotRows：证据最大者赢；平票取 rev 最新（与遍历顺序无关）', () => {
  const rows = [
    legacyRow({ rev: 3, evidence_n: 2, content_fingerprint: 'c3' }),
    legacyRow({ rev: 1, evidence_n: 5, content_fingerprint: 'c1' }),
    legacyRow({ rev: 2, evidence_n: 5, content_fingerprint: 'c2' })
  ];
  const w = resolveSlotRows(rows);
  assert.equal(w.content_fingerprint, 'c2', 'evidence_n 平票 ⇒ rev 最大者（c2）赢，不是 c1 也不是最后一行 c3');
  assert.equal(resolveSlotRows([]), null);
});

test('open()：legacy 行按口径选（推翻"最后一行赢"的旧口径）', () => {
  const { dir, store } = tmpStore();
  // 故意让**最后写入的行**证据最少 —— 旧口径会选它，新口径不许
  writeRows(dir, [
    legacyRow({ rev: 1, evidence_n: 4, content: '证据多的判断' }),
    legacyRow({ rev: 2, evidence_n: 1, content: '最后写入的弱判断' })
  ]);
  const reopened = openFactStore(dir, { normalizer: scopeStub });
  assert.equal(reopened.slots.get(K1).content, '证据多的判断', '赢家 = 证据最多的行');
  assert.equal(reopened.versionsOf(K1).length, 2, '全版本都留档');
});

test('slotCredibility：legacy 行打 0.5 折；口径行足额', () => {
  const legacy = legacyRow({ evidence_n: 4 });
  const fresh = legacyRow({ evidence_n: 4, caliber: SLOT_CALIBER });
  assert.equal(slotCredibility(legacy), 2, `legacy ×${LEGACY_CREDIBILITY_FACTOR}`);
  assert.equal(slotCredibility(fresh), 4, '带 caliber 的行足额');
  assert.equal(slotCredibility(null), 0);
});

// ── 多值槽的可信度（`ADR-0044` / `MULTI_ITEM_CRED`）─────────────────────────
//
// 为什么单列一组：多值槽的 `evidence_n` 是**哨兵值恒 1**（为了 latest-wins，
// 见 `resolveSlotRows`），它已经不是真实证据量了 ⇒ 再拿它当排序权重就是双重惩罚。
// 这一组钉死"改按方面数计价"以及它**不波及单值槽**。
test('slotCredibility：多值槽按方面数计价，而非恒 1 的 evidence_n', () => {
  const mk = (n) => ({
    evidence_n: 1, caliber: SLOT_CALIBER,
    content: { items: Array.from({ length: n }, (_, i) => ({ k: `方面${i}`, v: 'x' })) }
  });
  assert.equal(slotCredibility(mk(1)), MULTI_ITEM_CRED, '1 个方面 = MULTI_ITEM_CRED');
  assert.equal(slotCredibility(mk(3)), MULTI_ITEM_CRED * 3, '3 个方面线性累加');
  // 单值槽（无 items）**逐字不变** —— 这条防的是"顺手把所有槽的权重都抬了"
  assert.equal(slotCredibility({ evidence_n: 1, caliber: SLOT_CALIBER, content: { text: 'x' } }), 1);
  assert.equal(slotCredibility({ evidence_n: 7, caliber: SLOT_CALIBER, content: { text: 'x' } }), 7);
});

test('slotCredibility：多值槽取「方面数」与「evidence_n」的较大者，legacy 同样折减', () => {
  // 已有真实证据（如整理产出 evidence_n=40）时不能被方面数**拉低**
  const rich = {
    evidence_n: 40, caliber: SLOT_CALIBER,
    content: { items: [{ k: '整体', v: 'x' }] }
  };
  assert.equal(slotCredibility(rich), 40, '`max(base, items×K)`：高证据不被压下来');
  const legacyMulti = {
    evidence_n: 1,
    content: { items: [{ k: 'a', v: 'x' }, { k: 'b', v: 'y' }] }
  };
  assert.equal(slotCredibility(legacyMulti), 2 * MULTI_ITEM_CRED * LEGACY_CREDIBILITY_FACTOR,
    'legacy 多值槽同样 ×0.5');
});

test('versionsOf：rev 升序 + isWinner 标注 + legacy 标注（"查找更多证据"）', () => {
  const { dir, store } = tmpStore();
  writeRows(dir, [
    legacyRow({ rev: 2, evidence_n: 3, content_fingerprint: 'w' }),
    legacyRow({ rev: 1, evidence_n: 1, content_fingerprint: 'x' })
  ]);
  const vs = openFactStore(dir, { normalizer: scopeStub }).versionsOf(K1);
  assert.deepEqual(vs.map((v) => v.rev), [1, 2], 'rev 升序');
  assert.equal(vs.find((v) => v.rev === 2).isWinner, true);
  assert.equal(vs.find((v) => v.rev === 1).isWinner, false);
  for (const v of vs) assert.equal(v.legacy, true, '手写的行没有 caliber ⇒ legacy');
});

test('put()：新行带 caliber；证据更少的新行**不会**把旧赢家顶掉', () => {
  const { dir, store } = tmpStore();
  writeRows(dir, [legacyRow({ rev: 5, evidence_n: 6, content_fingerprint: 'strong' })]);
  const reopened = openFactStore(dir, { normalizer: scopeStub });
  const r = reopened.put({
    speaker: 'SELF', target: '〔P1〕', fact_kind: 'pattern', chatKey: '1',
    content: '新判断但只有一条证据', evidenceIds: ['e1']
  });
  assert.equal(r.action, 'update');
  assert.equal(reopened.slots.get(K1).content_fingerprint, 'strong',
    '旧赢家（6 条证据）仍是当前快照 —— 新行证据少，不顶掉');
  assert.equal(reopened.versionsOf(K1).length, 2, '但新行已落档可查');
  const fresh = reopened.versionsOf(K1).find((v) => v.caliber === SLOT_CALIBER);
  assert.ok(fresh, '新行带 caliber 标记');
  assert.equal(fresh.legacy, false);
});

test('put()：证据更多的新行**会**赢（口径正向工作）', () => {
  const { store } = tmpStore();
  store.put({ speaker: 'SELF', target: '〔P1〕', fact_kind: 'pattern', chatKey: '1', content: '少', evidenceIds: ['e1'] });
  store.put({ speaker: 'SELF', target: '〔P1〕', fact_kind: 'pattern', chatKey: '1', content: '多', evidenceIds: ['e1', 'e2', 'e3'] });
  assert.equal(store.slots.size, 1, '同槽');
  assert.equal(store.get(K1)?.content, '多');
});

test('verify()/stats() 与口径共存：槽数 = 键数（不是行数）', () => {
  const { dir, store } = tmpStore();
  writeRows(dir, [legacyRow({ rev: 1 }), legacyRow({ rev: 2, evidence_n: 9, content_fingerprint: 'w' })]);
  const reopened = openFactStore(dir, { normalizer: scopeStub });
  assert.equal(reopened.count, 1);
  assert.equal(reopened.verify().ok, true, JSON.stringify(reopened.verify().problems));
});
