import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChannelManager } from '../src/channels.mjs';
const until=async(fn)=>{const end=Date.now()+2000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,1));}assert.fail('condition not reached');};
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'family-files-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));let poll;const received=[],routes=[];
 const api={getQr:async()=>({qrcode:'q',qrUrl:'qr'}),checkQr:async()=>({status:'confirmed',token:'secret',baseUrl:'https://ilinkai.weixin.qq.com',accountId:'account',peerId:'peer'}),poll:({signal})=>new Promise((resolve,reject)=>{poll=resolve;signal.addEventListener('abort',()=>reject(new Error('abort')),{once:true});}),downloadFile:async()=>({name:'a.txt',bytes:Buffer.from('data')}),send:async()=>({status:'api_accepted'}),sendFile:async()=>({status:'api_accepted'})};
 const manager=createChannelManager({directory,api,onBound:(personId,b)=>{const route={personId,...b,generation:1};routes.push(route);return route;},onMessage:async(...v)=>received.push(v)});t.after(()=>manager.close());return {api,manager,received,routes,get poll(){return poll;}};
}
test('file descriptors enter handlers only after peer/account validation',async t=>{
 const f=fixture(t);await f.manager.login('mom');await until(()=>f.poll);const attachments=[{kind:'file',name:'a.txt',media:{aes_key:'key'}}];
 f.poll({cursor:'next',messages:[{id:'foreign',peerId:'other',attachments},{id:'wrong-account',peerId:'peer',accountId:'other',attachments},{id:'ok',peerId:'peer',accountId:'account',attachments}]});await until(()=>f.received.length);assert.equal(f.received.length,1);assert.deepEqual(f.received[0][1].attachments,attachments);
});
test('download validates route and authorization before and after receiving bytes',async t=>{
 const f=fixture(t);await f.manager.login('mom');await until(()=>f.routes.length);let calls=0,release,allowed=true;f.api.downloadFile=()=>{calls++;return new Promise(r=>release=r);};const route=f.routes[0];
 await assert.rejects(()=>f.manager.downloadFile({...route,generation:9},{kind:'file'}));assert.equal(calls,0);
 const pending=f.manager.downloadFile(route,{kind:'file'},{authorize:()=>allowed});await until(()=>release);allowed=false;release({name:'a.txt',bytes:Buffer.from('data')});await assert.rejects(pending);assert.equal(calls,1);
});
test('file sends share text outbound mutex and recheck permission while upload is in progress',async t=>{
 const f=fixture(t);assert.equal(typeof f.manager.sendFile,'function');await f.manager.login('mom');await until(()=>f.routes.length);let firstRelease,fileRelease,allowed=true,fileCalls=0;
 f.api.send=()=>new Promise(r=>firstRelease=()=>r({status:'api_accepted'}));f.api.sendFile=async options=>{fileCalls++;await new Promise(r=>fileRelease=r);if(!options.authorize())throw Object.assign(new Error('revoked'),{sendOutcome:'failed'});return{status:'api_accepted'};};
 const route=f.routes[0],first=f.manager.send(route,'text'),second=f.manager.sendFile(route,{name:'a.pptx',bytes:Buffer.from('file')},{authorize:()=>allowed});await until(()=>firstRelease);assert.equal(fileCalls,0);firstRelease();await first;await until(()=>fileRelease);allowed=false;fileRelease();await assert.rejects(second,e=>e.sendOutcome==='failed');assert.equal(fileCalls,1);
});
test('channel rejects oversized file buffers before queuing the transport',async t=>{
 const f=fixture(t);await f.manager.login('mom');await until(()=>f.routes.length);let sent=0;f.api.sendFile=async()=>{sent++;return{status:'api_accepted'};};
 await assert.rejects(()=>f.manager.sendFile(f.routes[0],{name:'large.pptx',bytes:Buffer.alloc(10*1024*1024+1)}),e=>e.sendOutcome==='failed');assert.equal(sent,0);
});
