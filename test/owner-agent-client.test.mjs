import test from 'node:test';
import assert from 'node:assert/strict';
import * as module from '../src/owner-agent-client.mjs';

const UUID='aa000000-0000-4000-8000-000000000001', REQUEST='bb000000-0000-4000-8000-000000000002';
const intent={workspaceId:'workspace',cwd:'/projects/daily',sessionId:`family_owner_${UUID}`,requestId:REQUEST,prompt:'读取这个项目说明，准备日报草稿。'};
const event=(seq,type,data)=>({type:'event',event:{seq,type,data}});
const turn=(requestId=REQUEST,text='已读取规则并准备草稿',ending='completed')=>[
 event(0,'turn/start',{turn:1}),event(1,'user/message',{source:{kind:'owner',rpcId:requestId}}),
 event(2,'assistant/message',{turn:1,message:{content:[{type:'text',text}]}}),...(ending?[event(3,'turn/end',{turn:1,reason:{kind:ending}})]:[])];
function fixture({records=[],exists=true,hasMore=false}={}){
 const calls=[],snapshot={type:'snapshot',header:{id:intent.sessionId,cwd:intent.cwd},records,hasMore,cursor:100,projections:{values:{}}};
 let member=exists,returned=0;
 const remote={
  workspace:{
   follow:()=>({async *[Symbol.asyncIterator](){try{yield{type:'baseline',value:{items:[{workspaceId:'workspace',path:intent.cwd,title:'日报',sessionIds:member?[intent.sessionId]:[]}]}};}finally{returned++;}}}),
   create:async input=>{calls.push(['workspace.create',input]);return{ok:true,value:{workspace:{workspaceId:'new',path:input.path,title:'新项目',sessionIds:[]},created:true}};},
  },
  directoryPicker:{pick:async()=>({ok:true,value:'/projects/new'})},
  session:{
   create:async input=>{calls.push(['create',input]);member=true;return{ok:true,value:{sessionId:input.sessionId}};},
   follow:()=>({async *[Symbol.asyncIterator](){try{yield snapshot;}finally{returned++;}}}),
   page:async()=>({ok:true,value:{records:[],hasMore:false}}),
   prompt:async input=>{calls.push(['prompt',input]);return{ok:true,value:{accepted:true}};},
   cancel:async input=>{calls.push(['cancel',input]);return{ok:true,value:{accepted:true}};},
  },
 };
 return{remote,calls,snapshot,get returned(){return returned;},client:module.createOwnerAgentClient({remote})};
}
test('lists registered workspaces from a bounded baseline and closes the stream',async()=>{
 const f=fixture();assert.deepEqual(await f.client.listWorkspaces(),[{workspaceId:'workspace',path:intent.cwd,title:'日报',sessionIds:[intent.sessionId]}]);assert.equal(f.returned,1);assert.equal(f.calls.length,0);
});
test('adds explicit Host path, native chooser cancel creates nothing, and relative path is refused',async()=>{
 const f=fixture();assert.equal((await f.client.addWorkspace('/projects/new')).workspaceId,'new');
 f.remote.directoryPicker.pick=async()=>({ok:true,value:null});assert.equal(await f.client.pickWorkspace(),null);assert.equal(f.calls.length,1);
 await assert.rejects(()=>f.client.addWorkspace('../private'),e=>e.code==='owner_agent_invalid_path');
});
test('creates a dedicated Owner session then admits exactly one stable request',async()=>{
 const f=fixture({exists:false}),result=await f.client.start(intent);
 assert.equal(result.state,'queued');assert.deepEqual(f.calls.map(c=>c[0]),['create','prompt']);
 assert.deepEqual(f.calls[0][1],{workspaceId:intent.workspaceId,sessionId:intent.sessionId});
 assert.deepEqual(f.calls[1][1],{sessionId:intent.sessionId,requestId:REQUEST,mode:'queue',content:[{type:'text',text:intent.prompt}]});
});
test('recovery observes the original request and never resubmits it',async()=>{
 const f=fixture({records:turn()}),result=await f.client.start(intent);assert.equal(result.state,'succeeded');assert.equal(result.text,'已读取规则并准备草稿');assert.equal(f.calls.length,0);
});
test('queued request is not submitted twice before a turn starts',async()=>{
 const f=fixture();f.snapshot.projections.values.inbox={'next-turn':[{source:{rpcId:REQUEST}}]};assert.equal((await f.client.start(intent)).state,'queued');assert.equal(f.calls.length,0);
});
test('mismatched workspace or host-created session identity never receives a prompt',async()=>{
 const f=fixture();await assert.rejects(()=>f.client.start({...intent,cwd:'/other'}),e=>e.code==='owner_agent_identity_mismatch');assert.equal(f.calls.length,0);
 const g=fixture({exists:false});g.remote.session.create=async()=>({ok:true,value:{sessionId:'unexpected'}});await assert.rejects(()=>g.client.start(intent),e=>e.code==='owner_agent_identity_mismatch');assert.equal(g.calls.length,0);
});
test('unfinished previous turn remains busy and incoming identifiers cannot select an arbitrary session',async()=>{
 const f=fixture({records:turn('old','previous',null)});await assert.rejects(()=>f.client.start(intent),e=>e.code==='owner_agent_busy');assert.equal(f.calls.length,0);
 await assert.rejects(()=>f.client.start({...intent,sessionId:'wechat_mom'}),e=>e.code==='owner_agent_invalid_intent');
});
test('history paging anchors original request before declaring a result',async()=>{
 const f=fixture({records:[event(5,'turn/start',{turn:2}),event(6,'user/message',{source:{rpcId:'other'}})],hasMore:true});let pages=0;
 f.remote.session.page=async request=>{pages++;assert.equal(request.beforeSeq,5);return{ok:true,value:{records:turn(),hasMore:false}};};
 const result=await f.client.observe(intent);assert.equal(result.state,'succeeded');assert.equal(result.text,'已读取规则并准备草稿');assert.equal(pages,1);
});
test('unresolved truncated history is unknown rather than a duplicate request',async()=>{
 const f=fixture({records:[event(50,'turn/start',{turn:4})],hasMore:true});await assert.rejects(()=>f.client.start(intent),e=>e.code==='owner_agent_history_incomplete');assert.equal(f.calls.length,0);
});
test('active approvals and user questions remain native Host interactions',async()=>{
 const f=fixture({records:turn(REQUEST,'正在处理',null)});f.snapshot.records.push(event(3,'approval/asked',{id:'approval'}));assert.equal((await f.client.observe(intent)).state,'needs_approval');assert.equal(f.calls.length,0);
 f.snapshot.records.push(event(4,'approval/decided',{id:'approval'}),event(5,'tool/call',{turn:1,callId:'question',name:'ask_user_question'}));f.snapshot.projections.values.userQuestions={active:[{callId:'question',state:'open'}]};assert.equal((await f.client.observe(intent)).state,'needs_input');
});
test('foreign user input in the same turn prevents attributing its output to this request',async()=>{
 const records=turn();records.splice(2,0,event(9,'user/message',{source:{kind:'owner',rpcId:'foreign'}}));records.at(-1).event.seq=10;
 const f=fixture({records}),result=await f.client.observe(intent);assert.equal(result.state,'unknown');assert.equal(result.text,'');
});
test('cancel verifies identity and delegates to native session without a non-CAS cancellation',async()=>{
 const f=fixture({records:turn(REQUEST,'processing',null)});assert.deepEqual(await f.client.cancel(intent),{requiresNativeSession:true});assert.deepEqual(f.calls,[]);
 const g=fixture({records:turn('other','processing',null)});assert.deepEqual(await g.client.cancel(intent),{requiresNativeSession:true});assert.equal(g.calls.length,0);
 await assert.rejects(()=>g.client.cancel({...intent,cwd:'/other'}),e=>e.code==='owner_agent_identity_mismatch');assert.equal(g.calls.length,0);
});
test('Remote failure is redacted and prompt admission timeout never retries',async()=>{
 const f=fixture();f.remote.session.prompt=async()=>{f.calls.push(['prompt']);return{ok:false,error:{message:'secret-token https://private'}};};await assert.rejects(()=>f.client.start(intent),e=>e.code==='owner_agent_remote_failed'&&!e.message.includes('secret'));assert.equal(f.calls.length,1);
 const g=fixture();g.remote.session.prompt=async()=>{g.calls.push(['prompt']);return new Promise(()=>{});};const client=module.createOwnerAgentClient({remote:g.remote,timeoutMs:20});await assert.rejects(()=>client.start(intent),e=>e.code==='owner_agent_unknown');assert.equal(g.calls.length,1);
});
test('a Remote exception cannot smuggle private diagnostics through a recognized error code',async()=>{
 const f=fixture();f.remote.session.prompt=async()=>{throw Object.assign(new Error('secret-token https://private'),{code:'owner_agent_remote_failed',cause:'secret'});};
 await assert.rejects(()=>f.client.start(intent),e=>{assert.equal(e.code,'owner_agent_remote_failed');assert.doesNotMatch(e.stack,/secret|https/);assert.equal(e.cause,undefined);return true;});
});
test('canceling admission wait reports unknown, without pretending the Host task was cancelled',async()=>{
 const f=fixture(),controller=new AbortController();
 f.remote.session.prompt=async()=>{f.calls.push(['prompt']);controller.abort();return new Promise(()=>{});};
 await assert.rejects(()=>f.client.start(intent,{signal:controller.signal}),e=>e.code==='owner_agent_unknown');assert.deepEqual(f.calls,[['prompt']]);
});
