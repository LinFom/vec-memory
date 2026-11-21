import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { initialize } from '../src/standalone/service.mjs';

const entry = fileURLToPath(new URL('../tools/standalone-server.mjs', import.meta.url));

test('agent-managed service stays up for the second Agent and stops after it exits', { timeout: 25000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-agent-managed-'));
  initialize(root);
  const dir = path.join(root, '.agent-owners');
  fs.mkdirSync(dir);
  const owners = Array.from({ length: 2 }, () =>
    spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] }));
  for (const owner of owners) fs.writeFileSync(path.join(dir, String(owner.pid)), '');
  const service = spawn(process.execPath, [entry, 'serve', '--root', root, '--port', '0', '--agent-managed']);
  const exited = once(service, 'exit');
  t.after(async () => {
    for (const owner of owners) owner.stdin.end();
    if (service.exitCode === null && service.signalCode === null) service.kill();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  });
  let endpoint;
  for await (const chunk of service.stdout) {
    endpoint = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (endpoint) break;
  }
  assert(endpoint);
  const firstExited = once(owners[0], 'exit');
  owners[0].stdin.end();
  await firstExited;
  await delay(6500);
  assert.equal((await fetch(endpoint + '/health')).status, 200);
  owners[1].stdin.end();
  assert.deepEqual(await exited, [0, null]);
  assert.equal(fs.existsSync(path.join(root, '.service.lock')), false);
});
