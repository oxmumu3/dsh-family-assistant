import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';
const instant='2026-10-23T12:00:00.000Z';
async function setup(t,{planWorkbench,respond,send}={}){
 const directory=mkdtempSync(join(tmpdir(),'family-wb-runtime-')),sent=[];
 const runtime=createRuntime({directory,now:()=>instant,planWorkbench,respond:respond??(async()=>({reply:'个人日报'})),intervalMs:600000,channelFactory:()=>({connect:async()=>{},disconnect:async()=>{},close:async()=>{},status:()=>({status:'connected'}),async send(route,text,options){if(!options.authorize())throw Object.assign(new Error('not authorized'),{sendOutcome:'failed'});if(send)await send(route,text);sent.push({route,text});return{status:'api_accepted'};}})});
 t.after(async()=>{await runtime.close();rmSync(directory,{recursive:true,force:true});});
 for(const[id,role,label]of[['owner','owner','我'],['mom','elder','妈妈'],['dad','elder','爸爸']]){runtime.store.addPerson({id,role,label});runtime.store.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id});}
 await runtime.start();return{runtime,sent};
}
const proposal={reply:'请核对',operation:{type:'plan',actions:[{type:'send_daily',personId:'mom'},{type:'remind',personId:'dad',text:'浇花',date:'2026-10-24',time:'08:00',repeat:'once',timeEvidence:'明早八点'}]}};
test('web proposal sends nothing until confirmed, then addresses each member independently',async t=>{
 const{runtime,sent}=await setup(t,{planWorkbench:async()=>proposal});
 let state=await runtime.action({action:'owner_chat',text:'给妈妈日报，明早八点提醒爸爸浇花',requestId:'one'});assert.equal(sent.length,0);assert.equal(state.workbench.cards.length,1);
 const card=state.workbench.cards[0];state=await runtime.action({action:'confirm_card',cardId:card.id,revision:card.revision});
 assert.equal(sent.length,1);assert.equal(sent[0].route.personId,'mom');assert.equal(runtime.store.reminders('dad').length,1);assert.equal(runtime.store.person('mom').dailyEnabled,false);
 await runtime.action({action:'confirm_card',cardId:card.id,revision:card.revision});assert.equal(sent.length,1);assert.equal(runtime.store.reminders('dad').length,1);
 assert.deepEqual(state.workbench.cards[0].actions.map(a=>a.status),['api_accepted','scheduled']);
});
test('changed recipient route after proposal cannot send to replacement',async t=>{
 const{runtime,sent}=await setup(t,{planWorkbench:async()=>proposal});const state=await runtime.action({action:'owner_chat',text:'给妈妈日报，明早八点提醒爸爸浇花',requestId:'one'});
 runtime.store.bindPerson('mom',{accountId:'other',peerId:'replacement'});const card=state.workbench.cards[0];
 const result=await runtime.action({action:'confirm_card',cardId:card.id,revision:card.revision});assert.equal(sent.length,0);assert.equal(result.workbench.cards[0].actions[0].status,'failed');
});
test('relay sends only the explicit request while Owner can directly inspect saved conversation',async t=>{
 const{runtime,sent}=await setup(t,{respond:async({text})=>text.includes('帮我转告')?{reply:'待转告',action:{type:'relay',text:'周六几点来看我？',evidence:'帮我转告，周六几点来看我？'}}:{reply:'收到'}});
 runtime.store.addMessage('mom',{dir:'in',text:'不准泄露的旧私聊'});
 await runtime.receive('mom',{id:'relay',peerId:'peer-mom',text:'帮我转告，周六几点来看我？'});
 let view=runtime.status({personId:'mom'});assert.equal(view.workbench.requests.length,1);assert.match(JSON.stringify(view.messages),/不准泄露/);assert.doesNotMatch(JSON.stringify(view.workbench.requests),/不准泄露/);assert.doesNotMatch(JSON.stringify(sent),/不准泄露/);
 assert.equal(sent.filter(s=>s.route.personId==='owner').length,1);
 const request=view.workbench.requests[0];await runtime.action({action:'reply_request',requestId:request.id,text:'下午四点',operationId:'reply-one'});
 assert.match(sent.at(-1).text,/代.*转告|回复/);assert.match(sent.at(-1).text,/下午四点/);assert.equal(sent.at(-1).route.personId,'mom');assert.equal(runtime.status().workbench.requests[0].status,'waiting');
 await runtime.action({action:'reply_request',requestId:request.id,text:'下午四点',operationId:'reply-one'});assert.equal(sent.filter(s=>/下午四点/.test(s.text)).length,1);
});
test('model cannot relay without explicit request in current elder message',async t=>{
 const{runtime,sent}=await setup(t,{respond:async()=>({reply:'转告',action:{type:'relay',text:'秘密',evidence:'帮我转告，周六几点来看我？'}})});
 await runtime.receive('mom',{id:'x',peerId:'peer-mom',text:'今天聊点园艺'});assert.equal(runtime.status().workbench.requests.length,0);assert(!sent.some(s=>s.route.personId==='owner'));
});
test('self preference persists privately and guides only that members next model call',async t=>{
 const calls=[];const{runtime}=await setup(t,{respond:async input=>{calls.push(input);return input.text.includes('以后日报')?{reply:'准备记住',action:{type:'preference',patch:{notes:'每天的日报简短一点'},evidence:'以后日报短一点'}}:{reply:'收到'};}});
 await runtime.receive('mom',{id:'one',peerId:'peer-mom',text:'以后日报短一点'});await runtime.receive('mom',{id:'two',peerId:'peer-mom',text:'今天有什么好玩'});await runtime.receive('dad',{id:'three',peerId:'peer-dad',text:'你好'});
 assert.match(calls[1].person.notes,/简短/);assert.doesNotMatch(calls[2].person.notes,/简短/);assert.doesNotMatch(JSON.stringify(runtime.status()),/每天的日报简短一点/);
});
test('unknown send has no retry, check never resends',async t=>{
 let attempts=0;const{runtime}=await setup(t,{planWorkbench:async()=>({reply:'确认',operation:{type:'plan',actions:[{type:'send_message',personId:'mom',text:'测试'}]}}),send:async()=>{attempts++;throw Object.assign(new Error('timeout'),{sendOutcome:'uncertain'});}});
 const view=await runtime.action({action:'owner_chat',text:'给妈妈说测试',requestId:'one'});const card=view.workbench.cards[0];await runtime.action({action:'confirm_card',cardId:card.id,revision:card.revision});
 await assert.rejects(runtime.action({action:'retry_action',cardId:card.id,actionId:card.actions[0].id}),/明确失败|未知/);await runtime.action({action:'check_action',cardId:card.id,actionId:card.actions[0].id});await runtime.tick();assert.equal(attempts,1);
});
