function hash(s){let h=2166136261;for(const c of s)h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;}
function random(seed){let h=hash(seed);return()=>{h+=0x6D2B79F5;let t=h;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};}
export function layoutGalaxy(nodes,edges){
  const byId=new Map(nodes.map(n=>[n.id,n])),channels=nodes.filter(n=>n.type==='channel').sort((a,b)=>a.id.localeCompare(b.id));
  const anchors=new Map(),members=new Map();
  channels.forEach((n,i)=>{const y=1-2*(i+.5)/Math.max(1,channels.length),a=i*2.3999632297,r=Math.sqrt(1-y*y);anchors.set(n.id,{x:Math.cos(a)*r*550,y:y*400,z:Math.sin(a)*r*550});});
  for(const e of edges)if(e.type==='appearance'){if(!members.has(e.source))members.set(e.source,[]);members.get(e.source).push({id:e.target,count:e.count||1});}
  for(const n of nodes){const rng=random(n.id),anchor=anchors.get(n.id);if(anchor){Object.assign(n,anchor);continue;}
    const groups=(members.get(n.id)||[]).filter(g=>anchors.has(g.id));let center={x:0,y:0,z:0};
    if(groups.length){const total=groups.reduce((s,g)=>s+Math.sqrt(g.count),0);for(const g of groups){const a=anchors.get(g.id),w=Math.sqrt(g.count)/total;center.x+=a.x*w;center.y+=a.y*w;center.z+=a.z*w;}}
    const u=rng()*2-1,theta=rng()*Math.PI*2,r=(groups.length?135:700)*Math.cbrt(rng()),v=Math.sqrt(1-u*u);
    Object.assign(n,{x:center.x+r*v*Math.cos(theta),y:center.y+r*u,z:center.z+r*v*Math.sin(theta)});
  }
  // Memory satellites inherit their owner's position, with deterministic offsets.
  for(const e of edges)if(e.type==='memory'){const a=byId.get(e.source),b=byId.get(e.target);if(a&&b){const r=random(b.id);b.x=a.x+(r()-.5)*75;b.y=a.y+(r()-.5)*75;b.z=a.z+(r()-.5)*75;}}
  return nodes;
}
