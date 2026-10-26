import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const waitFor=async(check)=>{for(let n=0;n<100;n++){if(check())return;await tick();}assert.fail('synthetic condition was not reached');};

test('a file preparation does not prevent the real channel from receiving a later cancellation',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'family-review-cancel-download-'));let runtime,firstPage,releaseDownload,downloadSignal,polls=0,files=0;
 const api={getQr:async()=>({qrcode:'synthetic',qrUrl:'https://weixin.qq.com/synthetic'}),checkQr:async()=>({status:'confirmed',token:'synthetic-token',baseUrl:'https://ilinkai.weixin.qq.com',accountId:'synthetic-account',peerId:'synthetic-peer'}),
  poll:async({signal})=>{polls++;if(polls===1)return new Promise(resolve=>firstPage=resolve);if(polls===2)return{messages:[{id:'stop',peerId:'synthetic-peer',text:'取消PPT'}],cursor:'after-stop'};return new Promise((resolve,reject)=>{if(signal.aborted)return reject(signal.reason);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});},
  downloadFile:async({signal})=>{downloadSignal=signal;await new Promise((resolve,reject)=>{releaseDownload=resolve;if(signal.aborted)return reject(signal.reason);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});return{name:'synthetic.txt',bytes:Buffer.from('Synthetic member-only material')};},
  send:async()=>({status:'api_accepted'}),sendFile:async()=>{files++;return{status:'api_accepted'};}};
 runtime=createRuntime({directory,api,respond:async()=>({reply:'ordinary'}),generatePresentation:async()=>({deck:{title:'Synthetic deck',slides:[]},name:'deck.pptx',bytes:Buffer.from('synthetic-deck')}),extractMaterial:({name,bytes})=>({name,text:bytes.toString()}),
  planWorkbench:async()=>({reply:'enable',operation:{type:'plan',actions:[{type:'presentation_service',personId:'member',enabled:true}]}})});
 t.after(async()=>{releaseDownload?.();await runtime.close();rmSync(directory,{recursive:true,force:true});});
 runtime.store.addPerson({id:'owner',role:'owner',label:'Owner'});runtime.store.addPerson({id:'member',role:'elder',label:'Synthetic'});
 await runtime.action({action:'login',personId:'member'});await waitFor(()=>firstPage);
 const view=await runtime.action({action:'owner_chat',text:'给Synthetic开通PPT',requestId:'enable'}),card=view.serviceSetup.find(row=>row.status==='ready');assert(card);await runtime.action({action:'service_confirm',draftId:card.id,revision:card.revision,requestId:'enable-confirm'});await runtime.start();
 firstPage({messages:[{id:'make',peerId:'synthetic-peer',text:'做个PPT：合成材料',attachments:[{kind:'file',name:'synthetic.txt'}]}],cursor:'after-make'});await waitFor(()=>downloadSignal);
 for(let n=0;n<20;n++)await tick();
 assert.equal(polls>=2,true,'file preparation must allow polling the later cancel message');
 assert.equal(downloadSignal.aborted,true,'validated cancel must abort the in-flight file download');
 assert.equal(files,0);
});

// Exercise the real upload/send adapter with synthetic fetch responses: an
// abort after sendmessage starts is uncertain and survives a restart.
test('shutdown during actual file message submission persists uncertainty and does not resubmit on restart',async t=>{
 const {createStore}=await import('../src/store.mjs');
 const {createPresentationWorkflow}=await import('../src/presentation-workflow.mjs');
 const {createWeixinApi}=await import('../src/weixin.mjs');
 const directory=mkdtempSync(join(tmpdir(),'family-review-shutdown-send-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const store=createStore({directory});store.addPerson({id:'member',role:'elder',label:'Synthetic'});store.bindPerson('member',{accountId:'synthetic-account',peerId:'synthetic-peer'});
 let submissions=0,submissionSignal;
 const api=createWeixinApi({fetchImpl:async(url,options)=>{
  if(url.endsWith('/getuploadurl'))return new Response(JSON.stringify({ret:0,upload_param:'synthetic-upload'}));
  if(url.includes('/c2c/upload'))return new Response('',{headers:{'x-encrypted-param':'synthetic-download'}});
  assert(url.endsWith('/sendmessage'));submissions++;submissionSignal=options.signal;
  return new Promise((resolve,reject)=>{if(options.signal.aborted)return reject(options.signal.reason);options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
 }});
 const config={directory,store,generate:async()=>({deck:{title:'Synthetic deck',slides:[]},bytes:Buffer.from('synthetic-deck'),name:'deck.pptx'}),extract:()=>{},download:()=>{},send:async(route,file,options)=>api.sendFile({token:'synthetic-token',baseUrl:'https://ilinkai.weixin.qq.com',peerId:route.peerId,...file,...options})};
 const workflow=createPresentationWorkflow(config);workflow.configure('member',true);
 const message={id:'make',text:'做个PPT：合成活动'},context={person:store.person('member'),route:store.route('member')};
 const pending=workflow.handle({...context,message});await waitFor(()=>submissionSignal);workflow.close();await pending;
 assert.equal(submissionSignal.aborted,true);assert.equal(workflow.snapshot().tasks[0].status,'uncertain');assert.equal(submissions,1);
 const restored=createPresentationWorkflow(config);
 assert.equal(restored.snapshot().tasks[0].status,'uncertain');
 const response=await restored.handle({...context,message:{id:'continue',text:'继续'}});
 assert.match(response.reply,/核对|确认/);assert.equal(submissions,1);restored.close();
});

test('deferred attachment descriptors survive restart privately and resume only on the same route',async t=>{
 const {readFileSync}=await import('node:fs');
 const {createStore}=await import('../src/store.mjs');
 const {createPresentationWorkflow}=await import('../src/presentation-workflow.mjs');
 const directory=mkdtempSync(join(tmpdir(),'family-review-durable-download-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const store=createStore({directory});for(const id of ['mom','dad']){store.addPerson({id,role:'elder',label:id});store.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id});}
 const attachment={kind:'file',name:'synthetic.txt',media:{aes_key:'synthetic-private-key',encrypt_query_param:'synthetic-private-query'}};
 const downloads=[],generations=[],sends=[];
 const config={directory,store,generate:async input=>{generations.push(input);return{deck:{title:'Synthetic deck',slides:[]},bytes:Buffer.from('synthetic-deck'),name:'deck.pptx'};},extract:({name,bytes})=>({name,text:bytes.toString()}),download:async(route,a)=>{downloads.push({route,a});return{name:a.name,bytes:Buffer.from('Synthetic private material')};},send:async(route)=>{sends.push(route);return{status:'api_accepted'};}};
 const first=createPresentationWorkflow(config);first.configure('mom',true);first.configure('dad',true);
 const prepared=await first.handle({person:store.person('mom'),route:store.route('mom'),message:{id:'material',text:'请把材料做成三页PPT',attachments:[attachment]},defer:true});
 assert.equal(typeof prepared.run,'function');assert.equal(downloads.length,0,'return to the poll loop before downloading');
 const raw=readFileSync(join(directory,'presentations.json'),'utf8');assert.match(raw,/synthetic-private-key/);assert.match(raw,/请把材料做成三页/);assert.doesNotMatch(JSON.stringify(first.snapshot()),/synthetic-private-key|synthetic-private-query|请把材料/);
 first.close();const restored=createPresentationWorkflow(config);assert.equal(restored.snapshot().tasks[0].status,'interrupted');assert.equal(downloads.length,0);assert.equal(sends.length,0);
 const foreign=await restored.handle({person:store.person('dad'),route:store.route('dad'),message:{id:'foreign-resume',text:'继续上一份PPT'}});assert.match(foreign.reply,/没有|找不到/);assert.equal(downloads.length,0);
 await restored.handle({person:store.person('mom'),route:store.route('mom'),message:{id:'resume',text:'继续'}});
 assert.equal(downloads.length,1);assert.equal(downloads[0].route.personId,'mom');assert.equal(generations.length,1);assert.match(generations[0].request,/请把材料做成三页/);assert.equal(generations[0].materials[0].text,'Synthetic private material');assert.equal(sends.length,1);
 assert.doesNotMatch(readFileSync(join(directory,'presentations.json'),'utf8'),/synthetic-private-key|synthetic-private-query/);restored.close();
});

test('a replaced binding cannot recover the previous route pending attachment',async t=>{
 const {createStore}=await import('../src/store.mjs'),{createPresentationWorkflow}=await import('../src/presentation-workflow.mjs');
 const directory=mkdtempSync(join(tmpdir(),'family-review-rebound-download-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const store=createStore({directory});store.addPerson({id:'mom',role:'elder',label:'Synthetic'});store.bindPerson('mom',{accountId:'old-account',peerId:'old-peer'});
 let downloads=0;const config={directory,store,generate:()=>assert.fail('no generation'),extract:()=>{},send:()=>assert.fail('no send'),download:()=>{downloads++;assert.fail('no download');}};
 const before=createPresentationWorkflow(config);before.configure('mom',true);await before.handle({person:store.person('mom'),route:store.route('mom'),message:{id:'old-file',text:'做PPT：合成材料',attachments:[{name:'old.txt'}]},defer:true});before.close();
 store.bindPerson('mom',{accountId:'new-account',peerId:'new-peer'});const after=createPresentationWorkflow(config);
 const response=await after.handle({person:store.person('mom'),route:store.route('mom'),message:{id:'continue',text:'继续上一份PPT'}});
 assert.match(response.reply,/没有|找不到/);assert.equal(downloads,0);after.close();
});

test('a rejected material descriptor is discarded so a replacement file can continue the task',async t=>{
 const {createStore}=await import('../src/store.mjs'),{createPresentationWorkflow}=await import('../src/presentation-workflow.mjs');
 const directory=mkdtempSync(join(tmpdir(),'family-review-rejected-material-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const store=createStore({directory});store.addPerson({id:'mom',role:'elder',label:'Synthetic'});store.bindPerson('mom',{accountId:'account',peerId:'peer'});
 let sent=0;const downloads=[];
 const workflow=createPresentationWorkflow({directory,store,generate:async input=>{assert.equal(input.materials[0].text,'valid replacement');return{deck:{title:'Synthetic',slides:[]},bytes:Buffer.from('ppt'),name:'deck.pptx'};},extract:({name,bytes})=>{if(name==='bad.docx')throw new Error('文件损坏，请另存后重试。');return{name,text:bytes.toString()};},download:async(route,a)=>{downloads.push(a.name);return{name:a.name,bytes:Buffer.from(a.name==='bad.docx'?'corrupted':'valid replacement')};},send:async()=>{sent++;return{status:'api_accepted'};}});workflow.configure('mom',true);
 const context={person:store.person('mom'),route:store.route('mom')};await workflow.handle({...context,message:{id:'bad',text:'做个PPT：活动',attachments:[{name:'bad.docx'}]}});
 await workflow.handle({...context,message:{id:'good',text:'',attachments:[{name:'good.txt'}]}});
 assert.deepEqual(downloads,['bad.docx','good.txt']);assert.equal(sent,1);workflow.close();
});
