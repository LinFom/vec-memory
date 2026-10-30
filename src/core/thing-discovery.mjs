import {MemoryError,requireText} from './durable-log.mjs';
import {SUBJECT_KINDS} from './subjects.mjs';
const fail=message=>{throw new MemoryError('INVALID_DISCOVERY',message);};
const exactMention=(text,name)=>{
  const token=name.normalize('NFC').toLowerCase(),haystack=text.normalize('NFC').toLowerCase();
  if(!/^[a-z0-9 _.-]+$/i.test(token))return haystack.includes(token);
  return new RegExp('(^|[^a-z0-9_])'+token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'($|[^a-z0-9_])','i').test(haystack);
};
export const DISCOVERY_PROMPT='可额外输出 discoveries:[{kind,label,aliases:[],interpretation,aspect,statement,claimType,evidenceIds:[],quote}]。用于发现此前未登记的新梗、概念、作品、项目、物件。kind=meme/concept/work/project/object/case；interpretation=mention/definition/usage。只有出现名称但没有解释的词用 mention，statement 留空，不因频繁出现就声称它是事实或梗；definition 必须有发言者明确解释名称，usage 必须有具体用法说明。quote 必须逐字摘自证据消息，完整保留名称与解释/用法。statement 只改写证据，不补常识、不猜起源；aspect 可为含义/起源/用法/场景等。aliases 只有消息明确说两个名称指同一事物时填写，不根据近义或相似拼写猜测。每项必须给下方真实 user 消息 evidenceIds；没有发现给空数组。';

export function prepareDiscoveries({win,windowId,scope,discoveries=[],normalize=s=>s}) {
  if(!Array.isArray(discoveries)||discoveries.length>30)fail('discoveries must be an array, max 30');
  if(!discoveries.length)return [];
  const rows=new Map(win.rows.filter(r=>!r.self&&(!r.role||r.role==='user')).map(r=>[String(r.id),r]));
  const entries=discoveries.map(d=>{
    if(!d||typeof d!=='object')fail('Discovery must be an object');
    const label=requireText(d.label??d.name,'label',200),kind=d.kind||'concept',interpretation=d.interpretation||((d.statement&&d.quote)?'definition':'mention');
    if(!SUBJECT_KINDS.includes(kind)||kind==='group')fail('Unsupported discovery kind');
    if(!['mention','definition','usage'].includes(interpretation))fail('Invalid discovery interpretation');
    if(!Array.isArray(d.evidenceIds)||!d.evidenceIds.length||d.evidenceIds.length>30)fail('Discovery requires source message IDs');
    const ids=[...new Set(d.evidenceIds.map(String))];
    if(ids.some(id=>!rows.has(id)))fail('Every discovery requires accepted user evidence in this window');
    const evidence=ids.map(id=>String(rows.get(id).text||'')),quote=String(d.quote||'').trim();
    if(!evidence.some(text=>exactMention(text,label)))fail('Discovered name is absent from evidence');
    if(interpretation!=='mention'&&(!quote||!evidence.some(text=>text.includes(quote))||!exactMention(quote,label)))fail('Definition and usage require an exact quote containing the name');
    const aliases=d.aliases||[];
    if(!Array.isArray(aliases)||aliases.length>30)fail('aliases must be an array, max 30');
    for(const alias of aliases){requireText(alias,'alias',200);if(!quote||!exactMention(quote,alias)||!exactMention(quote,label))fail('Aliases require a quote containing both names');}
    const claimType=d.claimType||'fact';if(!['fact','opinion','pattern'].includes(claimType))fail('Invalid claimType');
    const statement=interpretation==='mention'?`出现过“${label}”，含义待确认`:requireText(d.statement,'statement',2000);
    return {kind,label:normalize(label),aliases:[...new Set(aliases.map(normalize))],interpretation,claimType,
      aspect:requireText(d.aspect||(interpretation==='mention'?'待解释':'含义'),'aspect',100),statement:normalize(statement),quote,
      originalLabel:label,originalAliases:aliases,evidenceIds:ids,observedAt:win.toTs,
      provenance:ids.map(id=>({type:'message',id,chatKey:win.chatKey,fromTs:win.fromTs,toTs:win.toTs,matchMethod:'discovery-evidence-id'}))};
  });
  return [{operationId:`window:${windowId}:discoveries`,scope,entries}];
}
export function applyDiscoveries(subjectStore,requests,win,scope){
  const known=new Map(win.rows.filter(r=>!r.self&&(!r.role||r.role==='user')).map(r=>[String(r.id),r]));
  return requests.map(request=>subjectStore.applyDiscovery(request,{verifyEntry:(entry,s)=>s===scope&&entry.provenance.every(ref=>ref.chatKey===win.chatKey&&known.has(ref.id))&&entry.evidenceIds.every(id=>known.has(id))}));
}
