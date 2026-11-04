import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initialize} from '../src/standalone/service.mjs';
import {createStandaloneServer} from '../src/standalone/server.mjs';

test('management embeds only in configured consoles; health CORS does not grant API access',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vec-embed-')),token=initialize(root);
 const runtime=createStandaloneServer({root,embedOrigins:['http://127.0.0.1:3210','http://127.0.0.1:3211']});
 await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await runtime.close();fs.rmSync(root,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+runtime.server.address().port;
 const page=await fetch(base+'/standalone.html'),csp=page.headers.get('content-security-policy');
 assert.match(csp,/frame-ancestors 'self' http:\/\/127\.0\.0\.1:3210 http:\/\/127\.0\.0\.1:3211/);assert(!csp.includes('*'));
 const health=await fetch(base+'/health',{headers:{Origin:'http://127.0.0.1:3210'}});assert.equal(health.headers.get('access-control-allow-origin'),'http://127.0.0.1:3210');
 const denied=await fetch(base+'/health',{headers:{Origin:'https://outside.example'}});assert.equal(denied.headers.get('access-control-allow-origin'),null);
 assert.equal((await fetch(base+'/api/v1/admin/spaces')).status,401);
 assert.equal((await fetch(base+'/api/v1/admin/projects',{method:'POST',headers:{Origin:'http://127.0.0.1:3210',Authorization:'Bearer '+token,'content-type':'application/json'},body:'{"projectId":"untrusted"}'})).status,403);
});

test('default denies framing and invalid embedding origins leave no lock',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vec-embed-default-'));initialize(root);
 for(const origin of ['file:///console','http://user:secret@localhost:3210','http://localhost:3210/path']){
  assert.throws(()=>createStandaloneServer({root,embedOrigins:[origin]}),/origin/i);assert(!fs.existsSync(path.join(root,'.service.lock')));
 }
 const runtime=createStandaloneServer({root});await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await runtime.close();fs.rmSync(root,{recursive:true,force:true});});
 const page=await fetch('http://127.0.0.1:'+runtime.server.address().port+'/standalone.html');assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});
