import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';

const initialTime='2026-10-22T12:00:00.000Z';
function setup(t){
  const directory=mkdtempSync(join(tmpdir(),'family-owner-audit-'));
  let now=initialTime;
  const store=createStore({directory,now:()=>now});
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  store.addPerson({id:'owner',role:'owner',label:'测试 Owner'});
  store.addPerson({id:'elder',role:'elder',label:'测试长辈'});
  store.addPerson({id:'other-elder',role:'elder',label:'另一位测试长辈'});
  store.bindPerson('owner',{accountId:'owner-account',peerId:'owner-peer'});
  return{directory,store,setNow:value=>{now=value;}};
}
const command=(patch={})=>({id:'command-1',requestedBy:'owner',targetPersonId:'elder',inboundMessageId:'message-1',action:'send_daily',status:'pending',...patch});

test('version 1 state without audit remains unchanged until the first owner command',t=>{
  const {directory,store}=setup(t),file=join(directory,'family.json');
  assert.equal(Object.hasOwn(store.snapshot(),'ownerCommands'),false);
  const before=readFileSync(file,'utf8'),reloaded=createStore({directory});
  assert.deepEqual(reloaded.ownerCommands(),[]);
  assert.equal(readFileSync(file,'utf8'),before);
  reloaded.recordOwnerCommand(command());
  const persisted=JSON.parse(readFileSync(file,'utf8'));
  assert.equal(persisted.version,1);
  assert.equal(persisted.ownerCommands.length,1);
  assert.equal(statSync(file).mode&0o777,0o600);
});

test('audit persists a captured owner route and defensive status records without message text',t=>{
  const {directory,store}=setup(t);
  const row=store.recordOwnerCommand(command());
  assert.deepEqual(row.requestRoute,{personId:'owner',accountId:'owner-account',peerId:'owner-peer',generation:1});
  assert.equal(row.createdAt,initialTime);
  assert.equal(row.updatedAt,initialTime);
  assert.equal(row.detail,'等待执行');
  row.requestRoute.peerId='mutated';
  const list=store.ownerCommands();list[0].status='failed';
  const reloaded=createStore({directory}).ownerCommands();
  assert.equal(reloaded[0].status,'pending');
  assert.equal(reloaded[0].requestRoute.peerId,'owner-peer');
  assert.equal(Object.hasOwn(reloaded[0],'text'),false);
  store.bindPerson('owner',{accountId:'replacement-account',peerId:'replacement-peer'});
  assert.equal(createStore({directory}).ownerCommands()[0].requestRoute.peerId,'owner-peer');
});

test('a stable command id is idempotent and rejects conflicting identities',t=>{
  const {directory,store,setNow}=setup(t);
  store.recordOwnerCommand(command());
  setNow('2026-10-22T12:01:00.000Z');
  const final=store.updateOwnerCommand('command-1',{status:'api_accepted',resultId:'outbox-1'});
  const before=readFileSync(join(directory,'family.json'),'utf8');
  assert.deepEqual(store.recordOwnerCommand(command()),final);
  assert.equal(readFileSync(join(directory,'family.json'),'utf8'),before);
  for(const patch of [{targetPersonId:'other-elder'},{inboundMessageId:'message-2'},{action:'remind'},{requestedBy:'elder'}])assert.throws(()=>store.recordOwnerCommand(command(patch)));
  assert.equal(store.ownerCommands().length,1);
});

test('audit update owns timestamps, permits execution statuses and preserves identity and route',t=>{
  const {directory,store,setNow}=setup(t);
  const original=store.recordOwnerCommand(command({action:'remind'}));
  setNow('2026-10-22T12:02:00.000Z');
  const scheduled=store.updateOwnerCommand(original.id,{status:'scheduled',resultId:'reminder-1'});
  assert.equal(scheduled.createdAt,initialTime);
  assert.equal(scheduled.updatedAt,'2026-10-22T12:02:00.000Z');
  assert.equal(scheduled.detail,'已创建提醒');
  assert.deepEqual(scheduled.requestRoute,original.requestRoute);
  assert.equal(scheduled.targetPersonId,'elder');
  assert.deepEqual(createStore({directory}).ownerCommands(),[scheduled]);
  for(const patch of [{status:'failed',targetPersonId:'other-elder'},{status:'failed',createdAt:initialTime},{status:'failed',requestRoute:original.requestRoute},{status:'unknown'},{status:'failed',detail:'长辈的私人聊天内容'}])assert.throws(()=>store.updateOwnerCommand(original.id,patch));
  assert.throws(()=>store.updateOwnerCommand('missing',{status:'failed'}));
});

test('audit rejects unknown actors, non-elder targets, invalid fields and unbound owners atomically',t=>{
  const {store}=setup(t);
  assert.equal(typeof store.recordOwnerCommand,'function');
  for(const patch of [{id:'../invalid'},{id:'x'.repeat(81)},{requestedBy:'missing'},{requestedBy:'elder'},{targetPersonId:'owner'},{targetPersonId:'missing'},{inboundMessageId:''},{inboundMessageId:'x'.repeat(513)},{action:'transfer'},{status:'delivered'},{resultId:'../invalid'},{resultId:'x'.repeat(81)},{detail:'私人日报正文'},{text:'私人聊天正文'},{requestRoute:{personId:'owner',accountId:'forged',peerId:'forged',generation:1}},{createdAt:initialTime}])assert.throws(()=>store.recordOwnerCommand(command(patch)));
  assert.equal(Object.hasOwn(store.snapshot(),'ownerCommands'),false);
  const unboundDirectory=mkdtempSync(join(tmpdir(),'family-owner-unbound-'));
  t.after(()=>rmSync(unboundDirectory,{recursive:true,force:true}));
  const noBinding=createStore({directory:unboundDirectory});
  noBinding.addPerson({id:'owner',role:'owner',label:'测试 Owner'});
  noBinding.addPerson({id:'elder',role:'elder',label:'测试长辈'});
  assert.throws(()=>noBinding.recordOwnerCommand(command()));
});

test('import rejects malformed or duplicate audit entries without rewriting the saved file',t=>{
  const {directory,store}=setup(t),file=join(directory,'family.json');
  store.recordOwnerCommand(command());
  const original=store.snapshot();
  const badStates=[
    {...original,ownerCommands:{}},
    {...original,ownerCommands:[...original.ownerCommands,...original.ownerCommands]},
    ...[{requestedBy:'elder'},{targetPersonId:'owner'},{status:'delivered'},{detail:'私人日报正文'},{createdAt:'yesterday'},{requestRoute:{personId:'elder',accountId:'x',peerId:'x',generation:1}},{token:'credential'}].map(patch=>({...original,ownerCommands:[{...original.ownerCommands[0],...patch}]})),
  ];
  for(const state of badStates){
    const text=JSON.stringify(state);writeFileSync(file,text);
    assert.throws(()=>createStore({directory}));
    assert.equal(readFileSync(file,'utf8'),text);
  }
});
