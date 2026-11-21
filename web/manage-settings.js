export async function renderSettings({api,content,live,esc,error}) {
  let data=await api.get('memory/settings','settings');
  if(!live())return;
  function draw(preserved={}) {
    content.innerHTML=`<div class="card"><h2>当前服务配置</h2><p>配置文件：${esc(data.configFile||'由宿主适配器提供')}</p><small>库根：${esc(data.dataRoot)}<br>原料来源：${esc(data.sourceRoot)}</small><p class="muted">这里配置记忆服务；桥的服务地址、自动启动和宿主工具开关在宿主「插件管理 → 向量记忆库 → 设置」里管理（插件已不带独立设置页）。</p>${!data.writable?`<p class="error">${esc(data.reason||'当前连接仅支持读取设置')}</p>`:''}</div><form id="service-settings"><div id="settings-groups" class="full-width"></div><div class="settings-toolbar full-width"><button id="save-settings" ${data.writable?'':'disabled'}>保存修改</button><button id="reload-settings" type="button">重新读取（保留草稿）</button><span id="settings-status" role="status"></span></div></form>`;
    const groups=[...new Set(data.fields.map(f=>f.group))];
    const fieldHtml=f=>{
      const value=data.values[f.key]??'', id='setting-'+f.key;
      let control;
      if(f.type==='boolean')control=`<input id="${id}" type="checkbox" ${value?'checked':''}>`;
      else if(f.type==='select')control=`<select id="${id}">${f.options.map(([v,label])=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(label)}</option>`).join('')}</select>`;
      else control=`<input id="${id}" type="${f.type==='secret'?'password':f.type==='number'||f.type==='integer'?'number':f.type==='url'?'url':'text'}" value="${f.type==='secret'?'':esc(value)}" ${f.min!=null?`min="${f.min}" max="${f.max}" step="${f.type==='integer'?1:'any'}"`:''} ${['number','integer'].includes(f.type)&&!f.empty?'required':''} ${f.type==='secret'?'autocomplete="new-password"':''} placeholder="${f.type==='secret'?(data.secrets[f.key]?'已设置，留空保留':'未设置，可留空'):''}">`;
      return `<div class="setting-field ${f.type==='boolean'?'setting-check':''}"><label for="${id}">${esc(f.label)}${f.restart?'（重启后生效）':''}</label>${control}${f.type==='secret'?`<label class="secret-clear"><input type="checkbox" id="clear-${f.key}">清除此密钥</label>`:''}</div>`;
    };
    document.querySelector('#settings-groups').innerHTML=groups.map((g,i)=>`<details class="card settings-group" ${i<3?'open':''}><summary>${esc(g)}</summary>${g==='嵌入模型'?'<p class="muted">修改模型或维度不会自动重建已有向量；请按重建流程处理模型兼容性。</p>':''}${g==='自动处理'?'<p class="muted">开启后可能产生模型调用；定时任务参数调整后重启服务以应用调度。</p>':''}<div class="settings-grid">${data.fields.filter(f=>f.group===g).map(fieldHtml).join('')}</div></details>`).join('');
    const form=document.querySelector('#service-settings'),status=document.querySelector('#settings-status'),save=document.querySelector('#save-settings');
    for(const f of data.fields) {
      const input=document.querySelector('#setting-'+f.key);
      if(Object.hasOwn(preserved,f.key)) {
        if(f.type==='secret'&&preserved[f.key]===null)document.querySelector('#clear-'+f.key).checked=true;
        else if(f.type==='boolean')input.checked=preserved[f.key];
        else input.value=preserved[f.key];
      }
    }
    if(!data.writable)form.querySelectorAll('input,select').forEach(x=>x.disabled=true);
    const draft=()=>{
      const patch={};
      for(const f of data.fields) {
        const input=document.querySelector('#setting-'+f.key);
        if(f.type==='secret') {
          if(document.querySelector('#clear-'+f.key).checked)patch[f.key]=null;
          else if(input.value)patch[f.key]=input.value;
          continue;
        }
        const value=f.type==='boolean'?input.checked:['number','integer'].includes(f.type)?(input.value===''?'':Number(input.value)):input.value;
        if(value!==(data.values[f.key]??''))patch[f.key]=value;
      }
      return patch;
    };
    document.querySelector('#reload-settings').onclick=async()=>{
      const patch=draft();status.textContent='正在重新读取…';
      try {
        const next=await api.get('memory/settings','settings');
        if(!live())return;
        if(next.instanceId!==data.instanceId)throw Error('服务实例已变化，请重新打开页面');
        data=next;draw(patch);
        document.querySelector('#settings-status').textContent='已重新读取，草稿保留；请比较后再保存。';
      }catch(e){if(live()&&e.name!=='AbortError')status.innerHTML=error(e);}
    };
    form.onsubmit=async e=>{
      e.preventDefault();const patch=draft();
      if(!Object.keys(patch).length){status.textContent='没有需要保存的修改';return;}
      const fields=[...form.querySelectorAll('input,select,button')];fields.forEach(x=>x.disabled=true);
      status.textContent='正在保存…';
      try {
        const next=await api.write('memory/settings',{expectedInstanceId:data.instanceId,expectedEtag:data.etag,patch});
        if(!live())return;
        data=next;draw();
        document.querySelector('#settings-status').textContent=next.restartRequired?'已保存；请重启记忆服务使标注的设置生效。':'已保存，后续请求使用新设置。';
      }catch(err){
        if(!live())return;
        fields.forEach(x=>x.disabled=false);save.disabled=!data.writable;
        status.innerHTML=error(err)+'<span>草稿已保留。保存结果不确定或发生冲突时，请先重新读取并比较。</span>';
      }
    };
  }
  draw();
}
