import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, MemoryError, requireText } from './durable-log.mjs';

// Only service-owned keys are editable. Host, bridge and launch options stay outside this surface.
const field=(key,label,group,type='string',extra={})=>({key,label,group,type,...extra});
export const SETTINGS_FIELDS = [
  field('botName','机器人名称','身份','string',{restart:true}),
  field('selfAliases','机器人别称（逗号分隔）','身份'),
  field('embedBaseURL','嵌入服务地址','嵌入模型','url'),
  field('embedApiKey','嵌入 API Key','嵌入模型','secret'),
  field('embedModel','嵌入模型名称','嵌入模型'),
  field('embedDimensions','嵌入维度（空表示由模型决定）','嵌入模型','integer',{min:1,max:65536,empty:true}),
  field('embedBatchSize','每批嵌入条数','嵌入模型','integer',{min:1,max:128}),
  field('embedTimeoutMs','嵌入超时（毫秒）','嵌入模型','integer',{min:1000,max:600000}),
  field('llmEndpointKind','整理模型运行位置','整理模型','select',{options:[['','未配置'],['local','本机'],['external','外部服务']]}),
  field('llmBaseURL','整理模型服务地址','整理模型','url'),
  field('llmApiKey','整理 API Key','整理模型','secret'),
  field('llmModel','整理模型名称','整理模型'),
  field('injectEnabled','允许向对话提供记忆','采用与召回','boolean'),
  field('rememberEnabled','允许模型直接记忆','采用与召回','boolean',{fallback:true}),
  field('shadowMode','检索影子模式','采用与召回','boolean'),
  field('topK','检索结果上限','采用与召回','integer',{min:1,max:100}),
  field('injectPerPerson','每人印象条数','采用与召回','integer',{min:1,max:30}),
  field('injectTotal','印象总条数','采用与召回','integer',{min:1,max:100}),
  field('injectThreshold','向量相关性阈值','采用与召回','number',{min:0,max:1}),
  field('injectMode','相关性处理','采用与召回','select',{options:[['boost','相关时优先'],['hard','达到阈值才采用']]}),
  field('profilePolicy','人物档案跨场合策略','采用与召回','select',{options:[['','沿用当前兼容策略'],['same-scope','仅本场合'],['group-peers','本场合及其他群'],['all','所有场合（含私聊来源）']]}),
  field('crossChatEnabled','启用跨会话近况','跨会话近况','boolean'),
  field('crossChatInPrivate','私聊采用其他会话近况','跨会话近况','boolean'),
  field('crossChatInGroup','群聊采用其他群的近况','跨会话近况','boolean'),
  field('crossChatIncludePrivate','允许私聊作为近况来源','跨会话近况','boolean'),
  field('crossChatMinutes','近况时间窗（分钟）','跨会话近况','integer',{min:1,max:1440}),
  field('crossChatMaxChats','近况来源会话上限','跨会话近况','integer',{min:1,max:20}),
  field('autoIndexEnabled','启用自动索引','自动处理','boolean',{restart:true}),
  field('autoIndexIntervalMin','索引间隔（分钟，0 停止定时索引）','自动处理','integer',{min:0,max:10080,restart:true}),
  field('consolidateEnabled','启用事件自动整理','自动处理','boolean',{restart:true}),
  field('consolidateIntervalMin','整理间隔（分钟，0 使用服务默认）','自动处理','integer',{min:0,max:10080,restart:true}),
  field('consolidateWindowMsgs','每个整理窗口消息上限','自动处理','integer',{min:1,max:2000}),
  field('consolidateMaxWindowsPerRun','每轮整理窗口上限','自动处理','integer',{min:1,max:100}),
  field('consolidateMaxTokens','整理输出 token 上限','自动处理','integer',{min:100,max:64000}),
  field('consolidateTimeoutMs','整理超时（毫秒）','自动处理','integer',{min:1000,max:1200000}),
  field('subjectMemoryEnabled','启用主体自动观察提取','自动处理','boolean',{fallback:false}),
  field('layerMaintenance','整理时维护事件层','事件生命周期','boolean'),
  field('eventAutoEmbed','允许新事件自动嵌入','事件生命周期','boolean'),
  field('promoteHits','升长期所需采用次数','事件生命周期','integer',{min:1,max:10000}),
  field('retireDays','无采用事件的回收时间锚点（天）','事件生命周期','integer',{min:1,max:36500}),
  field('consolidateInjectCount','近期事件采用条数','事件生命周期','integer',{min:1,max:100}),
  field('consolidateEventRelatedCount','相关事件采用条数','事件生命周期','integer',{min:1,max:100}),
];
const fields=new Map(SETTINGS_FIELDS.map(f=>[f.key,f]));
const object=v=>v!==null && typeof v==='object' && !Array.isArray(v);
export function settingsView(explicit={}, defaults={}, botName='') {
  const values={}, secrets={};
  for(const f of SETTINGS_FIELDS) {
    if(f.type==='secret') {secrets[f.key]=!!explicit[f.key];continue;}
    values[f.key]=f.key==='botName'?botName:(explicit[f.key] ?? defaults[f.key] ?? f.fallback ?? '');
  }
  return {fields:SETTINGS_FIELDS,values,secrets};
}
function validateValue(f,value) {
  if(f.type==='secret' && value===null) return '';
  if(f.type==='boolean') {if(typeof value==='boolean')return value;}
  else if(f.type==='integer'||f.type==='number') {
    if(value===''&&f.empty)return '';
    if(typeof value==='number'&&Number.isFinite(value)&&value>=f.min&&value<=f.max&&(f.type!=='integer'||Number.isInteger(value)))return value;
  } else if(typeof value==='string' && value.length<=(f.type==='secret'?4096:2000) && !/[\r\n\x00]/.test(value)) {
    const clean=value.trim();
    if(f.type==='select') {if(f.options.some(([v])=>v===clean))return clean;}
    else if(f.type==='url' && clean) {
      try {const u=new URL(clean);if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash)return clean;} catch {}
    } else return clean;
  }
  throw new MemoryError('INVALID_ARGUMENT',`配置项「${f.label}」的值或范围不正确`);
}

export function createFileSettingsEditor(sourceRoot, {io=fs}={}) {
  const file=path.join(path.resolve(sourceRoot),'config.json');
  function read() {
    let raw;
    try {raw=io.readFileSync(file,'utf8');} catch(e) {
      if(e.code==='ENOENT') return {raw:null,data:{},etag:digest(null)};
      throw new MemoryError('CONFIG_UNAVAILABLE','无法读取配置文件',503);
    }
    let data;
    try {data=JSON.parse(raw);if(!object(data)||data.skills!=null&&!object(data.skills)||data.skills?.['memory-vec']!=null&&!object(data.skills['memory-vec'])||data.persona!=null&&!object(data.persona))throw Error();}
    catch {throw new MemoryError('CONFIG_INVALID','配置文件格式损坏，已拒绝覆盖；请先修复 config.json',503);}
    return {raw,data,etag:digest(raw)};
  }
  function view(defaults) {
    const {data,etag}=read();
    return {ok:true,writable:true,configFile:file,etag,...settingsView(data.skills?.['memory-vec'],defaults,data.persona?.botName||'')};
  }
  function update(request,defaults) {
    requireText(request?.expectedEtag,'expectedEtag',100);
    if(!object(request.patch)||!Object.keys(request.patch).length) throw new MemoryError('INVALID_ARGUMENT','请提供需要修改的配置项');
    const current=read();
    if(current.etag!==request.expectedEtag) throw new MemoryError('STALE_SETTINGS','配置已被其他页面修改，请重新读取并比较草稿',409);
    const patch={};
    for(const [key,value] of Object.entries(request.patch)) {
      const f=fields.get(key);
      if(!f) throw new MemoryError('INVALID_ARGUMENT','请求包含不支持的配置项');
      patch[key]=validateValue(f,value);
      // An empty password box preserves the old key. Explicit null clears it.
      if(f.type==='secret'&&value==='') delete patch[key];
    }
    const data=current.data;
    data.skills??={};data.skills['memory-vec']??={};
    for(const [key,value] of Object.entries(patch)) {
      if(key==='botName') {data.persona??={};data.persona.botName=value;}
      else data.skills['memory-vec'][key]=value;
    }
    const temp=file+'.'+randomUUID()+'.tmp';let fd;
    try {
      io.mkdirSync(path.dirname(file),{recursive:true});
      fd=io.openSync(temp,'wx',0o600);
      io.writeFileSync(fd,JSON.stringify(data,null,2)+'\n');io.fsyncSync(fd);io.closeSync(fd);fd=undefined;
      if(read().etag!==current.etag) throw new MemoryError('STALE_SETTINGS','配置在保存期间被其他页面修改',409);
      io.renameSync(temp,file);
    } catch(e) {
      if(e instanceof MemoryError)throw e;
      throw new MemoryError('CONFIG_WRITE_FAILED','配置保存失败，原文件未替换',503);
    } finally {
      if(fd!==undefined)io.closeSync(fd);
      if(io.existsSync(temp))io.unlinkSync(temp);
    }
    return {...view(defaults),changed:Object.keys(patch),restartRequired:Object.keys(patch).some(k=>fields.get(k).restart)};
  }
  return {getMemorySettings:view,updateMemorySettings:update};
}
