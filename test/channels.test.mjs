import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChannelManager } from '../src/channels.mjs';
const next=()=>new Promise(r=>setImmediate(r));
async function until(fn){const deadline=Date.now()+2000;while(Date.now()<deadline){if(fn())return;await new Promise(resolve=>setTimeout(resolve,1));}assert.fail('condition not reached');}
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'family-channels-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const pending=new Map(), sends=[], messages=[], bounds=[];let sequence=0;
 const api={getQr:async()=>({qrcode:`q${++sequence}`,qrUrl:`https://weixin.qq.com/qr${sequence}`}),checkQr:async({qrcode})=>({status:'confirmed',token:`token-${qrcode}`,baseUrl:'https://ilinkai.weixin.qq.com',accountId:`a-${qrcode}`,peerId:`p-${qrcode}`}),
 poll:({token,cursor,signal})=>new Promise((resolve,reject)=>{pending.set(token,{resolve,reject,cursor,signal});signal.addEventListener('abort',()=>{pending.delete(token);reject(new Error('aborted'));},{once:true});}),
 send:async(v)=>{sends.push(v);return {status:'api_accepted'};}};
 const manager=createChannelManager({directory,api,onBound:(personId,b)=>{const route={personId,...b,generation:3};bounds.push(route);return route;},onMessage:async(...m)=>messages.push(m),onStatus:()=>{}});t.after(()=>manager.close());return {directory,api,manager,pending,sends,messages,bounds};
}
test('three accounts isolate login, inbound peers, cursors, context and credentials',async t=>{
 const f=fixture(t);await Promise.all(['owner','one','two'].map(id=>f.manager.login(id)));await until(()=>f.pending.size===3);
 const tokens=[...f.pending.keys()];for(const [i,token] of tokens.entries())f.pending.get(token).resolve({cursor:`cursor${i}`,messages:[{id:`foreign${i}`,peerId:'stranger',text:'wrong',contextToken:'bad'},{id:`group${i}`,peerId:`p-q${i+1}`,groupId:'g',text:'group',contextToken:'bad'},{id:`m${i}`,peerId:`p-q${i+1}`,text:`hello${i}`,contextToken:`ctx${i}`}]});
 await until(()=>f.messages.length===3);for(const r of f.bounds)await f.manager.send(r,'reply',{clientId:'c'});
 assert.equal(f.sends.length,3);for(const [i,s] of f.sends.entries()){assert.equal(s.contextToken,`ctx${i}`);assert.equal(s.peerId,`p-q${i+1}`);}
 for(const [i,id] of ['owner','one','two'].entries()){const file=path.join(f.directory,id,'auth.json');assert.equal(fs.statSync(file).mode&0o777,0o600);const saved=JSON.parse(fs.readFileSync(file));assert.equal(saved.cursor,`cursor${i}`);assert.equal(saved.contextToken,`ctx${i}`);}
 const publicState=JSON.stringify(f.manager.statuses());assert.doesNotMatch(publicState,/token-q|ctx[0-9]|cursor[0-9]/);
 await f.manager.disconnect('one');assert.equal(f.manager.status('one').status,'disconnected');assert.equal(f.manager.status('two').status,'connected');assert.equal(f.pending.size,2);
});
test('send validates exact person account peer and generation without fallback',async t=>{
 const f=fixture(t);await f.manager.login('one');await until(()=>f.bounds.length===1);const r=f.bounds[0];
 for(const wrong of [{...r,peerId:'other'},{...r,accountId:'other'},{...r,generation:4},{...r,personId:'missing'}])await assert.rejects(()=>f.manager.send(wrong,'unsafe'));assert.equal(f.sends.length,0);
 await f.manager.disconnect('one');await assert.rejects(()=>f.manager.send(r,'unsafe'));assert.equal(f.sends.length,0);
});
test('connect restores same route through onBound and checkpoint only follows awaited handler',async t=>{
 const f=fixture(t);let finish;f.api.checkQr=async()=>({status:'confirmed',token:'t',baseUrl:'https://ilinkai.weixin.qq.com',accountId:'a',peerId:'p'});await f.manager.login('one');await until(()=>f.pending.has('t'));await f.manager.disconnect('one');await f.manager.connect('one');await until(()=>f.pending.has('t'));assert.equal(f.bounds.length,2);assert.equal(f.bounds[1].generation,3);
 const another=createChannelManager({directory:f.directory,api:f.api,onBound:(personId,b)=>({personId,...b,generation:3}),onMessage:()=>new Promise(r=>finish=r)});t.after(()=>another.close());await f.manager.disconnect('one');await another.connect('one');f.pending.get('t').resolve({cursor:'next',messages:[{id:'x',peerId:'p',text:'x',contextToken:'ctx'}]});await until(()=>finish);assert.notEqual(JSON.parse(fs.readFileSync(path.join(f.directory,'one','auth.json'))).cursor,'next');finish();await until(()=>JSON.parse(fs.readFileSync(path.join(f.directory,'one','auth.json'))).cursor==='next');
});
test('outbound sends serialize within person and remain concurrent across people',async t=>{
 const f=fixture(t);await Promise.all(['one','two'].map(id=>f.manager.login(id)));await until(()=>f.bounds.length===2);const releases=[];let active=0,max=0;
 f.api.send=v=>new Promise(resolve=>{active++;max=Math.max(max,active);releases.push(()=>{active--;resolve({status:'api_accepted'});});});
 const [a,b]=f.bounds;const p1=f.manager.send(a,'a'),p2=f.manager.send(a,'a2'),p3=f.manager.send(b,'b');await until(()=>releases.length===2);assert.equal(max,2);releases.shift()();releases.shift()();await until(()=>releases.length===1);releases.shift()();await Promise.all([p1,p2,p3]);
});
test('login returns QR before background confirmation and repeated login is isolated',async t=>{
 const f=fixture(t);const waits=[];f.api.checkQr=({signal})=>new Promise((resolve,reject)=>{waits.push(resolve);signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
 const r=await f.manager.login('one');assert.equal(r.phase,'awaiting_scan');assert.match(r.qrUrl,/qr1/);await f.manager.login('two');await f.manager.disconnect('one');assert.equal(f.manager.status('two').phase,'awaiting_scan');assert.equal(f.manager.status('one').status,'disconnected');
});
test('business failure and ambiguous sends propagate no retries or false connected receipt',async t=>{
 const f=fixture(t);await f.manager.login('one');await until(()=>f.bounds.length===1);for(const sendOutcome of ['failed','uncertain']){let count=0;f.api.send=async()=>{count++;throw Object.assign(new Error('secret-token'),{sendOutcome});};await assert.rejects(()=>f.manager.send(f.bounds[0],'x'),e=>e.sendOutcome===sendOutcome);assert.equal(count,1);assert.doesNotMatch(JSON.stringify(f.manager.statuses()),/secret-token/);}
});
test('manual phone verification resumes only with submitted digits and never persists the code',async t=>{
 const f=fixture(t);const codes=[];f.api.checkQr=async({verifyCode})=>{codes.push(verifyCode);return verifyCode?{status:'confirmed',token:'t',baseUrl:'https://ilinkai.weixin.qq.com',accountId:'a',peerId:'p'}:{status:'need_verifycode'};};
 await f.manager.login('one');await until(()=>f.manager.status('one').phase==='need_verification');await assert.rejects(()=>f.manager.submitCode('one','bad'));await f.manager.submitCode('one','1234');await until(()=>f.manager.status('one').connected);assert.deepEqual(codes,[undefined,'1234']);assert.doesNotMatch(fs.readFileSync(path.join(f.directory,'one','auth.json'),'utf8'),/1234/);
});
test('verification challenge expires without keeping close blocked',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'family-expiry-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const manager=createChannelManager({directory,qrTimeoutMs:10,api:{getQr:async()=>({qrcode:'q',qrUrl:'url'}),checkQr:async()=>({status:'need_verifycode'})},onBound:()=>{throw new Error('must not bind');}});t.after(()=>manager.close());await manager.login('one');await new Promise(r=>setTimeout(r,30));assert.equal(manager.status('one').status,'expired');await manager.close();
});
test('successful poll after connection failure permits reply in awaited message handler',async t=>{
 const f=fixture(t);let seen=0;f.api.poll=async({signal})=>{if(seen++===0)throw new Error('temporary');if(seen===2)return {messages:[{id:'m',peerId:'p-q1',text:'hello'}],cursor:'done'};return new Promise((r,j)=>signal.addEventListener('abort',()=>j(new Error('aborted')),{once:true}));};
 const manager=createChannelManager({directory:f.directory,api:f.api,pollRetryMs:1,onBound:(personId,b)=>({personId,...b,generation:1}),onMessage:async()=>manager.send({personId:'one',accountId:'a-q1',peerId:'p-q1',generation:1},'answer')});t.after(()=>manager.close());await manager.login('one');await until(()=>f.sends.length===1);assert.equal(f.sends.length,1);
});
test('concurrent replacement logins for one person cannot start two poll owners',async t=>{
 const f=fixture(t);await Promise.allSettled([f.manager.login('one'),f.manager.login('one')]);await until(()=>f.manager.status('one').connected);assert.equal(f.pending.size,1);assert.equal(f.bounds.length,1);
});
test('Owner authorization is checked again after waiting on the recipient outbound mutex',async t=>{
 const f=fixture(t);await f.manager.login('one');await until(()=>f.bounds.length===1);
 let release,allowed=true,attempts=0;
 f.api.send=()=>{attempts++;return new Promise(resolve=>release=()=>resolve({status:'api_accepted'}));};
 const first=f.manager.send(f.bounds[0],'existing send');await until(()=>release);
 const pending=f.manager.send(f.bounds[0],'Owner requested send',{authorize:()=>allowed});
 allowed=false;release();await first;await assert.rejects(pending,/授权|取消|变化/);assert.equal(attempts,1);
});
