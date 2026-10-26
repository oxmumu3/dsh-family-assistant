import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {createStore} from '../src/store.mjs';
import {createWorkbench} from '../src/workbench.mjs';
import {parseWorkbenchReply,createHostWorkbenchPlanner} from '../src/workbench-model.mjs';

const now=()=> '2026-10-23T12:00:00.000Z';
const proposal=(enabled=true,personId='mom')=>({reply:'请核对 PPT 制作安排。',operation:{type:'plan',actions:[{type:'presentation_service',personId,enabled}]}});
function setup(t){
  const directory=mkdtempSync(join(tmpdir(),'family-presentation-controls-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const store=createStore({directory,now});
  for(const [id,role,label] of [['owner','owner','我'],['mom','elder','妈妈'],['dad','elder','爸爸']])store.addPerson({id,role,label,timeZone:'Asia/Shanghai'});
  const executed=[],enabled=new Map();let answer=proposal();
  const wb=createWorkbench({directory,store,now,plan:async()=>answer,execute:async action=>{executed.push(action);enabled.set(action.personId,action.enabled);return{status:'completed',detail:action.enabled?'PPT 制作已开启。':'PPT 制作已停用。'};}});
  return{store,wb,executed,enabled,answer:value=>{answer=value;}};
}
test('presentation service accepts only the member ID and a real boolean',()=>{
  for(const enabled of [true,false])assert.deepEqual(parseWorkbenchReply(JSON.stringify(proposal(enabled))),proposal(enabled));
  for(const patch of [{enabled:'true'},{enabled:1},{enabled:null},{enabled:undefined},{tool:'exec'},{path:'/private/materials'},{template:'arbitrary'},{personId:'../mom'}]){
    const value=proposal();Object.assign(value.operation.actions[0],patch);
    assert.throws(()=>parseWorkbenchReply(JSON.stringify(value)),/字段|参数|标识|格式|开关/);
  }
});
test('opening and disabling PPT stay drafts until Owner confirms, with idempotent dispatch',async t=>{
  const {wb,executed,enabled,answer}=setup(t);
  await wb.chat({text:'给妈妈开通做 PPT',requestId:'enable-mom'});
  let card=wb.snapshot().cards[0];assert.ok(card,'PPT request should create a plan card');
  assert.equal(card.status,'draft');assert.equal(executed.length,0);assert.equal(enabled.has('mom'),false);
  await wb.confirm({cardId:card.id,revision:card.revision});
  await wb.confirm({cardId:card.id,revision:card.revision});
  assert.equal(executed.length,1);assert.equal(executed[0].type,'presentation_service');assert.equal(enabled.get('mom'),true);
  answer(proposal(false,'dad'));
  await wb.chat({text:'停用爸爸 PPT',requestId:'disable-dad'});
  card=wb.snapshot().cards[1];assert.equal(card.actions[0].enabled,false);assert.equal(executed.length,1);
  answer({reply:'确认停用',operation:{type:'confirm',cardId:card.id}});
  await wb.chat({text:'确认安排',contextId:'card:'+card.id,requestId:'confirm-disable-dad'});
  assert.equal(executed.length,2);assert.equal(enabled.get('dad'),false);
});
test('unregistered and Owner targets cannot become PPT service cards',async t=>{
  const {wb,answer,executed}=setup(t);
  for(const personId of ['missing','owner']){answer(proposal(true,personId));await wb.chat({text:'开通 PPT',requestId:'target-'+personId});}
  assert.equal(wb.snapshot().cards.length,0);assert.equal(executed.length,0);
});
test('a member cannot request or confirm Owner capability changes',async t=>{
  const {wb,store,executed}=setup(t);store.bindPerson('mom',{accountId:'mom-bot',peerId:'mom-peer'});
  await assert.rejects(wb.chat({text:'给我开通做 PPT',requestId:'member-enable',authorityRoute:store.route('mom')}),/Owner|管理/);
  assert.equal(wb.snapshot().cards.length,0);
  await wb.chat({text:'给妈妈开通做 PPT',requestId:'owner-enable'});const card=wb.snapshot().cards[0];
  await assert.rejects(wb.confirm({cardId:card.id,revision:card.revision,authorityRoute:store.route('mom')}),/Owner|管理/);
  assert.equal(executed.length,0);assert.equal(wb.snapshot().cards[0].status,'draft');
});
test('PPT planner recognizes scoped service without exposing general tools',async()=>{
  let captured;
  const planner=createHostWorkbenchPlanner({get:()=>({async *stream(input){captured=input;yield{type:'text-delta',index:0,text:JSON.stringify(proposal())};yield{type:'finish',reason:'stop'};}})},()=>({provider:'test',model:'test'}));
  const people=[{id:'owner',role:'owner',label:'我',timeZone:'Asia/Shanghai'},{id:'mom',role:'elder',label:'妈妈',timeZone:'Asia/Shanghai'}];
  assert.deepEqual((await planner({text:'给妈妈开通做 PPT',people,now:now()})).operation,proposal().operation);
  assert.deepEqual(captured.tools,[]);assert.match(captured.system,/presentation_service/);assert.match(captured.system,/txt.*md.*docx.*pptx/i);assert.match(captured.system,/未就绪/);
  const invalid=createHostWorkbenchPlanner({get:()=>({async *stream(){yield{type:'text-delta',index:0,text:JSON.stringify(proposal(true,'owner'))};yield{type:'finish',reason:'stop'};}})},()=>({provider:'test',model:'test'}));
  await assert.rejects(invalid({text:'给我开通 PPT',people,now:now()}),/成员|长辈/);
});
test('PPT controls and task states are in existing family and trajectory views',()=>{
  const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
  assert.match(app,/presentation_service\s*:\s*'PPT制作'/);
  assert.match(app,/presentation_service'\s*\?\s*'PPT制作'/);
  assert.match(app,/item\.enabled\s*\?\s*'开启'\s*:\s*'停用'/);
  assert.match(app,/state\.presentations/);assert.match(app,/未就绪/);
  for(const status of ['collecting','queued','generating','ready','dispatching','api_accepted','uncertain','failed','cancelled','interrupted'])assert.ok(new RegExp(status+':').test(app),'PPT task state '+status+' should have an explicit label');
  assert.match(app,/支持 txt、md、docx、pptx 中的文字材料/);
});

async function ui(snapshot,{post,storage=new Map()}={}){
  const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8'),app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
  const elements=new Map(),all=[],requests=[],deferred=[];let document;
  const descendants=element=>element.children.flatMap(child=>[child,...descendants(child)]);
  class Element{
    constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.attributes={};this.listeners={};this.options=[{},{}];this.value='';this._text='';this.hidden=false;this.scrollTop=0;this.scrollHeight=100;this.clientHeight=100;all.push(this);}
    set textContent(value){this._text=String(value??'');this.children=[];}get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
    get firstChild(){return this.children[0];}get lastChild(){return this.children.at(-1);}
    append(...children){this.children.push(...children);for(const child of children)child.parent=this;}
    replaceChildren(...children){this._text='';this.children=[];this.append(...children);}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
    setAttribute(key,value){this.attributes[key]=String(value);}removeAttribute(key){delete this.attributes[key];}
    addEventListener(event,fn){(this.listeners[event]??=[]).push(fn);}fire(event){for(const fn of this.listeners[event]??[])fn({preventDefault(){},target:this});}
    focus(){document.activeElement=this;}reset(){this.dataset.dirty='';}querySelectorAll(selector){return descendants(this).filter(element=>selector.includes(element.tagName));}
  }
  for(const match of html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)){const element=new Element(match[1]);element.hidden=/\bhidden(?:\s|>|=)/.test(match[0]);elements.set(match[2],element);}
  document={hidden:false,body:new Element('body'),activeElement:null,getElementById:id=>{assert.ok(elements.has(id),'missing DOM ID '+id);return elements.get(id);},createElement:tag=>new Element(tag),querySelectorAll:selector=>selector==='button'?all.filter(element=>element.tagName==='button'):[],addEventListener(){}};
  const sessionStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};let sequence=0;
  runInNewContext(app,{document,window:{parent:{},sessionStorage,addEventListener(){}},sessionStorage,crypto:{randomUUID:()=> 'ui-request-'+(++sequence)},AbortController,URL,fetch:async(url,options={})=>{const body=options.body?JSON.parse(options.body):null;requests.push(body);if(body&&post)await post(body,snapshot);return{ok:true,json:async()=>structuredClone(snapshot)};},setTimeout:(fn,ms)=>{if(ms===0)deferred.push(fn);return 1;},clearTimeout(){},setInterval:()=>1,clearInterval(){}});
  async function settle(){for(let i=0;i<5;i++){await new Promise(resolve=>setImmediate(resolve));for(const fn of deferred.splice(0))fn();}}
  await settle();return{elements,requests,settle,storage,click:id=>elements.get(id).fire('click'),submit:id=>elements.get(id).fire('submit'),input:(id,value)=>{elements.get(id).value=value;elements.get(id).fire('input');},button:(label,container='workspace')=>descendants(elements.get(container)).find(element=>element.tagName==='button'&&element.textContent===label)};
}
const uiState=()=>({people:[{id:'owner',role:'owner',label:'我',timeZone:'Asia/Shanghai'},{id:'mom',role:'elder',label:'妈妈',timeZone:'Asia/Shanghai',shareWithOwner:'none'}],config:{paused:false,timeZone:'Asia/Shanghai'},model:{available:true},reminders:[],outbox:[],workbench:{messages:[],cards:[],requests:[]},presentations:{available:true,people:[{personId:'mom',enabled:true}],tasks:[]}});
test('rendered PPT card has an explicit capability switch and uses the existing confirmation control',async()=>{
  const snapshot=uiState();snapshot.workbench.cards=[{id:'ppt-plan',kind:'plan',status:'draft',revision:3,actions:[{id:'ppt-enable',type:'presentation_service',personId:'mom',enabled:true,status:'draft'}]}];
  snapshot.workbench.messages=[{id:'ppt-proposal',role:'assistant',text:'请核对妈妈的 PPT 制作安排。',cardIds:['ppt-plan']}];
  const view=await ui(snapshot),space=view.elements.get('workspace');
  assert.match(space.textContent,/PPT制作.*开启/s);assert.doesNotMatch(space.textContent,/每日问候/);
  view.button('确认待执行安排').fire('click');await view.settle();
  assert.deepEqual(view.requests.find(request=>request?.action==='confirm_card'),{action:'confirm_card',cardId:'ppt-plan',revision:3});
  view.click('nav-family');assert.match(space.textContent,/PPT制作已开启/);
  snapshot.presentations.available=false;view.click('refresh');await view.settle();assert.match(space.textContent,/PPT制作已开启 · 未就绪/);
});
test('PPT trajectory refreshes task status without claiming phone receipt or showing an empty task list',async()=>{
  const snapshot=uiState();snapshot.presentations.tasks=[{id:'ppt-task',personId:'mom',status:'generating',version:1,detail:'正在制作可编辑 PPT。',updatedAt:now()}];
  const view=await ui(snapshot);view.click('nav-activity');const space=view.elements.get('workspace');
  assert.match(space.textContent,/PPT制作进展.*妈妈 · PPT制作.*正在制作/s);
  assert.doesNotMatch(space.textContent,/还没有待执行的安排/);
  snapshot.presentations.tasks[0]={...snapshot.presentations.tasks[0],status:'api_accepted',detail:'文件接口已接受。'};
  view.click('refresh');await view.settle();assert.match(space.textContent,/文件接口已接受.*手机取得并打开仍需本人确认/s);assert.doesNotMatch(space.textContent,/手机已收到|文件已送达/);
  snapshot.presentations.tasks[0]={...snapshot.presentations.tasks[0],status:'uncertain',detail:'发送结果未知。'};
  view.click('refresh');await view.settle();assert.match(space.textContent,/未自动重发/);
});

test('both add-family entries open focused intake while preserving the main conversation draft',async()=>{
  const view=await ui(uiState());view.input('owner-input','主对话还没发的事');
  for(const entry of ['add-family','rail-add-family']){
    view.click(entry);assert.equal(view.elements.get('drawer-overlay').hidden,false);assert.equal(view.elements.get('family-intake-panel')?.hidden,false,'add entry should open the dedicated intake dialog');
    assert.equal(view.elements.get('owner-input').value,'主对话还没发的事');assert.equal(view.requests.filter(request=>request?.action==='owner_chat').length,0);
    view.input('family-intake-input','K 喜欢画画，希望小美帮着做 PPT');view.click('drawer-close');
  }
  view.click('add-family');assert.equal(view.elements.get('family-intake-input').value,'K 喜欢画画，希望小美帮着做 PPT');
  assert.equal(view.elements.get('owner-input').value,'主对话还没发的事');
});
test('intake keeps edits and confirmation in the dialog and then offers the created member connection',async()=>{
  const snapshot=uiState();let edits=0;
  const view=await ui(snapshot,{post:async body=>{
    if(body.action==='owner_chat'){
      edits++;assert.equal(body.profileIntake,true);
      if(edits===2)assert.equal(body.contextId,'card:new-profile');
      snapshot.workbench.cards=[{id:'new-profile',kind:'profile',status:'draft',revision:edits,profile:{label:'K',timeZone:'Asia/Shanghai',notes:edits===2?'喜欢画画；希望做 PPT；说话简短':'喜欢画画；希望做 PPT',interests:['画画']}}];
      snapshot.workbench.messages.push({id:'answer-'+edits,role:'assistant',text:'资料已整理，请核对。',cardIds:['new-profile']});
    }else if(body.action==='confirm_card'){
      assert.equal(body.cardId,'new-profile');snapshot.people.push({id:'new-member',role:'elder',label:'K',timeZone:'Asia/Shanghai',shareWithOwner:'none'});
      Object.assign(snapshot.workbench.cards[0],{status:'saved',personId:'new-member'});
    }
  }});
  view.input('owner-input','原主对话草稿');view.click('add-family');view.input('family-intake-input','K 喜欢画画，希望小美帮着做 PPT');view.submit('family-intake-form');await view.settle();
  assert.equal(view.elements.get('drawer-overlay').hidden,false);assert.match(view.elements.get('family-intake-result').textContent,/K.*希望做 PPT/s);assert.equal(snapshot.people.length,2);
  view.input('family-intake-input','说话简短些');view.submit('family-intake-form');await view.settle();assert.equal(edits,2);assert.match(view.elements.get('family-intake-result').textContent,/说话简短/);
  view.button('确认创建家人','family-intake-result').fire('click');await view.settle();assert.equal(snapshot.people.length,3);assert.equal(view.elements.get('drawer-overlay').hidden,false);
  view.button('连接 K 的微信','family-intake-result').fire('click');await view.settle();assert.equal(view.elements.get('person-panel').hidden,false);assert.equal(view.elements.get('person-name').textContent,'K');
  assert.equal(view.elements.get('owner-input').value,'原主对话草稿');assert.equal(view.requests.filter(request=>request?.action==='login').length,0);
});
test('profile intake cannot update an existing person or execute a model-proposed action',async t=>{
  const {wb,answer,store,executed}=setup(t);
  for(const operation of [{type:'profile',personId:'mom',patch:{notes:'wrong update'}},{type:'plan',actions:[{type:'presentation_service',personId:'mom',enabled:true}]}]){
    answer({reply:'整理好了',operation});await wb.chat({text:'介绍新家人',requestId:'intake-'+operation.type,profileIntake:true});
  }
  assert.equal(store.person('mom').notes,'');assert.equal(wb.snapshot().cards.length,0);assert.equal(executed.length,0);
  answer({reply:'整理好了',operation:{type:'profile',patch:{label:'K',notes:'喜欢画画'}}});
  await wb.chat({text:'K 喜欢画画',requestId:'intake-new',profileIntake:true});const card=wb.snapshot().cards[0];assert.equal(card.status,'draft');assert.equal(store.snapshot().people.length,3);
  answer({reply:'确认',operation:{type:'confirm',cardId:card.id}});await wb.chat({text:'确认',requestId:'intake-model-confirm',contextId:'card:'+card.id,profileIntake:true});
  assert.equal(wb.snapshot().cards[0].status,'draft');assert.equal(store.snapshot().people.length,3);
});
test('intake retries an uncertain response by request ID even after refresh exposes its result',async()=>{
  const snapshot=uiState();let calls=0;
  const view=await ui(snapshot,{post:async body=>{
    if(body.action!=='owner_chat')return;calls++;
    if(calls===1){snapshot.workbench.cards=[{id:'recovered',kind:'profile',status:'draft',revision:1,profile:{label:'K',timeZone:'Asia/Shanghai',notes:'喜欢画画',interests:['画画']}}];snapshot.workbench.messages.push({id:'recovered-reply',requestId:body.requestId,role:'assistant',text:'资料已整理。',cardIds:['recovered']});throw new TypeError('connection lost');}
  }});
  view.click('add-family');view.input('family-intake-input','K 喜欢画画');view.submit('family-intake-form');await view.settle();const first=view.requests.find(request=>request?.action==='owner_chat');
  view.click('refresh');await view.settle();view.submit('family-intake-form');await view.settle();
  const sent=view.requests.filter(request=>request?.action==='owner_chat');assert.equal(sent.length,2);assert.equal(sent[1].requestId,first.requestId);assert.match(view.elements.get('family-intake-result').textContent,/K.*喜欢画画/s);assert.equal(view.elements.get('family-intake-input').value,'');
});
test('intake journal links response to its request and refuses request reuse across modes',async t=>{
  const {wb,answer}=setup(t);answer({reply:'请核对',operation:{type:'profile',patch:{label:'K'}}});
  await wb.chat({text:'K',requestId:'same-mode-key',profileIntake:true});
  assert.equal(wb.snapshot().messages.at(-1).requestId,'same-mode-key');
  await assert.rejects(wb.chat({text:'K',requestId:'same-mode-key'}),/重复|标识/);
});
