import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';

async function fixture(t,{generate,send}={}){
 const directory=mkdtempSync(join(tmpdir(),'family-ppt-runtime-')),files=[],calls=[],texts=[];
 const runtime=createRuntime({directory,respond:async()=>({reply:'普通聊天'}),
  generatePresentation:generate??(async input=>{calls.push(input);return{deck:{title:'私有汇报',slides:[{title:'活动',bullets:['合成材料']}]},name:'汇报.pptx',bytes:Buffer.from('pptx')};}),
  extractMaterial:({name,bytes})=>({name,text:bytes.toString()}),
  planWorkbench:async()=>({reply:'请核对',operation:{type:'plan',actions:[{type:'presentation_service',personId:'mom',enabled:true}]}}),
  channelFactory:()=>({async connect(){},async disconnect(){},async close(){},status:()=>({status:'connected'}),
   async send(r,text){texts.push({r,text});return{status:'api_accepted'};},
   async downloadFile(_r,a){return{name:a.name,bytes:Buffer.from('合成活动材料')};},
   async sendFile(r,file,opts){assert(opts.authorize());files.push({r,...file});if(send)return send();return{status:'api_accepted'};}})});
 t.after(async()=>{await runtime.close();rmSync(directory,{recursive:true,force:true});});
 for(const[id,role]of[['owner','owner'],['mom','elder'],['dad','elder']]){runtime.store.addPerson({id,role,label:id==='mom'?'妈妈':id==='dad'?'爸爸':id});runtime.store.bindPerson(id,{accountId:'a-'+id,peerId:'p-'+id});}
 await runtime.start();
 return{runtime,files,calls,texts,async enable(){const s=await runtime.action({action:'owner_chat',text:'给妈妈开通PPT',requestId:'enable'});const c=s.serviceSetup.find(row=>row.status==='ready');assert(c);return runtime.action({action:'service_confirm',draftId:c.id,revision:c.revision,requestId:'enable-confirm'});}};
}
test('confirmed Owner service enables only mom; attachment intake through runtime produces a file and revision',async t=>{
 const f=await fixture(t);await f.enable();assert.equal(f.runtime.status().presentations.people.find(p=>p.personId==='mom').enabled,true);
 await f.runtime.receive('mom',{id:'file',peerId:'p-mom',text:'',attachments:[{kind:'file',name:'材料.txt'}]});assert.equal(f.calls.length,0);
 await f.runtime.receive('mom',{id:'make',peerId:'p-mom',text:'做成PPT'});await f.runtime.settled();assert.equal(f.files.length,1);assert.equal(f.files[0].r.personId,'mom');assert.equal(f.calls[0].materials[0].text,'合成活动材料');
 await f.runtime.receive('mom',{id:'revise',peerId:'p-mom',text:'第一页再短一点'});await f.runtime.settled();assert.equal(f.files.length,2);assert(f.calls[1].previous);
 await f.runtime.receive('dad',{id:'make',peerId:'p-dad',text:'做成PPT'});assert.equal(f.files.length,2);
 assert.doesNotMatch(JSON.stringify(f.runtime.status()),/私有汇报|合成活动材料/);
});
test('elder cannot grant self service through chat and stale route cannot send',async t=>{
 let release;const gate=new Promise(r=>release=r);const f=await fixture(t,{generate:async()=>{await gate;return{deck:{title:'活动',slides:[]},name:'d.pptx',bytes:Buffer.from('x')};}});
 await f.runtime.receive('dad',{id:'grant',peerId:'p-dad',text:'给我开通PPT'});assert.equal(f.runtime.status().presentations.people.find(p=>p.personId==='dad').enabled,false);
 await f.enable();const pending=f.runtime.receive('mom',{id:'make',peerId:'p-mom',text:'做PPT：合成活动'});await new Promise(r=>setImmediate(r));f.runtime.store.bindPerson('mom',{accountId:'a-new',peerId:'p-new'});release();await pending;await f.runtime.settled();assert.equal(f.files.length,0);
});
test('cancel arrives while generator runs and does not wait for model completion to abort',async t=>{
 let started;const ready=new Promise(r=>started=r);let aborted=false;
 const f=await fixture(t,{generate:async({signal})=>{started();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));}});await f.enable();
 const pending=f.runtime.receive('mom',{id:'make',peerId:'p-mom',text:'做PPT：合成活动'});await ready;
 const cancel=f.runtime.receive('mom',{id:'stop',peerId:'p-mom',text:'取消PPT'});await Promise.all([pending,cancel]);await f.runtime.settled();assert(aborted);assert.equal(f.files.length,0);assert.equal(f.runtime.status().presentations.tasks[0].status,'cancelled');
});

test('inbound callback returns while PPT model runs so the real channel can poll a later cancellation',async t=>{
 let start,release;const ready=new Promise(r=>start=r),gate=new Promise(r=>release=r);
 const f=await fixture(t,{generate:async()=>{start();await gate;return{deck:{title:'活动',slides:[]},name:'d.pptx',bytes:Buffer.from('x')};}});await f.enable();
 let admitted=false;const incoming=f.runtime.receive('mom',{id:'long',peerId:'p-mom',text:'做PPT：合成活动'}).then(()=>admitted=true);await ready;
 try{await new Promise(r=>setImmediate(r));assert.equal(admitted,true,'poll loop must not wait for the entire model call');}finally{release();await incoming;await f.runtime.settled?.();}
});

test('replayed old cancellation cannot cancel a later task',async t=>{
 const f=await fixture(t);await f.enable();
 await f.runtime.receive('mom',{id:'first',peerId:'p-mom',text:'做PPT：第一份'});await f.runtime.settled?.();
 await f.runtime.receive('mom',{id:'old-cancel',peerId:'p-mom',text:'取消PPT'});await f.runtime.settled?.();
 await f.runtime.receive('mom',{id:'second',peerId:'p-mom',text:'新做一份PPT：第二份'});await f.runtime.settled?.();
 const before=f.runtime.status().presentations.tasks.at(-1).status;
 const result=await f.runtime.receive('mom',{id:'old-cancel',peerId:'p-mom',text:'取消PPT'});
 assert.equal(result.accepted,false);assert.equal(before,'api_accepted');assert.equal(f.runtime.status().presentations.tasks.at(-1).status,before);
});
