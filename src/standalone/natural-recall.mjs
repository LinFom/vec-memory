import { tokenize } from '../core/tokens.mjs';

const generic = new Set(['现在','今天','明天','后天','怎么','什么','最近','可以','记得','时候','已经','我们','你们','他们','不过','可能','谢谢','这个','那个','还是','就是','一个','一下','但是','然后','觉得','知道','事情']);
export function topicTerms(query) {
  return [...new Set(tokenize(String(query).slice(0,600)).filter(term=>term.length>1 && !generic.has(term)))];
}
export function topicScore(query, text) {
  const terms = topicTerms(query), words = new Set(tokenize(text));
  const matches=terms.filter(term=>words.has(term));
  if(!matches.length)return 0;
  // One two-character overlap in a long sentence is weak evidence of a topic.
  if(matches.length===1 && terms.length>3 && !/[a-z0-9]{3}/i.test(matches[0]))return 0;
  return matches.reduce((sum,term)=>sum+(/\d/.test(term)?2:1),0)/Math.sqrt(Math.max(1,terms.length));
}
export function naturalRecallLimit(request) {
  const requested=Number(request.naturalLimit ?? request.limit);
  return Number.isFinite(requested)?Math.min(3,Math.max(1,Math.floor(requested))):1;
}
