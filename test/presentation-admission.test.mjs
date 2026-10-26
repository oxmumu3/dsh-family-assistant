import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';
import {createRuntime} from '../src/runtime.mjs';
import {createPresentationWorkflow} from '../src/presentation-workflow.mjs';

const output=()=>({deck:{title:'Synthetic private deck',slides:[]},bytes:Buffer.from('fake-deck'),name:'deck.pptx'});
test('a crash after inbound dedup but before attachment preparation safely replays only unfinished admission',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'family-admission-'));let runtime;
 t.after(async()=>{await runtime?.close();rmSync(directory,{recursive:true,force:true});});
 const store=createStore({directory});store.addPerson({id:'member',role:'elder',label:'Synthetic'});store.bindPerson('member',{accountId:'a',peerId:'p'});
 const before=createPresentationWorkflow({directory,store,generate:()=>{},extract:()=>{},download:()=>{},send:()=>{}});before.configure('member',true);
 const message={id:'crashed-input',peerId:'p',text:'把材料做成一页PPT',attachments:[{name:'material.txt'}]};
 before.admit({person:store.person('member'),route:store.route('member'),message});
 store.recordInbound('member',{id:message.id,peerId:message.peerId,text:message.text});before.close();
 let generated=0,downloaded=0,sent=0;
 runtime=createRuntime({directory,generatePresentation:async input=>{generated++;assert.equal(input.materials[0].text,'Recovered material');return output();},extractMaterial:({name,bytes})=>({name,text:bytes.toString()}),
  channelFactory:()=>({connect:async()=>{},disconnect:async()=>{},close:async()=>{},status:()=>({status:'connected'}),send:async()=>({status:'api_accepted'}),
   downloadFile:async()=>{downloaded++;return{name:'material.txt',bytes:Buffer.from('Recovered material')};},sendFile:async()=>{sent++;return{status:'api_accepted'};}})});
 await runtime.start();assert.equal((await runtime.receive('member',message)).accepted,true);await runtime.settled();
 assert.equal(generated,1);assert.equal(downloaded,1);assert.equal(sent,1);
 assert.equal((await runtime.receive('member',message)).accepted,false);await runtime.settled();assert.equal(sent,1);assert.equal(downloaded,1);
 assert.doesNotMatch(JSON.stringify(runtime.status()),/Recovered material|Synthetic private deck/);
});

test('the real channel polls a cancellation while a previously admitted model task is running',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'family-channel-cancel-'));let runtime,firstPage;
 t.after(async()=>{await runtime?.close();rmSync(directory,{recursive:true,force:true});});
 let markStarted,markCancelled;const started=new Promise(r=>markStarted=r),cancelled=new Promise(r=>markCancelled=r);
 let polls=0,files=0;
 const api={getQr:async()=>({qrcode:'synthetic',qrUrl:'https://weixin.qq.com/synthetic'}),checkQr:async()=>({status:'confirmed',token:'synthetic-token',baseUrl:'https://ilinkai.weixin.qq.com',accountId:'a',peerId:'p'}),
  poll:async({signal})=>{polls++;if(polls===1)return new Promise(resolve=>firstPage=resolve);if(polls===2){await started;return{messages:[{id:'stop',peerId:'p',text:'取消PPT'}],cursor:'after-stop'};}return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},
  send:async()=>({status:'api_accepted'}),downloadFile:async()=>assert.fail('no material download expected'),sendFile:async()=>{files++;return{status:'api_accepted'};}};
 runtime=createRuntime({directory,api,respond:async()=>({reply:'ordinary'}),generatePresentation:async({signal})=>{markStarted();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{markCancelled();reject(signal.reason);},{once:true}));},extractMaterial:()=>{},
  planWorkbench:async()=>({reply:'enable',operation:{type:'plan',actions:[{type:'presentation_service',personId:'member',enabled:true}]}})});
 runtime.store.addPerson({id:'owner',role:'owner',label:'Owner'});runtime.store.addPerson({id:'member',role:'elder',label:'Synthetic'});
 await runtime.action({action:'login',personId:'member'});
 while(!firstPage)await new Promise(r=>setImmediate(r));
 const view=await runtime.action({action:'owner_chat',text:'给Synthetic开通PPT',requestId:'enable'}),card=view.serviceSetup.find(row=>row.status==='ready');assert(card);await runtime.action({action:'service_confirm',draftId:card.id,revision:card.revision,requestId:'enable-confirm'});await runtime.start();
 firstPage({messages:[{id:'make',peerId:'p',text:'做个PPT：合成材料'}],cursor:'after-make'});
 await Promise.race([cancelled,new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Cancellation never reached the running model')),15000);cancelled.finally(()=>clearTimeout(timeout));})]);
 await runtime.settled();assert.equal(files,0);assert.equal(runtime.status().presentations.tasks[0].status,'cancelled');assert(polls>=2);
});
