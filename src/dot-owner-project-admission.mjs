import {createHash} from 'node:crypto';
import {isAbsolute,resolve} from 'node:path';

const hash=value=>createHash('sha256').update(value).digest('hex');
const revision=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
// This is only a timing precondition. The caller must also prove the exact
// original request and currently running native tool call. Model latency is
// distinct from a message which already arrived late from the provider.
export function ownerProjectAdmissionTimeCurrent(timing,now){
 if(typeof timing?.receivedAt!=='string'||typeof timing?.providerCreatedAt!=='string'||typeof now!=='string')return false;
 const received=Date.parse(timing.receivedAt),created=Date.parse(timing.providerCreatedAt),current=Date.parse(now);
 return [received,created,current].every(Number.isFinite)&&created<=received+5000&&received<=current+5000&&received-created<=30000&&current-received<=600000;
}
// This is deliberately a small, literal envelope. Everything after the colon
// remains the user's task, including every negative constraint and return hint.
export function ownerProjectEnvelope(text){
 if(typeof text!=='string'||text.length>64000)return null;
 const match=text.trim().match(/^(?:请)?(?:把|将)(?:这个|这项)?任务(?:交给|派给)\s*([^：:\n]{2,240})\s*[：:]\s*([\s\S]+)$/u);
 if(!match)return null;
 const project=match[1].trim(),task=match[2].trim();
 if(!task||task.length>2000||/(?:如果|假如|假设|只预览|仅预览|无需执行|不要执行|暂不执行)/.test(project+'\n'+task))return null;
 // A plain native prompt cannot enforce read-only tool permissions. The
 // existing deterministic reader is a separate capability and remains so.
 if(/只读|仅读|仅(?:看|查看|检查|阅读)|只(?:看|查看|检查)|(?:不要|不得|禁止|别|不许).{0,4}(?:修改|写入|创建|删除|改动|更改|改文件)/.test(task))return null;
 return{project,task};
}

export function createDotOwnerProjectAdmission({authenticate,current,workspaces,workspaceCurrentSync,sourceRequest}={}){
 const safe=(fn)=>{try{return fn()===true;}catch{return false;}};
 const route=authority=>revision(authority?.bindingRevision)&&safe(()=>current(authority.sessionId,authority.bindingRevision));
 const registered=authority=>safe(()=>workspaceCurrentSync(authority.root,authority.workspaceId));
 const origin=authority=>{
  try{const row=sourceRequest(authority);if(!row||['cancelled','cancelling'].includes(row.state))return false;
   const envelope=ownerProjectEnvelope(row.userText);return envelope?.project===authority.projectName&&hash(envelope.task)===authority.taskHash;
  }catch{return false;}
 };
 function deliveryCurrent(authority){return route(authority)&&registered(authority)&&origin(authority);}
 async function acquire(input){
  try{
   if(!input||Object.keys(input).some(key=>!['sessionId','callId','bindingRevision','root','task','signal'].includes(key))||typeof input.sessionId!=='string'||!input.sessionId||input.sessionId.length>200||typeof input.callId!=='string'||!input.callId||!revision(input.bindingRevision)||typeof input.root!=='string'||!isAbsolute(input.root)||input.root!==resolve(input.root)||typeof input.task!=='string'||input.signal?.aborted)return null;
   const auth=await authenticate(input);
   if(!auth||auth.sessionId!==input.sessionId||auth.bindingRevision!==input.bindingRevision||typeof auth.sourceRequestId!=='string'||!auth.sourceRequestId||auth.sourceRequestId.length>512||typeof auth.authorize!=='function'||!safe(auth.authorize)||!route(auth))return null;
   const envelope=ownerProjectEnvelope(auth.userText);if(!envelope||input.task!==envelope.task)return null;
   const rows=await workspaces();if(!Array.isArray(rows)||input.signal?.aborted||!safe(auth.authorize)||!route(auth))return null;
   const named=rows.filter(row=>row&&(row.title===envelope.project||row.workspaceId===envelope.project));
   if(named.length!==1)return null;
   const ws=named[0];if(typeof ws.workspaceId!=='string'||!ws.workspaceId||typeof ws.path!=='string'||!isAbsolute(ws.path)||resolve(ws.path)!==input.root||rows.filter(row=>row?.workspaceId===ws.workspaceId).length!==1||rows.filter(row=>typeof row?.path==='string'&&isAbsolute(row.path)&&resolve(row.path)===input.root).length!==1)return null;
   const authority={sessionId:input.sessionId,bindingRevision:input.bindingRevision,sourceRequestId:auth.sourceRequestId,workspaceId:ws.workspaceId,root:input.root,projectName:envelope.project,taskHash:hash(envelope.task)};
   const permitted=()=>!input.signal?.aborted&&safe(auth.authorize)&&deliveryCurrent(authority);
   if(!permitted())return null;
   const recheck=async()=>{if(!permitted())return false;try{const latest=await authenticate(input);return permitted()&&latest?.sessionId===authority.sessionId&&latest.bindingRevision===authority.bindingRevision&&latest.sourceRequestId===authority.sourceRequestId&&latest.userText===auth.userText&&typeof latest.authorize==='function'&&safe(latest.authorize);}catch{return false;}};
   return{task:envelope.task,root:input.root,authority,dedupeKey:'family-native-'+hash(JSON.stringify(authority)),current:permitted,recheck};
  }catch{return null;}
 }
 return{acquire,deliveryCurrent};
}
