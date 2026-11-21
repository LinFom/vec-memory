// 断言 helper 一致性守卫 —— **C 收敛后版本**（2026-10-11）
//
// ## 这个守卫是怎么来的
//
// `ok()` 断言 helper 曾在 **15 个测试文件**里各自手抄。风险是**静默分叉**：有人改了
// 某一份的行为，其他份不知道，15 个文件全绿但测的不是同一个东西——`cjkCount` vs
// `extractTerms` 栽过的同款形态，只是搬到了测试代码层。守卫当时的职责是"提取全部副本、
// 比对行为指纹"，并在末尾用一条**到期探针**（副本数 < 15）把 C（收敛成共享模块）
// 的触发条件从"靠人记"变成"可检测"。
//
// **2026-10-11：探针到期，C 已落地。** 15 份副本 → 一份 `test/lib/_helpers.mjs`，
// 全部测试文件 import 它。**"行为一致"从此由构造保证，不再靠比对** —— 所以本文件
// 的职责随之从"比对 N 份副本"改写为"断言收敛状态没有被破坏"。纪律 2 明确要求
// C 的落地者连带改守卫，否则守卫会守着一个已经不存在的形态空转。
//
// ## 现在的 6 条断言
//
//   ① 归属完备：每个测试文件要么 import 共享模块，要么在 `NODE_TEST_ONLY` 名单里
//      （名单 = 用 `node:test` + `node:assert` 的文件，当前 13 个，逐条给理由）。漏网的当场点名。
//   ② 名单不腐：名单里的文件必须真的 `import ... from 'node:test'`（防止文件已被
//      改成 ok 流、名单却没更新 ⇒ 两边都不管）。
//   ③ **副本数 = 0**：任何测试文件都不许定义自己的 `ok`（`const/let/var ok`、
//      `function ok` 都算）。这条是收敛的**核心不变量**——原"第三形态扫描"升级而来：
//      以前只是"提取器认不到就报警"，现在是"根本不许存在"。
//   ④ 下界：import 共享模块的文件数 ≥ 15（当前盘点）。任何一份 import 丢失都触发——
//      不是"防提取器全失效"的 ≥1。合法收缩时更新此值并在 README 纪律 2 记一笔。
//   ⑤ 行为指纹 = 预期语义：**只探共享模块这一份**（✅/❌ 前缀、extra 拼接、
//      falsy 走失败分支）。这条仍必要——③ 保证"只有一份"，但那一份本身也可能被改坏。
//   ⑥ 导出面：共享模块必须同时导出 `ok` 与 `tally`（`ok` 记数、`tally` 读数的契约）。
//
// ## 守卫自己的守卫（突变验证手法，写在 `test/README.md` 纪律 2）
//
// 随便挑一个测试文件（如 `rank.mjs`），在末尾临时**声明一个同名 ok 常量**
// （本注释刻意不写出那个字面量——断言 ③ 只按源码文本匹配，注释里的字样**也会命中**。
//  这是有意的：宁可多报也不能漏报。想验的时候自己敲一行即可）
// ⇒ 跑本守卫**应当**红（断言 ③ 点名该文件）；还原 ⇒ 应当绿。
// 再验一次共享模块：把 `lib/_helpers.mjs` 的 `✅` 临时改成 `✔️`
// ⇒ 断言 ⑤ 应当红；还原 ⇒ 应当绿。
// 若改坏后仍绿，说明守卫失效——先修守卫再继续。
//
// 运行：node test/helpers-guard.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ok, tally } from './lib/_helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SHARED = path.join('lib', '_helpers.mjs');      // 唯一实现
const SHARED_IMPORT = `from './lib/_helpers.mjs'`;    // 唯一合法的 import 形态
/** 下界 = 当前盘点（15，2026-10-11 C 收敛时）。任何一份 import 丢失都触发。 */
const IMPORT_FLOOR = 15;

/**
 * 不参与共享 helper 契约的文件 —— 它们用 `node:test` + `node:assert`，
 * 没有 `ok` 流，因此**不存在**可收敛的副本。名单必须逐条给理由（纪律 2）。
 * ⚠️ 新增这类文件要同步登名单，否则断言 ① 会把它当"漏 import"报红（这是故意的）。
 */
const NODE_TEST_ONLY = new Map([
  ['natural-reminders.mjs', '自然日期、发言人归属、改期取消与重启后的原话过滤，node:test 管理真实隔离 worker'],
  ['event-reembedding.mjs', '事件向量来源缺失与显式重嵌的真实 worker 及 HTTP 端点验证'],
  ['llm-request.mjs', '整理模型思考模式的实际请求序列化与默认兼容行为，使用 node:test'],
  ['continuity.mjs', '角色念想及待办重启、可选备份和场合隔离，node:test 管理真实临时 worker'],
  ['temporal-memory.mjs', '时间事实迁移、当前位置和明确纠正的 node:test 真实存储验证'],
  ['portable-memory-data.mjs', 'Isolated snapshot and recall integration with node:test'],
  ['batch-four-memory.mjs', 'Isolated restart, restore and merge integration with node:test'],
  ['relationship-graph.mjs', 'node:test 临时库验证有向互动、精确来源、撤回与重复证据'],
  ['relationship-api.mjs', 'node:test 验证星图权限、已核对身份投影和历史任务暂停续跑'],
  ['standalone-embedding.mjs', '控制台嵌入来源白名单、健康探测及凭据边界，node:test 管理临时 HTTP 服务'],
  ['standalone-legacy-recall.mjs', '旧路由第三人称召回、关键词总限额与查询档案，node:test 隔离临时库'],
  ['standalone-third-person.mjs', '第三人称识别、关键词线索限额和跨场合档案权限，node:test 管理临时 worker 与模拟模型'],
  ['standalone-backup-contract.mjs', 'DSH 编写、主 Agent 独立复跑的 HTTP 加密备份、路径攻击、维护协调和中断导入恢复契约，node:test 管理临时服务'],
  ['standalone-upgrade.mjs', '场景修订、身份歧义、跨代来源与备份导入的 node:test 临时库验证'],
  ['standalone-discovery.mjs', '新事物自动发现的真实整理闭环、证据约束、别名歧义、候选和人工纠正，node:test 管理模拟模型与临时 worker'],
  ['standalone-subject-api.mjs', '新事物 HTTP 权限、场合隔离、共享撤销、人工修订重试和重启持久化，node:test 管理真实临时服务'],
  ['standalone-import.mjs', '离线快照转换后的真实 worker 加载验收：证据 ID、旧人物标签、事实与向量文档保留，移走宿主及快照后仍可召回；node:test 管理 worker 与临时目录'],
  ['standalone-service.mjs', '独立协议端到端凭据、多项目隔离、显式共享撤销、采用确认、HTTP 与持久任务恢复，使用 node:test 生命周期隔离临时目录与服务器'],
  ['agent-managed-service.mjs', '使用 node:test 启动独立服务和两个模拟宿主，验证共享服务的退出条件与锁清理'],
  ['standalone-migration.mjs', '离线旁置迁移与回退导出的持久正确性：完整资产、哈希漂移、外部原料与路径交叠拒绝，使用 node:test 临时目录且不定义本地 helper'],
  ['standalone-engine.mjs', '独立空间 worker 的真实消息、事实、检索与整理闭环及持久隔离，使用 node:test 管理 worker 和临时根目录'],
  ['standalone-history-index.mjs', '历史词法索引的建索引、覆盖度、按原话检索、原料增长后水位、重建任务与进度回传，node:test 管理临时库根与真实 worker'],
  ['settings-editor.mjs', '独立配置编辑的 node:test 验证：原文件保留、密钥不回显、CAS 冲突、写盘失败，以及真实 HTTP 来源和实例约束'],
  ['core-hardening.mjs', 'Isolated end-to-end identity, adoption, cancellation and generation contracts'],
  ['commit-integrity.mjs', 'Durable window and vector commits: node:test'],
  ['factstore-caliber.mjs', '聚合口径（ADR-0007）：用 node:test 子测试而非 ok 流'],
  ['inject.mjs', 'M2 注入选择器（ADR-0009）：纯函数，用 node:test 子测试'],
  ['inject-endpoint.mjs', '读侧端点 /inject：测**路由的参数收敛**（minScore 恒 NaN 那类 bug 纯函数层测不出），ADR-0028'],
  ['keywords.mjs', '关键词来源（ADR-0006）：用 node:test 子测试'],
  ['launcher.mjs', '启动器形态：读 .bat 文本断言不变量，用 node:test 子测试'],
  ['smoke.mjs', '工具链可用性（ADR-0002 前提）：用 node:test 子测试'],
  ['vocab-guard.mjs', '纯标点昵称守卫（ADR-0008）：用 node:test 子测试'],
  ['remember.mjs', '写侧端点 /remember：走 handleMemoryVec 验参数校验/占位符化/幂等，用 node:test 子测试'],
  ['instances.mjs', '多实例清单与总览端点 /instances：读侧永不抛 + 路径/self 口径 + 探活真查（ADR-0029），用 node:test 子测试'],
  ['trait.mjs', '固定特征档案层 /remember + /inject：并存/覆盖/latest-wins/独立配额都横跨"解析→落库→聚合→注入"四段，纯函数层盖不住（ADR-0031），用 node:test 子测试'],
  ['person.mjs', '人物卡 /person：按人聚合的只读视图 —— 索引只认 speaker、按 scope 分栏、三种"没东西"要可区分，全是 Python 层测不到的跨段性质（ADR-0032），用 node:test 子测试'],
  ['recall.mjs', '统一检索 /recall + /person?kinds=：长期（结构化事实）与近期（向量块）**分两段**返回、标签是封闭枚举（拼错 400）、`allKinds` 必须在过滤前统计 —— 全是"两套存储怎么被拼在一起看"的跨段性质，用 node:test 子测试'],
  ['crosschat.mjs', '跨会话近况（ADR-0043）：排除当前会话、私聊默认不当来源、时间窗/条数/字符三重夹子、三种"没有"理由要分开 —— 全是静默失败形态，用 node:test 子测试'],
  ['exact-search.mjs', '关键词层端点（ADR-0033）：/search 的 mode 三态与显式降级、派生倒排索引的生命周期（惰性/增量/作废/全扫兜底）、/inject 的 token 路与**独立量纲**门槛、/person?q= 的 vocab/facts 两路标注 —— 全是"函数被怎么用"上的毛病，纯函数层（test/tokens.mjs）全绿也挡不住，用 node:test 子测试'],
  ['merged-retire.mjs', '软删旁路 facts/merged.json + rebuildRequired 出口（ADR-0034）：过滤/回滚/自动解除/坏文件 fail-open，以及 /facts/merged 的读与写 —— 这一层的失败形态**全是静默的**（标了不存在的 key、旁路读不动看起来像"从没合并过"、applied 写成累加会漂移），只能靠端点/装配级断言逼出来，用 node:test 子测试'],
  ['caliber-governed.mjs', '口径管辖判据（2026-10-16）：`rebuildRequired`/`staleKeys` 必须只统计**判定产物**，直写槽（content.source=assistant-remember）不进处方 —— `staleKeys()` 同时是 `retire-stale` 的处方，过滤漏在这里 = 命令盲杀直写事实，而重判**补不回来**（两者 key 空间不相交）。失败形态是"数字看起来正常、数据静默消失"，纯函数层测不到，用 node:test 子测试'],
  ['inject-scope.mjs', '属性段的场合策略（ADR-0037）单向闸门：失败形态全是**静默**的 —— 私密内容上浮照样"注入成功、条数正确只是内容社死"；跨场合候选挤掉同场合候选时条数也不变。断言必须双向（挡住 + 留下），否则把整段注入真空化也能全绿，用 node:test 子测试'],
  ['source-filter.mjs', '数据源筛选：机器产物不得进 judge 候选（ADR-0038）—— 两头都是静默失败：拦多了只是"记忆少了点"（人类真话被当脚手架丢掉、没有任何报错），拦少了是"槽数量正常、注入正常只是内容是假的"。断言必须双向（每条模板拦住 + 长得像的人类文本留下），否则把筛选器改成恒真/恒假都能全绿，用 node:test 子测试'],
  ['adapter-checkpoint.mjs', '记忆检查点（0.25.0，#102 写侧触发）：被测对象是**宿主** plugins/memory-vec/index.js（实现与仓内 adapters 手抄副本分离，宿主不在时整组 skip 是登记在案的边界）。失败形态全是静默的：该触发不触发 = 注入静默缺席；不该触发却触发 = 群里刷系统消息。断言必须双向（到点触发 + 没到点不触发 + 工具轮不计数 + 清零生效 + 开关关死），且每用例独立子进程 + 临时数据目录（宿主 getConfig() 有进程内缓存，同进程改配置不生效）'],
  ['consolidate.mjs', '事件整理（M5，2026-10-22）：窗口切分/游标推进/事件幂等/人物印象落库，用 node:test 子测试。失败形态全是静默的 —— 窗口切在"正在聊"的当口（话题被劈成两半）、LLM 挂了却推进游标（那一段**永久丢失**且没有任何报错）、事件 id 不确定（重跑写两遍，同一件事念两次）、认不出 QQ 却退回昵称（槽挂在一个谁也认不出的人身上）。断言必须双向（推进/不推进、写/不写、重复/不重复），否则把游标改成无条件推进也能全绿'],
  ['event-index.mjs', '短期层关键词索引（ADR-0048 ④）：IDF 打分的成败**只看排序口径**，不看"能不能搜到" —— 单字不做 df 惩罚就会靠"不/人/大"顶满所有事件、分母不记"库里根本没有的词"会让一句无关话拿到满分 1.0、会话隔离漏一条就是把私聊的事念到群里（社死级且不报错）。这些全是"数值看起来正常、顺序已经错了"的形态，用 node:test 子测试（断言里直接读 score/matched）'],
  ['preview-purity.mjs', '票 03 预演纯度（2026-10-28 · [by:DS]）：预演是全库唯一"故意把真实管线跑一半"的功能 —— 它调模型、读账本、渲染候选，与正式路径逐行相同，**只差最后那行写入**。这种结构读代码判断不可靠：差的那一行可能藏在另一条分支里（评审 F03 正是"成功分支有不落盘保护、失败分支照写失败计数并推进游标"）。判据只能是**前后快照比对**（hits.jsonl 在不在、facts 写入器被调用几次），所以用 node:test 子测试 + t.after 清临时根'],
  ['recall-person-filter.mjs', '票 08 按人检索先筛后取（2026-10-28 · [by:DS]）：F09 的失败形态是**假空** —— `/recall?who=目标` 返回 0 条，看起来像"从没记过"，而底层明明能返回。差别只在**顺序**（先取 Top-K/6×K/500 条再筛 vs 先筛后取），纯函数层测的是"分数对不对"、看不见"候选集怎么来的"。每条都带**反向对照**（用改前口径做同一件事必须为空），否则数据造得太温柔时改不改都能绿。又要造 505 条块才能压住 500 边界，用 node:test 的 t.after 管临时根'],
  ['offline-restore.mjs', '票 01 离线备份/恢复验收矩阵（2026-10-29 · [by:DS]）：失败形态**全是静默的** —— 上一版 offline-verify 的判据是"没抛异常"，于是"哈希全对、内容全坏、缺活动代"能拿到 exit=0 / verdict=ok。判据只能是**独立进程 + 真实 loader**：同进程 import 进去就没有"退出码"这回事，而退出码正是自动化恢复唯一会看的东西。本文件只把 tools/offline-restore-drill.mjs 的 40 条矩阵钉进 npm test，并**钉死用例清单**（矩阵全绿但用例被删光，退出码照样是 0）与复审点名的每种失败形态'],
  // ⚠️ 下面两条是**主 Agent（GPT-6A）新增的文件**，登记由 DS 代填（2026-10-29，[by:DS]）：
  //    它们落地时没同步本名单，守卫因此报红（归属完备）。清理门禁不该 blocker 别人的活儿，
  //    但理由必须是真的 —— 已按文件里的实际用例标题填写，**请主 Agent 复核措辞**。
  ['memory-core-v1.mjs', '核心 evaluator 家族（visibility/CAS/隐藏/来源/主体观察，主 Agent 新增）：断言的是"重放与幂等之后读数不变""隐藏后机器重放不能复活""存储失败必须留住窗口"这类**跨段且静默**的性质，用 node:test 子测试'],
  ['memory-core-api.mjs', '核心 API 面（管理读/策略/主体观察，主 Agent 新增）：断言"改一处能同时影响 person/recall/inject""实例不符与畸形变更必须在写之前失败"，同属只能靠端点级断言才看得见的形态，用 node:test 子测试'],
  // ⚠️ 下面两条由 DS（本文件执行者）新增并自带理由（2026-10-29 · [by:DS]）：
  ['event-api.mjs', '新 07 读侧：事件检索 / 事件分页 / 人物场合映射（2026-10-29 · [by:DS]）。失败形态**全是"看着正常"的** —— 事件用覆盖率分数、块用余弦，混进一个数组排序之后没人能解释顺序；换过滤条件还用旧游标会把两个筛选集拼成"每页都对、合起来有重有漏"；账本翻页途中变了却不报 = 静默漏页；`scopeLabel` 是单向 HMAC，硬"猜"chatKey 就是把别人的场合挂到这个人名下。判据只能是端点级 + 两页拼起来做全集比对，纯函数层全绿也挡不住，用 node:test 子测试'],
  ['facts-evidence.mjs', '/facts/evidence 来源视图（2026-10-29 · [by:DS]）：它的失败形态是**过度声称** —— 结构上像 exact 就回 exact（窗口级来源被当成消息级精确出处），或账本读不动时把"没核对上"升级成"已确认"。只能靠"真实整理产出的槽 + 真账本"来验（`/remember` 直写的槽**没有**来源引用，正好做反向对照），用 node:test 子测试'],
  ['tombstone-flush.mjs', '同 id 重嵌的墓碑与压缩（ADR-0059 · 2026-10-29 · [by:DS]）：失败形态是"**条数完全正确、数据已经错位**" —— 压缩重排 slot，写错一维也能让 `alive` 前后相等；而不落墓碑那一侧更阴，`_load` 的隐式去重会把旧行置 null 兜住，于是"检索不重复"照样成立，只有**直接读盘上 `meta.jsonl` 的行状态**（多少 alive 行、多少 deleted、有无同 id 双 alive）和逐条 `sourceHash`+向量 sha256 对拍才看得见。判据必须落在文件上，不能落在内存读数上，用 node:test 子测试'],
  ['query-budget.mjs', '主动查询的嵌入预算（2026-10-29 · [by:DS]）：改成"默认 30s + 重试 2 次"在功能上**完全正常**，只会在网络慢时让用户多等三四秒 —— 判据只能是**量时间**（单次预算 vs 退避重试的总耗时把两者分开）加稳定错误码。另有一个只在装配层暴露的坑：一个进程只有一个 runtime（模块级单例），"每个用例起一套环境"的写法会让第二个用例其实还在用第一个的端点，所以本文件只建一套环境、用桩端点的 mode 切换行为'],
  ['event-api.mjs', '新 07 读侧：事件检索 / 事件分页 / 人物场合映射（2026-10-29 · [by:DS]）。失败形态**全是"看着正常"的** —— 事件用覆盖率分数、块用余弦，混进一个数组排序之后没人能解释顺序；换过滤条件还用旧游标会把两个筛选集拼成"每页都对、合起来有重有漏"；账本翻页途中变了却不报 = 静默漏页；`scopeLabel` 是单向 HMAC，硬"猜"chatKey 就是把别人的场合挂到这个人名下。判据只能是端点级 + 两页拼起来做全集比对，纯函数层全绿也挡不住，用 node:test 子测试'],
  ['compact-tool-path.mjs', '`--compact` 的统计对象（主审 P2 · 2026-10-29 · [by:DS]）：这个 bug 的失败形态是"**输出看起来一切正常**"——它量的是库根那份旧库的 vectors.bin，压缩活代时数字纹丝不动，人只会得出"压缩没省空间"的结论，而真正被改的文件从未被展示。判据只能落在**脚本对用户打印什么**（压缩目标代 / 实际文件路径 / 字节数）与**库根那份是否逐字节未变**上，纯函数层与内存读数都看不见，所以用真实子进程跑工具 + node:test 子测试'],
  ['event-carry-identity.mjs', '事件向量搬运的来源身份判定（主审 `batch-followup-acceptance.md` 2026-10-29 · [by:DS]）：被驳回的是**自证循环**——搬运时用 `settings.embedModel` 与当前 `encoding` 重写标签，于是"目标标签 == 目标 index"必真，任何只在这两层里打转的测试都会全绿而缺陷原样存在。所以判据必须落在三处它到不了的地方：① 6 项身份逐字段三态（尤其"同维度换模型""同模型换 endpoint/normalizer"——维度相同极易被当成兼容）；② `planEventCarry` 对 unknown 默认 fail-closed 而不是默认放行；③ **源码级断言** `targetStore.put` 块里不再出现 `settings.embedModel` 且不传 `encoding`（前两类测试证明不了 `runIndex` 真按 plan 落盘，有人把标签改回去会全绿复活）'],
  // ⚠️ 下面 8 条是 2026-11-07 从开源公开版 feat/memory-interop-rerank 移植过来的新功能专项，
  //    由 [by:WorkBuddy] 登记。它们一律使用 node:test + node:assert/strict，不碰 ok() 流，
  //    所以不存在可收敛的手抄副本；理由按各文件实际用例标题填写，不是占位。
  ['event-gist.mjs', '票 07 事件回指：evidenceIds 派生 / 引文三重校验 / unattributed 兜底，以及真值层与 vector-active 源码守卫；纯函数与源码文本断言，用 node:test 子测试'],
  ['import-contract.mjs', '票 01 通用记忆导入契约：受限 schema 子集、白名单外关键字 fail-closed、1 合法 / 6 非法样例、字段清单与 schema 双向对齐；离线只读校验器，用 node:test 子测试'],
  ['import-contract-document.mjs', '票 02 导入计划端到端：真实起 standalone HTTP 服务，验 JSONL→契约→确定性计划→提交、recall 命中、未核验台账、幂等 replayed、断网重入；失败形态是静默漏写，只能靠真实链路，用 node:test 管临时根'],
  ['inject-exposure.mjs', '票 03 注入级曝光降权：跨轮稳定 lineId、soft 降权不排除、候选==配额时相对顺序不变；断言必须双向（降权发生 + 强相关仍在前），用 node:test 子测试'],
  ['quality-regression.mjs', '票 05 质量回归：before/after 快照与历史基线逐字可比、三态零外部模型请求、精排不可用时回落票 03 原序；直接驱动导出的 applyRecallPolicy，用 node:test 子测试'],
  ['recall-policy.mjs', '票 03 多信号重排策略层：RRF / 归一化加权 / 曝光降权，以及 C7「/search 恰好四条召回路径、每处都 await」的源码守卫；分支数必须从路由表反向盘点，用 node:test 子测试'],
  ['rerank-backend.mjs', '票 04 外部精排客户端：stub 五情形、响应形状兼容、配置严格性、超时与连续降级内存熔断、四处白名单源码守卫；I/O 不渗纯函数层，用 node:test 子测试'],
  ['second-agent.mjs', '票 06 第二个 Agent 接入样例：真实起服务跑 messages→recall→adoptions，并断言样例不含平台专名、只走公开 v1；证明协议解耦，用 node:test 子测试']
]);

// ── 提取：共享模块里的 ok 声明（只此一份）────────────────────────────────────

// ⚠️ 下面两处返回值用**字符串拼接**而不是模板串，是为了让本文件源码里不出现
//    `const ok =` / `function ok(` 这两个**字面量**——断言 ③ 是对全部测试文件（含本文件）
//    做纯文本匹配的，写了字面量就会自己把自己报红（实测踩过一次）。
//    这是"宁可多报不许漏报"的代价，登记在此。

/** 从源码提取 ok helper 的**完整声明**（可直接放进函数体）。 */
function extractOk(src) {
  // 形态 A：const ok = (params) => {...};   —— 捕获到**行首**的 "};"
  let m = src.match(/const\s+ok\s*=\s*(\([\s\S]*?\n\})\s*;/);
  if (m) return 'const ' + 'ok = ' + m[1] + ';';
  // 形态 B：function ok(params) {...}   —— 捕获到**行首**的 "}"
  m = src.match(/function\s+ok\s*\(([^)]*)\)\s*\{([\s\S]*?\n\})/);
  if (m) return 'function ' + 'ok(' + m[1] + ') {' + m[2];
  return null;
}

/** 在隔离作用域重建 helper，返回一个可调用的工厂。 */
function sandbox(fnLiteral) {
  return new Function('console', `
    const tally = { pass: 0, fail: 0 };
    ${fnLiteral}
    return {
      call: (...args) => { ok(...args); return { pass: tally.pass, fail: tally.fail }; }
    };
  `);
}

// ── 行为指纹（只探共享模块，见头注释 ⑤）──────────────────────────────────────

const PROBES = [
  [true, 'X', 'E'],   // 通过 + extra
  [true, 'X'],        // 通过，无 extra（默认参数路径）
  [0, 'X'],           // falsy 数字必须走失败分支
  ['', 'X']           // falsy 字符串同上
];
const GOLD_LABELS = ['  ✅ X  E', '  ✅ X', '  ❌ X', '  ❌ X'];

function fingerprint(fnLiteral) {
  const logs = [];
  const fake = { log: (s) => logs.push(String(s)), error: (s) => logs.push(String(s)) };
  const sandboxed = sandbox(fnLiteral)(fake);
  for (const p of PROBES) sandboxed.call(...p);
  return JSON.stringify(logs);
}

// ── 扫描 ────────────────────────────────────────────────────────────────────

/**
 * 抹掉**注释**（纯 `//` 行、单行 `/* … *​/`、以及整段 `/** … *​/` 块）。
 *
 * 为什么要这一步：断言 ③ 是纯文本匹配，而**本文件自己的注释**必须引用那个字面量
 * 才能把规矩说清楚 ⇒ 不抹的话守卫会自己把自己报红（旧版登记为"注释不排除，真出现时
 * 红得可解释、不修"；C 落地后守卫自己成了第 16 个 import 方，这条必须处理）。
 *
 * 为什么敢抹：一条**绑定创建**（`const/let/var/function` + 名字）不可能整行/整段
 * 活在注释里，所以抹掉的每一行都必然没有代码 ⇒ **抹不会漏报任何真实违规**。
 *
 * 只在**行首**进入块状态（行中间出现 `/*` 不当块开始）—— 这样"代码 + 行尾 `/*`"
 * 不会误吞后续真实代码（宁可多报，不可漏报）。
 * 代价：**行尾**注释（`ok(...); // const ok = …`）里的字面量仍会命中 —— 多报，有意的。
 */
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    const t = line.trimStart();
    if (t.startsWith('//')) continue;
    if (t.startsWith('/*')) {
      if (!line.includes('*/', line.indexOf('/*') + 2)) inBlock = true;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

console.log('\n── 断言 helper 守卫（C 收敛后 · test/README.md 纪律 2）──');

const files = fs.readdirSync(HERE)
  .filter((f) => f.endsWith('.mjs'))
  .sort();

const importers = [];
const listed = [];
const orphans = [];      // 既没 import 也不在名单
const localDefs = [];    // ③ 违反"副本数 = 0"
const staleList = [];    // ② 名单不腐

const LOCAL_OK_TOKEN = /\b(?:const|let|var)\s+ok\b|\bfunction\s+ok\b/;

for (const f of files) {
  const src = fs.readFileSync(path.join(HERE, f), 'utf8');

  // ③ 副本数 = 0：任何本地 ok 定义都算违规（含"第三种形态"）
  if (LOCAL_OK_TOKEN.test(stripComments(src))) localDefs.push(f);

  const importsShared = src.includes(SHARED_IMPORT);
  if (importsShared) importers.push(f);

  if (NODE_TEST_ONLY.has(f)) {
    listed.push(f);
    // ② 名单不腐：名单里的文件必须真的用 node:test
    if (!/from\s+'node:test'/.test(src)) staleList.push(f);
  } else if (!importsShared) {
    orphans.push(f);
  }
}

// ① 归属完备
ok(orphans.length === 0,
  '归属完备：每个测试文件要么 import 共享 helper，要么在 NODE_TEST_ONLY 名单里',
  orphans.length
    ? `漏网 ⇒ ${orphans.join(',')}（要么加 import，要么登名单并给理由，README 纪律 2）`
    : `import ${importers.length} + 名单 ${listed.length} = ${files.length} 个文件`);

// ② 名单不腐
ok(staleList.length === 0,
  `名单不腐：NODE_TEST_ONLY 的 ${NODE_TEST_ONLY.size} 个文件都真的 import 了 node:test`,
  staleList.length ? `已改走 ok 流却没移出名单 ⇒ ${staleList.join(',')}` : '');

// ③ 副本数 = 0（收敛的核心不变量）
ok(localDefs.length === 0,
  '副本数 = 0：没有测试文件再定义自己的 ok（收敛后不许回流）',
  localDefs.length
    ? `违规 ⇒ ${localDefs.join(',')}——改为 import './lib/_helpers.mjs'（README 纪律 2）`
    : `唯一实现：${SHARED}`);

// ④ 下界：import 份数 ≥ 当前盘点
ok(importers.length >= IMPORT_FLOOR,
  `下界：import 共享 helper 的文件 ${importers.length} ≥ ${IMPORT_FLOOR}（当前盘点）`,
  importers.length < IMPORT_FLOOR
    ? '低于盘点 ⇒ 有文件丢了 import（或改回了手抄）——README 纪律 2'
    : importers.join(','));

// ⑤ 行为指纹 = 预期语义（只探共享模块这一份）
const sharedSrc = fs.readFileSync(path.join(HERE, SHARED), 'utf8');
const lit = extractOk(sharedSrc);
ok(lit !== null, `共享模块 ${SHARED} 里能提取到 ok 声明`);
if (lit) {
  ok(fingerprint(lit) === JSON.stringify(GOLD_LABELS),
    '行为指纹 = 预期语义（✅/❌ 前缀、extra 拼接、falsy 走失败分支）');
}

// ⑥ 导出面：ok 记数、tally 读数 —— 两个都要有
ok(/\bexport\s+(?:function\s+ok|const\s+ok)\b/.test(sharedSrc) && /\bexport\s+const\s+tally\b/.test(sharedSrc),
  '导出面：共享模块同时导出 ok 与 tally（ok 记数 / tally 读数的契约）');

console.log(`\n守卫覆盖：${importers.length + listed.length}/${files.length} 个文件（触发 C 的 15 份副本已归零）`);

// ── 登记在案的边界（**不断言**，只报数）──────────────────────────────────────
// 拆仓时 `dryrun/panelcheck/preflight` 三份副本**随适配层迁出**本目录（本仓盘点 13 → 12），
// 当时的决定是"不纳入本守卫"。那是**有意的范围决定**，不是遗漏 —— 但它必须**可见**，
// 否则"唯一实现"这句话会变成假话。所以这里只数一下、只打印，不改判定。
// 详见 `test/README.md` 纪律 2 的"未覆盖边界"。
try {
  const adapterTestDir = path.join(path.resolve(HERE, '..'), 'adapters', 'qq-agent', 'test');
  const adapterFiles = fs.readdirSync(adapterTestDir).filter((f) => f.endsWith('.mjs'));
  const adapterCopies = adapterFiles.filter((f) =>
    LOCAL_OK_TOKEN.test(stripComments(fs.readFileSync(path.join(adapterTestDir, f), 'utf8'))));
  console.log(`\n登记在案的未覆盖边界：adapters/qq-agent/test/ 有 ${adapterCopies.length} 份手抄副本`
    + `（${adapterCopies.join(',')}）—— 拆仓时的范围决定，见 test/README.md 纪律 2`);
} catch {
  console.log('\n登记在案的未覆盖边界：adapters/qq-agent/test/ 不存在或读不到（正常：适配层可能未随包分发）');
}

console.log(`helpers-guard: ${tally.pass} 通过 / ${tally.fail} 失败`);
process.exitCode = tally.fail ? 1 : 0;
