import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const capabilityScript = readFileSync(new URL('../web/capabilities.js', import.meta.url), 'utf8');
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
    click(){this.fire('click');} fire(name,extra={}){for(const listener of this.listeners[name]??[])listener({preventDefault(){},target:this,...extra});}
    reset(){this.dataset.dirty='';this.value='';}focus(){document.activeElement=this;}setSelectionRange(start,end,direction='none'){this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction;}scrollIntoView(){}
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
  runInNewContext(capabilityScript+'\n'+app,{document,window:{addEventListener(){},sessionStorage:sessions,parent:{__FamilyVoice:voice}},sessionStorage:sessions,crypto:{randomUUID:()=>`browser-key-${++sequence}`},AbortController,URL,Blob,atob:value=>Buffer.from(value,'base64').toString('binary'),fetch:async(url,options={})=>{
    const record={url,method:options.method??'GET',body:options.body?JSON.parse(options.body):undefined}; requests.push(record);
    if(record.body&&post){const response=await post(record.body,snapshot);if(response)return response;}
    const value=structuredClone(snapshot),personId=new URL(url,'http://family.test').searchParams.get('personId');
    if(personId)value.messages=[{id:'message-'+personId,personId,dir:'in',text:'聊天-'+personId,at:'2026-10-22T12:00:00Z'}];
    return{ok:true,json:async()=>value};
  },setTimeout:(fn,ms)=>{if(ms===0)deferred.push(fn);return 1;},clearTimeout(){},setInterval:()=>1,clearInterval(){}});
  async function settle(){for(let turn=0;turn<8;turn++){await new Promise(resolve=>setImmediate(resolve));for(const task of deferred.splice(0))task();}}
  await settle();
  return{elements,requests,settle,storage,snapshot,activeElement:()=>document.activeElement,click:id=>elements.get(id).fire('click'),submit:id=>elements.get(id).fire('submit'),input:(id,value)=>{elements.get(id).value=value;elements.get(id).fire('input');},select:index=>elements.get('people-list').children[index].fire('click'),key:(key)=>{for(const fn of documentListeners.keydown??[])fn({key,preventDefault(){}});}};
}
function descendants(element){return element.children.flatMap(child=>[child,...descendants(child)]);}
function button(container,label){return descendants(container).find(element=>element.tagName==='button'&&element.textContent===label);}

function fakeVoice(){
 let value={phase:'idle',readiness:{ready:true,phase:'ready'},transcript:'',capture:null};const listeners=new Set();
 const calls=[];let capture;
 const emit=patch=>{value={...value,...patch};for(const fn of listeners)fn({...value});};
 return {calls,emit,status:()=>value,subscribe(fn){listeners.add(fn);fn(value);return()=>listeners.delete(fn);},refresh:async()=>value,prepare:async()=>{calls.push('prepare');emit({phase:'setup',readiness:{ready:false,phase:'downloading',providers:[]}});},cancelPreparation:async()=>{calls.push('cancel_preparation');emit({phase:'setup',readiness:{ready:false,phase:'cancelled'}});},start:async c=>{capture=c;calls.push('start');emit({phase:'recording',capture,message:'正在听'});},stop:async()=>{calls.push('stop');emit({phase:'transcribing'});},cancel(){calls.push('cancel');emit({phase:'idle',transcript:'',capture:null});},contextChanged(key){if(capture&&capture.contextKey!==key)this.cancel();},finish(text){emit({phase:'transcript',transcript:text,capture});}};
}
const response=value=>({ok:true,json:async()=>value});
const byName=(root,name)=>descendants(root).find(element=>element.name===name);
const press=(view,id,extra={})=>view.elements.get(id).fire('keydown',{key:'Enter',shiftKey:false,isComposing:false,keyCode:13,...extra});
const connectedFamily=()=>{const snapshot=initial();snapshot.config.paused=false;for(const p of snapshot.people)p.binding={status:'connected',connected:true,generation:1};return snapshot;};
const historyComposer=view=>byName(view.elements.get('workspace'),'owner-history-message');
const historyPost=body=>body.action==='history_page'?response({access:'full',messages:[{id:'saved-'+body.personId,dir:'in',text:'原始对话-'+body.personId,at:'2026-10-25T09:00:00Z'}],total:1,hasMore:false}):undefined;
const openMember=async(view,id)=>{view.click('nav-family');descendants(view.elements.get('workspace')).find(n=>n.dataset.personId===id).fire('click');await view.settle();};

test('family history sends once with the captured recipient and preserves a new draft after a late receipt',async()=>{
 const snapshot=connectedFamily();let finish;
 const view=await workbenchHarness({snapshot,post:body=>body.action==='owner_send_message'?new Promise(resolve=>{finish=()=>resolve(response({outboxId:'sent-one',personId:body.personId,status:'api_accepted',detail:''}));}):historyPost(body)});
 await openMember(view,'mom');let field=historyComposer(view);assert.ok(field,'the complete archive has a direct composer');field.value='第一条消息';field.fire('input');
 for(const extra of[{shiftKey:true},{isComposing:true},{keyCode:229}])field.fire('keydown',{key:'Enter',...extra});
 await view.settle();assert.equal(view.requests.filter(r=>r.body?.action==='owner_send_message').length,0);
 field.fire('keydown',{key:'Enter'});field.fire('keydown',{key:'Enter'});await view.settle();const sends=view.requests.filter(r=>r.body?.action==='owner_send_message');assert.equal(sends.length,1);assert.equal(sends[0].body.personId,'mom');assert.equal(sends[0].body.bindingGeneration,1);assert.ok(sends[0].body.requestId);assert.equal(sends[0].body.text,'第一条消息');
 field=historyComposer(view);field.value='另写的新草稿';field.fire('input');await openMember(view,'summary');historyComposer(view).value='乙的草稿';historyComposer(view).fire('input');finish();await view.settle();assert.equal(historyComposer(view).value,'乙的草稿');
 await openMember(view,'mom');assert.equal(historyComposer(view).value,'另写的新草稿');assert.match(view.elements.get('workspace').textContent,/接口已接收|接口已接受/);assert.doesNotMatch(view.elements.get('workspace').textContent,/手机已收到|对方已收到/);
});

test('family drafts survive member navigation and reload, but removing Owner clears their session cache',async()=>{
 const snapshot=connectedFamily(),storage=new Map();let view=await workbenchHarness({snapshot,storage,post:historyPost});await openMember(view,'mom');historyComposer(view).value='甲的未发送文字';historyComposer(view).fire('input');await openMember(view,'summary');historyComposer(view).value='乙的未发送文字';historyComposer(view).fire('input');
 view=await workbenchHarness({snapshot,storage,post:historyPost});await openMember(view,'mom');assert.equal(historyComposer(view).value,'甲的未发送文字');await openMember(view,'summary');assert.equal(historyComposer(view).value,'乙的未发送文字');
 snapshot.people=snapshot.people.filter(p=>p.role!=='owner');view.click('refresh');await view.settle();assert.equal([...storage.values()].some(value=>value.includes('甲的未发送文字')||value.includes('乙的未发送文字')),false);
});

test('unknown family sends persist their original request and only read status until accepted',async()=>{
 const snapshot=connectedFamily(),storage=new Map();const post=body=>body.action==='owner_send_message'?Promise.reject(new TypeError('offline')):historyPost(body);
 let view=await workbenchHarness({snapshot,storage,post});await openMember(view,'mom');historyComposer(view).value='结果待核对的消息';historyComposer(view).fire('input');historyComposer(view).fire('keydown',{key:'Enter'});await view.settle();const sent=view.requests.find(r=>r.body?.action==='owner_send_message').body;assert.equal(historyComposer(view).value,sent.text);assert.match(view.elements.get('workspace').textContent,/待核对|结果.*不确定/);
 button(view.elements.get('workspace'),'核对发送状态').fire('click');await view.settle();assert.equal(view.requests.filter(r=>r.body?.action==='owner_send_message').length,1);
 view=await workbenchHarness({snapshot,storage,post});await openMember(view,'mom');assert.equal(historyComposer(view).value,sent.text);assert.ok([...storage.values()].some(value=>value.includes(sent.requestId)));
 snapshot.outbox.push({id:'accepted-later',personId:'mom',kind:'owner_message',sourceKey:'owner-message:owner:'+sent.requestId,status:'api_accepted'});view.click('refresh');await view.settle();assert.equal(historyComposer(view).value,'');assert.equal(view.requests.some(r=>r.body?.action==='owner_send_message'),false);
});

test('a different new family message can send while an older unknown request remains tracked',async()=>{
 const snapshot=connectedFamily(),storage=new Map();let attempts=0;const view=await workbenchHarness({snapshot,storage,post:body=>body.action==='owner_send_message'?(++attempts===1?Promise.reject(new TypeError('offline')):response({personId:body.personId,outboxId:'new-message',status:'api_accepted'})):historyPost(body)});
 await openMember(view,'mom');historyComposer(view).value='第一条结果未知';historyComposer(view).fire('input');historyComposer(view).fire('keydown',{key:'Enter'});await view.settle();const original=view.requests.find(r=>r.body?.action==='owner_send_message').body;
 historyComposer(view).value='这是一条完全不同的新消息';historyComposer(view).fire('input');assert.ok(button(view.elements.get('workspace'),'发送新消息给测试家人甲'));historyComposer(view).fire('keydown',{key:'Enter'});await view.settle();const sent=view.requests.filter(r=>r.body?.action==='owner_send_message').map(r=>r.body);assert.equal(sent.length,2);assert.notEqual(sent[1].requestId,original.requestId);assert.equal(sent[1].text,'这是一条完全不同的新消息');assert.equal(historyComposer(view).value,'');assert.ok([...storage.values()].some(value=>value.includes(original.requestId)));assert.match(descendants(view.elements.get('workspace')).find(n=>n.className==='lele-history-send-status').textContent,/较早|上一条/);
 historyComposer(view).value='下一条未提交草稿';historyComposer(view).fire('input');snapshot.outbox.push({id:'old-arrived',personId:'mom',kind:'owner_message',sourceKey:'owner-message:owner:'+original.requestId,status:'api_accepted'});view.click('refresh');await view.settle();assert.equal(historyComposer(view).value,'下一条未提交草稿');assert.equal(view.requests.filter(r=>r.body?.action==='owner_send_message').length,2);
});

test('a changed family binding clears its sending draft and rejects the late former-route receipt',async()=>{
 const snapshot=connectedFamily();let finish;const view=await workbenchHarness({snapshot,post:body=>body.action==='owner_send_message'?new Promise(resolve=>{finish=()=>resolve(response({outboxId:'old-route',personId:'mom',status:'api_accepted'}));}):historyPost(body)});
 await openMember(view,'mom');historyComposer(view).value='旧绑定草稿';historyComposer(view).fire('input');historyComposer(view).fire('keydown',{key:'Enter'});await view.settle();snapshot.people.find(p=>p.id==='mom').binding.generation=2;view.click('refresh');await view.settle();assert.equal(historyComposer(view).value,'');assert.match(view.elements.get('workspace').textContent,/绑定.*更新|绑定.*改变/);
 historyComposer(view).value='新绑定草稿';historyComposer(view).fire('input');finish();await view.settle();assert.equal(historyComposer(view).value,'新绑定草稿');assert.doesNotMatch(descendants(view.elements.get('workspace')).find(n=>n.className==='lele-history-send-status').textContent,/接口已接收|接口已接受/);
});

test('accepted family messages clear only their matching draft and return to the latest unfiltered archive',async()=>{
 const snapshot=connectedFamily();let accepted=false;const view=await workbenchHarness({snapshot,post:body=>{if(body.action==='owner_send_message'){accepted=true;return response({personId:body.personId,outboxId:'sent-new',status:'api_accepted'});}if(body.action==='history_page')return response({access:'full',messages:[{id:'latest',dir:'out',kind:accepted?'owner_message':'chat',text:accepted?'当前发出的正文':'之前的消息',at:'2026-10-25T09:00:00Z'}],total:1,hasMore:false});}});
 await openMember(view,'mom');byName(view.elements.get('workspace'),'history-query').value='旧关键词';button(view.elements.get('workspace'),'查找').fire('click');await view.settle();historyComposer(view).value='当前发出的正文';historyComposer(view).fire('input');historyComposer(view).fire('keydown',{key:'Enter'});await view.settle();assert.equal(historyComposer(view).value,'');const reads=view.requests.filter(r=>r.body?.action==='history_page');assert.equal(reads.at(-1).body.query,undefined);assert.equal(byName(view.elements.get('workspace'),'history-query').value,'');assert.match(view.elements.get('workspace').textContent,/你 · 通过乐乐/);assert.match(view.elements.get('workspace').textContent,/当前发出的正文/);
});

test('IME composition remains a send guard across a family state redraw',async()=>{
 const snapshot=connectedFamily(),view=await workbenchHarness({snapshot,post:historyPost});await openMember(view,'mom');let field=historyComposer(view);field.value='候选输入';field.fire('input');field.fire('compositionstart');snapshot.outbox.push({id:'redraw',personId:'summary',status:'failed'});view.click('refresh');await view.settle();field=historyComposer(view);field.fire('keydown',{key:'Enter'});await view.settle();assert.equal(view.requests.some(r=>r.body?.action==='owner_send_message'),false);field.fire('compositionend');
});

test('the second half of a double click cannot retry a definitive family send failure',async()=>{
 const snapshot=connectedFamily(),view=await workbenchHarness({snapshot,post:body=>body.action==='owner_send_message'?response({personId:body.personId,outboxId:'failed-once',status:'failed'}):historyPost(body)});await openMember(view,'mom');historyComposer(view).value='失败后保留的正文';historyComposer(view).fire('input');button(view.elements.get('workspace'),'发送给测试家人甲').fire('click',{detail:1});await view.settle();button(view.elements.get('workspace'),'重新发送').fire('click',{detail:2});await view.settle();assert.equal(view.requests.filter(r=>r.body?.action==='owner_send_message').length,1);assert.equal(historyComposer(view).value,'失败后保留的正文');assert.match(descendants(view.elements.get('workspace')).find(n=>n.className==='lele-history-send-status').textContent,/未完成发送/);
});

test('family polling preserves the composer caret and reloads history only when its message anchors change',async()=>{
 const snapshot=connectedFamily();let latest='原始对话';const view=await workbenchHarness({snapshot,post:body=>body.action==='history_page'?response({access:'full',messages:[{id:'message',dir:'in',text:latest,at:'2026-10-25T09:00:00Z'},{id:'owner-msg',dir:'out',kind:'owner_message',text:'家庭联系人通过乐乐转达：你好',at:'2026-10-25T09:01:00Z'}],total:2,hasMore:false}):undefined});
 await openMember(view,'mom');let field=historyComposer(view);field.value='输入中的消息';field.fire('input');field.focus();field.setSelectionRange(2,4,'backward');const count=view.requests.filter(r=>r.body?.action==='history_page').length;
 snapshot.outbox.push({id:'unrelated',personId:'summary',status:'failed'});view.click('refresh');await view.settle();field=historyComposer(view);assert.equal(view.activeElement(),field);assert.equal(field.selectionStart,2);assert.equal(field.selectionEnd,4);assert.equal(field.selectionDirection,'backward');assert.equal(view.requests.filter(r=>r.body?.action==='history_page').length,count);assert.match(view.elements.get('workspace').textContent,/你 · 通过乐乐/);
 latest='家人后续的回复';snapshot.people.find(p=>p.id==='mom').binding.lastInboundAt='2026-10-25T10:00:00Z';view.click('refresh');await view.settle();assert.match(view.elements.get('workspace').textContent,/家人后续的回复/);assert.equal(view.requests.filter(r=>r.body?.action==='history_page').length,count+1);view.click('refresh');await view.settle();assert.equal(view.requests.filter(r=>r.body?.action==='history_page').length,count+1);
});

test('family record redraw keeps a reading position and follows a new reply only from the bottom',async()=>{
 const snapshot=connectedFamily(),view=await workbenchHarness({snapshot,post:historyPost});await openMember(view,'mom');let scroll=descendants(view.elements.get('workspace')).find(n=>n.className==='lele-history-scroll');scroll.scrollHeight=1000;scroll.clientHeight=200;scroll.scrollTop=350;snapshot.outbox.push({id:'unrelated-scroll',personId:'summary',status:'failed'});view.click('refresh');await view.settle();scroll=descendants(view.elements.get('workspace')).find(n=>n.className==='lele-history-scroll');assert.equal(scroll.scrollTop,350,'polling does not jump away from the record being read');scroll.scrollHeight=1000;scroll.clientHeight=200;scroll.scrollTop=800;snapshot.people[1].binding.lastInboundAt='2026-10-26T00:00:00Z';view.click('refresh');await view.settle();scroll=descendants(view.elements.get('workspace')).find(n=>n.className==='lele-history-scroll');assert.equal(scroll.scrollTop,scroll.scrollHeight,'a reader already at the bottom follows the new reply');
});

test('family composer blocks paused, disconnected and missing-generation sends with a connection entry',async()=>{
 for(const kind of ['paused','disconnected','generation']){const snapshot=connectedFamily();if(kind==='paused')snapshot.config.paused=true;else if(kind==='disconnected')snapshot.people[1].binding={status:'disconnected',connected:false,generation:1};else delete snapshot.people[1].binding.generation;const view=await workbenchHarness({snapshot,post:historyPost});await openMember(view,'mom');const field=historyComposer(view);assert.ok(field);field.value='不能发';field.fire('input');field.fire('keydown',{key:'Enter'});await view.settle();assert.equal(view.requests.some(r=>r.body?.action==='owner_send_message'),false);assert.ok(button(view.elements.get('workspace'),'恢复连接')||button(view.elements.get('workspace'),'资料与连接'));assert.match(view.elements.get('workspace').textContent,/暂停|未连接|绑定|连接/);}
});
test('service source choices stay in the conversation and preserve an unsent main draft',async()=>{
 const snapshot=initial();snapshot.serviceSetup=[{id:'setup-one',origin:'console',revision:2,status:'needs_input',toolId:'ai_digest',personLabel:'测试家人甲',missing:['source'],choices:[{id:'s:one',kind:'source',label:'daily.md'}],summary:'每天08:00发送AI日报'}];
 const view=await workbenchHarness({snapshot,post:body=>{if(body.action==='service_select'){snapshot.serviceSetup[0]={...snapshot.serviceSetup[0],revision:3,status:'ready',choices:[]};return response(snapshot);}}});
 view.input('owner-input','尚未发送的补充说明');
 const choice=button(view.elements.get('workspace'),'daily.md');assert.ok(choice,'actual source is a direct chat action');choice.click();await view.settle();
 const sent=view.requests.find(row=>row.body?.action==='service_select').body;
 assert.equal(sent.draftId,'setup-one');assert.equal(sent.revision,2);assert.equal(sent.choiceId,'s:one');
 assert.equal(view.elements.get('owner-input').value,'尚未发送的补充说明');
 assert.ok(button(view.elements.get('workspace'),'确认开通'));
 assert.equal(view.requests.some(row=>row.body?.action==='service_confirm'),false);
});
test('confirming one ready service plan submits exact revision once and does not automatically retry',async()=>{
 const snapshot=initial();snapshot.serviceSetup=[{id:'setup-two',origin:'console',revision:4,status:'ready',toolId:'weather',operation:'configure',personLabel:'测试家人甲',choices:[],summary:'杭州天气，每天07:30'}];
 let finish;const view=await workbenchHarness({snapshot,post:body=>body.action==='service_confirm'?new Promise(resolve=>{finish=()=>{snapshot.serviceSetup=[{...snapshot.serviceSetup[0],status:'applied'}];resolve(response(snapshot));};}):undefined});
 const confirm=button(view.elements.get('workspace'),'确认开通');assert.ok(confirm);confirm.click();await view.settle();confirm.click();await view.settle();
 const requests=view.requests.filter(row=>row.body?.action==='service_confirm');assert.equal(requests.length,1);assert.equal(requests[0].body.revision,4);
 finish();await view.settle();assert.equal(button(view.elements.get('workspace'),'确认开通'),undefined);
});
test('Lele main composer Enter sends once, while Shift and IME selection preserve text',async()=>{
 const view=await workbenchHarness();view.input('owner-input','请记下这件事');
 for(const extra of[{shiftKey:true},{isComposing:true},{keyCode:229}]){press(view,'owner-input',extra);await view.settle();}
 assert.equal(view.requests.filter(r=>r.body?.action==='owner_chat').length,0);assert.equal(view.elements.get('owner-input').value,'请记下这件事');
 press(view,'owner-input');await view.settle();assert.equal(view.requests.filter(r=>r.body?.action==='owner_chat').length,1);assert.equal(view.elements.get('owner-input').value,'');
 press(view,'owner-input');await view.settle();assert.equal(view.requests.filter(r=>r.body?.action==='owner_chat').length,1);
});
test('Enter while a request is busy cannot submit a second instruction',async()=>{
 let finish;const view=await workbenchHarness({post:body=>body.action==='owner_chat'?new Promise(resolve=>{finish=()=>resolve(response(initial()));}):undefined});
 view.input('owner-input','第一次');press(view,'owner-input');await view.settle();view.input('owner-input','下一次');press(view,'owner-input');await view.settle();assert.equal(view.requests.filter(r=>r.body?.action==='owner_chat').length,1);finish();await view.settle();assert.equal(view.elements.get('owner-input').value,'下一次');
});
test('independent family introduction accepts Enter, keeps Shift and IME as input, and does not use main draft',async()=>{
 const view=await workbenchHarness();view.input('owner-input','主对话草稿');view.click('add-family');view.input('family-intake-input','阿宁，喜欢摄影');
 for(const extra of[{shiftKey:true},{isComposing:true},{keyCode:229}])press(view,'family-intake-input',extra);await view.settle();assert.equal(view.requests.filter(r=>r.body?.action==='owner_chat').length,0);
 press(view,'family-intake-input');await view.settle();const sent=view.requests.find(r=>r.body?.action==='owner_chat').body;assert.equal(sent.profileIntake,true);assert.equal(sent.text,'阿宁，喜欢摄影');assert.equal(view.elements.get('owner-input').value,'主对话草稿');
});
test('intake voice uses official bridge with editable transcript, explicit insertion and draft preservation',async()=>{
 const voice=fakeVoice(),view=await workbenchHarness({voice});view.input('owner-input','主草稿');view.click('add-family');view.input('family-intake-input','已有介绍。');view.click('family-intake-voice-start');await view.settle();view.click('family-intake-voice-stop');voice.finish('原始转写');await view.settle();
 assert.equal(view.elements.get('family-intake-input').value,'已有介绍。');view.input('family-intake-voice-transcript','修正后的介绍。');view.click('family-intake-voice-insert');assert.match(view.elements.get('family-intake-input').value,/修正后的介绍/);assert.equal(view.elements.get('owner-input').value,'主草稿');assert.equal(view.requests.filter(r=>r.method==='POST').length,0);
 view.click('family-intake-voice-start');await view.settle();view.click('family-intake-voice-cancel');view.key('Escape');assert.equal(view.elements.get('owner-input').value,'主草稿');
});
test('Owner reads and searches a default member archive with stable earlier-page cursor',async()=>{
 const snapshot=initial(),pages=[];const view=await workbenchHarness({snapshot,post:async body=>{if(body.action==='history_page'){pages.push(body);return response({access:'full',messages:[{id:body.before?'earlier':'latest',dir:'in',text:body.query?'搜索命中的原话':body.before?'较早原话':'最近原话',at:'2026-10-25T09:00:00Z'}],total:2,hasMore:!body.before&&!body.query,nextCursor:'history-cursor'});}}});
 view.click('nav-family');const member=descendants(view.elements.get('workspace')).find(n=>n.dataset.personId==='mom');member.fire('click');await view.settle();assert.match(view.elements.get('workspace').textContent,/最近原话/);button(view.elements.get('workspace'),'查看更早记录').fire('click');await view.settle();assert.equal(pages.at(-1).before,'history-cursor');assert.match(view.elements.get('workspace').textContent,/较早原话.*最近原话/s);
 const search=byName(view.elements.get('workspace'),'history-query');search.value='第二版';button(view.elements.get('workspace'),'查找').fire('click');await view.settle();assert.equal(pages.at(-1).personId,'mom');assert.equal(pages.at(-1).query,'第二版');assert.equal(pages.at(-1).before,undefined);assert.match(view.elements.get('workspace').textContent,/搜索命中的原话/);
});
test('brief sharing changes do not hide direct Owner history including an in-flight read',async()=>{
 const snapshot=initial();let finish;const view=await workbenchHarness({snapshot,post:body=>body.action==='history_page'?new Promise(resolve=>{finish=()=>resolve(response({access:'full',messages:[{id:'saved',dir:'in',text:'Owner可读的保存记录',at:'2026-10-25T00:00:00Z'}],total:1,hasMore:false}));}):undefined});
 view.click('nav-family');descendants(view.elements.get('workspace')).find(n=>n.dataset.personId==='full').fire('click');await view.settle();snapshot.people.find(p=>p.id==='full').shareWithOwner='none';view.click('refresh');await view.settle();finish();await view.settle();assert.match(view.elements.get('workspace').textContent,/Owner可读的保存记录/);assert.doesNotMatch(view.elements.get('workspace').textContent,/尚未开放完整记录/);
});
test('removing Owner clears cached history and rejects late history responses',async()=>{
 const snapshot=initial();let finish;const view=await workbenchHarness({snapshot,post:body=>body.action==='history_page'?new Promise(resolve=>{finish=()=>resolve(response({access:'full',messages:[{id:'late-private',dir:'in',text:'Owner移除后不能显示',at:'2026-10-25T00:00:00Z'}],total:1,hasMore:false}));}):undefined});
 view.click('nav-family');await view.settle();snapshot.people=snapshot.people.filter(p=>p.role!=='owner');view.click('refresh');await view.settle();finish();await view.settle();assert.doesNotMatch(view.elements.get('workspace').textContent,/Owner移除后不能显示/);
});
const configuredPost=async body=>({tool_catalog:response({items:[{toolId:'ai_digest',executorAvailable:true,ready:false},{toolId:'weather',executorAvailable:true,ready:false},{toolId:'presentation',executorAvailable:true,ready:false}]}),tool_assignments:response({items:[]}),workflow_requests:response({items:[]}),harness_projects:response({items:[{workspaceId:'daily',title:'AI日报',path:'/synthetic/daily'}]}),family_access_list:response({items:[]})})[body.action];
test('project dispatch has a direct optional family recipient while retaining Owner execution',async()=>{
 const snapshot=initial();snapshot.people.find(p=>p.id==='mom').binding={connected:true,status:'connected'};
 const view=await workbenchHarness({snapshot,post:async body=>body.action==='harness_submit'?response({id:'new-task'}):configuredPost(body)});
 view.click('nav-arrangements');await view.settle();button(view.elements.get('workspace'),'交代一件事').fire('click');
 const form=descendants(view.elements.get('capability-panel')).find(n=>n.tagName==='form'),recipient=byName(form,'recipientPersonId');assert.ok(recipient);recipient.value='mom';descendants(form).find(n=>n.tagName==='textarea').value='整理成一份周末计划';form.fire('submit');await view.settle();
 const sent=view.requests.find(row=>row.body?.action==='harness_submit')?.body;assert.equal(sent.recipientPersonId,'mom');assert.equal(sent.workspaceId,'daily');
});
test('a daily digest can track the source family with a source date zone distinct from the recipient zone',async()=>{
 const view=await workbenchHarness({post:async body=>body.action==='digest_sources'?response({items:[{relativePath:'reports/2026-10-25-wechat.txt',name:'2026-10-25-wechat.txt',bytes:120}]}):body.action==='tool_assign'?response({...body,revision:1}):configuredPost(body)});
 view.click('nav-tools');await view.settle();button(view.elements.get('workspace'),'给家人开通').fire('click');await view.settle();const form=descendants(view.elements.get('capability-panel')).find(n=>n.tagName==='form');
 const latest=byName(form,'latestDigest');assert.ok(latest);latest.checked=true;byName(form,'sourceTimeZone').value='America/Mexico_City';byName(form,'scheduled').checked=true;byName(form,'time').value='08:00';byName(form,'timeZone').value='Asia/Shanghai';form.fire('submit');await view.settle();
 const saved=view.requests.find(r=>r.body?.action==='tool_assign')?.body;assert.equal(saved.resource.selection,'latest');assert.equal(saved.resource.sourceTimeZone,'America/Mexico_City');assert.equal(saved.schedule.timeZone,'Asia/Shanghai');
});
test('tool configuration validates time in place and saves independent self-call and delivery choices',async()=>{
 const view=await workbenchHarness({post:async body=>body.action==='tool_assign'?response({...body,revision:1}):configuredPost(body)});view.click('nav-tools');await view.settle();button(view.elements.get('workspace'),'给家人开通').fire('click');await view.settle();const form=descendants(view.elements.get('capability-panel')).find(n=>n.tagName==='form');byName(form,'relativePath').value='reports/latest.md';byName(form,'allowInvoke').checked=false;byName(form,'scheduled').checked=true;form.fire('submit');await view.settle();assert.equal(view.requests.filter(r=>r.body?.action==='tool_assign').length,0);assert.match(form.textContent,/时间和时区/);
 byName(form,'time').value='08:00';byName(form,'timeZone').value='Asia/Shanghai';form.fire('submit');await view.settle();const saved=view.requests.find(r=>r.body?.action==='tool_assign').body;assert.equal(saved.allowInvoke,false);assert.equal(saved.schedule.enabled,true);assert.equal(saved.resource.relativePath,'reports/latest.md');assert.equal(saved.personId,'mom');assert.match(view.elements.get('capability-panel').textContent,/安排已保存/);
});
test('weather stays in one configuration dialog and sends the selected numeric location identity',async()=>{
 const view=await workbenchHarness({post:async body=>body.action==='weather_locations'?response({items:[{id:1808926,label:'杭州，浙江，中国'}]}):body.action==='tool_assign'?response({...body,revision:1}):configuredPost(body)});view.click('nav-tools');await view.settle();const rows=descendants(view.elements.get('workspace')).filter(n=>n.className==='lele-tool-row');button(rows[1],'给家人开通').fire('click');await view.settle();const body=view.elements.get('capability-panel'),form=descendants(body).find(n=>n.tagName==='form');byName(form,'city').value='杭州';form.fire('submit');await view.settle();assert.equal(view.requests.filter(r=>r.body?.action==='tool_assign').length,0);button(body,'查找城市').fire('click');await view.settle();form.fire('submit');await view.settle();const saved=view.requests.find(r=>r.body?.action==='tool_assign').body;assert.equal(saved.resource.locationId,1808926);assert.equal(saved.resource.city,'杭州，浙江，中国');
});
test('permission cancel makes no mutation and saved permissions use the selected stable member',async()=>{
 const view=await workbenchHarness({post:async body=>body.action==='family_access_grant'?response({...body,revision:1}):configuredPost(body)});view.click('nav-arrangements');await view.settle();button(view.elements.get('workspace'),'编辑权限').fire('click');await view.settle();button(view.elements.get('capability-panel'),'取消').fire('click');assert.equal(view.requests.filter(r=>r.body?.action==='family_access_grant').length,0);
 button(view.elements.get('workspace'),'编辑权限').fire('click');await view.settle();const form=descendants(view.elements.get('capability-panel')).find(n=>n.tagName==='form');byName(form,'workspaceId').checked=true;byName(form,'capability').checked=true;form.fire('submit');await view.settle();const saved=view.requests.find(r=>r.body?.action==='family_access_grant').body;assert.equal(saved.personId,'mom');assert.deepEqual(saved.workspaceIds,['daily']);assert.deepEqual(saved.capabilities,['read']);
});

test('a delayed family history response cannot replace a different active page',async()=>{
 let finish;const view=await workbenchHarness({post:async body=>body.action==='history_page'?new Promise(resolve=>{finish=()=>resolve(response({access:'full',messages:[{id:'late',dir:'in',text:'迟到历史',at:'2026-10-25T00:00:00Z'}],total:1,hasMore:false}));}):configuredPost(body)});
 view.click('nav-family');descendants(view.elements.get('workspace')).find(n=>n.dataset.personId==='full').fire('click');await view.settle();view.click('nav-tools');await view.settle();finish();await view.settle();assert.equal(view.elements.get('nav-tools').getAttribute('aria-current'),'page');assert.doesNotMatch(view.elements.get('workspace').textContent,/迟到历史/);assert.match(view.elements.get('workspace').textContent,/AI 信息精选/);
});

test('brand and skip links prevent srcdoc navigation, return to chat and preserve the unsent draft',async()=>{
 const view=await workbenchHarness({post:configuredPost});view.input('owner-input','不会丢掉的草稿');view.click('nav-tools');await view.settle();let brandPrevented=false;view.elements.get('brand-home').fire('click',{preventDefault(){brandPrevented=true;}});assert.equal(brandPrevented,true);assert.equal(view.elements.get('nav-chat').getAttribute('aria-current'),'page');assert.equal(view.elements.get('owner-input').value,'不会丢掉的草稿');let skipPrevented=false;view.elements.get('skip-main').fire('click',{preventDefault(){skipPrevented=true;}});assert.equal(skipPrevented,true);assert.equal(view.activeElement(),view.elements.get('workspace'));
});

test('digest file choices come from the selected project without requiring path transcription',async()=>{
 const view=await workbenchHarness({post:async body=>body.action==='digest_sources'?response({items:[{relativePath:'reports/latest.md',name:'latest.md',bytes:120}]}):configuredPost(body)});view.click('nav-tools');await view.settle();button(view.elements.get('workspace'),'给家人开通').fire('click');await view.settle();const form=descendants(view.elements.get('capability-panel')).find(n=>n.tagName==='form');assert.equal(byName(form,'digestFile').value,'reports/latest.md');assert.equal(byName(form,'relativePath').value,'reports/latest.md');const lookup=view.requests.find(r=>r.body?.action==='digest_sources').body;assert.equal(lookup.workspaceId,'daily');
});
test('Owner downloads a default family member document without enabling brief sharing',async()=>{
 const snapshot=initial();snapshot.harness={tasks:[{id:'task-mom',personId:'mom',executor:'family_project',workspaceTitle:'资料项目',state:'succeeded',contentAccess:'full',prompt:'整理文稿',files:[{relativePath:'family-output/mom/report.md',name:'report.md'}]}]};const content='验收文稿';const view=await workbenchHarness({snapshot,post:async body=>body.action==='harness_artifact'?response({name:'report.md',mimeType:'text/markdown',bytes:Buffer.byteLength(content),dataBase64:Buffer.from(content).toString('base64')}):configuredPost(body)});view.click('nav-arrangements');await view.settle();button(view.elements.get('workspace'),'下载 report.md').fire('click');await view.settle();const sent=view.requests.find(r=>r.body?.action==='harness_artifact').body;assert.equal(sent.taskId,'task-mom');assert.equal(sent.relativePath,'family-output/mom/report.md');assert.equal(view.elements.get('error').textContent,'');assert.equal(snapshot.people.find(p=>p.id==='mom').shareWithOwner,'none');
});
test('PPT scheduled invitations preserve permission to submit materials, and workflow progress only updates its own request',async()=>{
 const requests=[{personId:'mom',requestId:'workflow-1',text:'我想要旅行工具',status:'pending'}];const view=await workbenchHarness({post:async body=>body.action==='workflow_requests'?response({items:requests}):body.action==='workflow_request_update'?response({...body}):configuredPost(body)});view.click('nav-tools');await view.settle();const rows=descendants(view.elements.get('workspace')).filter(n=>n.className==='lele-tool-row');button(rows[2],'给家人开通').fire('click');await view.settle();const form=descendants(view.elements.get('capability-panel')).find(n=>n.tagName==='form'),invoke=byName(form,'allowInvoke'),scheduled=byName(form,'scheduled');invoke.checked=false;scheduled.checked=true;scheduled.fire('change');assert.equal(invoke.checked,true);assert.equal(invoke.disabled,true);view.key('Escape');button(view.elements.get('workspace'),'查看并接续').fire('click');const requestForm=descendants(view.elements.get('capability-panel')).find(n=>n.tagName==='form');byName(requestForm,'status').value='accepted';byName(requestForm,'note').value='先核对想用的资料';requestForm.fire('submit');await view.settle();const sent=view.requests.find(r=>r.body?.action==='workflow_request_update').body;assert.equal(sent.personId,'mom');assert.equal(sent.requestId,'workflow-1');assert.equal(sent.status,'accepted');assert.equal(view.requests.some(r=>r.body?.action==='harness_submit'),false);
});

test('brief opens its content panel with the correct title, rather than the settings form',async()=>{
 const snapshot=initial();snapshot.lastBrief={text:'已生成的今日服务简报'};const view=await workbenchHarness({snapshot});view.click('brief-nav-open');assert.equal(view.elements.get('drawer-title').textContent,'今日家庭服务简报');assert.equal(view.elements.get('brief-panel').hidden,false);assert.equal(view.elements.get('settings-panel').hidden,true);assert.match(view.elements.get('brief-direct-content').textContent,/已生成的今日服务简报/);
});

test('existing profile corrections stay in a dedicated person-scoped editor with voice available',async()=>{
 const view=await workbenchHarness();view.input('owner-input','原主草稿');view.click('nav-family');button(view.elements.get('workspace'),'补充资料').fire('click');assert.equal(view.elements.get('family-intake-panel').hidden,false);assert.equal(view.elements.get('family-intake-voice-start').hidden,false);view.input('family-intake-input','交流时再简短一点');press(view,'family-intake-input');await view.settle();const sent=view.requests.find(r=>r.body?.action==='owner_chat').body;assert.equal(sent.profileEdit,true);assert.equal(sent.profileIntake,undefined);assert.equal(sent.contextId,'person:mom');assert.equal(view.elements.get('owner-input').value,'原主草稿');
});

test('cached project choices never skip loading the actual family permissions',async()=>{
 const view=await workbenchHarness({post:async body=>body.action==='family_access_list'?response({items:[{personId:'mom',workspaceIds:['daily'],capabilities:['read'],revision:3}]}):configuredPost(body)});view.click('nav-tools');await view.settle();button(view.elements.get('workspace'),'给家人开通').fire('click');await view.settle();view.key('Escape');view.click('nav-arrangements');await view.settle();assert.equal(view.requests.some(r=>r.body?.action==='family_access_list'),true);const momRow=descendants(view.elements.get('workspace')).find(n=>n.className==='lele-tool-row'&&n.textContent.includes(people[1].label));assert.match(momRow.textContent,/AI日报/);assert.doesNotMatch(momRow.textContent,/尚未分配/);
});
test('console task delivery reports console return and never claims WeChat submission',async()=>{
 const snapshot=initial();snapshot.harness={tasks:[{id:'task-console',personId:'owner',origin:'console',workspaceTitle:'项目资料',state:'succeeded',prompt:'整理资料',text:'已整理',delivery:{state:'accepted'}}]};const view=await workbenchHarness({snapshot,post:configuredPost});view.click('nav-arrangements');await view.settle();const task=descendants(view.elements.get('workspace')).find(n=>n.className==='lele-native-task');assert.match(task.textContent,/结果已回到当前控制台/);assert.doesNotMatch(task.textContent,/交给微信接口/);
});
