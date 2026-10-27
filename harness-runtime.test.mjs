import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';
import {createHttpHandler} from '../src/http.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const assign=(runtime,personId='mom',patch={})=>runtime.action({action:'tool_assign',personId,toolId:'ai_digest',resource:{workspaceId:'family',relativePath:'reports/latest.md'},allowInvoke:true,...patch});
const inbound=(runtime,personId,id,text)=>runtime.receive(personId,{id,peerId:'peer-'+personId,text});

async function setup(t,extra={}){
 const directory=mkdtempSync(join(tmpdir(),'family-harness-runtime-')),sent=[];
 const runtime=createRuntime({directory,intervalMs:600000,respond:async()=>({reply:'普通回复'}),channelFactory:()=>({connect:async()=>{},disconnect:async()=>{},close:async()=>{},status:()=>({status:'connected'}),send:async(route,text,options)=>{assert.equal(options.authorize(),true);sent.push({personId:route.personId,text});return{status:'api_accepted'};}}),...extra});
 t.after(async()=>{await runtime.close();rmSync(directory,{recursive:true,force:true});});
 for(const[id,role]of[['owner','owner'],['mom','elder'],['dad','elder']]){runtime.store.addPerson({id,role,label:id});runtime.store.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id});}
 await runtime.start();return{runtime,sent};
}
test('trusted control history is paginated and cannot accept a forged viewer identity',async t=>{
 const{runtime}=await setup(t);for(let i=0;i<5;i++)runtime.store.addMessage('mom',{id:'m'+i,dir:i%2?'out':'in',text:'message-'+i});
 const page=await runtime.action({action:'history_page',personId:'mom',limit:2});assert.equal(page.access,'full');assert.equal(page.messages.length,2);assert.equal(page.total,5);assert.equal(page.hasMore,true);assert.equal(runtime.store.person('mom').shareWithOwner,'none');
 const previous=await runtime.action({action:'history_page',personId:'mom',before:page.nextCursor,limit:2});assert.equal(previous.messages.length,2);
 await assert.rejects(runtime.action({action:'history_page',personId:'mom',viewerPersonId:'owner'}));
});
test('control permissions use the registered Owner rather than actorId from the request',async t=>{
 const{runtime}=await setup(t);
 await runtime.action({action:'family_access_grant',personId:'mom',workspaceIds:['family'],capabilities:['read']});
 const rows=await runtime.action({action:'family_access_list'});assert.equal(rows.find(x=>x.personId==='mom').capabilities.includes('read'),true);
 await assert.rejects(runtime.action({action:'family_access_grant',actorId:'owner',personId:'dad',workspaceIds:['family'],capabilities:['write']}));
});
test('Owner WeChat lists official projects and family does not receive ungranted project metadata',async t=>{
 const ownerAgent={listWorkspaces:async()=>[{workspaceId:'family',path:'/tmp/synthetic-family',title:'家庭资料',sessionIds:[]},{workspaceId:'private',path:'/tmp/synthetic-private',title:'Owner专属项目',sessionIds:[]}]};
 const{runtime,sent}=await setup(t,{ownerAgent});
 await runtime.receive('owner',{id:'p1',peerId:'peer-owner',text:'列出 Harness 项目'});
 assert.match(sent.at(-1).text,/家庭资料/);assert.match(sent.at(-1).text,/Owner专属项目/);
 await runtime.receive('mom',{id:'p2',peerId:'peer-mom',text:'列出 Harness 项目'});
 assert.doesNotMatch(sent.at(-1).text,/Owner专属项目|synthetic-private/);
});
test('Owner native task completion is durably returned only to the original WeChat route',async t=>{
 let starts=0;
 const ownerAgent={listWorkspaces:async()=>[{workspaceId:'family',path:'/tmp/synthetic-family',title:'家庭资料',sessionIds:[]}],start:async()=>{starts++;return{state:'succeeded',text:'已整理合成材料，等待你检查。'};},observe:async()=>({state:'succeeded',text:'已整理合成材料，等待你检查。'})};
 const{runtime,sent}=await setup(t,{ownerAgent});
 await runtime.receive('owner',{id:'job1',peerId:'peer-owner',text:'在【家庭资料】项目执行：整理这份材料。'});await runtime.settled();
 assert.equal(starts,1);assert.equal(sent.some(x=>x.personId==='owner'&&x.text.includes('已整理合成材料')),true);assert.equal(sent.some(x=>x.personId!=='owner'),false);
 await runtime.receive('owner',{id:'job1',peerId:'peer-owner',text:'在【家庭资料】项目执行：整理这份材料。'});await runtime.settled();assert.equal(starts,1);
});
test('per-person tool grants expose and execute only the assigned scoped resource and return to that member',async t=>{
 const calls=[];const{runtime,sent}=await setup(t,{toolExecutors:{ai_digest:async request=>{calls.push(request);return{text:'合成日报：三条精选已经整理。'};}}});
 await assign(runtime);assert.equal((await runtime.action({action:'tool_catalog',personId:'mom'})).length,1);assert.deepEqual(await runtime.action({action:'tool_catalog',personId:'dad'}),[]);
 await inbound(runtime,'mom','digest-mom','AI 日报');await runtime.settled();
 assert.equal(calls.length,1);assert.equal(calls[0].personId,'mom');assert.deepEqual(calls[0].resource,{workspaceId:'family',relativePath:'reports/latest.md'});assert.ok(calls[0].signal instanceof AbortSignal);
 assert.equal(sent.filter(row=>row.text.includes('合成日报：三条精选')).length,1);assert.equal(sent.find(row=>row.text.includes('合成日报：三条精选')).personId,'mom');
 await inbound(runtime,'dad','digest-dad','AI 日报');await runtime.settled();assert.equal(calls.length,1);assert.equal(sent.some(row=>row.personId==='dad'&&row.text.includes('三条精选')),false);
 await inbound(runtime,'mom','digest-mom','AI 日报');await runtime.settled();assert.equal(calls.length,1);assert.equal(runtime.store.snapshot().outbox.filter(row=>row.kind==='tool_result').length,1);
});
test('trusted Owner can invoke a family tool and preserve the delegating Owner route on delivery',async t=>{
 const{runtime,sent}=await setup(t,{toolExecutors:{ai_digest:async()=>({text:'由 Owner 请求的合成内容'})}});await assign(runtime);
 const result=await runtime.action({action:'tool_invoke',personId:'mom',toolId:'ai_digest',requestId:'owner-invoke-1'});
 assert.equal(result.status,'succeeded');assert.equal(result.deliveryStatus,'api_accepted');assert.equal(sent.at(-1).personId,'mom');assert.equal(sent.at(-1).text,'由 Owner 请求的合成内容');
 const row=runtime.store.snapshot().outbox.find(item=>item.kind==='tool_result');assert.deepEqual(row.authorizationRoute,runtime.store.route('owner'));
});
for(const change of ['revoke','rebind','pause'])test(`${change} while a tool executor awaits suppresses its late result`,async t=>{
 const started=deferred(),finish=deferred();const{runtime,sent}=await setup(t,{toolExecutors:{ai_digest:async()=>{started.resolve();await finish.promise;return{text:'应被丢弃的旧授权内容'};}}});await assign(runtime);
 await inbound(runtime,'mom','pending-'+change,'AI 日报');await started.promise;
 if(change==='revoke')await assign(runtime,'mom',{allowInvoke:false});
 if(change==='rebind')runtime.store.bindPerson('mom',{accountId:'new-account-mom',peerId:'new-peer-mom'});
 if(change==='pause')await runtime.stop();
 finish.resolve();await runtime.settled();assert.equal(sent.some(row=>row.text.includes('应被丢弃')),false);assert.equal(runtime.store.snapshot().outbox.some(row=>row.kind==='tool_result'),false);
});
test('Owner rebinding while delegated execution awaits suppresses the pending return to a family member',async t=>{
 const started=deferred(),finish=deferred();const{runtime,sent}=await setup(t,{toolExecutors:{ai_digest:async()=>{started.resolve();await finish.promise;return{text:'旧 Owner 的代办结果'};}}});await assign(runtime);
 const pending=runtime.action({action:'tool_invoke',personId:'mom',toolId:'ai_digest',requestId:'owner-pending'});await started.promise;
 runtime.store.bindPerson('owner',{accountId:'new-owner-account',peerId:'new-owner-peer'});finish.resolve();const result=await pending;await runtime.settled();
 assert.equal(result.status,'uncertain');assert.equal(result.reason,'authorization_changed');assert.equal(sent.some(row=>row.text.includes('旧 Owner')),false);assert.equal(runtime.store.snapshot().outbox.some(row=>row.kind==='tool_result'),false);
});
test('repeated scheduler ticks share one durable daily tool run and one result delivery',async t=>{
 let count=0;const started=deferred(),finish=deferred();const{runtime,sent}=await setup(t,{now:()=> '2026-10-25T00:00:00.000Z',toolExecutors:{ai_digest:async()=>{count++;started.resolve();await finish.promise;return{text:'定时合成日报'};}}});
 await assign(runtime,'mom',{schedule:{enabled:true,time:'08:00',timeZone:'Asia/Shanghai'}});
 await runtime.tick();await started.promise;await Promise.all([runtime.tick(),runtime.tick()]);finish.resolve();await runtime.settled();await runtime.tick();await runtime.settled();
 assert.equal(count,1);assert.equal(sent.filter(row=>row.text==='定时合成日报').length,1);const rows=runtime.store.snapshot().outbox.filter(row=>row.kind==='tool_result');assert.equal(rows.length,1);assert.equal(rows[0].status,'api_accepted');
});
test('a family workflow request is deduplicated in the trusted Owner queue without granting or executing it',async t=>{
 let calls=0;const{runtime,sent}=await setup(t,{toolExecutors:{ai_digest:()=>{calls++;return'不应执行';}}});
 await inbound(runtime,'mom','workflow-mom','申请工作流：每天帮我整理社区活动材料。');await inbound(runtime,'mom','workflow-mom','申请工作流：每天帮我整理社区活动材料。');
 await inbound(runtime,'dad','workflow-dad','申请工具：帮我查询天气。');await runtime.settled();
 const rows=await runtime.action({action:'workflow_requests'});assert.equal(rows.length,2);assert.equal(rows.find(row=>row.personId==='mom').text,'每天帮我整理社区活动材料。');assert.ok(rows.every(row=>row.status==='pending'));assert.equal(calls,0);
 assert.deepEqual(await runtime.action({action:'tool_catalog',personId:'mom'}),[]);assert.equal(sent.some(row=>/已记下工具需求/.test(row.text)),true);
 await assert.rejects(runtime.action({action:'workflow_requests',actorId:'mom'}));
});
test('HTTP action arrays have an items envelope and retain trusted mode and model metadata',async t=>{
 const{runtime}=await setup(t);await assign(runtime);const handler=createHttpHandler({runtime,mode:'test',catalog:async()=>({available:true,providers:['synthetic']})});
 for(const action of ['tool_catalog','family_access_list','workflow_requests']){
  const response=await handler(new Request('http://dsh.internal/api/family/control',{method:'POST',headers:{'Content-Type':'application/json','X-Family-Action':'1'},body:JSON.stringify({action})}));
  assert.equal(response.status,200);const body=await response.json();assert.ok(Array.isArray(body.items));assert.equal(body.mode,'test');assert.deepEqual(body.model,{available:true,providers:['synthetic']});assert.equal(Object.hasOwn(body,'0'),false);
 }
});
test('long native results still produce a bounded WeChat return instead of silently losing all content',async t=>{
 const content='合成正文。'.repeat(800);const{runtime,sent}=await setup(t,{ownerAgent:{listWorkspaces:async()=>[{workspaceId:'family',path:'/tmp/synthetic-family',title:'家庭资料',sessionIds:[]}],start:async()=>({state:'succeeded',text:content}),observe:async()=>({state:'succeeded',text:content})}});
 await inbound(runtime,'owner','long-native','在【家庭资料】项目执行：起草内容。');await runtime.settled();
 const rows=runtime.store.snapshot().outbox.filter(row=>row.kind==='harness_result');assert.ok(rows.length>=1);assert.ok(rows.every(row=>row.text.length<=3200));assert.equal(sent.some(row=>row.text.includes('合成正文')),true);
 assert.equal(rows.map(row=>row.text.replace(/^（\d+\/\d+）\n/,'')).join(''),content);assert.ok(sent.findIndex(row=>row.text.includes('任务已登记'))<sent.findIndex(row=>row.text.includes('合成正文')));
 await inbound(runtime,'owner','long-native','在【家庭资料】项目执行：起草内容。');await runtime.settled();assert.equal(runtime.store.snapshot().outbox.filter(row=>row.kind==='harness_result').length,rows.length);
});
test('long family tool results produce a bounded return through the ordinary member route',async t=>{
 const{runtime,sent}=await setup(t,{toolExecutors:{ai_digest:async()=>({text:'较长的合成日报。'.repeat(600)})}});await assign(runtime);
 await inbound(runtime,'mom','long-tool','AI 日报');await runtime.settled();const rows=runtime.store.snapshot().outbox.filter(row=>row.kind==='tool_result');
 assert.ok(rows.length>=1);assert.ok(rows.every(row=>row.text.length<=3200));assert.equal(sent.some(row=>row.personId==='mom'&&row.text.includes('较长的合成日报')),true);
 assert.equal(rows.map(row=>row.text.replace(/^工具结果[^\n]*\n/,'')).join(''),'较长的合成日报。'.repeat(600));assert.ok(sent.findIndex(row=>row.text.includes('正在检查'))<sent.findIndex(row=>row.text.includes('较长的合成日报')));
});
test('a tool grant revoked while delivery awaits cannot authorize the queued content at the channel boundary',async t=>{
 const started=deferred(),finish=deferred(),delivered=[];let blocked=false;
 const{runtime}=await setup(t,{toolExecutors:{ai_digest:async()=>({text:'投递前撤权的内容'})},channelFactory:()=>({connect:async()=>{},disconnect:async()=>{},close:async()=>{},status:()=>({status:'connected'}),send:async(route,text,options)=>{
  if(text==='投递前撤权的内容'){started.resolve();await finish.promise;if(!options.authorize()){blocked=true;throw Object.assign(new Error('authorization changed'),{sendOutcome:'not_dispatched'});}}
  assert.equal(options.authorize(),true);delivered.push({personId:route.personId,text});return{status:'api_accepted'};
 }})});await assign(runtime);const receiving=inbound(runtime,'mom','delivery-revoke','AI 日报');await started.promise;
 await assign(runtime,'mom',{allowInvoke:false});finish.resolve();await receiving;await runtime.settled();
 assert.equal(blocked,true);assert.equal(delivered.some(row=>row.text==='投递前撤权的内容'),false);assert.notEqual(runtime.store.snapshot().outbox.find(row=>row.kind==='tool_result').status,'api_accepted');
});
test('natural language routing can delegate an explicitly named member tool and returns it only to that person',async t=>{
 const plans=[],calls=[];const{runtime,sent}=await setup(t,{planHarness:async context=>{plans.push(context);return{reply:'准备调用',operation:{type:'invoke_tool',personId:'mom',toolId:'ai_digest'}};},toolExecutors:{ai_digest:async request=>{calls.push(request);return{text:'自然语言派发的合成日报'};}}});await assign(runtime);
 await inbound(runtime,'owner','natural-tool','给 mom 发今天的 AI 精选。');await runtime.settled();assert.equal(plans.length,1);assert.equal(calls.length,1);assert.equal(calls[0].personId,'mom');
 assert.deepEqual(plans[0].targets.find(row=>row.personId==='mom').tools,['ai_digest']);assert.equal(sent.find(row=>row.text==='自然语言派发的合成日报').personId,'mom');assert.equal(sent.some(row=>row.personId==='owner'&&row.text==='自然语言派发的合成日报'),false);
});
test('a planner proposal cannot cross a family member identity or create an ungranted tool execution',async t=>{
 let calls=0;const plans=[];const{runtime,sent}=await setup(t,{planHarness:async context=>{plans.push(context);return{reply:'准备调用',operation:{type:'invoke_tool',personId:'dad',toolId:'ai_digest'}};},toolExecutors:{ai_digest:()=>{calls++;return'爸爸的资料';}}});await assign(runtime,'dad');
 await inbound(runtime,'mom','forged-plan','我也想看一下 AI 精选。');await runtime.settled();assert.equal(calls,0);assert.deepEqual(plans[0].targets.map(row=>row.personId),['mom']);assert.equal(sent.some(row=>row.text==='爸爸的资料'),false);
});
test('recovered native intents wait until every channel connects and observe without dispatching a second task',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'family-harness-recovery-')),connecting=deferred(),connected=deferred(),sent=[];let runtime,starts=0,observes=0,connects=0,gated=false;
 const ownerAgent={listWorkspaces:async()=>[{workspaceId:'family',path:'/tmp/synthetic-family',title:'家庭资料',sessionIds:[]}],start:async()=>{starts++;return{state:'queued'};},observe:async()=>{observes++;return{state:'succeeded',text:'通路连接完成后的恢复结果'};}};
 const options={directory,intervalMs:600000,ownerAgent,respond:async()=>({reply:'普通回复'}),channelFactory:()=>({connect:async()=>{connects++;if(gated){connecting.resolve();await connected.promise;}},disconnect:async()=>{},close:async()=>{},status:()=>({status:'connected'}),send:async(route,text,sendOptions)=>{assert.equal(sendOptions.authorize(),true);sent.push({personId:route.personId,text});return{status:'api_accepted'};}})};
 t.after(async()=>{await runtime?.close();rmSync(directory,{recursive:true,force:true});});runtime=createRuntime(options);
 for(const[id,role]of[['owner','owner'],['mom','elder']]){runtime.store.addPerson({id,role,label:id});runtime.store.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id});}
 await runtime.start();await inbound(runtime,'owner','recovered-task','在【家庭资料】项目执行：整理合成材料。');await runtime.settled();assert.equal(starts,1);assert.equal(observes,0);sent.length=0;await runtime.close();
 gated=true;connects=0;runtime=createRuntime(options);await runtime.settled();assert.equal(observes,0);assert.equal(sent.length,0);
 const starting=runtime.start();await connecting.promise;assert.equal(connects,2);await runtime.settled();assert.equal(observes,0);assert.equal(sent.length,0);
 connected.resolve();await starting;await runtime.settled();assert.equal(observes,1);assert.equal(starts,1);assert.equal(sent.filter(row=>row.text.includes('通路连接完成后的恢复结果')).length,1);assert.equal(runtime.status().harness.tasks[0].delivery.state,'accepted');
});
test('a failed WeChat tool request gets one explicit terminal notice after its acknowledgement without replaying the executor',async t=>{
 let calls=0;const{runtime,sent}=await setup(t,{toolExecutors:{ai_digest:async()=>{calls++;throw Error('secret-token https://private.invalid/material');}}});await assign(runtime);
 await inbound(runtime,'mom','failed-digest','AI 日报');await runtime.settled();const notices=sent.filter(row=>row.personId==='mom'&&/未能|未完成|失败|没能/.test(row.text));
 assert.equal(calls,1);assert.equal(notices.length,1);assert.ok(sent.findIndex(row=>row.text.includes('正在检查'))<sent.indexOf(notices[0]));assert.doesNotMatch(JSON.stringify(sent),/secret-token|private\.invalid/);assert.equal(runtime.store.snapshot().outbox.some(row=>row.kind==='tool_result'),false);
 await inbound(runtime,'mom','failed-digest','AI 日报');await runtime.settled();assert.equal(calls,1);assert.equal(sent.filter(row=>row.personId==='mom'&&/未能|未完成|失败|没能/.test(row.text)).length,1);
});
