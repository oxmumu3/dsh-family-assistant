import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const client = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');

const people = [
  {id:'owner',role:'owner',label:'我',timeZone:'America/Mexico_City',shareWithOwner:'none'},
  {id:'mom',role:'elder',label:'测试家人甲',timeZone:'Asia/Shanghai',shareWithOwner:'none'},
  {id:'summary',role:'elder',label:'测试家人乙',timeZone:'Asia/Shanghai',shareWithOwner:'summary'},
  {id:'full',role:'elder',label:'测试家人丙',timeZone:'Asia/Shanghai',shareWithOwner:'full'},
];
const initial = () => ({people:structuredClone(people),config:{paused:true,timeZone:'Asia/Shanghai',provider:'',model:''},model:{available:false},reminders:[],outbox:[],ownerCommands:[],workbench:{messages:[],cards:[],requests:[]}});

async function workbenchHarness({snapshot=initial(),storage=new Map(),post,voice}={}) {
  const all=[],elements=new Map(),deferred=[],requests=[],documentListeners={};
  let document, sequence=0;
  class Element {
    constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.attributes={};this.listeners={};this.value='';this.checked=false;this.hidden=false;this.disabled=false;this._text='';this.options=[{},{}];this.scrollTop=0;this.scrollHeight=100;this.clientHeight=100;all.push(this);}
    set textContent(value){this._text=String(value??'');this.children=[];}
    get textContent(){return this._text+this.children.map(child=>child.textContent??'').join('');}
    get firstChild(){return this.children[0];}get lastChild(){return this.children.at(-1);}
    append(...children){this.children.push(...children);for(const child of children)child.parent=this;}
    replaceChildren(...children){this._text='';this.children=[];this.append(...children);}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
    setAttribute(name,value){this.attributes[name]=String(value);}getAttribute(name){return this.attributes[name]??null;}removeAttribute(name){delete this.attributes[name];}
    addEventListener(name,listener){(this.listeners[name]??=[]).push(listener);}
    fire(name,extra={}){for(const listener of this.listeners[name]??[])listener({preventDefault(){},target:this,...extra});}
    reset(){this.dataset.dirty='';this.value='';}focus(){document.activeElement=this;}scrollIntoView(){}
    contains(target){return target===this||this.children.some(child=>child.contains?.(target));}
    querySelectorAll(selector){return descendants(this).filter(element=>selector.includes('button')&&element.tagName==='button'||selector.includes('input')&&['input','textarea','select'].includes(element.tagName));}
  }
  for(const match of html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)){
    const element=new Element(match[1]); element.id=match[2]; element.hidden=/\bhidden(?:\s|>|=)/.test(match[0]);
    element.value=match[0].match(/\bvalue="([^"]*)"/)?.[1]||'';
    element.disabled=/\bdisabled(?:\s|>|=)/.test(match[0]);elements.set(match[2],element);
  }
  document={hidden:false,body:new Element('body'),activeElement:null,getElementById:id=>{assert.ok(elements.has(id),'Missing DOM node '+id);return elements.get(id);},createElement:tag=>new Element(tag),querySelectorAll:selector=>selector==='button'?all.filter(element=>element.tagName==='button'):[],addEventListener(name,fn){(documentListeners[name]??=[]).push(fn);}};
  const sessions={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)};
  runInNewContext(app,{document,window:{addEventListener(){},sessionStorage:sessions,parent:{__FamilyVoice:voice}},sessionStorage:sessions,crypto:{randomUUID:()=>`browser-key-${++sequence}`},AbortController,URL,fetch:async(url,options={})=>{
    const record={url,method:options.method??'GET',body:options.body?JSON.parse(options.body):undefined}; requests.push(record);
    if(record.body&&post){const response=await post(record.body,snapshot);if(response)return response;}
    const value=structuredClone(snapshot),personId=new URL(url,'http://family.test').searchParams.get('personId');
    if(personId)value.messages=[{id:'message-'+personId,personId,dir:'in',text:'聊天-'+personId,at:'2026-10-22T12:00:00Z'}];
    return{ok:true,json:async()=>value};
  },setTimeout:(fn,ms)=>{if(ms===0)deferred.push(fn);return 1;},clearTimeout(){},setInterval:()=>1,clearInterval(){}});
  async function settle(){for(let turn=0;turn<8;turn++){await new Promise(resolve=>setImmediate(resolve));for(const task of deferred.splice(0))task();}}
  await settle();
  return{elements,requests,settle,storage,snapshot,click:id=>elements.get(id).fire('click'),submit:id=>elements.get(id).fire('submit'),input:(id,value)=>{elements.get(id).value=value;elements.get(id).fire('input');},select:index=>elements.get('people-list').children[index].fire('click'),key:(key)=>{for(const fn of documentListeners.keydown??[])fn({key,preventDefault(){}});}};
}
function descendants(element){return element.children.flatMap(child=>[child,...descendants(child)]);}
function button(container,label){return descendants(container).find(element=>element.tagName==='button'&&element.textContent===label);}

test('local workbench has no HTML sink, remote assets, fake recorder or prototype Host sidebar',()=>{
  assert.doesNotMatch(html+app,/https?:\/\//);
  assert.doesNotMatch(app,/\.innerHTML\s*=|insertAdjacentHTML|\beval\s*\(|MediaRecorder|getUserMedia/);
  assert.match(app,/element\.textContent\s*=/);
  assert.doesNotMatch(html,/宿主导航示意|交互原型|口述效果演示/);
  assert.match(html,/<html lang="zh-CN">/);
});
test('controls have unique IDs and accessible labels',()=>{
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);assert.equal(ids.length,new Set(ids).size);
  const labels=new Set([...html.matchAll(/<label\b[^>]*for="([^"]+)"/g)].map(match=>match[1]));
  for(const match of html.matchAll(/<(input|textarea|select)\b[^>]*id="([^"]+)"[^>]*>/g)){if(/type="checkbox"/.test(match[0]))continue;assert.ok(labels.has(match[2]),'Missing visible label: '+match[2]);}
  assert.match(html,/id="error"[^>]*role="alert"/);assert.match(html,/id="notice"[^>]*role="status"/);
});
test('native authenticated carrier, same-origin mutations, consent and local QR remain intact',()=>{
  assert.match(app,/credentials: 'same-origin'/);assert.match(app,/'X-Family-Action': '1'/);assert.match(app,/'Content-Type': 'application\/json'/);assert.match(app,/document\.hidden/);assert.match(app,/}, 5000\)/);
  assert.match(app,/shareWithOwner === 'full'/);assert.match(app,/share-consent'\)\.checked/);
  assert.match(client,/globalThis\.fetch\('\/api\/family\/workbench'/);assert.match(client,/srcDoc: html/);assert.match(client,/window\.__FamilyHostFetch = hostFetch/);assert.match(client,/id: 'family-assistant'.*label: '家庭助手'/);
  assert.match(app,/fetch\('\/family\/qr\.svg\?personId='/);assert.match(app,/URL\.revokeObjectURL/);
});
test('first use is an honest empty state with explicit Owner setup',async()=>{
  const snapshot=initial();snapshot.people=[];const view=await workbenchHarness({snapshot});
  assert.equal(view.elements.get('owner-setup').hidden,false);assert.match(view.elements.get('workspace').textContent,/还没有/);
  assert.equal(view.elements.get('send-owner').disabled,true);assert.equal(view.elements.get('settings-open').disabled,false);
  assert.doesNotMatch(view.elements.get('workspace').textContent,/测试家人|已连接|已发送/);
});
test('Owner own history loads initially and after mutations without expanding elder sharing',async()=>{
  const view=await workbenchHarness();assert.match(view.elements.get('history-list').textContent,/聊天-owner/);
  view.click('preview-brief');await view.settle();assert.match(view.elements.get('history-list').textContent,/聊天-owner/);
  for(const index of [1,2]){view.select(index);await view.settle();assert.doesNotMatch(view.elements.get('history-list').textContent,/聊天-/);}
  view.select(3);await view.settle();assert.match(view.elements.get('history-list').textContent,/聊天-full/);
  view.snapshot.people[3].shareWithOwner='none';view.click('refresh');await view.settle();assert.doesNotMatch(view.elements.get('history-list').textContent,/聊天-full/);
});
test('revoked brief is erased and discovered model is not called selected',async()=>{
  const snapshot=initial();snapshot.model.available=true;snapshot.lastBrief={text:'private family preview'};const view=await workbenchHarness({snapshot});
  assert.match(view.elements.get('model-status').textContent,/请选择服务与模型/);assert.equal(view.elements.get('brief-preview').textContent,'private family preview');
  snapshot.lastBrief=null;view.click('refresh');await view.settle();assert.equal(view.elements.get('brief-preview').textContent,'先预览，再决定是否发送。');
});
test('ambiguous owner chat failure retains input and reuses its request key across retry and reload',async()=>{
  const storage=new Map();const snapshot=initial();snapshot.model.available=true;snapshot.config.provider='p';snapshot.config.model='m';
  const first=await workbenchHarness({snapshot,storage,post:async body=>{if(body.action==='owner_chat')throw new TypeError('offline');}});
  first.input('owner-input','给家人整理一份资料');first.submit('composer-form');await first.settle();
  const sent=first.requests.find(request=>request.body?.action==='owner_chat').body;
  assert.ok(sent.requestId);assert.equal(first.elements.get('owner-input').value,'给家人整理一份资料');assert.match(first.elements.get('error').textContent,/不确定|中断/);
  const second=await workbenchHarness({snapshot,storage});assert.equal(second.elements.get('owner-input').value,'给家人整理一份资料');second.submit('composer-form');await second.settle();
  const retried=second.requests.find(request=>request.body?.action==='owner_chat').body;assert.equal(retried.requestId,sent.requestId);assert.equal(second.elements.get('owner-input').value,'');
});
test('drafts follow explicit card context across navigation and refresh',async()=>{
  const snapshot=initial();snapshot.workbench.cards=[{id:'p1',kind:'profile',status:'draft',title:'合成资料',revision:7,profile:{label:'合成家人',timeZone:'Asia/Shanghai',interests:['园艺'],notes:''}}];
  const view=await workbenchHarness({snapshot});view.input('owner-input','全局尚未发送');
  button(view.elements.get('workspace'),'继续修改').fire('click');view.input('owner-input','这份资料的修改');
  view.click('nav-family');assert.equal(view.elements.get('owner-input').value,'这份资料的修改');view.click('context-clear');assert.equal(view.elements.get('owner-input').value,'全局尚未发送');
  view.click('nav-chat');button(view.elements.get('workspace'),'继续修改').fire('click');assert.equal(view.elements.get('owner-input').value,'这份资料的修改');
  const restored=await workbenchHarness({snapshot,storage:view.storage});assert.equal(restored.elements.get('owner-input').value,'这份资料的修改');
  restored.submit('composer-form');await restored.settle();assert.equal(restored.requests.find(request=>request.body?.action==='owner_chat').body.contextId,'card:p1');
});
test('card confirmation sends revision and partial recovery never retries an unknown result',async()=>{
  const snapshot=initial();snapshot.workbench.cards=[{id:'plan',kind:'plan',title:'独立安排',status:'draft',revision:4,actions:[
    {id:'a',type:'send_message',personId:'mom',targetLabel:'合成甲',text:'<img src=x onerror=alert(1)>',status:'draft'},
    {id:'b',type:'send_message',personId:'summary',targetLabel:'合成乙',status:'failed'},
    {id:'c',type:'send_message',personId:'full',targetLabel:'合成丙',status:'uncertain'},
  ]}];const view=await workbenchHarness({snapshot});
  const space=view.elements.get('workspace');assert.match(space.textContent,/<img src=x onerror=alert\(1\)>/);
  const actions=descendants(space).filter(element=>element.dataset.actionId);
  assert.ok(actions.some(element=>element.dataset.actionId==='b'&&element.textContent==='仅重试这一项'));
  assert.ok(!actions.some(element=>element.dataset.actionId==='c'&&element.textContent.includes('重试')));
  actions.find(element=>element.dataset.actionId==='a'&&element.textContent==='取消这一项').fire('click');await view.settle();
  assert.deepEqual(view.requests.find(request=>request.body?.action==='cancel_card').body,{action:'cancel_card',cardId:'plan',actionId:'a'});
  button(view.elements.get('workspace'),'确认待执行安排').fire('click');await view.settle();assert.equal(view.requests.find(request=>request.body?.action==='confirm_card').body.revision,4);
});
test('linked request response keeps operation identity and displays only the selected matter',async()=>{
  const snapshot=initial();snapshot.workbench.requests=[{id:'r1',personId:'mom',text:'请转达一个选定事项',status:'open',responses:[{by:'elder',text:'事项补充',at:'2026-10-23T10:00:00Z'}]}];
  const view=await workbenchHarness({snapshot});view.click('nav-inbox');button(view.elements.get('workspace'),'查看并回应').fire('click');
  assert.match(view.elements.get('request-thread').textContent,/请转达一个选定事项.*事项补充/s);assert.doesNotMatch(view.elements.get('request-thread').textContent,/聊天-mom/);
  view.input('request-reply-text','我明天确认');view.submit('request-reply-form');await view.settle();const reply=view.requests.find(request=>request.body?.action==='reply_request').body;
  assert.equal(reply.requestId,'r1');assert.equal(reply.text,'我明天确认');assert.ok(reply.operationId);assert.match(view.elements.get('notice').textContent,/接口|请求/);
});
test('standalone page explains real microphone availability and Escape closes the secondary panel',async()=>{
  const view=await workbenchHarness();view.click('voice-start');assert.match(view.elements.get('voice-status').textContent,/Harness/);
  view.click('settings-open');assert.equal(view.elements.get('drawer-overlay').hidden,false);view.key('Escape');assert.equal(view.elements.get('drawer-overlay').hidden,true);
});

test('secondary panels surface API errors and keep manual setup available without a model',async()=>{
  const view=await workbenchHarness({post:async body=>body.action==='configure'?{ok:false,json:async()=>({error:'模型选择无效'})}:undefined});
  view.click('settings-open');view.input('service-zone','Asia/Shanghai');view.submit('service-settings');await view.settle();
  assert.ok(view.elements.has('drawer-error'),'The modal needs its own visible API feedback');
  assert.equal(view.elements.get('drawer-error').hidden,false);assert.match(view.elements.get('drawer-error').textContent,/模型选择无效/);
  view.click('manual-add-open');assert.equal(view.elements.get('add-panel').hidden,false);assert.equal(view.elements.get('add-role').value,'elder');
});

test('typing a next instruction while the model is busy does not lose it on completion',async()=>{
  let finish;
  const view=await workbenchHarness({post:body=>body.action==='owner_chat'?new Promise(resolve=>{finish=()=>resolve({ok:true,json:async()=>initial()});}):undefined});
  view.input('owner-input','第一个要求');view.submit('composer-form');await view.settle();
  assert.match(view.elements.get('composer-progress').textContent,/正在整理/);view.input('owner-input','尚未发送的下一句话');finish();await view.settle();
  assert.equal(view.elements.get('owner-input').value,'尚未发送的下一句话');
});

test('request reply keeps its operation ID after ambiguous network failure and reload',async()=>{
  const snapshot=initial();snapshot.workbench.requests=[{id:'r-safe',personId:'mom',text:'一个已同意转达的事项',status:'open'}];const storage=new Map();
  const first=await workbenchHarness({snapshot,storage,post:async body=>{if(body.action==='reply_request')throw new TypeError('offline');}});
  first.click('nav-inbox');button(first.elements.get('workspace'),'查看并回应').fire('click');first.input('request-reply-text','我已了解');first.submit('request-reply-form');await first.settle();
  const original=first.requests.find(request=>request.body?.action==='reply_request').body;
  const second=await workbenchHarness({snapshot,storage});second.click('nav-inbox');button(second.elements.get('workspace'),'查看并回应').fire('click');assert.equal(second.elements.get('request-reply-text').value,'我已了解');second.submit('request-reply-form');await second.settle();
  assert.equal(second.requests.find(request=>request.body?.action==='reply_request').body.operationId,original.operationId);
});

test('Owner command records expose service targets and interface status without private bodies or route IDs',async()=>{
  const snapshot=initial();snapshot.ownerCommands=[{id:'secret-command-id',requestedBy:'owner',targetPersonId:'mom',action:'send_daily',status:'api_accepted',deliveryStatus:'api_accepted',resultId:'secret-outbox-id',createdAt:'2026-10-22T12:00:00Z',detail:'不可展示的聊天内容',text:'不可展示的正文',requestRoute:{peerId:'不可展示的路由'}}];
  const view=await workbenchHarness({snapshot});const content=view.elements.get('owner-command-list').textContent;
  assert.match(content,/测试家人甲/);assert.match(content,/日报/);assert.match(content,/接口已接收/);assert.doesNotMatch(content,/不可展示|secret-|已送达|已读/);
  view.select(1);await view.settle();assert.equal(view.elements.get('owner-command-section').hidden,true);assert.equal(view.elements.get('owner-command-list').textContent,'');
});

test('submitting from another tab brings the linked model conversation into view',async()=>{
  const view=await workbenchHarness();view.click('nav-family');view.input('owner-input','继续说说这位家人');view.submit('composer-form');await view.settle();
  assert.equal(view.elements.get('nav-chat').getAttribute('aria-current'),'page');
});

test('switching to a browsing tab starts at its heading instead of inheriting chat scroll',async()=>{
  const view=await workbenchHarness();view.elements.get('workspace').scrollTop=900;view.click('nav-activity');assert.equal(view.elements.get('workspace').scrollTop,0);
});

test('opening a member detail starts at connection controls after scrolling settings',async()=>{
  const view=await workbenchHarness();assert.ok(view.elements.has('drawer-content'),'Drawer scrolling needs a stable container');view.click('settings-open');view.elements.get('drawer-content').scrollTop=1000;view.key('Escape');view.select(1);assert.equal(view.elements.get('drawer-content').scrollTop,0);
});

function fakeVoice(){
 let value={phase:'idle',readiness:{ready:true,phase:'ready'},transcript:'',capture:null};const listeners=new Set();
 const calls=[];let capture;
 const emit=patch=>{value={...value,...patch};for(const fn of listeners)fn({...value});};
 return {calls,emit,status:()=>value,subscribe(fn){listeners.add(fn);fn(value);return()=>listeners.delete(fn);},refresh:async()=>value,prepare:async()=>{calls.push('prepare');emit({phase:'setup',readiness:{ready:false,phase:'downloading',providers:[]}});},cancelPreparation:async()=>{calls.push('cancel_preparation');emit({phase:'setup',readiness:{ready:false,phase:'cancelled'}});},start:async c=>{capture=c;calls.push('start');emit({phase:'recording',capture,message:'正在听'});},stop:async()=>{calls.push('stop');emit({phase:'transcribing'});},cancel(){calls.push('cancel');emit({phase:'idle',transcript:'',capture:null});},contextChanged(key){if(capture&&capture.contextKey!==key)this.cancel();},finish(text){emit({phase:'transcript',transcript:text,capture});}};
}
test('voice capture stops into an editable draft and never sends automatically',async()=>{
 const voice=fakeVoice(),view=await workbenchHarness({voice});view.input('owner-input','先保留这句。');view.click('voice-start');await view.settle();
 assert.equal(voice.calls.at(-1),'start');assert.equal(view.elements.get('send-owner').disabled,true);
 view.click('voice-stop');await view.settle();voice.finish('再补一句。');await view.settle();
 assert.equal(view.elements.get('owner-input').value,'先保留这句。再补一句。');assert.equal(view.requests.filter(x=>x.method==='POST').length,0);assert.match(view.elements.get('composer-progress').textContent,/检查.*发送/);
 view.submit('composer-form');await view.settle();assert.equal(view.requests.filter(x=>x.body?.action==='owner_chat').length,1);
});
test('editing while transcribing retains transcript for explicit insertion or discard',async()=>{
 const voice=fakeVoice(),view=await workbenchHarness({voice});view.input('owner-input','原草稿');view.click('voice-start');await view.settle();view.click('voice-stop');await view.settle();view.input('owner-input','新草稿');voice.finish('识别文字');await view.settle();
 assert.equal(view.elements.get('owner-input').value,'新草稿');assert.equal(view.elements.get('voice-insert').hidden,false);assert.equal(view.requests.filter(x=>x.method==='POST').length,0);
 view.click('voice-insert');assert.equal(view.elements.get('owner-input').value,'新草稿识别文字');
});
test('changing tabs cancels microphone work and does not insert late words',async()=>{
 const voice=fakeVoice(),view=await workbenchHarness({voice});view.click('voice-start');await view.settle();view.click('nav-family');assert.ok(voice.calls.includes('cancel'));voice.finish('旧任务文字');await view.settle();assert.equal(view.elements.get('owner-input').value,'');
});
test('first voice preparation stays in composer and does not start recording afterwards',async()=>{
 const voice=fakeVoice(),view=await workbenchHarness({voice});voice.emit({phase:'setup',readiness:{ready:false,phase:'unprepared'}});view.click('voice-prepare');await view.settle();assert.ok(voice.calls.includes('prepare'));assert.equal(view.elements.get('voice-cancel-setup').hidden,false);
 voice.emit({phase:'idle',readiness:{ready:true,phase:'ready'}});assert.equal(voice.calls.includes('start'),false);assert.equal(view.requests.filter(x=>x.method==='POST').length,0);
});
test('long transcript never truncates an existing draft silently',async()=>{
 const voice=fakeVoice(),view=await workbenchHarness({voice});view.input('owner-input','原'.repeat(3998));view.click('voice-start');await view.settle();view.click('voice-stop');await view.settle();voice.finish('超出限制的文字');await view.settle();
 assert.equal(view.elements.get('owner-input').value.length,3998);assert.match(view.elements.get('voice-status').textContent,/4000|过长/);assert.equal(view.elements.get('voice-transcript').textContent,'超出限制的文字');
});
