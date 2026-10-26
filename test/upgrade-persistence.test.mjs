import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';

const instant='2026-10-23T12:00:00.000Z';
// A literal v1 fixture protects the released storage contract independently of
// the current store's constructors. These identities and credentials are fake.
function fixture(t,{paused=false}={}) {
  const directory=mkdtempSync(join(tmpdir(),'family-upgrade-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const ids=['owner','parent-one','parent-two'];
  const people=ids.map((id,i)=>({id,role:i===0?'owner':'elder',label:`Synthetic ${i}`,
    timeZone:'Asia/Shanghai',interests:[`interest-${i}`],notes:`note-${i}`,
    shareWithOwner:'none',dailyEnabled:false,dailyTime:'08:00',createdAt:instant}));
  const bindings=ids.map((personId,i)=>({personId,accountId:`fake-account-${i}`,
    peerId:`fake-peer-${i}`,generation:i+4,status:'connected'}));
  const snapshot={version:1,config:{paused,timeZone:'Asia/Shanghai',ownerBriefEnabled:false,
    ownerBriefTime:'20:00',provider:'',model:''},people,bindings,
    messages:ids.map((personId,i)=>({id:`fake-message-${i}`,personId,dir:'in',text:`saved-${i}`,kind:'chat',at:instant})),
    reminders:[{id:'saved-reminder',personId:ids[1],text:'Synthetic future reminder',dueAt:'2027-01-01T12:00:00.000Z',
      repeat:'once',timeZone:'Asia/Shanghai',status:'active',createdAt:instant}],outbox:[]};
  writeFileSync(join(directory,'family.json'),JSON.stringify(snapshot),{mode:0o600});
  const auths=new Map();
  for(const [i,id] of ids.entries()) {
    const folder=join(directory,'channels',id);mkdirSync(folder,{recursive:true,mode:0o700});
    const auth={token:`synthetic-token-${i}`,baseUrl:'https://ilinkai.weixin.qq.com',
      accountId:bindings[i].accountId,peerId:bindings[i].peerId,cursor:`cursor-${i}`,contextToken:`context-${i}`};
    writeFileSync(join(folder,'auth.json'),JSON.stringify(auth),{mode:0o600});auths.set(id,auth);
  }
  const polls=[];
  const api={
    getQr:async()=>assert.fail('An existing binding must not request another QR'),
    checkQr:async()=>assert.fail('An existing binding must not wait for a scan'),
    send:async()=>assert.fail('Reload must not send unsolicited messages'),
    poll:args=>{polls.push({...args,signal:undefined});return new Promise((resolve,reject)=>{
      if(args.signal.aborted)return reject(new Error('aborted'));
      args.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
    });},
  };
  return {directory,ids,snapshot,auths,api,polls};
}

test('released v1 state restores all three WeChat routes after replacement and another restart without a scan',async t=>{
  const f=fixture(t);let runtime;
  t.after(async()=>runtime?.close());
  for(let restart=0;restart<2;restart++) {
    runtime=createRuntime({directory:f.directory,api:f.api,now:()=>instant});
    assert.deepEqual(runtime.store.snapshot().people,f.snapshot.people);
    assert.deepEqual(runtime.store.snapshot().messages,f.snapshot.messages);
    assert.deepEqual(runtime.store.snapshot().reminders,f.snapshot.reminders);
    assert.equal(runtime.store.snapshot().config.paused,false);
    await runtime.start();
    for(const [i,id] of f.ids.entries()) {
      assert.equal(runtime.channels.status(id).connected,true);
      const {status,...binding}=f.snapshot.bindings[i];
      assert.deepEqual(runtime.store.route(id),binding);
      const authFile=join(f.directory,'channels',id,'auth.json');
      assert.deepEqual(JSON.parse(readFileSync(authFile,'utf8')),f.auths.get(id));
      assert.equal(statSync(authFile).mode&0o777,0o600);
    }
    await runtime.close();
    assert.deepEqual(JSON.parse(readFileSync(join(f.directory,'family.json'),'utf8')).bindings,f.snapshot.bindings);
  }
  assert.equal(f.polls.length,6);
  for(const [i,args] of f.polls.entries())assert.deepEqual(args,{...f.auths.get(f.ids[i%3]),signal:undefined});
});

test('a paused released profile retains its saved bindings and stays idle until explicitly started',async t=>{
  const f=fixture(t,{paused:true});const runtime=createRuntime({directory:f.directory,api:f.api,now:()=>instant});
  t.after(()=>runtime.close());
  assert.equal(runtime.store.snapshot().config.paused,true);
  assert.deepEqual(runtime.store.snapshot().bindings,f.snapshot.bindings);
  assert.equal(f.polls.length,0);
  await runtime.start();
  assert.equal(f.polls.length,3);
});

test('an unsupported stored version fails without replacing any saved state or credential',t=>{
  const f=fixture(t);const file=join(f.directory,'family.json');
  const original=JSON.stringify({...f.snapshot,version:999});writeFileSync(file,original);
  assert.throws(()=>createRuntime({directory:f.directory,api:f.api}),/存储版本/);
  assert.equal(readFileSync(file,'utf8'),original);
  for(const id of f.ids)assert.deepEqual(JSON.parse(readFileSync(join(f.directory,'channels',id,'auth.json'),'utf8')),f.auths.get(id));
  assert.equal(f.polls.length,0);
});
