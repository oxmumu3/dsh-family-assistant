import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';

const instant='2026-10-23T12:00:00.000Z';
async function fixture(t,{planWorkbench,respond,send}={}){
  const directory=mkdtempSync(join(tmpdir(),'family-runtime-review-')),sent=[];
  const runtime=createRuntime({directory,now:()=>instant,planWorkbench,respond:respond??(async()=>({reply:'收到。'})),intervalMs:600000,channelFactory:()=>({
    connect:async()=>{},disconnect:async()=>{},close:async()=>{},status:()=>({status:'connected'}),
    async send(route,text,options){if(!options.authorize())throw Object.assign(new Error('not authorized'),{sendOutcome:'failed'});if(send)await send(route,text);sent.push({personId:route.personId,text});return{status:'api_accepted'};},
  })});
  t.after(async()=>{await runtime.close();rmSync(directory,{recursive:true,force:true});});
  for(const[id,role,label]of[['owner','owner','小林'],['mom','elder','妈妈'],['dad','elder','爸爸']]){runtime.store.addPerson({id,role,label});runtime.store.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id});}
  await runtime.start();return{runtime,sent};
}

test('review: relay consent for one matter cannot expose unrelated text from the same message',async t=>{
  const {runtime,sent}=await fixture(t,{respond:async()=>({reply:'准备转告。',action:{type:'relay',text:'我有一件私事',evidence:'请帮我问孩子周六来不来'}})});
  await runtime.receive('mom',{id:'unrelated_quote',peerId:'peer-mom',text:'我有一件私事。请帮我问孩子周六来不来'});
  assert.equal(runtime.status().workbench.requests.length,0);assert.equal(sent.filter(item=>item.personId==='owner').length,0);
});

test('review: owner self reminders retain their original path with a workbench planner installed',async t=>{
  let plannerCalls=0;const {runtime}=await fixture(t,{planWorkbench:async()=>{plannerCalls++;return{reply:'管理对话。',operation:null};},respond:async()=>({reply:'准备设置。',action:{type:'remind',text:'散步',dueAt:'2026-10-24T00:00:00Z',repeat:'once'}})});
  await runtime.receive('owner',{id:'own_reminder',peerId:'peer-owner',text:'明早八点提醒我散步'});
  assert.equal(plannerCalls,0);assert.equal(runtime.store.reminders('owner').length,1);assert.equal(runtime.store.reminders('mom').length,0);
});

test('review: lost owner authority during an earlier action blocks a later schedule',async t=>{
  let output={reply:'请核对。',operation:{type:'plan',actions:[{type:'send_message',personId:'mom',text:'周末见。'},{type:'remind',personId:'dad',text:'浇花',date:'2026-10-24',time:'08:00',repeat:'once',timeEvidence:'明早八点'}]}};
  const {runtime}=await fixture(t,{planWorkbench:async()=>output,send:async route=>{if(route.personId==='mom')runtime.store.bindPerson('owner',{accountId:'owner_new',peerId:'owner_new'});}});
  const view=await runtime.action({action:'owner_chat',text:'告诉妈妈周末见，明早八点提醒爸爸浇花',requestId:'prepare'}),card=view.workbench.cards[0];
  output={reply:'开始处理。',operation:{type:'confirm',cardId:card.id}};
  await runtime.receive('owner',{id:'confirm',peerId:'peer-owner',text:'确认安排'});
  assert.equal(runtime.store.reminders('dad').length,0);
  assert.equal(runtime.status().workbench.cards[0].actions[1].status,'failed');
});

test('review: personal model receives only the registered owner contact label',async t=>{
  let input;const {runtime}=await fixture(t,{respond:async value=>{input=value;return{reply:'你好。'};}});
  await runtime.receive('mom',{id:'contact_label',peerId:'peer-mom',text:'可以帮我联系谁？'});
  assert.deepEqual(input.ownerContact,{label:'小林'});
});

test('review: cancelling an obsolete daily schedule cannot disable its replacement',async t=>{
  let time='08:00';const {runtime}=await fixture(t,{planWorkbench:async()=>({reply:'请核对。',operation:{type:'plan',actions:[{type:'daily_schedule',personId:'mom',enabled:true,time}]}})});
  const first=await runtime.action({action:'owner_chat',text:'每天上午八点给妈妈日报',requestId:'daily_first'}),old=first.workbench.cards[0];
  await runtime.action({action:'confirm_card',cardId:old.id,revision:old.revision});
  time='09:00';const second=await runtime.action({action:'owner_chat',text:'每天上午九点给妈妈日报',requestId:'daily_replacement'}),replacement=second.workbench.cards.at(-1);
  await runtime.action({action:'confirm_card',cardId:replacement.id,revision:replacement.revision});
  try{await runtime.action({action:'cancel_card',cardId:old.id,actionId:old.actions[0].id});}catch(error){assert.match(error.message,/已|取消|改变|覆盖|替换|当前/);}
  assert.equal(runtime.store.person('mom').dailyEnabled,true);assert.equal(runtime.store.person('mom').dailyTime,'09:00');
});
