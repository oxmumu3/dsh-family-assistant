import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';

const deck={title:'合成活动汇报',slides:[{title:'活动安排',bullets:['周五在活动室集合']}]};
async function setup(t,options={}){
 const directory=mkdtempSync(join(tmpdir(),'family-ppt-workflow-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const store=createStore({directory});for(const id of ['mom','dad']){store.addPerson({id,role:'elder',label:id});store.bindPerson(id,{accountId:'a-'+id,peerId:'p-'+id});}
 const sent=[],calls=[];let current=true;
 const {createPresentationWorkflow}=await import('../src/presentation-workflow.mjs');
 const generate=options.generate??(async input=>{calls.push(input);return{reply:'已制作',deck,bytes:Buffer.from('synthetic-deck'),name:'汇报.pptx'};});
 const workflow=createPresentationWorkflow({directory,store,generate,extract:({name,bytes})=>({name,text:bytes.toString()}),download:async(_r,a)=>({name:a.name,bytes:Buffer.from(a.content)}),send:async(r,file,opts)=>{assert(opts.authorize());sent.push({route:r,name:file.name,bytes:file.bytes});if(options.send) return options.send();return{status:'api_accepted'};}});
 const run=(id,text,messageId=String(calls.length+sent.length+Math.random()),attachments=[])=>workflow.handle({person:store.person(id),route:store.route(id),message:{id:messageId,text,attachments},authorize:()=>current,signal:new AbortController().signal});
 return{directory,store,workflow,run,sent,calls,revoke:()=>current=false};
}
test('service is opt-in and material-only messages do not invoke generation',async t=>{
 const f=await setup(t);assert.equal((await f.run('mom','帮我做PPT')).handled,false);
 f.workflow.configure('mom',true);
 const collected=await f.run('mom','','file-1',[{name:'材料.txt',content:'只给妈妈的活动安排'}]);
 assert.equal(collected.handled,true);assert.match(collected.reply,/材料/);assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);
 await f.run('mom','帮我做成一页PPT','m1');assert.equal(f.sent.length,1);assert.equal(f.sent[0].route.personId,'mom');assert.match(f.calls[0].materials[0].text,/只给妈妈/);
 await f.run('mom','帮我做成一页PPT','m1');assert.equal(f.sent.length,1);
 assert.doesNotMatch(JSON.stringify(f.workflow.snapshot()),/只给妈妈|合成活动汇报/);
 f.store.updatePerson('mom',{shareWithOwner:'full'});assert.match(JSON.stringify(f.workflow.snapshot()),/合成活动汇报/);
});
test('same-member revision receives the previous deck; another member does not',async t=>{
 const f=await setup(t);f.workflow.configure('mom',true);f.workflow.configure('dad',true);
 await f.run('mom','做个PPT：周五活动');await f.run('mom','第三页再短一点');await f.run('dad','做个PPT：另一个活动');
 assert.deepEqual(f.calls[1].previous,deck);assert.equal(f.calls[2].previous,undefined);assert(!JSON.stringify(f.calls[2]).includes('周五活动'));
 assert.equal(f.workflow.snapshot().tasks.filter(t=>t.personId==='mom').length,1);
 assert.equal(f.workflow.snapshot().tasks.find(t=>t.personId==='mom').version,2);
});
test('revocation while generating prevents dispatch and new binding cannot retrieve old task',async t=>{
 let done;const gate=new Promise(r=>done=r);const f=await setup(t,{generate:async()=>{await gate;return{deck,bytes:Buffer.from('d'),name:'d.pptx',reply:'ok'};}});f.workflow.configure('mom',true);
 const pending=f.run('mom','做PPT：活动');await new Promise(r=>setImmediate(r));f.workflow.configure('mom',false);done();await pending;assert.equal(f.sent.length,0);
 f.workflow.configure('mom',true);f.store.bindPerson('mom',{accountId:'new',peerId:'new'});
 const result=await f.run('mom','继续上一份PPT');assert.match(result.reply,/没有|找不到|新/);assert.equal(f.sent.length,0);
});
test('unknown file delivery is retained and never auto-retried on restart or casual retry',async t=>{
 const f=await setup(t,{send:()=>{throw Object.assign(new Error('unconfirmed'),{sendOutcome:'uncertain'});}});f.workflow.configure('mom',true);
 await f.run('mom','帮我做PPT：活动');assert.equal(f.workflow.snapshot().tasks[0].status,'uncertain');
 const r=await f.run('mom','重试');assert.match(r.reply,/确认|可能|核对/);assert.equal(f.sent.length,1);
 const {createPresentationWorkflow}=await import('../src/presentation-workflow.mjs');const restored=createPresentationWorkflow({directory:f.directory,store:f.store,generate:async()=>assert.fail('must not run')});
 assert.equal(restored.snapshot().tasks[0].status,'uncertain');assert.equal(f.sent.length,1);
});
test('crash recovery preserves versions; collecting request and clarification survive restart',async t=>{
 let inputs=0;const f=await setup(t,{generate:async()=>++inputs===1?{needsInput:true,reply:'请告诉我用途。'}:{deck,bytes:Buffer.from('d'),name:'d.pptx'}});f.workflow.configure('mom',true);
 await f.run('mom','帮我做PPT');assert.equal(f.workflow.snapshot().tasks[0].status,'collecting');
 await f.run('mom','社区活动介绍');assert.equal(f.workflow.snapshot().tasks[0].version,1);
 const file=join(f.directory,'presentations.json'),state=JSON.parse(readFileSync(file));state.tasks[0].status='generating';writeFileSync(file,JSON.stringify(state));
 const {createPresentationWorkflow}=await import('../src/presentation-workflow.mjs');const restored=createPresentationWorkflow({directory:f.directory,store:f.store});
 assert.equal(restored.snapshot().tasks[0].status,'interrupted');assert.equal(restored.snapshot().tasks[0].version,1);
});
test('paused/rebound route and oversized materials fail before file delivery',async t=>{
 const f=await setup(t);f.workflow.configure('mom',true);f.revoke();await f.run('mom','做PPT：活动');assert.equal(f.sent.length,0);assert.equal(f.calls.length,0);
});

test('material-only follow-up continues the already stated request without repeating intake',async t=>{
 let calls=0;const f=await setup(t,{generate:async input=>{calls++;return input.materials.length?{deck,bytes:Buffer.from('d'),name:'d.pptx'}:{needsInput:true,reply:'请发需要整理的材料。'};}});
 f.workflow.configure('mom',true);await f.run('mom','把材料做成八页PPT');
 await f.run('mom','','material-followup',[{name:'材料.txt',content:'合成完整材料'}]);
 assert.equal(calls,2);assert.equal(f.sent.length,1);
});
test('natural progress query reads the ongoing task without another model call',async t=>{
 const f=await setup(t);f.workflow.configure('mom',true);await f.run('mom','做个PPT：活动');
 for(const question of ['做好了吗','进度','做完了吗']){const answer=await f.run('mom',question);assert.equal(answer.handled,true);assert.match(answer.reply,/文件已提交/);}
 assert.equal(f.calls.length,1);assert.equal(f.sent.length,1);
});
test('uncertain delivery cannot be resent by vague continuation or a natural resend phrase',async t=>{
 const f=await setup(t,{send:()=>{throw Object.assign(new Error('unknown'),{sendOutcome:'uncertain'});}});f.workflow.configure('mom',true);
 await f.run('mom','做PPT：活动');
 for(const text of ['继续','接着做','重新发送PPT','再发一遍PPT']){const answer=await f.run('mom',text);assert.match(answer.reply,/核对|确认/);}
 assert.equal(f.sent.length,1);assert.equal(f.calls.length,1);
 await f.run('mom','确认重新发送');assert.equal(f.sent.length,2);assert.equal(f.calls.length,1);
});
test('an orphan artifact from a crash does not block the next version or leak a filesystem path',async t=>{
 const f=await setup(t);f.workflow.configure('mom',true);await f.run('mom','做PPT：活动');
 const stateFile=join(f.directory,'presentations.json'),state=JSON.parse(readFileSync(stateFile));state.tasks[0].status='generating';writeFileSync(stateFile,JSON.stringify(state));
 writeFileSync(join(f.directory,'presentation-files',state.tasks[0].id+'-v2.pptx'),Buffer.from('orphan output'));
 const {createPresentationWorkflow}=await import('../src/presentation-workflow.mjs');let sent=0;
 const restored=createPresentationWorkflow({directory:f.directory,store:f.store,generate:async()=>({deck,bytes:Buffer.from('d'),name:'d.pptx'}),extract:()=>{},download:()=>{},send:async()=>{sent++;return{status:'api_accepted'};}});
 const result=await restored.handle({person:f.store.person('mom'),route:f.store.route('mom'),message:{id:'resume-after-crash',text:'继续'}});
 assert.equal(sent,1);assert.equal(restored.snapshot().tasks[0].version,2);assert.doesNotMatch(result.reply,/EEXIST|\/var\/|presentation-files/);
});
test('deferred intake durably saves instructions and material descriptors before preparation and recovers without auto dispatch',async t=>{
 const f=await setup(t);f.workflow.configure('mom',true);
 const prepared=await f.workflow.handle({person:f.store.person('mom'),route:f.store.route('mom'),message:{id:'deferred',text:'做成八页PPT',attachments:[{name:'材料.txt',content:'合成材料已保存'}]},defer:true});
 assert.equal(f.calls.length,0);assert.equal(typeof prepared.run,'function');
 const saved=JSON.parse(readFileSync(join(f.directory,'presentations.json')));assert.equal(saved.tasks[0].status,'queued');assert.match(saved.tasks[0].instructions[0],/八页/);assert.equal(saved.tasks[0].materials.length,0);assert.equal(saved.tasks[0].pendingMaterials[0].attachment.content,'合成材料已保存');assert.equal(saved.inputs[0].status,'planned');
 const {createPresentationWorkflow}=await import('../src/presentation-workflow.mjs');const restored=createPresentationWorkflow({directory:f.directory,store:f.store});
 assert.equal(restored.snapshot().tasks[0].status,'interrupted');assert.equal(f.sent.length,0);
});
test('cancelling before a deferred run invalidates it even after a new request starts',async t=>{
 const f=await setup(t);f.workflow.configure('mom',true);const person=f.store.person('mom'),route=f.store.route('mom');
 const old=await f.workflow.handle({person,route,message:{id:'queued-old',text:'做PPT：旧任务'},defer:true});
 f.workflow.cancelIfRequested('mom',route,'取消PPT');
 await f.run('mom','新做一份PPT：新任务','queued-new');await old.run();
 assert.equal(f.sent.length,1);assert.equal(f.calls.length,1);assert.match(f.calls[0].request,/新任务/);
});
test('a model that finishes after pause leaves an interrupted task instead of a permanently generating one',async t=>{
 let release;const gate=new Promise(r=>release=r);const f=await setup(t,{generate:async()=>{await gate;return{deck,bytes:Buffer.from('d'),name:'d.pptx'};}});f.workflow.configure('mom',true);
 const pending=f.run('mom','做PPT：合成材料');await new Promise(r=>setImmediate(r));f.revoke();release();await pending;
 assert.equal(f.sent.length,0);assert.equal(f.workflow.snapshot().tasks[0].status,'interrupted');
});
test('filesystem errors are reported without local paths or internal error codes',async t=>{
 const f=await setup(t,{generate:async()=>{throw Object.assign(new Error("EIO: open '/Users/private/member.pptx'"),{code:'EIO'});}});f.workflow.configure('mom',true);
 const answer=await f.run('mom','做PPT：材料');assert.match(answer.reply,/读写|稍后/);assert.doesNotMatch(answer.reply,/EIO|\/Users|member\.pptx/);
});
