// 真实 createRuntime + 真实 Owner 工具：服务草稿接线不再依赖替身 action，
// 草稿上下文由已验证的 Owner 原生会话派生，确认只认上一轮唯一展示的版本。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';
import {createOwnerManagementTool,ownerServiceContextId,serviceDraftReferenceMarker} from '../src/owner-management-tool.mjs';

const instant='2026-11-11T02:00:00.000Z';
const request='给妈妈开通AI日报，用 reports/latest.md，只开通，不定时';

function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'family-owner-service-runtime-'));
 const control={workspaceId:'digest',title:'AI 日报',path:join(directory,'digest')};
 const prompts=[],sent=[],finished=new Map();
 let sendPlan=null;
 let beforeSources=null;
 const ownerAgent={
  ensureControlWorkspace:async()=>structuredClone(control),
  listWorkspaces:async()=>[structuredClone(control)],
  start:async intent=>{prompts.push(structuredClone(intent));return{state:'running'};},
  observe:async intent=>{
   const forced=finished.get(intent.requestId),base={workspaceId:intent.workspaceId,sessionId:intent.sessionId,cwd:intent.cwd,requestId:intent.requestId};
   if(forced)return{...base,state:forced.state,text:forced.text??''};
   return{...base,state:'running',requestSeen:true,queued:false,foreign:false,turn:1,activeTurn:1,activeRequestIds:[intent.requestId],events:[{type:'tool/call',seq:1,turn:1,name:'family_assistant',callId:'call-1',status:'running'}]};
  },
 };
 const runtime=createRuntime({directory,now:()=>instant,intervalMs:3600000,ownerAgent,
  digestSources:async args=>{if(beforeSources){const hook=beforeSources;beforeSources=null;await hook();}return[{relativePath:'reports/latest.md',name:'latest.md',bytes:30,updatedAt:instant}];},
  respond:async()=>({reply:'合成回复'}),planWorkbench:async()=>({reply:'合成管理回复',operation:null}),planHarness:async()=>({reply:'合成规划',operation:null}),
  channelFactory:()=>({status:()=>({status:'connected'}),connect:async()=>{},disconnect:async()=>{},close:async()=>{},
   send:async(route,text,options)=>{if(options?.authorize&&options.authorize()!==true)throw Object.assign(new Error('synthetic authority revoked'),{sendOutcome:'failed'});const status=typeof sendPlan==='function'?sendPlan(text,route):'api_accepted';sent.push({personId:route.personId,text,status});return{status};}}),
 });
 t.after(async()=>{await runtime.close();rmSync(directory,{recursive:true,force:true});});
 const store=runtime.store;
 for(const[id,role,label]of[['owner','owner','我'],['mom','elder','妈妈']]){store.addPerson({id,role,label,timeZone:'Asia/Shanghai','shareWithOwner':'none'});store.bindPerson(id,{accountId:'synthetic-account-'+id,peerId:'synthetic-peer-'+id});}
 store.configure({paused:false});
 const tool=createOwnerManagementTool({runtime,directory:join(directory,'tool')});
 let counter=0;
 const receive=async text=>{const id='m-'+(++counter);await runtime.receive('owner',{id,peerId:store.route('owner').peerId,text,at:instant});const task=runtime.status().harness.tasks.filter(row=>row.state==='running').at(-1);assert.ok(task,`native task missing after ${text}`);return task;};
 const finish=async(task,{state='succeeded',text='合成答复'}={})=>{
  finished.set(task.requestId,{state,text});
  for(let i=0;i<100;i++){
   await runtime.tick();
   const row=runtime.status().harness.tasks.find(item=>item.id===task.id);
   if(!row)return;
   if(['succeeded','failed','cancelled','unknown'].includes(row.state)||['accepted','suppressed','failed','unknown'].includes(row.delivery?.state))return;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error('synthetic native task did not settle');
 };
 const execution=task=>({callId:'call-1',agent:{id:task.sessionId},signal:new AbortController().signal});
 const preview=async({deliveredText}={})=>{
  const task=await receive(request),result=await tool.execute({action:'service_request',text:request},execution(task));
  assert.equal(result.draft?.status,'ready',JSON.stringify(result));
  const stored=runtime.status().serviceSetup.find(row=>row.id===result.draft.id);
  assert.equal(stored.origin,'wechat');
  assert.equal(stored.contextId,ownerServiceContextId(task.sessionId),'草稿必须落在真实会话派生的上下文，而不是 default');
  const rendered=tool.output.render({},result);
  await finish(task,{text:deliveredText??result.text});
  return{task,draft:{...result.draft,contextId:stored.contextId,summary:stored.summary},result,rendered};
 };
 const grants=async()=>runtime.action({action:'tool_assignments'});
 const confirm=async(draft,{revision=draft.revision,task,exec}={})=>{
  const current=task??await receive('确认');
  try{return await tool.execute({action:'service_confirm',draftId:draft.id,revision},exec??execution(current));}
  finally{const row=runtime.status().harness.tasks.find(item=>item.id===current.id);if(row&&row.state==='running')await finish(current);}
 };
 return{runtime,store,tool,sent,preview,receive,finish,execution,confirm,grants,beforeSources:hook=>{beforeSources=hook;},setSendPlan:plan=>{sendPlan=plan;}};
}

test('a real runtime owner-session preview then confirm saves exactly that displayed draft, with no family send',async t=>{
 const f=fixture(t),{task,draft}=await f.preview();
 assert.equal((await f.grants()).length,0,'预览不落授权');
 const result=await f.confirm(draft);
 assert.equal(result.status,'completed',JSON.stringify(result));
 assert.equal((await f.grants()).length,1);
 assert.equal((await f.grants())[0].personId,'mom');
 const stored=f.runtime.status().serviceSetup.find(row=>row.id===draft.id);
 assert.equal(stored.status,'applied');
 assert.equal(f.sent.filter(row=>row.personId==='mom').length,0,'确认只保存配置，没有给家人发消息');
 assert.ok(f.sent.some(row=>row.personId==='owner'),'上一轮草稿预览确实投递到了主人微信');
 assert.equal(f.runtime.status().harness.tasks.find(row=>row.id===task.id).delivery.state,'accepted');
});

test('a later unrelated turn cannot confirm a draft from an older topic',async t=>{
 const f=fixture(t),{draft}=await f.preview();
 await f.finish(await f.receive('今天先聊点别的'));
 const result=await f.confirm(draft);
 assert.equal(result.status,'needs_input',JSON.stringify(result));
 assert.match(result.text,/上一轮|旧话题/);
 assert.equal((await f.grants()).length,0);
 assert.equal(f.runtime.status().serviceSetup.find(row=>row.id===draft.id).status,'ready');
});

test('a draft the owner never saw (legacy default context) cannot be confirmed through the tool',async t=>{
 const f=fixture(t);
 const legacy=await f.runtime.action({action:'service_request',text:request,requestId:'legacy-preview'});
 assert.equal(legacy.draft?.status,'ready',JSON.stringify(legacy));
 assert.equal(legacy.draft.contextId,'default');
 const result=await f.confirm(legacy.draft);
 assert.equal(result.status,'needs_input',JSON.stringify(result));
 assert.equal((await f.grants()).length,0);
});

test('a draft the model produced but never showed in the delivered reply cannot be confirmed',async t=>{
 const f=fixture(t),{draft}=await f.preview({deliveredText:'好的，我先整理一下，稍后告诉你。'});
 assert.ok(draft.summary,'草稿有可展示的摘要');
 const result=await f.confirm(draft);
 assert.equal(result.status,'needs_input',JSON.stringify(result));
 assert.match(result.text,/没有真正展示|送达回执/);
 assert.equal((await f.grants()).length,0);
});

test('the exact displayed revision is required and other revisions never save',async t=>{
 const f=fixture(t),{draft}=await f.preview();
 const task=await f.receive('确认');
 const wrong=await f.tool.execute({action:'service_confirm',draftId:draft.id,revision:draft.revision+1},f.execution(task));
 assert.equal(wrong.status,'needs_input');assert.match(wrong.text,/版本|展示/);assert.equal((await f.grants()).length,0);
 const ok=await f.tool.execute({action:'service_confirm',draftId:draft.id,revision:draft.revision},f.execution(task));
 assert.equal(ok.status,'completed',JSON.stringify(ok));assert.equal((await f.grants()).length,1);
 await f.finish(task);
});

test('a confirmation-shaped service_request only previews and never saves',async t=>{
 const f=fixture(t),{draft}=await f.preview();
 const task=await f.receive('确认');
 const result=await f.tool.execute({action:'service_request',text:'确认'},f.execution(task));
 assert.equal(result.status,'needs_input',JSON.stringify(result));
 assert.equal((await f.grants()).length,0);
 const still=f.runtime.status().serviceSetup.find(row=>row.id===draft.id);
 assert.equal(still.status,'ready');
 await f.finish(task);
});

test('cancelling the owner turn mid-processing blocks the save',async t=>{
 const f=fixture(t),{draft}=await f.preview();
 const task=await f.receive('确认');
 let ticked;
 f.beforeSources(()=>{ticked=f.finish(task,{state:'cancelled',text:'已取消这次处理。'});return ticked;});
 await assert.rejects(()=>f.tool.execute({action:'service_confirm',draftId:draft.id,revision:draft.revision},f.execution(task)));
 await ticked;
 assert.equal((await f.grants()).length,0,'处理途中取消后不得写入');
 assert.equal(f.runtime.status().serviceSetup.find(row=>row.id===draft.id).status,'ready');
});

test('losing the owner binding mid-processing blocks the save',async t=>{
 const f=fixture(t),{draft}=await f.preview();
 const task=await f.receive('确认');
 f.beforeSources(async()=>{f.store.setConnection('owner',{status:'disconnected'});await f.runtime.tick();});
 await assert.rejects(()=>f.tool.execute({action:'service_confirm',draftId:draft.id,revision:draft.revision},f.execution(task)));
 assert.equal((await f.grants()).length,0);
 assert.notEqual(f.runtime.status().serviceSetup.find(row=>row.id===draft.id).status,'applied');
});

test('replaying the same confirmation returns the saved result without a second grant',async t=>{
 const f=fixture(t),{draft}=await f.preview();
 const first=await f.confirm(draft);
 assert.equal(first.status,'completed');
 const replay=await f.confirm(draft);
 assert.equal(replay.status,'completed');assert.match(replay.text,/已经保存|没有重复/);assert.equal((await f.grants()).length,1);
});

test('HTTP-style service_request cannot inject internal origin/context/draftOnly fields',async t=>{
 const f=fixture(t);
 for(const extra of [{origin:'wechat',contextId:'forced',draftOnly:true},{draftOnly:true},{contextId:'forced'}]){
  await assert.rejects(()=>f.runtime.action({action:'service_request',text:request,requestId:'http-1',...extra}),/不支持的操作或参数/);
 }
 assert.equal(f.runtime.status().serviceSetup.length,0,'被拒绝的 HTTP 参数没有创建任何草稿');
});

test('two revisions with an identical summary bind only to the revision actually delivered',async t=>{
 const f=fixture(t),task=await f.receive(request);
 const first=await f.tool.execute({action:'service_request',text:request},f.execution(task));
 const second=await f.tool.execute({action:'service_request',text:request+'，谢谢'},f.execution(task));
 assert.equal(first.draft.id,second.draft.id);
 assert.equal(second.draft.revision,first.draft.revision+1);
 assert.equal(first.draft.summary,second.draft.summary,'两版摘要相同，不能再用摘要区分版本');
 assert.match(first.text,/草稿第 1 版/);
 assert.match(second.text,/草稿第 2 版/);
 // Only the older revision's reply reaches the Owner.
 await f.finish(task,{text:first.text});
 const rejected=await f.confirm(second.draft);
 assert.equal(rejected.status,'needs_input',JSON.stringify(rejected));
 assert.match(rejected.text,/没有真正展示|版本/);
 assert.equal((await f.grants()).length,0,'只展示旧版时新版不得新增授权');
 assert.equal(f.runtime.status().serviceSetup.find(row=>row.id===second.draft.id).status,'ready');
 // Re-display on a new turn, then the newest revision can be confirmed.
 const retryTask=await f.receive(request);
 const third=await f.tool.execute({action:'service_request',text:request},f.execution(retryTask));
 assert.equal(third.draft.revision,second.draft.revision+1);
 assert.equal(third.draft.summary,first.draft.summary);
 assert.match(third.text,/草稿第 3 版/);
 await f.finish(retryTask,{text:third.text});
 const saved=await f.confirm(third.draft);
 assert.equal(saved.status,'completed',JSON.stringify(saved));
 assert.equal((await f.grants()).length,1);
 assert.equal(f.sent.filter(row=>row.personId==='mom').length,0,'确认只保存配置，没有给家人发消息');
});

test('a preview without an accepted WeChat receipt cannot be confirmed',async t=>{
 const f=fixture(t);
 // The synthetic channel rejects the preview reply itself; no api_accepted row exists.
 f.setSendPlan(text=>text.includes('给妈妈开通')?'failed':'api_accepted');
 const task=await f.receive(request);
 const result=await f.tool.execute({action:'service_request',text:request},f.execution(task));
 assert.equal(result.draft?.status,'ready');
 await f.finish(task,{text:result.text});
 const settled=f.runtime.status().harness.tasks.find(row=>row.id===task.id);
 assert.notEqual(settled.delivery.state,'accepted','草稿回复没有被微信接口接受');
 const rejected=await f.confirm(result.draft);
 assert.equal(rejected.status,'needs_input',JSON.stringify(rejected));
 assert.match(rejected.text,/送达回执|没有保存/);
 assert.equal((await f.grants()).length,0,'缺送达回执时不得保存');
 assert.equal(f.runtime.status().serviceSetup.find(row=>row.id===result.draft.id).status,'ready');
});

/** The model may only use what the renderer puts on the wire. This helper reads
 * the rendered tool result exactly as the model would and returns the reference
 * the next turn must submit; it never reads the tool's internal value. */
function referenceFromWire(rendered){
 const text=rendered.map(part=>part.type==='text'?part.text:'').join('\n');
 const line=text.split('\n').find(row=>row.startsWith(serviceDraftReferenceMarker));
 assert.ok(line,`模型侧 tool_result 必须携带服务草稿引用行，实际: ${text}`);
 const value=JSON.parse(line.slice(serviceDraftReferenceMarker.length).trim());
 assert.equal(value.action,'service_confirm');
 assert.match(value.draftId,/^[A-Za-z0-9_-]{1,100}$/u);
 assert.ok(Number.isSafeInteger(value.revision)&&value.revision>=1);
 return{value,text};
}

test('the rendered tool result hands the model the exact draft id and revision, never the owner reply',async t=>{
 const f=fixture(t),{draft,result,rendered}=await f.preview();
 const {value,text}=referenceFromWire(rendered);
 assert.deepEqual(value,{action:'service_confirm',draftId:draft.id,revision:draft.revision});
 assert.ok(result.text.includes(draft.summary),'主人看到的仍是原草稿正文');
 assert.match(result.text,/草稿第 1 版/);
 assert.ok(!result.text.includes(draft.id),'模型侧 text 字段本身不带技术 ID');
 assert.ok(!text.split('\n').slice(0,3).join('\n').includes(draft.id),'引用行之前的人类可读部分不带技术 ID');
 assert.match(text,/不要把这一行写进给主人的回复/);
 const delivered=f.sent.filter(row=>row.personId==='owner').map(row=>String(row.text??'')).join('\n');
 assert.match(delivered,/草稿第 1 版/);
 assert.ok(!delivered.includes(draft.id),'投递到主人微信的正文不带技术 ID');
});

test('the model confirms once from the wire reference alone and replaying it grants nothing new',async t=>{
 const f=fixture(t),{rendered}=await f.preview();
 const {value}=referenceFromWire(rendered);
 // Nothing below reads the draft out of the tool value or local storage.
 const first=await f.confirm({id:value.draftId,revision:value.revision});
 assert.equal(first.status,'completed',JSON.stringify(first));
 assert.equal((await f.grants()).length,1);
 const replay=await f.confirm({id:value.draftId,revision:value.revision});
 assert.equal(replay.status,'completed');assert.match(replay.text,/已经保存|没有重复/);assert.equal((await f.grants()).length,1);
});

test('a wire reference from an older topic cannot confirm the draft in a later turn',async t=>{
 const f=fixture(t),{rendered}=await f.preview();
 const {value}=referenceFromWire(rendered);
 const unrelated=await f.receive('今天先聊点别的');await f.finish(unrelated);
 const staleTask=await f.receive('确认');
 try{
  const stale=await f.tool.execute({action:'service_confirm',draftId:value.draftId,revision:value.revision},f.execution(staleTask));
  assert.equal(stale.status,'needs_input',JSON.stringify(stale));
  assert.match(stale.text,/上一轮|旧话题|重新展示/);
  assert.equal((await f.grants()).length,0,'旧话题不能确认上一轮的草稿');
 }finally{
  const row=f.runtime.status().harness.tasks.find(item=>item.id===staleTask.id);
  if(row&&row.state==='running')await f.finish(staleTask);
 }
});

test('a draft that is not ready and confirmable hands the model no reference',async t=>{
 const f=fixture(t);
 const task=await f.receive('给家人开通AI日报');
 try{
  const result=await f.tool.execute({action:'service_request',text:'给家人开通AI日报'},f.execution(task));
  assert.notEqual(result.draft?.status,'ready');
  assert.equal(result.serviceDraft,undefined,'不可确认的草稿不得下发引用');
  const text=f.tool.output.render({},result).map(part=>part.text).join('\n');
  assert.ok(!text.includes(serviceDraftReferenceMarker));
 }finally{
  const row=f.runtime.status().harness.tasks.find(item=>item.id===task.id);
  if(row&&row.state==='running')await f.finish(task,{text:'请说明要给哪位家人开通什么服务。'});
 }
});

test('a model that echoes the internal draft reference leaks nothing to the Owner reply or task state',async t=>{
 const f=fixture(t);
 const task=await f.receive(request);
 const result=await f.tool.execute({action:'service_request',text:request},f.execution(task));
 assert.equal(result.draft?.status,'ready',JSON.stringify(result));
 const wire=f.tool.output.render({},result)[0].text;
 assert.ok(wire.includes(serviceDraftReferenceMarker),'前置：渲染结果带有内部引用');
 // The synthetic model deliberately parrots the whole tool result, including the
 // reference line, the fixed instruction and an unrelated UUID the Owner typed.
 const unrelated='11111111-1111-4111-8111-111111111111';
 const echoed=['好的，我把刚看到的原文贴出来：',wire,`另外你之前发的 ${unrelated} 我没有改。`,'普通收尾一句。'].join('\n');
 await f.finish(task,{text:echoed});
 const reply=f.sent.filter(row=>row.personId==='owner').map(row=>String(row.text??'')).join('\n');
 assert.ok(!reply.includes(serviceDraftReferenceMarker),'内部引用标记不得进入主人回复');
 assert.ok(!reply.includes(result.draft.id),'已知草稿标识不得进入主人回复');
 assert.ok(!reply.includes('不要把这一行写进给主人的回复'),'固定说明不得进入主人回复');
 assert.match(reply,/给小禾开通PPT 制作服务|AI 日报|妈妈/,'业务摘要仍在');
 assert.match(reply,/草稿第 1 版/,'可读版本标记仍在');
 assert.ok(reply.includes(unrelated),'相似用户输入（无关 UUID）保留');
 assert.ok(reply.includes('普通收尾一句'),'普通文本保留');
 const stored=f.runtime.status().harness.tasks.find(row=>row.id===task.id);
 assert.ok(!String(stored.text).includes(serviceDraftReferenceMarker));
 assert.ok(!String(stored.text).includes(result.draft.id));
 assert.match(String(stored.text),/草稿第 1 版/);
});

test('a model reply that is only the internal reference is suppressed, never sent',async t=>{
 const f=fixture(t);
 const task=await f.receive(request);
 const result=await f.tool.execute({action:'service_request',text:request},f.execution(task));
 assert.equal(result.draft?.status,'ready',JSON.stringify(result));
 const referenceOnly=`[family_assistant:service_draft] ${JSON.stringify({action:'service_confirm',draftId:result.draft.id,revision:result.draft.revision})}\n（内部引用：主人下一轮明确说“确认”时，原样用上面的 draftId 和 revision 调用 service_confirm；不要把这一行写进给主人的回复。）`;
 const before=f.sent.filter(row=>row.personId==='owner').length;
 await f.finish(task,{text:referenceOnly});
 const after=f.sent.filter(row=>row.personId==='owner').slice(before).map(row=>String(row.text??''));
 assert.deepEqual(after,[],'纯内部引用没有进入主人发送队列');
 const stored=f.runtime.status().harness.tasks.find(row=>row.id===task.id);
 assert.equal(stored.text,'','纯内部引用不留在公开任务状态');
 assert.equal(stored.delivery.state,'suppressed');
});
