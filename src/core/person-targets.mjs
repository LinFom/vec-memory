// Resolve people mentioned in text without guessing identities or matching name fragments.
// Longer names occupy their spans even when ambiguous: 柚子 must not match inside 蜂蜜柚子茶.
export function mentionedPeople(text, entities) {
  const source=String(text||'').normalize('NFKC'), terms=new Map();
  for(const e of entities) {
    if(!['person','self'].includes(e.kind||'person'))continue;
    for(const value of [e.id,e.displayName,...(e.surface||e.surfaces||[]),...(e.aliases||[])]) {
      const term=String(value||'').normalize('NFKC').trim();if(!term)continue;
      if(!terms.has(term))terms.set(term,new Set());terms.get(term).add(e.id);
    }
  }
  const spans=[],ids=[],ambiguous=[];
  for(const [term,owners]of [...terms].sort((a,b)=>b[0].length-a[0].length)) {
    for(let at=source.indexOf(term);at>=0;at=source.indexOf(term,at+term.length)) {
      const end=at+term.length;
      if(spans.some(s=>at<s.end&&end>s.at))continue;
      const word=/^[\x00-\x7f]+$/.test(term)?/[A-Za-z0-9_]/:term.length===1?/[\p{L}\p{N}_]/u:null;
      if(word&&(word.test(source[at-1]||'')||word.test(source[end]||'')))continue;
      spans.push({at,end});
      if(owners.size===1)ids.push([...owners][0]);else ambiguous.push(term);
    }
  }
  return {ids:[...new Set(ids)],ambiguous:[...new Set(ambiguous)]};
}
