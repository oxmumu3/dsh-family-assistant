import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,mkdirSync,statSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';
import {createServiceSetup} from '../src/service-setup.mjs';
import {ownerServiceContextId} from '../src/owner-management-tool.mjs';
import {createOwnerServiceLedger,serviceDraftMarker,serviceDraftSummaryHash} from '../src/owner-service-ledger.mjs';
import {confirmOwnerServiceDraft} from '../src/owner-service-confirm.mjs';

const instant='2026-10-25T02:00:00.000Z';
const request='给妈妈开通AI日报，用 reports/latest.md，只开通，不定时';

function fixture(t){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'family-service-confirm-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const store=createStore({directory:join(root,'store')});
 for(const[id,role,label]of[['owner','owner','我'],['mom','elder','妈妈']]){store.addPerson({id,role,label,timeZone:'Asia/Shanghai'});store.bindPerson(id,{accountId:'synthetic-account-'+id,peerId:'synthetic-peer-'+id});}
 let grants=[],grantOwners=new Map();
 const toolbox={
  assign(input){const previous=grants.find((row,index)=>grantOwners.get(grants[index])===input.actorId&&row.personId===input.personId&&row.toolId===input.toolId),saved={personId:input.personId,toolId:input.toolId,resource:structuredClone(input.resource),allowInvoke:input.allowInvoke,schedule:structuredClone(input.schedule),revision:(previous?.revision??0)+1,updatedAt:instant};grants=grants.filter((row,index)=>!(grantOwners.get(row)===input.actorId&&row.personId===input.personId&&row.toolId===input.toolId)).concat(saved);grantOwners.set(saved,input.actorId);return structuredClone(saved);},
  assignments({actorId}={}){return grants.filter(row=>!actorId||grantOwners.get(row)===actorId).map(row=>structuredClone(row));},
  catalog(){return[];},
 };
 const serviceSetup=createServiceSetup({directory:join(root,'service'),store,toolbox,now:()=>instant,
  listProjects:async()=>[{workspaceId:'digest',title:'AI 日报'}],
  digestSources:async()=>[{relativePath:'reports/latest.md',name:'latest.md',bytes:30,updatedAt:instant}],
  weatherSearch:async()=>[{id:1,label:'上海',timeZone:'Asia/Shanghai'}],
 });
 const ledger=createOwnerServiceLedger({directory:join(root,'views'),now:()=>instant});
 const sessionId='session-a',sourceRequestId='wechat-source-preview';
 const preview=async({text=request,session=sessionId}={})=>serviceSetup.handle({actorId:'owner',text,requestId:'preview-'+Math.random(),origin:'wechat',contextId:ownerServiceContextId(session),draftOnly:true});
 const record=(draft,{session=sessionId,source=sourceRequestId}={})=>ledger.record({sessionId:session,sourceRequestId:source,personId:'owner',origin:'wechat',contextId:ownerServiceContextId(session),draftId:draft.id,revision:draft.revision,summary:draft.summary,marker:serviceDraftMarker(draft.revision)});
 const authority=(patch={})=>({personId:'owner',origin:'wechat',sourceRequestId:'wechat-source-confirm',previousSourceRequestId:sourceRequestId,userText:'确认',deliveryTarget:null,route:store.route('owner'),authorize:()=>true,...patch});
 const confirm=({a=authority(),session=sessionId,draftId,revision,delivered=true}={})=>confirmOwnerServiceDraft({authority:a,sessionId:session,draftId,revision,serviceSetup,ledger,previousTurnDelivered:()=>delivered});
 return{root,store,serviceSetup,ledger,preview,record,authority,confirm,grants:()=>grants,sessionId};
}

async function shown(f){
 const result=await f.preview();
 assert.equal(result.draft?.status,'ready',JSON.stringify(result));
 f.record(result.draft);
 return result.draft;
}

test('the exact draft shown in the previous same-session turn saves once and writes the ledger privately',async t=>{
 const f=fixture(t),draft=await shown(f);
 assert.equal(f.grants().length,0,'预览不落授权');
 const result=await f.confirm({draftId:draft.id,revision:draft.revision});
 assert.equal(result.status,'completed',JSON.stringify(result));
 assert.equal(f.grants().length,1);assert.equal(f.grants()[0].personId,'mom');assert.equal(f.grants()[0].toolId,'ai_digest');assert.equal(f.grants()[0].schedule,null);
 assert.equal(f.serviceSetup.snapshotForOwner({actorId:'owner',origin:'wechat',contextId:draft.contextId}).find(row=>row.id===draft.id).status,'applied');
 assert.equal(statSync(join(f.root,'views','owner-service-drafts.json')).mode&0o777,0o600);
});

test('a later unrelated turn, a cross-session draft, a wrong revision and an unshown draft never save',async t=>{
 const f=fixture(t),draft=await shown(f);
 const oldTopic=await f.confirm({a:f.authority({previousSourceRequestId:'wechat-source-old-topic'}),draftId:draft.id,revision:draft.revision});
 assert.equal(oldTopic.status,'needs_input');assert.equal(f.grants().length,0);
 const wrongRevision=await f.confirm({draftId:draft.id,revision:draft.revision+1});
 assert.equal(wrongRevision.status,'needs_input');assert.equal(f.grants().length,0);
 const crossSession=await f.confirm({session:'session-b',draftId:draft.id,revision:draft.revision});
 assert.equal(crossSession.status,'needs_input');assert.equal(f.grants().length,0,'跨会话不能确认');
 const unshown=await f.confirm({a:f.authority({previousSourceRequestId:'wechat-source-never-shown'}),draftId:draft.id,revision:draft.revision});
 assert.equal(unshown.status,'needs_input');assert.equal(f.grants().length,0);
});

test('two drafts shown in one turn are ambiguous; a cancelled or revised draft does not save',async t=>{
 const f=fixture(t),first=await shown(f),second=await f.preview({text:'给妈妈开通天气服务，上海'});
 assert.equal(second.draft?.status,'ready',JSON.stringify(second));
 f.record(second.draft);
 const ambiguous=await f.confirm({draftId:first.id,revision:first.revision});
 assert.equal(ambiguous.status,'needs_input');assert.equal(f.grants().length,0);

 const g=fixture(t),draft=await shown(g);
 await g.serviceSetup.cancel({actorId:'owner',draftId:draft.id,revision:draft.revision,origin:'wechat',contextId:draft.contextId,requestId:'cancel-1'});
 const cancelled=await g.confirm({draftId:draft.id,revision:draft.revision});
 assert.equal(cancelled.status,'needs_input');assert.equal(g.grants().length,0);
});

test('only the owner original words authorize; a model text, explicit ids and undelivered previews are rejected',async t=>{
 const f=fixture(t),draft=await shown(f);
 const undelivered=await f.confirm({delivered:false,draftId:draft.id,revision:draft.revision});
 assert.equal(undelivered.status,'needs_input');assert.equal(f.grants().length,0);
 await assert.rejects(()=>f.confirm({a:f.authority({userText:request}),draftId:draft.id,revision:draft.revision}),/确认/);
 const mismatch=await f.confirm({a:f.authority({userText:'确认 '+draft.id+' v99'}),draftId:draft.id,revision:draft.revision});
 assert.equal(mismatch.status,'needs_input');assert.equal(f.grants().length,0);
 const explicit=await f.confirm({a:f.authority({userText:'确认 '+draft.id+' v'+draft.revision}),draftId:draft.id,revision:draft.revision});
 assert.equal(explicit.status,'completed',JSON.stringify(explicit));
});

test('authorization is rechecked immediately before the write, not only when the turn started',async t=>{
 const f=fixture(t),draft=await shown(f);
 let calls=0;
 const result=await f.confirm({a:f.authority({authorize:()=>++calls===1}),draftId:draft.id,revision:draft.revision});
 assert.equal(result.status,'needs_input');assert.match(result.text,/变化|没有保存/);assert.equal(f.grants().length,0);
 assert.equal(calls,2,'确认入口和真正写入前各核对一次');
});

test('replaying an applied confirmation reports the saved result without a second grant',async t=>{
 const f=fixture(t),draft=await shown(f);
 assert.equal((await f.confirm({draftId:draft.id,revision:draft.revision})).status,'completed');
 const replay=await f.confirm({a:f.authority({previousSourceRequestId:'wechat-source-next-turn'}),draftId:draft.id,revision:draft.revision});
 assert.equal(replay.status,'completed');assert.match(replay.text,/已经保存/);assert.equal(f.grants().length,1);
});

test('a missing verifier or an empty summary is a rejection, never a loose pass',async t=>{
 const f=fixture(t),draft=await shown(f);
 const noVerifier=await confirmOwnerServiceDraft({authority:f.authority(),sessionId:f.sessionId,draftId:draft.id,revision:draft.revision,serviceSetup:f.serviceSetup,ledger:f.ledger});
 assert.equal(noVerifier.status,'needs_input',JSON.stringify(noVerifier));
 assert.equal(f.grants().length,0,'缺展示核实器不得保存');
 let confirmed=0;
 const empty=await confirmOwnerServiceDraft({
  authority:f.authority(),sessionId:'session-empty',draftId:'draft-empty',revision:1,
  serviceSetup:{snapshotForOwner:()=>[{id:'draft-empty',revision:1,status:'ready',summary:''}],confirm:async()=>{confirmed++;return{reply:'不应保存'};}},
  ledger:{view:()=>[{draftId:'draft-empty',revision:1,marker:serviceDraftMarker(1),summaryHash:serviceDraftSummaryHash('')}]},
  previousTurnDelivered:()=>true,
 });
 assert.equal(empty.status,'needs_input',JSON.stringify(empty));
 assert.equal(confirmed,0,'空摘要不得走到写入');
 assert.equal(f.grants().length,0);
});

test('legacy display records without a version marker and content hash are ignored',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'family-service-ledger-legacy-')));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const directory=join(root,'views');mkdirSync(directory,{mode:0o700});
 const contextId=ownerServiceContextId('session-a');
 writeFileSync(join(directory,'owner-service-drafts.json'),JSON.stringify({version:1,views:[{sessionId:'session-a',sourceRequestId:'wechat-source-legacy',personId:'owner',origin:'wechat',contextId,draftId:'legacy-draft',revision:1,at:instant}]}),{mode:0o600});
 const ledger=createOwnerServiceLedger({directory,now:()=>instant});
 assert.deepEqual(ledger.view({sessionId:'session-a',sourceRequestId:'wechat-source-legacy',personId:'owner',contextId}),[],'旧记录不能证明展示过哪个版本');
 ledger.record({sessionId:'session-a',sourceRequestId:'wechat-source-new',personId:'owner',origin:'wechat',contextId,draftId:'new-draft',revision:1,summary:'给妈妈开通AI 日报。',marker:serviceDraftMarker(1)});
 assert.equal(ledger.view({sessionId:'session-a',sourceRequestId:'wechat-source-new',personId:'owner',contextId}).length,1);
 assert.equal(JSON.parse(readFileSync(join(directory,'owner-service-drafts.json'),'utf8')).version,2,'下一次展示记录升级为新格式');
});
