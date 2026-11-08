import fs from 'node:fs';
import path from 'node:path';
import {createBackupTo, inspectAnyFile, restoreAnyFile} from '../src/standalone/backup.mjs';
import {createSpaceEngine} from '../src/standalone/engine.mjs';
// `--mode=evidence|full` 是可以出现在任意位置的旗标，从位置参数里摘掉再解析。
// 缺省不传 ⇒ createBackupTo 自己取默认值（evidence）。想要完整镜像必须显式写 --mode=full，
// 这样「多带了 500MB 原始聊天」永远是打字打出来的决定，而不是没注意到默认值。
const argv = process.argv.slice(2);
const modeArg = argv.find(a => a.startsWith('--mode='))?.slice('--mode='.length);
const [action,source,destination,option]=argv.filter(a=>!a.startsWith('--mode=')),password=process.env.VEC_MEMORY_BACKUP_PASSWORD;
try {
 if(action==='create') {
  const root=path.resolve(source),lock=path.join(root,'.service.lock');
  if(fs.existsSync(lock)){const {pid}=JSON.parse(fs.readFileSync(lock));let alive=true;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}if(alive)throw Error('Service is running; use the online backup API or stop it first');}
  // 流式写入：库再大也不会整份进内存。
  const result=await createBackupTo(root,path.resolve(destination),{password,spaceId:option,mode:modeArg});
  console.log(JSON.stringify({ok:true,file:path.resolve(destination),...result}));
 } else if(action==='inspect') {
  const a=await inspectAnyFile(path.resolve(source),password);
  console.log(JSON.stringify({kind:a.kind,spaceId:a.spaceId,mode:a.mode||'full',evidenceOnly:(a.mode||'full')==='evidence',files:a.files.length,totalBytes:a.totalBytes,checksum:a.checksum,excluded:a.excluded||[]},null,2));
 } else if(action==='restore') {
  const result=await restoreAnyFile(path.resolve(source),destination,{password,expectedChecksum:option});
  const spaces=result.kind==='space'?[destination]:Object.keys(JSON.parse(fs.readFileSync(path.join(destination,'access.json'))).spaces).map(id=>path.join(destination,'spaces',id));
  for(const root of spaces){const e=createSpaceEngine({root,maintenance:true});try{await e.call('audit');}finally{await e.close();}}
  console.log(JSON.stringify({...result,validated:true},null,2));
 } else throw Error('Usage: standalone-backup.mjs create <stopped-root> <new-file> [spaceId] [--mode=evidence|full] | inspect <file> | restore <file> <new-directory> [expected-checksum]');
} catch(error){console.error(error.message);process.exitCode=1;}
