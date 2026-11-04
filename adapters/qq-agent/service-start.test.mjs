import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {initialize} from '../../src/standalone/service.mjs';
import {standaloneStartArgs} from './service-start.mjs';

test('v1 activation starts the configured local data root without carrying credentials in arguments',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vec-start-')),data=path.join(root,'service'),host=path.join(root,'host');initialize(data);
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const cfg={protocolV1:true,autoStartService:true,serviceRoot:fileURLToPath(new URL('../../',import.meta.url)),serviceDataRoot:data,serviceBaseURL:'http://127.0.0.1:'+port,spaceId:'test',serviceToken:'must-not-be-in-arguments',managementOrigins:['http://127.0.0.1:3210']};
 assert(!JSON.stringify(standaloneStartArgs(cfg)).includes(cfg.serviceToken));
 assert.equal(standaloneStartArgs({...cfg,serviceDataRoot:''}),null);assert.equal(standaloneStartArgs({...cfg,serviceBaseURL:'https://remote.example'}),null);
 const mod=await import('./index.js?start-test='+Date.now());let pid;
 t.after(async()=>{mod.deactivate();if(!pid&&fs.existsSync(path.join(data,'.service.lock')))pid=JSON.parse(fs.readFileSync(path.join(data,'.service.lock'),'utf8')).pid;if(pid){assert.notEqual(pid,process.pid);try{process.kill(pid);}catch{}}await new Promise(r=>setTimeout(r,150));fs.rmSync(root,{recursive:true,force:true});});
 mod.setup({config:()=>cfg,registerTool:()=>{}});mod.activate({dataDir:host,store:{listChats:()=>[],recent:()=>[]}});
 let ready=false;for(let n=0;n<60;n++){try{const r=await fetch(cfg.serviceBaseURL+'/health',{signal:AbortSignal.timeout(500)});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
 assert(ready,'QQ activation did not start the standalone service');
 pid=JSON.parse(fs.readFileSync(path.join(data,'.service.lock'),'utf8')).pid;
 const page=await fetch(cfg.serviceBaseURL+'/standalone.html');assert.match(page.headers.get('content-security-policy'),/127\.0\.0\.1:3210/);
 assert(!fs.existsSync(path.join(root,'data')),'startup must not initialize a different library');
});
