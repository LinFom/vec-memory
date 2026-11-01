import fs from 'node:fs';
import path from 'node:path';
import {createBackup,inspectBackup,restoreBackup,writeBackup} from '../src/standalone/backup.mjs';
import {createSpaceEngine} from '../src/standalone/engine.mjs';
const [action,source,destination,spaceId]=process.argv.slice(2),password=process.env.VEC_MEMORY_BACKUP_PASSWORD;
try {
 if(action==='create') {
  const root=path.resolve(source),lock=path.join(root,'.service.lock');
  if(fs.existsSync(lock)){const {pid}=JSON.parse(fs.readFileSync(lock));let alive=true;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}if(alive)throw Error('Service is running; use the online backup API or stop it first');}
  writeBackup(destination,createBackup(root,{password,spaceId}));console.log(JSON.stringify({ok:true,file:path.resolve(destination)}));
 } else if(action==='inspect') {
  const a=inspectBackup(fs.readFileSync(source),password);console.log(JSON.stringify({kind:a.kind,spaceId:a.spaceId,files:a.files.length,totalBytes:a.totalBytes,checksum:a.checksum},null,2));
 } else if(action==='restore') {
  const result=restoreBackup(fs.readFileSync(source),destination,{password});
  const spaces=result.kind==='space'?[destination]:Object.keys(JSON.parse(fs.readFileSync(path.join(destination,'access.json'))).spaces).map(id=>path.join(destination,'spaces',id));
  for(const root of spaces){const e=createSpaceEngine({root,maintenance:true});try{await e.call('audit');}finally{await e.close();}}
  console.log(JSON.stringify({...result,validated:true},null,2));
 } else throw Error('Usage: standalone-backup.mjs create <stopped-root> <new-file> [spaceId] | inspect <file> | restore <file> <new-directory>');
} catch(error){console.error(error.message);process.exitCode=1;}
