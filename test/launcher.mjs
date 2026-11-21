// 启动器自检 —— 钉住 `启动-向量记忆库服务.bat` 上**已经真实咬过人**的性质，
// 以及 0.9.3 外接模式新收敛出的形态。
//
// 为什么值得一个测试文件：这个 .bat 是**唯一**把"库"接到"面板"上的东西，
// 而它出过的三次故障都不是逻辑错，是形态错 —— 形态错不会让任何 JS 测试变红：
//   ① 双态同端口 ⇒ 点错副本，面板连上空库，报"嵌入端点未配置"（连中三次）
//   ② 透传参数拼成一行字符串 ⇒ 空参时留下 7 个空格，被判成"带了自定义参数"，
//      于是**每一次双击都静默跳过**启动后健康检查
//   ③ 用 `timeout /t 2` 当睡眠 ⇒ PATH 上只要有 POSIX timeout 就被劫持
// 0.9.3 外接模式把 ① 的根除掉了：**只剩这一份启动器**，双态分支必须保持消失。
// 这些性质只能从文件内容上判，所以本文件读文本、断言"不变量"，不起进程。
//
// ⚠️ 判据只看**可执行行**：文件顶部的 HISTORY 注释里故意引用了这几种**旧写法**
//    （不引用就没法说清"为什么不能这么写"），所以 `rem` 行必须先剥掉，
//    否则"注释里躺着的旧写法"会被当成"代码里又有旧写法"。—— 这条本身也是实测：
//    首版没剥，两条断言立刻误报。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = path.join(REPO, '启动-向量记忆库服务.bat');

function raw() {
  assert.ok(fs.existsSync(LAUNCHER), `启动器不在预期的位置：${LAUNCHER}`);
  return fs.readFileSync(LAUNCHER);
}

/** 可执行行（去掉 rem 注释与空行）。断言内容性质时用它，不要用全文。 */
function code() {
  return raw()
    .toString('utf8')
    .split('\r\n')
    .filter((l) => !/^\s*rem\b/i.test(l))
    .join('\n');
}

test('启动器 · 纯 ASCII + 只有 CRLF（编码错会把中文路径和 echo 全毁掉）', () => {
  const buf = raw();
  const bad = [...buf].filter((b) => b > 127);
  assert.equal(bad.length, 0, `出现了 ${bad.length} 个非 ASCII 字节`);
  const text = buf.toString('utf8');
  assert.equal((text.match(/\r\n/g) || []).length > 0, true, '没有任何 CRLF');
  assert.equal((text.match(/(?<!\r)\n/g) || []).length, 0, '存在裸 LF（cmd 会把行尾吃进参数）');
});

test('启动器 · 外接模式下必须是**单份单态**（双态分支不许回来）', () => {
  const t = code();
  // 0.9.3 起唯一启动口：默认 8088（面板默认值），不再有第二个副本/第二个端口
  assert.match(t, /set "PORT=8088"/, '默认端口不是 8088（面板 serviceBaseURL 默认值对不上）');
  assert.equal(/set "PORT=8099"/.test(t), false, '又出现了第二个默认端口 —— 双态回潮');
  assert.equal(/set "LAYOUT=/.test(t), false, '又出现了布局判定 —— 双态回潮');
  assert.equal(/vendor/.test(t), false, '启动器又引用了 vendor —— 消费方包内副本回潮');
  // 服务器必须在自己旁边找（外接模式：服务从仓里起）
  assert.match(t, /set "SERVER=%~dp0src\\server\.mjs"/, '服务器路径不再是 %~dp0src\\server.mjs');
});

test('启动器 · 端口必须无条件注入，且排在调用方参数之前', () => {
  const startLines = code().split(/\n/).filter((l) => l.startsWith('start "vec-memory-service"'));
  assert.equal(startLines.length, 2, `start 行应有两处（常规 + 自定义参数），实得 ${startLines.length}`);
  for (const line of startLines) {
    assert.match(line, /--port %PORT%/, `start 行没有注入 --port：${line.slice(0, 80)}`);
    assert.ok(
      line.indexOf('--port %PORT%') < line.indexOf('%REST%') || !line.includes('%REST%'),
      '调用方参数排在 --port 之前，会反过来覆盖脚本选的端口'
    );
  }
});

test('启动器 · 空参不得被误判成"带了自定义参数"（跳过健康检查的元凶）', () => {
  const t = code();
  // 旧写法：set "REST=%~2 %~3 ... %~9" —— 空参时留下 7 个空格，比 " " 长
  assert.equal(/"%~2 %~3/.test(t), false, '透传参数又拼成了单行字符串');
  assert.match(t, /if not "%~2"=="" set "REST=%~2"/, '逐参追加的写法不见了');
  // 自定义参数分支靠的必须是**精确**空判据
  assert.match(t, /if not "%REST%"=="" goto customargs/, '自定义参数判据不是精确空判据');
});

test('启动器 · 睡眠不许依赖 PATH 上的 timeout，健康判据必须是轮询', () => {
  const t = code();
  assert.equal(/timeout\s+\/t/i.test(t), false, '又在用 timeout /t —— PATH 上的 POSIX timeout 会劫持它');
  assert.match(t, /for \/l %%I in \(1,1,\d+\) do/, '没有重试轮询，慢启动会被判成失败');
  assert.match(t, /curl -s --max-time \d+ http:\/\/127\.0\.0\.1:%PORT%\/health/, '轮询探的不是本机 /health');
  assert.match(t, /goto healthy/, '轮询成功后没有出口');
});

test('启动器 · 外接模式的两条运行期事实必须被点名（config.json / sourceRoot）', () => {
  const t = code();
  assert.match(t, /if exist "%DATAROOT%\\config\.json" goto cfgok/, '没有 config.json 判据');
  assert.match(t, /\[WARN\] No config\.json in %DATAROOT%/, '缺 config.json 时没有警告');
  // sourceRoot 是 0.9.3 的第二运行期事实：没配它 ⇒ 索引源/身份/面板设置全空
  assert.match(t, /findstr \/c:"sourceRoot" "%DATAROOT%\\config\.json"/, '没有对 config.json 做 sourceRoot 探测');
  assert.match(t, /\[WARN\] %DATAROOT%\\config\.json has no sourceRoot\./, '缺 sourceRoot 时没有警告');
  // 启动成功的输出里必须回显两个根的语义，排障时才有对账基准
  assert.match(t, /dataRoot is the lib/, '成功输出没有解释 dataRoot 的语义');
  assert.match(t, /sourceRoot is where the/, '成功输出没有解释 sourceRoot 的语义');
});
