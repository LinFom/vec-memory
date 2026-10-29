import fs from 'node:fs';
import path from 'node:path';
import { MemoryError } from './durable-log.mjs';
export const POLICY_VERSION = 1;
export const PROFILE_POLICIES = Object.freeze(['same-scope', 'group-peers', 'all']);
export function scopeType(scope) {
  return typeof scope === 'string' && /^(group|private):[^\s:]+$/.test(scope) ? scope.split(':')[0] : null;
}
export function evaluateVisibility({ sourceScope, targetScope, section = 'profile', policy = 'same-scope', isSelf = false } = {}) {
  if (!['profile','attribute','subject'].includes(section) || !PROFILE_POLICIES.includes(policy)) throw new MemoryError('INVALID_POLICY', 'Unknown visibility policy');
  const a = scopeType(sourceScope), b = scopeType(targetScope);
  const relation = isSelf && section !== 'subject' ? 'self' : !a || !b ? 'unknown' : sourceScope === targetScope ? 'same'
    : a === 'group' && b === 'group' ? 'group-peer' : a === 'private' && b === 'private' ? 'private-peer' : `${a}-to-${b}`;
  const same = relation === 'same' || relation === 'self';
  const allowed = same || relation !== 'unknown' && (section === 'profile'
    ? policy === 'all' || policy === 'group-peers' && relation === 'group-peer'
    : section === 'attribute' && relation !== 'private-to-group');
  return { allowed, relation, reason: same ? relation : allowed ? 'cross-scope-allowed' : relation === 'unknown' ? 'unknown-scope' : 'policy-blocked',
    rank: allowed ? same ? 0 : 1 : null, policyId: section === 'profile' ? policy : section === 'attribute' ? 'attribute-v1' : 'subject-same-scope' };
}
const own = (o,k) => Object.hasOwn(o || {}, k);
function legacy(value) {
  if (![true,false,'true','false'].includes(value)) throw new MemoryError('INVALID_POLICY', 'profileCrossScope must be boolean');
  return value === true || value === 'true' ? 'all' : 'same-scope';
}
function policy(value) { if (!PROFILE_POLICIES.includes(value)) throw new MemoryError('INVALID_POLICY', 'Invalid profilePolicy'); return value; }
export function resolveProfilePolicy({ request = {}, settings = {}, existing = true } = {}) {
  if (own(request,'profilePolicy') && own(request,'profileCrossScope') && policy(request.profilePolicy) !== legacy(request.profileCrossScope)) throw new MemoryError('POLICY_CONFLICT', 'Conflicting profilePolicy and profileCrossScope');
  if (own(request,'profilePolicy')) return { id: policy(request.profilePolicy), origin: 'request' };
  if (own(request,'profileCrossScope')) return { id: legacy(request.profileCrossScope), origin: 'request-legacy' };
  if (own(settings,'profilePolicy') && settings.profilePolicy != null && settings.profilePolicy !== '') return { id: policy(settings.profilePolicy), origin: 'instance' };
  if (own(settings,'profileCrossScope') && settings._profileCrossScopeExplicit !== false) return { id: legacy(settings.profileCrossScope), origin: 'instance-legacy' };
  // Existing runtimes previously defaulted true. Do not silently narrow them on upgrade.
  return { id: existing ? 'all' : 'group-peers', origin: existing ? 'legacy-default' : 'new-install-default' };
}

// A new-install default must survive restart; an existing unmarked library retains its old default.
export function loadPolicyBaseline(root) {
  const file=path.join(root,'policy-baseline.json');
  if(fs.existsSync(file)) {
    let value; try {value=JSON.parse(fs.readFileSync(file,'utf8'));} catch(e) {throw new MemoryError('STORAGE_UNAVAILABLE','Invalid policy baseline: '+e.message,503);}
    if(value.version!==1 || value.profilePolicy!=='group-peers') throw new MemoryError('STORAGE_UNAVAILABLE','Unsupported policy baseline',503);
    return {existing:false};
  }
  if(fs.existsSync(root) && fs.readdirSync(root).length) return {existing:true};
  fs.mkdirSync(root,{recursive:true});
  const fd=fs.openSync(file,'wx');
  try {fs.writeFileSync(fd,JSON.stringify({version:1,profilePolicy:'group-peers'})+'\n');fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  return {existing:false};
}
