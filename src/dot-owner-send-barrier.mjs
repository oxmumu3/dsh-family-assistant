import {setTimeout as delay} from 'node:timers/promises';

// This barrier does not send and must be called before acquiring an outbox or
// message mutex. All identities and task state come from the local Owner route.
export async function waitForOwnerReply({sessionId,sourceRequestId,bindingRevision,current,findTask,signal,timeoutMs=30000,now=()=>performance.now(),sleep=(ms)=>delay(ms,undefined,{signal})}={}){
 try{
  if(typeof sessionId!=='string'||!sessionId||typeof sourceRequestId!=='string'||!sourceRequestId||sourceRequestId.length>512||!/^[a-f0-9]{64}$/.test(bindingRevision??'')||typeof current!=='function'||typeof findTask!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<0||timeoutMs>30000||typeof now!=='function'||typeof sleep!=='function')return'blocked';
  const start=now();if(!Number.isFinite(start))return'blocked';
  while(true){
   if(signal?.aborted||current()!==true)return'blocked';
   const task=await findTask();
   if(signal?.aborted||current()!==true)return'blocked';
   if(task){
    if(task.sessionId!==sessionId||task.sourceRequestId!==sourceRequestId)return'blocked';
    if(task.state==='cancelled')return'blocked';
    if(['failed','unknown'].includes(task.state))return'ready';
    if(task.state==='succeeded'&&(!task.text?.trim()||['accepted','failed','unknown','suppressed'].includes(task.delivery?.state)))return'ready';
    if(!['queued','running','succeeded'].includes(task.state)||!['none','dispatching','accepted','failed','unknown','suppressed','unavailable'].includes(task.delivery?.state))return'blocked';
   }
   const elapsed=now()-start;if(!Number.isFinite(elapsed)||elapsed<0)return'blocked';if(elapsed>=timeoutMs)return'timeout';
   await sleep(Math.min(500,timeoutMs-elapsed));
  }
 }catch{return'blocked';}
}

// Gateway tasks can rotate a source into turns[]. The archived turn has no
// delivery record, so we must not infer an acknowledgement was sent.
export function findOwnerRequest(tasks,{personId,sessionId,sourceRequestId,deliveryForTurn}={}){
 if(!Array.isArray(tasks)||typeof personId!=='string'||!personId||typeof sessionId!=='string'||!sessionId||typeof sourceRequestId!=='string'||!sourceRequestId)return null;
 const matches=[];
 for(const task of tasks){
  if(!task||task.origin!=='wechat'||task.personId!==personId||task.sessionId!==sessionId)continue;
  if(task.sourceRequestId===sourceRequestId)matches.push(task);
  if(task.turns!==undefined&&!Array.isArray(task.turns))return null;
  for(const turn of task.turns??[])if(turn?.sourceRequestId===sourceRequestId){
   let delivery='unavailable';try{const found=typeof deliveryForTurn==='function'?deliveryForTurn(task,turn):null;if(['accepted','failed','unknown'].includes(found))delivery=found;}catch{}
   matches.push({sessionId,sourceRequestId,state:turn.state,text:turn.text,delivery:{state:delivery}});
  }
 }
 if(matches.length>1)return null;
 if(matches.length===0)return{task:null};
 if(['cancelled','cancelling'].includes(matches[0].state))return null;
 return{task:matches[0]};
}

// Recover only the original turn's exact outbox receipts on the original route.
// An absent or partial multipart record is unknown, never a success claim.
export function archivedOwnerDelivery({task,turn,route,outbox}={}){
 try{
  if(!task||typeof task.id!=='string'||!turn||typeof turn.requestId!=='string'||typeof turn.text!=='string'||!route||!Array.isArray(outbox))return'unavailable';
  const routeKeys=['personId','accountId','peerId','generation'];const same=(a,b)=>a&&b&&routeKeys.every(key=>a[key]===b[key]);
  let text=turn.text.replace(/file:\/\/[^\s]+|\/(?:Users|home|private|tmp)\/[^\s，。；]+/g,'（本地路径已省略）'),count=0;
  while(text.length){let end=Math.min(3000,text.length);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;if(end<1)return'unavailable';text=text.slice(end);count++;}
  if(!count)return'unavailable';
  for(let i=0;i<count;i++){
   const key=`harness-task:${task.id}:${turn.requestId}:${i}`;const rows=outbox.filter(row=>row?.sourceKey===key);
   if(rows.length!==1||rows[0].kind!=='harness_result'||rows[0].personId!==route.personId||!same(rows[0].route,route)||!same(rows[0].authorizationRoute,route))return'unavailable';
   if(rows[0].status==='uncertain')return'unknown';
   if(['failed','cancelled','blocked','expired'].includes(rows[0].status))return'failed';
   if(rows[0].status!=='api_accepted')return'unavailable';
  }
  return'accepted';
 }catch{return'unavailable';}
}
