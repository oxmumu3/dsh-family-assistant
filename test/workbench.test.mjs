import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';
const now=()=> '2026-10-23T12:00:00.000Z';
async function setup(t,{plan,execute}={}){
  const directory=mkdtempSync(join(tmpdir(),'family-workbench-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const store=createStore({directory,now});
  for(const[id,role,label]of[['owner','owner','我'],['mom','elder','妈妈'],['dad','elder','爸爸']])store.addPerson({id,role,label});
  const {createWorkbench}=await import('../src/workbench.mjs');
  const options={directory,store,now,plan:plan??(async()=>({reply:'好的',operation:null})),execute:execute??(async()=>({status:'api_accepted'}))};
  return {store,wb:createWorkbench(options),options,directory,createWorkbench};
}
const profile={reply:'整理好了，请核对',operation:{type:'profile',patch:{label:'外婆',notes:'住北京，喜欢养花',interests:['养花']}}};
const plan={reply:'请核对安排',operation:{type:'plan',actions:[{type:'remind',personId:'dad',text:'浇花',date:'2026-10-24',time:'08:00',repeat:'once',timeEvidence:'明早八点'},{type:'send_daily',personId:'mom'}]}};
test('new profile is a persistent draft and confirmation is idempotent',async t=>{
 const {wb,store,createWorkbench,options,directory}=await setup(t,{plan:async()=>profile});
 await wb.chat({text:'外婆住北京，喜欢养花',requestId:'request1'});
 const card=wb.snapshot().cards[0];assert.equal(card.status,'draft');assert.equal(store.snapshot().people.length,3);
 await wb.confirm({cardId:card.id,revision:card.revision});await wb.confirm({cardId:card.id,revision:card.revision});
 assert.equal(store.snapshot().people.length,4);assert.equal(wb.snapshot().cards[0].status,'saved');
 assert.equal(createWorkbench(options).snapshot().messages.length,2);
 assert.equal(statSync(join(directory,'workbench.json')).mode&0o777,0o600);
});
test('same input request id is not planned twice and cannot be reused for another input',async t=>{
 let calls=0;const{wb}=await setup(t,{plan:async()=>{calls++;return profile;}});
 await Promise.all([wb.chat({text:'新建外婆',requestId:'same'}),wb.chat({text:'新建外婆',requestId:'same'})]);
 assert.equal(calls,1);assert.equal(wb.snapshot().cards.length,1);
 await assert.rejects(wb.chat({text:'改成爸爸',requestId:'same'}),/标识|重复/);
});
test('saved profile revision has an undo and never changes binding or sharing',async t=>{
 let result={reply:'更新了',operation:{type:'profile',personId:'mom',patch:{notes:'住杭州'}}};
 const{wb,store}=await setup(t,{plan:async()=>result});store.bindPerson('mom',{accountId:'a',peerId:'b'});
 await wb.chat({text:'妈妈住杭州',contextId:'person:mom',requestId:'edit'});
 const card=wb.snapshot().cards[0];assert.equal(card.status,'saved');assert.equal(store.person('mom').notes,'住杭州');
 await wb.undo({cardId:card.id});assert.equal(store.person('mom').notes,'');assert.equal(store.person('mom').shareWithOwner,'none');assert.equal(store.binding('mom').peerId,'b');
});
test('undo refuses to overwrite a later profile change',async t=>{
 const{wb,store}=await setup(t,{plan:async()=>({reply:'更新',operation:{type:'profile',personId:'mom',patch:{notes:'北京'}}})});
 await wb.chat({text:'妈妈在北京',requestId:'a'});store.updatePerson('mom',{notes:'上海'});
 await assert.rejects(wb.undo({cardId:wb.snapshot().cards[0].id}),/后来|改变|更新/);assert.equal(store.person('mom').notes,'上海');
});
test('cancelling one item leaves the other and only confirms remaining draft',async t=>{
 const calls=[];const{wb}=await setup(t,{plan:async()=>plan,execute:async a=>{calls.push(a);return{status:'api_accepted'};}});
 await wb.chat({text:'明早八点提醒爸爸浇花，再给妈妈日报',requestId:'a'});let card=wb.snapshot().cards[0];
 await wb.cancel({cardId:card.id,actionId:card.actions[0].id});card=wb.snapshot().cards[0];
 await wb.confirm({cardId:card.id,revision:card.revision});assert.equal(calls.length,1);assert.equal(calls[0].personId,'mom');
 assert.equal(wb.snapshot().cards[0].actions[0].status,'cancelled');
});
test('per-action failure retry never repeats accepted item and unknown cannot retry',async t=>{
 let count=0;const{wb}=await setup(t,{plan:async()=>plan,execute:async a=>{count++;return{status:a.personId==='dad'?'scheduled':count===2?'failed':'uncertain'};}});
 await wb.chat({text:'明早八点提醒爸爸浇花，再给妈妈日报',requestId:'a'});let card=wb.snapshot().cards[0];await wb.confirm({cardId:card.id,revision:card.revision});
 card=wb.snapshot().cards[0];await wb.retry({cardId:card.id,actionId:card.actions[1].id});assert.equal(count,3);
 await assert.rejects(wb.retry({cardId:card.id,actionId:card.actions[1].id}),/明确失败|未知|不明/);assert.equal(count,3);
});
test('same-card patch merges one action without dropping the other',async t=>{
 let answer=plan;const{wb}=await setup(t,{plan:async()=>answer});await wb.chat({text:'明早八点提醒爸爸浇花，再给妈妈日报',requestId:'a'});
 const card=wb.snapshot().cards[0];answer={reply:'改到九点',operation:{type:'plan',cardId:card.id,actions:[{...plan.operation.actions[0],id:card.actions[0].id,time:'09:00',timeEvidence:'明早九点'}]}};
 await wb.chat({text:'爸爸改到明早九点',contextId:'card:'+card.id,requestId:'b'});
 const next=wb.snapshot().cards[0];assert.equal(next.actions.length,2);assert.equal(next.actions[0].time,'09:00');assert.equal(next.actions[1].personId,'mom');
 await assert.rejects(wb.confirm({cardId:card.id,revision:card.revision}),/更新|版本|核对/);
});
test('request reply stays waiting after API acceptance and only own explicit response resolves it',async t=>{
 const {wb}=await setup(t);const request=wb.createRequest({personId:'mom',text:'周六几点来看我',sourceId:'in-1'});
 assert.equal(wb.createRequest({personId:'mom',text:'周六几点来看我',sourceId:'in-1'}).id,request.id);
 await wb.reply({requestId:request.id,text:'下午四点',operationId:'reply1'});
 assert.equal(wb.snapshot().requests[0].status,'waiting');
 assert.throws(()=>wb.memberResponse({personId:'dad',requestId:request.id,text:'好的'}),/当前|家人|本人/);
 wb.memberResponse({personId:'mom',requestId:request.id,text:'好的，我等你'});assert.equal(wb.snapshot().requests[0].status,'resolved');
});
test('member preferences remain private from Owner planner, journal view and profile',async t=>{
 let input;const{wb,store}=await setup(t,{plan:async x=>{input=x;return{reply:'没有新事项',operation:null};}});
 wb.savePreference('mom',{notes:'不想向家人分享的偏好',interests:['私有主题']});
 assert.match(wb.memberProfile('mom').notes,/不想向/);assert.doesNotMatch(JSON.stringify(wb.snapshot()),/私有|不想向/);
 await wb.chat({text:'今天怎么样',requestId:'a'});assert.doesNotMatch(JSON.stringify(input),/私有|不想向/);assert.equal(store.person('mom').notes,'');
});
