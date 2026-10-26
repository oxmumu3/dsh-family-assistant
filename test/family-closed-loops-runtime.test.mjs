import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRuntime} from '../src/runtime.mjs';
import {createFamilyToolbox} from '../src/family-toolbox.mjs';

async function fixture(t,extra={}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'lele12-loops-'))),sent=[],files=[];
 const make=()=>createRuntime({directory:join(root,'private'),intervalMs:600000,ownerTaskArtifacts:{collect:async()=>[]},respond:async()=>({reply:'普通回复'}),...extra,
  channelFactory:()=>({connect:async()=>{},disconnect:async()=>{},close:async()=>{},status:()=>({status:'connected'}),send:async(route,text,options)=>{assert.equal(options.authorize(),true);sent.push({personId:route.personId,text});return{status:'api_accepted'};},sendFile:async(route,file,options)=>{assert.equal(options.authorize(),true);files.push({personId:route.personId,...file});return{status:'api_accepted'};}})});
 let runtime=make();for(const[id,role,label]of[['owner','owner','我'],['mom','elder','妈妈'],['dad','elder','爸爸']]){runtime.store.addPerson({id,role,label});runtime.store.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id});}await runtime.start();
 t.after(async()=>{await runtime.close();rmSync(root,{recursive:true,force:true});});
 return{root,get runtime(){return runtime;},sent,files,async restart(){await runtime.close();runtime=make();await runtime.start();}};
}
const incoming=(f,who,id,text)=>f.runtime.receive(who,{id,peerId:'peer-'+who,text});

test('a WeChat message confirmation addresses the current message card rather than an older incomplete daily draft',async t=>{
 const f=await fixture(t,{ownerAgent:{listWorkspaces:async()=>[{workspaceId:'family',title:'家庭资料',path:'/tmp/synthetic-family'}]},digestSources:async()=>[{relativePath:'reports/2026-10-25-wechat.txt',bytes:100,updatedAt:'2026-10-25T14:00:00Z'}],planWorkbench:async({text,cards})=>text==='确认安排'?{reply:'核对后执行',operation:{type:'confirm',cardId:cards.at(-1).id}}:{reply:'请核对',operation:{type:'plan',actions:[{type:'send_message',personId:'dad',text:'周六见'}]}}});
 await incoming(f,'owner','daily-first','给妈妈每天早上发AI日报');
 await incoming(f,'owner','message-next','给爸爸发一条消息，说周六见');
 await incoming(f,'owner','message-confirm','确认安排');await f.runtime.settled();
 assert.equal(f.sent.filter(row=>row.personId==='dad'&&row.text.includes('周六见')).length,1,JSON.stringify({sent:f.sent,workbench:f.runtime.status().workbench,serviceSetup:f.runtime.status().serviceSetup,error:f.runtime.status().lastError}));
 assert.equal(f.runtime.store.person('mom').dailyEnabled,false);
});

test('a member workflow request notifies Owner and an explicit Owner response returns only to the member, including follow-up',async t=>{
 const f=await fixture(t);await incoming(f,'mom','want-tool','申请工具：我想每周整理一次菜谱');await f.runtime.settled();
 const notice=f.sent.find(row=>row.personId==='owner'&&row.text.includes('菜谱'));assert.ok(notice,'Owner must receive the actual new request');
 const shortId=notice.text.match(/wf-[a-f0-9]{12}/)?.[0];assert.ok(shortId);
 await incoming(f,'owner','respond-tool',`回复需求 ${shortId}：可以，周末先用你的菜单试一轮`);await f.runtime.settled();
 assert.equal(f.sent.filter(row=>row.personId==='mom'&&row.text.includes('周末先用你的菜单')).length,1);
 assert.equal(f.sent.some(row=>row.personId==='dad'&&row.text.includes('菜单')),false);
 await incoming(f,'mom','extra-tool',`补充需求 ${shortId}：希望附上采购清单`);await f.runtime.settled();
 assert.equal(f.sent.filter(row=>row.personId==='owner'&&row.text.includes('采购清单')).length,1);
 const before=f.sent.length;await incoming(f,'mom','extra-tool',`补充需求 ${shortId}：希望附上采购清单`);await f.restart();await f.runtime.tick();assert.equal(f.sent.length,before);
});
test('the existing console workflow update sends its explicit note back through the same scoped route',async t=>{
 const f=await fixture(t);await incoming(f,'mom','want-console','申请工作流：周末菜单');
 const requests=await f.runtime.action({action:'workflow_requests'}),request=requests[0];assert.ok(request);
 await f.runtime.action({action:'workflow_request_update',personId:'mom',requestId:request.requestId,status:'accepted',note:'先用上周菜单来做',operationId:'respond-console'});await f.runtime.settled();
 assert.equal(f.sent.filter(row=>row.personId==='mom'&&row.text.includes('先用上周菜单')).length,1);
});
test('replaying an earlier pure status update does not roll a workflow request back after a newer update or restart',async t=>{
 const f=await fixture(t);await incoming(f,'mom','status-request','申请工具：周末菜单');const request=(await f.runtime.action({action:'workflow_requests'}))[0];
 const first={action:'workflow_request_update',personId:'mom',requestId:request.requestId,status:'accepted',operationId:'status-first'};
 await f.runtime.action(first);await f.runtime.action({...first,status:'completed',operationId:'status-second'});const before=f.sent.length;
 await f.restart();await f.runtime.action(first);const current=(await f.runtime.action({action:'workflow_requests'}))[0];assert.equal(current.status,'completed');assert.equal(f.sent.length,before);
});
test('a conflicting console chat request identity is rejected before a workflow response can send',async t=>{
 const f=await fixture(t);await incoming(f,'mom','chat-conflict-request','申请工具：周末菜单');const shortId=f.sent.find(row=>row.personId==='owner')?.text.match(/wf-[a-f0-9]{12}/)?.[0];assert.ok(shortId);
 await f.runtime.action({action:'owner_chat',text:'你能帮我做什么',requestId:'same-chat-id'});
 await assert.rejects(f.runtime.action({action:'owner_chat',text:`回复需求 ${shortId}：下一周尝试`,requestId:'same-chat-id'}),/重复|不同/);
 assert.equal(f.sent.some(row=>row.personId==='mom'&&row.text.includes('下一周尝试')),false);
});
test('legacy workflow notes remain local and old operation replay cannot overwrite newer progress',async t=>{
 const f=await fixture(t),box=createFamilyToolbox({directory:join(f.root,'private'),store:f.runtime.store});box.requestWorkflow({personId:'mom',requestId:'legacy-no-anchor',text:'旧工具需求'});
 const first={action:'workflow_request_update',personId:'mom',requestId:'legacy-no-anchor',status:'accepted',note:'旧说明',operationId:'legacy-update-one'};
 await f.runtime.action(first);await f.runtime.action({...first,status:'completed',note:'新说明',operationId:'legacy-update-two'});await f.restart();await f.runtime.action(first);
 const row=(await f.runtime.action({action:'workflow_requests'})).find(row=>row.requestId==='legacy-no-anchor');assert.equal(row.status,'completed');assert.equal(row.note,'新说明');assert.equal(f.sent.length,0);
});
test('an authenticated console Owner can designate a distinct family recipient without granting project access',async t=>{
 let starts=0;const ownerAgent={listWorkspaces:async()=>[{workspaceId:'family',title:'家庭资料',path:'/tmp/synthetic-family'}],start:async task=>{starts++;assert.equal(task.personId,'owner');return{state:'succeeded',text:'这份材料已整理好。'};},observe:async()=>({state:'succeeded',text:'这份材料已整理好。'})};
 const f=await fixture(t,{ownerAgent});const task=await f.runtime.action({action:'harness_submit',workspaceId:'family',text:'整理这份材料',recipientPersonId:'mom',requestId:'separate-recipient'});await f.runtime.settled();
 assert.equal(starts,1);assert.equal(f.sent.filter(row=>row.personId==='mom'&&row.text.includes('这份材料已整理好')).length,1);
 assert.equal(f.sent.some(row=>row.personId==='dad'),false);
 const result=await f.runtime.action({action:'harness_task_status',taskId:task.id});assert.equal(result.personId,'owner');assert.equal(result.deliveryTarget.personId,'mom');
 assert.equal((await f.runtime.action({action:'family_access_list'})).some(row=>row.workspaceIds?.length),false);
 await f.runtime.action({action:'harness_submit',workspaceId:'family',text:'整理这份材料',recipientPersonId:'mom',requestId:'separate-recipient'});await f.restart();await f.runtime.tick();assert.equal(starts,1);assert.equal(f.sent.filter(row=>row.personId==='mom'&&row.text.includes('这份材料已整理好')).length,1);
});
test('the explicit WeChat project command captures its named recipient and returns the actual result there',async t=>{
 const f=await fixture(t,{ownerAgent:{listWorkspaces:async()=>[{workspaceId:'family',title:'家庭资料',path:'/tmp/synthetic-family'}],start:async()=>({state:'succeeded',text:'周末活动安排已整理。'}),observe:async()=>({state:'succeeded',text:'周末活动安排已整理。'})}});
 await incoming(f,'owner','delegate-project','在【家庭资料】项目执行：整理周末活动安排，把结果发给妈妈');await f.runtime.settled();
 assert.equal(f.sent.filter(row=>row.personId==='mom'&&row.text.includes('周末活动安排已整理')).length,1);
 assert.equal(f.sent.filter(row=>row.personId==='owner'&&row.text.includes('周末活动安排已整理')).length,0);
 assert.ok(f.sent.some(row=>row.personId==='owner'&&/妈妈/.test(row.text)));
});
for(const instruction of ['整理材料，结果不要发给妈妈','整理材料，不给妈妈发结果','整理材料，如果她同意再把结果发给妈妈','整理材料，如果她同意，再给妈妈发结果','分析这个示例：“把结果发给妈妈”'])test(`a routing-only delivery phrase does not override its actual context: ${instruction}`,async t=>{
 const f=await fixture(t,{ownerAgent:{listWorkspaces:async()=>[{workspaceId:'family',title:'家庭资料',path:'/tmp/synthetic-family'}],start:async()=>({state:'succeeded',text:'仅在原会话返回的结果'}),observe:async()=>({state:'succeeded',text:'仅在原会话返回的结果'})}});
 await incoming(f,'owner','context-sensitive','在【家庭资料】项目执行：'+instruction);await f.runtime.settled();assert.equal(f.sent.some(row=>row.personId==='mom'),false);
});
test('a named recipient receives actual native output bytes and Owner can download the same verified artifact',async t=>{
 const project=realpathSync(mkdtempSync(join(tmpdir(),'lele12-owner-project-')));t.after(()=>rmSync(project,{recursive:true,force:true}));
 const bytes=Buffer.from('周末活动安排\n周六上午去公园。\n');
 const ownerAgent={listWorkspaces:async()=>[{workspaceId:'family',title:'家庭资料',path:project}],start:async task=>{const path=join(project,task.artifactScope.relativeDirectory);mkdirSync(path,{recursive:true});writeFileSync(join(path,'活动安排.md'),bytes);return{state:'succeeded',text:'活动安排已整理，文稿见随附文件。'};},observe:async()=>({state:'succeeded',text:'活动安排已整理。'})};
 const {createOwnerTaskArtifacts}=await import('../src/owner-task-artifacts.mjs');
 const f=await fixture(t,{ownerAgent,ownerTaskArtifacts:createOwnerTaskArtifacts({ownerAgent})});
 const task=await f.runtime.action({action:'harness_submit',workspaceId:'family',text:'整理周末活动安排',recipientPersonId:'mom',requestId:'real-artifact'});await f.runtime.settled();
 assert.equal(f.files.length,1,JSON.stringify({sent:f.sent,tasks:f.runtime.status().harness.tasks,error:f.runtime.status().lastError}));assert.equal(f.files[0].personId,'mom');assert.deepEqual(f.files[0].bytes,bytes);
 const completed=await f.runtime.action({action:'harness_task_status',taskId:task.id});assert.equal(completed.files.length,1);
 const download=await f.runtime.action({action:'harness_artifact',taskId:task.id,relativePath:completed.files[0].relativePath});assert.deepEqual(Buffer.from(download.dataBase64,'base64'),bytes);
 const before=f.files.length;await f.restart();await f.runtime.tick();assert.equal(f.files.length,before);
});
test('an interrupted result delivery cannot resume a leftover pending result during restart ticks',async t=>{
 const f=await fixture(t,{ownerAgent:{listWorkspaces:async()=>[{workspaceId:'family',title:'家庭资料',path:'/tmp/synthetic-family'}],start:async()=>({state:'succeeded',text:'先前已提交的结果'}),observe:async()=>({state:'succeeded',text:'先前已提交的结果'})}});
 const task=await f.runtime.action({action:'harness_submit',workspaceId:'family',text:'整理材料',recipientPersonId:'mom',requestId:'interrupted-native'});await f.runtime.settled();
 const full=f.runtime.status().harness.tasks.find(row=>row.id===task.id);
 const row=f.runtime.store.enqueue({personId:'mom',kind:'harness_result',text:'未确认的遗留正文',sourceKey:`harness-task:${task.id}:${full.requestId}:99`});
 const file=join(f.root,'private','harness-tasks.json'),saved=JSON.parse(readFileSync(file,'utf8'));saved.tasks.find(row=>row.id===task.id).delivery={state:'unknown'};writeFileSync(file,JSON.stringify(saved));
 await f.restart();await f.runtime.tick();assert.equal(f.sent.some(row=>row.text.includes('未确认的遗留正文')),false);assert.equal(f.runtime.store.snapshot().outbox.find(item=>item.id===row.id).status,'cancelled');
});
