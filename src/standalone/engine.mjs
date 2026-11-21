import { Worker } from 'node:worker_threads';
export function createSpaceEngine({root,settings={},maintenance=false,evaluation=false}) {
  const worker=new Worker(new URL('./worker.mjs',import.meta.url),{workerData:{root,settings,maintenance,evaluation},execArgv:[]});
  const pending=new Map();let seq=0,closed=false;
  worker.on('message',m=>{
    // 进度帧没有 result，必须先拦掉：否则会被当成结果把 pending 提前 resolve，任务假成功。
    if(m&&m.type==='progress'){const p=pending.get(m.id);if(p&&typeof p.onProgress==='function'){try{p.onProgress(m.progress);}catch{}}return;}
    const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Object.assign(new Error(m.error.message),m.error)):p.resolve(m.result);});
  const fail=error=>{closed=true;for(const p of pending.values())p.reject(error);pending.clear();};
  worker.on('error', cause => fail(Object.assign(new Error('Space worker failed', { cause }), { code:'ENGINE_UNAVAILABLE', status:503 })));
  worker.on('exit',code=>fail(Object.assign(new Error(`Space worker exited (${code})`),{code:'ENGINE_UNAVAILABLE',status:503})));
  return {get closed(){return closed;},call(operation,payload={},options={}){if(closed)return Promise.reject(Object.assign(new Error('Space engine is closed'),{code:'ENGINE_UNAVAILABLE',status:503}));const id=++seq;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject,onProgress:options.onProgress});worker.postMessage({id,operation,payload});});},async close(){closed=true;await worker.terminate();}};
}
