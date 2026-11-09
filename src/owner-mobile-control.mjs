import {randomBytes} from 'node:crypto';

const sameRoute=(a,b)=>a&&b&&['personId','accountId','peerId','generation'].every(key=>a[key]===b[key]);
const plain=(value,max=1200)=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(0,max).trim();
const contexts=new Set(['runtime-context','agent-instructions','compact-checkpoint','model-selection','time-context','tmux-context','user-approval','working-directory','repeat-tool-reminder','plan-mode','tool-registry','ptc-mode','skill-catalog','skill-invocation','session-reference','tool-goal']);
const unavailable=()=>Object.assign(Error('mobile question unavailable'),{code:'ASK_ABORTED'});
/** Ephemeral answerer for one durable Owner request. Never owns transport or approval policy. */
export function createOwnerMobileControl({resolveTask,getAgent,sendNotice,timeoutMs=600000,now=Date.now,isContinued=()=>false,answerContinued=()=>false}={}){
 if(![resolveTask,getAgent,sendNotice].every(fn=>typeof fn==='function')||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw Error('Invalid mobile control dependencies');
 const claims=new Map(),pending=new Map(),replies=new Map();let closed=false;
 const valid=claim=>{try{return !closed&&!claim.stopped&&!claim.ended&&!claim.mixed&&claim.scope&&claims.get(claim.agent.id)===claim&&getAgent(claim.agent.id)===claim.agent&&claim.scope.authorize()===true;}catch{return false;}};
 function questionState(item,state){try{if(item.kind==='question'&&item.callId)item.claim.scope.questionState?.({callId:item.callId,state});}catch{}}
 const validContinued=item=>{try{const active=claims.get(item.claim.agent.id);return !closed&&!item.claim.stopped&&!item.claim.mixed&&(!active||active===item.claim||active.ended)&&getAgent(item.claim.agent.id)===item.claim.agent&&item.claim.scope.authorize()===true&&isContinued(item.claim.agent,item.callId)===true;}catch{return false;}};
 function finish(item,value,error){if(!pending.has(item.code))return;pending.delete(item.code);clearTimeout(item.timer);item.signal?.removeEventListener('abort',item.abort);questionState(item,item.continued&&value?'answered_continued':'closed');error?item.reject(error):item.resolve(value);}
 const withdraw=claim=>{for(const item of [...pending.values()])if(item.claim===claim)finish(item,item.kind==='approval'?'unavailable':undefined,item.kind==='question'?unavailable():undefined);for(const [callId,linked] of replies)if(linked===claim)replies.delete(callId);};
 function claimed({agent,message,turn}={}){
  if(closed||!agent||!Number.isSafeInteger(turn)||turn<0)return;
  const source=message?.source,previous=claims.get(agent.id);
  if(contexts.has(source?.kind))return;
  const linked=source?.kind==='user-question-reply'?replies.get(JSON.stringify([agent.id,source.callId])):null;
  if(linked&&linked.agent===agent&&getAgent(agent.id)===agent&&linked.scope.authorize()===true){
   if(previous?.turn===turn&&(previous.mixed||previous.agent!==agent||previous.scope?.requestId!==linked.scope.requestId)){previous.mixed=true;withdraw(previous);return;}
   replies.delete(JSON.stringify([agent.id,source.callId]));claims.set(agent.id,{agent,turn,scope:linked.scope});return;
  }
  if(source?.kind==='user-question-reply'&&previous?.turn===turn&&[...pending.values()].some(item=>item.claim===previous&&item.callId===source.callId))return;
  let scope;try{scope=source?.kind==='user'&&typeof (source.rpcId??message.id)==='string'?resolveTask(agent.id,source.rpcId??message.id):null;}catch{}
  if(previous?.turn===turn){
   if(!scope||previous.scope?.requestId!==scope.requestId||previous.agent!==agent){previous.mixed=true;withdraw(previous);}
   return;
  }
  if(previous)withdraw(previous);
  claims.set(agent.id,{agent,turn,scope:scope??null,mixed:!scope});
 }
 function ended({sessionId,turn}={}){const claim=claims.get(sessionId);if(claim?.turn===turn){claim.ended=true;for(const item of [...pending.values()])if(item.claim===claim&&!item.continued)finish(item,item.kind==='approval'?'unavailable':undefined,item.kind==='question'?unavailable():undefined);if(![...pending.values()].some(item=>item.claim===claim))claims.delete(sessionId);}}
 function questions(request){
  const rows=request.questions;
  if(!Array.isArray(rows)||!rows.length||rows.length>3)return null;
  const copied=rows.map(q=>({id:q.id,question:q.question,...(q.options?{options:q.options.map(o=>({label:o.label}))}:{}),...(q.multiSelect?{multiSelect:true}:{}),...(q.intent?{intent:q.intent}:{}),...(q.detail?{detail:q.detail}:{})}));
  if(new Set(copied.map(q=>q.id)).size!==copied.length||copied.some(q=>typeof q.id!=='string'||!q.id||typeof q.question!=='string'||!q.question||q.options&&(!Array.isArray(q.options)||q.options.length>8||q.options.some(o=>typeof o.label!=='string'||!o.label))))return null;
  if(JSON.stringify(copied).length>2200)return null;
  // Approval/plan-intent questions carry richer Host decisions. Keep them on
  // the Host; actual tool approvals use the one-shot approval waterfall below.
  return copied.some(q=>q.intent)?null:copied;
 }
 function wait(kind,request,next){
  const claim=claims.get(request.agent?.id);
  if(!claim||claim.agent!==request.agent||!valid(claim))return next();
  const rows=kind==='question'?questions(request):null;
  if(kind==='question'&&!rows)return next();
  if(request.signal?.aborted||pending.size>=16)return kind==='approval'?Promise.resolve('unavailable'):Promise.reject(unavailable());
  let code;do{code=randomBytes(3).toString('hex').toUpperCase();}while(pending.has(code));
  let resolve,reject;const result=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const item={kind,claim,code,rows,callId:request.wait?.callId,resolve,reject,signal:request.signal,expiresAt:now()+timeoutMs,delivered:false};
  item.abort=()=>{
   if(kind==='question'&&request.wait?.timed===true&&item.signal.reason?.code==='ASK_TIMED_OUT'){
    item.continued=true;item.signal.removeEventListener('abort',item.abort);questionState(item,'continued');item.reject(item.signal.reason);return;
   }
   finish(item,kind==='approval'?'cancelled':undefined,kind==='question'?unavailable():undefined);
  };
  item.timer=setTimeout(()=>finish(item,kind==='approval'?'unavailable':undefined,kind==='question'?unavailable():undefined),timeoutMs);item.timer.unref?.();pending.set(code,item);questionState(item,'open');item.signal?.addEventListener('abort',item.abort,{once:true});
  const label=plain(claim.scope.label,100),body=kind==='approval'?`需要你确认本次操作：${plain(request.toolName,100)}\n${plain(request.displayReason?.['zh-CN']??request.reason,1000)}\n仅同意这一次：同意本次 ${code}\n拒绝：拒绝 ${code}`:rows.map((q,i)=>`${rows.length>1?`${i+1}. `:''}${plain(q.question,650)}${q.options?.length?'\n'+q.options.map((o,n)=>`${n+1}) ${o.label}`).join('\n'):''}`).join('\n\n')+`\n\n回复 ${code}：${rows.length===1?'选项编号或你的回答':'1=第一题回答；2=第二题回答'}${rows.length===1?'\n当前只有这一问时，也可直接回复选项编号或文字。':''}`;
  void (async()=>{try{const sent=await sendNotice({scope:claim.scope,code,text:`正在处理：${label}\n\n${body}`,authorize:()=>(valid(claim)||item.continued&&validContinued(item))&&pending.get(code)===item&&(item.continued||!item.signal?.aborted)&&now()<item.expiresAt});if(!pending.has(code))return;if(!(valid(claim)||item.continued&&validContinued(item))||!['api_accepted','reported_sent'].includes(sent?.status))throw unavailable();item.delivered=true;}catch{finish(item,kind==='approval'?'unavailable':undefined,kind==='question'?unavailable():undefined);}})();
  return result;
 }
 function answer(rows,value){
  const parts=rows.length===1?[value]:value.split(/[;；\n]+/).map(v=>v.trim()).filter(Boolean);
  if(parts.length!==rows.length)return null;
  const answers=[];
  for(let i=0;i<rows.length;i++){
   const q=rows[i],raw=rows.length===1?parts[i]:parts.find(v=>new RegExp(`^${i+1}\\s*[=:：]`).test(v))?.replace(/^\d+\s*[=:：]\s*/,'');
   if(!raw?.trim()||raw.length>2000)return null;
   const values=q.multiSelect?raw.split(/[,，、]+/).map(v=>v.trim()):[raw.trim()],selected=[];let custom;
   for(const value of values){const match=/^[1-8]$/.test(value)?q.options?.[Number(value)-1]:q.options?.find(o=>o.label===value);if(match){if(selected.includes(match.label))return null;selected.push(match.label);}else if(values.length===1&&(!q.options?.length||!/^\d+$/.test(value)))custom=value;else return null;}
   answers.push({id:q.id,selected,...(custom?{custom}:{})});
  }
  return{answers};
 }
 async function handle({personId,route,text}={}){
  if(closed||typeof text!=='string'||text.length>4000)return null;
  const own=claim=>claim.scope?.personId===personId&&sameRoute(claim.scope.route,route);
  const value=text.trim().replace(/[。！!？?]+$/,'').trim();
  const explicit=value.match(/^(同意本次|拒绝|回复)\s+([A-Fa-f0-9]{6})(?:\s*[：:]\s*([\s\S]+))?$/);
  let item=explicit?pending.get(explicit[2].toUpperCase()):null;
  const list=[...pending.values()].filter(row=>own(row.claim));
  if(!explicit&&list.length===1&&list[0].kind==='question')item=list[0];
  const control=value.match(/^(?:请|帮我)?(停止(?:当前任务|这项任务)?|停一下|停下|别做了|现在到哪了|任务状态|当前任务状态|处理到哪了|进度呢)(?:[：:\s]+(.+))?$/);
  const stop=control&&/^(?:停止|停一下|停下|别做了)/.test(control[1]),status=control&&!stop,selector=control?.[2]?.trim();
  if(stop||status){
   const owned=[...claims.values()].filter(own);const replyCurrent=claim=>{try{const active=claims.get(claim.agent.id);return !closed&&!claim.stopped&&!claim.mixed&&(!active||active===claim||active.ended)&&getAgent(claim.agent.id)===claim.agent&&claim.scope.authorize()===true&&[...replies.values()].includes(claim);}catch{return false;}};const canControl=claim=>valid(claim)||replyCurrent(claim)||[...pending.values()].some(item=>item.claim===claim&&item.continued&&validContinued(item));let active=owned.filter(canControl);
   if(selector)active=active.filter(claim=>claim.scope.label===selector);
   else if(active.filter(claim=>claim.scope.kind==='project').length===1){const project=active.find(claim=>claim.scope.kind==='project');active=active.filter(claim=>claim===project||claim.agent.id!==project.scope.originSessionId);}
   if(active.length>1)return{reply:'同时有多项任务在处理：'+active.map(claim=>plain(claim.scope.label,100)).join('；')+'。请说“'+(stop?'停止':'任务状态')+'：项目名称”。'};
   if(active.length!==1)return selector?{reply:'没有找到这个名称对应的当前任务，没有取消其他会话。'}:owned.length?{reply:'当前任务身份或连接已改变，请核对原任务；没有取消其他会话。'}:null;
   const claim=active[0];
   if(status)return{reply:`正在处理：${plain(claim.scope.label,100)}\n${list.length?'等你回答刚才的问题或确认。':'电脑仍在处理。'}你可以补充要求，也可以说“停一下”。`};
   const inbox=claim.agent.inbox;
   if(!Array.isArray(inbox?.nextTurn)||!Array.isArray(inbox?.nextStep)||typeof claim.agent.cancel!=='function')return{reply:'当前宿主无法安全停止这项任务，请在原会话核对。'};
   const queued=[...inbox.nextTurn,...inbox.nextStep];
   if(queued.some(message=>{try{if(message.source?.kind==='user-question-reply')return replies.get(JSON.stringify([claim.agent.id,message.source.callId]))!==claim||!replyCurrent(claim);const scope=resolveTask(claim.agent.id,message.source?.rpcId??message.id);return message.source?.kind!=='user'||!scope||scope.personId!==personId||!sameRoute(scope.route,route)||scope.authorize()!==true;}catch{return true;}}))return{reply:'这段会话还排有其他来源的输入，请在电脑核对；没有取消其他任务。'};
   // All checks are synchronous with Agent.cancel, so another turn cannot
   // enter between the ownership check and the session-level operation.
   if(!canControl(claim))return{reply:'当前任务身份已改变，没有停止其他任务。'};
   claim.agent.cancel({kind:'user'});withdraw(claim);claim.stopped=true;
   return{reply:'已请求停止当前任务，并清除这段会话尚未执行的输入。已保存或发出的内容会保留。'};
  }
  if(explicit&&(!item||!own(item.claim)))return{reply:'这条确认已处理或已过期，没有执行新的操作。'};
  if(!item||!own(item.claim))return null;
  if(item.continued?!validContinued(item):!valid(item.claim)||item.signal?.aborted){finish(item,item.kind==='approval'?'unavailable':undefined,item.kind==='question'?unavailable():undefined);return{reply:'任务身份或连接已改变，这条确认已失效。'};}
  if(now()>=item.expiresAt){finish(item,item.kind==='approval'?'unavailable':undefined,item.kind==='question'?Error('mobile question expired'):undefined);return{reply:'这条问题已过期，没有继续执行。'};}
  if(!item.delivered)return{reply:'这条问题的投递尚未确认，请稍后核对；没有继续执行。'};
  if(item.kind==='approval'){
   if(!explicit||!['同意本次','拒绝'].includes(explicit[1])||explicit[3])return null;
   const accepted=explicit[1]==='同意本次';finish(item,accepted?'allowed-once':'rejected');return{taskId:item.claim.scope.taskId,reply:accepted?'已同意本次操作，原任务继续处理。':'已拒绝本次操作。'};
  }
  if(explicit&&explicit[1]!=='回复')return{reply:'这是补充信息的问题，请回复问题编号和答案。'};
  const result=answer(item.rows,explicit?explicit[3]??'':text.trim());
  if(!result)return{reply:'答案还不能对应刚才的问题，请按选项编号或题号回复。'};
  if(item.continued){
   const inbox=item.claim.agent.inbox;
   if(!Array.isArray(inbox?.nextTurn)||!Array.isArray(inbox?.nextStep)||[...inbox.nextTurn,...inbox.nextStep].some(message=>!contexts.has(message.source?.kind)))return{reply:'原会话还排有其他输入，请先核对这项任务；没有把答案送入其他执行。'};
   replies.set(JSON.stringify([item.claim.agent.id,item.callId]),item.claim);
   try{if(answerContinued(item.claim.agent,item.callId,result)!==true)throw unavailable();}catch{replies.delete(JSON.stringify([item.claim.agent.id,item.callId]));finish(item,undefined,unavailable());return{reply:'原问题已失效，没有开始新的任务。'};}
  }
  finish(item,result);return{taskId:item.claim.scope.taskId,reply:'已收到补充信息，原任务继续处理。'};
 }
 return Object.freeze({claimed,ended,releaseAgent(agent){const claim=claims.get(agent?.id);if(claim?.agent===agent){withdraw(claim);claims.delete(agent.id);}},hasPendingTask:id=>[...pending.values()].some(item=>item.claim.scope.taskId===id),question:(request,next)=>wait('question',request,next),approval:(request,next)=>wait('approval',request,next),handle,close(){closed=true;for(const claim of claims.values())withdraw(claim);claims.clear();replies.clear();}});
}

/** Use official scoped waterfalls; never shadow tools or widen their ACL. */
export function installOwnerMobileControl({ctx,...options}={}){
 const getAgent=id=>ctx.get('agents',false)?.get?.(id),broker=createOwnerMobileControl({...options,getAgent,isContinued:(agent,callId)=>ctx.get('userQuestions',false)?.continued?.(agent)?.some(row=>row.callId===callId)===true,answerContinued:(agent,callId,answer)=>ctx.get('userQuestions',false)?.answer?.(agent,callId,answer)===true}),scopes=new Map(),disposers=[];
 function attach(agent){
  if(typeof agent?.id!=='string'||!agent.ctx?.on||scopes.has(agent))return;
  const off=[agent.ctx.on('approval/request',(request,next)=>broker.approval(request,next),{prepend:true}),agent.ctx.on('user-questions/request',(request,next)=>broker.question(request,next),{prepend:true})];
  scopes.set(agent,off);
 }
 function detach(agent){const off=scopes.get(agent);if(!off)return;scopes.delete(agent);for(const dispose of off)dispose();broker.releaseAgent(agent);}
 if(typeof ctx.on==='function'){
  disposers.push(ctx.on('agent/inbox/claimed',event=>broker.claimed(event)),ctx.on('session/event',(session,event)=>{if(event?.type==='turn/end')broker.ended({sessionId:session?.id,turn:event.data?.turn});}),ctx.on('agent/created',({agent}={})=>attach(agent)),ctx.on('agent/disposed',({agent}={})=>detach(agent)));
  for(const agent of ctx.get('agents',false)?.list?.()??[])attach(agent);
 }
 return Object.freeze({...broker,async close(){broker.close();for(const off of disposers)off();for(const agent of [...scopes.keys()])detach(agent);}});
}
