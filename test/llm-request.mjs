import test from 'node:test';
import assert from 'node:assert/strict';
import {callLlmOpenAI} from '../src/core/backend.mjs';

test('model thinking is opt-in on the wire and explicit mode preserves JSON content',async t=>{
 const sent=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{sent.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({choices:[{message:{content:'{"events":[],"people":[]}'}}]})};});
 const request={baseURL:'https://example.test/v1',model:'model',system:'Return JSON',user:'source',maxTokens:4000};
 assert.deepEqual(JSON.parse(await callLlmOpenAI(request)),{events:[],people:[]});
 assert.equal(Object.hasOwn(sent[0].body,'thinking'),false);
 await callLlmOpenAI({...request,thinkingMode:'disabled'});
 assert.deepEqual(sent[1].body.thinking,{type:'disabled'});assert.equal(sent[1].body.max_tokens,4000);
 await callLlmOpenAI({...request,thinkingMode:'enabled'});assert.deepEqual(sent[2].body.thinking,{type:'enabled'});
 await assert.rejects(callLlmOpenAI({...request,thinkingMode:'guess'}),{code:'INVALID_THINKING_MODE'});assert.equal(sent.length,3);
});
