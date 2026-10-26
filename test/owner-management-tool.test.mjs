import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';
import {createWorkbench} from '../src/workbench.mjs';

function setup(t){
  const directory=mkdtempSync(join(tmpdir(),'family-owner-tool-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const store=createStore({directory});store.addPerson({id:'owner',role:'owner',label:'我'});store.addPerson({id:'k',role:'elder',label:'K'});
  let output={reply:'已整理',operation:{type:'plan',actions:[{type:'send_message',personId:'k',text:'已根据资料整理的合成摘要'}]}};
  const executed=[],wb=createWorkbench({directory,store,plan:async()=>output,execute:async a=>{executed.push(a);return{status:'api_accepted'};}});
  return{store,wb,executed,set:value=>output=value};
}
test('Host project result becomes an idempotent family draft without dispatch',async t=>{
  const {wb,executed}=setup(t),input={text:'把合成摘要给K，先准备安排',requestId:'host-call-1',draftOnly:true};
  await wb.chat(input);await wb.chat(input);const state=wb.snapshot();
  assert.equal(state.cards.length,1);assert.equal(state.cards[0].actions[0].status,'draft');assert.equal(executed.length,0);
  await assert.rejects(wb.chat({...input,draftOnly:false}),/草稿|参数/);
});
test('Host draft helper cannot confirm/cancel or mutate an existing member through model output',async t=>{
  const {wb,store,executed,set}=setup(t);await wb.chat({text:'给K安排消息',requestId:'first',draftOnly:true});const card=wb.snapshot().cards[0];
  const operations=[{type:'confirm',cardId:card.id},{type:'cancel',cardId:card.id},{type:'profile',personId:'k',patch:{label:'被修改'} }];
  for(let i=0;i<operations.length;i++){set({reply:'准备完成',operation:operations[i]});await wb.chat({text:'确认安排',requestId:'restricted-'+i,draftOnly:true,contextId:i===2?undefined:'card:'+card.id});}
  assert.equal(executed.length,0);assert.equal(store.person('k').label,'K');assert.equal(wb.snapshot().cards[0].status,'draft');
  assert.match(wb.snapshot().messages.at(-1).text,/草稿/);
});
test('mounted Host tool exposes bounded member context and a draft action, never a send action',async t=>{
  const {apply}=await import('../index.js'),directory=mkdtempSync(join(tmpdir(),'family-mounted-tool-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const routes=[],tools=[];let requests=0;
  const services={connection:{fetch:{register(route){routes.push(route);return()=>{};}}},tools:{register(tool){tools.push(tool);}},llm:{listProviders:()=>[],async *stream(){requests++;yield{type:'text-delta',index:0,text:JSON.stringify({reply:'请核对',operation:{type:'plan',actions:[{type:'send_message',personId:memberId,text:'三条精选和七条摘要的合成内容'}]}})};yield{type:'finish',reason:'stop'};}}};
  const dispose=apply({get:name=>services[name],tools:services.tools,effect:fn=>fn()},{storageDir:directory});t.after(dispose);
  const invoke=async input=>{const response=await routes[0].fetch(new Request('http://dsh.internal/api/family/control',{method:'POST',headers:{'Content-Type':'application/json','X-Family-Action':'1'},body:JSON.stringify(input)}));assert.equal(response.status,200);return response.json();};
  await invoke({action:'add_person',role:'owner',label:'我'});let state=await invoke({action:'add_person',role:'elder',label:'K'});const memberId=state.people.find(p=>p.role==='elder').id;
  await invoke({action:'configure',provider:'synthetic',model:'fixture'});
  const exec={callId:'synthetic-tool-call',agent:{id:'synthetic-owner-session'},signal:new AbortController().signal};
  const status=await tools[0].execute({action:'status'},exec);assert.equal(status.people.find(p=>p.label==='K').id,memberId);
  assert.equal(status.people.some(p=>'peerId'in p||'history'in p||'token'in p),false);
  const args={action:'draft_management',text:'将合成的三条精选和七条摘要发给K。'};
  const first=await tools[0].execute(args,exec);const again=await tools[0].execute(args,exec);
  assert.equal(requests,1);assert.equal(first.cards.length,1);assert.deepEqual(again.cards,first.cards);assert.equal(first.cards[0].actions[0].status,'draft');assert.match(first.text,/确认/);
  const other=await tools[0].execute(args,{...exec,agent:{id:'second-owner-session'}});
  assert.equal(requests,2);assert.notEqual(other.requestId,first.requestId);assert.notEqual(other.cards[0].id,first.cards[0].id);
  assert.equal((await invoke({action:'preview_brief'})).outbox.length,0);
  await assert.rejects(tools[0].execute({action:'draft_management',text:'hi',send:true},exec),/操作|参数/);
  await assert.rejects(tools[0].execute(args,{signal:exec.signal}),/请求|标识/);
});
