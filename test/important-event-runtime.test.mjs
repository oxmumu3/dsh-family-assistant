import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';

const classified=(input,patch={})=>({decision:'notify',urgency:'soon',category:'needs_help',relatedIncidentId:null,subject:'self',eventState:'current',evidence:[{messageId:input.message.id,quote:input.message.text}],clarificationKind:null,...patch});
async function fixture(t,options={}){
 const directory=mkdtempSync(join(tmpdir(),'lele-attention-runtime-')),sent=[],calls=[],connections=new Map();let clock='2026-10-26T10:00:00.000Z';
 const runtime=createRuntime({directory,now:()=>clock,intervalMs:60000,respond:options.respond??(async()=>({reply:'收到，我在。'})),classifyImportantEvent:async input=>{calls.push(input);return options.classify?options.classify(input):classified(input);},channelFactory:()=>({connect:async()=>{},disconnect:async()=>{},close:async()=>{},statuses:()=>({}),status:id=>({status:connections.get(id)??'connected'}),send:async(route,text)=>{sent.push({route,text});return{status:'api_accepted'};}})});
 for(const[id,role,label]of[['owner','owner','我'],['mom','elder','妈妈'],['dad','elder','爸爸']]){runtime.store.addPerson({id,role,label,shareWithOwner:'none'});runtime.store.bindPerson(id,{accountId:'bot-'+id,peerId:'wx-'+id});}
 await runtime.start();t.after(async()=>{await runtime.close();rmSync(directory,{recursive:true,force:true});});
 return{runtime,sent,calls,connections,advance:()=>clock=new Date(Date.parse(clock)+1000).toISOString(),receive:async(text,id='m1',personId='mom')=>{await runtime.receive(personId,{id,peerId:'wx-'+personId,text,at:clock});await runtime.settled();}};
}
test('important observation is off until explicitly enabled and does not backfill existing history',async t=>{
 const f=await fixture(t);await f.receive('之前有件事需要帮忙');assert.equal(f.calls.length,0);
 await f.runtime.action({action:'attention_configure',enabled:true});await f.runtime.tick();await f.runtime.settled();assert.equal(f.calls.length,0);assert.equal(f.runtime.status().attention.enabled,true);
 f.advance();await f.receive('现在有件事需要帮忙','m2');assert.equal(f.calls.length,1);assert.equal(f.sent.filter(x=>x.route.personId==='owner').length,1);
});
test('new family inbound is assessed with only its own bounded history, independent of brief sharing',async t=>{
 const f=await fixture(t);await f.receive('爸爸的旧话','d1','dad');await f.runtime.action({action:'attention_configure',enabled:true});f.advance();await f.receive('我需要你帮我处理一件事');
 assert.equal(f.calls[0].message.id,'m1');assert.equal(f.calls[0].member.id,'mom');assert(!JSON.stringify(f.calls[0]).includes('爸爸的旧话'));
 const alerts=f.sent.filter(x=>x.route.personId==='owner');assert.equal(alerts.length,1);assert.match(alerts[0].text,/妈妈|需要/);assert(f.sent.some(x=>x.route.personId==='mom'&&x.text==='收到，我在。'));
 assert.equal(f.runtime.status().attention.incidents.length,1);await f.receive('我需要你帮我处理一件事');assert.equal(f.calls.length,1);
});
test('classification failure never changes the normal family reply into a JSON error',async t=>{
 const f=await fixture(t,{classify:async()=>{throw Error('important_event_classification_invalid');}});await f.runtime.action({action:'attention_configure',enabled:true});f.advance();await f.receive('你好');
 assert.equal(f.sent.filter(x=>x.route.personId==='owner').length,0);assert.equal(f.sent.filter(x=>x.route.personId==='mom').length,1);assert.equal(f.sent[0].text,'收到，我在。');assert.equal(f.runtime.status().lastError,null);
 assert.match(f.runtime.status().attention.lastError,/判断|分类|完成/);
});
test('Owner can acknowledge the actual latest alert in WeChat without opening the console',async t=>{
 const f=await fixture(t);await f.runtime.action({action:'attention_configure',enabled:true});f.advance();await f.receive('我需要一起帮忙');f.advance();await f.receive('我来处理','o1','owner');
 assert.equal(f.runtime.status().attention.incidents[0].status,'acknowledged');assert.match(f.sent.at(-1).text,/已记|你来处理/);assert.equal(f.sent.filter(x=>x.route.personId==='mom'&&x.text.includes('转达')).length,0);
 f.advance();await f.receive('已解决','o2','owner');assert.equal(f.runtime.status().attention.incidents[0].status,'resolved');
});
test('Owner contextual message is sent to the alert member once and later unrelated context cannot reuse it',async t=>{
 const f=await fixture(t);await f.runtime.action({action:'attention_configure',enabled:true});f.advance();await f.receive('这件事我一个人办不了');f.advance();await f.receive('告诉她：我晚上帮你处理','o1','owner');
 const direct=f.sent.filter(x=>x.route.personId==='mom'&&x.text.includes('我晚上帮你处理'));assert.equal(direct.length,1);assert.match(direct[0].text,/转达/);await f.receive('告诉她：我晚上帮你处理','o1','owner');assert.equal(f.sent.filter(x=>x.route.personId==='mom'&&x.text.includes('我晚上帮你处理')).length,1);
 f.advance();await f.receive('另一个话题','o2','owner');f.advance();await f.receive('已解决','o3','owner');assert.notEqual(f.runtime.status().attention.incidents[0].status,'resolved');
});
test('disabled observation and changed binding revoke pending classification without a send',async t=>{
 let release;const gate=new Promise(done=>release=done);const f=await fixture(t,{classify:async input=>{await gate;return classified(input);}});await f.runtime.action({action:'attention_configure',enabled:true});f.advance();await f.runtime.receive('mom',{id:'m1',peerId:'wx-mom',text:'需要帮忙'});await new Promise(setImmediate);await f.runtime.action({action:'attention_configure',enabled:false});f.runtime.store.bindPerson('mom',{accountId:'replacement',peerId:'new-peer'});release();await f.runtime.settled();assert.equal(f.sent.filter(x=>x.route.personId==='owner').length,0);
});
test('one natural clarification stays in the family conversation and does not alert Owner',async t=>{
 const f=await fixture(t,{classify:async input=>classified(input,{decision:'clarify',subject:'unclear',eventState:'unclear',clarificationKind:'current_or_quote'})});await f.runtime.action({action:'attention_configure',enabled:true});f.advance();await f.receive('刚才说的那个事');assert.equal(f.sent.filter(x=>x.route.personId==='owner').length,0);assert(f.sent.some(x=>/还是转发/.test(x.text)));assert.equal(f.runtime.status().attention.incidents.length,0);
});
test('a disconnected Owner queues an alert and the unchanged binding receives it once after reconnect',async t=>{
 const f=await fixture(t);await f.runtime.action({action:'attention_configure',enabled:true});f.connections.set('owner','disconnected');f.advance();await f.receive('窗口这件事我一个人办不了');assert.equal(f.sent.filter(x=>x.route.personId==='owner').length,0);assert.equal(f.runtime.status().outbox.filter(row=>row.kind==='important_event'&&row.status==='pending').length,1);
 await f.runtime.tick();assert.equal(f.sent.filter(x=>x.route.personId==='owner').length,0);f.connections.set('owner','connected');await f.runtime.tick();await f.runtime.tick();assert.equal(f.sent.filter(x=>x.route.personId==='owner').length,1);
});
test('a pending alert for an old binding is cancelled instead of being forwarded to a replacement Owner',async t=>{
 const f=await fixture(t);await f.runtime.action({action:'attention_configure',enabled:true});f.connections.set('owner','disconnected');f.advance();await f.receive('有件事要帮忙');f.runtime.store.bindPerson('owner',{accountId:'replacement',peerId:'replacement'});f.connections.set('owner','connected');await f.runtime.tick();assert.equal(f.sent.filter(x=>x.route.personId==='owner').length,0);assert.equal(f.runtime.status().attention.enabled,false);
});
test('the Owner can operate the independent alert toggle directly in WeChat and config stays unchanged',async t=>{
 const f=await fixture(t),before=f.runtime.store.snapshot().config;f.advance();await f.receive('开启重要事项主动提醒','o1','owner');assert.equal(f.runtime.status().attention.enabled,true);f.advance();await f.receive('关闭重要事项主动提醒','o2','owner');assert.equal(f.runtime.status().attention.enabled,false);assert.deepEqual(f.runtime.store.snapshot().config,before);
});
test('a slow background observation does not delay the normal family reply',async t=>{
 let release;const gate=new Promise(done=>release=done),f=await fixture(t,{classify:async input=>{await gate;return classified(input);}});await f.runtime.action({action:'attention_configure',enabled:true});f.advance();const response=f.runtime.receive('mom',{id:'slow',peerId:'wx-mom',text:'有件事需要一起帮忙'});await response;assert(f.sent.some(x=>x.route.personId==='mom'&&x.text==='收到，我在。'));assert.equal(f.sent.filter(x=>x.route.personId==='owner').length,0);release();await f.runtime.settled();assert.equal(f.sent.filter(x=>x.route.personId==='owner').length,1);
});
test('sensitive strings are masked in both classifier current text and prior family context',async t=>{
 const f=await fixture(t);await f.receive('密码：private-example 账号123456789012345678','old');await f.runtime.action({action:'attention_configure',enabled:true});f.advance();await f.receive('我需要帮忙，token=secret-example','new');const context=JSON.stringify(f.calls[0]);assert.doesNotMatch(context,/private-example|123456789012345678|secret-example/);assert.doesNotMatch(f.sent.find(x=>x.route.personId==='owner').text,/secret-example/);
});
test('unavailable semantic classification is visible and never fabricates an automatic judgment from keywords',async t=>{
 const f=await fixture(t,{classify:async()=>{throw Error('unavailable');}});await f.runtime.action({action:'attention_configure',enabled:true});f.advance();await f.receive('我现在喘不过气了，一个人在家，需要马上有人来帮我');assert.equal(f.sent.filter(x=>x.route.personId==='owner').length,0);assert.match(f.runtime.status().attention.lastError,/判断|分类|完成/);assert(f.sent.some(x=>x.route.personId==='mom'&&x.text==='收到，我在。'));
});
test('classifier failure cannot turn a forwarded or historical danger passage into a fallback alert',async t=>{
 const f=await fixture(t,{classify:async()=>{throw Error('unavailable');}});await f.runtime.action({action:'attention_configure',enabled:true});f.advance();await f.receive('昨天的记录：\n我现在喘不过气了','old-danger');f.advance();await f.receive('转发新闻：\n我现在喘不过气了','news-danger');assert.equal(f.sent.filter(x=>x.route.personId==='owner').length,0);
});
test('natural secret expressions are hidden before classification and automatic notification',async t=>{
 const f=await fixture(t);await f.runtime.action({action:'attention_configure',enabled:true});f.advance();await f.receive('我需要帮忙，验证码是834291，密码是SYNTHETIC_PASSWORD_27');assert.doesNotMatch(JSON.stringify(f.calls),/834291|SYNTHETIC_PASSWORD_27/);assert.doesNotMatch(f.sent.find(x=>x.route.personId==='owner').text,/834291|SYNTHETIC_PASSWORD_27/);
});
test('an explicit relay uses its established notice rather than producing a second automatic alert',async t=>{
 const text='请帮我转告家人：明早需要有人陪我去办事',f=await fixture(t,{respond:async()=>({reply:'已记录',action:{type:'relay',evidence:text,text:'明早需要有人陪我去办事'}})});await f.runtime.action({action:'attention_configure',enabled:true});f.advance();await f.receive(text,'relay');assert.equal(f.sent.filter(row=>row.route.personId==='owner').length,1);assert.equal(f.runtime.status().outbox.filter(row=>row.kind==='family_request').length,1);assert.equal(f.calls.length,0);
});
test('a quoted relay phrase does not bypass observation of an otherwise important family message',async t=>{
 const f=await fixture(t);await f.runtime.action({action:'attention_configure',enabled:true});f.advance();await f.receive('我这件事需要家里帮忙，材料里那句“请帮我转告家人”是引用');assert.equal(f.calls.length,1);assert.equal(f.sent.filter(row=>row.route.personId==='owner').length,1);
});
