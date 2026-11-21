import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createSpaceEngine} from '../src/standalone/engine.mjs';
import {resolveReminderDate} from '../src/standalone/reminder-date.mjs';

const zone='Asia/Hong_Kong', now=Date.parse('2027-01-04T10:00:00+08:00');
const scope={kind:'private',id:'one'};
test('calendar capture preserves day precision, timezone and unambiguous clocks',()=>{
  const date=resolveReminderDate('明天去还书',now,zone);
  assert.equal(date.dueAt,Date.parse('2027-01-05T00:00:00+08:00'));
  assert.equal(date.duePrecision,'day');
  assert.equal(resolveReminderDate('下周三下午三点半去复查',now,zone).dueAt,Date.parse('2027-01-13T15:30:00+08:00'));
  assert.equal(resolveReminderDate('月底交材料',now,zone).dueAt,Date.parse('2027-01-31T00:00:00+08:00'));
  assert.equal(resolveReminderDate('明天晚上去还书',now,zone),null);
  assert.equal(resolveReminderDate('2月30日去还书',now,zone),null);
  assert.equal(resolveReminderDate('明天或后天去还书',now,zone),null);
});

test('natural reminders revise only the speaker task and suppress cancelled source recall',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'vec-natural-'));
  await fs.writeFile(path.join(root,'settings.json'),JSON.stringify({reminderTimeZone:zone}));
  let engine=createSpaceEngine({root,evaluation:true,maintenance:true});
  t.after(async()=>{await engine.close();await fs.rm(root,{recursive:true,force:true});});
  let index=0;
  await engine.call('entity',{entityId:'alice',displayName:'小甲'});
  await engine.call('entity',{entityId:'bob',displayName:'小乙'});
  const ingest=async(text,extra={})=>engine.call('ingest',{evaluationNow:now,
    messages:[{messageId:'m'+(++index),conversationId:'one',scope,actorId:'alice',role:'user',timestamp:now-600000+index,text,...extra}]});
  for(const text of ['小李明天去还书','明天小李去还书','如果明天去还书','明天去还书吗？','“明天去还书”']) {
    assert.equal((await ingest(text)).reminderCapture.written,0,text);
  }
  assert.equal((await ingest('明天去还书')).reminderCapture.written,1);
  assert.equal((await ingest('后天去还书',{actorId:'bob'})).reminderCapture.written,1);
  assert.equal((await ingest('小李已经还书了')).reminderCapture.written,0);
  assert.equal((await ingest('还书改到后天')).reminderCapture.written,1);
  let rows=(await engine.call('recall',{scope,observations:{status:'planned'},evaluationNow:now})).records;
  const own=rows.find(r=>r.payload.subject==='alice');
  assert.equal(own.revision,2);
  assert.equal(own.payload.dueAt,Date.parse('2027-01-06T00:00:00+08:00'));
  assert.equal((await ingest('不用去还书了')).reminderCapture.written,1);
  rows=(await engine.call('recall',{scope,observations:{status:'planned'},evaluationNow:now})).records;
  assert.equal(rows.length,1);assert.equal(rows[0].payload.subject,'bob');
  await engine.close();engine=createSpaceEngine({root,evaluation:true,maintenance:true});
  const cancelled=(await engine.call('recall',{scope,observations:{status:'cancelled'},evaluationNow:now})).records;
  assert.equal(cancelled.length,1);assert.equal(cancelled[0].revision,3);
  const recall=await engine.call('recall',{scope,purpose:'automatic',natural:true,query:'还书',evaluationNow:now,limit:99});
  assert(recall.items.length<=3);
  assert(recall.items.every(item=>!item.sourceRefs.some(ref=>['m6','m9','m10'].includes(ref.id))));
  await ingest('小乙喜欢种兰花');
  await ingest('继续聊种兰花',{timestamp:now-1});
  const attributed=await engine.call('recall',{scope,purpose:'automatic',natural:true,agentView:true,query:'种兰花',evaluationNow:now});
  assert(attributed.items.some(item=>item.text.includes('小甲原话：')&&item.text.includes('小乙喜欢种兰花')),JSON.stringify(attributed.items));
});
