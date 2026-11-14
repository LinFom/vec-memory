import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createService, initialize} from '../src/standalone/service.mjs';
import {createBackupTo, restoreBackupFile} from '../src/standalone/backup.mjs';

test('continuity survives restart and opt-in restore while ordinary backup omits role notes', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-continuity-'));
  const root = path.join(temp, 'service');
  const token = initialize(root);
  let service = createService({root});
  t.after(async () => {
    await service.close();
    fs.rmSync(temp, {recursive:true,force:true});
  });
  const call = (path, body) => service.handle({path:'/api/v1/' + path, method:'POST', token, body});
  await call('admin/projects', {projectId:'p'});
  await call('admin/spaces', {spaceId:'s', owner:'p'});
  const scope = {kind:'private',id:'a'};
  const group = {kind:'group',id:'g'};
  const role = {scope,roleId:'moon'};
  const message = {messageId:'m', scope, conversationId:'a', actorId:'alice', role:'user',
    text:'Continue picking a book next time', timestamp:1700000000000};
  assert.equal((await call('spaces/s/messages',{messages:[message]})).body.accepted,1);
  const note = {...role, operationId:'note', text:'Pick a book', messageId:'m'};
  assert.equal((await call('spaces/s/role-notes',note)).status,200);
  assert.equal((await call('spaces/s/role-notes',note)).body.replayed,true);
  assert.equal((await call('spaces/s/continuity-tasks',{...note,scope:group})).status,400);
  assert.equal((await call('spaces/s/continuity-tasks',{scope,operationId:'task',text:note.text,messageId:'m'})).status,200);
  await service.close();
  for (const [includeRoleNotes, sid] of [[false, 'plain'], [true, 'with-role']]) {
    const file = path.join(temp,sid+'.vmb');
    await createBackupTo(root,file,{spaceId:'s',mode:'full',includeRoleNotes});
    await restoreBackupFile(file,path.join(root,'spaces',sid));
  }
  const accessFile = path.join(root,'access.json');
  const access = JSON.parse(fs.readFileSync(accessFile));
  access.spaces.plain = access.spaces['with-role'] = access.spaces.s;
  fs.writeFileSync(accessFile,JSON.stringify(access));
  service = createService({root});
  const entries = async (sid, endpoint, body) => (await call('spaces/'+sid+'/'+endpoint+'/query',body)).body.items;
  assert.equal((await entries('plain','role-notes',role)).length,0);
  assert.equal((await entries('with-role','role-notes',role))[0].sourceRefs[0].id,'m');
  assert.equal((await entries('with-role','role-notes',{...role,scope:group})).length,0);
  assert.equal((await entries('with-role','role-notes',{...role,roleId:'other'})).length,0);
  assert.equal((await entries('plain','continuity-tasks',{scope})).length,1);
  assert.equal((await call('spaces/s/continuity-tasks',{scope,id:'task',operationId:'done',expectedRevision:1,status:'completed'})).status,200);
  assert.equal((await entries('s','continuity-tasks',{scope})).length,0);
});
