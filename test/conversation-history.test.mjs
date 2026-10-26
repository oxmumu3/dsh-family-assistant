import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';
import {createConversationHistory} from '../src/conversation-history.mjs';

const directories=[];
const at=index=>new Date(Date.UTC(2026,9,25,0,index)).toISOString();
const message=(index,personId='mom',patch={})=>({id:'m-'+index,personId,dir:index%2?'out':'in',text:`${personId} 原文 ${index}`,kind:'chat',at:at(index),...patch});
function setup({messages=[],sharing='none'}={}){
  const directory=mkdtempSync(join(tmpdir(),'family-conversation-history-'));directories.push(directory);
  let store=createStore({directory,now:()=>at(0)});
  store.addPerson({id:'owner',role:'owner',label:'Owner'});
  store.addPerson({id:'mom',role:'elder',label:'合成妈妈',shareWithOwner:sharing});
  store.addPerson({id:'dad',role:'elder',label:'合成爸爸',shareWithOwner:'full'});
  const fixture=store.snapshot();fixture.messages=messages;
  writeFileSync(join(directory,'family.json'),JSON.stringify(fixture,null,2)+'\n');
  store=createStore({directory,now:()=>at(0)});
  return{directory,store,history:createConversationHistory({store})};
}
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
const request={viewerPersonId:'owner',personId:'mom'};
const key=row=>JSON.stringify([row.personId,row.dir,row.id]);

test('pages both directions from all existing local records rather than only the last 100',()=>{
  const messages=Array.from({length:243},(_,index)=>message(index));
  const {history}=setup({messages});
  const page=history.page(request);
  assert.equal(page.access,'full');assert.equal(page.available,true);assert.equal(page.total,243);
  assert.deepEqual(page.messages,messages.slice(-50));assert.equal(page.messages.length,50);
  assert.equal(page.hasMore,true);assert.match(page.nextCursor,/^fh1_[A-Za-z0-9_-]{43}$/);
  assert.equal(page.historyScope,'available_local_records');assert.equal(page.source.supportsAttachments,true);
  assert.match(page.source.description,/本机|现存/);assert.match(page.source.description,/微信|手机/);
  assert.deepEqual(new Set(page.messages.map(row=>row.dir)),new Set(['in','out']));
});

test('every older page is contiguous with no skipped or duplicated text',()=>{
  const messages=Array.from({length:243},(_,index)=>message(index));
  const {history}=setup({messages});let before;const all=[];
  for(let safety=0;safety<20;safety++){
    const page=history.page({...request,limit:37,...(before?{before}:{})});all.unshift(...page.messages);
    if(!page.hasMore){assert.equal(page.nextCursor,null);break;}
    assert.ok(page.nextCursor);before=page.nextCursor;
  }
  assert.deepEqual(all,messages);assert.equal(new Set(all.map(key)).size,messages.length);
});

test('new tail messages do not shift the anchor for older pagination',()=>{
  const messages=Array.from({length:150},(_,index)=>message(index));
  const {store,history}=setup({messages});
  const latest=history.page({...request,limit:30});
  store.addMessage('mom',{id:'new-tail',dir:'in',text:'分页后追加的新入站',at:at(200)});
  const older=history.page({...request,before:latest.nextCursor,limit:30});
  assert.deepEqual(older.messages,messages.slice(90,120));assert.equal(older.total,151);
  assert.equal(history.page({...request,limit:1}).messages[0].id,'new-tail');
});

test('same timestamps keep stable archive order and inbound/outbound ID reuse has distinct cursors',()=>{
  const messages=[message(0,'mom',{id:'shared',dir:'in',at:at(0)}),message(1,'mom',{id:'shared',dir:'out',at:at(0)}),message(2,'mom',{id:'third',at:at(0)})];
  const {history}=setup({messages});
  const latest=history.page({...request,limit:1});
  const middle=history.page({...request,limit:1,before:latest.nextCursor});
  const first=history.page({...request,limit:1,before:middle.nextCursor});
  assert.deepEqual(latest.messages,[messages[2]]);assert.deepEqual(middle.messages,[messages[1]]);assert.deepEqual(first.messages,[messages[0]]);
  assert.notEqual(latest.nextCursor,middle.nextCursor);assert.equal(first.hasMore,false);assert.equal(first.nextCursor,null);
});

test('messages sort chronologically, using original order only for ties',()=>{
  const early=message(0),middleA=message(1,'mom',{at:at(5)}),middleB=message(2,'mom',{at:at(5)}),late=message(3,'mom',{at:at(20)});
  const {history}=setup({messages:[late,middleA,early,middleB]});
  assert.deepEqual(history.page({...request,limit:100}).messages,[early,middleA,middleB,late]);
});

test('one member never receives another member messages or a usable foreign cursor',()=>{
  const {history}=setup({messages:[...Array.from({length:4},(_,index)=>message(index)),message(10,'dad')]});
  const mom=history.page({...request,limit:1});
  const dad=history.page({...request,personId:'dad'});
  assert.equal(dad.total,1);assert.ok(dad.messages.every(row=>row.personId==='dad'));
  assert.throws(()=>history.page({...request,personId:'dad',before:mom.nextCursor}),/分页|标识|cursor/i);
});

test('only a registered Owner can inspect history',()=>{
  const {history}=setup({messages:[message(0)]});
  for(const viewerPersonId of ['mom','dad','unknown'])assert.throws(()=>history.page({...request,viewerPersonId}),/Owner|权限/);
  assert.throws(()=>history.page({...request,role:'owner'}),/参数|字段/);
  assert.throws(()=>history.page({...request,personId:'unknown'}),/家人|成员/);
});

test('the Owner can read their own local archive without enabling sharing',()=>{
  const ownerMessage=message(0,'owner');
  const {history}=setup({messages:[ownerMessage,message(1)]});
  const page=history.page({...request,personId:'owner'});
  assert.equal(page.access,'full');assert.equal(page.available,true);assert.deepEqual(page.messages,[ownerMessage]);
});

test('registered Owner reads saved family history regardless of brief sharing choice',()=>{
  for(const sharing of ['full','summary','none']){
    const messages=Array.from({length:120},(_,index)=>message(index));
    const {history,store}=setup({messages,sharing});
    const page=history.page(request);
    assert.equal(page.access,'full');assert.equal(page.available,true);assert.deepEqual(page.messages,messages.slice(-50));
    assert.equal(page.total,120);assert.ok(page.nextCursor);assert.equal(page.hasMore,true);
    assert.equal(store.person('mom').shareWithOwner,sharing);
  }
});

test('changing brief sharing does not revoke Owner history or invalidate its pagination',()=>{
  const {store,history}=setup({messages:Array.from({length:120},(_,index)=>message(index))});
  const cursor=history.page(request).nextCursor;assert.ok(cursor);
  store.updatePerson('mom',{shareWithOwner:'summary'});
  const after=history.page({...request,before:cursor});
  assert.equal(after.access,'full');assert.equal(after.total,120);
  assert.deepEqual(after.messages,Array.from({length:50},(_,index)=>message(index+20)));
});

test('an empty local archive is available to Owner with default brief sharing',()=>{
  const {history}=setup();const page=history.page(request);
  assert.equal(page.access,'full');assert.equal(page.available,true);assert.equal(page.total,0);
  assert.deepEqual(page.messages,[]);assert.equal(page.hasMore,false);assert.equal(page.nextCursor,null);
});

test('invalid limits and extra inputs fail explicitly instead of silently changing the page',()=>{
  const {history}=setup({messages:[message(0)]});
  for(const limit of [0,-1,101,1.5,'50',null,NaN,Infinity])assert.throws(()=>history.page({...request,limit}),/数量|limit|分页/);
  for(const invalid of [null,[],42,'history'])assert.throws(()=>history.page(invalid),/参数/);
  for(const personId of ['',null,'../mom'])assert.throws(()=>history.page({...request,personId}),/成员|标识|参数/);
  assert.throws(()=>history.page({...request,query:'x'.repeat(201)}),/搜索|文字/);
  assert.equal(history.page({...request,limit:1}).messages.length,1);
});

test('malformed, nonexistent or no-longer-retained cursors are errors rather than restarting at the latest page',()=>{
  const {store,history}=setup({messages:[message(0),message(1)]});
  for(const before of ['',null,12,'not-a-cursor','fh1_'+'a'.repeat(43)])assert.throws(()=>history.page({...request,before}),/分页|标识|cursor/i);
  const cursor=history.page({...request,limit:1}).nextCursor;
  const state=store.snapshot();state.messages=[];
  const replaced=createConversationHistory({store:{snapshot:()=>structuredClone(state)}});
  assert.throws(()=>replaced.page({...request,before:cursor}),/分页|标识|cursor/i);
});

test('page responses are defensive projections and reading does not write any stored state',()=>{
  const {store,history,directory}=setup({messages:[message(0),message(1)]});
  const file=join(directory,'family.json'),bytes=readFileSync(file);
  const page=history.page({...request,limit:1});page.messages[0].text='changed';page.source.description='changed';
  history.page({...request,before:page.nextCursor,limit:1});history.page({...request,personId:'dad'});
  assert.deepEqual(readFileSync(file),bytes);assert.equal(store.messages('mom')[1].text,'mom 原文 1');
  assert.notEqual(history.page(request).source.description,'changed');
  const state=store.snapshot();state.messages[0].attachment={token:'not-in-current-schema'};state.messages[0].peerId='private-route';
  const projected=createConversationHistory({store:{snapshot:()=>state}}).page(request);
  assert.equal('attachment' in projected.messages[0],false);assert.equal('peerId' in projected.messages[0],false);
});

test('authorization and messages are evaluated from one fresh snapshot per request',()=>{
  const {store}=setup({messages:[message(0)]});const data=store.snapshot();let reads=0;
  const history=createConversationHistory({store:{snapshot(){reads++;return structuredClone(data);}}});
  assert.equal(history.page(request).messages.length,1);assert.equal(reads,1);
  data.people.find(person=>person.id==='owner').role='elder';
  assert.throws(()=>history.page(request),/Owner|权限/);assert.equal(reads,2);
});

test('unsupported store inputs and malformed local archive fail closed',()=>{
  for(const store of [null,{},[],{snapshot:'not-a-function'}])assert.throws(()=>createConversationHistory({store}),/存储|store/);
  assert.throws(()=>createConversationHistory({store:{snapshot:()=>({people:[],messages:null})}}).page(request),/归档|存储|Owner/);
});
