import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createStore} from '../src/store.mjs';
import {createFamilyToolbox} from '../src/family-toolbox.mjs';
import {createServiceSetup} from '../src/service-setup.mjs';
import {createRuntime} from '../src/runtime.mjs';

const text='请自己找到本机 Codex 的 AI 日报项目，实际打开最新微信版日报，把正文回复给我；只回复我，不要发给 K，也不要修改订阅。';
const instant='2026-10-25T20:53:19.072Z';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);

async function fixture(t,mutate=()=>{}){
 const directory=mkdtempSync(join(tmpdir(),'lele-owner-resume-'));let clock=instant;
 const now=()=>clock,store=createStore({directory,now});store.configure({paused:false});
 for(const[id,role,label]of[['owner','owner','我'],['k','elder','K']]){store.addPerson({id,role,label,timeZone:'Asia/Shanghai',shareWithOwner:'none'});store.bindPerson(id,{accountId:'a-'+id,peerId:'p-'+id});}
 const message={id:'real-test-id',peerId:'p-owner',text,at:instant};store.recordInbound('owner',message);
 const sourceRequestId='wechat-'+digest([store.route('owner'),message.id]);
 const toolbox=createFamilyToolbox({directory,store,now});
 const setup=createServiceSetup({directory,store,toolbox,now});
 // Build a schema-valid synthetic preview.15 false-stop journal, including
 // the original durable request fingerprint; never touch live/private data.
 const old=await setup.handle({actorId:'owner',text:'停止给我每天推送AI日报',requestId:sourceRequestId,origin:'wechat'});
 const file=join(directory,'service-setup.json'),ledger=JSON.parse(readFileSync(file,'utf8'));
 ledger.drafts[0].intentEvidence=text.trim().normalize('NFKC');
 ledger.requests[0].fingerprint=createHash('sha256').update(canonical({type:'handle',actorId:'owner',text,requestId:sourceRequestId,origin:'wechat',contextId:'default'})).digest('hex');
 writeFileSync(file,JSON.stringify(ledger)+'\n');
 const ack=store.enqueue({personId:'owner',text:old.reply,kind:'harness_command',sourceKey:'reply:owner:1:'+message.id});store.transition(ack.id,'dispatching');store.transition(ack.id,'api_accepted');
 await mutate({store,directory,ledger,toolbox,message,sourceRequestId,setTime:value=>{clock=value;}});
 const starts=[],sent=[],runtime=createRuntime({directory,now,intervalMs:600000,
  ownerAgent:{ensureControlWorkspace:async()=>({workspaceId:'control',title:'Owner',path:join(directory,'control')}),listWorkspaces:async()=>[{workspaceId:'control',title:'Owner',path:join(directory,'control'),sessionIds:[]}],start:async intent=>{starts.push(structuredClone(intent));return{state:'succeeded',text:'AI日报正文合成结果'};},observe:async()=>{throw Error('must not observe on resume');}},
  channelFactory:()=>({status:()=>({status:'connected'}),connect:async()=>{},disconnect:async()=>{},close:async()=>{},send:async(route,body,options)=>{assert.equal(options.authorize(),true);sent.push({personId:route.personId,text:body});return{status:'api_accepted'};}}),
 });
 t.after(async()=>{await runtime.close();rmSync(directory,{recursive:true,force:true});});
 await runtime.start();return{runtime,starts,sent,directory,message,sourceRequestId,setTime:value=>{clock=value;}};
}

test('resume uses the saved Owner inbound and original request once without another acknowledgement or family delivery',async t=>{
 const f=await fixture(t),before=f.runtime.store.snapshot(),service=readFileSync(join(f.directory,'service-setup.json'),'utf8');
 const results=await Promise.all(Array.from({length:3},()=>f.runtime.action({action:'resume_owner_native_message',messageId:f.message.id})));
 await f.runtime.settled();
 assert.equal(results.filter(result=>result.resumed).length,1);assert.equal(f.starts.length,1);
 const task=f.runtime.status().harness.tasks[0];assert.equal(task.sourceRequestId,f.sourceRequestId);assert.equal(task.origin,'wechat');assert.equal(task.deliveryTarget,undefined);
 assert.equal(f.starts[0].prompt.endsWith(text),true);assert.equal(task.delivery.state,'accepted');
 assert.deepEqual(f.runtime.store.snapshot().messages.filter(row=>row.dir==='in'),before.messages.filter(row=>row.dir==='in'));
 assert.deepEqual(f.runtime.store.snapshot().outbox.filter(row=>row.kind==='harness_command'),before.outbox);
 assert.deepEqual(f.sent,[{personId:'owner',text:'Harness 任务结果\nAI日报正文合成结果'}]);
 assert.deepEqual(f.runtime.store.snapshot().people,before.people);assert.deepEqual(f.runtime.store.snapshot().reminders,before.reminders);
 assert.equal(readFileSync(join(f.directory,'service-setup.json'),'utf8'),service);
 const again=await f.runtime.action({action:'resume_owner_native_message',messageId:f.message.id});await f.runtime.settled();
 assert.equal(again.resumed,false);assert.equal(f.starts.length,1);assert.equal(f.sent.length,1);
});

for(const [label,mutate]of[
 ['old binding',({store})=>store.bindPerson('owner',{accountId:'new-owner',peerId:'new-peer'})],
 ['newer inbound',({store})=>store.recordInbound('owner',{id:'newer',peerId:'p-owner',text:'下一件事',at:instant})],
 ['expired inbound',({setTime})=>setTime('2026-10-25T21:53:19.073Z')],
 ['future inbound',({setTime})=>setTime('2026-10-25T20:53:18.000Z')],
 ['missing false-stop evidence',({directory})=>{const file=join(directory,'service-setup.json'),ledger=JSON.parse(readFileSync(file,'utf8'));ledger.requests=[];writeFileSync(file,JSON.stringify(ledger)+'\n');}],
 ['existing related service grant',({toolbox})=>toolbox.assign({actorId:'owner',personId:'owner',toolId:'ai_digest',resource:{workspaceId:'digest',relativePath:'report.md'},allowInvoke:true,schedule:null})],
 ['attached inbound',({directory})=>{const file=join(directory,'family.json'),state=JSON.parse(readFileSync(file,'utf8'));state.messages.find(row=>row.dir==='in').attachments=[{name:'input.txt',size:1}];writeFileSync(file,JSON.stringify(state));}],
])test(`resume rejects ${label} without native dispatch or outbound`,async t=>{
 const f=await fixture(t,mutate),before=f.runtime.store.snapshot();
 await assert.rejects(()=>f.runtime.action({action:'resume_owner_native_message',messageId:f.message.id}),/不能恢复|无法恢复|不支持/);
 await f.runtime.settled();assert.equal(f.starts.length,0);assert.equal(f.sent.length,0);assert.deepEqual(f.runtime.store.snapshot(),before);
});

test('resume preserves an unrelated family service assignment and never delivers to that family member',async t=>{
 const f=await fixture(t,({toolbox})=>toolbox.assign({actorId:'owner',personId:'k',toolId:'ai_digest',resource:{workspaceId:'digest',relativePath:'report.md'},allowInvoke:true,schedule:{enabled:true,time:'09:00',timeZone:'Asia/Shanghai'}}));
 const file=join(f.directory,'family-toolbox.json'),before=readFileSync(file,'utf8');
 const result=await f.runtime.action({action:'resume_owner_native_message',messageId:f.message.id});await f.runtime.settled();
 assert.equal(result.resumed,true);assert.equal(f.starts.length,1);assert.equal(f.sent.length,1);assert.equal(f.sent[0].personId,'owner');
 assert.equal(readFileSync(file,'utf8'),before);
});

test('resume rejects a paused runtime and unknown message without side effects',async t=>{
 const f=await fixture(t);await f.runtime.action({action:'pause'});
 await assert.rejects(()=>f.runtime.action({action:'resume_owner_native_message',messageId:f.message.id}),/不能恢复|无法恢复|不支持/);
 await assert.rejects(()=>f.runtime.action({action:'resume_owner_native_message',messageId:'missing'}),/不能恢复|无法恢复|不支持/);
 assert.equal(f.starts.length,0);assert.equal(f.sent.length,0);
});

test('the original negative delivery request now enters native directly on both Owner origins',async t=>{
 for(const origin of ['wechat','console']){
  const f=await fixture(t);const before=f.runtime.store.snapshot().outbox.length;
  if(origin==='wechat')await f.runtime.receive('owner',{id:'new-native-'+origin,peerId:'p-owner',text});
  else await f.runtime.action({action:'owner_chat',requestId:'new-native-'+origin,text});
  await f.runtime.settled();assert.equal(f.starts.length,1);assert.equal(f.starts[0].origin,origin);assert.equal(f.starts[0].deliveryTarget,undefined);
  assert.equal(f.sent.some(row=>row.personId==='k'),false);assert.equal(f.runtime.status().serviceSetup.length,1);
  assert.equal(f.runtime.store.snapshot().outbox.length,before+(origin==='wechat'?2:0));
 }
});
