// test/source-filter.mjs — 数据源筛选：机器产物不得进 judge 候选（`ADR-0038`）
//
// 为什么单独一个文件、而不是并进 `test/judge.mjs`：
// 这一层的失败形态**两头都是静默的**，`judge.mjs` 的旧用例（prompt 组装 / 出境断言 /
// 解析降级）一条都拦不住：
//   · **拦多了**：人类的真话被当成脚手架丢掉 ⇒ 簇变少、槽变少，看起来只是"记忆少了点"，
//     没有任何报错。`[引用 …：B站视频是吧，正在解析下载…]你怎么抢爱音的台词` 就是实测反例
//     —— 人类在吐槽机器人，整条必须留。
//   · **拦少了**：机器人自己的模板被当人类表达学下去 ⇒ 槽数量正常、注入正常，**只是内容是假的**
//     （A 号 29 条群槽里 6 条是机器人/插件的话，其中一条还被同时记成 pattern+event+promise）。
//
// 所以断言必须**双向**：每条模板既要证明"该拦的拦住了"，也要证明"长得像的人类文本留下来了"。
// 只验前一半 ⇒ 把 `classifySourceRejection` 改成恒返回 `'X'` 也能全绿（本仓栽过两次的形态）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySourceRejection, SCAFFOLD_TEMPLATES, MEDIA_VARIANT_RE, SYSTEM_MESSAGE_MARKERS
} from '../src/core/judge.mjs';

/** 造一条存档消息（只带筛选器读的字段）。 */
const msg = (text, over = {}) => ({ text, senderId: '12345', self: false, ...over });

// ── ① 回归锁：2026-10-17 实测的、**已经污染过槽**的真实文本 ───────────────────
//
// 这五条不是"想出来的坏消息"，是从 A 号 `slots.jsonl` 反向查回存档原文的现场证据。
// 它们的共同点：能过句长下限、能成簇、judge 真的学了。任何一条重新变成候选都算回归。

test('回归锁：已污染过槽的 5 条真实文本必须全部被拦', () => {
  const polluted = [
    ['B站视频是吧，正在解析下载，稍等～', 'MEDIA_FETCH_ACK'],   // P1669 的 pattern+event+promise 三合一
    ['抖音视频是吧，正在解析下载，稍等～', 'MEDIA_FETCH_ACK'],
    ['收到B站链接，我去下载一下，稍等哦～', 'MEDIA_LINK_ACK'],
    ['【防撤回】一条已撤回的消息（缓存未命中，由 get_msg 回查）：\n还有共犯转换', 'ANTI_RECALL'],
    ['给 沫钤 点了 20 个赞。', 'LIKE_BATCH']
  ];
  for (const [text, expect] of polluted) {
    assert.equal(classifySourceRejection(msg(text)), expect, `未拦住：${text}`);
  }
});

test('回归锁：槽里出现过的媒体变体（剥不掉的形态）必须被拦', () => {
  for (const text of ['[表情:饥饿]', '[音乐:NIGHT DANCER]', '[表情344]', '[表情包:嘿嘿]', '[表情:托腮]']) {
    assert.equal(classifySourceRejection(msg(text)), 'MEDIA_VARIANT', `未拦住：${text}`);
  }
});

test('回归锁：**触发簇里**抓到的机器人功能回执（第一批清单漏掉的）必须被拦', () => {
  // 这三条不是从槽里反查的，是过滤后重跑触发簇时逐条人工核对抓出来的
  // （`_scratch/probe-triggered-clusters.mjs`）—— 证明"定清单"要拿候选全量核对，
  // 只看已落库的槽会漏掉"还没被学进去但已经在候选里"的形态。
  assert.equal(classifySourceRejection(msg('还在努力下载中…（30 秒了）')), 'DOWNLOAD_PROGRESS');
  assert.equal(classifySourceRejection(msg('视频有点大，还在下…（已等待 30 秒）')), 'DOWNLOAD_PROGRESS');
  assert.equal(classifySourceRejection(msg('还在下载中…（已经等了 30 秒了）')), 'DOWNLOAD_PROGRESS');
  assert.equal(classifySourceRejection(msg('恋人（逆位）——失衡、选错、分离、价值观冲突')), 'TAROT_DRAW');
  assert.equal(classifySourceRejection(msg('今日已抽取　皇帝（逆位）——专制、僵化、失控、压力过大')), 'TAROT_DRAW');
  assert.equal(classifySourceRejection(msg('今日的赞已点满啦')), 'LIKE_QUOTA');
});

// ── ② 反向：人类真话不许被误伤（`[引用]` 里装脚手架是最危险的形态）──────────────

test('反向：含脚手架词但**是人类在说**的消息必须留', () => {
  const keep = [
    // 人类吐槽机器人的模板 —— 实测存在（`[引用 #116429 依山傍水：B站视频是吧…]`）
    '[引用 #116429 依山傍水：B站视频是吧，正在解析下载，稍等～]你怎么抢爱音的台词',
    // 人类说的"稍等"，与机器人的「正在解析下载，稍等～」同词不同源
    '稍等我去四群拉个消息记录',
    // 人类在讨论撤回功能本身
    '会自己撤回',
    '在市场上传插件漏说明书了可以撤回吗）',
    // 人类说"点赞"，与机器人回执「给 X 点了 N 个赞。」只差一个模板形状
    '24个赞！',
    '竖屏刷到点个赞就划走了',
    '我只能给沫老师点个赞了'
  ];
  for (const text of keep) {
    assert.equal(classifySourceRejection(msg(text)), '', `误伤：${text}`);
  }
});

test('反向：媒体标记 + 真话的混合消息必须留', () => {
  for (const text of ['[图片]重启了下服务器又这样了', '[表情24]今天好累', '[图片]怎么回事倒地是']) {
    assert.equal(classifySourceRejection(msg(text)), '', `误伤：${text}`);
  }
});

test('反向：**讨论**塔罗 / 下载进度的人类话语必须留（整条锚定才有这个性质）', () => {
  const keep = [
    '[引用 #1 某人：恋人（逆位）——失衡、选错、分离]这是啥意思，准吗',
    '我觉得塔罗牌的恋人逆位说得挺准的，失衡嘛',
    '还在下载中…这破网速（30 秒了）真的服了'
  ];
  for (const text of keep) {
    assert.equal(classifySourceRejection(msg(text)), '', `误伤：${text}`);
  }
});

test('反向：`[引用 …]` 单独一条不是媒体变体（别人的原话，不是占位符）', () => {
  assert.equal(classifySourceRejection(msg('[引用 #51095 浮生若梦：今天好累]')), '');
});

// ── ③ 与既有层不重叠、不冲突 ──────────────────────────────────────────────────

test('`SYSTEM_MARKER` 仍走原判据（平台事件 vs 机器人模板，原因码要能分开）', () => {
  const marker = SYSTEM_MESSAGE_MARKERS[0];
  assert.equal(classifySourceRejection(msg(`[${marker}]`)), 'SYSTEM_MARKER');
  // 同一个函数里两类原因不许混：模板必须报自己的 id
  assert.equal(classifySourceRejection(msg('【防撤回】xx')), 'ANTI_RECALL');
});

test('`self` 不参与判定（`ADR-0019` 观察项 #5：不排除、只标注）', () => {
  // 机器人账号自己发的**正常对话**照旧进候选 —— 只拦"文本能证明是模板"的那部分
  assert.equal(classifySourceRejection(msg('今天这个天气真是够了', { self: true, senderId: 'self' })), '');
  // 而它的模板化回复照样被拦（不靠 self 标志，靠文本形态）
  assert.equal(
    classifySourceRejection(msg('收到B站链接，我去下载一下，稍等哦～', { self: true, senderId: 'self' })),
    'MEDIA_LINK_ACK'
  );
});

test('空文本给独立原因码（不与"模板"混成一类）', () => {
  assert.equal(classifySourceRejection(msg('   ')), 'EMPTY');
  assert.equal(classifySourceRejection(undefined), 'EMPTY');
});

// ── ④ 模板清单自身的形态不变量 ────────────────────────────────────────────────

test('每条模板都是**整条锚定**（`^` 开头）且带证据', () => {
  assert.ok(SCAFFOLD_TEMPLATES.length >= 5);
  for (const tpl of SCAFFOLD_TEMPLATES) {
    assert.ok(tpl.id && tpl.re instanceof RegExp, `${tpl.id} 缺 id/re`);
    assert.ok(tpl.re.source.startsWith('^'), `${tpl.id} 未锚定开头 —— 会误伤引用块里的人类真话`);
    assert.ok(String(tpl.evidence || '').length > 0, `${tpl.id} 没有证据说明 —— 违反「按证据定清单」`);
    assert.match(String(tpl.evidence), /\d+\s*条/, `${tpl.id} 的证据里没有条数，等于没数过`);
  }
});

test('媒体变体正则只认**整条**，且不含 `引用` 这类会误伤人类文本的标签', () => {
  assert.ok(MEDIA_VARIANT_RE.source.startsWith('^'));
  assert.ok(MEDIA_VARIANT_RE.source.endsWith('$'));
  assert.equal(MEDIA_VARIANT_RE.test('[表情24]'), true);
  assert.equal(MEDIA_VARIANT_RE.test('[表情24]今天好累'), false);
  assert.equal(MEDIA_VARIANT_RE.test('[引用 某人：你好]'), false);
  assert.equal(MEDIA_VARIANT_RE.test('[重要]'), false);
});

test('模板 id 唯一（分布表才能当回看依据）', () => {
  const ids = SCAFFOLD_TEMPLATES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});
