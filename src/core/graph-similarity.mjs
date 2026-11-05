// Optional content similarity. This is deliberately not a social relationship.
export function graphSimilarity(nodes,memories,resolveAccount=id=>id){
 const owner=new Map();for(const n of nodes)for(const id of n.accounts||[])owner.set(resolveAccount(id),n.id);
 const tokens=new Map();for(const m of memories){const id=owner.get(resolveAccount(m.actorId));if(!id)continue;if(!tokens.has(id))tokens.set(id,new Set());const set=tokens.get(id);
   for(const part of String(m.text||'').toLowerCase().match(/[a-z]{3,}|[\u4e00-\u9fff]{2,}/g)||[]){if(set.size>=200)break;if(/^[a-z]/.test(part))set.add(part);else for(let i=0;i<part.length-1&&set.size<200;i++)set.add(part.slice(i,i+2));}}
 const postings=new Map();for(const [id,terms]of tokens)for(const term of terms){if(!postings.has(term))postings.set(term,[]);postings.get(term).push(id);}
 const pairs=new Map();for(const ids of postings.values()){if(ids.length>30)continue;for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){const pair=[ids[i],ids[j]].sort(),key=JSON.stringify(pair),p=pairs.get(key)||{source:pair[0],target:pair[1],shared:0};p.shared++;pairs.set(key,p);}}
 const candidates=[...pairs.values()].map(p=>({...p,weight:p.shared/(tokens.get(p.source).size+tokens.get(p.target).size-p.shared)})).filter(p=>p.shared>=3&&p.weight>=.3).sort((a,b)=>b.weight-a.weight);
 const counts=new Map(),edges=[];for(const p of candidates){if((counts.get(p.source)||0)>=3||(counts.get(p.target)||0)>=3)continue;counts.set(p.source,(counts.get(p.source)||0)+1);counts.set(p.target,(counts.get(p.target)||0)+1);edges.push({...p,id:'similarity:'+JSON.stringify([p.source,p.target]),type:'similarity',method:'keyword-jaccard',count:1});}return edges;
}
