import { Worker } from 'node:worker_threads';
export function createSpaceEngine({root,settings={}}) {
  const worker=new Worker(new URL('./worker.mjs',import.meta.url),{workerData:{root,settings},execArgv:[]});
  const pending=new Map();let seq=0,closed=false;
  worker.on('message',m=>{const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Object.assign(new Error(m.error.message),m.error)):p.resolve(m.result);});
  const fail=error=>{closed=true;for(const p of pending.values())p.reject(error);pending.clear();};
  worker.on('error',fail);worker.on('exit',code=>fail(Object.assign(new Error(`Space worker exited (${code})`),{code:'ENGINE_UNAVAILABLE',status:503})));
  return {call(operation,payload={}){if(closed)return Promise.reject(Object.assign(new Error('Space engine is closed'),{code:'ENGINE_UNAVAILABLE',status:503}));const id=++seq;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});worker.postMessage({id,operation,payload});});},async close(){closed=true;await worker.terminate();}};
}
