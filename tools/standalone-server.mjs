import path from 'node:path';
import { initialize } from '../src/standalone/service.mjs';
import { createStandaloneServer, isLoopbackHost } from '../src/standalone/server.mjs';
const args = process.argv.slice(2), action = args.shift();
function option(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
const root = option('--root');
if (!root || !['init', 'serve'].includes(action)) { console.error('Usage: node tools/standalone-server.mjs init|serve --root <directory> [--host 127.0.0.1] [--port 8091] [--embed-origin http://127.0.0.1:3210] [--require-auth]'); process.exitCode = 1; }
else if (action === 'init') console.log(JSON.stringify({ root: path.resolve(root), adminToken: initialize(root), notice: 'Save this credential; it is shown only once.' }));
else {
  const host = option('--host', '127.0.0.1'), port = Number(option('--port', '8091'));
  const embedOrigins=args.flatMap((arg,i)=>arg==='--embed-origin'?[args[i+1]]:[]);
  // 0.32.2 起默认免凭据：本机单人使用，未携带凭据的回环请求直接按管理员处理。
  // 只允许回环地址 —— 绑到 0.0.0.0 就等于把管理面交给整个局域网。
  // 要恢复"必须给凭据"，用 --require-auth（access.json 与既有凭据一直保留，随时可切回）。
  const requireAuth = args.includes('--require-auth');
  const localAdmin = !requireAuth;
  if (localAdmin && !isLoopbackHost(host)) { console.error('[vec-memory] default no-auth mode requires a loopback --host (or pass --require-auth)'); process.exitCode = 1; }
  else {
    const runtime = createStandaloneServer({ root, embedOrigins, localAdmin });
    runtime.server.listen(port, host, () => {
      console.log(`[vec-memory] standalone http://${host}:${runtime.server.address().port}/standalone.html`);
      if (localAdmin) console.log('[vec-memory] 免凭据模式（默认）：仅本机回环免凭据，非回环来源仍需凭据；用 --require-auth 关闭');
    });
    const stop = async () => { await runtime.close(); process.exitCode = 0; };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }
}
