import * as T from './vendor/three/three.module.js';
import {OrbitControls} from './vendor/three/OrbitControls.js';
import {layoutGalaxy} from './galaxy-layout.mjs';

// Colour semantics (graph facts only, never inferred intimacy):
//   hue     = dominant community  -> the channel a person mostly appears/relates in,
//             assigned from a stable hash of the channel id
//   lightness = connection count + recent activity; bridge nodes (two+ communities) brighter
//   size      = degree or activity metric
// Warm/cool universe: blue, teal, gold, rose, violet community hues.
const COMMUNITY_HUES=[0.585,0.485,0.105,0.955,0.775];
const COMMUNITY_NAMES=['blue','teal','gold','rose','violet'];
const EDGE_TYPES=['appearance','interaction','relationship','attitude','memory','similarity'];
const NODE_TYPES=['person','channel','memory'];
const DIM=0.33;
const ARROW_MAX=420;
const LABEL_MAX=96;
const TAU=Math.PI*2;

function fnv(s){const t=String(s==null?'':s);let h=2166136261;for(let i=0;i<t.length;i++)h=Math.imul(h^t.charCodeAt(i),16777619);return h>>>0;}
function rngFor(seed){let h=fnv(seed);return()=>{h=(h+0x6D2B79F5)|0;let t=h;t=Math.imul(t^(t>>>15),t|1);t=(t+Math.imul(t^(t>>>7),t|61))|0;return((t^(t>>>14))>>>0)/4294967296;};}
const clamp=(v,lo,hi)=>v<lo?lo:v>hi?hi:v;
const fract=v=>v-Math.floor(v);
// sRGB hsl->rgb done locally: buffers are authored in sRGB so the shaders can write
// gl_FragColor directly without depending on three's colour-management defaults.
function hsl2rgb(h,s,l){
  h=fract(h);
  const c=(1-Math.abs(2*l-1))*clamp(s,0,1),hp=h*6,x=c*(1-Math.abs((hp%2)-1)),m=l-c/2;
  const seg=Math.floor(hp)%6;
  let r,g,b;
  if(seg===0){r=c;g=x;b=0;}else if(seg===1){r=x;g=c;b=0;}else if(seg===2){r=0;g=c;b=x;}
  else if(seg===3){r=0;g=x;b=c;}else if(seg===4){r=x;g=0;b=c;}else{r=c;g=0;b=x;}
  return [clamp(r+m,0,1),clamp(g+m,0,1),clamp(b+m,0,1)];
}
function rgbHex(r,g,b){const q=v=>('0'+Math.round(clamp(v,0,1)*255).toString(16)).slice(-2);return '#'+q(r)+q(g)+q(b);}

const NODE_VS='attribute vec3 aColor;attribute float aSize;attribute float aPhase;attribute float aDim;uniform float uScale;uniform float uTime;uniform float uMotion;varying vec3 vColor;varying float vFade;uniform float uSelection;void main(){vec4 mv=modelViewMatrix*vec4(position,1.0);float dist=max(90.0,-mv.z);float d=clamp(aDim,0.0,1.6);float tw=mix(1.0,0.82+0.26*sin(uTime*1.3+aPhase),uMotion);vec3 tint=aColor;if(uSelection>0.5){if(d>1.06)tint=mix(aColor,vec3(1.0,0.96,0.88),0.55);else if(d>0.95)tint=mix(aColor,vec3(1.0,0.72,0.30),0.42);else if(d>0.6)tint=mix(aColor,vec3(0.42,0.86,0.86),0.34);}vColor=tint*d;vFade=step(0.002,d)*mix(0.86,1.0,clamp(d,0.0,1.0));gl_PointSize=clamp(aSize*mix(0.84,1.0,clamp(d,0.0,1.0))*tw*uScale/dist,1.7,64.0);gl_Position=projectionMatrix*mv;}';
const NODE_FS='varying vec3 vColor;varying float vFade;void main(){vec2 q=gl_PointCoord-vec2(0.5);float r=length(q)*2.0;if(r>1.0)discard;float core=pow(max(0.0,1.0-r),2.4);float a=core*vFade;if(a<0.004)discard;gl_FragColor=vec4(mix(vColor*0.42,vColor,core),a);}';
const HALO_VS='attribute vec3 aColor;attribute float aSize;attribute float aPhase;attribute float aDim;uniform float uScale;uniform float uTime;uniform float uMotion;varying vec3 vColor;varying float vAlpha;uniform float uSelection;void main(){vec4 mv=modelViewMatrix*vec4(position,1.0);float dist=max(90.0,-mv.z);float d=clamp(aDim,0.0,1.5);float tw=mix(1.0,0.78+0.30*sin(uTime*0.85+aPhase*1.7),uMotion);vec3 tint=aColor;if(uSelection>0.5){if(d>1.06)tint=mix(aColor,vec3(1.0,0.96,0.88),0.50);else if(d>0.95)tint=mix(aColor,vec3(1.0,0.72,0.30),0.38);else if(d>0.6)tint=mix(aColor,vec3(0.42,0.86,0.86),0.30);}vColor=tint;vAlpha=0.058*step(0.002,d)*clamp(d,0.0,1.2)*tw;gl_PointSize=clamp(aSize*3.0*uScale/dist,2.0,210.0);gl_Position=projectionMatrix*mv;}';
const HALO_FS='varying vec3 vColor;varying float vAlpha;void main(){float r=length(gl_PointCoord-vec2(0.5))*2.0;if(r>1.0)discard;float a=pow(max(0.0,1.0-r),3.2)*vAlpha;if(a<0.002)discard;gl_FragColor=vec4(vColor,a);}';
const EDGE_VS='attribute vec3 aColor;attribute float aAlpha;attribute float aDist;attribute float aStyle;varying vec3 vColor;varying float vAlpha;varying float vDist;varying float vStyle;void main(){vColor=aColor;vAlpha=aAlpha;vDist=aDist;vStyle=aStyle;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}';
const EDGE_FS='uniform float uDash;varying vec3 vColor;varying float vAlpha;varying float vDist;varying float vStyle;void main(){if(vAlpha<0.004)discard;float on=1.0;if(vStyle>0.5){float period=uDash*26.0;if(vStyle>3.5)period=uDash*52.0;else if(vStyle>2.5)period=uDash*24.0;float f=fract(vDist/max(1.0,period));if(vStyle<1.5)on=f<0.62?1.0:0.0;else if(vStyle<2.5)on=f<0.30?1.0:0.0;else if(vStyle<3.5)on=(f<0.34||(f>0.46&&f<0.64))?1.0:0.0;else on=f<0.74?1.0:0.0;}if(on<0.5)discard;gl_FragColor=vec4(vColor,vAlpha);}';
const ARROW_VS='attribute vec3 aColor;attribute float aAlpha;varying vec3 vColor;varying float vAlpha;void main(){vColor=aColor;vAlpha=aAlpha;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}';
const ARROW_FS='varying vec3 vColor;varying float vAlpha;void main(){if(vAlpha<0.01)discard;gl_FragColor=vec4(vColor,vAlpha);}';
const DECOR_VS='attribute vec3 aColor;attribute float aSize;attribute float aPhase;uniform float uScale;uniform float uTime;uniform float uMotion;varying vec3 vColor;varying float vAlpha;void main(){vec4 mv=modelViewMatrix*vec4(position,1.0);float dist=max(90.0,-mv.z);float tw=mix(1.0,0.72+0.34*sin(uTime*0.42+aPhase),uMotion);vColor=aColor;vAlpha=0.05*tw;gl_PointSize=clamp(aSize*uScale/dist,1.0,420.0);gl_Position=projectionMatrix*mv;}';
const DECOR_FS='varying vec3 vColor;varying float vAlpha;void main(){float r=length(gl_PointCoord-vec2(0.5))*2.0;if(r>1.0)discard;float a=pow(max(0.0,1.0-r),2.6)*vAlpha;if(a<0.001)discard;gl_FragColor=vec4(vColor,a);}';

export function createGalaxyRenderer(container,{onSelect=()=>{},onDoubleClick=()=>{}}={}){
  const host=container||document.createElement('div');
  const renderer=new T.WebGLRenderer({antialias:false,alpha:false,powerPreference:'high-performance'});
  const pixelRatio=Math.min((typeof devicePixelRatio==='number'?devicePixelRatio:1)||1,1.75);
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(0x04070f,1);
  host.append(renderer.domElement);
  const scene=new T.Scene();
  const camera=new T.PerspectiveCamera(50,1,1,15000);
  camera.position.set(0,360,1750);
  const controls=new OrbitControls(camera,renderer.domElement);
  controls.enableDamping=true;controls.dampingFactor=0.075;controls.minDistance=8;controls.maxDistance=6000;
  controls.rotateSpeed=0.62;controls.autoRotateSpeed=0.26;controls.autoRotate=false;
  const overlay=document.createElement('div');overlay.className='galaxy-labels';host.append(overlay);
  const uniforms={uScale:{value:2772},uTime:{value:0},uMotion:{value:1},uDash:{value:1},uSelection:{value:0}};
  const reduced=typeof matchMedia==='function'?matchMedia('(prefers-reduced-motion: reduce)'):null;
  let motion=!(reduced&&reduced.matches),motionOverride=false,interacting=false,idleTimer=0;
  uniforms.uMotion.value=motion?1:0;

  let nodes=[],edges=[],byId=new Map(),idxById=new Map(),adj=new Map(),edgeByNode=new Map();
  let nCount=0,drawnCount=0,weakTotal=0,maxDegree=1,maxActivity=1,maxInteraction=1;
  let selected=null,selectedIdx=-1,related=new Set(),relIdx=new Set();
  let layers=new Set([...EDGE_TYPES,...NODE_TYPES]);
  let metric='degree',lod=-1,disposed=false,frame=0,flight=null,lastFrame=0;
  let labels=[],arrowItems=[],arrowDirty=false,paletteColors=0,hueCount=0;
  let nPos=null,nColor=null,nSize=null,nPhase=null,nDim=null,nHex=null,nHue=null,nSat=null,nLight=null,nBridge=null,nBase=null;
  let degreeOf=null;
  let nodeGeo=null,nodeMat=null,nodePts=null,haloPts=null;
  let edgeGeo=null,edgeMat=null,edgeObj=null,ePos=null,eCol=null,eAlpha=null,eDist=null,eStyle=null;
  let dA=null,dB=null,dBase=null;
  let arrowGeo=null,arrowMat=null,arrowObj=null,aPos=null,aCol=null,aAlpha=null;
  let decor=null;
  const v=new T.Vector3();
  let channelHue=new Map();

  function isHidden(i){const n=nodes[i];return !!n&&n.type==='memory'&&!layers.has('memory');}
  function clearLabels(){overlay.replaceChildren();labels=[];}

  function disposeObjects(){
    for(const o of [nodePts,haloPts,edgeObj,arrowObj]){
      if(!o)continue;
      scene.remove(o);
      if(o.geometry)o.geometry.dispose();
      if(o.material)o.material.dispose();
    }
    if(decor){
      for(const o of decor.all){scene.remove(o);o.geometry.dispose();o.material.dispose();}
      scene.remove(decor.group);
      decor=null;
    }
    nodePts=null;haloPts=null;edgeObj=null;arrowObj=null;
    nodeGeo=null;edgeGeo=null;arrowGeo=null;
  }

  // ---- deterministic communities: hue = dominant channel, lightness = degree + activity ----
  function computePalette(){
    const chanIdx=new Map();
    for(let i=0;i<nCount;i++)if(nodes[i].type==='channel')chanIdx.set(nodes[i].id,i);
    const chanIds=[...chanIdx.values()].sort((a,b)=>String(nodes[a].id).localeCompare(String(nodes[b].id)));
    channelHue=new Map();
    nHue=new Float32Array(nCount);nSat=new Float32Array(nCount);nLight=new Float32Array(nCount);nBridge=new Uint8Array(nCount);
    for(const i of chanIds){
      const id=nodes[i].id,h=fnv(id),slot=h%COMMUNITY_HUES.length;
      const jitter=(((h>>>8)%17)/17-0.5)*0.028;
      nHue[i]=fract(COMMUNITY_HUES[slot]+jitter);
      nSat[i]=0.84+((h>>>12)%10)/100;
      nLight[i]=0.54+((h>>>16)%12)/100;
      channelHue.set(id,nHue[i]);
    }
    const w=new Map();
    const bump=(id,ch,v)=>{
      if(!ch||!chanIdx.has(ch)||!(v>0))return;
      let m=w.get(id);if(!m){m=new Map();w.set(id,m);}
      m.set(ch,(m.get(ch)||0)+v);
    };
    for(const e of edges){
      const c=Math.max(1,+e.count||1);
      if(e.type==='appearance')bump(e.source,e.target,c);
      else if(e.channel&&chanIdx.has(e.channel)){bump(e.source,e.channel,c);bump(e.target,e.channel,c);}
    }
    for(const i of chanIds)bump(nodes[i].id,nodes[i].id,1);
    for(let pass=0;pass<2;pass++){
      const pending=[];
      for(let i=0;i<nCount;i++)if(!w.has(nodes[i].id))pending.push(i);
      if(!pending.length)break;
      const add=[];
      for(const i of pending){
        const acc=new Map();
        for(const other of adj.get(nodes[i].id)||[]){
          const m=w.get(other);if(!m)continue;
          for(const [ch,v] of m)acc.set(ch,(acc.get(ch)||0)+v*0.6);
        }
        if(!acc.size)continue;
        let top=0;for(const v of acc.values())if(v>top)top=v;
        const keep=new Map();
        for(const [ch,v] of acc)if(v>=top*0.25)keep.set(ch,v);
        if(keep.size)add.push([nodes[i].id,keep]);
      }
      if(!add.length)break;
      for(const [id,m] of add)w.set(id,m);
    }
    const logDeg=Math.log1p(maxDegree),logAct=Math.log1p(maxActivity);
    for(let i=0;i<nCount;i++){
      const n=nodes[i];
      if(n.type==='channel')continue;
      const deg=degreeOf[i]||0;
      const degN=logDeg>0?Math.log1p(deg)/logDeg:0;
      const actN=logAct>0?Math.log1p(+n.activity||0)/logAct:0;
      const m=w.get(n.id);
      if(m&&m.size){
        let sx=0,sy=0,sw=0,top=0;
        for(const [ch,v] of m){
          const hue=channelHue.has(ch)?channelHue.get(ch):0.585;
          sx+=Math.cos(hue*TAU)*v;sy+=Math.sin(hue*TAU)*v;sw+=v;
          if(v>top)top=v;
        }
        let distinct=0;
        for(const v of m.values())if(v>=Math.max(1.5,top*0.32))distinct++;
        const bridge=distinct>=2&&n.type==='person';
        nHue[i]=sw>0?fract(Math.atan2(sy,sx)/TAU):0.585;
        nSat[i]=clamp(0.80-0.18*degN-(bridge?0.14:0),0.34,0.92);
        nLight[i]=clamp(0.40+0.20*degN+0.10*actN+(bridge?0.13:0),0.28,0.80);
        nBridge[i]=bridge?1:0;
      }else{
        nHue[i]=n.type==='memory'?0.775:0.605;
        nSat[i]=n.type==='memory'?0.32:0.40;
        nLight[i]=clamp(0.34+0.18*degN+0.08*actN,0.24,0.68);
      }
      if(n.type==='memory'){nSat[i]=Math.min(nSat[i],0.5);nLight[i]=clamp(nLight[i],0.33,0.70);}
    }
    const seen=new Set();
    for(let i=0;i<nCount;i++){
      const rgb=hsl2rgb(nHue[i],nSat[i],nLight[i]);
      nColor[i*3]=rgb[0];nColor[i*3+1]=rgb[1];nColor[i*3+2]=rgb[2];
      nBase[i*3]=rgb[0];nBase[i*3+1]=rgb[1];nBase[i*3+2]=rgb[2];
      nHex[i]=rgbHex(rgb[0],rgb[1],rgb[2]);
      seen.add((Math.round(rgb[0]*24)*25+Math.round(rgb[1]*24))*25+Math.round(rgb[2]*24));
    }
    paletteColors=seen.size;
    hueCount=channelHue.size?COMMUNITY_NAMES.length:0;
    for(const i of chanIds)channelHue.set(nodes[i].id,nHue[i]);
  }

  function computeSizes(){
    const maxV=metric==='activity'?maxActivity:maxDegree;
    const denom=Math.log1p(Math.max(1,maxV));
    for(let i=0;i<nCount;i++){
      const n=nodes[i];
      const base=n.type==='channel'?15.5:n.type==='memory'?3.1:4.3;
      const raw=metric==='activity'?(+n.activity||0):(degreeOf[i]||0);
      const t=clamp(Math.log1p(Math.max(0,raw))/denom,0,1);
      let s=base*(1+0.85*Math.sqrt(t));
      if(nBridge[i])s*=1.16;
      if(n.type==='channel')s*=1+0.4*t;
      nSize[i]=s;
    }
    if(nodeGeo&&nodeGeo.getAttribute('aSize'))nodeGeo.getAttribute('aSize').needsUpdate=true;
  }

  function buildBuffers(){
    nPos=new Float32Array(nCount*3);nColor=new Float32Array(nCount*3);nSize=new Float32Array(nCount);
    nPhase=new Float32Array(nCount);nDim=new Float32Array(nCount);nHex=new Array(nCount);
    nBase=new Float32Array(nCount*3);
    for(let i=0;i<nCount;i++){
      const n=nodes[i];
      nPos[i*3]=+n.x||0;nPos[i*3+1]=+n.y||0;nPos[i*3+2]=+n.z||0;
      nPhase[i]=rngFor('phase|'+n.id)()*TAU;
    }
    const cap=Math.max(2,edges.length*2);
    ePos=new Float32Array(cap*3);eCol=new Float32Array(cap*3);eAlpha=new Float32Array(cap);
    eDist=new Float32Array(cap);eStyle=new Float32Array(cap);
    dA=new Int32Array(edges.length+1);dB=new Int32Array(edges.length+1);dBase=new Float32Array(edges.length+1);
  }
  function setData(data){
    if(!data)return;
    disposeObjects();clearLabels();
    nodes=layoutGalaxy(Array.isArray(data.nodes)?data.nodes:[],Array.isArray(data.edges)?data.edges:[]);
    edges=Array.isArray(data.edges)?data.edges:[];
    nCount=nodes.length;
    byId=new Map();idxById=new Map();adj=new Map();edgeByNode=new Map();
    for(let i=0;i<nCount;i++){byId.set(nodes[i].id,nodes[i]);idxById.set(nodes[i].id,i);}
    degreeOf=new Float32Array(nCount);
    for(let i=0;i<edges.length;i++){
      const e=edges[i];
      let setA=adj.get(e.source);if(!setA){setA=new Set();adj.set(e.source,setA);}
      let setB=adj.get(e.target);if(!setB){setB=new Set();adj.set(e.target,setB);}
      setA.add(e.target);setB.add(e.source);
      let listA=edgeByNode.get(e.source);if(!listA){listA=[];edgeByNode.set(e.source,listA);}
      let listB=edgeByNode.get(e.target);if(!listB){listB=[];edgeByNode.set(e.target,listB);}
      listA.push(i);listB.push(i);
    }
    maxDegree=1;maxActivity=1;maxInteraction=1;
    for(let i=0;i<nCount;i++){
      const d=(adj.get(nodes[i].id)||{size:0}).size||0;
      degreeOf[i]=d;if(d>maxDegree)maxDegree=d;
      const a=+nodes[i].activity||0;if(a>maxActivity)maxActivity=a;
    }
    for(const e of edges)if(e.type==='interaction'){const c=Math.max(1,+e.count||1);if(c>maxInteraction)maxInteraction=c;}
    buildBuffers();
    computePalette();
    computeSizes();
    selected=null;selectedIdx=-1;related=new Set();relIdx=new Set();
    buildScene();
    buildDecor();
    lod=-1;drawnCount=0;
    fillEdges();
    paintDim();
    paintEdgeAlpha();
    refreshArrows();
    refreshLabels(true);
  }

  function buildScene(){
    nodeGeo=new T.BufferGeometry();
    nodeGeo.setAttribute('position',new T.BufferAttribute(nPos,3));
    nodeGeo.setAttribute('aColor',new T.BufferAttribute(nColor,3));
    nodeGeo.setAttribute('aSize',new T.BufferAttribute(nSize,1));
    nodeGeo.setAttribute('aPhase',new T.BufferAttribute(nPhase,1));
    nodeGeo.setAttribute('aDim',new T.BufferAttribute(nDim,1));
    nodeMat=new T.ShaderMaterial({uniforms:uniforms,vertexShader:NODE_VS,fragmentShader:NODE_FS,transparent:true,depthWrite:false,blending:T.NormalBlending});
    nodePts=new T.Points(nodeGeo,nodeMat);nodePts.frustumCulled=false;nodePts.renderOrder=2;scene.add(nodePts);
    const haloMat=new T.ShaderMaterial({uniforms:uniforms,vertexShader:HALO_VS,fragmentShader:HALO_FS,transparent:true,depthWrite:false,blending:T.AdditiveBlending});
    haloPts=new T.Points(nodeGeo,haloMat);haloPts.frustumCulled=false;haloPts.renderOrder=1;scene.add(haloPts);
    edgeGeo=new T.BufferGeometry();
    edgeGeo.setAttribute('position',new T.BufferAttribute(ePos,3));
    edgeGeo.setAttribute('aColor',new T.BufferAttribute(eCol,3));
    edgeGeo.setAttribute('aAlpha',new T.BufferAttribute(eAlpha,1));
    edgeGeo.setAttribute('aDist',new T.BufferAttribute(eDist,1));
    edgeGeo.setAttribute('aStyle',new T.BufferAttribute(eStyle,1));
    edgeGeo.setDrawRange(0,0);
    edgeMat=new T.ShaderMaterial({uniforms:uniforms,vertexShader:EDGE_VS,fragmentShader:EDGE_FS,transparent:true,depthWrite:false,blending:T.NormalBlending});
    edgeObj=new T.LineSegments(edgeGeo,edgeMat);edgeObj.frustumCulled=false;edgeObj.renderOrder=0;scene.add(edgeObj);
    aPos=new Float32Array(ARROW_MAX*9);aCol=new Float32Array(ARROW_MAX*9);aAlpha=new Float32Array(ARROW_MAX*3);
    arrowGeo=new T.BufferGeometry();
    arrowGeo.setAttribute('position',new T.BufferAttribute(aPos,3));
    arrowGeo.setAttribute('aColor',new T.BufferAttribute(aCol,3));
    arrowGeo.setAttribute('aAlpha',new T.BufferAttribute(aAlpha,1));
    arrowGeo.setDrawRange(0,0);
    arrowMat=new T.ShaderMaterial({uniforms:uniforms,vertexShader:ARROW_VS,fragmentShader:ARROW_FS,transparent:true,depthWrite:false,side:T.DoubleSide,blending:T.NormalBlending});
    arrowObj=new T.Mesh(arrowGeo,arrowMat);arrowObj.frustumCulled=false;arrowObj.renderOrder=3;arrowObj.visible=false;scene.add(arrowObj);
  }

  const ES={r:0.5,g:0.5,b:0.5,alpha:0.1,style:0};
  // Edge language: warm solid = confirmed relationship, dashed = candidate, rose = explicit
  // attitude, dash-dot = explicit negation, long dash = explicit conflict, cool dotted =
  // weak directed interaction (warms up and goes solid as the count grows).
  function styleEdge(e){
    const cnt=Math.max(1,+e.count||1);
    const rec=e.record||null;
    let h=0.58,s=0.4,l=0.52,a=0.10,st=0;
    if(e.type==='relationship'){
      const negated=!!(rec&&rec.negated);
      const conflicts=!!(rec&&Array.isArray(rec.conflicts)&&rec.conflicts.length);
      if(negated){h=0.955;s=0.62;l=0.66;a=0.34;st=3;}
      else if(conflicts){h=0.800;s=0.56;l=0.68;a=0.30;st=4;}
      else if(rec&&rec.status==='candidate'){h=0.095;s=0.58;l=0.60;a=0.24;st=1;}
      else{h=0.098;s=0.72;l=0.62;a=0.38;st=0;}
    }else if(e.type==='attitude'){
      const negated=!!(rec&&rec.negated);
      const alt=(fnv(String(e.id||e.source+'|'+e.target))>>>3)%2;
      h=negated?0.965:(alt?0.925:0.755);
      s=0.60;l=0.64;a=negated?0.34:0.28;st=negated?3:0;
    }else if(e.type==='interaction'){
      // Single interactions stay cool/dotted no matter what the dataset maximum is.
      const t=clamp(Math.log1p(Math.max(0,cnt-1))/Math.log1p(Math.max(9,maxInteraction-1)),0,1);
      h=0.495-(0.495-0.085)*t;
      s=0.50+0.22*t;l=0.54+0.10*t;a=0.14+0.30*t;
      st=t<0.34?2:(t<0.66?1:0);
    }else if(e.type==='appearance'){
      h=channelHue.has(e.target)?channelHue.get(e.target):0.47;
      s=0.50;l=0.52;a=0.085;st=0;
    }else if(e.type==='memory'){
      h=0.775;s=0.32;l=0.56;a=0.13;st=2;
    }else if(e.type==='similarity'){
      h=0.60;s=0.16;l=0.52;a=0.09;st=2;
    }else{
      h=0.58;s=0.28;l=0.52;a=0.10;st=1;
    }
    const rgb=hsl2rgb(h,s,l);
    ES.r=rgb[0];ES.g=rgb[1];ES.b=rgb[2];ES.alpha=clamp(a,0,0.5);ES.style=st;
    return ES;
  }

  function fillEdges(){
    if(!edgeGeo)return;
    weakTotal=0;
    for(const e of edges)if(e.type==='interaction'||e.type==='appearance')weakTotal++;
    const budget=lod===2?1:lod===1?7000:1800;
    const stride=weakTotal>budget?Math.ceil(weakTotal/budget):1;
    let k=0,weakSeen=0;
    for(let i=0;i<edges.length;i++){
      const e=edges[i];
      if(!layers.has(e.type))continue;
      const ai=idxById.get(e.source),bi=idxById.get(e.target);
      if(ai===undefined||bi===undefined)continue;
      if(isHidden(ai)||isHidden(bi))continue;
      if(e.type==='interaction'||e.type==='appearance'){
        weakSeen++;
        // Incident edges of the selection always survive the weak-edge stride.
        const keep=selectedIdx>=0&&(ai===selectedIdx||bi===selectedIdx);
        if(!keep&&stride>1&&weakSeen%stride!==0)continue;
      }
      const si=styleEdge(e);
      const x0=nPos[ai*3],y0=nPos[ai*3+1],z0=nPos[ai*3+2];
      const x1=nPos[bi*3],y1=nPos[bi*3+1],z1=nPos[bi*3+2];
      const dx=x1-x0,dy=y1-y0,dz=z1-z0;
      const len=Math.sqrt(dx*dx+dy*dy+dz*dz);
      const v0=k*2;
      ePos[v0*3]=x0;ePos[v0*3+1]=y0;ePos[v0*3+2]=z0;
      ePos[v0*3+3]=x1;ePos[v0*3+4]=y1;ePos[v0*3+5]=z1;
      eCol[v0*3]=si.r;eCol[v0*3+1]=si.g;eCol[v0*3+2]=si.b;
      eCol[v0*3+3]=si.r;eCol[v0*3+4]=si.g;eCol[v0*3+5]=si.b;
      eDist[v0]=0;eDist[v0+1]=len;
      eStyle[v0]=si.style;eStyle[v0+1]=si.style;
      dA[k]=ai;dB[k]=bi;dBase[k]=si.alpha;
      k++;
    }
    drawnCount=k;
    edgeGeo.setDrawRange(0,k*2);
    for(const name of ['position','aColor','aDist','aStyle']){const at=edgeGeo.getAttribute(name);if(at)at.needsUpdate=true;}
  }
  // Selection never removes nodes: unrelated stars drop to ~0.33 brightness, keep a size,
  // and stay pickable. Only explicit filters (layers / channel scope) remove anything.
  function paintDim(){
    if(!nodeGeo)return;
    const sel=selectedIdx;
    // Tiers: 1.14 selected, 1 direct adjacency, 0.8 second hop (depth>=2), DIM everything else.
    const selKey=sel>=0?nodes[sel].id:null;
    const dirKey=selKey!=null?(adj.get(selKey)||null):null;
    for(let i=0;i<nCount;i++){
      let d=1;
      if(sel>=0){
        if(i===sel)d=1.14;
        else if(dirKey&&dirKey.has(nodes[i].id))d=1;
        else if(relIdx.has(i))d=0.8;
        else d=DIM;
      }
      nDim[i]=isHidden(i)?0:d;
    }
    // Community palette is kept in overview; only an active selection repaints the colour
    // buffer from the preserved base (no per-frame recolour, exact adjacency only).
    if(nBase&&nodeGeo.getAttribute('aColor')){
      const col=nodeGeo.getAttribute('aColor').array;
      for(let i=0;i<nCount*3;i++)col[i]=nBase[i];
      if(sel>=0){
        for(let i=0;i<nCount;i++){
          let tint=null,mixT=0;
          const id=nodes[i].id;
          if(i===sel){tint=[1.0,0.96,0.88];mixT=0.55;}
          else if(dirKey&&dirKey.has(id)){tint=[1.0,0.72,0.30];mixT=0.42;}
          else if(relIdx.has(i)){tint=[0.42,0.86,0.86];mixT=0.34;}
          if(!tint)continue;
          const r=nBase[i*3],g=nBase[i*3+1],b=nBase[i*3+2];
          col[i*3]=r+(tint[0]-r)*mixT;col[i*3+1]=g+(tint[1]-g)*mixT;col[i*3+2]=b+(tint[2]-b)*mixT;
        }
      }
      nodeGeo.getAttribute('aColor').needsUpdate=true;
    }
    uniforms.uSelection.value=sel>=0?1:0;
    const at=nodeGeo.getAttribute('aDim');if(at)at.needsUpdate=true;
  }
  function paintEdgeAlpha(){
    if(!edgeGeo)return;
    const sel=selectedIdx;
    // Unselected global lines stay quiet: far LOD is faintest so stars read through them.
    const baseF=lod===2?0.4:(lod===1?0.25:0.12);
    for(let k=0;k<drawnCount;k++){
      let f=baseF;
      if(sel>=0){
        const a=dA[k],b=dB[k];
        const rel=(a===sel||b===sel||(relIdx.has(a)&&relIdx.has(b)));
        f=rel?2.2:0.16;
      }
      const al=clamp(dBase[k]*f,0,0.6);
      eAlpha[k*2]=al;eAlpha[k*2+1]=al;
    }
    const at=edgeGeo.getAttribute('aAlpha');if(at)at.needsUpdate=true;
  }

  function refreshArrows(){
    arrowItems=[];
    if(!arrowGeo||selectedIdx<0){if(arrowObj)arrowObj.visible=false;if(arrowGeo)arrowGeo.setDrawRange(0,0);return;}
    const list=edgeByNode.get(nodes[selectedIdx].id)||[];
    for(const ei of list){
      if(arrowItems.length>=ARROW_MAX)break;
      const e=edges[ei];
      if(!e||!layers.has(e.type))continue;
      if(e.type==='appearance'||e.type==='similarity'||e.type==='memory')continue;
      const ai=idxById.get(e.source),bi=idxById.get(e.target);
      if(ai===undefined||bi===undefined||ai===bi)continue;
      if(isHidden(ai)||isHidden(bi))continue;
      const si=styleEdge(e);
      arrowItems.push({ai:ai,bi:bi,r:si.r,g:si.g,b:si.b,a:clamp(si.alpha*2.6,0.22,0.85)});
    }
    arrowDirty=true;
  }
  // Arrow heads are re-oriented every frame against the live camera, so direction stays
  // readable while the orbit moves. Direction always follows source -> target.
  function updateArrowGeometry(){
    if(!arrowObj||!arrowGeo)return;
    if(!arrowItems.length){arrowGeo.setDrawRange(0,0);arrowObj.visible=false;return;}
    const cx=camera.position.x,cy=camera.position.y,cz=camera.position.z;
    let n=0;
    for(const it of arrowItems){
      const ax=nPos[it.ai*3],ay=nPos[it.ai*3+1],az=nPos[it.ai*3+2];
      const bx=nPos[it.bi*3],by=nPos[it.bi*3+1],bz=nPos[it.bi*3+2];
      let dx=bx-ax,dy=by-ay,dz=bz-az;
      const len=Math.sqrt(dx*dx+dy*dy+dz*dz);
      if(!(len>0.001))continue;
      dx/=len;dy/=len;dz/=len;
      const head=clamp(len*0.13,7,26),w=head*0.44,t=0.72;
      const tx=ax+dx*len*t,ty=ay+dy*len*t,tz=az+dz*len*t;
      const vx=ax-cx,vy=ay-cy,vz=az-cz;
      let px=dy*vz-dz*vy,py=dz*vx-dx*vz,pz=dx*vy-dy*vx;
      const pl=Math.sqrt(px*px+py*py+pz*pz);
      if(pl>1e-4){px/=pl;py/=pl;pz/=pl;}
      else{
        px=dy*0-dz*1;py=dz*0-dx*0;pz=dx*1-dy*0;
        const ql=Math.sqrt(px*px+py*py+pz*pz)||1;
        px/=ql;py/=ql;pz/=ql;
      }
      const ox=tx-dx*head,oy=ty-dy*head,oz=tz-dz*head;
      const o=n*9;
      aPos[o]=tx;aPos[o+1]=ty;aPos[o+2]=tz;
      aPos[o+3]=ox+px*w;aPos[o+4]=oy+py*w;aPos[o+5]=oz+pz*w;
      aPos[o+6]=ox-px*w;aPos[o+7]=oy-py*w;aPos[o+8]=oz-pz*w;
      for(let j=0;j<3;j++){
        aCol[o+j*3]=it.r;aCol[o+j*3+1]=it.g;aCol[o+j*3+2]=it.b;
        aAlpha[n*3+j]=it.a;
      }
      n++;
    }
    arrowGeo.setDrawRange(0,n*3);
    arrowObj.visible=n>0;
    for(const name of ['position','aColor','aAlpha']){const at=arrowGeo.getAttribute(name);if(at)at.needsUpdate=true;}
    arrowDirty=false;
  }

  // Purely decorative: a sparse nebula wash plus fine dust. Separate batched objects, no
  // data count, no picking, no influence on any relationship position.
  function buildDecor(){
    const group=new T.Group();scene.add(group);
    const all=[];
    const rng=rngFor('decor|'+nCount+'|'+edges.length);
    const mat=new T.ShaderMaterial({uniforms:uniforms,vertexShader:DECOR_VS,fragmentShader:DECOR_FS,transparent:true,depthWrite:false,depthTest:false,blending:T.AdditiveBlending});
    const makeCloud=(count,rMin,rMax,sMin,sMax,flat)=>{
      const pos=new Float32Array(count*3),col=new Float32Array(count*3),siz=new Float32Array(count),pha=new Float32Array(count);
      for(let i=0;i<count;i++){
        const u=rng()*2-1,th=rng()*TAU,sq=Math.sqrt(Math.max(0,1-u*u));
        const rad=rMin+(rMax-rMin)*Math.cbrt(rng());
        pos[i*3]=sq*Math.cos(th)*rad*0.98;
        pos[i*3+1]=u*rad*flat*(0.85+rng()*0.3);
        pos[i*3+2]=sq*Math.sin(th)*rad*1.04;
        const hue=fract(COMMUNITY_HUES[i%COMMUNITY_HUES.length]+(rng()-0.5)*0.05);
        const rgb=hsl2rgb(hue,0.42+0.34*rng(),0.44+0.22*rng());
        col[i*3]=rgb[0];col[i*3+1]=rgb[1];col[i*3+2]=rgb[2];
        siz[i]=sMin+(sMax-sMin)*rng();
        pha[i]=rng()*TAU;
      }
      const g=new T.BufferGeometry();
      g.setAttribute('position',new T.BufferAttribute(pos,3));
      g.setAttribute('aColor',new T.BufferAttribute(col,3));
      g.setAttribute('aSize',new T.BufferAttribute(siz,1));
      g.setAttribute('aPhase',new T.BufferAttribute(pha,1));
      const p=new T.Points(g,mat);
      p.frustumCulled=false;p.raycast=function(){};
      return p;
    };
    const nebula=makeCloud(560,320,980,44,150,0.66);
    nebula.renderOrder=-3;group.add(nebula);all.push(nebula);
    const dust=makeCloud(1500,120,1180,1.1,3.4,0.9);
    dust.renderOrder=-2;group.add(dust);all.push(dust);
    decor={group:group,all:all,nebula:nebula,dust:dust};
  }
  function refreshLabels(force){
    if(!nCount){clearLabels();return;}
    const w=host.clientWidth||1,h=host.clientHeight||1;
    const cx=camera.position.x,cy=camera.position.y,cz=camera.position.z;
    const candidates=[];
    for(let i=0;i<nCount;i++){
      const n=nodes[i];
      if(isHidden(i))continue;
      const x=nPos[i*3],y=nPos[i*3+1],z=nPos[i*3+2];
      v.set(x,y,z).project(camera);
      if(v.z<-1||v.z>1||Math.abs(v.x)>=1||Math.abs(v.y)>=1)continue;
      const dist=Math.sqrt((cx-x)*(cx-x)+(cy-y)*(cy-y)+(cz-z)*(cz-z));
      const isSel=i===selectedIdx,isRel=relIdx.has(i),isChan=n.type==='channel';
      if(selectedIdx>=0){if(!isSel&&!isChan&&!isRel)continue;}
      else if(!isChan&&dist>640)continue;
      const score=dist-(isSel?1e6:isChan?1e4:isRel?5e3:0);
      candidates.push({i:i,n:n,x:(v.x+1)*w/2,y:(1-v.y)*h/2,score:score});
    }
    candidates.sort((a,b)=>a.score-b.score);
    const occupied=new Set(),chosen=[];
    for(const c of candidates){
      const cell=Math.floor(c.x/108)+':'+Math.floor(c.y/22);
      if(occupied.has(cell)&&c.i!==selectedIdx)continue;
      occupied.add(cell);chosen.push(c);
      if(chosen.length>=LABEL_MAX)break;
    }
    const sig=chosen.map(c=>c.i).join(',');
    if(!force&&sig===labels.map(l=>l.i).join(','))return;
    overlay.replaceChildren();
    labels=chosen.map(c=>{
      const el=document.createElement('span');
      el.textContent=c.n.label||c.n.id;
      if(c.n.type==='channel')el.classList.add('channel');
      if(c.i===selectedIdx)el.classList.add('selected');
      el.style.color=c.i===selectedIdx?'#ffffff':(c.n.type==='channel'?(nHex[c.i]||'#ffd8a0'):'#9fb6c8');
      overlay.append(el);
      return {i:c.i,el:el};
    });
    positionLabels();
  }
  function positionLabels(){
    if(!labels.length)return;
    const w=host.clientWidth||1,h=host.clientHeight||1;
    for(const l of labels){
      v.set(nPos[l.i*3],nPos[l.i*3+1],nPos[l.i*3+2]).project(camera);
      const vis=v.z>=-1&&v.z<=1&&Math.abs(v.x)<0.99&&Math.abs(v.y)<0.99;
      if(!vis){l.el.style.display='none';continue;}
      l.el.style.display='';
      l.el.style.transform='translate('+((v.x+1)*w/2).toFixed(1)+'px,'+((1-v.y)*h/2).toFixed(1)+'px)';
    }
  }
  function pick(ev){
    const rect=renderer.domElement.getBoundingClientRect();
    const x=ev.clientX-rect.left,y=ev.clientY-rect.top;
    const w=rect.width||1,h=rect.height||1;
    let best=-1,bestD=15;
    for(let i=0;i<nCount;i++){
      if(nDim[i]<=0.0001)continue;
      v.set(nPos[i*3],nPos[i*3+1],nPos[i*3+2]).project(camera);
      if(v.z<-1||v.z>1)continue;
      const sx=(v.x+1)*w/2,sy=(1-v.y)*h/2;
      const lim=nodes[i].type==='channel'?26:15;
      const d=Math.sqrt((sx-x)*(sx-x)+(sy-y)*(sy-y));
      if(d<lim&&d<=bestD){bestD=d;best=i;}
    }
    return best;
  }

  function highlight(id,depth){
    const key=id==null?null:id;
    selected=(key!=null&&byId.has(key))?key:null;
    selectedIdx=selected!=null?idxById.get(selected):-1;
    if(selectedIdx===undefined)selectedIdx=-1;
    related=new Set();relIdx=new Set();
    if(selected){
      related.add(selected);
      let frontier=[selected];
      const levels=clamp(Math.round(+depth||1),1,3);
      for(let d=0;d<levels;d++){
        const next=[];
        for(const key2 of frontier){
          for(const other of adj.get(key2)||[]){
            if(!related.has(other)){related.add(other);next.push(other);}
          }
        }
        frontier=next;
        if(!frontier.length)break;
      }
      for(const key2 of related){const k=idxById.get(key2);if(k!==undefined)relIdx.add(k);}
    }
    paintDim();paintEdgeAlpha();refreshArrows();refreshLabels(true);
  }
  function focus(id){
    const key=id==null?selected:id;
    const idx=idxById.get(key);
    if(idx===undefined)return;
    highlight(key,1);
    const target=new T.Vector3(nPos[idx*3],nPos[idx*3+1],nPos[idx*3+2]);
    const offset=camera.position.clone().sub(controls.target);
    if(offset.lengthSq()<1e-4)offset.set(0,0.35,1);
    offset.normalize().multiplyScalar(230);
    flight={start:performance.now(),from:camera.position.clone(),fromTarget:controls.target.clone(),to:target.clone().add(offset),target:target.clone()};
    syncAutoRotate();
  }
  function reset(){
    highlight(null,1);
    flight={start:performance.now(),from:camera.position.clone(),fromTarget:controls.target.clone(),to:new T.Vector3(0,360,1750),target:new T.Vector3(0,0,0)};
    syncAutoRotate();
  }
  function syncAutoRotate(){controls.autoRotate=!!motion&&!interacting&&!flight;}
  function setMotion(on){
    motion=!!on;motionOverride=true;
    uniforms.uMotion.value=motion?1:0;
    syncAutoRotate();
  }
  function onReducedChange(ev){
    if(motionOverride)return;
    motion=!ev.matches;uniforms.uMotion.value=motion?1:0;syncAutoRotate();
  }
  function onStart(){interacting=true;clearTimeout(idleTimer);idleTimer=0;syncAutoRotate();}
  function onEnd(){
    clearTimeout(idleTimer);
    idleTimer=setTimeout(()=>{interacting=false;idleTimer=0;syncAutoRotate();},4200);
  }
  controls.addEventListener('start',onStart);
  controls.addEventListener('end',onEnd);
  if(reduced&&reduced.addEventListener)reduced.addEventListener('change',onReducedChange);

  let down=null;
  function onPointerDown(ev){down=[ev.clientX,ev.clientY];}
  function onClick(ev){
    if(down&&Math.hypot(ev.clientX-down[0],ev.clientY-down[1])>5)return;
    const i=pick(ev);
    const node=i<0?null:nodes[i];
    highlight(node?node.id:null,1);
    try{onSelect(node);}catch(err){if(typeof console!=='undefined')console.error(err);}
  }
  function onDblClick(ev){
    const i=pick(ev);
    if(i<0)return;
    focus(nodes[i].id);
    try{onDoubleClick(nodes[i]);}catch(err){if(typeof console!=='undefined')console.error(err);}
  }
  function onContextLost(ev){
    ev.preventDefault();
    host.dispatchEvent(new CustomEvent('galaxy-error',{detail:'三维绘图上下文已丢失，请重新加载星图。'}));
  }
  renderer.domElement.addEventListener('pointerdown',onPointerDown);
  renderer.domElement.addEventListener('click',onClick);
  renderer.domElement.addEventListener('dblclick',onDblClick);
  renderer.domElement.addEventListener('webglcontextlost',onContextLost,false);

  function sizeToHost(){
    const w=host.clientWidth||1,h=host.clientHeight||1;
    renderer.setSize(w,h);
    camera.aspect=w/h;camera.updateProjectionMatrix();
    uniforms.uScale.value=clamp(h*pixelRatio*2.4,2200,14000);
  }
  const resize=new ResizeObserver(()=>sizeToHost());
  resize.observe(host);
  sizeToHost();

  function countVisible(){let c=0;for(let i=0;i<nCount;i++)if(!isHidden(i))c++;return c;}

  let lastLabels=0,frames=0,fps=0,lastTick=0;
  function animate(now){
    if(disposed)return;
    frame=requestAnimationFrame(animate);
    const dt=lastFrame?Math.min(0.06,(now-lastFrame)/1000):0;
    lastFrame=now;
    uniforms.uTime.value=now*0.001;
    if(flight){
      const t=clamp((now-flight.start)/780,0,1),k=t*t*(3-2*t);
      camera.position.lerpVectors(flight.from,flight.to,k);
      controls.target.lerpVectors(flight.fromTarget,flight.target,k);
      if(t>=1){flight=null;syncAutoRotate();}
    }
    controls.update();
    const dist=camera.position.distanceTo(controls.target);
    uniforms.uDash.value=clamp(dist/820,0.55,3.0);
    const nextLod=dist<210?2:(dist<560?1:0);
    if(nextLod!==lod){lod=nextLod;fillEdges();paintEdgeAlpha();refreshArrows();}
    if(decor&&motion){decor.nebula.rotation.y+=dt*0.006;decor.dust.rotation.y-=dt*0.014;}
    if(selectedIdx>=0)updateArrowGeometry();
    if(now-lastLabels>220){lastLabels=now;refreshLabels(false);}
    positionLabels();
    renderer.render(scene,camera);
    frames++;
    if(now-lastTick>1000){fps=Math.round(frames*1000/(now-lastTick));frames=0;lastTick=now;}
  }
  syncAutoRotate();
  frame=requestAnimationFrame(animate);

  function dispose(){
    if(disposed)return;
    disposed=true;
    cancelAnimationFrame(frame);
    clearTimeout(idleTimer);idleTimer=0;
    try{resize.disconnect();}catch(err){}
    renderer.domElement.removeEventListener('pointerdown',onPointerDown);
    renderer.domElement.removeEventListener('click',onClick);
    renderer.domElement.removeEventListener('dblclick',onDblClick);
    renderer.domElement.removeEventListener('webglcontextlost',onContextLost,false);
    if(reduced&&reduced.removeEventListener)reduced.removeEventListener('change',onReducedChange);
    controls.removeEventListener('start',onStart);
    controls.removeEventListener('end',onEnd);
    try{controls.dispose();}catch(err){}
    clearLabels();
    disposeObjects();
    try{renderer.dispose();}catch(err){}
    if(typeof renderer.forceContextLoss==='function'){try{renderer.forceContextLoss();}catch(err){}}
    renderer.domElement.remove();
    overlay.remove();
  }

  return {
    setData:setData,
    highlight:highlight,
    focus:focus,
    reset:reset,
    setLayers:function(types){
      if(!Array.isArray(types))return;
      layers=new Set(types);
      paintDim();fillEdges();paintEdgeAlpha();refreshArrows();refreshLabels(true);
    },
    setMetric:function(value){
      metric=value==='activity'?'activity':'degree';
      computeSizes();
    },
    setMotion:setMotion,
    stats:function(){
      return {
        fps:fps,
        nodes:nCount,
        edges:edges.length,
        dataNodes:nCount,
        visibleNodes:countVisible(),
        drawnEdges:drawnCount,
        drawCalls:renderer.info.render.calls,
        geometries:renderer.info.memory.geometries,
        textures:renderer.info.memory.textures,
        labels:labels.length,
        motionEnabled:motion,
        paletteColors:paletteColors,
        hueCount:hueCount
      };
    },
    dispose:dispose
  };
}
