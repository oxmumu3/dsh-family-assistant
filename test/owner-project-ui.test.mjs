import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const workspace={workspaceId:'demo-project',path:'/projects/family-demo',title:'家人服务项目'};
const initial=()=>({people:[{id:'owner',role:'owner',label:'我',timeZone:'Asia/Shanghai',shareWithOwner:'none'}],config:{paused:false,timeZone:'Asia/Shanghai'},model:{available:true},reminders:[],outbox:[],workbench:{messages:[],cards:[],requests:[]}});
const descendants=element=>element.children.flatMap(child=>[child,...descendants(child)]);
async function harness({bridge,storage=new Map(),snapshot=initial(),storageFailure=false}={}){
  const all=[],elements=new Map(),deferred=[],requests=[],intervals=[];let document,sequence=0;
  class Element{
    constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.attributes={};this.listeners={};this.options=[{},{}];this.value='';this._text='';this.hidden=false;this.disabled=false;this.scrollTop=0;this.scrollHeight=100;this.clientHeight=100;all.push(this);}
    set textContent(value){this._text=String(value??'');this.children=[];}get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
    get firstChild(){return this.children[0];}get lastChild(){return this.children.at(-1);}
    append(...children){this.children.push(...children);for(const child of children)child.parent=this;}
    replaceChildren(...children){this._text='';this.children=[];this.append(...children);}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
    setAttribute(key,value){this.attributes[key]=String(value);}getAttribute(key){return this.attributes[key]??null;}removeAttribute(key){delete this.attributes[key];}
    addEventListener(event,fn){(this.listeners[event]??=[]).push(fn);}fire(event){if(event==='click'&&this.disabled)return;for(const fn of this.listeners[event]??[])fn({preventDefault(){},target:this});}
    focus(){document.activeElement=this;}reset(){this.dataset.dirty='';}querySelectorAll(selector){return descendants(this).filter(element=>selector.includes(element.tagName));}
    contains(target){return target===this||this.children.some(child=>child.contains?.(target));}
  }
  for(const match of html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)){const element=new Element(match[1]);element.hidden=/\bhidden(?:\s|>|=)/.test(match[0]);elements.set(match[2],element);}
  document={hidden:false,body:new Element('body'),activeElement:null,getElementById:id=>{assert.ok(elements.has(id),'missing DOM ID '+id);return elements.get(id);},createElement:tag=>new Element(tag),querySelectorAll:selector=>selector==='button'?all.filter(element=>element.tagName==='button'):[],addEventListener(){}};
  const sessions={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)};
  const local={...sessions,setItem:(key,value)=>{if(storageFailure)throw new Error('storage disabled');sessions.setItem(key,value);}};
  runInNewContext(app,{document,window:{parent:{__FamilyOwnerAgent:bridge},sessionStorage:sessions,localStorage:local,addEventListener(){}},sessionStorage:sessions,crypto:{randomUUID:()=>`aa000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`},AbortController,URL,fetch:async(url,options={})=>{requests.push(options.body?JSON.parse(options.body):null);return{ok:true,json:async()=>structuredClone(snapshot)};},setTimeout:(fn,ms)=>{if(ms===0)deferred.push(fn);return 1;},clearTimeout(){},setInterval:fn=>{intervals.push(fn);return intervals.length;},clearInterval(){}});
  async function settle(){for(let i=0;i<8;i++){await new Promise(resolve=>setImmediate(resolve));for(const fn of deferred.splice(0))fn();}}
  await settle();
  return{elements,requests,storage,settle,click:id=>{assert.ok(elements.has(id),'missing control '+id);elements.get(id).fire('click');},input:value=>{elements.get('owner-input').value=value;elements.get('owner-input').fire('input');},submit:()=>elements.get('composer-form').fire('submit'),button:(label,container='workspace')=>descendants(elements.get(container)).find(element=>element.tagName==='button'&&element.textContent===label),poll:async()=>{for(const fn of intervals)fn();await settle();}};
}
function native(overrides={}){
  const calls=[];
  const bridge={listWorkspaces:async()=>[workspace],pickWorkspace:async()=>null,addWorkspace:async path=>({workspaceId:'picked',path,title:'新选项目'}),start:async intent=>{calls.push(['start',structuredClone(intent)]);return{state:'succeeded',text:'已读取项目说明。'};},observe:async intent=>{calls.push(['observe',structuredClone(intent)]);return{state:'succeeded',text:'任务结果已核对。'};},cancel:async intent=>{calls.push(['cancel',structuredClone(intent)]);return{cancelRequested:true};},openSession:async intent=>{calls.push(['openSession',structuredClone(intent)]);return{opened:true};},...overrides};return{bridge,calls};
}
test('family operations keep their route and unavailable native project requests stay unsent',async()=>{
  const view=await harness();view.input('给妈妈开通做 PPT');view.submit();await view.settle();assert.equal(view.requests.filter(item=>item?.action==='owner_chat').length,1);
  view.input('扫描本地项目，看看有什么消息源');view.submit();await view.settle();
  assert.equal(view.elements.get('drawer-overlay').hidden,false);assert.equal(view.elements.get('owner-project-panel')?.hidden,false);
  assert.match(view.elements.get('owner-project-status').textContent,/原生.*未就绪/);assert.equal(view.elements.get('owner-input').value,'扫描本地项目，看看有什么消息源');assert.equal(view.requests.filter(item=>item?.action==='owner_chat').length,1);
});
test('selecting a project continues the pending prompt and followups reuse one native session',async()=>{
  const {bridge,calls}=native(),view=await harness({bridge});view.input('读取本地项目说明');view.submit();await view.settle();
  view.button('家人服务项目','owner-project-list').fire('click');await view.settle();
  assert.equal(calls.filter(item=>item[0]==='start').length,1);const first=calls[0][1];
  assert.equal(first.workspaceId,workspace.workspaceId);assert.equal(first.cwd,workspace.path);assert.match(first.sessionId,/^family_owner_[a-f0-9-]{36}$/);assert.match(first.requestId,/^[a-f0-9-]{36}$/);assert.equal(first.prompt,'读取本地项目说明');
  assert.equal(view.requests.filter(item=>item?.action==='owner_chat').length,0);assert.equal(view.elements.get('owner-project-strip').hidden,false);assert.match(view.elements.get('workspace').textContent,/已读取项目说明/);
  view.input('请继续整理成一份概要');view.submit();await view.settle();const second=calls.filter(item=>item[0]==='start')[1][1];assert.equal(second.sessionId,first.sessionId);assert.notEqual(second.requestId,first.requestId);
});
test('project choice and separate drafts survive exiting and reopening the local mode',async()=>{
  const {bridge}=native(),view=await harness({bridge});view.input('还没发的家庭安排');view.click('owner-project-open');await view.settle();view.button('家人服务项目','owner-project-list').fire('click');await view.settle();
  view.input('项目里还没发的想法');view.click('owner-project-exit');assert.equal(view.elements.get('owner-input').value,'还没发的家庭安排');
  view.click('owner-project-open');await view.settle();assert.equal(view.elements.get('owner-input').value,'项目里还没发的想法');assert.equal(view.elements.get('drawer-overlay').hidden,true);
  const restored=await harness({bridge,storage:view.storage});assert.equal(restored.elements.get('owner-project-strip').hidden,false);assert.equal(restored.elements.get('owner-input').value,'项目里还没发的想法');
});
test('approval is handed to the official session and only observation resumes task status',async()=>{
  const {bridge,calls}=native({start:async intent=>{calls.push(['start',structuredClone(intent)]);return{state:'needs_approval',text:'正在等你确认项目访问。'};}});
  const view=await harness({bridge});view.input('读取项目');view.submit();await view.settle();view.button('家人服务项目','owner-project-list').fire('click');await view.settle();
  assert.match(view.elements.get('workspace').textContent,/等待.*审批|需要.*审批/);view.button('打开官方会话').fire('click');await view.settle();assert.equal(calls.filter(item=>item[0]==='openSession').length,1);assert.equal(calls.filter(item=>item[0]==='start').length,1);
  view.button('核对状态').fire('click');await view.settle();assert.match(view.elements.get('workspace').textContent,/任务结果已核对/);assert.equal(calls.filter(item=>item[0]==='observe').length,1);
});
test('ambiguous admission never dispatches again and check uses the exact owned intent',async()=>{
  const {bridge,calls}=native({start:async intent=>{calls.push(['start',structuredClone(intent)]);throw new Error('network uncertain');},observe:async intent=>{calls.push(['observe',structuredClone(intent)]);return{state:'unknown',text:''};}});
  const view=await harness({bridge});view.input('扫描项目');view.submit();await view.settle();view.button('家人服务项目','owner-project-list').fire('click');await view.settle();
  assert.match(view.elements.get('workspace').textContent,/结果.*不确定|状态.*不明/);view.submit();await view.settle();assert.equal(calls.filter(item=>item[0]==='start').length,1);
  assert.equal(view.button('取消本次任务'),undefined);view.button('核对状态').fire('click');await view.settle();assert.deepEqual(calls[1][1],calls[0][1]);assert.equal(calls[1][0],'observe');
});
test('native folder chooser cancellation leaves the draft and later selection creates one workspace',async()=>{
  let pick=null;const calls=[];const {bridge}=native({listWorkspaces:async()=>[],pickWorkspace:async()=>pick,addWorkspace:async path=>{calls.push(['add',path]);return{workspaceId:'picked',path,title:'指定文件夹'};},start:async intent=>{calls.push(['start',structuredClone(intent)]);return{state:'running',text:'正在读取。'};}});
  const view=await harness({bridge});view.input('读取这个文件夹');view.submit();await view.settle();view.click('owner-project-pick');await view.settle();assert.equal(calls.length,0);assert.equal(view.elements.get('owner-input').value,'读取这个文件夹');
  pick='/projects/chosen';view.click('owner-project-pick');await view.settle();assert.deepEqual(calls[0],['add','/projects/chosen']);assert.equal(calls[1][1].cwd,'/projects/chosen');assert.match(view.elements.get('workspace').textContent,/正在读取/);
  assert.equal(view.button('取消本次任务'),undefined);view.button('在官方会话取消').fire('click');await view.settle();
});
test('project assistant results are rendered as text without HTML execution',async()=>{
  const {bridge}=native({start:async()=>({state:'running',text:'正在分析',messages:[{role:'assistant',text:'读取 README\n<img src=x onerror=alert(1)>'}]})});
  const view=await harness({bridge});view.input('本地项目');view.submit();await view.settle();view.button('家人服务项目','owner-project-list').fire('click');await view.settle();
  assert.match(view.elements.get('workspace').textContent,/读取 README/);assert.match(view.elements.get('workspace').textContent,/<img src=x onerror=alert\(1\)>/);assert.doesNotMatch(app,/\.innerHTML\s*=|insertAdjacentHTML/);
});
test('failed durable intent storage prevents native admission',async()=>{
  const {bridge,calls}=native(),view=await harness({bridge,storageFailure:true});view.input('读取项目');view.submit();await view.settle();view.button('家人服务项目','owner-project-list').fire('click');await view.settle();
  assert.equal(calls.filter(item=>item[0]==='start').length,0);assert.match(view.elements.get('error').textContent,/无法保存.*尚未派发/);assert.equal(view.elements.get('owner-input').value,'读取项目');
});
test('reopen observes the durable request once and another Owner cannot inherit its session or text',async()=>{
  const {bridge,calls}=native({start:async intent=>{calls.push(['start',structuredClone(intent)]);return{state:'running',text:'只有当前 Owner 可见的输出'};}}),first=await harness({bridge});
  first.input('读取项目中的私有说明');first.submit();await first.settle();first.button('家人服务项目','owner-project-list').fire('click');await first.settle();
  const intent=calls[0][1],saved=JSON.parse(first.storage.get('family-owner-project-v1:owner'));assert.deepEqual(saved.runs[0].intent,intent);
  assert.equal(Object.hasOwn(JSON.parse(first.storage.get('family-workbench-drafts-v1')),'ownerProject'),false);
  const reopened=await harness({bridge,storage:first.storage});assert.equal(calls.filter(item=>item[0]==='start').length,1);assert.deepEqual(calls.find(item=>item[0]==='observe')[1],intent);assert.match(reopened.elements.get('workspace').textContent,/任务结果已核对/);
  const other=initial();other.people[0].id='other-owner';const otherView=await harness({bridge,storage:first.storage,snapshot:other});assert.equal(otherView.elements.get('owner-project-strip').hidden,true);assert.doesNotMatch(otherView.elements.get('workspace').textContent,/私有说明|当前 Owner|家人服务项目/);
});
test('late native completion cannot clear the family draft after leaving project mode',async()=>{
  let complete;const {bridge}=native({start:()=>new Promise(resolve=>{complete=()=>resolve({state:'succeeded',text:'项目执行完成'});})}),view=await harness({bridge});
  view.input('同一句还没发的想法');view.click('owner-project-open');await view.settle();view.button('家人服务项目','owner-project-list').fire('click');await view.settle();view.input('同一句还没发的想法');view.submit();await view.settle();
  view.click('owner-project-exit');assert.equal(view.elements.get('owner-input').value,'同一句还没发的想法');complete();await view.settle();assert.equal(view.elements.get('owner-input').value,'同一句还没发的想法');
});
test('project completion keeps family drafts at their conversation anchor and confirmation stays in project mode',async()=>{
  const snapshot=initial(),draft={id:'project-plan',kind:'plan',title:'给妈妈的阅读安排',status:'draft',revision:3,actions:[{id:'daily',type:'daily_schedule',personId:'mom',enabled:true,status:'draft'}]};
  snapshot.workbench.cards.push({id:'unrelated-plan',kind:'plan',title:'无关旧草稿',status:'draft',revision:1,actions:[{id:'old',type:'daily_schedule',personId:'mom',enabled:true,status:'draft'}]});
  const {bridge}=native({start:async()=>{snapshot.workbench.cards.push(draft);snapshot.workbench.messages.push({id:'host-result',role:'assistant',text:'已经整理好了',cardIds:[draft.id]});return{state:'succeeded',text:'已读完项目材料，并整理家人安排。'};}});
  const view=await harness({bridge,snapshot});view.input('读取项目并整理给妈妈的安排');view.submit();await view.settle();view.button('家人服务项目','owner-project-list').fire('click');await view.settle();
  const content=view.elements.get('workspace'),card=descendants(content).find(element=>element.dataset.cardId===draft.id);
  assert.match(card.parent.textContent,/已经整理好了/);assert.equal(card.parent.className,'chat-message assistant');assert.doesNotMatch(content.textContent,/无关旧草稿/);
  assert.equal(descendants(content).filter(element=>element.dataset.cardId===draft.id).length,1);
  assert.equal(view.requests.filter(item=>item?.action==='confirm_card').length,0);
  view.button('确认待执行安排').fire('click');await view.settle();assert.equal(view.requests.find(item=>item?.action==='confirm_card').revision,3);assert.equal(view.elements.get('owner-project-strip').hidden,false);
});
test('removing the current Owner clears native context from the visible interface',async()=>{
  const snapshot=initial(),{bridge}=native(),view=await harness({bridge,snapshot});view.input('读取项目中的私有说明');view.submit();await view.settle();view.button('家人服务项目','owner-project-list').fire('click');await view.settle();view.input('尚未发送的项目私有文字');
  snapshot.people=[];await view.poll();assert.equal(view.elements.get('owner-project-strip').hidden,true);assert.doesNotMatch(view.elements.get('workspace').textContent,/私有说明|已读取项目说明/);assert.equal(view.elements.get('owner-input').value,'');
});
