import * as T from './vendor/three/three.module.js';
import {OrbitControls} from './vendor/three/OrbitControls.js';
import {layoutGalaxy} from './galaxy-layout.mjs';

const palette={person:0xb9e9ff,channel:0xffcc83,memory:0x9e8cff,similarity:0x8176b5,appearance:0x427b9c,interaction:0x41d5ca,relationship:0xffc77b,attitude:0xed91c1};
export function createGalaxyRenderer(container,{onSelect=()=>{},onDoubleClick=()=>{}}={}){
  const renderer=new T.WebGLRenderer({antialias:false,alpha:false,powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.75));renderer.setClearColor(0x030711);container.append(renderer.domElement);
  const scene=new T.Scene(),camera=new T.PerspectiveCamera(50,1,1,15000);camera.position.set(0,360,1750);
  const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.dampingFactor=.08;controls.minDistance=8;controls.maxDistance=6000;
  const overlay=document.createElement('div');overlay.className='galaxy-labels';container.append(overlay);
  let nodes=[],edges=[],byId=new Map(),adj=new Map(),points,lines,selected=null,lit=null,local=false,metric='degree',layers=new Set(Object.keys(palette)),labels=[],disposed=false,frame,flight,lod=0;
  let last=performance.now(),frames=0,fps=0;
  function clearGeometry(){for(const o of [points,lines])if(o){scene.remove(o);o.geometry.dispose();o.material.dispose();}overlay.replaceChildren();labels=[];}
  function rebuild(){
    clearGeometry();const positions=[],colors=[],sizes=[];
    for(const n of nodes){positions.push(n.x,n.y,n.z);const c=new T.Color(palette[n.type]||palette.person),visible=!local||!lit||lit.has(n.id),bright=!selected||lit?.has(n.id)?1:.10;
      c.multiplyScalar(visible?bright:0);colors.push(c.r,c.g,c.b);sizes.push(visible?(n.type==='channel'?13:4+Math.min(13,Math.sqrt(n[metric]||0)*.65)):0);}
    const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(positions,3));geometry.setAttribute('color',new T.Float32BufferAttribute(colors,3));geometry.setAttribute('size',new T.Float32BufferAttribute(sizes,1));
    const material=new T.ShaderMaterial({vertexColors:true,transparent:true,depthWrite:false,blending:T.AdditiveBlending,
      vertexShader:'attribute float size; varying vec3 vColor; void main(){vColor=color; vec4 mv=modelViewMatrix*vec4(position,1.0);gl_PointSize=clamp(size*1000.0/max(80.0,-mv.z),2.0,60.0);gl_Position=projectionMatrix*mv;}',
      fragmentShader:'varying vec3 vColor; void main(){float d=length(gl_PointCoord-vec2(.5))*2.0;if(d>1.0)discard;float a=pow(1.0-d,2.0);gl_FragColor=vec4(vColor,a);}' });
    points=new T.Points(geometry,material);scene.add(points);
    const ep=[],ec=[];
    let edgeIndex=0;const weakStride=lod===2?1:Math.max(1,Math.ceil(edges.length/(lod===1?6000:1600)));
    for(const e of edges){const sample=edgeIndex++%weakStride===0;if(!layers.has(e.type))continue;const a=byId.get(e.source),b=byId.get(e.target);if(!a||!b)continue;
      const relevant=selected&&(e.source===selected||e.target===selected||lit?.has(e.source)&&lit?.has(e.target));
      if(local&&!relevant)continue;
      if(!relevant&&!sample&&['interaction','appearance'].includes(e.type))continue;
      const c=new T.Color(e.record?.status==='candidate'?0xa19acb:palette[e.type]||0x6680a8).multiplyScalar(selected?(relevant?.65:.006):(e.type==='appearance'?.05:.08));ep.push(a.x,a.y,a.z,b.x,b.y,b.z);ec.push(c.r,c.g,c.b,c.r,c.g,c.b);
      if(relevant&&!['appearance','similarity'].includes(e.type)){
        const direction=new T.Vector3(b.x-a.x,b.y-a.y,b.z-a.z),length=direction.length();if(length>0){direction.normalize();const tip=new T.Vector3().lerpVectors(a,b,.7),wing=new T.Vector3().crossVectors(direction,camera.up).normalize().multiplyScalar(Math.min(5,length*.08)),back=tip.clone().addScaledVector(direction,-Math.min(10,length*.15));
          for(const sign of [-1,1]){const end=back.clone().addScaledVector(wing,sign);ep.push(tip.x,tip.y,tip.z,end.x,end.y,end.z);ec.push(c.r,c.g,c.b,c.r,c.g,c.b);}}
      }
    }
    const eg=new T.BufferGeometry();eg.setAttribute('position',new T.Float32BufferAttribute(ep,3));eg.setAttribute('color',new T.Float32BufferAttribute(ec,3));
    lines=new T.LineSegments(eg,new T.ShaderMaterial({vertexColors:true,transparent:true,depthWrite:false,blending:T.AdditiveBlending,
      vertexShader:'varying vec3 vColor;void main(){vColor=color;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader:'varying vec3 vColor;void main(){gl_FragColor=vec4(vColor,0.38);}'}));scene.add(lines);
    const priority=[...nodes].sort((a,b)=>(b.type==='channel')-(a.type==='channel')+(b.degree||0)-(a.degree||0));
    for(const n of priority){if(local&&lit&&!lit.has(n.id))continue;if(labels.length>=100)break;if(selected&&n.id!==selected&&!lit?.has(n.id)&&n.type!=='channel')continue;
      const el=document.createElement('span');el.textContent=n.label;el.className=n.type==='channel'?'channel':'';if(n.id===selected)el.classList.add('selected');overlay.append(el);labels.push({n,el});}
  }
  function highlight(id,depth=1){selected=id;lit=id?new Set([id]):null;let frontier=id?[id]:[];for(let i=0;i<depth;i++){const next=[];for(const key of frontier)for(const other of adj.get(key)||[])if(!lit.has(other)){lit.add(other);next.push(other);}frontier=next;}rebuild();}
  function focus(id){const n=byId.get(id);if(!n)return;highlight(id);local=true;rebuild();const target=new T.Vector3(n.x,n.y,n.z),offset=camera.position.clone().sub(controls.target).normalize().multiplyScalar(220);flight={start:performance.now(),from:camera.position.clone(),fromTarget:controls.target.clone(),to:target.clone().add(offset),target};}
  function reset(){local=false;highlight(null);flight={start:performance.now(),from:camera.position.clone(),fromTarget:controls.target.clone(),to:new T.Vector3(0,360,1750),target:new T.Vector3()};}
  const v=new T.Vector3();let down;
  renderer.domElement.addEventListener('pointerdown',e=>{down=[e.clientX,e.clientY];});
  function pick(e){const rect=renderer.domElement.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;let best=null,dist=13;
    for(const n of nodes){if(local&&lit&&!lit.has(n.id))continue;v.set(n.x,n.y,n.z).project(camera);if(v.z<-1||v.z>1)continue;const d=Math.hypot((v.x+1)*rect.width/2-x,(1-v.y)*rect.height/2-y);if(d<dist){dist=d;best=n;}}return best;}
  renderer.domElement.addEventListener('click',e=>{if(down&&Math.hypot(e.clientX-down[0],e.clientY-down[1])>5)return;const n=pick(e);highlight(n?.id||null);onSelect(n);});
  renderer.domElement.addEventListener('dblclick',e=>{const n=pick(e);if(n){focus(n.id);onDoubleClick(n);}});
  renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();container.dispatchEvent(new CustomEvent('galaxy-error',{detail:'三维绘图上下文已丢失，请重新加载星图。'}));});
  const resize=new ResizeObserver(()=>{const w=container.clientWidth,h=container.clientHeight;if(!w||!h)return;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();});resize.observe(container);
  let lastLabels=0;
  function refreshLabels(){
    const candidates=[];for(const n of nodes){if(local&&lit&&!lit.has(n.id))continue;const distance=Math.hypot(camera.position.x-n.x,camera.position.y-n.y,camera.position.z-n.z);
      if(n.type!=='channel'&&n.id!==selected&&!lit?.has(n.id)&&distance>600)continue;
      v.set(n.x,n.y,n.z).project(camera);if(v.z<-1||v.z>1||Math.abs(v.x)>.98||Math.abs(v.y)>.98)continue;
      candidates.push({n,x:(v.x+1)*container.clientWidth/2,y:(1-v.y)*container.clientHeight/2,score:distance-(n.id===selected?100000:n.type==='channel'?10000:lit?.has(n.id)?5000:0)});
    }
    candidates.sort((a,b)=>a.score-b.score);const occupied=new Set(),chosen=[];
    for(const c of candidates){const cell=Math.floor(c.x/110)+':'+Math.floor(c.y/24);if(occupied.has(cell)&&c.n.id!==selected)continue;occupied.add(cell);chosen.push(c.n);if(chosen.length>=100)break;}
    if(chosen.map(n=>n.id).join('|')===labels.map(l=>l.n.id).join('|'))return;
    overlay.replaceChildren();labels=chosen.map(n=>{const el=document.createElement('span');el.textContent=n.label;el.className=n.type==='channel'?'channel':'';if(n.id===selected)el.classList.add('selected');overlay.append(el);return {n,el};});
  }
  function animate(now){if(disposed)return;frame=requestAnimationFrame(animate);if(flight){const t=Math.min(1,(now-flight.start)/750),k=t*t*(3-2*t);camera.position.lerpVectors(flight.from,flight.to,k);controls.target.lerpVectors(flight.fromTarget,flight.target,k);if(t===1)flight=null;}controls.update();
    const distance=camera.position.distanceTo(controls.target),nextLod=distance<200?2:distance<550?1:0;if(nextLod!==lod){lod=nextLod;rebuild();}
    if(now-lastLabels>250){lastLabels=now;refreshLabels();}
    for(const {n,el}of labels){v.set(n.x,n.y,n.z).project(camera);const near=camera.position.distanceTo(new T.Vector3(n.x,n.y,n.z))<600;const visible=v.z>=-1&&v.z<=1&&Math.abs(v.x)<.98&&Math.abs(v.y)<.98&&(n.type==='channel'||n.id===selected||lit?.has(n.id)||near);el.style.display=visible?'':'none';if(visible)el.style.transform=`translate(${(v.x+1)*container.clientWidth/2}px,${(1-v.y)*container.clientHeight/2}px)`;}
    renderer.render(scene,camera);frames++;if(now-last>1000){fps=Math.round(frames*1000/(now-last));frames=0;last=now;}}
  frame=requestAnimationFrame(animate);
  return {setData(data){nodes=layoutGalaxy(data.nodes,data.edges);edges=data.edges;byId=new Map(nodes.map(n=>[n.id,n]));adj=new Map();for(const e of edges){if(!adj.has(e.source))adj.set(e.source,new Set());if(!adj.has(e.target))adj.set(e.target,new Set());adj.get(e.source).add(e.target);adj.get(e.target).add(e.source);}selected=null;lit=null;rebuild();},highlight,focus,reset,
    setLayers(types){layers=new Set(types);rebuild();},setMetric(value){metric=value;rebuild();},stats(){return {fps,nodes:nodes.length,edges:edges.length,drawCalls:renderer.info.render.calls,geometries:renderer.info.memory.geometries};},
    dispose(){disposed=true;cancelAnimationFrame(frame);resize.disconnect();controls.dispose();clearGeometry();renderer.dispose();renderer.domElement.remove();overlay.remove();}};
}
