import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRuntime} from '../src/runtime.mjs';

const instant='2026-10-25T02:00:00.000Z';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const origins=['wechat','console'];

async function fixture(t,overrides={}){
 const directory=mkdtempSync(join(tmpdir(),'lele-owner-native-entry-'));
 const starts=[],ensures=[],harnessPlans=[],workbenchPlans=[],responses=[],sent=[];
 const workspace={workspaceId:'owner-control',title:'Owner 主对话',path:join(directory,'control'),sessionIds:[]};
 const runtime=createRuntime({directory:join(directory,'private'),now:()=>instant,intervalMs:600000,
  ownerAgent:{
   async ensureControlWorkspace(options){ensures.push(options);return structuredClone(workspace);},
   async listWorkspaces(){return[structuredClone(workspace),{workspaceId:'writing',title:'写作资料',path:join(directory,'writing'),sessionIds:[]}];},
   async start(intent){starts.push(structuredClone(intent));return{state:'succeeded',text:'合成原生结果 '+starts.length};},
   async observe(){return{state:'succeeded',text:'合成观察结果'};},
  },
  ownerTaskArtifacts:{collect:async()=>[]},
  planHarness:async input=>{harnessPlans.push(structuredClone(input));return{reply:'旧规划器只列项目',operation:{type:'projects'}};},
  planWorkbench:async input=>{workbenchPlans.push(structuredClone(input));return overrides.workbench?overrides.workbench(input):{reply:'合成管理结果',operation:null};},
  respond:async input=>{responses.push(structuredClone(input));return overrides.respond?overrides.respond(input):{reply:'合成本人回复'};},
  channelFactory:()=>({status:()=>({status:'connected'}),connect:async()=>{},disconnect:async()=>{},close:async()=>{},
   async send(route,text,options){assert.equal(options.authorize(),true);sent.push({personId:route.personId,text});return{status:'api_accepted'};},
  }),
 });
 t.after(async()=>{await runtime.close();rmSync(directory,{recursive:true,force:true});});
 for(const[id,role,label]of[['owner','owner','我'],['mom','elder','妈妈'],['dad','elder','爸爸']]){
  runtime.store.addPerson({id,role,label,timeZone:'Asia/Shanghai',shareWithOwner:'none'});
  runtime.store.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id});
 }
 await runtime.start();
 let next=0;
 const send=async(origin,text,requestId='request-'+next++,extra={})=>{
  if(origin==='console')await runtime.action({action:'owner_chat',text,requestId,...extra});
  else await runtime.receive(extra.personId??'owner',{id:requestId,peerId:runtime.store.route(extra.personId??'owner').peerId,text});
  await runtime.settled();
  return runtime.status();
 };
 return{runtime,starts,ensures,harnessPlans,workbenchPlans,responses,sent,send};
}

for(const origin of origins)test(`Owner ${origin} search and ordinary follow-ups use one native session without the old planner`,async t=>{
 const f=await fixture(t),texts=['搜本地全部项目找到AI日报','哈喽你在找吗','Harness本地搜日报','继续找','找到了吗'];
 for(let i=0;i<texts.length;i++)await f.send(origin,texts[i],'search-'+i);
 assert.equal(f.starts.length,texts.length);
 assert.equal(f.harnessPlans.length,0);assert.equal(f.workbenchPlans.length,0);assert.equal(f.responses.length,0);
 assert.equal(f.runtime.status().serviceSetup.length,0);
 const tasks=f.runtime.status().harness.tasks;
 assert.equal(tasks.length,texts.length);
 assert.equal(new Set(tasks.map(row=>row.id)).size,texts.length);
 assert.equal(new Set(tasks.map(row=>row.requestId)).size,texts.length);
 assert.equal(new Set(tasks.map(row=>row.sourceRequestId)).size,texts.length);
 assert.equal(new Set(tasks.map(row=>row.conversationId)).size,1);
 assert.equal(new Set(tasks.map(row=>row.sessionId)).size,1);
 for(let i=0;i<texts.length;i++){
  assert.match(tasks[i].conversationId,uuid);assert.equal(tasks[i].sessionId,'family_owner_'+tasks[i].conversationId);
  assert.equal(tasks[i].prompt,texts[i],'Owner task cards show the request, not internal execution instructions');
  assert.ok(f.starts[i].prompt.includes(texts[i]));assert.equal(f.starts[i].origin,origin);
 }
 assert.equal(f.sent.some(row=>row.personId!=='owner'),false);
});

for(const origin of origins)test(`Owner ${origin} can ask for unnamed local material without moving to a project picker`,async t=>{
 const f=await fixture(t),text='帮我搜索一下以前准备的学习资料，整理后先给我看';
 await f.send(origin,text);
 assert.equal(f.starts.length,1);assert.ok(f.starts[0].prompt.includes(text));
 assert.equal(f.harnessPlans.length,0);assert.equal(f.workbenchPlans.length,0);
 const replies=origin==='console'?f.runtime.status().workbench.messages:f.sent;
 assert.equal(replies.some(row=>/需要先在.*Owner.*入口|请说明要使用哪个项目|不能实际扫描/.test(row.text)),false);
});

test('Owner console and WeChat keep separate native conversation identities',async t=>{
 const f=await fixture(t);
 await f.send('wechat','帮我整理旧文稿','wechat-first');await f.send('console','帮我整理旧文稿','console-first');
 assert.equal(f.starts.length,2);assert.notEqual(f.starts[0].sessionId,f.starts[1].sessionId);
 assert.notEqual(f.starts[0].conversationId,f.starts[1].conversationId);
});

for(const origin of origins)test(`Owner ${origin} duplicate request never dispatches or delivers a second native result`,async t=>{
 const f=await fixture(t),text='帮我查找以前的学习材料';
 await f.send(origin,text,'same-request');const deliveries=f.sent.length;
 await Promise.all([f.send(origin,text,'same-request'),f.send(origin,text,'same-request')]);
 assert.equal(f.starts.length,1);assert.equal(f.runtime.status().harness.tasks.length,1);assert.equal(f.sent.length,deliveries);
 if(origin==='console')await assert.rejects(()=>f.send(origin,'改成整理另一件事','same-request'),/重复|内容|编号/);
 else await f.send(origin,'改成整理另一件事','same-request');
 assert.equal(f.starts.length,1);assert.equal(f.runtime.status().harness.tasks.length,1);
});

test('Owner replacement WeChat binding starts a new conversation without injecting the old private history',async t=>{
 const f=await fixture(t);
 await f.send('wechat','检索旧绑定专属标识词','before-rebind');
 const first=f.starts[0];assert.ok(first);
 f.runtime.store.bindPerson('owner',{accountId:'replacement-account',peerId:'replacement-peer'});
 await f.send('wechat','帮我找一份学习材料','after-rebind');
 assert.equal(f.starts.length,2);assert.notEqual(f.starts[1].conversationId,first.conversationId);
 assert.notEqual(f.starts[1].sessionId,first.sessionId);assert.equal(f.starts[1].prompt.includes('旧绑定专属标识词'),false);
});

test('a family member never receives the Owner generic native entry or its control workspace',async t=>{
 const f=await fixture(t);
 await f.send('wechat','帮我搜索一下以前准备的学习资料','member-free',{personId:'mom'});
 await f.send('wechat','搜本地全部项目找到AI日报','member-projects',{personId:'dad'});
 assert.equal(f.starts.length,0);assert.equal(f.ensures.length,0);
 assert.equal(f.runtime.status().harness.tasks.length,0);
 assert.equal(f.harnessPlans.some(row=>row.person.role==='owner'),false);
 assert.equal(JSON.stringify(f.harnessPlans).includes('Owner 主对话'),false);
});

test('explicit profile, selected member/card and draft-only management remain in the workbench',async t=>{
 const f=await fixture(t,{workbench:input=>input.text==='准备妈妈资料卡'?{reply:'核对资料',operation:{type:'profile',personId:'mom',patch:{notes:'喜欢园艺'}}}:{reply:'合成管理结果',operation:null}});
 await f.send('console','准备妈妈资料卡','seed-card',{contextId:'person:mom'});
 const card=f.runtime.status().workbench.cards[0];assert.ok(card);
 const inputs=[
  {profileIntake:true,text:'阿姨喜欢读书'},
  {profileEdit:true,contextId:'person:mom',text:'喜欢简短回答'},
  {contextId:'person:mom',text:'补充妈妈的资料'},
  {contextId:'card:'+card.id,text:'调整这张资料卡'},
  {draftOnly:true,text:'整理一份合成安排草稿'},
 ];
 for(let i=0;i<inputs.length;i++){const{text,...extra}=inputs[i];await f.send('console',text,'management-'+i,extra);}
 assert.equal(f.workbenchPlans.length,inputs.length+1);assert.equal(f.starts.length,0);assert.equal(f.ensures.length,0);
 assert.equal(f.sent.length,0);
});

for(const origin of origins)test(`Owner ${origin} brief keeps the existing service summary route`,async t=>{
 const f=await fixture(t);await f.send(origin,'查看简报');
 assert.equal(f.starts.length,0);assert.equal(f.ensures.length,0);assert.equal(f.harnessPlans.length,0);
 const replies=origin==='console'?f.runtime.status().workbench.messages:f.sent;
 assert.ok(replies.some(row=>/简报|家庭服务/.test(row.text)));
 assert.equal(replies.some(row=>/请说明要使用哪个项目/.test(row.text)),false);
});

test('Owner console self-reminder stays with existing management instead of a null native route',async t=>{
 const f=await fixture(t);await f.send('console','提醒我明早八点浇花');
 assert.equal(f.starts.length,0);assert.equal(f.ensures.length,0);assert.equal(f.workbenchPlans.length,1);
 assert.equal(f.runtime.status().workbench.messages.at(-1).text,'合成管理结果');
});

test('Owner WeChat self-reminder retains its personal organizer and does not start native execution',async t=>{
 const f=await fixture(t,{respond:()=>({reply:'准备记录',action:{type:'remind',text:'浇花',dueAt:'2026-10-26T00:00:00.000Z',repeat:'once'}})});
 await f.send('wechat','提醒我明早八点浇花');
 assert.equal(f.starts.length,0);assert.equal(f.ensures.length,0);assert.equal(f.workbenchPlans.length,0);
 assert.equal(f.responses.length,1);assert.equal(f.runtime.store.reminders('owner').length,1);
 assert.equal(f.runtime.store.reminders('mom').length,0);
});

for(const origin of origins)test(`an unrelated old draft cannot capture Owner ${origin} confirmation after a native exchange`,async t=>{
 const f=await fixture(t,{workbench:input=>input.text==='准备旧安排'?{reply:'核对旧安排',operation:{type:'plan',actions:[{type:'send_message',personId:'mom',text:'禁止误发的旧草稿正文'}]}}:input.text==='确认'?{reply:'准备确认',operation:{type:'confirm',cardId:input.cards[0].id}}:{reply:'管理回复',operation:null}});
 await f.send('console','准备旧安排','old-draft',{draftOnly:true});
 const card=f.runtime.status().workbench.cards[0];assert.ok(card);assert.equal(card.status,'draft');
 await f.send(origin,'帮我查找旧材料，先核对你找到的来源','native-before-confirm');
 await f.send(origin,'确认','new-native-confirm');
 assert.equal(f.starts.length,2);assert.equal(f.workbenchPlans.length,1);
 assert.equal(f.starts[0].sessionId,f.starts[1].sessionId);
 assert.equal(f.runtime.status().workbench.cards.find(row=>row.id===card.id).status,'draft');
 assert.equal(f.sent.some(row=>row.personId==='mom'),false);
});

for(const origin of origins)test(`Owner ${origin} result sent to self uses the original entry without a family delivery target`,async t=>{
 const f=await fixture(t);await f.send(origin,'整理旧资料，发给我');
 assert.equal(f.starts.length,1);assert.equal(f.starts[0].deliveryTarget,undefined);
 assert.equal(f.runtime.status().harness.tasks[0].deliveryTarget,undefined);
 assert.equal(f.sent.some(row=>row.personId!=='owner'),false);
 if(origin==='console')assert.equal(f.sent.length,0);
});

for(const origin of origins)test(`Owner ${origin} native follow-up does not inherit the previous family recipient`,async t=>{
 const f=await fixture(t);await f.send(origin,'整理一份学习材料，发给妈妈','recipient-first');
 await f.send(origin,'接着检索下一份，先给我看','recipient-next');
 assert.equal(f.starts.length,2);assert.equal(f.starts[0].deliveryTarget.personId,'mom');
 assert.equal(f.starts[1].deliveryTarget,undefined);assert.equal(f.starts[0].sessionId,f.starts[1].sessionId);
 assert.equal(f.runtime.status().harness.tasks[1].deliveryTarget,undefined);
 assert.equal(f.sent.filter(row=>row.personId==='mom'&&row.text.includes('合成原生结果 2')).length,0);
});

for(const origin of origins)test(`Owner ${origin} asking how delivery works does not authorize a family send`,async t=>{
 const f=await fixture(t);await f.send(origin,'请解释怎么把结果发给妈妈');
 assert.equal(f.starts.length,1);assert.equal(f.starts[0].deliveryTarget,undefined);
 assert.equal(f.sent.some(row=>row.personId==='mom'),false);
});
