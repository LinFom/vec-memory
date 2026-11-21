import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createFileSettingsEditor} from '../src/core/settings-editor.mjs';
import {DEFAULT_SETTINGS,getRuntime,disposeMemoryVec} from '../src/core/backend.mjs';
import {start} from '../src/server.mjs';
const err=code=>e=>e.code===code;
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mv-settings-'));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('mv-settings-'));fs.rmSync(root,{recursive:true,force:true});});
  return root;
}
test('settings editor preserves host configuration, masks keys, supports explicit secret clear and CAS',t=>{
  const root=fixture(t),file=path.join(root,'config.json'),editor=createFileSettingsEditor(root);
  const original={server:{port:3210},persona:{botName:'Synthetic Cat',other:1},skills:{other:{key:'unrelated-secret'},'memory-vec':{embedApiKey:'synthetic-key-not-for-ui',unknownOption:123,topK:8}}};
  fs.writeFileSync(file,JSON.stringify(original));
  const before=editor.getMemorySettings(DEFAULT_SETTINGS);
  assert.equal(before.secrets.embedApiKey,true);assert.doesNotMatch(JSON.stringify(before),/synthetic-key-not-for-ui|unrelated-secret/);
  const updated=editor.updateMemorySettings({expectedEtag:before.etag,patch:{topK:12,embedApiKey:'',botName:'Updated Cat'}},DEFAULT_SETTINGS);
  const disk=JSON.parse(fs.readFileSync(file));
  assert.deepEqual(disk.server,original.server);assert.deepEqual(disk.skills.other,original.skills.other);
  assert.equal(disk.skills['memory-vec'].unknownOption,123);assert.equal(disk.skills['memory-vec'].embedApiKey,'synthetic-key-not-for-ui');
  assert.equal(disk.persona.other,1);assert.equal(updated.restartRequired,true);assert.equal(updated.values.topK,12);
  assert.throws(()=>editor.updateMemorySettings({expectedEtag:before.etag,patch:{topK:2}},DEFAULT_SETTINGS),err('STALE_SETTINGS'));
  const cleared=editor.updateMemorySettings({expectedEtag:updated.etag,patch:{embedApiKey:null,llmApiKey:'new-synthetic-key'}},DEFAULT_SETTINGS);
  assert.equal(cleared.secrets.embedApiKey,false);assert.equal(cleared.secrets.llmApiKey,true);assert.doesNotMatch(JSON.stringify(cleared),/new-synthetic-key/);
});
test('invalid, corrupt and failed writes preserve original file; external changes are not overwritten',t=>{
  const root=fixture(t),file=path.join(root,'config.json'),editor=createFileSettingsEditor(root);
  for(const patch of [{sourceRoot:'elsewhere'},{topK:0},{autoIndexEnabled:'true'},{embedBaseURL:'file:///tmp'},{embedBaseURL:'https://user:password@example.test'},{llmEndpointKind:'guess'},{embedDimensions:1.5},{embedApiKey:[]}]) {
    assert.throws(()=>editor.updateMemorySettings({expectedEtag:editor.getMemorySettings(DEFAULT_SETTINGS).etag,patch},DEFAULT_SETTINGS),err('INVALID_ARGUMENT'));
    assert.equal(fs.existsSync(file),false);
  }
  const blank=editor.getMemorySettings(DEFAULT_SETTINGS);
  const saved=editor.updateMemorySettings({expectedEtag:blank.etag,patch:{topK:9}},DEFAULT_SETTINGS);
  const before=fs.readFileSync(file,'utf8');
  const badIo=Object.create(fs);badIo.fsyncSync=()=>{throw Error('disk full');};
  assert.throws(()=>createFileSettingsEditor(root,{io:badIo}).updateMemorySettings({expectedEtag:saved.etag,patch:{topK:10}},DEFAULT_SETTINGS),err('CONFIG_WRITE_FAILED'));
  assert.equal(fs.readFileSync(file,'utf8'),before);assert.deepEqual(fs.readdirSync(root),['config.json']);
  fs.writeFileSync(file,'{broken');assert.throws(()=>editor.getMemorySettings(DEFAULT_SETTINGS),err('CONFIG_INVALID'));
  assert.throws(()=>editor.updateMemorySettings({expectedEtag:saved.etag,patch:{topK:10}},DEFAULT_SETTINGS),err('CONFIG_INVALID'));
  assert.equal(fs.readFileSync(file,'utf8'),'{broken');
});
test('standalone settings HTTP updates actual source config and runtime, protects origin and instance',async t=>{
  const root=fixture(t),source=path.join(root,'upstream'),data=path.join(root,'library');
  fs.mkdirSync(source);fs.mkdirSync(data);
  const sourceConfig={persona:{botName:'HTTP Test Cat'},skills:{'memory-vec':{autoIndexEnabled:false,consolidateEnabled:false,embedApiKey:'secret-http-test'}}};
  fs.writeFileSync(path.join(source,'config.json'),JSON.stringify(sourceConfig));
  fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({unrelated:true}));
  const service=await start({dataRoot:data,sourceRoot:source,port:0});
  try {
    const call=async(body,headers={})=>{
      const r=await fetch(service.url+'/api/vec/memory/settings',{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:r.status,body:await r.json()};
    };
    const initial=(await call()).body;
    assert.equal(initial.configFile,path.join(source,'config.json'));assert.equal(initial.writable,true);
    assert.doesNotMatch(JSON.stringify(initial),/secret-http-test/);
    const body={expectedInstanceId:initial.instanceId,expectedEtag:initial.etag,patch:{topK:13,embedModel:'test-only-model'}};
    const result=await call(body, {origin:service.url});assert.equal(result.status,200,JSON.stringify(result.body));
    assert.equal((await getRuntime()).settings.topK,13);
    assert.equal(JSON.parse(fs.readFileSync(path.join(source,'config.json'))).skills['memory-vec'].topK,13);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data,'config.json'))),{unrelated:true});
    assert.equal((await call(body)).status,409);
    assert.equal((await call({...body,expectedInstanceId:'wrong'})).status,409);
    assert.equal((await call({...body,expectedEtag:result.body.etag},{origin:'https://untrusted.example'})).status,403);
    assert.equal((await call(body,{'content-type':'text/plain'})).status,403);
  } finally {disposeMemoryVec();await new Promise(r=>service.server.close(r));}
});
