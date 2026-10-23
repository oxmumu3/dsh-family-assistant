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

test('workbench summary never exposes unshared message or outbox text',async t=>{
  const {runtime}=await fixture(t);
  runtime.store.updatePerson('dad',{shareWithOwner:'none'});
  await runtime.receive('dad',{id:'secret',peerId:'wx-dad',text:'未分享的私人内容'});
  const snapshot=runtime.status({personId:'dad'});
  assert(!JSON.stringify(snapshot).includes('未分享的私人内容'));
  assert.equal(snapshot.messages.length,0);
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
