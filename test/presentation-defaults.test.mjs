import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {unzipSync} from 'fflate';
import {createStore} from '../src/store.mjs';
import {createPresentationWorkflow} from '../src/presentation-workflow.mjs';
import {createPresentationGenerator,extractPresentationMaterial,renderPresentation} from '../src/presentations.mjs';

async function fixture(t,{defaultEnabled=true,generate}={}){
 const directory=mkdtempSync(join(tmpdir(),'family-ppt-default-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const store=createStore({directory});for(const id of ['mom','dad']){store.addPerson({id,role:'elder',label:id});store.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id});}
 const sent=[],calls=[];
 const generator=generate??createPresentationGenerator({get:()=>({async *stream(options){calls.push(options);const payload=JSON.parse(options.messages[0].content[0].text);const output=payload.previous?{reply:'已修改内容。',changes:[{index:1,slide:{title:'下一步',bullets:['周末整理照片。']}}]}:{reply:'内容已整理。',deck:{title:'合成家庭活动',slides:[{title:'活动安排',bullets:[payload.materials[0]?.text??'周五在活动室集合。']},{title:'下一步',bullets:['请核对活动安排。']}]}};yield{type:'text-delta',index:0,text:JSON.stringify(output)};yield{type:'finish',reason:{kind:'stop'}};}})},()=>({provider:'deepseek-account',model:'deepseek-flash'}));
 const config={directory,store,defaultEnabled,generate:generator,extract:extractPresentationMaterial,download:async(_route,attachment)=>({name:attachment.name,bytes:Buffer.from(attachment.content)}),send:async(route,file,options)=>{assert.equal(options.authorize(),true);sent.push({route,file});return{status:'api_accepted'};}};
 const workflow=createPresentationWorkflow(config);t.after(()=>workflow.close());
 const run=(personId,text,id,attachments=[])=>workflow.handle({person:store.person(personId),route:store.route(personId),message:{id,text,attachments}});
 return{directory,store,workflow,config,run,sent,calls};
}

test('default-enabled family PPT collects own material, renders actual PPTX and revises the same task once',async t=>{
 const f=await fixture(t);assert.equal(f.workflow.snapshot().people.find(p=>p.personId==='mom').enabled,true);
 const intake=await f.run('mom','','own-material',[{name:'活动.txt',content:'周五在活动室集合。'}]);assert.match(intake.reply,/材料/);assert.equal(f.calls.length,0);
 const first=await f.run('mom','把刚才材料做成两页PPT','first-deck');assert.equal(first.handled,true);assert.equal(f.sent.length,1);assert.equal(f.sent[0].route.personId,'mom');
 const initialZip=unzipSync(f.sent[0].file.bytes),slide1=Buffer.from(initialZip['ppt/slides/slide1.xml']).toString();assert.match(slide1,/周五在活动室集合/);assert.ok(f.sent[0].file.bytes.length>1000);assert.equal(f.calls[0].reasoningEffort,'off');
 await f.run('mom','第二页改成周末整理照片','revise-deck');assert.equal(f.sent.length,2);const revised=unzipSync(f.sent[1].file.bytes);assert.equal(Buffer.from(revised['ppt/slides/slide1.xml']).toString(),slide1);assert.match(Buffer.from(revised['ppt/slides/slide2.xml']).toString(),/周末整理照片/);
 await f.run('mom','第二页改成周末整理照片','revise-deck');assert.equal(f.sent.length,2);assert.equal(f.workflow.snapshot().tasks.length,1);assert.equal(f.workflow.snapshot().tasks[0].version,2);
 assert.deepEqual(JSON.parse(readFileSync(join(f.directory,'presentations.json'))).services,{},'Using the default does not manufacture an Owner opt-in');
 await f.run('dad','做一份PPT：另一个人的活动','dad-deck');const dadPayload=JSON.parse(f.calls.at(-1).messages[0].content[0].text);assert.deepEqual(dadPayload.materials,[]);assert.equal(dadPayload.previous,undefined);assert.doesNotMatch(JSON.stringify(dadPayload),/周五在活动室|周末整理照片/);
});

test('explicit Owner disable overrides default-enabled PPT and survives restart',async t=>{
 const f=await fixture(t);f.workflow.configure('mom',false);assert.equal((await f.run('mom','帮我做PPT','disabled')).handled,false);f.workflow.close();
 const restored=createPresentationWorkflow(f.config);t.after(()=>restored.close());assert.equal(restored.snapshot().people.find(p=>p.personId==='mom').enabled,false);assert.equal(restored.snapshot().people.find(p=>p.personId==='dad').enabled,true);
 assert.equal((await restored.handle({person:f.store.person('mom'),route:f.store.route('mom'),message:{id:'still-disabled',text:'做PPT'}})).handled,false);assert.equal(f.sent.length,0);
});

test('an explicit disable while the capability is already default-off persists before a later default upgrade',async t=>{
 const f=await fixture(t,{defaultEnabled:false});f.workflow.configure('mom',false);const path=join(f.directory,'presentations.json');assert.equal(existsSync(path),true,'An explicit Owner disable must be durable');assert.equal(JSON.parse(readFileSync(path)).services.mom.enabled,false);f.workflow.close();
 const upgraded=createPresentationWorkflow({...f.config,defaultEnabled:true});t.after(()=>upgraded.close());assert.equal(upgraded.snapshot().people.find(p=>p.personId==='mom').enabled,false);assert.equal(upgraded.snapshot().people.find(p=>p.personId==='dad').enabled,true);
});

test('disabling a default-enabled in-flight generation preserves the existing dispatch guard',async t=>{
 let release;const wait=new Promise(resolve=>release=resolve);const f=await fixture(t,{generate:async()=>{await wait;return{deck:{title:'合成活动',slides:[{title:'安排',bullets:['仅供合成验证。']}]},...await renderPresentation({title:'合成活动',slides:[{title:'安排',bullets:['仅供合成验证。']}]})};}});
 const pending=f.run('mom','做PPT：合成活动','inflight');await new Promise(resolve=>setImmediate(resolve));f.workflow.configure('mom',false);release();await pending;assert.equal(f.sent.length,0);assert.equal(f.workflow.snapshot().tasks.length,1);assert.equal(f.workflow.snapshot().tasks[0].status,'cancelled');
});

test('PPT model generation disables verified DeepSeek thinking without changing its budget or custom providers',async()=>{
 for(const config of [{provider:'deepseek-account',model:'deepseek-flash'},{provider:'deepseek-official',model:'deepseek-pro'},{provider:'custom',model:'deepseek-flash'}]){
  let captured;const signal=new AbortController().signal;
  const generate=createPresentationGenerator({get:()=>({async *stream(options){captured=options;yield{type:'text-delta',index:0,text:'{"reply":"请提供活动材料。","needsInput":true}'};yield{type:'finish',reason:{kind:'stop'}};}})},()=>config);
  await generate({request:'请帮我做PPT',signal});assert.equal(captured.reasoningEffort,config.provider==='custom'?undefined:'off');assert.equal(captured.maxTokens,7000);assert.deepEqual(captured.tools,[]);assert.equal(captured.signal,signal);
 }
});
