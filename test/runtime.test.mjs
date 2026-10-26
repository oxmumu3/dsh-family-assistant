import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const load=()=>import('../src/runtime.mjs');
async function fixture(t,respond=async({person,text})=>({reply:`${person.label}：${text}`})){
  const directory=mkdtempSync(join(tmpdir(),'family-runtime-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const sent=[];
  const channelFactory=()=>({
    async connect(){},async disconnect(){},async close(){},
    status:()=>({status:'connected',phase:'connected'}),statuses:()=>({}),
    async send(route,text){sent.push({route,text});return{status:'api_accepted'};},
  });
  const {createRuntime}=await load();
  const runtime=createRuntime({directory,respond,channelFactory,intervalMs:60000});
  t.after(()=>runtime.close());
  for(const [id,role,label] of [['owner','owner','我'],['dad','elder','爸爸'],['mom','elder','妈妈']]){
    runtime.store.addPerson({id,role,label,shareWithOwner:'full'});
    runtime.store.bindPerson(id,{accountId:`bot-${id}`,peerId:`wx-${id}`});
  }
  await runtime.start();return{runtime,sent,directory};
}

test('three people keep independent histories and outbound recipient routes',async t=>{
  const calls=[];
  const {runtime,sent}=await fixture(t,async input=>{calls.push(input);return{reply:`收到 ${input.text}`};});
  await Promise.all([
    runtime.receive('dad',{id:'same-message-id',peerId:'wx-dad',text:'我喜欢历史'}),
    runtime.receive('mom',{id:'same-message-id',peerId:'wx-mom',text:'我喜欢园艺'}),
  ]);
  assert.equal(sent.length,2);
  assert.deepEqual(new Set(sent.map(x=>x.route.peerId)),new Set(['wx-dad','wx-mom']));
  assert(calls.find(x=>x.person.id==='dad').history.every(x=>x.personId==='dad'));
  assert(!JSON.stringify(calls.find(x=>x.person.id==='dad')).includes('园艺'));
  assert(!JSON.stringify(calls.find(x=>x.person.id==='mom')).includes('历史'));
});

test('foreign peers and duplicate messages cannot trigger model or sends',async t=>{
  let calls=0;const {runtime,sent}=await fixture(t,async()=>{calls++;return{reply:'收到'};});
  await runtime.receive('dad',{id:'1',peerId:'foreign',text:'冒充爸爸'});
  await runtime.receive('dad',{id:'2',peerId:'wx-dad',text:'你好'});
  await runtime.receive('dad',{id:'2',peerId:'wx-dad',text:'你好'});
  assert.equal(calls,1);assert.equal(sent.length,1);
});

test('a route changed while model is running never sends to the new peer',async t=>{
  let release;const ready=new Promise(resolve=>release=resolve);
  const {runtime,sent}=await fixture(t,async()=>{await ready;return{reply:'旧会话回答'};});
  const pending=runtime.receive('dad',{id:'a',peerId:'wx-dad',text:'慢一点回答'});
  await new Promise(resolve=>setImmediate(resolve));
  runtime.store.bindPerson('dad',{accountId:'replacement',peerId:'new-peer'});
  release();await pending;assert.equal(sent.length,0);
});

test('pause during a model call prevents outbound dispatch',async t=>{
  let release;const ready=new Promise(resolve=>release=resolve);
  const {runtime,sent}=await fixture(t,async()=>{await ready;return{reply:'回答'};});
  const pending=runtime.receive('mom',{id:'a',peerId:'wx-mom',text:'你好'});
  await new Promise(resolve=>setImmediate(resolve));
  await runtime.action({action:'pause'});release();await pending;
  assert.equal(sent.length,0);
});

test('owner brief sends exclusively to owner, even after elder activity',async t=>{
  const {runtime,sent}=await fixture(t);
  await runtime.receive('dad',{id:'a',peerId:'wx-dad',text:'你好'});
  const before=sent.length;
  await runtime.action({action:'send_brief'});
  assert.equal(sent.length,before+1);
  assert.equal(sent.at(-1).route.personId,'owner');
});

test('model actions can add reminders only for current person',async t=>{
  const {runtime}=await fixture(t,async()=>({reply:'will set',action:{type:'remind',text:'散步',dueAt:new Date(Date.now()+3600000).toISOString(),repeat:'once',personId:'mom'}}));
  await runtime.receive('dad',{id:'a',peerId:'wx-dad',text:'一小时后提醒我散步'});
  assert.equal(runtime.store.reminders('mom').length,0);
  // Unknown model fields must fail closed, never gain an alternate destination.
  assert.equal(runtime.store.reminders('dad').length,0);
});

test('single data directory cannot have two active runtime owners',async t=>{
  const {directory}=await fixture(t);const {createRuntime}=await load();
  assert.throws(()=>createRuntime({directory}),/正在|占用|locked|运行/i);
});

test('unknown send outcomes are not automatically retried',async t=>{
  const {runtime}=await fixture(t);let attempts=0;
  runtime.channels.send=async()=>{attempts++;throw Object.assign(new Error('network timeout'),{sendOutcome:'uncertain'});};
  await runtime.receive('dad',{id:'a',peerId:'wx-dad',text:'你好'});
  await runtime.tick();await runtime.tick();
  assert.equal(attempts,1);
  assert.equal(runtime.store.snapshot().outbox.at(-1).status,'uncertain');
});

test('trusted Owner sees saved messages while outbox bodies stay outside the status projection',async t=>{
  const {runtime}=await fixture(t);
  runtime.store.updatePerson('dad',{shareWithOwner:'none'});
  await runtime.receive('dad',{id:'secret',peerId:'wx-dad',text:'未分享的私人内容'});
  const snapshot=runtime.status({personId:'dad'});
  assert(snapshot.messages.some(row=>row.text==='未分享的私人内容'));
  assert(snapshot.outbox.every(row=>!Object.hasOwn(row,'text')));
});

test('revoking sharing invalidates cached owner brief preview',async t=>{
  const {runtime}=await fixture(t);
  await runtime.receive('dad',{id:'private',peerId:'wx-dad',text:'爸爸的私人原文'});
  await runtime.action({action:'preview_brief'});
  runtime.store.updatePerson('dad',{shareWithOwner:'none'});
  assert.equal(runtime.status().lastBrief,null);
});

test('inbound during paused setup is archived without model calls or sends',async t=>{
  let calls=0;const {runtime,sent}=await fixture(t,async()=>{calls++;return{reply:'hello'};});
  await runtime.action({action:'pause'});
  await runtime.receive('dad',{id:'setup',peerId:'wx-dad',text:'刚扫码，您好'});
  assert.equal(runtime.store.messages('dad').filter(x=>x.dir==='in').length,1);
  assert.equal(calls,0);assert.equal(sent.length,0);
});

test('owner brief can summarize shared topics without using unshared elder records',async t=>{
  const calls=[];const{runtime}=await fixture(t,async input=>{calls.push(input);return{reply:'今天主要聊了园艺。'};});
  runtime.store.updatePerson('dad',{shareWithOwner:'none'});
  runtime.store.addMessage('dad',{dir:'in',text:'不能分享的私人细节'});
  runtime.store.addMessage('mom',{dir:'in',text:'园艺怎么浇水'});
  const view=await runtime.action({action:'preview_brief'});
  assert.match(view.lastBrief.text,/园艺/);
  const input=calls.find(x=>x.person.role==='owner');assert(input);
  assert(!JSON.stringify(input).includes('不能分享的私人细节'));
});

test('manual owner brief never follows a replacement binding while model awaits',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const{runtime,sent}=await fixture(t,async()=>{await gate;return{reply:'今天聊了园艺'};});
  runtime.store.addMessage('mom',{dir:'in',text:'园艺'});
  const pending=runtime.action({action:'send_brief'});
  await new Promise(resolve=>setImmediate(resolve));
  runtime.store.bindPerson('owner',{accountId:'new-owner-bot',peerId:'replacement'});
  release();await assert.rejects(pending,/绑定|暂停|改变/);assert.equal(sent.length,0);
  assert.equal(runtime.store.pending().length,0);
});

test('Owner history composer sends an attributed message once to the captured family binding',async t=>{
 const {runtime,sent}=await fixture(t),request={action:'owner_send_message',personId:'mom',text:'周末一起吃饭吧',requestId:'history-message-one',bindingGeneration:1};
 const values=await Promise.all([runtime.action(request),runtime.action(request)]);
 assert.equal(sent.length,1);assert.equal(sent[0].route.personId,'mom');assert.equal(sent[0].text,'家庭联系人通过乐乐转达：\n周末一起吃饭吧');assert(values.every(value=>value.status==='api_accepted'));
 assert.equal(runtime.store.messages('mom').filter(row=>row.kind==='owner_message').length,1);
 assert.equal(runtime.status().people.find(row=>row.id==='mom').binding.generation,1);
 await assert.rejects(()=>runtime.action({...request,text:'换一段内容'}),/已用于|冲突/);
 assert.equal(sent.length,1);
});
test('Owner history composer refuses stale binding, paused service and missing message identity',async t=>{
 const {runtime,sent}=await fixture(t),request={action:'owner_send_message',personId:'mom',text:'别忘了带伞',requestId:'history-message-two',bindingGeneration:1};
 runtime.store.bindPerson('mom',{accountId:'replacement',peerId:'replacement-peer'});
 await assert.rejects(()=>runtime.action(request),/绑定|连接/);
 await assert.rejects(()=>runtime.action({...request,personId:'dad',requestId:undefined}),/标识|参数/);
 await runtime.action({action:'pause'});await assert.rejects(()=>runtime.action({...request,personId:'dad'}),/暂停/);assert.equal(sent.length,0);
});
test('Owner history composer keeps an uncertain attempt durable and never sends it again',async t=>{
 const {runtime}=await fixture(t);let calls=0;runtime.channels.send=async()=>{calls++;throw Object.assign(new Error('connection lost'),{sendOutcome:'uncertain'});};
 const request={action:'owner_send_message',personId:'mom',text:'看到以后回我',requestId:'history-message-unknown',bindingGeneration:1};
 assert.equal((await runtime.action(request)).status,'uncertain');assert.equal((await runtime.action(request)).status,'uncertain');assert.equal(calls,1);assert.equal(runtime.store.messages('mom').filter(row=>row.kind==='owner_message').length,0);
});

test('Owner composer sends without waiting for a family model response',async t=>{
 let release;const wait=new Promise(resolve=>release=resolve);const {runtime,sent}=await fixture(t,async()=>{await wait;return{reply:'模型稍后回答'};});
 const incoming=runtime.receive('mom',{id:'family-model-wait',peerId:'wx-mom',text:'你好'});await new Promise(resolve=>setImmediate(resolve));
 const outgoing=runtime.action({action:'owner_send_message',personId:'mom',text:'我先说一句',requestId:'direct-owner-message',bindingGeneration:1});
 const first=await Promise.race([outgoing,new Promise(resolve=>setTimeout(()=>resolve('blocked-by-model'),180))]);release();await Promise.all([incoming,outgoing]);
 assert.notEqual(first,'blocked-by-model');assert.equal(first.status,'api_accepted');assert.equal(sent[0].text,'家庭联系人通过乐乐转达：\n我先说一句');
});
test('queued Owner messages cannot follow a replacement binding',async t=>{
 const {runtime}=await fixture(t);let release;const wait=new Promise(resolve=>release=resolve),routes=[];
 runtime.channels.send=async(route,_text,options)=>{routes.push(route);await wait;if(!options.authorize())throw Object.assign(new Error('binding changed'),{sendOutcome:'failed'});return{status:'api_accepted'};};
 const request={action:'owner_send_message',personId:'mom',text:'第一条',requestId:'queued-owner-first',bindingGeneration:1};const first=runtime.action(request);await new Promise(resolve=>setImmediate(resolve));
 const second=runtime.action({...request,text:'第二条',requestId:'queued-owner-second'}),refused=assert.rejects(second,/绑定/);runtime.store.bindPerson('mom',{accountId:'new-account',peerId:'new-peer'});release();await Promise.all([first,refused]);assert.equal(routes.length,1);assert.equal(routes[0].peerId,'wx-mom');
});
test('Owner uncertain message remains idempotent after runtime restart',async t=>{
 const {runtime,directory}=await fixture(t);let calls=0;runtime.channels.send=async()=>{calls++;throw Object.assign(new Error('lost acknowledgement'),{sendOutcome:'uncertain'});};
 const request={action:'owner_send_message',personId:'mom',text:'请核对这件事',requestId:'durable-owner-message',bindingGeneration:1};assert.equal((await runtime.action(request)).status,'uncertain');await runtime.close();
 const {createRuntime}=await load(),restored=createRuntime({directory,intervalMs:60000,channelFactory:()=>({connect:async()=>{},disconnect:async()=>{},close:async()=>{},status:()=>({status:'connected'}),send:async()=>{calls++;return{status:'api_accepted'};}})});t.after(()=>restored.close());await restored.start();
 assert.equal((await restored.action(request)).status,'uncertain');assert.equal(calls,1);assert.equal(restored.store.snapshot().outbox.filter(row=>row.kind==='owner_message').length,1);
});
