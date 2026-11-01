import {tokenOverlapSims} from './inject.mjs';

// Automatic context gets small keyword leads, not complete profile cards.
// A deliberate tool query continues to use the full retrieval path.
export function keywordImpressions({candidates=[],profiles=[],query='',limit=2}={}) {
  if(!String(query).trim())return [];
  const pool=[...candidates.map(c=>({...c,section:'semantic'})),...profiles.flatMap(c=>
    (c.rec?.content?.items||[]).map(item=>({...c,section:'profile',itemKey:item.k,
      line:`${item.k}=${Array.isArray(item.v)?item.v.join('、'):String(item.v)}`})))];
  // A name is a useful lead, but the requested attribute must outrank name-only matches.
  const bodies=tokenOverlapSims(pool.map(c=>c.line),String(query));
  const names=tokenOverlapSims(pool.map(c=>c.who),String(query));
  return pool.map((c,i)=>({...c,keywordScore:bodies[i]*2+names[i]*0.25})).filter(c=>c.keywordScore>0)
    .sort((a,b)=>b.keywordScore-a.keywordScore||Number(b.credibility)-Number(a.credibility))
    .slice(0,Math.max(0,Math.min(2,Number(limit)||2)))
    .map(c=>({...c,line:c.line.length>180?c.line.slice(0,180)+'…':c.line}));
}
