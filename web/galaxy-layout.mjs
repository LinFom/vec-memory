function hash(s){let h=2166136261;for(const c of s)h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;}
function random(seed){let h=hash(seed);return()=>{h+=0x6D2B79F5;let t=h;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};}
const TAU=Math.PI*2, GOLDEN=2.399963229728653;
const clamp=(v,lo,hi)=>v<lo?lo:v>hi?hi:v;
// Cohesive irregular ellipsoid galaxy: channel anchors sit INSIDE the main volume
// (radius 150-300, Fibonacci directions, varying radial depths) and their members bloom
// into overlapping 220-400 blobs, so islands merge into one dense noisy core instead of
// rings or isolated balls. Bridges sit on weighted channel barycenters; unaffiliated
// people fill the central volume. All offsets come from stable ids, so it is deterministic.
export function layoutGalaxy(nodes,edges){
  const byId=new Map(),channels=[],members=new Map(),pop=new Map(),satellite=new Set();
  for(const n of nodes){byId.set(n.id,n);if(n.type==='channel')channels.push(n);}
  channels.sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  const anchors=new Map();
  for(const e of edges){
    if(e.type==='memory'){if(byId.has(e.target))satellite.add(e.target);continue;}
    if(e.type!=='appearance')continue;
    const list=members.get(e.source)||(members.set(e.source,[]),members.get(e.source));
    list.push({id:e.target,count:Math.max(1,+e.count||1)});
    pop.set(e.target,(pop.get(e.target)||0)+1);
  }
  let maxPop=1;for(const c of channels){const p=pop.get(c.id)||0;if(p>maxPop)maxPop=p;}
  const logMax=Math.log1p(maxPop),total=Math.max(1,channels.length);
  channels.forEach((n,i)=>{
    const rng=random('anchor|'+n.id);
    const y=1-2*(i+.5)/total,ring=Math.sqrt(Math.max(0,1-y*y));
    const a=i*GOLDEN+(rng()-.5)*.9;
    const depth=150+150*(.35*rng()+.65*((i*.6180339887)%1));
    const radius=clamp(depth+(rng()-.5)*45,150,300);
    Object.assign(n,{
      x:clamp(Math.cos(a)*ring*radius*(1+(rng()-.5)*.12),-300,300),
      y:clamp(y*radius*.94*(1+(rng()-.5)*.12),-300,300),
      z:clamp(Math.sin(a)*ring*radius*(1+(rng()-.5)*.12),-300,300)});
    anchors.set(n.id,{x:n.x,y:n.y,z:n.z});
  });
  const spread=(id)=>220+180*(logMax>0?Math.log1p(pop.get(id)||0)/logMax:0);
  for(const n of nodes){
    if(anchors.has(n.id)||satellite.has(n.id))continue;
    const groups=(members.get(n.id)||[]).filter(g=>anchors.has(g.id));
    const rng=random((groups.length?'member|':'field|')+n.id);
    if(groups.length){
      let sx=0,sy=0,sz=0,sw=0,sr=0;
      for(const g of groups){const a=anchors.get(g.id),w=Math.sqrt(g.count);sx+=a.x*w;sy+=a.y*w;sz+=a.z*w;sw+=w;sr+=spread(g.id)*w;}
      const c={x:sx/sw,y:sy/sw,z:sz/sw};
      const widen=1+.25*Math.min(1,Math.log1p(groups.length-1)/Math.log1p(8));
      const r=clamp((sr/sw)*widen,220,400)*Math.cbrt(rng());
      const u=rng()*2-1,theta=rng()*TAU,sq=Math.sqrt(Math.max(0,1-u*u));
      Object.assign(n,{x:c.x+sq*Math.cos(theta)*r,y:c.y+u*r*.92,z:c.z+sq*Math.sin(theta)*r});
    }else{
      const u=rng()*2-1,theta=rng()*TAU,sq=Math.sqrt(Math.max(0,1-u*u));
      const k=Math.cbrt(rng())*(1-.28*Math.pow(rng(),2.2)-.06*rng());
      Object.assign(n,{x:sq*Math.cos(theta)*600*k,y:u*500*k,z:sq*Math.sin(theta)*560*k});
    }
  }
  // Soft irregular envelope: keep the silhouette a noisy ellipsoid near x600/y500/z560.
  const ext={x:0,y:0,z:0};
  for(const n of nodes){if(satellite.has(n.id))continue;ext.x=Math.max(ext.x,Math.abs(n.x));ext.y=Math.max(ext.y,Math.abs(n.y));ext.z=Math.max(ext.z,Math.abs(n.z));}
  const scale={x:600/(ext.x||1),y:500/(ext.y||1),z:560/(ext.z||1)};
  for(const n of nodes){if(satellite.has(n.id))continue;n.x*=clamp(scale.x,.75,1.25);n.y*=clamp(scale.y,.75,1.25);n.z*=clamp(scale.z,.75,1.25);}
  // Memory satellites inherit their owner's position, with deterministic offsets.
  for(const e of edges)if(e.type==='memory'){const a=byId.get(e.source),b=byId.get(e.target);if(a&&b){const r=random('sat|'+b.id);b.x=a.x+(r()-.5)*55;b.y=a.y+(r()-.5)*55;b.z=a.z+(r()-.5)*55;}}
  return nodes;
}
