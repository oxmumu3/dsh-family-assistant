import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,readFileSync,writeFileSync,statSync,symlinkSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';
import {createWorkbench} from '../src/workbench.mjs';
import {createConversationHistory} from '../src/conversation-history.mjs';
import {createOwnerManagementTool,ownerLiteralMessageAuthorized} from '../src/owner-management-tool.mjs';

function fixture(t){
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'family-owner-native-')));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const store=createStore({directory});for(const[id,role,label]of[['owner','owner','我'],['mom','elder','妈妈'],['dad','elder','爸爸'],['k','elder','K']]){store.addPerson({id,role,label,shareWithOwner:'none'});store.bindPerson(id,{accountId:'synthetic-account-'+id,peerId:'synthetic-peer-'+id});}
 const history=createConversationHistory({store}),executed=[],sent=[],authorityCalls=[],sendCalls=[],confirmCalls=[];let allowed=true,planCalls=0,receipt='api_accepted',extraDrafts=[];
 let context={taskId:'native-task',requestId:'native-request',sourceRequestId:'source-draft',personId:'owner',origin:'wechat',route:store.route('owner'),userText:'给K整理一份消息草稿',deliveryTarget:null,previousSourceRequestId:null},planOutput={reply:'请核对',operation:{type:'plan',actions:[{type:'send_message',personId:'k',text:'本人可以直接告诉乐乐修改日报。'}]}};
 const wb=createWorkbench({directory,store,plan:async()=>{planCalls++;return planOutput;},execute:async action=>{executed.push(action);return{status:'api_accepted'};}});
 const runtime={store,status:()=>({config:{paused:false},people:store.snapshot().people.map(person=>({...person,binding:store.binding(person.id)})),workbench:{...wb.snapshot(),cards:[...wb.snapshot().cards,...extraDrafts]}}),
  ownerAuthorityForSession:async input=>{authorityCalls.push(input);if(input.sessionId!=='session-owner'||!['call-1','call-2','root-call'].includes(input.callId)||!allowed)throw Error('Not an active Owner tool call');return{...structuredClone(context),authorize:()=>allowed};},
  action:async input=>{if(input.action==='owner_chat'){await wb.chat(input);return{workbench:wb.snapshot()};}if(input.action==='history_page')return history.page({viewerPersonId:'owner',personId:input.personId,...(input.limit!==undefined?{limit:input.limit}:{}),...(input.before?{before:input.before}:{}),...(input.query!==undefined?{query:input.query}:{})});if(input.action==='preview_brief')return{lastBrief:{text:'自动简报受分享偏好控制'}};throw Error('Unexpected runtime action');},
  ownerSendForSession:async input=>{sendCalls.push(input);await runtime.ownerAuthorityForSession(input);const key=JSON.stringify([context.sourceRequestId,input.personId,input.text]);let row=sent.find(item=>item.key===key);if(!row){row={key,personId:input.personId,text:input.text,status:receipt,outboxId:'synthetic-outbox'};sent.push(row);}return{status:row.status,outboxId:row.outboxId};},
  ownerConfirmForSession:async input=>{confirmCalls.push(input);await runtime.ownerAuthorityForSession(input);await wb.confirm({cardId:input.cardId,revision:input.revision,authorityRoute:context.route,authorize:()=>allowed});return{workbench:wb.snapshot()};},
 };
 const execution={callId:'call-1',agent:{id:'session-owner'},signal:new AbortController().signal},tool=createOwnerManagementTool({runtime,directory});
 return{directory,store,runtime,tool,execution,wb,sent,executed,authorityCalls,sendCalls,confirmCalls,planCalls:()=>planCalls,setContext:patch=>{context={...context,...patch};},setPlan:value=>{planOutput=value;},setAllowed:value=>{allowed=value;},setReceipt:value=>{receipt=value;},setExtraDrafts:value=>{extraDrafts=value;},restart:()=>createOwnerManagementTool({runtime,directory})};
}
const confirmContext=(f,patch={})=>f.setContext({sourceRequestId:'source-confirm',requestId:'native-confirm',previousSourceRequestId:'source-draft',previousUserText:'给K整理一份消息草稿',userText:'确认',...patch});
async function draft(f){return f.tool.execute({action:'draft_management',text:'请准备发给K：本人可以直接告诉乐乐修改日报。'},f.execution);}

test('Owner status rendering contains recipient IDs and only necessary directory fields',async t=>{
 const f=fixture(t),value=await f.tool.execute({action:'status'},f.execution),rendered=f.tool.output.render({},value)[0].text;
 assert.equal(JSON.parse(rendered).people.find(person=>person.label==='妈妈').id,'mom');assert.equal(value.capabilities.ownerLocalHistory,'full');assert.doesNotMatch(rendered,/account|peer|token|route|source-draft|native-task/);assert.equal(statSync(join(f.directory,'owner-native-management.json')).mode&0o777,0o600);
});

test('all management operations require an actual current Owner tool call and rootCallId is used',async t=>{
 const f=fixture(t);for(const args of [{action:'status'},{action:'preview_brief'},{action:'history_page',personId:'mom'},{action:'send_message',personId:'mom',text:'hi'},{action:'draft_management',text:'hi'},{action:'confirm_management',cardId:'x',revision:1}])await assert.rejects(()=>f.tool.execute(args,{...f.execution,agent:{id:'family_owner_forged'}}));
 await f.tool.execute({action:'status'},{...f.execution,callId:'nested-call',rootCallId:'root-call'});assert.equal(f.authorityCalls.at(-1).callId,'root-call');f.setAllowed(false);await assert.rejects(()=>f.tool.execute({action:'status'},f.execution));assert.equal(f.sent.length,0);
});

test('Owner reads full share-none local history with a bounded exact query and opaque paging',async t=>{
 const f=fixture(t);for(let i=0;i<3;i++)f.store.addMessage('mom',{id:'mom-'+i,dir:'in',text:'合成重要事 '+i,kind:'chat'});f.store.addMessage('dad',{dir:'in',text:'DAD_PRIVATE_NOT_IN_MOM_PAGE',kind:'chat'});
 const first=await f.tool.execute({action:'history_page',personId:'mom',limit:2,query:'重要事'},f.execution);assert.equal(first.access,'full');assert.equal(first.messages.length,2);assert.equal(first.hasMore,true);assert.doesNotMatch(first.text,/DAD_PRIVATE|synthetic-peer|synthetic-account/);assert.equal(JSON.parse(f.tool.output.render({},first)[0].text).messages.length,2);
 const older=await f.tool.execute({action:'history_page',personId:'mom',limit:2,query:'重要事',before:first.nextCursor},f.execution);assert.equal(older.messages.length,1);await assert.rejects(()=>f.tool.execute({action:'history_page',personId:'mom',limit:101},f.execution));
});

test('literal Owner instructions send directly without another confirmation or workbench visit',async t=>{
 const f=fixture(t);f.setContext({userText:'帮我给妈妈发消息：今晚早点休息。'});const result=await f.tool.execute({action:'send_message',personId:'mom',text:'今晚早点休息'},f.execution);assert.equal(result.status,'api_accepted');assert.equal(f.sent.length,1);assert.equal(f.sent[0].personId,'mom');assert.equal(f.sent[0].text,'今晚早点休息');assert.doesNotMatch(result.text,/已收到|已读|工作台|确认后/);assert.equal(Object.hasOwn(f.sendCalls[0],'requestId'),false);
 await f.tool.execute({action:'send_message',personId:'mom',text:'今晚早点休息'},{...f.execution,callId:'call-2'});assert.equal(f.sent.length,1);
});

test('a direct tell request may contain a conditional body and a polite question ending',async t=>{
 const f=fixture(t),body='如果现在他对AI digest日报不满意，可以直接告诉这个微信小助手让它改吧';f.setContext({userText:'你先帮我告诉K，'+body+'，可以吗？'});assert.equal((await f.tool.execute({action:'send_message',personId:'k',text:body},f.execution)).status,'api_accepted');assert.equal(f.sent[0].text,body);
});

test('natural say-to and plural-parent literal instructions are grounded without widening questions',async t=>{
 for(const userText of ['帮我跟K说：晚上八点见','帮我对K说：晚上八点见']){const f=fixture(t);f.setContext({userText});assert.equal((await f.tool.execute({action:'send_message',personId:'k',text:'晚上八点见'},f.execution)).status,'api_accepted');assert.equal(f.sent.length,1);}
 const f=fixture(t);f.setContext({userText:'给爸妈都发一条消息：今晚降温'});for(const personId of ['mom','dad'])assert.equal((await f.tool.execute({action:'send_message',personId,text:'今晚降温'},f.execution)).status,'api_accepted');assert.equal(f.sent.length,2);assert.equal((await f.tool.execute({action:'send_message',personId:'k',text:'今晚降温'},f.execution)).status,'needs_input');
 for(const userText of ['比如帮我跟K说：晚上八点见','你能不能给爸妈都发一条消息：今晚降温','解释“给爸妈都发一条消息：今晚降温”是什么意思']){f.setContext({userText});const personId=userText.includes('K')?'k':'mom',text=userText.includes('K')?'晚上八点见':'今晚降温';assert.equal((await f.tool.execute({action:'send_message',personId,text},f.execution)).status,'needs_input');}assert.equal(f.sent.length,2);
});

test('the original polite K instruction authorizes its complete literal body only',async t=>{
 const f=fixture(t),body='如果现在他对 AI digest 的日报不满意，他可以直接告诉这个微信小助手，让它改吧';f.setContext({userText:'你先帮我告诉 K，'+body+'，可以吗？'});assert.equal((await f.tool.execute({action:'send_message',personId:'k',text:body},f.execution)).status,'api_accepted');assert.equal(f.sent.length,1);assert.equal(f.sent[0].text,body);assert.equal((await f.tool.execute({action:'send_message',personId:'k',text:'如果现在他对 AI digest 的日报不满意'},f.execution)).status,'needs_input');
});

test('draft and deferred-send instructions never authorize an immediate literal send',async t=>{
 const f=fixture(t),target=f.store.person('k'),people=f.store.snapshot().people;
 for(const[userText,text]of [['先帮我起草给K发：今晚八点见','今晚八点见'],['给K发：今晚八点见，但先别发','今晚八点见，但先别发'],['先拟一条给K的消息：今晚八点见','今晚八点见'],['给K发：今晚八点见，先给我看','今晚八点见，先给我看'],['给K发：今晚八点见，等我确认','今晚八点见，等我确认'],['给K发：今晚八点见，暂时不发','今晚八点见，暂时不发']])assert.equal(ownerLiteralMessageAuthorized({userText,target,people,text}),false,userText);
 const {isOwnerMessageDraftIntent}=await import('../src/owner-management-tool.mjs');assert.equal(typeof isOwnerMessageDraftIntent,'function');
 for(const userText of ['先帮我起草给K发：今晚八点见','给K发：今晚八点见，但先别发','先拟一条给K的消息：今晚八点见','给K发：今晚八点见，先给我看','给K发：今晚八点见，等我确认','给K发：今晚八点见，暂时不发'])assert.equal(isOwnerMessageDraftIntent({userText,people}),true,userText);
});

test('handling text inside the quoted message and ordinary body conditionals stay sendable',async t=>{
 const f=fixture(t),target=f.store.person('k'),people=f.store.snapshot().people;
 for(const[userText,text]of [['给K发：“草稿先别发，等我确认”。','草稿先别发，等我确认'],['告诉K：如果日报不满意，可以让乐乐改。','如果日报不满意，可以让乐乐改'],['告诉K：不要忘记今晚聚餐。','不要忘记今晚聚餐']])assert.equal(ownerLiteralMessageAuthorized({userText,target,people,text}),true,userText);
 const {isOwnerMessageDraftIntent}=await import('../src/owner-management-tool.mjs');for(const userText of ['给K发：“草稿先别发，等我确认”。','告诉K：如果日报不满意，可以让乐乐改。','告诉K：不要忘记今晚聚餐。','比如先起草给K发：今晚八点见','你能不能先起草给K发：今晚八点见','先起草给未登记的人发：今晚八点见'])assert.equal(isOwnerMessageDraftIntent({userText,people}),false,userText);
});

test('explicit denial of having requested a send cannot become literal authorization',async t=>{
 const f=fixture(t),target=f.store.person('k'),people=f.store.snapshot().people;for(const userText of ['我没让你给K发：今晚八点见','我没有要求你告诉K：今晚八点见','我没叫你跟K说：今晚八点见'])assert.equal(ownerLiteralMessageAuthorized({userText,target,people,text:'今晚八点见'}),false,userText);
});

test('registered for-recipient draft wording is recognized without treating schedules as drafts',async t=>{
 const f=fixture(t);f.store.addPerson({id:'qa-mom',role:'elder',label:'QA妈妈'});const people=f.store.snapshot().people,{isOwnerMessageDraftIntent}=await import('../src/owner-management-tool.mjs');assert.equal(isOwnerMessageDraftIntent({userText:'请为QA妈妈起草一条消息：合成正文。先给我看，等我确认再发送。',people}),true);
 for(const userText of ['给K每天早上九点发AI日报','给K明天八点发消息','明天八点给K发消息'])assert.equal(isOwnerMessageDraftIntent({userText,people}),false,userText);
});

test('a future send time before the recipient cannot authorize an immediate send',async t=>{
 const f=fixture(t),target=f.store.person('k'),people=f.store.snapshot().people;for(const userText of ['明早帮我告诉K：合成正文','明天八点给K发：合成正文','每天早上九点给K发消息：合成正文','今晚八点给K发：合成正文','定时给K发：合成正文'])assert.equal(ownerLiteralMessageAuthorized({userText,target,people,text:'合成正文'}),false,userText);
 for(const[userText,text]of [['告诉K：今晚八点见。','今晚八点见'],['给K发：明天八点见。','明天八点见'],['告诉K：每天晚上不要忘记关灯。','每天晚上不要忘记关灯']])assert.equal(ownerLiteralMessageAuthorized({userText,target,people,text}),true,userText);
});

test('read-only project requests with a no-send constraint never become a message draft',async t=>{
 const f=fixture(t),people=f.store.snapshot().people,target=f.store.person('k'),{isOwnerMessageDraftIntent}=await import('../src/owner-management-tool.mjs');
 const requests=['请自己找到本机Codex的AI日报项目，实际打开最新微信版日报，把正文回复给我；只回复我，不要发给K，也不要修改订阅。','不要发给K。','不要给K发消息。','不要发K，也不要改订阅。','不要给K发：合成正文','不要发给K：合成正文'];for(const userText of requests){assert.equal(isOwnerMessageDraftIntent({userText,people}),false,userText);assert.equal(ownerLiteralMessageAuthorized({userText,target,people,text:'合成正文'}),false,userText);}
 assert.equal(isOwnerMessageDraftIntent({userText:'先起草给K发：合成正文',people}),true);assert.equal(isOwnerMessageDraftIntent({userText:'给K发：合成正文，但先别发',people}),true);
});

test('capability questions, quoted examples, missing content and model claims do not send',async t=>{
 const f=fixture(t);for(const userText of ['你能不能遥控给妈妈发消息？','比如告诉妈妈：今晚早点休息。','解释“告诉妈妈：今晚早点休息”是什么意思。','不要告诉妈妈：今晚早点休息。','你能不能告诉妈妈：今晚早点休息。','给爸爸发消息：今晚早点休息。']){f.setContext({userText});const result=await f.tool.execute({action:'send_message',personId:'mom',text:'今晚早点休息'},f.execution);assert.equal(result.status,'needs_input',userText);}assert.equal(f.sent.length,0);
 await assert.rejects(()=>f.tool.execute({action:'send_message',personId:'mom',text:'今晚早点休息',authorized:true},f.execution));
});

test('an existing native delivery target and an unknown send cannot trigger a second outbound',async t=>{
 const f=fixture(t);f.setContext({userText:'告诉妈妈：今晚早点休息',deliveryTarget:{personId:'mom'}});assert.equal((await f.tool.execute({action:'send_message',personId:'mom',text:'今晚早点休息'},f.execution)).status,'delivery_managed');assert.equal(f.sendCalls.length,0);
 f.setContext({deliveryTarget:null});f.setReceipt('unknown');assert.equal((await f.tool.execute({action:'send_message',personId:'mom',text:'今晚早点休息'},f.execution)).status,'unknown');await f.tool.execute({action:'send_message',personId:'mom',text:'今晚早点休息'},{...f.execution,callId:'call-2'});assert.equal(f.sent.length,1);
});

test('a native draft is idempotent and the immediately following confirmation executes once',async t=>{
 const f=fixture(t),first=await draft(f),again=await f.tool.execute({action:'draft_management',text:'请准备发给K：本人可以直接告诉乐乐修改日报。'},{...f.execution,callId:'call-2'});assert.equal(f.planCalls(),1);assert.equal(first.cards.length,1);assert.equal(again.cards[0].id,first.cards[0].id);assert.match(first.text,/当前会话|无需返回/);assert.equal(f.executed.length,0);
 const card=first.cards[0];confirmContext(f);const result=await f.tool.execute({action:'confirm_management',cardId:card.id,revision:card.revision},f.execution);assert.equal(result.status,'completed');assert.equal(f.executed.length,1);assert.equal(f.executed[0].personId,'k');
 const restarted=f.restart();await restarted.execute({action:'confirm_management',cardId:card.id,revision:card.revision},{...f.execution,callId:'call-2'});assert.equal(f.confirmCalls.length,1);assert.equal(f.executed.length,1);
 const journal=readFileSync(join(f.directory,'owner-native-management.json'),'utf8');assert.doesNotMatch(journal,/synthetic-account|synthetic-peer|本人可以直接告诉乐乐修改日报/);
});

test('a same-card modification is confirmed only at its revised version in the next turn',async t=>{
 const f=fixture(t),original=(await draft(f)).cards[0];f.setContext({sourceRequestId:'source-edit',requestId:'native-edit',previousSourceRequestId:'source-draft',userText:'把同一条消息改为修改后的合成说明'});f.setPlan({reply:'已改稿',operation:{type:'plan',cardId:original.id,actions:[{id:original.actions[0].id,type:'send_message',personId:'k',text:'修改后的合成说明'}]}});
 const revised=(await f.tool.execute({action:'draft_management',text:'把这条消息改为修改后的合成说明',contextId:'card:'+original.id},f.execution)).cards[0];assert.equal(revised.id,original.id);assert.ok(revised.revision>original.revision);assert.equal(f.executed.length,0);confirmContext(f,{previousSourceRequestId:'source-edit'});
 assert.equal((await f.tool.execute({action:'confirm_management',cardId:original.id,revision:original.revision},f.execution)).status,'needs_input');assert.equal(f.executed.length,0);assert.equal((await f.tool.execute({action:'confirm_management',cardId:revised.id,revision:revised.revision},f.execution)).status,'completed');assert.equal(f.executed.length,1);assert.equal(f.executed[0].text,'修改后的合成说明');
});

test('two actual draft candidates from the previous native turn cannot be selected by the model alone',async t=>{
 const f=fixture(t),first=(await draft(f)).cards[0],second=(await f.tool.execute({action:'draft_management',text:'另准备一张K的独立安排草稿'},f.execution)).cards[0];assert.notEqual(first.id,second.id);assert.equal(f.wb.snapshot().cards.length,2);confirmContext(f);
 for(const card of [first,second])assert.equal((await f.tool.execute({action:'confirm_management',cardId:card.id,revision:card.revision},f.execution)).status,'needs_input');assert.equal(f.confirmCalls.length,0);assert.equal(f.executed.length,0);
});

test('unrelated, old-turn, wrong revision, changed binding and ambiguous confirmations cannot act',async t=>{
 for(const scenario of ['new-topic','old-turn','revision','binding','owner-binding','multiple']){
  const f=fixture(t),card=(await draft(f)).cards[0];confirmContext(f);
  if(scenario==='new-topic')f.setContext({userText:'先帮我看看天气'});
  if(scenario==='old-turn')f.setContext({previousSourceRequestId:'intervening-source'});
  if(scenario==='binding')f.store.bindPerson('k',{accountId:'changed-k',peerId:'changed-peer-k'});
  if(scenario==='owner-binding')f.setContext({route:{...f.store.route('owner'),generation:2}});
  if(scenario==='multiple'){const file=join(f.directory,'owner-native-management.json'),journal=JSON.parse(readFileSync(file));journal.drafts.push({...journal.drafts[0],cardId:'other-card'});writeFileSync(file,JSON.stringify(journal),{mode:0o600});}
  const result=await f.tool.execute({action:'confirm_management',cardId:card.id,revision:card.revision+(scenario==='revision'?1:0)},f.execution);assert.equal(result.status,'needs_input',scenario);assert.equal(f.executed.length,0,scenario);
 }
});

test('old workbench cards without native provenance and cross-session confirmations are refused',async t=>{
 const f=fixture(t);await f.wb.chat({text:'旧草稿',requestId:'old-host-draft',draftOnly:true});const old=f.wb.snapshot().cards[0];confirmContext(f);assert.equal((await f.tool.execute({action:'confirm_management',cardId:old.id,revision:old.revision},f.execution)).status,'needs_input');assert.equal(f.executed.length,0);
 await assert.rejects(()=>f.tool.execute({action:'confirm_management',cardId:old.id,revision:old.revision},{...f.execution,agent:{id:'other-session'}}));
});

test('crashed dispatching confirmations recover unknown and never invoke the runtime again',async t=>{
 const f=fixture(t),card=(await draft(f)).cards[0];confirmContext(f);f.runtime.ownerConfirmForSession=async()=>{throw Error('uncertain callback detail');};const value=await f.tool.execute({action:'confirm_management',cardId:card.id,revision:card.revision},f.execution);assert.equal(value.status,'unknown');assert.doesNotMatch(value.text,/callback detail/);
 const file=join(f.directory,'owner-native-management.json'),journal=JSON.parse(readFileSync(file));journal.confirmations[0].status='dispatching';delete journal.confirmations[0].result;writeFileSync(file,JSON.stringify(journal),{mode:0o600});let calls=0;f.runtime.ownerConfirmForSession=async()=>{calls++;throw Error('must not run');};assert.equal((await f.restart().execute({action:'confirm_management',cardId:card.id,revision:card.revision},f.execution)).status,'unknown');assert.equal(calls,0);
});

test('concurrent identical confirmations reserve one callback before either asynchronous execution',async t=>{
 const f=fixture(t),card=(await draft(f)).cards[0];confirmContext(f);let release,attempts=0;const gate=new Promise(resolve=>release=resolve),base=f.runtime.ownerConfirmForSession;f.runtime.ownerConfirmForSession=async input=>{attempts++;await gate;return base(input);};
 const first=f.tool.execute({action:'confirm_management',cardId:card.id,revision:card.revision},f.execution),second=f.tool.execute({action:'confirm_management',cardId:card.id,revision:card.revision},{...f.execution,callId:'call-2'});await new Promise(resolve=>setImmediate(resolve));const observed=attempts;release();await Promise.all([first,second]);assert.equal(observed,1);assert.equal(f.executed.length,1);assert.equal(JSON.parse(readFileSync(join(f.directory,'owner-native-management.json'))).confirmations.length,1);
});

test('concurrent confirmations from distinct native sessions retain both journal results',async t=>{
 const f=fixture(t),route=f.store.route('owner');let release;const gate=new Promise(resolve=>release=resolve);
 function native(sessionId){let context={taskId:'task-'+sessionId,requestId:'native-'+sessionId,sourceRequestId:'draft-'+sessionId,personId:'owner',origin:'wechat',route,userText:'先准备K的消息',deliveryTarget:null};const runtime={...f.runtime,ownerAuthorityForSession:async input=>{assert.equal(input.sessionId,sessionId);return{...context,authorize:()=>true};},ownerConfirmForSession:async input=>{await gate;return{card:{id:input.cardId,status:'completed',actions:[{status:'api_accepted'}]}};}};return{tool:createOwnerManagementTool({runtime,directory:f.directory}),execution:{...f.execution,agent:{id:sessionId}},confirm(){context={...context,sourceRequestId:'confirm-'+sessionId,previousSourceRequestId:'draft-'+sessionId,userText:'确认'};}};}
 const a=native('owner-a'),b=native('owner-b'),cardA=(await a.tool.execute({action:'draft_management',text:'先准备K的消息A'},a.execution)).cards[0],cardB=(await b.tool.execute({action:'draft_management',text:'先准备K的消息B'},b.execution)).cards[0];a.confirm();b.confirm();
 const first=a.tool.execute({action:'confirm_management',cardId:cardA.id,revision:cardA.revision},a.execution),second=b.tool.execute({action:'confirm_management',cardId:cardB.id,revision:cardB.revision},b.execution);await new Promise(resolve=>setImmediate(resolve));release();await Promise.all([first,second]);const saved=JSON.parse(readFileSync(join(f.directory,'owner-native-management.json')));assert.equal(saved.drafts.length,2);assert.equal(saved.confirmations.length,2);assert.ok(saved.confirmations.every(row=>row.status==='completed'));
});

test('revocation after asynchronous reads never returns family context',async t=>{
 const f=fixture(t),base=f.runtime.action;f.runtime.action=async args=>{const value=await base(args);f.setAllowed(false);return value;};f.store.addMessage('mom',{dir:'in',text:'PRIVATE_READ_MUST_NOT_ESCAPE',kind:'chat'});await assert.rejects(()=>f.tool.execute({action:'history_page',personId:'mom'},f.execution),error=>!error.message.includes('PRIVATE_READ_MUST_NOT_ESCAPE'));
});

test('Owner journal symlink and hardlink substitutions fail without modifying targets',t=>{
 for(const kind of ['symlink','hardlink']){const f=fixture(t),file=join(f.directory,'owner-native-management.json'),target=join(f.directory,'untouched.json'),before=readFileSync(file);writeFileSync(target,before,{mode:0o600});rmSync(file);if(kind==='symlink')symlinkSync(target,file);else linkSync(target,file);assert.throws(()=>f.restart(),/记录|路径|权限/);assert.deepEqual(readFileSync(target),before);}
});

test('literal source matching permits a quoted payload but rejects ambiguous family aliases',async t=>{
 const f=fixture(t),target=f.store.person('mom');assert.equal(ownerLiteralMessageAuthorized({userText:'请转告妈妈：“今晚早点休息”。',target,people:f.store.snapshot().people,text:'今晚早点休息'}),true);f.store.addPerson({id:'other-mom',role:'elder',label:'妈妈的另一个账户'});assert.equal(ownerLiteralMessageAuthorized({userText:'请转告妈妈：今晚早点休息。',target,people:f.store.snapshot().people,text:'今晚早点休息'}),false);
});
