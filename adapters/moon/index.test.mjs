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

test('inner-life facade returns scoped hits, restores only private continuity, and releases its slot', async () => {
  const {installInnerLifeMemory} = await import('./inner-life.mjs');
  const host = {};
  const adapter = {forConversation(scope) {
    assert.equal(scope.id, 'a');
    return {
      async recall(request) {
        assert.equal(request.automatic, true);
        return {items: [
          {id:'match', text:'Pick a book', sourceRefs:[{type:'message',chatKey:'private:a'}]},
          {id:'other', text:'Unavailable', sourceRefs:[{type:'message',chatKey:'private:b'}]},
        ]};
      },
      tasks: async () => ({items:[{id:'same',text:'Choose book'}]}),
      notes: async () => ({items:[{id:'same',text:'Read sample'}]}),
    };
  }};
  const remove = installInnerLifeMemory(adapter, host);
  const bridge = host.__MOON_MEMBUS__;
  assert.throws(() => installInnerLifeMemory(adapter, host));
  assert.deepEqual((await bridge.recallFor({chatKey:'private:a',query:'book'})).hits.map(x => x.id), ['match']);
  assert.deepEqual((await bridge.restoreFor({chatKey:'private:a'})).hits.map(x => x.id), ['task:same','note:same']);
  assert.deepEqual((await bridge.restoreFor({chatKey:'group:a'})).hits, []);
  assert.deepEqual((await bridge.restoreFor({chatKey:'private:b'})).hits, []);
  remove();
  assert.equal(host.__MOON_MEMBUS__, undefined);
});
