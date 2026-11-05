// View-only union. Identity proof is supplied by the administrator, never by names.
export function unionGraphs(results){
 const parents=new Map(),identities=new Map(),find=id=>{while(parents.has(id))id=parents.get(id);return id;};
 const rows=[];
 for(const {source,result}of results)for(const n of result.nodes){const id=source+'::'+n.id;rows.push({source,n,id});for(const key of n.verifiedIdentities||[]){const proof=n.type+':'+key;if(identities.has(proof)){const a=find(id),b=find(identities.get(proof));if(a!==b)parents.set(a,b);}else identities.set(proof,id);}}
 const nodes=new Map();for(const {source,n,id}of rows){const key=find(id),origin={spaceId:source,originId:n.id,accounts:n.accounts||[]};if(!nodes.has(key))nodes.set(key,{...n,id:key,spaceId:source,originId:n.id,origins:[],activity:0,accounts:[]});const out=nodes.get(key);out.origins.push(origin);out.activity+=n.activity||0;out.accounts=[...new Set([...out.accounts,...(n.accounts||[])])];}
 const edges=[];for(const {source,result}of results)for(const e of result.edges){const a=find(source+'::'+e.source),b=find(source+'::'+e.target);if(a!==b)edges.push({...e,id:source+'::'+e.id,source:a,target:b,spaceId:source,originId:e.id});}
 const adj=new Map();for(const e of edges){if(!adj.has(e.source))adj.set(e.source,new Set());if(!adj.has(e.target))adj.set(e.target,new Set());adj.get(e.source).add(e.target);adj.get(e.target).add(e.source);}
 for(const n of nodes.values())n.degree=adj.get(n.id)?.size||0;
 return {nodes:[...nodes.values()],edges};
}
