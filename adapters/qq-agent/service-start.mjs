import fs from 'node:fs';
import path from 'node:path';

// A protocol adapter may start an existing local service, never initialize a new data root.
export function standaloneStartArgs(cfg) {
  const base=new URL(cfg.serviceBaseURL||'http://127.0.0.1:8091');
  if(base.protocol!=='http:'||base.username||base.password||!['127.0.0.1','localhost','[::1]'].includes(base.hostname))return null;
  const repo=String(cfg.serviceRoot||''),root=String(cfg.serviceDataRoot||'');
  if(!path.isAbsolute(repo)||!path.isAbsolute(root)||!fs.existsSync(path.join(root,'access.json')))return null;
  const tool=path.join(repo,'tools','standalone-server.mjs');if(!fs.existsSync(tool))return null;
  const args=['--max-old-space-size=8192',tool,'serve','--root',root,'--host',base.hostname==='[::1]'?'::1':'127.0.0.1','--port',base.port||'80'];
  if(cfg.managementOrigins!=null&&!Array.isArray(cfg.managementOrigins))throw Error('managementOrigins must be an array');
  for(const value of cfg.managementOrigins||[]){const origin=new URL(value);if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('Invalid management origin');args.push('--embed-origin',origin.origin);}
  return args;
}
