import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';
import {createHostOwnerPlanner} from '../src/owner-commands.mjs';
import {createHostResponder} from '../src/model.mjs';

async function fixture(t,{planOwner,respond=async()=>({reply:'日报里的私人园艺建议'}),send,now='2026-10-22T12:00:00Z'}={}){
  const directory=mkdtempSync(join(tmpdir(),'family-owner-runtime-')),sent=[];
  const runtime=createRuntime({directory,planOwner,respond,now:()=>now,intervalMs:60000,channelFactory:()=>({
    async connect(){},async disconnect(){},async close(){},status:()=>({status:'connected'}),
    async send(route,text,options){if(options?.authorize&&!options.authorize())throw Object.assign(new Error('authorization changed'),{sendOutcome:'failed'});if(send)await send(route,text);sent.push({route,text});return{status:'api_accepted'};},
  })});
  t.after(async()=>{await runtime.close();rmSync(directory,{recursive:true,force:true});});
  for(const[id,role,label]of[['owner','owner','我'],['dad','elder','爸爸'],['mom','elder','妈妈']]){
    runtime.store.addPerson({id,role,label,timeZone:'Asia/Shanghai',shareWithOwner:'none'});
    runtime.store.bindPerson(id,{accountId:'bot-'+id,peerId:'wx-'+id});
  }
  await runtime.start();
  const receive=(text,id='command-1',personId='owner')=>runtime.receive(personId,{id,peerId:'wx-'+personId,text});
  return{runtime,sent,receive};
}
const daily={reply:'准备发送。',action:{type:'send_daily',target:'我妈'}};
const reminder={reply:'准备安排。',action:{type:'remind',target:'爸爸',text:'给花浇水',date:'2026-10-23',time:'08:00',repeat:'once',timeEvidence:'八点'}};

test('Owner manual daily targets only mom without enabling schedule or revealing private content',async t=>{
  let planned;
  const{runtime,sent,receive}=await fixture(t,{planOwner:async input=>{planned=input;return daily;}});
  runtime.store.updatePerson('mom',{notes:'不向Owner分享的私密偏好'});
  runtime.store.addMessage('mom',{dir:'in',text:'不向Owner分享的聊天内容'});
  await receive('给我妈发今天的日报');
  assert.deepEqual(sent.map(x=>x.route.personId),['mom','owner']);
  assert.match(sent[0].text,/私人园艺/);assert.doesNotMatch(sent[1].text,/私人园艺|私密偏好|聊天内容/);
  assert.doesNotMatch(JSON.stringify(planned),/私密偏好|聊天内容/);
  assert.equal(runtime.store.person('mom').dailyEnabled,false);
  const audit=runtime.status().ownerCommands;
  assert.equal(audit.length,1);assert.equal(audit[0].targetPersonId,'mom');assert.equal(audit[0].status,'api_accepted');
  assert.doesNotMatch(JSON.stringify(audit),/私人园艺|私密偏好|聊天内容|accountId|peerId/);
});

test('Owner reminder uses the selected elder timezone and records who requested it',async t=>{
  const{runtime,sent,receive}=await fixture(t,{planOwner:async()=>reminder});
  await receive('明早八点提醒爸爸给花浇水');
  const rows=runtime.store.reminders('dad');assert.equal(rows.length,1);assert.equal(rows[0].dueAt,'2026-10-23T00:00:00.000Z');
  assert.equal(rows[0].timeZone,'Asia/Shanghai');assert.equal(runtime.store.reminders('owner').length,0);assert.equal(runtime.store.reminders('mom').length,0);
  assert.equal(sent.length,1);assert.match(sent[0].text,/爸爸.*当地时间|当地时间.*爸爸/);
  const command=runtime.status().ownerCommands[0];assert.equal(command.requestedBy,'owner');assert.equal(command.status,'scheduled');assert.equal(command.resultId,rows[0].id);
});

test('elder cross-person request never calls the Owner planner or creates any reminder',async t=>{
  let plans=0,models=0;const{runtime,sent,receive}=await fixture(t,{planOwner:async()=>{plans++;return reminder;},respond:async()=>{models++;return{reply:'会安排',action:{type:'remind',text:'浇水',dueAt:'2026-10-23T00:00:00Z'}};}});
  await receive('明早八点提醒爸爸给花浇水','elder-1','mom');
  assert.equal(plans,0);assert.equal(models,0);assert.equal(runtime.store.snapshot().reminders.length,0);assert.match(sent[0].text,/Owner|管理人|接收人/);
});

test('missing explicit time, unknown person and duplicate aliases have no cross-person effects',async t=>{
  let plan={...reminder,action:{...reminder.action,timeEvidence:'八点'}};
  const{runtime,sent,receive}=await fixture(t,{planOwner:async()=>plan});
  await receive('提醒爸爸给花浇水','missing-time');
  assert.equal(runtime.store.snapshot().reminders.length,0);
  plan={...daily,action:{type:'send_daily',target:'奶奶'}};
  await receive('给奶奶发日报','unknown');
  runtime.store.addPerson({id:'mom2',role:'elder',label:'母亲',timeZone:'Asia/Shanghai'});
  plan=daily;await receive('给我妈发今天的日报','duplicate');
  assert.equal(sent.filter(x=>x.route.personId!=='owner').length,0);assert.equal(runtime.status().ownerCommands.length,0);
});

for(const changed of ['owner','mom','pause'])test(`Owner ${changed} route change while planning prevents cross-person effects`,async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const{runtime,sent,receive}=await fixture(t,{planOwner:async()=>{await gate;return daily;}});
  const pending=receive('给我妈发今天的日报');await new Promise(resolve=>setImmediate(resolve));
  if(changed==='pause')await runtime.stop();else runtime.store.bindPerson(changed,{accountId:'changed-bot',peerId:'changed-peer'});
  release();await pending;
  assert.equal(sent.filter(x=>x.route.personId==='mom').length,0);assert.equal(runtime.status().ownerCommands.length,0);
});

test('Owner rebind during daily generation cancels it rather than delivering to the elder',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const{runtime,sent,receive}=await fixture(t,{planOwner:async()=>daily,respond:async()=>{await gate;return{reply:'私人日报'};}});
  const pending=receive('给我妈发今天的日报');await new Promise(resolve=>setImmediate(resolve));
  runtime.store.bindPerson('owner',{accountId:'new-owner',peerId:'new-owner-peer'});release();await pending;
  assert.equal(sent.length,0);assert.equal(runtime.status().ownerCommands[0].status,'cancelled');
});

test('uncertain manual daily reports uncertainty and never automatically retries',async t=>{
  let attempts=0;const{runtime,sent,receive}=await fixture(t,{planOwner:async()=>daily,send:async route=>{if(route.personId==='mom'){attempts++;throw Object.assign(new Error('transport timeout'),{sendOutcome:'uncertain'});}}});
  await receive('给我妈发今天的日报');await runtime.tick();await runtime.tick();
  assert.equal(attempts,1);assert.equal(runtime.status().ownerCommands[0].status,'uncertain');assert.match(sent.at(-1).text,/不明|未知|未确认/);
});

for(const change of ['owner','pause'])test(`${change} change after a daily enters transport preserves an uncertain outcome`,async t=>{
  let rejectSend,attempts=0;const gate=new Promise((_,reject)=>rejectSend=reject);
  const{runtime,receive}=await fixture(t,{planOwner:async()=>daily,send:async route=>{if(route.personId==='mom'){attempts++;await gate;}}});
  const pending=receive('给我妈发今天的日报');
  while(!attempts)await new Promise(resolve=>setImmediate(resolve));
  if(change==='pause')await runtime.stop();else runtime.store.bindPerson('owner',{accountId:'replacement-owner',peerId:'replacement-owner-peer'});
  rejectSend(Object.assign(new Error('transport response unknown'),{sendOutcome:'uncertain'}));await pending;
  assert.equal(runtime.status().ownerCommands[0].status,'uncertain');
  assert.equal(runtime.store.snapshot().outbox.find(row=>row.kind==='manual_daily').status,'uncertain');
  await runtime.start();await runtime.tick();assert.equal(attempts,1);
});

test('duplicate Owner inbound executes one manual daily',async t=>{
  let plans=0;const{sent,receive}=await fixture(t,{planOwner:async()=>{plans++;return daily;}});
  await receive('给我妈发今天的日报');await receive('给我妈发今天的日报');
  assert.equal(plans,1);assert.equal(sent.filter(x=>x.route.personId==='mom').length,1);
});

test('pause cancels a manual daily queued behind another recipient operation',async t=>{
  let release,started=false;const gate=new Promise(resolve=>release=resolve);
  const{runtime,sent,receive}=await fixture(t,{planOwner:async()=>daily,respond:async()=>{started=true;await gate;return{reply:'日报'};}});
  runtime.store.enqueue({personId:'mom',text:'已有日报',kind:'daily',sourceKey:'existing-daily'});
  const ticking=runtime.tick();while(!started)await new Promise(resolve=>setImmediate(resolve));
  const pending=receive('给我妈发今天的日报');
  while(!runtime.store.ownerCommands().length)await new Promise(resolve=>setImmediate(resolve));
  await runtime.stop();release();await Promise.all([ticking,pending]);
  assert.equal(sent.length,0);assert.equal(runtime.status().ownerCommands[0].status,'cancelled');
  assert.equal(runtime.store.snapshot().outbox.find(row=>row.kind==='manual_daily').status,'cancelled');
});

test('cancelling an Owner-created reminder is reflected in the command log',async t=>{
  const{runtime,receive}=await fixture(t,{planOwner:async()=>reminder});await receive('明早八点提醒爸爸给花浇水');
  const reminderId=runtime.store.reminders('dad')[0].id;
  await runtime.action({action:'cancel_reminder',personId:'dad',reminderId});
  assert.equal(runtime.status().ownerCommands[0].status,'cancelled');
});

test('ordinary Owner chat uses the existing self-only model without command planning',async t=>{
  let plans=0;const{sent,receive}=await fixture(t,{planOwner:async()=>{plans++;return daily;},respond:async()=>({reply:'连接正常'})});
  await receive('家庭助手测试，请只回复连接正常');assert.equal(plans,0);assert.equal(sent[0].text,'连接正常');
});

test('actual Owner planner and per-person responder integrate without sharing elder context with the planner',async t=>{
  const captured=[];
  const llm={async *stream(options){
    const payload=JSON.parse(options.messages[0].content[0].text);captured.push({options,payload});
    const answer=payload.members?daily:{reply:'只给妈妈看的日报',action:null};
    yield{type:'text-delta',index:0,text:JSON.stringify(answer)};yield{type:'finish',reason:{kind:'stop'}};
  }};
  const ctx={get:()=>llm},config=()=>({provider:'fake',model:'fake'});
  const{runtime,sent,receive}=await fixture(t,{planOwner:createHostOwnerPlanner(ctx,config),respond:createHostResponder(ctx,config)});
  runtime.store.addMessage('mom',{dir:'in',text:'妈妈未分享的园艺问题'});
  await receive('给我妈发今天的日报');
  assert.equal(captured.length,2);assert(captured.every(call=>call.options.tools.length===0));
  assert.doesNotMatch(JSON.stringify(captured[0]),/未分享的园艺问题/);
  assert.match(JSON.stringify(captured[1]),/未分享的园艺问题/);
  assert.deepEqual(sent.map(item=>item.route.personId),['mom','owner']);assert.doesNotMatch(sent[1].text,/只给妈妈看的日报/);
});

test('past reminder and nonexistent DST wall time never schedule',async t=>{
  let plan={...reminder,action:{...reminder.action,date:'2026-10-21'}};
  const{runtime,receive}=await fixture(t,{planOwner:async()=>plan});
  await receive('昨天八点提醒爸爸给花浇水','past');assert.equal(runtime.store.snapshot().reminders.length,0);
  runtime.store.updatePerson('dad',{timeZone:'America/New_York'});
  plan={...reminder,action:{...reminder.action,date:'2027-03-14',time:'02:30',timeEvidence:'2:30'}};
  await receive('2027年3月14日2:30提醒爸爸给花浇水','dst');assert.equal(runtime.store.snapshot().reminders.length,0);
});
