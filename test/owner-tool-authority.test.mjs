import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';
import {createHarnessGateway} from '../src/harness-gateway.mjs';

const conversationId='cc000000-0000-4000-8000-000000000001';
const denied=error=>error?.code==='gateway_owner_tool_forbidden';
function observation(intent,patch={}){
 return{workspaceId:intent.workspaceId,sessionId:intent.sessionId,requestId:intent.requestId,cwd:intent.cwd,state:'running',requestSeen:true,queued:false,foreign:false,turn:3,activeTurn:3,activeRequestIds:[intent.requestId],events:[{type:'tool/call',seq:12,turn:3,name:'family_assistant',callId:'current-call',status:'running'}],...patch};
}
function fixture(t,{start,observe}={}){
 const directory=mkdtempSync(join(tmpdir(),'owner-tool-authority-synthetic-')),store=createStore({directory:join(directory,'store')}),intents=[],observed=[];
 for(const[id,role]of[['owner','owner'],['member','elder']]){store.addPerson({id,role,label:id});store.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id});}store.configure({paused:false});
 const ownerAgent={listWorkspaces:async()=>[{workspaceId:'control',title:'Owner',path:join(directory,'control'),sessionIds:[]}],start:async intent=>{intents.push(structuredClone(intent));return start?start(intent):{state:'running'};},observe:async(intent,options)=>{observed.push(structuredClone(intent));return observe?observe(intent,options):observation(intent);}};
 const gateway=createHarnessGateway({directory,store,ownerAgent,recoverOnCreate:false}),request=patch=>({personId:'owner',route:store.route('owner'),workspaceId:'control',prompt:'内部说明\n\n当前 Owner 请求原文：\n查看成员最近的聊天记录',requestId:'source-current',conversationId,...patch});
 const submit=async patch=>{const task=await gateway.submit(request(patch));await gateway.settled();return task;};
 const context=(patch={})=>gateway.ownerToolContext({personId:'owner',sessionId:'family_owner_'+conversationId,callId:'current-call',...patch});
 t.after(async()=>{await gateway.close();rmSync(directory,{recursive:true,force:true});});
 return{directory,store,gateway,ownerAgent,intents,observed,request,submit,context};
}

test('a current native tool call returns only its registered Owner request context',async t=>{
 const f=fixture(t),task=await f.submit();assert.equal(typeof f.gateway.ownerToolContext,'function');
 const context=await f.context();assert.equal(context.taskId,task.id);assert.equal(context.requestId,task.requestId);assert.equal(context.sourceRequestId,'source-current');assert.equal(context.previousSourceRequestId,null);assert.equal(context.previousUserText,null);assert.equal(context.personId,'owner');assert.equal(context.origin,'wechat');assert.deepEqual(context.route,f.store.route('owner'));assert.equal(context.userText,'查看成员最近的聊天记录');assert.equal(context.deliveryTarget,undefined);assert.equal(context.authorize(),true);assert.equal(f.observed.length,1);
 context.route.peerId='mutated';assert.equal(context.authorize(),true,'returned values cannot mutate the authority anchor');
});

test('a running PTC dispatch can supply the same exact tool call proof',async t=>{
 const f=fixture(t,{observe:intent=>observation(intent,{events:[{type:'tool/ptc-dispatch-start',seq:12,turn:3,callId:'current-call',status:'running'}]})});await f.submit();assert.equal((await f.context()).authorize(),true);
});

test('a later queued Owner request never replaces the request which owns the active tool call',async t=>{
 const f=fixture(t,{start:intent=>({state:intent.sourceRequestId==='source-later'?'queued':'running'}),observe:intent=>intent.sourceRequestId==='source-later'?observation(intent,{state:'queued',requestSeen:false,queued:true,activeRequestIds:[f.intents[0].requestId],events:[]}):observation(intent)}),first=await f.submit();await f.submit({requestId:'source-later',prompt:'当前 Owner 请求原文：\n给成员发另一条消息'});
 const context=await f.context();assert.equal(context.taskId,first.id);assert.equal(context.sourceRequestId,'source-current');assert.equal(context.userText,'查看成员最近的聊天记录');assert.equal(f.observed.length,2);
});

test('a tool executing before start returns can prove its running request despite a queued ledger',async t=>{
 let resolved;const result=new Promise(resolve=>resolved=resolve);let f;
 f=fixture(t,{start:async()=>{try{resolved(await f.context());}catch(error){resolved(error);}return{state:'running'};}});const task=await f.submit(),context=await result;assert.equal(context.taskId,task.id);assert.equal(context.requestId,task.requestId);
});

test('confirmation receives only the immediate preceding request in this exact native session',async t=>{
 const f=fixture(t,{start:intent=>({state:intent.sourceRequestId==='source-current'?'succeeded':'running'}),observe:intent=>observation(intent)});await f.submit();await f.submit({requestId:'source-other-entry',conversationId:'cc000000-0000-4000-8000-000000000002',prompt:'当前 Owner 请求原文：\n无关会话的旧草稿'});const task=await f.submit({requestId:'source-confirm',prompt:'当前 Owner 请求原文：\n确认发送'});
 const context=await f.context();assert.equal(context.taskId,task.id);assert.equal(context.previousSourceRequestId,'source-current');assert.equal(context.previousUserText,'查看成员最近的聊天记录');assert.equal(context.userText,'确认发送');
});

for(const[kind,patch]of[
 ['unseen request',{requestSeen:false}],['queued request',{state:'queued',queued:true}],['foreign same-turn input',{foreign:true}],['another active request',{activeRequestIds:['another-request']}],['multiple active requests',{activeRequestIds:['another-request','placeholder']}],['missing active ownership',{activeRequestIds:[]}],['ended turn',{activeTurn:null}],['different active turn',{activeTurn:4}],['completed request',{state:'succeeded'}],['wrong session',{sessionId:'family_owner_forged'}],['wrong workspace',{workspaceId:'other'}],['wrong directory',{cwd:'/unrelated'}],['wrong request',{requestId:'another-request'}],['missing tool proof',{events:[]}],['another tool call',{events:[{type:'tool/call',turn:3,callId:'other-call',status:'running'}]}],['past tool result',{events:[{type:'tool/result',turn:3,callId:'current-call',status:'completed'}]}],['finished tool call',{events:[{type:'tool/call',turn:3,callId:'current-call',status:'completed'}]}],['tool call from another turn',{events:[{type:'tool/call',turn:2,callId:'current-call',status:'running'}]}],['missing ownership fields',{requestSeen:undefined,foreign:undefined,activeRequestIds:undefined}],
])test(`Owner authority rejects ${kind}`,async t=>{
 const f=fixture(t,{observe:intent=>observation(intent,patch)});await f.submit();await assert.rejects(()=>f.context(),denied);
});

test('overlapping native RPCs in one live turn cannot authorize either request',async t=>{
 const f=fixture(t,{observe:intent=>observation(intent,{activeRequestIds:f.intents.map(row=>row.requestId),foreign:true})});await f.submit();await f.submit({requestId:'source-second'});await assert.rejects(()=>f.context(),denied);
});

test('session prefixes and member identity cannot create Owner tool authority',async t=>{
 const f=fixture(t);await f.submit();await assert.rejects(()=>f.context({personId:'member'}),denied);await assert.rejects(()=>f.context({personId:'unknown'}),denied);await assert.rejects(()=>f.context({sessionId:'family_owner_cc000000-0000-4000-8000-000000000099'}),denied);assert.equal(f.observed.length,0);
});

test('an old Owner binding cannot be observed or retain an existing tool authority',async t=>{
 const f=fixture(t);await f.submit();const context=await f.context();f.store.bindPerson('owner',{accountId:'replacement-account',peerId:'replacement-peer'});assert.equal(context.authorize(),false);const before=f.observed.length;await assert.rejects(()=>f.context(),denied);assert.equal(f.observed.length,before);
});

test('a binding change while reading native proof prevents returning authority',async t=>{
 let f;f=fixture(t,{observe:async intent=>{f.store.bindPerson('owner',{accountId:'replacement-account',peerId:'replacement-peer'});return observation(intent);}});await f.submit();await assert.rejects(()=>f.context(),denied);
});

test('the authority expires after its task finishes, service pauses, or request signal aborts',async t=>{
 const f=fixture(t),task=await f.submit(),controller=new AbortController(),context=await f.context({signal:controller.signal});controller.abort();assert.equal(context.authorize(),false);
 const active=await f.context();f.store.configure({paused:true});assert.equal(active.authorize(),false);f.store.configure({paused:false});f.ownerAgent.observe=async()=>({state:'succeeded',text:'finished'});await f.gateway.check({personId:'owner',taskId:task.id});assert.equal(active.authorize(),false);await assert.rejects(()=>f.context(),denied);
});

test('native proof failures and cancellation fail closed without changing the task or dispatching again',async t=>{
 const f=fixture(t,{observe:async()=>{throw Error('synthetic observation unavailable');}});await f.submit();const before=f.gateway.snapshotForOwner();await assert.rejects(()=>f.context(),denied);assert.deepEqual(f.gateway.snapshotForOwner(),before);assert.equal(f.intents.length,1);
 const controller=new AbortController();controller.abort();await assert.rejects(()=>f.context({signal:controller.signal}));assert.equal(f.observed.length,1);
});

test('an unrelated historical unknown request with an unreadable anchor cannot block the current native tool call',async t=>{
 const f=fixture(t,{start:intent=>({state:intent.sourceRequestId==='source-old-unknown'?'unknown':'running'}),observe:intent=>{
  if(intent.sourceRequestId==='source-old-unknown')throw Object.assign(new Error('synthetic old anchor is outside bounded history'),{code:'owner_agent_history_incomplete'});
  return observation(intent);
 }});
 const old=await f.submit({requestId:'source-old-unknown',prompt:'当前 Owner 请求原文：\n历史中断请求'}),active=await f.submit(),context=await f.context();
 assert.equal(context.taskId,active.id);assert.equal(context.sourceRequestId,'source-current');assert.equal(context.authorize(),true);
 assert.deepEqual(f.observed.map(intent=>intent.requestId),[active.requestId]);assert.equal(f.gateway.snapshotForOwner().find(task=>task.id===old.id).state,'unknown','authorization must not rewrite historical task state');
});

test('a newest queued probe identifies the active request without observing unrelated historical unknown tasks',async t=>{
 let active;
 const f=fixture(t,{start:intent=>({state:intent.sourceRequestId==='source-old-unknown'?'unknown':intent.sourceRequestId==='source-later'?'queued':'running'}),observe:intent=>{
  if(intent.sourceRequestId==='source-old-unknown')throw Object.assign(new Error('synthetic old anchor is outside bounded history'),{code:'owner_agent_history_incomplete'});
  return intent.sourceRequestId==='source-later'?observation(intent,{state:'queued',requestSeen:false,queued:true,turn:null,activeTurn:3,activeRequestIds:[active.requestId],events:[]}):observation(intent);
 }});
 const old=await f.submit({requestId:'source-old-unknown',prompt:'当前 Owner 请求原文：\n历史中断请求'});active=await f.submit();const queued=await f.submit({requestId:'source-later',prompt:'当前 Owner 请求原文：\n后续排队中的发送要求'}),context=await f.context();
 assert.equal(context.taskId,active.id);assert.equal(context.sourceRequestId,'source-current');assert.equal(context.userText,'查看成员最近的聊天记录');assert.equal(context.authorize(),true);
 assert.deepEqual(f.observed.map(intent=>intent.requestId),[queued.requestId,active.requestId]);assert.equal(f.gateway.snapshotForOwner().find(task=>task.id===old.id).state,'unknown');
});

test('a latest probe with multiple active native RPCs is refused without selecting an older request',async t=>{
 const f=fixture(t,{observe:intent=>observation(intent,{activeRequestIds:f.intents.map(row=>row.requestId)})});await f.submit();const latest=await f.submit({requestId:'source-later'});await assert.rejects(()=>f.context(),denied);assert.deepEqual(f.observed.map(intent=>intent.requestId),[latest.requestId]);
});

test('a latest probe naming an unregistered active native RPC cannot fall back to a known request',async t=>{
 const f=fixture(t,{observe:intent=>observation(intent,{activeRequestIds:['dd000000-0000-4000-8000-000000000099']})});await f.submit();const latest=await f.submit({requestId:'source-later'});await assert.rejects(()=>f.context(),denied);assert.deepEqual(f.observed.map(intent=>intent.requestId),[latest.requestId]);
});

test('a precise active-request read which contradicts its latest probe cannot authorize a tool call',async t=>{
 let active,queued;
 const f=fixture(t,{start:intent=>({state:intent.sourceRequestId==='source-later'?'queued':'running'}),observe:intent=>intent.sourceRequestId==='source-later'?observation(intent,{state:'queued',requestSeen:false,queued:true,turn:null,activeRequestIds:[active.requestId],events:[]}):observation(intent,{activeRequestIds:[queued.requestId]})});
 active=await f.submit();queued=await f.submit({requestId:'source-later'});await assert.rejects(()=>f.context(),denied);assert.deepEqual(f.observed.map(intent=>intent.requestId),[queued.requestId,active.requestId]);
});

test('an unreadable latest probe fails closed rather than scanning older requests for an authorization',async t=>{
 const f=fixture(t,{observe:intent=>{if(intent.sourceRequestId==='source-later')throw Object.assign(new Error('synthetic probe cannot be verified'),{code:'owner_agent_history_incomplete'});return observation(intent);}});await f.submit();const latest=await f.submit({requestId:'source-later'});await assert.rejects(()=>f.context(),denied);assert.deepEqual(f.observed.map(intent=>intent.requestId),[latest.requestId]);
});
