import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createStore} from '../src/store.mjs';
import {createWorkbench} from '../src/workbench.mjs';

const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const proposal=(text='今晚八点见')=>({reply:'模型自述：已经发出，草稿也准备好了',operation:{type:'plan',actions:[{type:'send_message',personId:'k',text}]}});
function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'owner-message-draft-workbench-synthetic-')),store=createStore({directory}),executed=[];let output=proposal();
 for(const[id,role,label]of[['owner','owner','我'],['k','elder','K']]){store.addPerson({id,role,label});store.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id});}
 const options={directory,store,plan:async()=>output,execute:async action=>{executed.push(action);return{status:'api_accepted'};}},wb=createWorkbench(options);
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const chat=patch=>wb.chat({text:'先起草给K发的消息，暂时不要发送',requestId:'draft-source',draftOnly:true,messageDraftOrigin:'wechat',authorityRoute:store.route('owner'),...patch});
 const draft=patch=>wb.messageDraft({requestId:'draft-source',origin:'wechat',authorityRoute:store.route('owner'),...patch});
 return{directory,store,wb,options,executed,chat,draft,set:value=>{output=value;}};
}

test('a displayed message draft comes from persistent real cards and survives restart without raw routes',async t=>{
 const f=fixture(t),view=await f.chat(),card=view.cards[0],reply=view.messages.at(-1).text;
 assert.match(reply,/发给K[：:][\s\S]*今晚八点见/);assert.match(reply,/确认[\s\S]*修改/);assert.doesNotMatch(reply,/模型自述|已经发出/);assert.equal(f.executed.length,0);
 assert.deepEqual(f.draft(),{stale:false,cards:[card]});assert.equal(f.draft({origin:'console'}),null);assert.equal(f.draft({requestId:'missing'}),null);
 const stored=JSON.parse(readFileSync(join(f.directory,'workbench.json'),'utf8')).inputs.find(row=>row.id==='draft-source').messageDraft;
 assert.deepEqual(stored,{origin:'wechat',ownerRouteHash:sha(f.store.route('owner')),cards:[{id:card.id,revision:card.revision,recipients:[{personId:'k',routeHash:sha(f.store.route('k'))}]}]});assert.doesNotMatch(JSON.stringify(stored),/account-|peer-|accountId|peerId/);
 assert.deepEqual(createWorkbench(f.options).messageDraft({requestId:'draft-source',origin:'wechat',authorityRoute:f.store.route('owner')}),{stale:false,cards:[card]});
});

test('a model claiming draft success without a real card produces an explicit not-ready result',async t=>{
 const f=fixture(t);f.set({reply:'草稿好了，回复确认即可发送',operation:null});const view=await f.chat();assert.equal(view.cards.length,0);assert.equal(f.draft(),null);assert.match(view.messages.at(-1).text,/尚未|还没有|未能/);assert.doesNotMatch(view.messages.at(-1).text,/草稿好了|回复确认即可发送/);
});

for(const operation of[{type:'profile',patch:{label:'新家人'}},{type:'plan',actions:[{type:'send_daily',personId:'k'}]},{type:'plan',actions:[{type:'send_message',personId:'k',text:'可以保存的正文'},{type:'send_daily',personId:'k'}]}])test('the message draft path refuses a different operation without side effects: '+JSON.stringify(operation),async t=>{
 const f=fixture(t);f.set({reply:'草稿好了',operation});const view=await f.chat();assert.equal(view.cards.length,0);assert.equal(f.executed.length,0);assert.equal(f.store.snapshot().people.length,2);assert.equal(f.draft(),null);assert.match(view.messages.at(-1).text,/消息草稿|仅|只能/);
});

test('a revised or cancelled card invalidates an older displayed message draft',async t=>{
 const f=fixture(t);await f.chat();const card=f.wb.snapshot().cards[0];f.set({reply:'已修改',operation:{type:'plan',cardId:card.id,actions:[{type:'send_message',personId:'k',id:card.actions[0].id,text:'改成九点见'}]}});await f.chat({requestId:'draft-revision',text:'改成九点见',contextId:'card:'+card.id});assert.deepEqual(f.draft(),{stale:true,cards:[]});
 assert.equal(f.draft({requestId:'draft-revision'}).stale,false);await f.wb.cancel({cardId:card.id});assert.deepEqual(f.draft({requestId:'draft-revision'}),{stale:true,cards:[]});
});

test('recipient and Owner replacement bindings invalidate the displayed draft even with the old supplied route',async t=>{
 for(const personId of['k','owner']){const f=fixture(t);await f.chat();const prior=f.store.route('owner');f.store.bindPerson(personId,{accountId:'replacement-'+personId,peerId:'replacement-peer-'+personId});assert.deepEqual(f.draft(),{stale:true,cards:[]});assert.deepEqual(f.draft({authorityRoute:prior}),{stale:true,cards:[]});}
});

test('message draft origin is part of request identity and the internal mode requires draftOnly',async t=>{
 const f=fixture(t);await f.chat();await assert.rejects(()=>f.chat({messageDraftOrigin:'console',authorityRoute:undefined}),/重复|标识/);await assert.rejects(()=>f.chat({requestId:'invalid-mode',draftOnly:undefined}),/草稿|draftOnly/);
});

test('the previous workbench path is unchanged when messageDraftOrigin is absent',async t=>{
 const f=fixture(t);f.set({reply:'原流程保持的普通答复',operation:null});const view=await f.wb.chat({text:'普通对话',requestId:'legacy'});assert.equal(view.messages.at(-1).text,'原流程保持的普通答复');assert.equal(f.wb.messageDraft({requestId:'legacy',origin:'console'}),null);
});

test('an external handler can recheck and confirm its real message draft inside the same serial queue', {timeout:1500},async t=>{
 const f=fixture(t);await f.chat();const route=f.store.route('owner');await f.wb.external({text:'确认发送',requestId:'confirm-source',authorityRoute:route},async({confirm})=>{const draft=f.draft();assert.equal(draft.stale,false);for(const card of draft.cards)await confirm({cardId:card.id,revision:card.revision,authorityRoute:route,authorize:()=>true});return{reply:'已按真实状态处理。'};});assert.equal(f.executed.length,1);assert.equal(f.executed[0].text,'今晚八点见');assert.deepEqual(f.draft(),{stale:true,cards:[]});
});
