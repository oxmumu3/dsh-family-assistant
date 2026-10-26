import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHostResponder} from '../src/model.mjs';
import {createRuntime} from '../src/runtime.mjs';

const now='2026-10-26T00:00:00.000Z';
const failureReply='刚才回复时出了点问题，你的消息我已经收到了。这次没有执行任何操作，请稍后再试。';
const reply='能看到你的消息，我们可以继续聊。';
const complete=value=>[{type:'text-delta',index:0,text:typeof value==='string'?value:JSON.stringify(value)},{type:'finish',reason:{kind:'stop'}}];
const malformed=()=>complete('{"reply":"SYNTHETIC_PARTIAL_REPLY","action":');
const truncated=()=>[{type:'reasoning-delta',index:0,text:'SYNTHETIC_PRIVATE_REASONING'},{type:'finish',reason:{kind:'max-tokens'}}];
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};

async function fixture(t,steps){
 const directory=mkdtempSync(join(tmpdir(),'lele-model-recovery-')),sent=[],calls=[];
 const llm={async *stream(options){const index=calls.length;calls.push(options);assert.ok(index<steps.length,'recovery must be bounded');const step=steps[index];yield*(typeof step==='function'?await step(options):step);}};
 let runtime;
 const respond=createHostResponder({get:name=>name==='llm'?llm:undefined},()=>runtime.store.snapshot().config);
 runtime=createRuntime({directory,now:()=>now,respond,intervalMs:600000,channelFactory:()=>({
  status:()=>({status:'connected'}),statuses:()=>({}),connect:async()=>{},disconnect:async()=>{},close:async()=>{},
  send:async(route,text,options)=>{assert.equal(options.authorize(),true);sent.push({personId:route.personId,peerId:route.peerId,text});return{status:'api_accepted'};},
 })});
 t.after(async()=>{await runtime.close();rmSync(directory,{recursive:true,force:true});});
 for(const[id,role,label]of[['owner','owner','合成联系人'],['mom','elder','合成成员']]){runtime.store.addPerson({id,role,label,timeZone:'Asia/Shanghai'});runtime.store.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id});}
 runtime.store.configure({paused:false,provider:'synthetic',model:'synthetic'});await runtime.start();
 const read=name=>existsSync(join(directory,name))?JSON.parse(readFileSync(join(directory,name),'utf8')):null;
 const business=()=>({reminders:runtime.store.snapshot().reminders,organizer:read('personal-organizer.json'),workbench:read('workbench.json')});
 const receive=(id='hello',text='连接上了吗？[呲牙]')=>runtime.receive('mom',{id,peerId:'peer-mom',text});
 return{runtime,sent,calls,receive,business};
}

for(const[first,second,label]of[
 [malformed,complete({reply,action:null}),'invalid JSON'],
 [truncated,complete(reply),'max-tokens'],
])test(`member ${label} recovers once through the real responder and sends one reply without business effects`,async t=>{
 const f=await fixture(t,[first(),second]),before=f.business();await f.receive();
 assert.equal(f.calls.length,2);assert.deepEqual(f.calls.map(call=>call.tools),[[],[]]);assert.equal(f.calls[0].signal,f.calls[1].signal);
 assert.deepEqual(f.sent,[{personId:'mom',peerId:'peer-mom',text:reply}]);assert.deepEqual(f.business(),before);
 const outbox=f.runtime.store.snapshot().outbox;assert.equal(outbox.length,1);assert.equal(outbox[0].kind,'reply');assert.equal(outbox[0].status,'api_accepted');
});

test('two responder failures send only a human-facing error while keeping a diagnostic internally',async t=>{
 const failure=()=>[{type:'reasoning-delta',index:0,text:'SYNTHETIC_PRIVATE_REASONING'},...complete('{"reply":"SYNTHETIC_SECRET_BODY","action":')];
 const f=await fixture(t,[malformed(),failure()]),before=f.business();await f.receive('twice','咋回事呀');
 assert.equal(f.calls.length,2);assert.deepEqual(f.sent,[{personId:'mom',peerId:'peer-mom',text:failureReply}]);
 assert.doesNotMatch(f.sent[0].text,/JSON|reasoning|SYNTHETIC|模型|格式|完整结束/);assert.ok(f.runtime.status().lastError);assert.notEqual(f.runtime.status().lastError,failureReply);assert.deepEqual(f.business(),before);
 assert.equal(f.runtime.store.snapshot().outbox.length,1);assert.equal(f.runtime.store.snapshot().outbox[0].kind,'error');
});

for(const[text,action,label]of[
 ['明天上午九点提醒我喝水',{type:'remind',text:'喝水',dueAt:'2026-10-27T01:00:00.000Z',repeat:'once',timeEvidence:'明天上午九点'},'reminder'],
 ['帮我记住：合成钥匙在蓝色抽屉',{type:'remember',text:'合成钥匙在蓝色抽屉',evidence:'帮我记住：合成钥匙在蓝色抽屉'},'note'],
 ['以后日报短一点',{type:'preference',patch:{notes:'日报短一点'},evidence:'以后日报短一点'},'preference'],
])test(`answer-only recovery cannot execute a valid ${label} action returned by the second attempt`,async t=>{
 const f=await fixture(t,[malformed(),complete({reply:'已保存并安排',action})]),before=f.business();await f.receive('action-'+label,text);
 assert.equal(f.calls.length,2);assert.deepEqual(f.business(),before);assert.deepEqual(f.sent,[{personId:'mom',peerId:'peer-mom',text:failureReply}]);
});

test('duplicate member inbound does not repeat model recovery or outbound reply',async t=>{
 const f=await fixture(t,[malformed(),complete({reply,action:null})]),before=f.business();
 await f.receive('same-message');await f.receive('same-message');assert.equal(f.calls.length,2);assert.equal(f.sent.length,1);assert.equal(f.sent[0].text,reply);assert.deepEqual(f.business(),before);
});

for(const change of ['pause','rebind'])test(`a ${change} during responder recovery prevents delivery to the old or new binding`,async t=>{
 const entered=deferred(),release=deferred();t.after(()=>release.resolve());
 const f=await fixture(t,[malformed(),async()=>{entered.resolve();await release.promise;return complete({reply,action:null});}]);
 const pending=f.receive('during-'+change);const reached=await Promise.race([entered.promise.then(()=>true),pending.then(()=>false)]);
 assert.equal(reached,true,'a recovery attempt must actually be in flight');
 if(change==='pause')await f.runtime.action({action:'pause'});else f.runtime.store.bindPerson('mom',{accountId:'replacement-account',peerId:'replacement-peer'});
 release.resolve();await pending;assert.equal(f.calls.length,2);assert.deepEqual(f.sent,[]);assert.equal(f.runtime.store.snapshot().outbox.length,0);
});
