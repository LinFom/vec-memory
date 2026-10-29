import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function required(value, name) { if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an explicit absolute path`); return path.resolve(value); }
function inside(parent, child) { const rel = path.relative(parent, child); return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel)); }
function scan(root, prefix = '') {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) throw new Error('Symbolic links are not supported');
  return fs.readdirSync(root, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link: ${rel}`);
    if (entry.isDirectory()) return scan(file, rel);
    if (!entry.isFile()) throw new Error(`Unsupported asset: ${rel}`);
    return [{path:rel, bytes:fs.statSync(file).size, sha256:hash(file)}];
  });
}
function ensureEmpty(target) {
  // Reject symlink ancestors as well as a symlink at the final target.
  let ancestor = target;
  while (ancestor !== path.dirname(ancestor)) { if (fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Symlink target ancestor'); ancestor=path.dirname(ancestor); }
  if(fs.existsSync(target) && fs.readdirSync(target).length) throw new Error('Target must be empty');
}
function copy(source, target, assets) {
  for(const asset of assets) {
    const dest=path.join(target, asset.path);
    fs.mkdirSync(path.dirname(dest), {recursive:true});
    fs.copyFileSync(path.join(source,asset.path),dest,fs.constants.COPYFILE_EXCL);
    if(hash(dest)!==asset.sha256) throw new Error(`Copy mismatch: ${asset.path}`);
  }
}
export function migrate({from, to, spaceId, sourceRoot=''}) {
  from=required(from,'from'); to=required(to,'to');
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(spaceId||'')) throw new Error('Invalid spaceId');
  if(!fs.statSync(path.join(from,'memory-vec')).isDirectory()) throw new Error('from must be the data root containing memory-vec');
  if(inside(from,to)||inside(to,from)) throw new Error('Source and target must be disjoint');
  if(sourceRoot) { sourceRoot=required(sourceRoot,'sourceRoot'); if(inside(sourceRoot,to)||inside(to,sourceRoot)) throw new Error('Source-root and target must be disjoint'); }
  const space=path.join(to,'spaces',spaceId);
  ensureEmpty(space);
  const assets=scan(from);
  const sourceAssets=sourceRoot ? scan(sourceRoot) : [];
  fs.mkdirSync(space,{recursive:true});
  copy(from,path.join(space,'legacy','data'),assets);
  if(sourceRoot) copy(sourceRoot,path.join(space,'imported-source'),sourceAssets);
  if(JSON.stringify(scan(from))!==JSON.stringify(assets) || (sourceRoot && JSON.stringify(scan(sourceRoot))!==JSON.stringify(sourceAssets))) throw new Error('Source changed during copy; do not activate this target');
  const manifest={version:1,spaceId,createdAt:new Date().toISOString(),from,sourceRoot:sourceRoot||null,assets,sourceAssets,byteIntegrity:true,sourceStable:true,semanticRecovery:'not-verified',activated:false};
  fs.writeFileSync(path.join(space,'migration-manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
  return {ok:true,spaceRoot:space,files:assets.length,sourceFiles:sourceAssets.length,semanticRecovery:'not-verified',activated:false};
}
export function verify({spaceRoot}) {
  spaceRoot=required(spaceRoot,'spaceRoot');
  const manifest=JSON.parse(fs.readFileSync(path.join(spaceRoot,'migration-manifest.json'),'utf8'));
  const actual=scan(path.join(spaceRoot,'legacy','data'));
  const sourceActual=manifest.sourceRoot ? scan(path.join(spaceRoot,'imported-source')) : [];
  const byteIntegrity=JSON.stringify(actual)===JSON.stringify(manifest.assets) && JSON.stringify(sourceActual)===JSON.stringify(manifest.sourceAssets);
  return {ok:byteIntegrity,byteIntegrity,semanticRecovery:'not-verified',activated:false};
}
export function exportSpace({spaceRoot,to}) {
  spaceRoot=required(spaceRoot,'spaceRoot'); to=required(to,'to');
  if(inside(spaceRoot,to)||inside(to,spaceRoot)) throw new Error('Export target must be disjoint');
  ensureEmpty(to);
  const assets=scan(spaceRoot);
  fs.mkdirSync(to,{recursive:true}); copy(spaceRoot,path.join(to,'space'),assets);
  if(JSON.stringify(scan(spaceRoot))!==JSON.stringify(assets)) throw new Error('Space changed during export; pause writes and retry');
  fs.writeFileSync(path.join(to,'export-manifest.json'),JSON.stringify({version:1,createdAt:new Date().toISOString(),assets,byteIntegrity:true,sourceStable:true},null,2),{flag:'wx'});
  return {ok:true,files:assets.length,byteIntegrity:true};
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [command,...argv]=process.argv.slice(2); const args={};
    for(let i=0;i<argv.length;i++) { const a=argv[i]; if(!a.startsWith('--')) throw new Error('Expected named argument'); const eq=a.indexOf('='); const key=a.slice(2,eq<0?undefined:eq); args[key]=eq<0?argv[++i]:a.slice(eq+1); }
    const result=command==='migrate'?migrate({from:args.from,to:args.to,spaceId:args.space,'sourceRoot':args['source-root']}):command==='verify'?verify({spaceRoot:args['space-root']}):command==='export'?exportSpace({spaceRoot:args['space-root'],to:args.to}):null;
    if(!result) throw new Error('Use migrate --from ABS --to ABS --space ID [--source-root ABS], verify --space-root ABS, or export --space-root ABS --to ABS');
    process.stdout.write(JSON.stringify(result)+'\n'); if(!result.ok) process.exitCode=1;
  } catch(error) { process.stderr.write(JSON.stringify({ok:false,error:error.message})+'\n'); process.exitCode=1; }
}
