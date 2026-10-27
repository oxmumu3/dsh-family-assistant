import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';

async function fixture(t,options={}){
 const directory=mkdtempSync(join(tmpdir(),'owner-draft-chat-')),sent=[],native=[],plans=[];
 const runtime=createRuntime({directory,intervalMs:1000000,
  ownerAgent:{ensureControlWorkspace:async()=>({workspaceId:'control',title:'乐乐',path:'/synthetic/owner'}),listWorkspaces:async()=>[{workspaceId:'control',title:'乐乐',path:'/synthetic/owner'}],start:async input=>{native.push(input);return{state:'succeeded',text:'合成普通答复'};},observe:async()=>({state:'succeeded',text:'合成普通答复'})},
  planWorkbench:async input=>{plans.push(input);if(options.plan)return options.plan(input);const current=input.cards.find(card=>'card:'+card.id===input.contextId);return{reply:'模型只说已准备好不能作为执行依据',operation:{type:'plan',...(current?{cardId:current.id}:{}),actions:[{type:'send_message',personId:'k',text:input.text.includes('九点')?'晚上九点见':'晚上八点见',...(current?{id:current.actions[0].id}:{})}]}};},
  channelFactory:()=>({status:()=>({status:'connected'}),connect:async()=>{},disconnect:async()=>{},close:async()=>{},send:async(route,text,options)=>{assert.equal(options.authorize(),true);sent.push({personId:route.personId,text});return{status:'api_accepted'};}}),
 });
 t.after(async()=>{await runtime.close();rmSync(directory,{recursive:true,force:true});});
 for(const[id,role,label]of[['owner','owner','我'],['k','elder','K']]){runtime.store.addPerson({id,role,label});runtime.store.bindPerson(id,{accountId:'fake-'+id,peerId:'peer-'+id});}
 await runtime.start();
 const send=async(origin,text,id)=>{if(origin==='wechat')await runtime.receive('owner',{id,peerId:runtime.store.route('owner').peerId,text});else await runtime.action({action:'owner_chat',text,requestId:id});await runtime.settled();return runtime.status();};
 return{runtime,sent,native,plans,send};
}

for(const origin of ['wechat','console']){
 test(`Owner ${origin} message draft and confirmation use durable workbench state instead of model promises`,async t=>{
  const f=await fixture(t);const initial=await f.send(origin,'先帮我起草给K发：晚上八点见','draft-one');
  assert.equal(f.native.length,0);assert.equal(f.plans.length,1);assert.equal(f.sent.filter(row=>row.personId==='k').length,0);
  assert.equal(initial.workbench.cards.length,1);assert.equal(initial.workbench.cards[0].status,'draft');
  const preview=origin==='wechat'?f.sent.at(-1).text:initial.workbench.messages.at(-1).text;assert.match(preview,/晚上八点见/);assert.match(preview,/确认/);assert.doesNotMatch(preview,/工作台|模型只说/);
  await f.send(origin,'确认','confirm-one');assert.equal(f.native.length,0);assert.equal(f.plans.length,1,'confirmation does not ask another model to choose an operation');
  assert.equal(f.sent.filter(row=>row.personId==='k').length,1);assert.match(f.sent.find(row=>row.personId==='k').text,/晚上八点见/);
  await f.send(origin,'确认','confirm-one');assert.equal(f.sent.filter(row=>row.personId==='k').length,1);
 });
 test(`Owner ${origin} revises the same shown draft then confirms only the revised content`,async t=>{
  const f=await fixture(t);const initial=await f.send(origin,'先帮我起草给K发：晚上八点见','edit-first'),id=initial.workbench.cards[0]?.id;
  const revised=await f.send(origin,'把晚上八点改成晚上九点','edit-second');
  assert.equal(f.native.length,0);assert.equal(revised.workbench.cards.length,1);assert.equal(revised.workbench.cards[0].id,id);assert.match(revised.workbench.messages.at(-1).text,/晚上九点见/);
  await f.send(origin,'发吧','edit-confirm');assert.equal(f.sent.filter(row=>row.personId==='k').length,1);assert.match(f.sent.find(row=>row.personId==='k').text,/晚上九点见/);
 });
 test(`a new ${origin} topic prevents a later confirmation from executing an older draft`,async t=>{
  const f=await fixture(t);await f.send(origin,'先帮我起草给K发：晚上八点见','stale-first');
  await f.send(origin,'今天你能做什么呢？','unrelated-next');await f.send(origin,'确认','unrelated-confirm');
  assert.equal(f.sent.some(row=>row.personId==='k'),false);assert.equal(f.runtime.status().workbench.cards[0].status,'draft');
 });
}
test('a replaced Owner WeChat binding cannot confirm a draft from the previous binding',async t=>{
 const f=await fixture(t);await f.send('wechat','先帮我起草给K发：晚上八点见','before-binding');
 f.runtime.store.bindPerson('owner',{accountId:'fake-new-owner',peerId:'peer-new-owner'});
 await f.send('wechat','确认','after-binding');assert.equal(f.sent.some(row=>row.personId==='k'),false);
});
test('a long message preview is fully shown before Owner can confirm its actions',async t=>{
 const f=await fixture(t,{plan:()=>({reply:'prepared',operation:{type:'plan',actions:[{type:'send_message',personId:'k',text:'A'.repeat(2000)},{type:'send_message',personId:'k',text:'B'.repeat(2000)}]}})});
 const state=await f.send('wechat','先帮我起草给K发两条消息','long-preview');
 const full=state.workbench.messages.at(-1).text;
 assert.ok(full.length>3200);assert.equal(f.sent.filter(row=>row.personId==='owner').map(row=>row.text).join(''),full);
 await f.send('wechat','确认','long-confirm');assert.equal(f.sent.filter(row=>row.personId==='k').length,2);
});
