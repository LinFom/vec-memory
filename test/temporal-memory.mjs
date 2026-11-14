import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createService, initialize} from '../src/standalone/service.mjs';

test('temporal memory distinguishes a move, a visit, and a correction', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-temporal-'));
  const token = initialize(root);
  let service = createService({root});
  const call = (route, method, body, credential = token) => service.handle({
    token: credential, path: '/api/v1/' + route, method, body,
  });
  const scope = {kind:'private', id:'a'};
  const context = {scope, actorId:'alice', attribute:'residence'};
  const base = 'spaces/s/temporal-memory';
  const query = async (view, overrides = {}) =>
    (await call(base + '/query', 'POST', {...context, view, ...overrides})).body.items.map(item => item.value);
  try {
    await call('admin/projects', 'POST', {projectId:'p'});
    const outsider = (await call('admin/projects', 'POST', {projectId:'outside'})).body.token;
    await call('admin/spaces', 'POST', {spaceId:'s', owner:'p'});
    const messages = ['I lived in Alpha', 'I am visiting Beta', 'I now live in Beta', 'I never lived in Alpha']
      .map((text, i) => ({messageId:'m' + i, conversationId:'a', role:'user', actorId:'alice',
        timestamp:1700000000000 + i * 86400000, text, scope}));
    assert.equal((await call('spaces/s/messages','POST',{messages})).body.accepted,4);
    const recall = async () => (await call('spaces/s/recall', 'POST', {scope, mode:'keyword'})).body.items;
    const originalRecall = await recall();
    assert.ok(originalRecall.length);
    assert.deepEqual(await query('current'), []);
    const old = {...context, operationId:'old', messageId:'m0', value:'Alpha'};
    assert.equal((await call(base,'POST',old)).status,200);
    assert.equal((await call(base,'POST',old)).body.replayed,true);
    assert.equal((await call(base,'POST',{...old, attribute:'current_location'})).status,409);
    assert.equal((await call(base,'POST',{...context, attribute:'current_location', operationId:'visit', messageId:'m1', value:'Beta'})).status,200);
    assert.deepEqual(await query('current'), ['Alpha']);
    assert.equal((await call(base,'POST',{...context, operationId:'move', messageId:'m2', value:'Beta'})).status,200);
    assert.deepEqual(await query('current'), ['Beta']);
    assert.deepEqual(await query('history'), ['Beta','Alpha']);
    assert.deepEqual(await query('history',{scope:{kind:'private',id:'other'}}), []);
    assert.equal((await call(base+'/query','POST',context,outsider)).status,403);
    assert.equal((await call(base,'POST',{...context, operationId:'correction', messageId:'m3', action:'retract', targetId:'old'})).status,200);
    await service.close();
    service = createService({root});
    assert.deepEqual(await query('history'), ['Beta']);
    const {items} = (await call(base+'/query','POST',context)).body;
    assert.equal(items[0].effectiveAt,null);
    assert.equal(items[0].sourceRefs[0].id,'m2');
    assert.deepEqual(await recall(), originalRecall);
  } finally {
    await service.close();
    fs.rmSync(root,{recursive:true,force:true});
  }
});
