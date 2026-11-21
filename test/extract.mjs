// M4 抽取**前置段** · 单元测试（纯函数，不联网、不读存档、不调 LLM）。
//
// 断言的是 `ADR-0010` 决定 4 那**三道护栏 + 三个触发条件**真的可执行，
// 且**口径是 `ADR-0018` 更正之后的**：
//   ① 句长下限 = **有效字符**（不再是"CJK 字"）—— 否则 `I love you` 被静默拦掉
//   ② 相似度 = **剥标点后**的 Jaccard —— 否则 `你好，在吗` 与 `你好在吗` 配不上
//   ③ 逐字相同 = 口头禅单列 —— 用**原始**文本（与 ② 两版并存）
//   ④ 触发条件 3 = **最密窗口 ≥ N** —— 不是"首末跨度 ≤ horizon"
// 以及一条**身份纪律**：簇的粒度是 `(speaker, target, scope)` ——
//   同一句话在两个会话里**不许**并进同一簇（否则 `scope` 白进了键）。
//
// 运行：node test/extract.mjs

import {
  cjkCount, contentCharCount, passesSentenceFloor, isVerbatim, stripScaffold,
  normalizeForSimilarity, ngrams, jaccard, classifyPair,
  clusterCandidates, densestWindow, shouldTrigger,
  SENTENCE_FLOOR_CHARS, SIMILARITY_THRESHOLD, TRIGGER_N, PRAGMATIC_VERSION,
  SCAFFOLD_LABELS
} from '../src/core/extract.mjs';
import { PRAGMATIC_VERSION as EDGES_PRAGMATIC_VERSION, extractAtTargets, entityLabel } from '../src/core/edges.mjs';
import { Normalizer, MEDIA_MARKER_LABELS } from '../src/core/normalize.mjs';
import { ok, tally } from './lib/_helpers.mjs';

const sec = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 46 - t.length))}`);

// ── 0. 版本纪律 ─────────────────────────────────────────────────────────
sec('版本纪律（阈值即逻辑）');
ok(PRAGMATIC_VERSION === EDGES_PRAGMATIC_VERSION, 'extract **不另写**版本号，与 edges 同一个');
ok(PRAGMATIC_VERSION === 7, '`ROADMAP #97` 已 bump 到 7（候选条目的 target 启用 ⇒ **判定输入变了**：簇粒度 `(speaker,scope)`→`(speaker,target,scope)`）', `= ${PRAGMATIC_VERSION}`);

// ── 1. 句长下限（护栏 ①）────────────────────────────────────────────────
sec('句长下限（护栏 ①：≥ 4 有效字符，ADR-0018）');
ok(cjkCount('今天天气不错') === 6, 'CJK 字数计数正确（旧口径保留）', `= ${cjkCount('今天天气不错')}`);
ok(cjkCount('P7722') === 0, '占位符**不计**入 CJK 字数', `= ${cjkCount('P7722')}`);
ok(cjkCount('abc123') === 0, 'ASCII / 数字**不计**入 CJK 字数（旧口径）');
ok(cjkCount('你好啊abc') === 3, '混合文本只数 CJK 部分', `= ${cjkCount('你好啊abc')}`);

ok(contentCharCount('I love you') === 8, '★ 拉丁：`I love you` ⇒ 8 个有效字符', `= ${contentCharCount('I love you')}`);
ok(contentCharCount('666666') === 6, '★ 数字：`666666` ⇒ 6 个有效字符', `= ${contentCharCount('666666')}`);
ok(contentCharCount('OKOKOK') === 6, '★ 拉丁：`OKOKOK` ⇒ 6 个有效字符', `= ${contentCharCount('OKOKOK')}`);
ok(contentCharCount('你好啊') === 3, '中文：3 个有效字符', `= ${contentCharCount('你好啊')}`);
ok(contentCharCount('〔P7722〕') === 0, '★ 占位符**先剥掉**再数（`〔P7722〕` 只是"关于谁"）', `= ${contentCharCount('〔P7722〕')}`);
ok(contentCharCount('你好😭！') === 2, 'emoji / 标点**不计**入有效字符', `= ${contentCharCount('你好😭！')}`);
ok(contentCharCount('') === 0, '空串 ⇒ 0');

ok(passesSentenceFloor('在吗啊') === false, '3 字 ⇒ **不过**下限');
ok(passesSentenceFloor('在吗啊啊') === true, '4 字 ⇒ 过下限');
ok(passesSentenceFloor('I love you') === true, '★ `I love you` 现在**过**（旧口径被静默拦掉）');
ok(passesSentenceFloor('OKOKOK') === true, '★ `OKOKOK` 现在**过**');
ok(passesSentenceFloor('OK') === false, '`OK`（2）仍不过 —— 短填充词照拦');
ok(passesSentenceFloor('〔P7722〕') === false, '★ 纯点名（占位符）**不过** —— 它不是"说了什么"');
ok(passesSentenceFloor('I love you', 4, { counter: 'cjk' }) === false, '`counter:"cjk"` 保留旧口径（对照用）');
ok(passesSentenceFloor('好', 1) === true, '下限可下调（min=1）');
ok(passesSentenceFloor('') === false, '空串 ⇒ 不过');
ok(SENTENCE_FLOOR_CHARS === 4, '常数初值 = 4（名字已随语义改）');

// ── 2. 逐字相同 = 口头禅（护栏 ③，**原始**文本）──────────────────────────
sec('逐字相同 = 口头禅（护栏 ③，用原始文本）');
ok(isVerbatim('在吗在吗', '在吗在吗') === true, '逐字相同 ⇒ true');
ok(isVerbatim('在吗在吗', '  在吗在吗  ') === true, '两端空白不影响判定');
ok(isVerbatim('在吗？', '在吗') === false, '**标点不同不算相同**（"逐字"就是逐字）→ 留给护栏 ② 处理');
ok(isVerbatim('你好', '你们') === false, '一字之差 ⇒ false');

// ── 3. 相似度（护栏 ②，**剥标点**）───────────────────────────────────────
sec('相似度：剥标点后的字符 n-gram Jaccard（ADR-0018 决定 2）');
ok(normalizeForSimilarity('你好，在吗') === '你好在吗', '剥标点：`你好，在吗` ⇒ `你好在吗`');
ok(normalizeForSimilarity('a b\nc') === 'abc', '剥空白');
ok(normalizeForSimilarity('你好😭！') === '你好😭', '**标点剥、emoji 留**（emoji 是情绪内容）');
ok(jaccard('真的吗', '真的吗') === 1, '完全相同 ⇒ 1.0');
ok(jaccard('今天天气好', '他在打游戏') === 0, '完全不同 ⇒ 0.0');
ok(jaccard('', '') === 0, '两边都空 ⇒ **0**（不是 1：都没说话 ≠ 说的一样）');
ok(jaccard('啊', '啊啊啊啊') === 0, '单字无二元组 ⇒ 0（已被句长下限挡住）');
ok(jaccard('你好，在吗', '你好在吗') === 1, '★ 实测旧口径 = 0.400 ⇒ 现在 = **1.0**（标点不再拆簇）');
ok(jaccard('你好，在吗', '你好！！！在吗') === 1, '★ 实测旧口径 = 0.286 ⇒ 现在 = **1.0**');
ok(jaccard('在吗？', '在吗') === 1, '★ 实测旧口径 = 0.500 ⇒ 现在 = **1.0**');
const j1 = jaccard('我真的好喜欢你', '我真的好喜欢他');
ok(j1 > 0.7, '近义变体 ⇒ 高相似（剥标点不影响无标点的对）', `= ${j1.toFixed(3)}`);
ok(Math.abs(jaccard('甲甲甲乙', '乙乙乙甲') - jaccard('乙乙乙甲', '甲甲甲乙')) < 1e-12, 'Jaccard **对称**');
ok(ngrams('a b\nc', 2).has('ab') && !ngrams('a b\nc', 2).has('a '), 'n-gram 先剥空白');
ok(ngrams('一二三四', 3).size === 2, 'n 可调（3 元组 ⇒ 2 个）');
ok([...ngrams('你好😭在吗', 2)].every((g) => [...g].length === 2), '★ 按**码点**切：每个 n-gram 都是 2 个码点（emoji 不被劈开）',
  `size=${ngrams('你好😭在吗', 2).size}`);
ok(ngrams('你好😭在吗', 2).has('😭在'), '★ emoji 后面的 n-gram 正常（旧实现会切出半个代理对）');

sec('classifyPair —— 单一决策点（两版文本的分工）');
ok(classifyPair('在吗在吗', '在吗在吗').kind === 'verbatim', '逐字 ⇒ verbatim');
ok(classifyPair('我真的好喜欢你', '我真的好喜欢他').kind === 'similar', '近义 ⇒ similar');
ok(classifyPair('今天天气好', '他在打游戏').kind === 'different', '无关 ⇒ different');
ok(classifyPair('在吗？', '在吗').kind === 'similar', '★ 标点差异 ⇒ **similar**（不是 verbatim：不构成"逐字相同"）');
ok(classifyPair('在吗？', '在吗？').kind === 'verbatim', '★ 两版并存：同带标点且逐字相同 ⇒ still verbatim');
ok(classifyPair('今天天气好', '他在打游戏', { threshold: 0 }).kind === 'similar', '阈值可调（0 ⇒ 全相似）');
ok(SIMILARITY_THRESHOLD === 0.6, '阈值初值 = 0.6（ADR-0010 决定 4）');
ok(classifyPair('在吗在吗', '在吗在吗').jaccard === 1, 'verbatim 的 jaccard 记为 1');

// ── 3b. 结构脚手架（护栏①②③ 都要剥；ADR-0018 决定 4）────────────────────
sec('结构脚手架：引用块 / @ / 媒体标记（三处都剥）');
ok(stripScaffold('[引用 〔P1〕：今天好累] 嗯').trim() === '嗯', '引用块整体剥掉（含**被引用的原话**）');
ok(stripScaffold('[引用 〔R〕 〔P1〕：走了] 乙 等等').trim() === '乙 等等', '带引用锚点 `〔R〕` 的形态');
ok(stripScaffold('@〔P1234〕 你说啥').trim() === '你说啥', '提及标记 `@〔P…〕` 剥掉');
ok(stripScaffold('〔MENTION〕 在吗').trim() === '在吗', '`〔MENTION〕` 剥掉');
ok(stripScaffold('[图片] 哈哈哈哈').trim() === '哈哈哈哈', '媒体标记 `[图片]` 剥掉');
ok(stripScaffold('[image] 哈哈哈哈').trim() === '哈哈哈哈', '媒体标记 `[image]` 剥掉');
ok(stripScaffold('[重要] 记得买票').includes('[重要]'), '★ **不误剥**：正文里的普通方括号原样保留（只列已知脚手架形态）');

ok(contentCharCount('[引用 〔P1〕：今天好累] 嗯') === 1, '★ 引用内容**不虚增**句长（实际只说了"嗯"）', `= ${contentCharCount('[引用 〔P1〕：今天好累] 嗯')}`);
ok(passesSentenceFloor('[引用 〔P1〕：今天好累] 嗯') === false, '★ ⇒ 一条**纯附和**不再冒充"够长的表达"');
ok(isVerbatim('[引用 〔P1〕：甲] 嗯', '[引用 〔P2〕：乙丙丁] 嗯') === true, '★ 只有引用不同 ⇒ 仍算**逐字相同**（口头禅）');
ok(isVerbatim('[引用 〔P1〕：甲] 你好？', '[引用 〔P2〕：乙] 你好') === false, '★ 但**标点差异仍算不同**（两版并存没被破坏）');
const jSc = jaccard('[引用 〔P1〕：今天好累] 我明白你的意思', '[引用 〔P2〕：别的] 我明白你的意思');
ok(jSc === 1, '★ 同内容、不同引用 ⇒ 相似度 = 1（旧口径会被共享脚手架误导）', `= ${jSc.toFixed(3)}`);
ok(jaccard('嗯嗯嗯嗯', '[图片] 嗯嗯嗯嗯') === 1, '媒体标记不影响相似度');
ok(normalizeForSimilarity('[图片] 你好，在吗') === '你好在吗', '相似度版：脚手架 + 标点都剥');

// ── 3c. 占位符也是脚手架（ADR-0018 决定 6：`〔MENTION〕` 剥、`〔MEDIA〕` 不剥没有道理）──
sec('占位符并入脚手架（决定 6：按〔…〕结构剥，不逐形态枚举）');
ok(stripScaffold('〔MEDIA〕 哈哈').trim() === '哈哈', '`〔MEDIA〕` 剥掉（原来只剥 `〔MENTION〕` —— 不对称）');
ok(stripScaffold('在吗〔T20〕在吗') === '在吗 在吗', '`〔T20〕`/`〔D〕` 等时间占位符剥掉');
ok(isVerbatim('〔MEDIA〕在吗在吗在吗', '在吗在吗在吗') === true, '★ 带媒体与否**不再拆簇**（占位符不是"说的话"）');
ok(isVerbatim('在吗〔P1〕', '在吗') === true, '★ 行内占位符（"关于谁"）不影响逐字判定 —— 与 `@〔P1〕` 行为对齐');
ok(jaccard('〔MEDIA〕你好', '〔MEDIA〕你们') === 0, '★ 相似度不再被共享占位符字母托起来（构造例：旧口径 0.714）');
ok(classifyPair('在吗〔P1〕', '在吗').kind === 'verbatim', '★ 与 `@` 同规则：同句话对谁说都算同句话（target 在簇键里，不在文本里）');

// ── 3d. 白名单同步机制（对面追问 2 的落地：三层机制）─────────────────────
sec('白名单同步契约（单一来源 + 契约测试 + 形态闸门兜底）');
// 第一层：媒体标记表**单一来源** —— extract 引用 normalize 导出的同一清单，不手抄
{
  const src = SCAFFOLD_LABELS.split('|');
  const shared = MEDIA_MARKER_LABELS.split('|');
  const sameSource = shared.every((l) => src.includes(l));
  ok(sameSource, 'extract 的媒体标记白名单**包含** normalize 的 `MEDIA_MARKER_LABELS` 全部条目（单一来源，非手抄）',
    `normalize ${shared.length} 种 · extract ${src.length} 种`);
}
// 第二层：逐标记断言 —— normalize 认的每种标记，stripScaffold 都剥得掉
{
  const labels = MEDIA_MARKER_LABELS.split('|');
  let allStripped = true;
  for (const l of labels) if (stripScaffold(`[${l}] 好了`).trim() !== '好了') { allStripped = false; break; }
  ok(allStripped, `逐标记断言：${labels.length} 种媒体标记（含归一化侧认的每一种）全部剥掉`, labels.join(','));
}
// 第三层：**归一化产物残留断言** —— 真实管线（normalize → stripScaffold）后不许有结构残留。
// normalize 将来若新增一种脚手架产出而 extract 没跟上，只要它属于本 battery 覆盖的类别就会在这里炸。
{
  const nb = new Normalizer({ secret: 'test-extract-contract-0123456789abcdef' });
  const battery = [
    ['[CQ:at,qq=123] 在吗', '提及 CQ 码'],
    ['[引用 名字(QQ:1234)：今天好累] 嗯', '引用块（带硬 ID）'],
    ['[CQ:image,file=x.jpg] 看这个', '媒体 CQ 码'],
    ['[image] 看这个', '拍平媒体标记（英）'],
    ['[图片] 看这个', '拍平媒体标记（中）'],
    ['回复 #123 哈哈', '引用锚点 #N'],
    ['2026-10-08 20:15 在吗', '日期 / 时刻']
  ];
  let allClean = true;
  const dirt = [];
  for (const [raw, kind] of battery) {
    const out = String(nb.normalize(raw)?.text ?? '');
    const clean = stripScaffold(out);
    if (/引用|CQ:|〔|@/.test(clean)) { allClean = false; dirt.push(kind); }
  }
  ok(allClean, `归一化产物经 stripScaffold 后**零结构残留**（${battery.length} 类输入）`, dirt.length ? `残留:${dirt.join(',')}` : '');
}
ok(stripScaffold('[重要] 记得买票').includes('[重要]'), '**不误剥红线不变**：正文普通方括号仍保留（占位符的〔…〕是归一化器保留语法，护栏① 本来就剥，②③ 只是对齐）');

// ── 4. 聚类（粒度 = speaker × target × scope）───────────────────────────
sec('聚类：粒度 = (speaker, target, scope)');
const items = [
  { speaker: 'P1', target: 'P2', scope: 'group:C1', text: '我真的好喜欢你', id: 'm1', at: 1000 },
  { speaker: 'P1', target: 'P2', scope: 'group:C1', text: '我真的好喜欢他', id: 'm2', at: 2000 },
  { speaker: 'P1', target: 'P2', scope: 'group:C1', text: '我真的好喜欢她', id: 'm3', at: 3000 },
  { speaker: 'P1', target: 'P2', scope: 'group:C1', text: '在吗在吗在吗', id: 'm4', at: 4000 },
  { speaker: 'P1', target: 'P2', scope: 'group:C1', text: '在吗在吗在吗', id: 'm5', at: 4000 },
  { speaker: 'P1', target: 'P2', scope: 'group:C1', text: '在吗在吗在吗', id: 'm6', at: 4000 },
  { speaker: 'P1', target: 'P2', scope: 'group:C1', text: '短', id: 'm7' },          // 被下限丢掉
  { speaker: 'P1', target: 'P2', scope: 'private:C2', text: '我真的好喜欢你', id: 'm8', at: 5000 },
  { speaker: 'P9', target: 'P2', scope: 'group:C1', text: '我真的好喜欢你', id: 'm9', at: 5000 }
];
const { clusters, stats } = clusterCandidates(items);
ok(stats.input === 9, 'stats.input 正确', `= ${stats.input}`);
ok(stats.droppedByFloor === 1, '句长下限丢掉 1 条（"短"）', `= ${stats.droppedByFloor}`);
ok(clusters.length === 4, '聚出 4 簇（近义3 + 口头禅3 + 私聊1 + 另一说话人1）', `= ${clusters.length}`);
const big = clusters.find((c) => c.size === 3 && !c.verbatim);
const stut = clusters.find((c) => c.verbatim);
ok(!!big && big.memberIds.length === 3, '近义簇：3 条并到一起', `ids=${big && big.memberIds.join(',')}`);
ok(!!big && big.spanMs === 2000, '簇记录时间跨度 spanMs（仅展示）', `= ${big && big.spanMs}`);
ok(!!big && Array.isArray(big.times) && big.times.join(',') === '1000,2000,3000', '★ 簇带**升序 times**（触发条件 3 的输入）', `=${big && big.times}`);
ok(!!stut && stut.size === 3, '口头禅簇：3 条逐字相同 ⇒ 整簇 verbatim');
ok(clusters.filter((c) => c.scope === 'private:C2').length === 1, '**同文本、不同 scope ⇒ 分属不同簇**（scope 进键的落地）');
ok(clusters.filter((c) => c.speaker === 'P9').length === 1, '**不同 speaker ⇒ 不同簇**');
ok(stats.verbatimClusters === 1, 'stats 正确标出口头禅簇数', `= ${stats.verbatimClusters}`);
ok(clusters.filter((c) => c.size === 1).every((c) => c.verbatim === false), '**单条簇不是口头禅**（"反复"逐字相同才构成 —— 否则孤立表达被静默拦掉）');
ok(clusterCandidates(items, { keepVerbatim: false }).clusters.every((c) => !c.verbatim), 'keepVerbatim:false ⇒ 滤掉口头禅簇');
ok(clusterCandidates([]).clusters.length === 0, '空输入 ⇒ 无簇（不炸）');
ok(clusterCandidates(items).clusters[0].size >= clusterCandidates(items).clusters.at(-1).size, '簇按 size 降序');

// 标点变体现在能并簇（旧口径会拆成两簇）
const puncItems = [
  { speaker: 'P1', target: 'P2', scope: 'group:C1', text: '你好，在吗', id: 'p1', at: 100 },
  { speaker: 'P1', target: 'P2', scope: 'group:C1', text: '你好在吗', id: 'p2', at: 200 },
  { speaker: 'P1', target: 'P2', scope: 'group:C1', text: '你好！！！在吗', id: 'p3', at: 300 }
];
const pc = clusterCandidates(puncItems).clusters;
ok(pc.length === 1 && pc[0].size === 3, '★ 标点变体并成 **1 簇 / 3 条**（旧口径会拆成 3 簇，永远凑不满 N）', `= ${pc.length} 簇`);

// selfN：self=true 成员计数 —— 不排除、只标注（对面 0035 回复：speaker 混同风险的观测面）
const selfItems = [
  { speaker: 'S1', target: '', scope: 'group:C9', text: '在吗在吗在吗', id: 'sf1', at: 100, self: true },
  { speaker: 'S1', target: '', scope: 'group:C9', text: '在吗在吗在吗', id: 'sf2', at: 200, self: true },
  { speaker: 'S1', target: '', scope: 'group:C9', text: '在吗在吗在吗', id: 'sf3', at: 300, self: false },
  { speaker: 'S1', target: '', scope: 'group:C9', text: '在吗在吗在吗', id: 'sf4', at: 400 }
];
const scSelf = clusterCandidates(selfItems).clusters;
ok(scSelf.length === 1 && scSelf[0].selfN === 2, '★ 簇带 selfN（self=true 成员计数，缺省字段计 0）', `= ${scSelf[0] && scSelf[0].selfN}`);
ok(clusterCandidates([{ speaker: 'S2', target: '', scope: 'group:C9', text: '在吗在吗在吗', id: 'sf5', at: 100 }]).clusters[0].selfN === 0, '无 self 字段 ⇒ selfN=0（不炸不猜）');

// 脚手架：同内容、不同引用 ⇒ 仍并同簇；exemplar 存"剥了脚手架的内容"
const scItems = [
  { speaker: 'P1', target: '', scope: 'group:C1', text: '[引用 〔P1〕：甲] 我明白你的意思', id: 's1', at: 100 },
  { speaker: 'P1', target: '', scope: 'group:C1', text: '[引用 〔P2〕：乙丙丁] 我明白你的意思', id: 's2', at: 200 }
];
const sc = clusterCandidates(scItems).clusters;
ok(sc.length === 1 && sc[0].size === 2 && sc[0].verbatim === true,
  '★ 同内容、不同引用 ⇒ 并 1 簇，且判为**口头禅**（引用不是"说的话"）',
  `= ${sc.length} 簇 verbatim=${sc[0] && sc[0].verbatim}`);
ok(sc[0].exemplar === '我明白你的意思', '★ `exemplar` 存**剥脚手架后**的内容（原始串另存 `rawExemplar`）', `= ${sc[0].exemplar}`);
ok(clusterCandidates([{ speaker: 'P1', target: '', scope: 'group:C1', text: '[引用 〔P1〕：这是一段很长的被引用原话] 嗯', id: 's3' }]).stats.droppedByFloor === 1,
  '★ 纯附和（引用很长、自己只说"嗯"）被句长下限丢掉 —— 引用内容不再冒充内容');

// ── 5. 最密窗口（触发条件 3 的度量）────────────────────────────────────
sec('densestWindow —— "同一 horizon 窗口内 ≥ N 条"的字面落法');
ok(densestWindow([0, 1, 2], 2) === 3, '三点间距 ≤2 ⇒ 3');
ok(densestWindow([0, 100, 200], 2) === 1, '点都孤立 ⇒ 1');
ok(densestWindow([0, 1, 2, 3, 100, 101, 102], 3) === 4, '取**最密**那段 ⇒ 4（不是总数 7）');
ok(densestWindow([1000, 2000, 3000], 0) === 1, '窗口 0 ⇒ 只能装同一时刻的点');
ok(densestWindow([], 10) === 0, '空 ⇒ 0');
ok(densestWindow([5], 10) === 1, '单点 ⇒ 1');
ok(densestWindow([3, 1, 2], 2) === 3, '**乱序输入**也正确（内部先排序）');

// ── 6. 触发（三条件）────────────────────────────────────────────────────
sec('触发（size ≥ N ∧ 非口头禅 ∧ 最密窗口 ≥ N）');
ok(shouldTrigger(big).trigger === true, 'size 3、非口头禅 ⇒ **触发**（未给 horizonMs ⇒ 不查窗口）');
ok(shouldTrigger(stut).reason === 'VERBATIM_STUTTER', '口头禅簇 ⇒ **不触发**（护栏 ③）');
ok(shouldTrigger({ size: 2, verbatim: false, times: [] }).reason === 'SIZE_2_LT_3', 'size 2 < N ⇒ 不触发');
ok(shouldTrigger({ size: 5, verbatim: false, times: [0, 1, 2, 3, 4] }, { N: 6 }).trigger === false, 'N 可调');
ok(shouldTrigger(null).trigger === false, '空簇 ⇒ 不触发（不炸）');
ok(TRIGGER_N === 3, 'N 初值 = 3');
ok(TRIGGER_N === SENTENCE_FLOOR_CHARS - 1, '⚠️ N(3) 与句长下限(4)是**两个不同的数** —— 别把"建档阈值=N"记成"= 句长下限"',
  `N=${TRIGGER_N} · floor=${SENTENCE_FLOOR_CHARS}`);

sec('触发条件 3：窗口内 ≥ N（与"首末跨度"划清界限）');
const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
// ★ 关键回归：3 天内只有 3 条，但**其中 3 条挤在同一个小时内**。
const spread = { size: 3, verbatim: false, times: [0, HOUR / 4, HOUR / 2, 3 * DAY], spanMs: 3 * DAY };
ok(shouldTrigger(spread, { horizonMs: HOUR }).trigger === true,
  '★ **旧口径会漏**：首末跨度 3 天 > 1h ⇒ 旧实现判 OUT_OF_HORIZON；新实现看到"1h 内 3 条"⇒ **触发**');
ok(densestWindow(spread.times, HOUR) === 3, '  最密窗口 = 3（罪魁是那条 3 天前的旧实例）', `= ${densestWindow(spread.times, HOUR)}`);

ok(shouldTrigger({ size: 3, verbatim: false, times: [0, 100, 200] }, { horizonMs: 10 }).reason === 'WINDOW_1_LT_3',
  '真·窗口内不够 ⇒ 不触发，且 reason 写明差多少');
ok(shouldTrigger({ size: 3, verbatim: false, times: [0, 1, 2] }, { horizonMs: 2 }).trigger === true, '窗口内正好 3 ⇒ 触发');
ok(shouldTrigger({ size: 3, verbatim: false, times: [] }, { horizonMs: HOUR }).reason === 'NO_TIMESTAMPS',
  '★ **fail-closed**：没有时间戳 ⇒ 证不出"同窗"⇒ 不触发（且 reason 独立可见，不是静默）');
ok(shouldTrigger({ size: 3, verbatim: false }, { horizonMs: HOUR }).reason === 'NO_TIMESTAMPS',
  '连 `times` 字段都没有 ⇒ 同上（不炸、也不静默通过）');

// ★ 切窗不变性：同一批表达，无论调用方"一次全给"还是"按小时切三次给"，
//   判定结果必须一致 —— 这正是"最密窗口"相对"首末跨度"的核心好处。
const allAtOnce = { size: 4, verbatim: false, times: [0, HOUR / 2, HOUR, 5 * HOUR] };
ok(shouldTrigger(allAtOnce, { horizonMs: 2 * HOUR }).trigger === true,
  '★ 切窗不变性：一次全给 ⇒ 触发（1 个 2h 窗口装下 3 条）',
  `densest=${densestWindow(allAtOnce.times, 2 * HOUR)}`);

// ── 7. 「对谁」（target）回取：@ / 引用 ⇒ 实体 id（2026-10-12，`ROADMAP #97`）──
// 与边层**共用同一套正则**（`extractAtTargets`）—— 这条断言的存在就是为了钉住
// "不许有两份实现"：谁要是把它抄一份，边层与事实层的"谁 @ 了谁"就会各答一个数。
sec('「对谁」（target）：@ / 引用 回取（与边层共用）');
{
  const at = extractAtTargets('@甲[CQ:at,qq=1234567] 在吗');
  ok(at.ids.length === 1 && at.ids[0] === 'qq:1234567', '@ ⇒ 实体 id', JSON.stringify(at.ids));
  ok(at.atHits === 1 && at.quoteHits === 0, '计数：@ 1 次', `at=${at.atHits}/q=${at.quoteHits}`);

  // ⚠️ 已知边界：前置守卫只认**字面 `@`**（快速预筛），`[CQ:at,…]` 里本身没有 `@`。
  //    实测全库 24,493 条含 `[CQ:at,qq=]`，其中**无字面 @** 的仅 **26 条**，且全是
  //    机器人系统播报（`已禁言…` / `已加入黑名单…`）—— 会被 `isSystemMessage` 挡在
  //    候选之外，所以这条盲区对事实层**零影响**。钉在这里，免得日后被当成"漏了"。
  ok(extractAtTargets('只有[CQ:at,qq=1234567]没有字面 at 符号').ids.length === 0,
    '⚠️ 已知边界：无字面 `@` ⇒ 不扫（全库 26 条，全是系统播报，不影响候选）');

  const multi = extractAtTargets('@甲[CQ:at,qq=1111111] @甲[CQ:at,qq=1111111] @乙[CQ:at,qq=2222222]');
  ok(multi.ids.length === 2, '★ 同一人 @ 两次 ⇒ ids 去重（保序）', JSON.stringify(multi.ids));
  ok(multi.atHits === 3, '计数仍记 3 次命中（去重只作用于 `ids`）', `= ${multi.atHits}`);

  const qq = extractAtTargets('[引用 甲(QQ:3333333)：原话]');
  ok(qq.ids.length === 1 && qq.ids[0] === 'qq:3333333', '引用里的 `(QQ:n)` ⇒ 实体 id');

  const local = extractAtTargets('[引用 #12006 甲：原话] 回一句', {
    resolveLocalId: (n) => (n === '12006' ? 'qq:4444444' : null)
  });
  ok(local.ids.length === 1 && local.ids[0] === 'qq:4444444', '★ 引用 `#n` ⇒ 走反查回调', JSON.stringify(local.ids));
  ok(local.quoteHits === 1 && local.quoteUnresolved === 0, '反查成功 ⇒ `quoteHits` +1');

  const miss = extractAtTargets('[引用 #9 甲：原话]', { resolveLocalId: () => null });
  ok(miss.ids.length === 0 && miss.quoteUnresolved === 1, '★ 反查不到 ⇒ 计 `quoteUnresolved` 且**不产**目标（不猜）');

  const none = extractAtTargets('就是普通一句话，没有指向谁');
  ok(none.ids.length === 0 && none.atHits === 0 && none.quoteHits === 0, '无 @ / 引用 ⇒ 空（也不白跑正则）');
  ok(extractAtTargets('').ids.length === 0, '空串 ⇒ 空');

  // ⚠️ 一条真实样本：`[引用 #12006 归汐：…]@归汐[CQ:at,qq=1626861961] 会偷吃白饭`
  //    两种写法**可能**指同一个人。若反查出的 senderId 恰好就是 at 里的号 ⇒ 实体 id 相同、
  //    `ids` 自然去重成 1 条；若不同（引用的是甲、@ 的是乙）⇒ 两个目标，这是**对的**
  //    （回复甲、同时点名乙）。真正需要"占位符层再去重一次"的是**规范号 vs 别名**（见 §8）。
  const both = extractAtTargets('[引用 #12006 甲：话][CQ:at,qq=4444444] 回', {
    resolveLocalId: (n) => (n === '12006' ? 'qq:5555555' : null)
  });
  ok(both.ids.length === 2, '回复甲 + 点名乙 ⇒ 两个目标（不是一条）', JSON.stringify(both.ids));
}

// ── 8. 实体 → 占位符（`entityLabel`：与边层同一份映射，不许产生明文）──────────
sec('实体 → 占位符（entityLabel）');
{
  const nv = new Normalizer({ secret: 'extract-test-'.repeat(3) });
  nv.setVocabulary([
    { id: 'self', kind: 'self', surface: ['我'], aliases: ['qq:10001'] },
    { id: 'qq:20002', kind: 'person', surface: ['甲'] }
  ]);
  ok(entityLabel(nv, 'self') === 'SELF', '实体 id `self` ⇒ `SELF`', `= ${entityLabel(nv, 'self')}`);
  ok(entityLabel(nv, 'qq:10001') === 'SELF',
    '★ 别名 `qq:<机器人自己的号>` ⇒ **同一个** `SELF`（存档里 `[CQ:at,qq=<bot>]` 走这条）',
    `= ${entityLabel(nv, 'qq:10001')}`);
  const p = nv.labelById.get('qq:20002');
  ok(entityLabel(nv, 'qq:20002') === p, '已知实体 ⇒ 它自己的占位符', `= ${entityLabel(nv, 'qq:20002')}`);
  const unknown = entityLabel(nv, 'qq:99999999');
  ok(/^(X|P)\d+$/.test(unknown), '未知实体 ⇒ 临时占位符', `= ${unknown}`);
  ok(!unknown.includes('99999999'), '临时占位符里**不含**原号（不泄号）');
  ok(entityLabel(nv, '') === '', '空实体 ⇒ 空串（不猜）');

  // ★ 规范号 vs 别名 ⇒ **同一个**占位符。这正是 `backend.mjs` 构造候选时
  //   必须在**占位符层**再去重一次的原因：实体 id 不同、人却是同一个。
  const nv2 = new Normalizer({ secret: 'extract-test-'.repeat(3) });
  nv2.setVocabulary([{ id: 'qq:20002', kind: 'person', surface: ['甲'], aliases: ['qq:7777777'] }]);
  ok(entityLabel(nv2, 'qq:20002') === entityLabel(nv2, 'qq:7777777'),
    '★ 规范号与别名 ⇒ 同一个占位符（故 target 去重必须在占位符层做）',
    `${entityLabel(nv2, 'qq:20002')} / ${entityLabel(nv2, 'qq:7777777')}`);
}

// ── 9. 出境红线（本模块**不产生任何明文**）──────────────────────────────
sec('出境红线');
const out = JSON.stringify({ clusters, stats });
const leaks = out.match(/\b[1-9][0-9]{6,11}\b/g) || [];
ok(leaks.length === 0, '模块输出里**没有明文长数字**（占位符进、占位符出）', `命中 ${leaks.length}`);

console.log(`\n${'═'.repeat(64)}`);
console.log(`M4 抽取前置段：${tally.pass} 通过 / ${tally.fail} 失败`);
console.log('═'.repeat(64));
process.exit(tally.fail ? 1 : 0);
