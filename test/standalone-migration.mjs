import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {migrate,verify,exportSpace} from '../tools/standalone-migrate.mjs';

test('offline migration preserves all assets and export includes new protocol state',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'vec-migration-'));
  try {
    const from=path.join(temp,'old'),to=path.join(temp,'new');
    const samples={'facts/slots.jsonl':'{"key":"old"}\n','manual/revisions.jsonl':'manual','normalizer/secret.key':'secret','vector-generations/g1/vectors.bin':Buffer.from([0,1,255]),'consolidate/events.jsonl':'events'};
    for(const [rel,data] of Object.entries(samples)) {const file=path.join(from,'memory-vec',rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);}
    fs.writeFileSync(path.join(from,'labels.json'),'{}');
    const result=migrate({from,to,spaceId:'qq-a'});
    assert.equal(result.activated,false);assert.equal(result.semanticRecovery,'not-verified');assert.equal(result.files,6);
    assert.equal(verify({spaceRoot:result.spaceRoot}).ok,true);
    assert.throws(()=>migrate({from,to,spaceId:'qq-a'}),/empty/);
    assert.throws(()=>migrate({from,to:path.join(from,'nested'),spaceId:'x'}),/disjoint/);
    assert.throws(()=>migrate({from,to,spaceId:'../escape'}),/Invalid/);
    fs.writeFileSync(path.join(result.spaceRoot,'state.json'),'{"messages":["new"]}');
    const output=path.join(temp,'export');
    exportSpace({spaceRoot:result.spaceRoot,to:output});
    assert.equal(fs.readFileSync(path.join(output,'space','state.json'),'utf8'),'{"messages":["new"]}');
    assert.equal(fs.existsSync(path.join(output,'access.json')),false);
    fs.writeFileSync(path.join(result.spaceRoot,'legacy/data/memory-vec/facts/slots.jsonl'),'changed');
    assert.equal(verify({spaceRoot:result.spaceRoot}).ok,false);
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
});

test('explicit external source survives migration; extra files fail byte verification',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'vec-source-'));
  try {
    const from=path.join(temp,'old'),sourceRoot=path.join(temp,'host'),to=path.join(temp,'target');
    fs.mkdirSync(path.join(from,'memory-vec'),{recursive:true});fs.writeFileSync(path.join(from,'memory-vec','notes.json'),'{}');
    fs.mkdirSync(path.join(sourceRoot,'messages'),{recursive:true});fs.writeFileSync(path.join(sourceRoot,'messages','chat.json'),'[{"id":"m1"}]');
    const result=migrate({from,to,spaceId:'a',sourceRoot});
    assert.equal(fs.readFileSync(path.join(result.spaceRoot,'imported-source/messages/chat.json'),'utf8'),'[{"id":"m1"}]');
    assert.equal(verify({spaceRoot:result.spaceRoot}).ok,true);
    fs.writeFileSync(path.join(result.spaceRoot,'legacy/data/unexpected'),'extra');
    assert.equal(verify({spaceRoot:result.spaceRoot}).ok,false);
    assert.throws(()=>exportSpace({spaceRoot:result.spaceRoot,to:path.join(result.spaceRoot,'nested')}),/disjoint/);
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
});
