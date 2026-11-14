import test from 'node:test';
import assert from 'node:assert/strict';
import {createMoonMemoryAdapter} from './index.mjs';

test('adapter binds chat and role at the trusted host boundary', async () => {
  const calls = [];
  const adapter = createMoonMemoryAdapter({
    baseURL:'http://localhost:8088', spaceId:'s', roleId:'moon', token:'test',
    fetcher:async (url, options) => {
      calls.push({url, body:JSON.parse(options.body), auth:options.headers.Authorization});
      return {ok:true, json:async () => ({ok:true,items:[]})};
    },
  });
  const scope = {kind:'private',id:'alice'};
  const chat = adapter.forConversation(scope);
  await chat.writeNote({operationId:'n',text:'Pick a book',roleId:'other',scope:{kind:'group',id:'g'}});
  await chat.notes();
  await chat.recall({query:'book'});
  assert.equal(calls[0].url,'http://localhost:8088/api/v1/spaces/s/role-notes');
  assert.equal(calls[0].auth,'Bearer test');
  assert.deepEqual(calls[0].body,{operationId:'n',text:'Pick a book',roleId:'moon',scope});
  assert.deepEqual(calls[1].body,{roleId:'moon',scope});
  assert.deepEqual(calls[2].body,{query:'book',scope,purpose:'query'});
});

test('adapter surfaces service errors without falling back to another store', async () => {
  const adapter = createMoonMemoryAdapter({
    baseURL:'http://localhost:8088',spaceId:'s',roleId:'moon',token:'test',
    fetcher:async () => ({ok:false,status:403,json:async () => ({ok:false,code:'FORBIDDEN'})}),
  });
  await assert.rejects(adapter.forConversation({kind:'group',id:'g'}).tasks(), {status:403,code:'FORBIDDEN'});
});
