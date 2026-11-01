import fs from 'node:fs';
import {digest} from '../src/core/durable-log.mjs';

// Explicit, rerunnable legacy import. No host modules, no scanning host directories.
export async function importGroupMemory({document,spaceId,baseURL,token,fetchImpl=fetch}) {
  if(document.version!==1||!Array.isArray(document.entries)||typeof document.chatKey!=='string')throw Error('Expected a version 1 group-memory document');
  const match=/^(group|private):(.+)$/.exec(document.chatKey);if(!match)throw Error('Invalid legacy chatKey');
  const scope={kind:match[1],id:match[2]},sceneId=document.chatKey;
  const request=async body=>{const r=await fetchImpl(baseURL.replace(/\/$/,'')+'/api/v1/spaces/'+encodeURIComponent(spaceId)+'/workspace',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await r.json();if(!r.ok)throw Error(result.code+': '+result.error);return result;};
  await request({action:'ensureScene',scope,name:document.entries.find(e=>e.kind==='title')?.text||document.chatKey});
  const results=[];
  for(const entry of document.entries)results.push(await request({action:'entry',operationId:'legacy-group:'+digest([document.chatKey,entry]),sceneId,scope,kind:entry.kind,text:entry.text,legacy:true,legacyRecord:entry,confirm:false,shareable:false}));
  return {ok:true,imported:results.length,sceneId,unverified:true};
}
if(process.argv[1]&&import.meta.url===(await import('node:url')).pathToFileURL(process.argv[1]).href){
 const [file,spaceId]=process.argv.slice(2);
 try{const result=await importGroupMemory({document:JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')),spaceId,baseURL:process.env.VEC_MEMORY_URL||'http://127.0.0.1:8091',token:process.env.VEC_MEMORY_ADMIN_TOKEN});console.log(JSON.stringify(result,null,2));}catch(error){console.error(error.message);process.exitCode=1;}
}
