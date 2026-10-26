import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';
import {createFamilyProjectExecutor} from '../src/family-project-executor.mjs';
import {createFamilyToolbox} from '../src/family-toolbox.mjs';
import {createStore} from '../src/store.mjs';
import {createConversationHistory} from '../src/conversation-history.mjs';
const now=()=> '2026-10-25T08:00:00.000Z';
function setup(t,extra={}){const directory=mkdtempSync(join(tmpdir(),'lele-controls-'));const runtime=createRuntime({directory,now,channelFactory:()=>({status:()=>({status:'connected'}),connect:async()=>{},disconnect:async()=>{},close:async()=>{},send:async()=>({status:'api_accepted'})}),...extra});t.after(async()=>{await runtime.close();rmSync(directory,{recursive:true,force:true});});for(const[id,role]of[['owner','owner'],['mom','elder']])runtime.store.addPerson({id,role,label:id,shareWithOwner:'full'});return{runtime,directory};}
test('Owner can read full saved tool settings while the member catalogue has no resource paths',async t=>{
 const{runtime}=setup(t);await runtime.action({action:'tool_assign',personId:'mom',toolId:'ai_digest',resource:{workspaceId:'digest',relativePath:'reports/latest.md'},allowInvoke:true,schedule:{enabled:true,time:'08:00',timeZone:'Asia/Shanghai'}});
 const rows=await runtime.action({action:'tool_assignments',personId:'mom'});assert.equal(rows[0].resource.relativePath,'reports/latest.md');assert.equal(rows[0].schedule.time,'08:00');
 assert.doesNotMatch(JSON.stringify(await runtime.action({action:'tool_catalog',personId:'mom'})),/reports\/latest/);
 await assert.rejects(runtime.action({action:'tool_assignments',actorId:'owner'}));
});
test('workflow requests keep durable Owner progress and immutable original member text',async t=>{
 const{runtime,directory}=setup(t);const box=createFamilyToolbox({directory,store:runtime.store,now});box.requestWorkflow({personId:'mom',requestId:'request-one',text:'希望帮忙整理旅行攻略'});
 const item=await runtime.action({action:'workflow_request_update',personId:'mom',requestId:'request-one',status:'accepted',note:'准备制作'});assert.equal(item.status,'accepted');assert.equal(item.text,'希望帮忙整理旅行攻略');assert.equal(item.note,'准备制作');
 const later=createFamilyToolbox({directory,store:runtime.store,now}).listRequests({actorId:'owner'})[0];assert.equal(later.status,'accepted');
 await assert.rejects(runtime.action({action:'workflow_request_update',personId:'mom',requestId:'request-one',status:'running'}));
});
test('Owner history search covers all matching records independently of brief sharing',t=>{
 const{runtime}=setup(t);for(let n=0;n<130;n++)runtime.store.addMessage('mom',{id:'m'+n,dir:n%2?'in':'out',text:n%20===0?'PPT 第二版 '+n:'普通原文 '+n});
 const history=createConversationHistory({store:runtime.store});let page=history.page({viewerPersonId:'owner',personId:'mom',query:'第二版',limit:3});assert.equal(page.total,7);assert.equal(page.messages.length,3);assert.equal(page.hasMore,true);assert.ok(page.messages.every(row=>row.text.includes('第二版')));
 page=history.page({viewerPersonId:'owner',personId:'mom',query:'第二版',before:page.nextCursor,limit:3});assert.equal(page.messages.length,3);
 runtime.store.updatePerson('mom',{shareWithOwner:'none'});const after=history.page({viewerPersonId:'owner',personId:'mom',query:'第二版'});assert.equal(after.total,7);assert.equal(after.messages.length,7);
});

test('trusted console native tasks work without a WeChat binding and keep their result in the console',async t=>{
 let starts=0;const{runtime}=setup(t,{ownerAgent:{listWorkspaces:async()=>[{workspaceId:'project',title:'资料项目',path:'/synthetic/project',sessionIds:[]}],start:async()=>{starts++;return{state:'succeeded',text:'控制台合成结果'};},observe:async()=>({state:'succeeded',text:'控制台合成结果'})}});
 const task=await runtime.action({action:'harness_submit',workspaceId:'project',text:'整理合成材料',requestId:'console-job'});await runtime.settled();
 assert.equal(starts,1);assert.equal(task.origin,'console');assert.equal(runtime.store.snapshot().outbox.length,0);assert.ok(runtime.status().workbench.messages.some(row=>row.text.includes('控制台合成结果')));
});

test('continuing a native console task reuses its Session, retains request identity history, and returns each result once',async t=>{
 const starts=[];const{runtime}=setup(t,{ownerAgent:{listWorkspaces:async()=>[{workspaceId:'project',title:'资料项目',path:'/synthetic/project',sessionIds:[]}],start:async intent=>{starts.push(intent);return{state:'succeeded',text:intent.prompt==='初稿'?'初稿结果':'第二版结果'};},observe:async()=>({state:'unknown'})}});
 const first=await runtime.action({action:'harness_submit',workspaceId:'project',text:'初稿',requestId:'first-turn'});await runtime.settled();
 const second=await runtime.action({action:'harness_continue',taskId:first.id,text:'第二版',requestId:'second-turn'});await runtime.settled();assert.equal(second.id,first.id);assert.equal(starts.length,2);assert.equal(starts[0].sessionId,starts[1].sessionId);assert.notEqual(starts[0].requestId,starts[1].requestId);
 await runtime.action({action:'harness_continue',taskId:first.id,text:'第二版',requestId:'second-turn'});await runtime.settled();assert.equal(starts.length,2);assert.equal(runtime.status().harness.tasks.length,1);assert.equal(runtime.status().harness.tasks[0].turns.length,1);
 const text=runtime.status().workbench.messages.map(row=>row.text).join('\n');assert.match(text,/初稿结果/);assert.match(text,/第二版结果/);assert.equal(runtime.store.snapshot().outbox.length,0);
});

test('a proactive-only tool can run on its confirmed daily schedule but the member cannot invoke it',async t=>{
 const outputs=[];const{runtime,directory}=setup(t,{toolExecutors:{ai_digest:async()=>{outputs.push('ran');return{text:'主动推送日报'};}}});runtime.store.bindPerson('mom',{accountId:'account',peerId:'peer-mom'});await runtime.start();
 await runtime.action({action:'tool_assign',personId:'mom',toolId:'ai_digest',resource:{workspaceId:'digest',relativePath:'latest.md'},allowInvoke:false,schedule:{enabled:true,time:'16:00',timeZone:'Asia/Shanghai'}});
 const box=createFamilyToolbox({directory,store:runtime.store,now,executors:{ai_digest:async()=>({text:'should not run'})}});await assert.rejects(box.invoke({personId:'mom',toolId:'ai_digest',requestId:'member-not-allowed'}),error=>error.code==='not_granted');
 await runtime.tick();await runtime.settled();assert.equal(outputs.length,1);assert.ok(runtime.store.snapshot().outbox.some(row=>row.text==='主动推送日报'&&row.status==='api_accepted'));
 await runtime.tick();await runtime.settled();assert.equal(outputs.length,1);
});
test('PPT tool assignment uses the existing presentation service and can send a real materials invitation',async t=>{
 const{runtime}=setup(t,{generatePresentation:async()=>({needsInput:true,reply:'请把分享主题和材料发给我。'}),extractMaterial:async()=>({name:'text',text:'材料'}),channelFactory:()=>({status:()=>({status:'connected'}),connect:async()=>{},disconnect:async()=>{},close:async()=>{},send:async()=>({status:'api_accepted'}),downloadFile:async()=>({name:'text',bytes:Buffer.from('材料')}),sendFile:async()=>({status:'api_accepted'})})});runtime.store.bindPerson('owner',{accountId:'owner',peerId:'peer-owner'});runtime.store.bindPerson('mom',{accountId:'mom',peerId:'peer-mom'});await runtime.start();
 await runtime.action({action:'tool_assign',personId:'mom',toolId:'presentation',resource:{workflow:'presentation'},allowInvoke:true});assert.equal(runtime.status().presentations.people.find(row=>row.personId==='mom').enabled,true);
 const result=await runtime.action({action:'tool_invoke',personId:'mom',toolId:'presentation',requestId:'ppt-invite'});assert.equal(result.status,'succeeded');assert.match(result.result.text,/材料|PPT/);assert.equal(result.deliveryStatus,'api_accepted');
 await runtime.action({action:'tool_assign',personId:'mom',toolId:'presentation',resource:{workflow:'presentation'},allowInvoke:false,schedule:null});assert.equal(runtime.status().presentations.people.find(row=>row.personId==='mom').enabled,false);
});

test('a family project task uses only its separate executor and checks live read/task/write scope',async t=>{
 let calls=0,nativeCalls=0;const sent=[];const{runtime}=setup(t,{familyProjectExecutor:{execute:async({authorize})=>{calls++;assert.equal(authorize({capability:'read'}),true);assert.equal(authorize({capability:'task'}),true);assert.equal(authorize({capability:'write'}),false);return{state:'succeeded',text:'只读项目合成结果'};}},ownerAgent:{listWorkspaces:async()=>[{workspaceId:'project',title:'家庭资料',path:'/synthetic/project',sessionIds:[]}],start:async()=>{nativeCalls++;return{state:'failed'};},observe:async()=>({state:'unknown'})},channelFactory:()=>({status:()=>({status:'connected'}),connect:async()=>{},disconnect:async()=>{},close:async()=>{},send:async(route,text)=>{sent.push({personId:route.personId,text});return{status:'api_accepted'};}})});runtime.store.bindPerson('mom',{accountId:'mom',peerId:'peer-mom'});await runtime.start();await runtime.action({action:'family_access_grant',personId:'mom',workspaceIds:['project'],capabilities:['read','task']});
 await runtime.receive('mom',{id:'family-task',peerId:'peer-mom',text:'在【家庭资料】项目执行：读一下本月安排。'});await runtime.settled();assert.equal(calls,1);assert.equal(nativeCalls,0);assert.ok(sent.some(row=>row.personId==='mom'&&row.text.includes('只读项目合成结果')));assert.ok(!sent.some(row=>row.personId==='owner'));
 assert.equal(runtime.status().harness.tasks[0].executor,'family_project');
});

test('history records only safe attachment display metadata and searches file names',async t=>{
 const{runtime}=setup(t);runtime.store.bindPerson('mom',{accountId:'mom',peerId:'peer-mom'});
 await runtime.receive('mom',{id:'file-in',peerId:'peer-mom',text:'这份分享材料',attachments:[{kind:'file',name:'养花分享第二版.docx',len:'1234',media:{aeskey:'never-expose'},url:'https://private.invalid'}]});
 const page=await runtime.action({action:'history_page',personId:'mom',query:'第二版'});assert.equal(page.messages.length,1);assert.deepEqual(page.messages[0].attachments,[{name:'养花分享第二版.docx',size:1234}]);assert.doesNotMatch(JSON.stringify(page),/aeskey|never-expose|private.invalid/);assert.equal(page.source.supportsAttachments,true);
});

test('Owner task overview reads saved family project conversations regardless of brief sharing',async t=>{
 const{runtime}=setup(t,{familyProjectExecutor:{execute:async()=>({state:'succeeded',text:'家人未分享的结果'})},ownerAgent:{listWorkspaces:async()=>[{workspaceId:'project',title:'家庭资料',path:'/synthetic/project',sessionIds:[]}]}});runtime.store.updatePerson('mom',{shareWithOwner:'none'});runtime.store.bindPerson('mom',{accountId:'mom',peerId:'peer-mom'});await runtime.start();await runtime.action({action:'family_access_grant',personId:'mom',workspaceIds:['project'],capabilities:['read','task']});
 await runtime.receive('mom',{id:'private-project',peerId:'peer-mom',text:'在【家庭资料】项目执行：这是家人未分享的私密请求'});await runtime.settled();const task=runtime.status().harness.tasks[0];assert.equal(task.contentAccess,'full');assert.match(JSON.stringify(task),/私密请求/);assert.match(JSON.stringify(task),/未分享的结果/);const checked=await runtime.action({action:'harness_task_status',taskId:task.id});assert.equal(checked.contentAccess,'full');assert.equal(runtime.store.person('mom').shareWithOwner,'none');
});

test('a family controlled project cancellation stops its executor and reports settled cancellation without claiming rollback',async t=>{
 let entered,done;const started=new Promise(resolve=>entered=resolve),finished=new Promise(resolve=>done=resolve);const{runtime}=setup(t,{familyProjectExecutor:{execute:async({signal})=>{entered();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{done();reject(new Error('cancelled'));},{once:true}));return{state:'succeeded',text:'must not return'};}},ownerAgent:{listWorkspaces:async()=>[{workspaceId:'project',title:'家庭资料',path:'/synthetic/project',sessionIds:[]}]}});runtime.store.bindPerson('mom',{accountId:'mom',peerId:'peer-mom'});await runtime.start();await runtime.action({action:'family_access_grant',personId:'mom',workspaceIds:['project'],capabilities:['read','task']});
 await runtime.receive('mom',{id:'cancel-project',peerId:'peer-mom',text:'在【家庭资料】项目执行：整理材料。'});await started;const task=runtime.status().harness.tasks[0];const result=await runtime.action({action:'harness_cancel',taskId:task.id});assert.equal(result.accepted,true);assert.equal(result.requiresNativeSession,false);await finished;await runtime.settled();assert.equal(runtime.status().harness.tasks[0].state,'cancelled');assert.match(runtime.status().harness.tasks[0].text,/保留|核对|已停止/);
});

test('controlled project files are truly delivered and can be downloaded by an authorized Owner',async t=>{
 const files=[];const bytes=Buffer.from('合成成果');const executor={execute:async()=>({state:'succeeded',text:'已整理成果',files:[{relativePath:'family-output/mom/result.md',name:'result.md'}]}),readArtifact:async({authorize})=>{assert.equal(authorize({capability:'read'}),true);return{name:'result.md',mimeType:'text/markdown',bytes};}};
 const{runtime}=setup(t,{familyProjectExecutor:executor,ownerAgent:{listWorkspaces:async()=>[{workspaceId:'project',title:'家庭资料',path:'/synthetic/project',sessionIds:[]}]},channelFactory:()=>({status:()=>({status:'connected'}),connect:async()=>{},disconnect:async()=>{},close:async()=>{},send:async()=>({status:'api_accepted'}),sendFile:async(route,file,options)=>{assert.equal(options.authorize(),true);files.push({personId:route.personId,name:file.name,text:file.bytes.toString(),clientId:options.clientId});return{status:'api_accepted'};}})});runtime.store.bindPerson('mom',{accountId:'mom',peerId:'peer-mom'});await runtime.start();await runtime.action({action:'family_access_grant',personId:'mom',workspaceIds:['project'],capabilities:['read','task','write']});await runtime.receive('mom',{id:'make-file',peerId:'peer-mom',text:'在【家庭资料】项目执行：写一份材料。'});await runtime.settled();assert.equal(files.length,1);assert.equal(files[0].personId,'mom');assert.equal(files[0].text,'合成成果');
 const task=runtime.status().harness.tasks[0];assert.equal(task.artifactDeliveries[0].status,'api_accepted');const download=await runtime.action({action:'harness_artifact',taskId:task.id,relativePath:'family-output/mom/result.md'});assert.equal(Buffer.from(download.dataBase64,'base64').toString(),'合成成果');
 runtime.store.updatePerson('mom',{shareWithOwner:'none'});const after=await runtime.action({action:'harness_artifact',taskId:task.id,relativePath:'family-output/mom/result.md'});assert.equal(Buffer.from(after.dataBase64,'base64').toString(),'合成成果');await runtime.action({action:'harness_task_status',taskId:task.id});await runtime.settled();assert.equal(files.length,1);
});

test('an uncertain controlled-project file receipt is durable and never automatically sent twice',async t=>{
 let sends=0;const executor={execute:async()=>({state:'succeeded',text:'已整理成果',files:[{relativePath:'family-output/mom/result.md',name:'result.md'}]}),readArtifact:async()=>({name:'result.md',mimeType:'text/markdown',bytes:Buffer.from('成果')})};
 const extra={familyProjectExecutor:executor,ownerAgent:{listWorkspaces:async()=>[{workspaceId:'project',title:'家庭资料',path:'/synthetic/project',sessionIds:[]}]},channelFactory:()=>({status:()=>({status:'connected'}),connect:async()=>{},disconnect:async()=>{},close:async()=>{},send:async()=>({status:'api_accepted'}),sendFile:async()=>{sends++;throw Object.assign(new Error('unknown'),{sendOutcome:'uncertain'});}})};
 const{runtime,directory}=setup(t,extra);runtime.store.bindPerson('mom',{accountId:'mom',peerId:'peer-mom'});await runtime.start();await runtime.action({action:'family_access_grant',personId:'mom',workspaceIds:['project'],capabilities:['read','task','write']});await runtime.receive('mom',{id:'unknown-file',peerId:'peer-mom',text:'在【家庭资料】项目执行：写一份材料。'});await runtime.settled();const task=runtime.status().harness.tasks[0];assert.equal(task.artifactDeliveries[0].status,'unknown');assert.equal(task.delivery.state,'unknown');await runtime.action({action:'harness_task_status',taskId:task.id});await runtime.tick();await runtime.settled();assert.equal(sends,1);
 await runtime.close();const restarted=createRuntime({directory,now,intervalMs:600000,...extra});t.after(()=>restarted.close());await restarted.start();await restarted.settled();assert.equal(sends,1);assert.equal(restarted.status().harness.tasks[0].artifactDeliveries[0].status,'unknown');
});


test('the actual bounded project factory reads, creates a personal result and sends that exact file through runtime',async t=>{
 const workspace=realpathSync(mkdtempSync(join(tmpdir(),'lele-real-project-')));t.after(()=>rmSync(workspace,{recursive:true,force:true}));writeFileSync(join(workspace,'notes.md'),'合成项目原文');let round=0;const sentFiles=[];
 const tool=(name,args,id)=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',index:0,id,name,argumentsDelta:JSON.stringify(args)},{type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}];
 const steps=[tool('read_project_file',{relativePath:'notes.md'},'read-one'),tool('write_project_note',{name:'summary.md',content:'基于合成原文的专属摘要'},'write-one'),[{type:'text-delta',index:0,text:'已根据资料创建专属摘要。'},{type:'finish',reason:{kind:'stop'}}]];
 const ownerAgent={listWorkspaces:async()=>[{workspaceId:'project',title:'家庭资料',path:workspace,sessionIds:[]}],start:async()=>{throw Error('Owner Agent must not run');},observe:async()=>({state:'unknown'})};
 const executor=createFamilyProjectExecutor({ownerAgent,llm:{async *stream(){for(const item of steps[round++])yield item;}},readConfig:()=>({provider:'synthetic',model:'bounded-test'})});
 const{runtime}=setup(t,{familyProjectExecutor:executor,ownerAgent,channelFactory:()=>({status:()=>({status:'connected'}),connect:async()=>{},disconnect:async()=>{},close:async()=>{},send:async()=>({status:'api_accepted'}),sendFile:async(route,file)=>{sentFiles.push({personId:route.personId,...file});return{status:'api_accepted'};}})});runtime.store.bindPerson('mom',{accountId:'mom',peerId:'peer-mom'});await runtime.start();await runtime.action({action:'family_access_grant',personId:'mom',workspaceIds:['project'],capabilities:['read','task','write']});await runtime.receive('mom',{id:'real-project',peerId:'peer-mom',text:'在【家庭资料】项目执行：读取 notes.md 并创建一份专属摘要。'});await runtime.settled();
 assert.equal(round,3);assert.equal(readFileSync(join(workspace,'family-output','mom','summary.md'),'utf8'),'基于合成原文的专属摘要');assert.equal(sentFiles.length,1);assert.equal(sentFiles[0].personId,'mom');assert.equal(sentFiles[0].bytes.toString(),'基于合成原文的专属摘要');const task=runtime.status().harness.tasks[0];assert.equal(task.state,'succeeded');assert.equal(task.artifactDeliveries[0].status,'api_accepted');
 const download=await runtime.action({action:'harness_artifact',taskId:task.id,relativePath:task.files[0].relativePath});assert.equal(Buffer.from(download.dataBase64,'base64').toString(),'基于合成原文的专属摘要');
});

test('a family member can naturally shorten their previous project task without a UUID and ordinary chat does not dispatch',async t=>{
 const prompts=[],plans=[];const{runtime}=setup(t,{planHarness:async context=>{plans.push(context);return{reply:'继续原任务',operation:{type:'continue_task',taskId:context.tasks[0].id}};},familyProjectExecutor:{execute:async({prompt,history})=>{prompts.push({prompt,history});return{state:'succeeded',text:prompts.length===1?'较长的原稿':'短版结果'};}},ownerAgent:{listWorkspaces:async()=>[{workspaceId:'project',title:'家庭资料',path:'/synthetic/project',sessionIds:[]}]},respond:async()=>({reply:'你好'})});runtime.store.bindPerson('mom',{accountId:'mom',peerId:'peer-mom'});await runtime.start();await runtime.action({action:'family_access_grant',personId:'mom',workspaceIds:['project'],capabilities:['read','task']});
 await runtime.receive('mom',{id:'natural-first',peerId:'peer-mom',text:'在【家庭资料】项目执行：整理一段文字。'});await runtime.settled();await runtime.receive('mom',{id:'natural-follow',peerId:'peer-mom',text:'再短一点'});await runtime.settled();assert.equal(prompts.length,2);assert.equal(prompts[1].prompt,'再短一点');assert.equal(prompts[1].history.length,1);assert.equal(runtime.status().harness.tasks.length,1);assert.equal(plans[0].tasks.length,1);assert.equal(plans[0].tasks[0].personId,'mom');
 await runtime.receive('mom',{id:'just-chat',peerId:'peer-mom',text:'你好'});await runtime.settled();assert.equal(prompts.length,2);assert.equal(plans.length,1);
});
