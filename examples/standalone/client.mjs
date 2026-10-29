// VEC_BASE_URL, VEC_TOKEN and VEC_SPACE must point to a provisioned project.
import {randomUUID} from 'node:crypto';
const base=(process.env.VEC_BASE_URL||'http://127.0.0.1:8091').replace(/\/$/,'');
const token=process.env.VEC_TOKEN,space=process.env.VEC_SPACE;
if(!token||!space) throw new Error('Set VEC_TOKEN and VEC_SPACE');
async function request(route,body) {
  const response=await fetch(`${base}/api/v1/spaces/${encodeURIComponent(space)}/${route}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
  const data=await response.json(); if(!response.ok||data.ok===false) throw new Error(`${response.status}: ${data.code||data.error}`); return data;
}
const conversationId='demo-chat',scope={kind:'private',id:conversationId};
console.log(await request('messages',{messages:[{messageId:randomUUID(),conversationId,actorId:'demo-user',role:'user',timestamp:new Date().toISOString(),text:'我喜欢喝不加糖的茶。',scope}]}));
// Requires an explicitly configured model and incurs model usage.
if(process.env.VEC_RUN_CONSOLIDATE==='1') {
  const job=await request('jobs',{type:'consolidate'});
  const deadline=Date.now()+300000;
  for(;;) {
    const {job:state}=await request(`jobs/${encodeURIComponent(job.jobId)}`);
    if(state.status==='failed') throw new Error(`Consolidation failed: ${state.error}`);
    if(state.status==='completed') {console.log('job:',state);break;}
    if(Date.now()>deadline) throw new Error(`Timed out waiting for job ${job.jobId}; query its status to resume`);
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
}
const recalled=await request('recall',{query:'我喜欢喝什么？',conversationId,scope,actorIds:['demo-user']});
console.log(recalled);
// Confirm only after these items have actually been appended to your model context.
if(process.env.VEC_CONFIRM_ADOPTION==='1' && recalled.receiptId) console.log(await request('adoptions',{receiptId:recalled.receiptId,itemIds:recalled.items.map(item=>item.id)}));
