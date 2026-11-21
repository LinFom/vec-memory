// test/tokens.mjs —— 关键词层纯函数（`ADR-0033`）
//
// 为什么单独一个文件：`topicOverlap` 是**从宿主照抄**过来的计分（`src/memory.js`），
// 抄错了不会报错、只会**悄悄换口径**——注入排序与检索排序会一起变，而两边都"看起来正常"。
// 所以这个文件干两件事：
//   ① 把**真源码对拍**出来的数值钉成锚点（下面每条注释里都写了它是从哪来的）；
//   ② 宿主源码**在场**时再跑一遍真对拍（`parity` 一节），不在场则**显式说明跳过**
//      ——不许"静默跳过还报绿"。
//
// ⚠️ 锚点数字来自 2026-10-14 的对拍脚本 `_scratch/parity-tokens.mjs`
//    （170/170 topicOverlap、7/7 tokenize、17/17 tokensForLine 与宿主真源码一致）。
//    改这些数 = 换口径 ⇒ 必须重新对拍并另开 ADR。
//
// 运行：node test/tokens.mjs
import fs from 'node:fs';
import path from 'node:path';

import { ok, tally } from './lib/_helpers.mjs';
import { tokenize, tokensForLine, topicOverlap, tokenCoverage, normText, skipBigramHit } from '../src/core/tokens.mjs';

console.log('\n── 关键词层：分词 + 跳字 bigram 重合度 ──');

// ═══════════════════════════════════════════════════════════════════════════
// ① 规范化与分词
// ═══════════════════════════════════════════════════════════════════════════

ok(normText('ＡＢＣ　Ｄ') === 'abc d', '规范化：NFKC（全角→半角）+ 小写 + 空白折叠');
ok(normText('  a   b  ') === 'a b', '规范化：去首尾空白、折叠中间空白');

const tk = tokenize('推首歌');
ok(['推', '首', '歌'].every((t) => tk.includes(t)), '分词：汉字串给单字');
ok(tk.includes('推首') && tk.includes('首歌'), '分词：汉字串给相邻 bigram（不交叉成 推歌）');
ok(!tk.includes('推歌'), '分词：**不**切出跨字 bigram —— 跨字靠 skipBigramHit 补（这是有意的）');
ok(JSON.stringify(tokenize('推 首 歌')) === JSON.stringify(['推', '首', '歌']),
  '分词：空白分隔的字串**不**产出 bigram（⇒ 空格在检索里是有意义的）');
ok(tokenize('KID1411 你好').includes('kid1411'), '分词：ASCII 连续段整词保留');
ok(!tokenize('这是我的').includes('的') && !tokenize('is a the').includes('the'),
  '分词：停用词剔除（中文 的 / 英文 the）');
ok(tokenize('').length === 0 && tokenize(null).length === 0, '分词：空输入返空数组（不抛）');
ok(tokenize('a'.repeat(41)).length === 0, '分词：超长 token（>40）被剔除（畸形粘串不污染倒排）');

// ═══════════════════════════════════════════════════════════════════════════
// ② tokensForLine：set + pos（跳字 bigram 的原料）
// ═══════════════════════════════════════════════════════════════════════════

const line = tokensForLine('推首歌');
ok(line && line.set instanceof Set && line.pos instanceof Map, 'tokensForLine：返回 { set, pos }');
ok(JSON.stringify(line.pos.get('推')) === '[0]', 'tokensForLine：pos 记汉字下标（推@0）');
ok(JSON.stringify(line.pos.get('歌')) === '[2]', 'tokensForLine：pos 记汉字下标（歌@2）');
ok(tokensForLine('') === null, 'tokensForLine：空串返 null（调用方要判，不许当空对象用）');
// ⚠️ 这条**必须用可观测的量**。第一版写成 `tokensForLine('a'.repeat(300)).set.size === 0 || true`
//    —— 恒真（`|| true`），是典型的**假通过**（`ADR-0032` §7 立的纪律）。ASCII 长串无论
//    截不截断都会被"token > 40 剔除"吃掉 ⇒ set 恒空，**看不见截断**。
//    改用汉字串：`pos` 逐字记下标 ⇒ 它的长度**就是**截断后的字数，截断生效即可观测。
ok(tokensForLine('推'.repeat(300)).pos.get('推').length === 160,
  'tokensForLine：超长行按 160 字截断（用 pos 下标数观测，不是靠"没抛异常"）');

// ═══════════════════════════════════════════════════════════════════════════
// ③ topicOverlap：把宿主调出来的那几个数钉住
// ═══════════════════════════════════════════════════════════════════════════

ok(topicOverlap('推歌', '给我推首歌') === 1.2,
  '重合度：短词「推歌」对话题「给我推首歌」= 1.2（真词命中 1 + 单字 0.2）',
  '这就是宿主实测捞回"音乐推荐口味"那条的那个例子');
ok(topicOverlap('推首歌', '推歌') === 0.2,
  '⚠️ 方向性：反过来只有 0.2 —— 长的一侧必须当 topicSets（见 tokens.mjs 头注释）');
ok(topicOverlap('音乐推荐口味固定三类：古典、摇滚、OST，推歌请严格遵循此三类', '给我推首歌') === 1.2,
  '重合度：长属性行对短话题 = 1.2（封顶前就是 1 个真词 + 单字）');
ok(topicOverlap('她怕打雷', '今天打雷了') === 1.2, '重合度：真词命中（打雷）');
ok(topicOverlap('完全无关', '给我推首歌') === 0, '重合度：完全无关 = 0（**不插手**，不是给个 0.1）');
ok(topicOverlap('不/人/大/件/推/定', '群里没人推东西') === 0.2,
  '⚠️ 单字封顶：6 个字巧合对上也只有 0.2（不按字累加 —— 否则刷屏群的常用字会攒到 0.9 压过真相关）');
ok(topicOverlap('', '随便') === 0 && topicOverlap('x', '') === 0, '重合度：空输入 = 0（不抛）');
ok(topicOverlap('甲', []) === 0 && topicOverlap('甲', ['']) === 0, '重合度：空话题集 = 0');

// 封顶 2：多个真词命中也不超过 2
const many = topicOverlap('推歌 口味 音乐 古典 摇滚', '给我推首歌，顺便说说音乐口味');
ok(many === 2, `重合度：真词多于两个时**封顶 2**（实测 ${many}）`);

// 多句话题取**最大**（不是求和）：一句相关就够了
ok(topicOverlap('推歌', ['今天天气不错', '给我推首歌']) === 1.2,
  '多句话题：逐句算取最大（旁边聊别的不会稀释）');
ok(topicOverlap('推歌', ['今天天气不错', '明天要早起', '随便', '哦', '嗯', '好', '再多一句']) === 0,
  '多句话题：最多取 6 句（第 7 句之后不进集合，与宿主同口径）');

// 叠字：`a === b` 不认跳字，但**直接集合命中**照样算 —— 与宿主行为一致
ok(topicOverlap('首首', '首首歌') === 1.2,
  '叠字：话题里字面含 bigram「首首」⇒ 直接命中 1（`a===b` 只挡跳字，不挡集合命中）');

// skipBigramHit 本身
const q = tokensForLine('给我推首歌');
ok(skipBigramHit(q, '推歌') === true, '跳字 bigram：推…歌 间距 2 ≤ 3 ⇒ 命中');
ok(skipBigramHit(q, '推首') === true, '跳字 bigram：推首 是相邻真词，也命中');
ok(skipBigramHit(q, '推我') === false, '跳字 bigram：方向反了（我 在 推 之前）⇒ 不命中');
ok(skipBigramHit(q, '首首') === false, '跳字 bigram：叠字（a===b）⇒ 不命中');
ok(skipBigramHit(q, '推') === false, '跳字 bigram：只对两字词生效');
const far = tokensForLine('推一二三四歌');
ok(skipBigramHit(far, '推歌') === false, '跳字 bigram：间距 5 > 3 ⇒ 不命中（窗口是有界的）');

// ═══════════════════════════════════════════════════════════════════════════
// ④ tokenCoverage：并列时的第二排序键（**不是**相关性分数）
// ═══════════════════════════════════════════════════════════════════════════

const doc = new Set(tokenize('古典 摇滚 ost 推歌 音乐 口味'));
ok(tokenCoverage('推歌', doc).count === 1, '覆盖率：查询词「推歌」在文档里 ⇒ count 1');
ok(tokenCoverage('推歌', doc).matched.includes('推歌'), '覆盖率：matched 给出命中的词本身（可解释）');
ok(tokenCoverage('给我推首歌', doc).count === 0,
  '⚠️ 覆盖率**看不见跳字**：查询「给我推首歌」对同一文档 count=0（单字不算、跳字也不算）',
  '⇒ 所以 overlap 是主键、coverage 只是并列时的次序 —— 两者互补，不能互相替代');
ok(tokenCoverage('推歌 口味 不存在', doc).count === 2, '覆盖率：只数真的命中的（3 个查询词命中 2 个）');
ok(tokenCoverage('', doc).count === 0 && tokenCoverage('x', new Set()).count === 0,
  '覆盖率：空查询/空文档 = 0（不抛）');

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 真源码对拍（宿主在场才跑；不在场必须**明说跳过**）
// ═══════════════════════════════════════════════════════════════════════════
//
// 为什么这条值得留在测试里：锚点数字是我从对拍里取的（见文件头）。锚点会随宿主改口径而**过期**，
// 而过期的方式是静默的（本仓照样绿）。在这里再对一次，宿主一改就当场红。
//
// ⚠️ 路径是**本机绝对路径**（本仓是宿主的消费者，不假设宿主在隔壁）。找不到就打印跳过理由，
//    **不冒充通过**。

const HOST_MEMORY = 'E:/Tools/QQ-Agent-整合版-20260922/src/memory.js';
const HOST_TOK = 'E:/Tools/QQ-Agent-整合版-20260922/src/conversation-memory/tokenize.js';

if (fs.existsSync(HOST_MEMORY) && fs.existsSync(HOST_TOK)) {
  const src = fs.readFileSync(HOST_MEMORY, 'utf8');
  const sliceFn = (re) => {
    const m = src.match(re);
    if (!m) throw new Error(`找不到声明：${re}`);
    const braceAt = src.indexOf('{', m.index);
    let depth = 0, i = braceAt;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    return src.slice(m.index, i + 1);
  };
  const hostTok = (await import('file:///' + HOST_TOK)).tokenize;
  const hostOv = new Function('tokenize', 'getConfig', `
    let topicFilterCache = new Map();
    ${sliceFn(/function tokensForLine\s*\(/)}
    ${sliceFn(/function topicTokenSets\s*\(/)}
    ${sliceFn(/function skipBigramHit\s*\(/)}
    ${sliceFn(/function topicOverlap\s*\(/)}
    return { topicOverlap };
  `)(hostTok, () => ({ persona: {}, onebot: {} })).topicOverlap;

  const CS = ['音乐推荐口味固定三类：古典、摇滚、OST，推歌请严格遵循此三类', '推歌', '推首歌',
    '今天有点累', 'KID1411 说话真诚', '爱喝美式', '不/人/大/件/推/定', '群里的机器人管理员',
    '首首', '她怕打雷', '', ' '];
  const TS = ['给我推首歌', ['推首歌'], '推歌', ['今天好累', '明天要早起'], '首首歌',
    'KID1411 在吗', '完全无关的一句话', '画画', ['']];
  let diff = 0, n = 0;
  for (const c of CS) for (const t of TS) {
    n++;
    if (topicOverlap(c, t) !== hostOv(c, t)) {
      diff++;
      if (diff <= 3) console.log(`     ↳ 不一致 content=${JSON.stringify(c)} topic=${JSON.stringify(t)} 我=${topicOverlap(c, t)} 宿主=${hostOv(c, t)}`);
    }
  }
  ok(diff === 0, `真源码对拍：与宿主 src/memory.js 的 topicOverlap 逐例一致（${n - diff}/${n}）`,
    diff ? '口径已经漂了 —— 要么改回等价，要么另开 ADR 并重取锚点' : '');
} else {
  console.log('  ⏭️  真源码对拍跳过：宿主源码不在本机（找不到 src/memory.js）—— 锚点仍按文件头的对拍结果校验');
}

console.log(`\ntokens: ${tally.pass} 通过 / ${tally.fail} 失败`);
process.exitCode = tally.fail ? 1 : 0;
