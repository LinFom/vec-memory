import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {inspectAnyFile,restoreAnyFile} from '../src/standalone/backup.mjs';
import {createSpaceEngine} from '../src/standalone/engine.mjs';
import {digest} from '../src/core/durable-log.mjs';

const assert = (condition,message) => {if (!condition) throw Error(message);};
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function messageSample(file) {
  // The durable journal uses LF framing. readline also treats bare CR as a
  // separator, which can split historical JSON accepted by the journal reader.
  async function* lines() {
    let pending = '';
    for await (const chunk of createReadStream(file, {encoding:'utf8'})) {
      pending += chunk;
      let cut;
      while ((cut = pending.indexOf('\n')) !== -1) {
        yield pending.slice(0,cut);
        pending = pending.slice(cut+1);
      }
    }
    assert(!pending.length,'Incomplete journal tail in backup');
  }
  let count = 0, first, middle, last;
  for await (const line of lines()) {
    if (!line.trim()) continue;
    const message = JSON.parse(line).data?.message;
    count++;
    first ??= message;
    if (count % 100000 === 0) middle = message;
    last = message;
  }
  return {count,samples:[...new Map([first,middle,last].filter(Boolean).map(row => [row.messageId,row])).values()]};
}
async function verifyFiles(destination,archive) {
  let checked = 0;
  for (const file of archive.files) {
    // Restoration deliberately suspends jobs and clears transient receipts.
    if (/(?:^|\/)settings\.json$|(?:^|\/)state\.json$/.test(file.name)) continue;
    assert(await hashFile(path.join(destination,...file.name.split('/'))) === file.sha256,
      'Restored stable file differs from the reviewed archive');
    checked++;
  }
  return checked;
}
async function exerciseSpace(space,{probe=false,rebuild=false}={}) {
  const sampled = await messageSample(path.join(space,'input/messages.jsonl'));
  const engine = createSpaceEngine({root:space,maintenance:true});
  const started = performance.now();
  try {
    await engine.call('audit',{});
    const status = await engine.call('status',{});
    assert(status.messages === sampled.count,'Restored message count differs');
    const evidence = await engine.call('graphEvidence',{ids:sampled.samples.map(row => row.messageId),admin:true});
    assert(digest(evidence.messages) === digest(sampled.samples),'Restored original-message samples differ');
    let index;
    if (rebuild) {
      const begin = performance.now();
      index = await engine.call('job',{type:'history-lexical'});
      index = {ms:Math.round(performance.now()-begin),indexedRows:index.indexedRows ?? index.rows ?? null};
    }
    if (probe) {
      const scope = {kind:'private',id:'recovery-rehearsal'}, roleId='recovery-role';
      const message={messageId:'recovery-evidence',conversationId:'private:recovery-rehearsal',scope,
        actorId:'recovery-person',role:'user',timestamp:Date.now()-1000,text:'我住在恢复测试城，约好明天核对备份'};
      await engine.call('ingest',{messages:[message]});
      await engine.call('temporalWrite',{operationId:'recovery-temporal',scope,actorId:message.actorId,
        attribute:'residence',messageId:message.messageId,value:'恢复测试城'});
      await engine.call('roleNotesWrite',{operationId:'recovery-note',scope,roleId,kind:'concern',text:'记得核对备份',messageId:message.messageId});
      await engine.call('tasksWrite',{operationId:'recovery-task',scope,text:'核对备份',messageId:message.messageId});
      assert((await engine.call('temporalQuery',{scope,actorId:message.actorId,attribute:'residence'})).items.length===1,'Temporal probe unavailable');
      assert((await engine.call('roleNotesQuery',{scope,roleId,kind:'concern'})).items.length===1,'Role probe unavailable');
      assert((await engine.call('tasksQuery',{scope})).items.length===1,'Task probe unavailable');
      await engine.call('audit',{});
    } else {
      const absent=await engine.call('graphEvidence',{ids:['recovery-evidence'],admin:true});
      assert(absent.messages.length===0,'Rollback retained the upgrade probe');
    }
    return {messages:sampled.count,sampledMessages:sampled.samples.length,index,
      auditAndChecksMs:Math.round(performance.now()-started),probeWritten:probe};
  } finally {await engine.close();}
}

export async function rehearseMemoryRecovery({root,baseURL='http://127.0.0.1:8091',reportFile,workParent=os.tmpdir(),onProgress=()=>{}}) {
  root=await fs.realpath(root);
  const url=new URL(baseURL);
  assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Use a loopback service for local recovery rehearsal');
  const parent=await fs.realpath(workParent), temporary=await fs.mkdtemp(path.join(parent,'vec-memory-rehearsal-'));
  const password=randomBytes(32).toString('base64url');
  let backupId,peakRss=process.memoryUsage().rss;
  const ticker=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);},100);
  const report={date:new Date().toISOString(),status:'running',source:'online-consistent-full-service-backup',steps:[],spaces:[]};
  const phase=async(name,fn)=>{
    onProgress(name);
    const start=performance.now(), result=await fn();
    report.steps.push({name,ms:Math.round(performance.now()-start)});
    return result;
  };
  try {
    const created=await phase('online-backup',async()=>{
      const response=await fetch(new URL('/api/v1/admin/backups',url),{method:'POST',
        headers:{'content-type':'application/json'},body:JSON.stringify({mode:'full',includeRoleNotes:true,password}),
        signal:AbortSignal.timeout(600000)});
      const body=await response.json();
      assert(response.ok&&body.ok===true,'Online backup API failed');
      return body;
    });
    backupId=created.backupId;
    assert(/^[a-f0-9-]{36}$/i.test(backupId),'Unexpected backup ID');
    const archiveFile=path.join(root,'backups',backupId+'.vmb');
    const archive=await phase('verify-backup',()=>inspectAnyFile(archiveFile,password));
    assert(archive.kind==='service'&&archive.mode==='full','Rehearsal requires a complete service archive');
    report.archive={version:archive.version,files:archive.files.length,payloadBytes:archive.totalBytes,
      storedBytes:(await fs.stat(archiveFile)).size,checksum:archive.checksum};
    const upgrade=path.join(temporary,'upgraded'), rollback=path.join(temporary,'rollback');
    await phase('restore-upgrade',()=>restoreAnyFile(archiveFile,upgrade,{password,expectedChecksum:archive.checksum,verifiedChecksum:archive.checksum}));
    report.stableFilesVerified=await phase('verify-upgrade-files',()=>verifyFiles(upgrade,archive));
    const access=JSON.parse(await fs.readFile(path.join(upgrade,'access.json'),'utf8'));
    report.permissionsFingerprint=digest(access);
    for(const sid of Object.keys(access.spaces)) {
      const result=await phase('upgrade-audit-index-'+sid,()=>exerciseSpace(path.join(upgrade,'spaces',sid),{probe:true,rebuild:true}));
      report.spaces.push({space:sid,...result});
    }
    await phase('restore-rollback',()=>restoreAnyFile(archiveFile,rollback,{password,expectedChecksum:archive.checksum,verifiedChecksum:archive.checksum}));
    report.rollbackStableFilesVerified=await phase('verify-rollback-files',()=>verifyFiles(rollback,archive));
    assert(digest(JSON.parse(await fs.readFile(path.join(rollback,'access.json'),'utf8')))===report.permissionsFingerprint,'Rollback permissions differ');
    for(const sid of Object.keys(access.spaces)) {
      const result=await phase('rollback-audit-'+sid,()=>exerciseSpace(path.join(rollback,'spaces',sid)));
      const expected=report.spaces.find(row=>row.space===sid);
      assert(result.messages===expected.messages,'Rollback message count differs');
      expected.rollback=result;
    }
    report.status='passed';
    return report;
  } catch(error) {
    report.status='failed';
    report.error={code:error.code??'REHEARSAL_FAILED',message:error.message,stack:error.stack};
    throw error;
  } finally {
    clearInterval(ticker);
    report.peakRssBytes=peakRss;
    report.peakRssScope='rehearsal coordinator process; worker heaps excluded';
    if(reportFile) {
      await fs.mkdir(path.dirname(path.resolve(reportFile)),{recursive:true});
      await fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    }
    if(backupId&&/^[a-f0-9-]{36}$/i.test(backupId)) await fs.unlink(path.join(root,'backups',backupId+'.vmb')).catch(()=>{});
    if(path.dirname(await fs.realpath(temporary))===parent&&path.basename(temporary).startsWith('vec-memory-rehearsal-')) {
      await fs.rm(temporary,{recursive:true,force:true});
    }
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [root,reportFile,baseURL]=process.argv.slice(2);
  if(!root||!reportFile){console.error('Usage: node tools/rehearse-memory-recovery.mjs <service-root> <report.json> [loopback-url]');process.exitCode=1;}
  else try {
    const report=await rehearseMemoryRecovery({root,reportFile,baseURL,onProgress:phase=>console.log(JSON.stringify({phase}))});
    console.log(JSON.stringify({status:report.status,files:report.archive.files,spaces:report.spaces.map(row=>({space:row.space,messages:row.messages})),peakRssBytes:report.peakRssBytes}));
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
