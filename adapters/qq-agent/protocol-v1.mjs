import fs from 'node:fs';
import path from 'node:path';
export const scopeOf = chatKey => { const [kind,...rest]=String(chatKey).split(':'); if(!['private','group'].includes(kind)||!rest.join(':')) throw Error('无效会话'); return {kind,id:rest.join(':')}; };
export function messageOf(e,chatKey) {
  const id=e.id ?? e.mid; const at=e.ts ?? e.at; const actor=e.senderId ?? e.sender?.id;
  if(id==null || !actor || !Number.isFinite(Number(at))) throw Error('消息缺少稳定 ID、发送者或时间');
  return {messageId:`${chatKey}:${id}`,conversationId:chatKey,actorId:String(actor),role:e.self?'assistant':'user',timestamp:new Date(Number(at)).toISOString(),text:String(e.text||'').replace(/\[CQ:at,qq=(\d+)\]/g,'').replace(/\[CQ:[^\]]+\]/g,''),scope:scopeOf(chatKey),mentions:[...String(e.text||'').matchAll(/\[CQ:at,qq=(\d+)\]/g)].map(m=>m[1]),...(e.reply?.mid!=null?{replyTo:`${chatKey}:${e.reply.mid}`}:{})};
}
export function createProtocolBridge({config,dataDir,fetcher=(...args)=>fetch(...args),store=null}) {
  const cfg=config(); const target={base:String(cfg.serviceBaseURL||'http://127.0.0.1:8088').replace(/\/+$/,''),space:String(cfg.spaceId||'')};
  const file=path.join(dataDir,'memory-vec','protocol-v1.json'); let state={target,queue:[],cursors:{},lastError:null};
  try {state=JSON.parse(fs.readFileSync(file,'utf8'));} catch(e){if(e.code!=='ENOENT')throw e;}
  if(state.target?.base!==target.base||state.target?.space!==target.space) throw Error('协议队列目标已改变，请先完成原目标迁移');
  const save=()=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(state));fs.renameSync(file+'.tmp',file);};
  let running=null, syncing=null, stopped=false;
  const queuedIds=new Set(state.queue.map(m=>m.messageId)); const controllers=new Set();
  async function request(route,body,method='POST') {
    if(stopped)throw Error('适配层已停用');
    const ac=new AbortController();controllers.add(ac);const timer=setTimeout(()=>ac.abort(),2500);
    try {const token=String(config().serviceToken||'');if(!target.space||!token)throw Error('请配置 spaceId 和 serviceToken');
      const r=await fetcher(`${target.base}/api/v1/spaces/${encodeURIComponent(target.space)}/${route}`,{method,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(body),signal:ac.signal});const p=await r.json();if(!r.ok||p.ok===false)throw Error(p.error?.message||p.error||`HTTP ${r.status}`);return p;
    }finally{clearTimeout(timer);controllers.delete(ac);}
  }
  function enqueue(messages, cursor = null) {
    for(const m of messages) if(!queuedIds.has(m.messageId)) { state.queue.push(m); queuedIds.add(m.messageId); }
    if(cursor)state.cursors[cursor.chat]=cursor.id;
    save();
  }
  function flush() {
    if(running)return running;
    running=Promise.resolve().then(async()=>{
      const pending=[...state.queue];
      if(!pending.length&&state.lastError){state.lastError=null;save();}
      try {
        for(let n=0;n<pending.length&&!stopped;n+=100) {
          const batch=pending.slice(n,n+100), result=await request('messages',{messages:batch});
          if(stopped)return;
          if(!Array.isArray(result.results))throw Error('消息接口缺少逐条接收结果');
          const batchIds=new Set(batch.map(m=>m.messageId));
          const accepted=new Set(result.results.filter(r=>batchIds.has(r.messageId)&&['accepted','duplicate'].includes(r.status)).map(r=>r.messageId));
          state.queue=state.queue.filter(m=>!accepted.has(m.messageId));
          for(const id of accepted)queuedIds.delete(id);
          if(accepted.size<batch.length)state.lastError=`投递失败：${result.results.filter(r=>!['accepted','duplicate'].includes(r.status)).map(r=>r.code||r.status).join(', ')||'未收到完整回执'}`;
          if(!state.queue.length)state.lastError=null;
          save();
        }
      }catch(e){if(!stopped){state.lastError=String(e.message);save();}}
    }).finally(()=>{running=null;});
    return running;
  }
  function sync() {
    if(syncing)return syncing;
    syncing=Promise.resolve().then(async()=>{
      try {
        await flush();
        if(stopped||state.queue.length||state.lastError)return;
        if(!store?.listChats||!store?.recent)return;
        for(const chat of store.listChats()) {
          if(stopped)return;
          const cursor=Number(state.cursors[chat]||0);
          let offset=0;const entries=[];
          for(;;) {
            const page=store.recent(chat,{limit:500,offset,includeSelf:true});
            for(const e of page)if(Number(e.id)>cursor)entries.push(e);
            if(page.length<500||page.some(e=>Number(e.id)<=cursor))break;
            offset+=page.length;
          }
          entries.sort((a,b)=>Number(a.id)-Number(b.id));
          for(let n=0;n<entries.length;n+=500) {
            if(stopped)return;
            const batch=entries.slice(n,n+500);let highest=Number(state.cursors[chat]||0);
            for(const e of batch)highest=Math.max(highest,Number(e.id));
            enqueue(batch.map(e=>messageOf(e,chat)),{chat,id:highest});
            await flush();
            if(stopped||state.queue.length||state.lastError)return;
          }
        }
      }catch(e){if(!stopped){state.lastError=String(e.message);save();}}
    }).finally(()=>{syncing=null;});
    return syncing;
  }
  return {request,enqueue,flush,sync,status:()=>({pending:state.queue.length,lastError:state.lastError,cursors:{...state.cursors}}),stop(){stopped=true;for(const ac of controllers)ac.abort();}};
}
