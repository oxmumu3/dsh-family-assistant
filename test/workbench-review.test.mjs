import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';
import {createWorkbench} from '../src/workbench.mjs';

const now=()=> '2026-10-23T12:00:00.000Z';
function fixture(t,{plan,execute}={}){
  const directory=mkdtempSync(join(tmpdir(),'family-workbench-review-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const store=createStore({directory,now});
  for(const[id,role,label]of[['owner','owner','我'],['mom','elder','妈妈'],['dad','elder','爸爸']])store.addPerson({id,role,label});
  const options={directory,store,now,plan:plan??(async()=>({reply:'请补充信息。',operation:null})),execute:execute??(async()=>({status:'api_accepted'}))};
  return{store,wb:createWorkbench(options),options};
}
const proposal=actions=>({reply:'请核对草稿。',operation:{type:'plan',actions}});

test('review: incomplete new profile does not leave a nameless persisted draft',async t=>{
  const {wb,options}=fixture(t,{plan:async()=>({reply:'请补充称呼。',operation:{type:'profile',patch:{notes:'喜欢养花'}}})});
  await wb.chat({text:'喜欢养花',requestId:'missing_label'});
  assert.equal(wb.snapshot().cards.length,0);
  assert.equal(createWorkbench(options).snapshot().cards.length,0);
});

test('review: a rebind during model planning cannot retarget the resulting send',async t=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers();let sends=0;
  const {wb,store}=fixture(t,{plan:async()=>{entered.resolve();await release.promise;return proposal([{type:'send_message',personId:'mom',text:'周末见。'}]);},execute:async action=>{
    if(action.expectedRoute?.peerId!==store.binding(action.personId)?.peerId)return{status:'failed',detail:'绑定已改变。'};
    sends++;return{status:'api_accepted'};
  }});
  store.bindPerson('mom',{accountId:'account_old',peerId:'peer_old'});
  const pending=wb.chat({text:'告诉妈妈周末见',contextId:'person:mom',requestId:'rebind_during_plan'});
  await entered.promise;store.bindPerson('mom',{accountId:'account_new',peerId:'peer_new'});release.resolve();await pending;
  const card=wb.snapshot().cards[0];if(card)await wb.confirm({cardId:card.id,revision:card.revision});
  assert.equal(sends,0,'the model request started with the old route and must not silently authorize the new route');
});

test('review: quoted time evidence cannot authorize a different model clock',async t=>{
  const {wb}=fixture(t,{plan:async()=>proposal([{type:'remind',personId:'mom',text:'浇花',date:'2026-10-24',time:'15:00',repeat:'once',timeEvidence:'明早八点'}])});
  await wb.chat({text:'明早八点提醒妈妈浇花',requestId:'wrong_model_clock'});
  assert.equal(wb.snapshot().cards.length,0,'15:00 does not agree with the quoted 08:00');
});

test('review: discussion of confirmation is not authorization to execute a draft',async t=>{
  let output=proposal([{type:'send_daily',personId:'mom'}]),sends=0;
  const {wb}=fixture(t,{plan:async()=>output,execute:async()=>{sends++;return{status:'api_accepted'};}});
  await wb.chat({text:'给妈妈发日报',requestId:'draft'});const card=wb.snapshot().cards[0];
  output={reply:'确认后会发。',operation:{type:'confirm',cardId:card.id}};
  await wb.chat({text:'确认以后会自动每天发吗？',contextId:`card:${card.id}`,requestId:'question'});
  assert.equal(sends,0);assert.equal(wb.snapshot().cards[0].status,'draft');
});

test('review: unknown exceptions stay uncertain and cannot be retried',async t=>{
  let sends=0;const {wb}=fixture(t,{plan:async()=>proposal([{type:'send_message',personId:'mom',text:'周末见。'}]),execute:async()=>{sends++;throw new Error('connection closed after write');}});
  await wb.chat({text:'告诉妈妈周末见',requestId:'unknown_send'});const card=wb.snapshot().cards[0];
  await wb.confirm({cardId:card.id,revision:card.revision});const action=wb.snapshot().cards[0].actions[0];
  assert.equal(action.status,'uncertain');await assert.rejects(()=>wb.retry({cardId:card.id,actionId:action.id}),/未知|不明|明确失败/);assert.equal(sends,1);
});

test('review: an existing profile card can be corrected in its own person context',async t=>{
  let output={reply:'资料草稿。',operation:{type:'profile',personId:'mom',patch:{notes:'住北京'}}};
  const {wb,store}=fixture(t,{plan:async()=>output});await wb.chat({text:'妈妈住北京',contextId:'person:mom',requestId:'profile_first'});
  const card=wb.snapshot().cards[0];output={reply:'改为上海。',operation:{type:'profile',personId:'mom',cardId:card.id,patch:{notes:'住上海'}}};
  await wb.chat({text:'改成上海',contextId:'person:mom',requestId:'profile_correction'});
  assert.equal(store.person('mom').notes,'住上海');assert.equal(wb.snapshot().cards.length,1);
});
