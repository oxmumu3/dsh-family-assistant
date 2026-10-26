import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';
import {createMemberAgent} from '../src/member-agent.mjs';
import {renderPresentation} from '../src/presentations.mjs';
import {createHash} from 'node:crypto';
async function fixture(t,{run,feedback,planHarness,extractMaterial,generatePresentation,agentFactory,beforeStart}={}){
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'member-agent-runtime-'))),sent=[],files=[],calls=[];let closes=0;
 const memberAgent=agentFactory?agentFactory(directory):{run:async input=>{calls.push(input);return run?run(input):{state:'succeeded',text:'合成的实际办理结果'};},snapshot:()=>({active:0}),close:async()=>{closes++;}};
 const runtime=createRuntime({directory,memberAgent,memberReportFeedback:feedback,extractMaterial,generatePresentation,planHarness,respond:async()=>({reply:'旧的聊天回复'}),channelFactory:()=>({status:()=>({status:'connected'}),connect:async()=>{},disconnect:async()=>{},close:async()=>{},downloadFile:async()=>({name:'材料.txt',bytes:Buffer.from('合成材料内容')}),sendFile:async(route,file,options)=>{assert.equal(options.authorize(),true);files.push({route,file});return{status:'api_accepted'};},send:async(route,text,options)=>{assert.equal(options.authorize(),true);sent.push({personId:route.personId,text});return{status:'api_accepted'};}})});
 for(const[id,role]of[['owner','owner'],['mom','elder'],['k','elder']]){runtime.store.addPerson({id,role,label:id});runtime.store.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id});}
 if(beforeStart)await beforeStart({runtime,memberAgent,directory});await runtime.start();t.after(async()=>{await runtime.close();rmSync(directory,{recursive:true,force:true});});
 const receive=async(text,id='test')=>{const result=await runtime.receive('mom',{id,peerId:'peer-mom',text});await runtime.settled();return result;};
 return{runtime,sent,files,calls,receive,get closes(){return closes;}};
}
test('a member without product tools gets a default agent and its plain result is delivered once',async t=>{
 const f=await fixture(t);await f.receive('帮我写一段活动致辞');await f.receive('帮我写一段活动致辞');
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].person.id,'mom');assert.equal(f.calls[0].route.peerId,'peer-mom');assert.deepEqual(f.sent,[{personId:'mom',text:'合成的实际办理结果'}]);
 assert.equal((await f.runtime.action({action:'family_access_list'})).find(x=>x.personId==='mom').workspaceIds.length,0);
});
test('report feedback bypasses product planning and sees the complete current-member accepted report only',async t=>{
 const f=await fixture(t,{planHarness:async()=>{throw Error('Report feedback must reach the default Agent');}});
 const accepted=(personId,text,key)=>{const r=f.runtime.store.enqueue({personId,text,kind:'digest_once',sourceKey:key});f.runtime.store.transition(r.id,'dispatching');f.runtime.store.transition(r.id,'api_accepted');};
 accepted('mom','AI 日报｜合成一期\n第一段','digest-once:synthetic:0');accepted('mom','第二段原文','digest-once:synthetic:1');accepted('k','PRIVATE_OTHER_REPORT','digest-once:other:0');
 f.runtime.store.enqueue({personId:'mom',text:'PRIVATE_PENDING_REPORT',kind:'digest_once',sourceKey:'digest-once:pending:0'});
 await f.receive('AI日报太难了，改成三条');assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].reports.length,1);assert.match(f.calls[0].reports[0].text,/第一段[\s\S]*第二段/);assert.doesNotMatch(JSON.stringify(f.calls[0].reports),/PRIVATE_OTHER|PRIVATE_PENDING/);
});
test('long plain agent work is split without losing the tail or rerunning the task',async t=>{
 const text='内容'.repeat(3500)+'结尾';const f=await fixture(t,{run:async()=>({state:'succeeded',text})});await f.receive('写一份长稿');assert.equal(f.sent.map(x=>x.text).join(''),text);assert(f.sent.length>=3);assert(f.sent.every(x=>x.text.length<=3000));
});
test('the file callback uses the captured binding and records actual accepted attachment metadata',async t=>{
 const f=await fixture(t,{run:async input=>{const value=await input.deliverFile({name:'稿件.md',bytes:Buffer.from('合成正文'),clientId:'synthetic-file',signal:input.signal,authorize:async()=>true});assert.equal(value.status,'api_accepted');return{state:'succeeded',text:'文件已提交微信接口'};}});
 await f.receive('写成文件给我');assert.equal(f.files.length,1);assert.equal(f.files[0].route.peerId,'peer-mom');assert(f.runtime.store.messages('mom').some(x=>x.attachments?.[0]?.name==='稿件.md'));
});
test('generic text attachments are analyzed as member material instead of forcing PPT enrollment',async t=>{
 const f=await fixture(t,{extractMaterial:async({bytes})=>({name:'材料.txt',text:bytes.toString()})});
 await f.runtime.receive('mom',{id:'file-analysis',peerId:'peer-mom',text:'帮我解释这份材料',attachments:[{name:'材料.txt',download:'synthetic'}]});await f.runtime.settled();assert.equal(f.calls.length,1);assert.equal(f.calls[0].materials[0].text,'合成材料内容');
});
test('an in-flight default agent cannot send after rebind and closes with the runtime',async t=>{
 let release,entered;const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r);const f=await fixture(t,{run:async()=>{entered();await wait;return{state:'succeeded',text:'不可跨新绑定发送'};}});
 const pending=f.receive('慢慢写');const reached=await Promise.race([started.then(()=>true),pending.then(()=>false)]);assert.equal(reached,true);f.runtime.store.bindPerson('mom',{accountId:'new-account',peerId:'new-peer'});release();await pending;assert.equal(f.sent.length,0);await f.runtime.close();assert.equal(f.closes,1);
});
test('an Owner help callback rechecks binding after awaiting model authorization',async t=>{
 let f;f=await fixture(t,{run:async input=>{await assert.rejects(()=>input.requestOwnerHelp({text:'请帮我联系Owner',evidence:'请帮我联系Owner',reason:'缺资料',requestId:'help-race',authorize:async()=>{f.runtime.store.bindPerson('mom',{accountId:'replacement',peerId:'replacement'});return true;}}));return{state:'failed',text:'已停止'};}});
 await f.receive('请帮我联系Owner');assert.equal((await f.runtime.action({action:'workflow_requests'})).length,0);
});
test('a real member task is admitted before polling returns and progress/cancel do not wait on its model',async t=>{
 let entered,calls=0;const started=new Promise(resolve=>entered=resolve);
 const f=await fixture(t,{agentFactory:directory=>createMemberAgent({directory,readConfig:()=>({provider:'fixture',model:'fixture'}),llm:{async *stream(options){calls++;entered();await new Promise((resolve,reject)=>{if(options.signal.aborted)reject(options.signal.reason);else options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});}}})});
 const accepted=await f.runtime.receive('mom',{id:'long',peerId:'peer-mom',text:'帮我慢慢写一份活动致辞'});assert.equal(accepted.queued,true);await started;
 assert.equal(f.runtime.status().memberAgent.active,1);
 const progress=await f.runtime.receive('mom',{id:'progress',peerId:'peer-mom',text:'进度'});assert.equal(progress.control,true);assert.match(f.sent.at(-1).text,/处理中/);
 const stopped=await f.runtime.receive('mom',{id:'stop',peerId:'peer-mom',text:'停止刚才的任务'});assert.equal(stopped.control,true);await f.runtime.settled();
 assert.equal(calls,1);assert.match(f.sent.at(-1).text,/停止/);assert.equal(f.runtime.status().memberAgent.active,0);assert.equal(f.sent.length,2);
});
test('a completed PPT does not capture a later ordinary document analysis request',async t=>{
 let generations=0;const f=await fixture(t,{extractMaterial:async({bytes})=>({name:'材料.txt',text:bytes.toString()}),generatePresentation:async()=>{generations++;const deck={title:'合成活动',slides:[{title:'安排',bullets:['仅供本地合成验证。']}]};return{deck,...await renderPresentation(deck)};}});
 await f.receive('做一份PPT：合成活动','ppt');assert.equal(f.files.length,1);assert.equal(generations,1);
 await f.runtime.receive('mom',{id:'ordinary-document',peerId:'peer-mom',text:'帮我看看这个文档讲了什么',attachments:[{name:'材料.txt',download:'synthetic'}]});await f.runtime.settled();
 assert.equal(generations,1);assert.equal(f.files.length,1);assert.equal(f.calls.length,1);assert.equal(f.calls[0].materials[0].text,'合成材料内容');
});
test('startup resumes a durable unstarted file request without exposing its transport descriptor to the model',async t=>{
 let payload,calls=0;
 const f=await fixture(t,{extractMaterial:async({bytes})=>({name:'材料.txt',text:bytes.toString()}),agentFactory:directory=>createMemberAgent({directory,readConfig:()=>({provider:'fixture',model:'fixture'}),llm:{async *stream(options){calls++;payload=JSON.parse(options.messages[0].content[0].text);yield{type:'text-delta',index:0,text:'合成材料已整理'};yield{type:'finish',reason:{kind:'stop'}};}}}),beforeStart:async({runtime,directory})=>{
  const seeder=createMemberAgent({directory,readConfig:()=>({provider:'fixture',model:'fixture'})}),person=runtime.store.person('mom'),route=runtime.store.route('mom'),messageId='prepared-file',requestId='wechat-'+createHash('sha256').update(JSON.stringify([route,messageId])).digest('hex');
  seeder.prepare({person,route,text:'解释这个文档',requestId,admissionKey:'durable-source-key',source:{messageId,attachments:[{name:'材料.txt',transportSecret:'SYNTHETIC_TRANSPORT_DO_NOT_LEAK'}]},authorize:()=>true});await seeder.close();
 }});
 await f.runtime.settled();assert.equal(calls,1);assert.equal(f.sent[0].text,'合成材料已整理');assert.equal(payload.materials[0].text,'合成材料内容');assert.doesNotMatch(JSON.stringify(payload),/SYNTHETIC_TRANSPORT/);assert(f.runtime.store.messages('mom').some(row=>row.id==='prepared-file'));
 await f.runtime.start();await f.runtime.settled();assert.equal(calls,1);assert.equal(f.sent.length,1);
});
test('startup drains more than twenty durable unstarted member requests once without another reconnect',async t=>{
 let calls=0;
 const f=await fixture(t,{agentFactory:directory=>createMemberAgent({directory,readConfig:()=>({provider:'fixture',model:'fixture'}),llm:{async *stream(){calls++;yield{type:'text-delta',index:0,text:'合成积压任务已完成'};yield{type:'finish',reason:{kind:'stop'}};}}}),beforeStart:async({runtime,directory})=>{
  const seeder=createMemberAgent({directory,readConfig:()=>({provider:'fixture',model:'fixture'})}),person=runtime.store.person('mom'),route=runtime.store.route('mom');
  for(let index=0;index<21;index++){
   const messageId='durable-backlog-'+index,requestId='wechat-'+createHash('sha256').update(JSON.stringify([route,messageId])).digest('hex');
   seeder.prepare({person,route,text:'整理本人的合成稿件 '+index,requestId,admissionKey:'durable-backlog-key-'+index,source:{messageId},authorize:()=>true});
  }
  await seeder.close();
 }});
 await f.runtime.settled();assert.equal(calls,21);assert.equal(f.sent.length,21);assert.equal(f.runtime.status().memberAgent.prepared,0);
 await f.runtime.start();await f.runtime.tick();await f.runtime.settled();assert.equal(calls,21);assert.equal(f.sent.length,21);
});
test('failed attachment extraction closes its prepared task and startup never retries it automatically',async t=>{
 let agent,extracts=0,calls=0;
 const f=await fixture(t,{extractMaterial:async()=>{extracts++;throw new Error('合成文件无法提取文字');},agentFactory:directory=>agent=createMemberAgent({directory,readConfig:()=>({provider:'fixture',model:'fixture'}),llm:{async *stream(){calls++;yield{type:'text-delta',index:0,text:'不应开始模型处理'};yield{type:'finish',reason:{kind:'stop'}};}}})});
 const message={id:'failed-material',peerId:'peer-mom',text:'解释本人的这个文档',attachments:[{name:'材料.txt',download:'synthetic'}]};
 assert.equal((await f.runtime.receive('mom',message)).queued,true);await f.runtime.settled();
 const task=()=>agent.status({person:f.runtime.store.person('mom'),route:f.runtime.store.route('mom'),authorize:()=>true});
 assert.equal(extracts,1);assert.equal(calls,0);assert.equal(task().state,'failed');assert.equal(f.runtime.status().memberAgent.prepared,0);
 assert(f.runtime.store.messages('mom').some(row=>row.id===message.id));assert.match(f.sent.at(-1).text,/材料|保留|没有完成/);
 await f.runtime.start();await f.runtime.tick();await f.runtime.settled();await f.runtime.receive('mom',message);await f.runtime.settled();
 assert.equal(extracts,1);assert.equal(calls,0);assert.equal(task().state,'failed');assert.equal(f.sent.length,1);
});
