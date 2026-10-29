import path from 'node:path';
import { initialize } from '../src/standalone/service.mjs';
import { createStandaloneServer } from '../src/standalone/server.mjs';
const args = process.argv.slice(2), action = args.shift();
function option(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
const root = option('--root');
if (!root || !['init', 'serve'].includes(action)) { console.error('Usage: node tools/standalone-server.mjs init|serve --root <directory> [--host 127.0.0.1] [--port 8091]'); process.exitCode = 1; }
else if (action === 'init') console.log(JSON.stringify({ root: path.resolve(root), adminToken: initialize(root), notice: 'Save this credential; it is shown only once.' }));
else {
  const host = option('--host', '127.0.0.1'), port = Number(option('--port', '8091'));
  const runtime = createStandaloneServer({ root });
  runtime.server.listen(port, host, () => console.log(`[vec-memory] standalone http://${host}:${runtime.server.address().port}/standalone.html`));
  const stop = async () => { await runtime.close(); process.exitCode = 0; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
