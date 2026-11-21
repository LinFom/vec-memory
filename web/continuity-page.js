// Isolated page in the existing console shell; all operations use the selected
// space and explicit conversation, with server revisions and evidence checks.
export function mountContinuity(root,{space,scope,scopes,api,esc,toast}) {
  Object.assign(root.style,{display:'grid',gap:'16px',minWidth:'0'});
  let epoch=0, rows=[], mutation=null;
  const key=s=>s.kind+':'+s.id;
  const defaults=scope?.id?scope:scopes[0]||{kind:'private',id:''};
  const options=(values,selected)=>values.map(([value,label])=>`<option value="${esc(value)}"${value===selected?' selected':''}>${esc(label)}</option>`).join('');
  root.innerHTML=`<div class="head"><h1>角色与约定</h1><p>按会话查看念想、心事、一天、待办和人物状态。</p></div>
  <form class="card" id="continuity-filter"><div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr))">
    <label class="field">会话类型<select class="inp" name="scopeKind">${options([['private','私聊'],['group','群'],['channel','频道'],['game','游戏']],defaults.kind)}</select></label>
    <label class="field">会话 ID<input class="inp" name="scopeId" required value="${esc(defaults.id)}" list="continuity-scopes"><datalist id="continuity-scopes">${scopes.map(s=>`<option value="${esc(s.id)}">${esc(key(s))}</option>`).join('')}</datalist></label>
    <label class="field">记录<select class="inp" name="kind">${options([['thought','念想'],['concern','心事'],['day','她的一天'],['task','待办约定'],['temporal','人物状态']],'thought')}</select></label>
    <label class="field" data-role>角色 ID<input class="inp" name="roleId" placeholder="与接入配置中的角色一致"></label>
    <label class="field" data-status>状态<select class="inp" name="status">${options([['open','未结束'],['all','全部'],['completed','已完成'],['cancelled','已取消']],'open')}</select></label>
    <label class="field" data-person hidden>人物 ID<input class="inp" name="actorId"></label>
    <label class="field" data-person hidden>属性<input class="inp" name="attribute" placeholder="如 residence"></label>
    <label class="field" data-person hidden>视图<select class="inp" name="view"><option value="current">现状</option><option value="history">历史</option></select></label>
  </div><div class="row" style="margin-top:12px"><button class="btn primary">查询</button><span class="muted" id="continuity-status" role="status">选择会话、记录类型后查询。</span></div></form>
  <div class="card" id="continuity-list" aria-live="polite">尚未查询。</div>
  <details class="card"><summary>新增记录</summary><form id="continuity-write" style="margin-top:12px">
    <div class="grid"><label class="field" data-note>内容<textarea class="inp" name="text" maxlength="2000"></textarea></label>
    <label class="field">来源消息 ID<input class="inp" name="messageId" placeholder="本会话已入库的用户原话 ID"></label>
    <label class="field" data-day hidden>一天类型<select class="inp" name="dayKind"><option value="planned">计划</option><option value="occurred">实际发生</option><option value="fictional">虚构</option></select></label>
    <label class="field" data-day hidden>时间<input class="inp" name="at" type="datetime-local"></label>
    <label class="field" data-person hidden>状态值<input class="inp" name="value" placeholder="须在来源原话中逐字出现"></label>
    <label class="field" data-person hidden>生效时间（原话明确时才填）<input class="inp" name="effectiveAt" type="datetime-local"></label>
    </div><p class="muted" style="margin:10px 0">待办、实际发生和人物状态需要原话证据。念想、心事与虚构不会进入普通召回。时间按本机时区输入。</p>
    <button class="btn primary">保存</button>
  </form></details>`;
  const filter=root.querySelector('#continuity-filter'),writer=root.querySelector('#continuity-write');
  const status=root.querySelector('#continuity-status'),list=root.querySelector('#continuity-list');
  for(const card of root.querySelectorAll('.card'))card.style.minWidth='0';
  list.style.overflowX='auto';
  const field=name=>filter.elements[name].value.trim();
  function context() {
    if(!field('scopeId'))throw Error('先选择会话');
    const kind=field('kind'),ctx={scope:{kind:field('scopeKind'),id:field('scopeId')}};
    if(['thought','concern','day'].includes(kind)){
      if(!field('roleId'))throw Error('请填写接入配置中的角色 ID');
      Object.assign(ctx,{roleId:field('roleId'),kind});
    }
    if(kind==='temporal'){
      if(!field('actorId')||!field('attribute'))throw Error('人物状态需要人物 ID 和属性');
      Object.assign(ctx,{actorId:field('actorId'),attribute:field('attribute')});
    }
    return {kind,ctx,route:'spaces/'+encodeURIComponent(space)+'/'+(kind==='task'?'continuity-tasks':kind==='temporal'?'temporal-memory':'role-notes')};
  }
  function stateFields() {
    const kind=field('kind');epoch++;rows=[];list.textContent='条件已改变，请重新查询。';
    for(const el of root.querySelectorAll('[data-role]'))el.hidden=['task','temporal'].includes(kind);
    for(const el of root.querySelectorAll('[data-person]'))el.hidden=kind!=='temporal';
    for(const el of root.querySelectorAll('[data-day]'))el.hidden=kind!=='day';
    for(const el of root.querySelectorAll('[data-note],[data-status]'))el.hidden=kind==='temporal';
  }
  filter.onchange=stateFields;
  async function query() {
    const n=++epoch,{kind,ctx,route}=context();status.textContent='正在查询…';
    const result=await api(route+'/query','POST',{...ctx,...(kind==='temporal'?{view:field('view')}:{status:field('status')})});
    if(!root.isConnected||n!==epoch)return;
    rows=result.items||[];status.textContent=`${rows.length} 条记录`;
    const labels={open:'未结束',completed:'已完成',cancelled:'已取消',planned:'计划',occurred:'实际发生',fictional:'虚构'};
    list.innerHTML=rows.length?`<div class="table-wrap"><table><thead><tr><th>内容</th><th>状态 / 时间</th><th>来源与版本</th><th>操作</th></tr></thead><tbody>${rows.map((row,i)=>`<tr>
      <td style="white-space:pre-wrap;min-width:180px">${esc(row.text??row.value)}</td>
      <td>${esc(labels[row.dayKind]||labels[row.status]||'人物状态')}${row.at!=null?'<br>'+esc(new Date(row.at).toLocaleString('zh-CN')):''}${row.statedAt!=null?'<br>'+esc(new Date(row.statedAt).toLocaleString('zh-CN')):''}</td>
      <td><details><summary>${esc(row.id)}${row.revision?' · v'+esc(row.revision):''}</summary><pre>${esc(JSON.stringify(row.sourceRefs||[],null,2))}</pre></details></td>
      <td>${kind==='temporal'?`<button class="btn sm" data-retract="${i}">纠正撤回</button>`:row.status==='open'?`<button class="btn sm" data-complete="${i}">完成</button> <button class="btn sm" data-cancel="${i}">取消</button>${row.dayKind==='planned'?` <button class="btn sm" data-occur="${i}">记录发生</button>`:''}`:'—'}</td></tr>`).join('')}</tbody></table></div>`:'这个会话和角色下暂无符合条件的记录。';
  }
  async function run(fn) {try{await fn();}catch(e){if(root.isConnected){status.textContent=e.message;toast(e.message,'err');}}}
  filter.onsubmit=e=>{e.preventDefault();void run(query);};
  // Retain one operation ID across an uncertain network failure. Changed payloads
  // get a new ID; a response lost after commit can safely be retried.
  async function write(payload,route) {
    const fingerprint=JSON.stringify([route,payload]);
    if(mutation?.fingerprint!==fingerprint)mutation={fingerprint,id:crypto.randomUUID()};
    for(const button of root.querySelectorAll('button'))button.disabled=true;
    try {
      await api(route,'POST',{...payload,operationId:mutation.id});mutation=null;
      if(root.isConnected){toast('已保存','ok');await query();}
    }finally{for(const button of root.querySelectorAll('button'))button.disabled=false;}
  }
  writer.onsubmit=e=>{e.preventDefault();void run(async()=>{
    const {kind,ctx,route}=context(),data=new FormData(writer),payload={...ctx};
    const source=String(data.get('messageId')).trim();if(source)payload.messageId=source;
    if(kind==='temporal'){
      payload.value=String(data.get('value')).trim();
      if(data.get('effectiveAt'))payload.effectiveAt=new Date(data.get('effectiveAt')).getTime();
    }else payload.text=String(data.get('text')).trim();
    if(kind==='day'){
      if(!data.get('at'))throw Error('请填写一天条目的时间');
      payload.dayKind=data.get('dayKind');payload.at=new Date(data.get('at')).getTime();
    }
    await write(payload,route);
  });};
  list.onclick=e=>{const button=e.target.closest('button');if(!button)return;void run(async()=>{
    const action=['complete','cancel','occur','retract'].find(a=>button.dataset[a]!=null);if(!action)return;
    const row=rows[Number(button.dataset[action])];if(!row)return;
    const {kind,ctx,route}=context(),payload={...ctx};
    if(action==='retract'){
      const source=writer.elements.messageId.value.trim();if(!source)throw Error('请先在新增区域填写纠正原话的消息 ID');
      Object.assign(payload,{action:'retract',targetId:row.id,messageId:source});
    }else{
      Object.assign(payload,{id:row.id,expectedRevision:row.revision});
      if(action==='occur'){
        const source=writer.elements.messageId.value.trim(),at=writer.elements.at.value;
        if(!source||!at)throw Error('请先在新增区域填写实际发生时间与原话消息 ID');
        Object.assign(payload,{dayKind:'occurred',at:new Date(at).getTime(),messageId:source});
      }else payload.status=action==='complete'?'completed':'cancelled';
    }
    await write(payload,route);
  });};
  stateFields();
}
