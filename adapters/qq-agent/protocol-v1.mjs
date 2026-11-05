import fs from 'node:fs';
import path from 'node:path';
export const scopeOf = chatKey => { const [kind,...rest]=String(chatKey).split(':'); if(!['private','group','game','channel'].includes(kind)||!rest.join(':')) throw Error('无效会话'); return {kind,id:rest.join(':')}; };
export function messageOf(e,chatKey) {
  const id=e.id ?? e.mid; const at=e.ts ?? e.at; const actor=e.senderId ?? e.sender?.id;
  if(id==null || !actor || !Number.isFinite(Number(at))) throw Error('消息缺少稳定 ID、发送者或时间');
  return {messageId:`${chatKey}:${id}`,conversationId:chatKey,actorId:String(actor),role:e.self?'assistant':'user',timestamp:new Date(Number(at)).toISOString(),text:String(e.text||'').replace(/\[CQ:at,qq=(\d+)\]/g,'').replace(/\[CQ:[^\]]+\]/g,''),scope:scopeOf(chatKey),mentions:[...String(e.text||'').matchAll(/\[CQ:at,qq=(\d+)\]/g)].map(m=>m[1]),...(e.reply?.mid!=null?{replyTo:`${chatKey}:${e.reply.mid}`}:{})};
}

/**
 * 通道名同步（QQ 群名 → 场景显示名）的两个窗口。
 *
 * 为什么是 5 分钟：名字是**慢变量**，而 `sync()` 被宿主每 15s 叫一次（`activate` 里的
 * `v1Timer`）。把慢变量放进快循环，代价全是白花的 OneBot 往返与场景写请求。所以：
 * **成功**的一轮之后 5 分钟内不再问 adapter、不再发；**失败**的一轮按更短的 1 分钟重试
 *（比 5 分钟"更早"，但不至于每 15 秒重发一遍）。
 * 结构性的"旧服务不认名字同步"（回执里没有 `nameSyncSupported`）不按偶发失败算：那是
 * 本次部署的一段长期状态，按 5 分钟退避，别拿它刷服务日志。
 */
const CHANNEL_NAME_SYNC_GAP_MS = 5 * 60 * 1000;
const CHANNEL_NAME_RETRY_GAP_MS = 60 * 1000;

/**
 * adapter 回调的返回值 → 桥认得的同步项。
 *
 * 只认三件事：`scope.kind === 'group'`、非空 `id`、非空 `name`。其余形状一律丢弃，且
 * **绝不从消息正文或昵称里猜名字** —— 名字的唯一来源是 adapter 只读的群列表
 *（`get_group_list`）：那是"这台机器观察到的事实"，不是推断。
 * `scopeOf()` 复用同一处会话键校验，免得"哪些 scope 合法"出现第二套口径。
 */
function channelNameItems(list) {
  const out=[]; const seen=new Set();
  for(const raw of Array.isArray(list)?list:[]) {
    const kind=String(raw?.scope?.kind??'').trim(), id=String(raw?.scope?.id??'').trim(), name=String(raw?.name??'').trim();
    if(kind!=='group'||!id||!name)continue;            // 空名字不占位：没名字就别给场景起名
    let scope; try{scope=scopeOf(`${kind}:${id}`);}catch{continue;}
    const key=`${scope.kind}:${scope.id}`;
    if(seen.has(key))continue;                          // 同一 scope 只发一次：重复项会让 previousName 打架
    seen.add(key); out.push({scope,name});
  }
  return out;
}

export function createProtocolBridge({config,dataDir,fetcher=(...args)=>fetch(...args),store=null,getChannelNames=null}) {
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
  /** 把各会话存档里游标之后的条目搬进队列（消息主通道；节律沿用 0.32.x，别改）。 */
  async function syncChats() {
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
        // Host sender metadata is authoritative for names; text is not an identity registry.
        for(const e of batch) {
          const id=String(e.senderId??e.sender?.id??''),name=String(e.senderName??e.sender?.name??'').trim();
          if(!/^\d{5,15}$/.test(id)||!name||state.entityNames?.[id]===name)continue;
          await request('entities/'+encodeURIComponent(id),{displayName:name},'PUT');
          (state.entityNames||={})[id]=name;save();
        }
        for(const e of batch)highest=Math.max(highest,Number(e.id));
        enqueue(batch.map(e=>messageOf(e,chat)),{chat,id:highest});
        await flush();
        if(stopped||state.queue.length||state.lastError)return;
      }
    }
  }

  /**
   * 把 adapter 给的群名推给服务的**场景显示名**（`workspace/ensureScene`），并把"服务
   * 明确承认过"的名字记成游标（下一轮作为 `previousName` 带上）。
   *
   * 定位先说清楚：名字是**显示元数据**，不是身份。游标按 `kind:id` 存（ID 定身份），
   * 名字只随行 —— 两个群同名、同一个群换了名字，都不改变任何 ID 归属，也绝不参与
   * 身份合并；同理名字**不写进 `entityNames`**（那份表只收宿主给的说话人名字）。
   *
   * 五条不可退让的纪律：
   *  ① **纯附带、绝不牵连消息**：这里所有失败只写 `state.channelSyncError` 这一条
   *    **独立**字段，**永不**写 `state.lastError` —— 后者是消息队列的闸（`sync()` 见它
   *    就整轮不动），写错一次就是"记忆不再同步"。本函数自己吞掉全部异常。
   *  ② **ack 门控**：回执必须同时满足 `nameSyncSupported === true` **且**给出非空字符串
   *    `name`，才落游标；落的是 **`ack.name`（服务实际存下的名字）**，不是提交的名字。
   *    旧服务会收下并忽略未知字段（回 `{ok:true,sceneId}`），把"发出去"当"同步成功"等于
   *    永久记下服务从没采用过的名字 ⇒ 之后连"名字改了"都判不出来；只有标志、没有名字的
   *    回执同理（不完整回执不算成功：记 `channelSyncError`、不占成功窗口）。
   *    为什么必须是 `ack.name`：服务可能回 `staleName:true`（这次提交的改名没落地，服务
   *    那边还是旧名）或 `manualPreserved:true`（手工名优先）。落提交名会让之后每一轮的
   *    `previousName` 永远是错的名字、且错得稳定；落实际名则天然正确。手工名保持**服务
   *    权威** —— 桥只记事实，不争名字的所有权。
   *  ③ **节律只由成功占用**：成功的一轮写 `channelSyncAt`（5 分钟窗口），失败的一轮
   *    只写 `channelSyncRetryAt`（偶发 1 分钟 / 旧服务 5 分钟）⇒ 改了名还能同步上，
   *    也不至于每 15 秒重发一遍。
   *  ④ **adapter 答不上来就什么都不落**：回调返回非数组（没接上 / 断线 / 读失败）时
   *    直接返回，既不占窗口也不记错误 —— 下一拍再问，接上后名字最多晚一拍（15s）。
   *  ⑤ **停用即撤**：每项之间复查 `stopped`，配合 `request()` 的 AbortController；
   *    `stop()` 之后不会再发出任何一次写请求。
   */
  async function syncChannelNames() {
    if(typeof getChannelNames!=='function'||stopped)return;
    const now=Date.now();
    if(state.channelSyncAt&&now-Number(state.channelSyncAt)<CHANNEL_NAME_SYNC_GAP_MS)return;
    if(Number(state.channelSyncRetryAt||0)>now)return;
    let list;
    try { list=await getChannelNames(); }
    catch(e){if(!stopped){state.channelSyncError=`通道名读取失败：${String(e?.message||e)}`;state.channelSyncRetryAt=Date.now()+CHANNEL_NAME_RETRY_GAP_MS;save();}return;}
    if(stopped)return;
    if(!Array.isArray(list))return;                      // 纪律④：adapter 这一拍答不上来
    const items=channelNameItems(list);
    const failures=[]; let acked=0, unsupported=false;
    for(const item of items) {
      if(stopped)return;
      const key=`${item.scope.kind}:${item.scope.id}`, previous=state.channelNames?.[key];
      try {
        const ack=await request('workspace',{action:'ensureScene',scope:item.scope,name:item.name,nameSource:'adapter',...(previous?{previousName:previous}:{})});
        if(stopped)return;
        // 旧服务只回 {ok:true,sceneId}：**不能**当成"名字已被采用"（纪律②）。
        if(ack?.nameSyncSupported!==true){unsupported=true;failures.push(`${key} 服务未声明 nameSyncSupported`);continue;}
        // 回执必须回**实际存下来的名字**：只有标志、没名字的回执是不完整回执 ⇒ 不算成功（纪律②）。
        // 落的是**服务当前的真名**：`staleName`（提交的改名这次没落地，服务那边还是旧名）
        // 照样接受 —— 下一轮 `previousName` 才带得对；`manualPreserved`（手工名）也是服务的权威
        // 事实，桥只记下来、不覆盖也不推断。
        const stored=typeof ack.name==='string'?ack.name.trim():'';
        if(!stored){failures.push(`${key} 回执缺少 name`);continue;}
        // 游标 = **服务实际存下的名字**（`ack.name`），不是我们提交的 adapter 名：
        // 提交了却没被采用（stale / 手工保护）时存提交名，会让之后每一轮的 `previousName`
        // 永远错位、且错得稳定 —— 改名再也不会被识别。
        (state.channelNames||={})[key]=stored;
        acked++;
      } catch(e) {
        if(stopped)return;
        failures.push(`${key} ${String(e?.message||e)}`);
      }
    }
    if(stopped)return;
    if(failures.length) {
      state.channelSyncError=`通道名同步失败：${failures.slice(0,3).join('；')}`;
      state.channelSyncRetryAt=Date.now()+(unsupported?CHANNEL_NAME_SYNC_GAP_MS:CHANNEL_NAME_RETRY_GAP_MS);
    } else {
      // 一轮"零失败"就是成功：包括"adapter 在线但一个群都没有"（空数组 = 真实答案）。
      state.channelSyncError=null;state.channelSyncRetryAt=0;state.channelSyncAt=Date.now();
    }
    save();
  }

  function sync() {
    if(syncing)return syncing;
    syncing=Promise.resolve().then(async()=>{
      try {
        await flush();
        // 队列还压着 / 上一轮有错 ⇒ 这一轮只做消息；名字留到"可靠的那一拍"。
        if(stopped||state.queue.length||state.lastError)return;
        await syncChats();
        if(stopped||state.queue.length||state.lastError)return;
        await syncChannelNames();          // 自己吞掉全部异常，走到这里也不会抛出去
      }catch(e){if(!stopped){state.lastError=String(e.message);save();}}
    }).finally(()=>{syncing=null;});
    return syncing;
  }
  return {request,enqueue,flush,sync,status:()=>({pending:state.queue.length,lastError:state.lastError,cursors:{...state.cursors},channelNames:{...(state.channelNames||{})},channelSyncAt:state.channelSyncAt??null,channelSyncError:state.channelSyncError??null}),stop(){stopped=true;for(const ac of controllers)ac.abort();}};
}
