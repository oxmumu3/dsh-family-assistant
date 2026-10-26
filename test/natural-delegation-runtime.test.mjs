import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRuntime} from '../src/runtime.mjs';

const instant='2026-10-25T02:00:00.000Z';
async function fixture(t,options={}){
 const directory=mkdtempSync(join(tmpdir(),'lele9-runtime-')),sent=[],native=[];let callbacks;
 const runtime=createRuntime({directory,now:()=>instant,intervalMs:600000,
  ownerAgent:{listWorkspaces:async()=>[{workspaceId:'digest',title:'AI 日报',path:directory}],start:async x=>{native.push(x);return{state:'succeeded',text:'原生结果'};},observe:async()=>({state:'succeeded',text:'原生结果'})},
  digestSources:async()=>[{relativePath:'daily.md',name:'daily.md',bytes:30,updatedAt:instant}],
  toolExecutors:{ai_digest:async()=>({text:'三条合成AI精选'})},
  planWorkbench:async()=>({reply:'普通管理回复',operation:null}),
  planHarness:async()=>({reply:'普通项目回复',operation:null}),
  respond:async()=>({reply:'普通回复'}),...options,
  channelFactory:args=>{callbacks=args;return{status:()=>({status:'connected'}),connect:async()=>{},disconnect:async()=>{},close:async()=>{},login:async id=>{await args.onBound(id,{accountId:'account-'+id,peerId:'peer-'+id});},send:async(route,text,config)=>{assert.equal(config.authorize(),true);sent.push({personId:route.personId,text});return{status:'api_accepted'};}};},
 });
 for(const[id,role,label]of[['owner','owner','我'],['mom','elder','妈妈'],['dad','elder','爸爸']]){runtime.store.addPerson({id,role,label,timeZone:'Asia/Shanghai'});runtime.store.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id});}
 runtime.store.configure({paused:false});await runtime.start();
 t.after(async()=>{await runtime.close();rmSync(directory,{recursive:true,force:true});});
 return{runtime,sent,native,callbacks};
}
const incoming=(runtime,personId,id,text)=>runtime.receive(personId,{id,peerId:'peer-'+personId,text});

test('Owner console drafts an actual digest service, confirms it in chat and does not dispatch a native task or message',async t=>{
 const{runtime,sent,native}=await fixture(t);
 const state=await runtime.action({action:'owner_chat',text:'用【AI 日报】项目的 daily.md，给妈妈每天北京时间08:00推送AI日报',requestId:'setup-digest'});
 const draft=state.serviceSetup?.find(row=>row.status==='ready');
 assert.ok(draft,'a ready service plan is returned in the same chat');
 assert.equal(draft.personId,'mom');assert.equal(sent.length,0);assert.equal(native.length,0);
 const applied=await runtime.action({action:'service_confirm',draftId:draft.id,revision:draft.revision,requestId:'confirm-digest'});
 assert.equal(applied.serviceSetup.find(row=>row.id===draft.id).status,'applied');
 const grants=await runtime.action({action:'tool_assignments',personId:'mom'});
 assert.equal(grants[0].toolId,'ai_digest');assert.equal(grants[0].schedule.time,'08:00');assert.equal(grants[0].schedule.timeZone,'Asia/Shanghai');
 assert.equal(sent.length,0);assert.equal(native.length,0);
 await runtime.action({action:'service_confirm',draftId:draft.id,revision:draft.revision,requestId:'confirm-digest'});
 assert.equal((await runtime.action({action:'tool_assignments',personId:'mom'}))[0].revision,grants[0].revision);
});

test('Owner WeChat uses the same service path and accepts a natural current-plan confirmation',async t=>{
 const{runtime,sent,native}=await fixture(t);
 await incoming(runtime,'owner','wechat-setup','用【AI 日报】项目的 daily.md，给妈妈每天北京时间08:00推送AI日报');
 assert.ok(runtime.status().serviceSetup.some(row=>row.origin==='wechat'&&row.status==='ready'));
 await incoming(runtime,'owner','wechat-confirm','确认开通');
 const grants=await runtime.action({action:'tool_assignments',personId:'mom'});assert.equal(grants.length,1);
 assert.equal(native.length,0);assert.equal(sent.some(row=>row.personId==='mom'),false);
 assert.ok(sent.some(row=>row.personId==='owner'&&/开通|保存|生效/.test(row.text)));
});

test('member memory actions are persisted for that member and never exposed to Owner status or another member model',async t=>{
 const contexts=[];
 const{runtime,sent}=await fixture(t,{respond:async args=>{contexts.push(args);return args.text.startsWith('帮我记住')?{reply:'准备记录',action:{type:'remember',text:'讲座材料在蓝色文件夹',evidence:args.text}}:{reply:'准备查找',action:{type:'search_notes',query:'讲座'}};}});
 await incoming(runtime,'mom','note-1','帮我记住：讲座材料在蓝色文件夹');
 await incoming(runtime,'mom','note-2','找一下讲座材料');
 assert.ok(sent.at(-1).text.includes('蓝色文件夹'));
 assert.ok(contexts.at(-1).notes.some(note=>note.text.includes('蓝色文件夹')));
 await incoming(runtime,'dad','other-person','找一下讲座材料');
 assert.equal(contexts.at(-1).notes.length,0);assert.equal(sent.at(-1).text.includes('蓝色文件夹'),false);
 assert.equal(JSON.stringify(runtime.status()).includes('蓝色文件夹'),false);
});

test('editing a personal reminder keeps its canonical ID, changes the next occurrence and cancels the old queued reminder',async t=>{
 let reminder;
 const{runtime,sent}=await fixture(t,{respond:async args=>({reply:'准备修改',action:{type:'update_reminder',reminderId:reminder.id,patch:{dueAt:'2026-10-26T06:00:00.000Z'},evidence:args.text,timeEvidence:'明天下午两点'}})});
 reminder=runtime.store.addReminder({personId:'mom',text:'参加社区会议',dueAt:'2026-10-26T02:00:00.000Z',repeat:'once',timeZone:'Asia/Shanghai'});
 runtime.store.enqueue({personId:'mom',text:'旧会议提醒',kind:'reminder',sourceKey:`reminder:${reminder.id}:${reminder.dueAt}`});
 await incoming(runtime,'mom','reschedule-1','把社区会议改到明天下午两点');
 const current=runtime.store.reminders('mom')[0];assert.equal(current.id,reminder.id);assert.equal(current.dueAt,'2026-10-26T06:00:00.000Z',JSON.stringify(sent));
 assert.equal(runtime.store.snapshot().outbox.find(row=>row.sourceKey.startsWith('reminder:')).status,'cancelled');
 assert.equal(sent.some(row=>row.text==='旧会议提醒'),false);
});

test('capability help is answered without an LLM and welcome only admits a newly bound family member once',async t=>{
 const{runtime,sent,callbacks}=await fixture(t,{respond:async()=>{throw Error('help must not call model');}});
 await incoming(runtime,'mom','help-1','你能帮我做什么');
 assert.match(sent.at(-1).text,/记|日程|提醒/);assert.equal(sent.at(-1).text.includes('已开通AI日报'),false);
 runtime.store.addPerson({id:'new-member',role:'elder',label:'阿宁'});
 await callbacks.onBound('new-member',{accountId:'account-new-member',peerId:'peer-new-member'});
 await runtime.tick();await runtime.settled();
 const count=()=>runtime.store.snapshot().outbox.filter(row=>row.kind==='member_welcome').length;
 assert.equal(count(),1);
 await callbacks.onBound('new-member',{accountId:'account-new-member',peerId:'peer-new-member'});
 await runtime.tick();await runtime.settled();assert.equal(count(),1);
 assert.equal(runtime.store.snapshot().outbox.some(row=>row.personId==='mom'&&row.kind==='member_welcome'),false);
});

test('PPT configuration preflights actual workflow readiness before persisting a grant',async t=>{
 const{runtime}=await fixture(t);
 await assert.rejects(runtime.action({action:'tool_assign',personId:'mom',toolId:'presentation',resource:{workflow:'presentation'},allowInvoke:true,schedule:null}),/PPT/);
 assert.equal((await runtime.action({action:'tool_assignments',personId:'mom'})).length,0);
 await assert.rejects(runtime.action({action:'tool_assign',personId:'owner',toolId:'presentation',resource:{workflow:'presentation'},allowInvoke:true,schedule:null}),/家人/);
 assert.equal((await runtime.action({action:'tool_assignments',personId:'owner'})).length,0);
});

test('a replacement binding does not put old private note text or reminder contents into the new model context',async t=>{
 const seen=[];const{runtime,sent}=await fixture(t,{respond:async args=>{seen.push(args);return args.text.startsWith('帮我记住')?{reply:'准备记录',action:{type:'remember',text:'旧账号的私密资料位置',evidence:args.text}}:{reply:'新账号普通回复'};}});
 await incoming(runtime,'mom','before-rebind','帮我记住：旧账号的私密资料位置');
 runtime.store.addReminder({personId:'mom',text:'旧账号私人日程',dueAt:'2026-10-25T02:00:00.000Z',timeZone:'Asia/Shanghai'});
 runtime.store.bindPerson('mom',{accountId:'replacement-account',peerId:'replacement-peer'});
 await runtime.receive('mom',{id:'after-rebind',peerId:'replacement-peer',text:'你好，我有哪些记事和安排'});
 assert.equal(seen.at(-1).notes.length,0);assert.equal(seen.at(-1).reminders.length,0);
 assert.equal(JSON.stringify(seen.at(-1)).includes('旧账号'),false);
 await runtime.tick();await runtime.settled();assert.equal(sent.some(row=>row.text.includes('旧账号私人日程')),false);
});

test('Owner help in console and WeChat explains actual project control and family service setup',async t=>{
 const{runtime,sent}=await fixture(t,{respond:async()=>{throw Error('help does not need a model');},planWorkbench:async()=>{throw Error('help does not need a planner');}});
 const state=await runtime.action({action:'owner_chat',text:'你能帮我做什么',requestId:'owner-help'});
 const reply=state.workbench.messages.at(-1).text;assert.match(reply,/项目/);assert.match(reply,/家人/);assert.match(reply,/开通|配置/);
 await incoming(runtime,'owner','owner-help-wechat','你能帮我做什么');assert.match(sent.at(-1).text,/项目/);assert.match(sent.at(-1).text,/家人/);
});
