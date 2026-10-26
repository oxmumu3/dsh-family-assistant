import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import PptxGenJS from 'pptxgenjs';
import {unzipSync} from 'fflate';
import {createPresentationGenerator} from '../src/presentations.mjs';
import {createPresentationWorkflow} from '../src/presentation-workflow.mjs';
import {createStore} from '../src/store.mjs';

const deck={title:'合成活动汇报',slides:[{title:'活动安排',bullets:['周五在活动室集合。']}]};
const text=value=>({type:'text-delta',index:0,text:value});
const stop={type:'finish',reason:{kind:'stop'}};
const valid=[text(JSON.stringify({reply:'已整理内容。',deck})),stop];
const input={request:'把本人的材料做成一页PPT。',materials:[{name:'材料.txt',text:'周五在活动室集合。'}]};
function generator(steps,{after}={}){
 const calls=[];
 const generate=createPresentationGenerator({get:()=>({async *stream(options){calls.push(options);yield*(steps[calls.length-1]??steps.at(-1));after?.(calls.length);}})},()=>({provider:'deepseek-account',model:'deepseek-flash'}));
 return{generate,calls};
}

test('invalid PPT JSON regenerates once before a single real render under the same controls',async t=>{
 let renders=0;const write=PptxGenJS.prototype.write;PptxGenJS.prototype.write=function(...args){renders++;return write.apply(this,args);};t.after(()=>{PptxGenJS.prototype.write=write;});
 const signal=new AbortController().signal,f=generator([[text('{"reply":"unfinished","deck":'),stop],valid]);
 const result=await f.generate({...input,signal});assert.equal(f.calls.length,2);assert.equal(renders,1);assert.ok(result.bytes.length>1000);assert.match(Buffer.from(unzipSync(result.bytes)['ppt/slides/slide1.xml']).toString(),/周五在活动室集合/);
 for(const call of f.calls){assert.equal(call.signal,signal);assert.deepEqual(call.tools,[]);assert.equal(call.reasoningEffort,'off');assert.equal(call.maxTokens,7000);}
});

for(const [label,end]of [['max-tokens',[{type:'finish',reason:{kind:'max-tokens'}}]],['missing-finish',[]]]){
 test(`PPT ${label} retries pure generation once without salvaging partial JSON`,async()=>{
  const f=generator([[text('{"reply":"partial"'),...end],valid]);const result=await f.generate(input);assert.equal(f.calls.length,2);assert.deepEqual(result.deck,deck);
 });
}

test('PPT cancellation after the first rejected output never starts another model call',async()=>{
 const controller=new AbortController(),f=generator([[text('invalid JSON'),stop],valid],{after:()=>controller.abort()});
 await assert.rejects(()=>f.generate({...input,signal:controller.signal}),/abort/i);assert.equal(f.calls.length,1);
});

test('PPT semantic or protocol failures do not enter generation recovery',async()=>{
 for(const first of [
  [text(JSON.stringify({reply:'草稿',deck,command:'exec'})),stop],
  [text(JSON.stringify({reply:'草稿',deck:{title:'wrong',slides:[]}})),stop],
  [text('partial'),{type:'tool-call-delta',index:1,id:'bad',name:'exec',argumentsDelta:'{}'},stop],
  [text('partial'),{type:'finish',reason:{kind:'max-tokens'}},stop],
  [text('partial'),{type:'finish',reason:{kind:'max-tokens'}},{type:'tool-call-delta',index:1,id:'bad',name:'exec',argumentsDelta:'{}'}],
  [text('partial'),{type:'finish',reason:{kind:'error'}}],
  [text('partial'),{type:'unexpected-protocol-chunk'}],
 ]){const f=generator([first,valid]);await assert.rejects(()=>f.generate(input));assert.equal(f.calls.length,1);}
});

test('two PPT generation failures keep internal diagnostics but show family plain language and create no file',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'family-ppt-generation-failure-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const store=createStore({directory});store.addPerson({id:'mom',role:'elder',label:'合成家人'});store.bindPerson('mom',{accountId:'synthetic-account',peerId:'synthetic-peer'});
 const f=generator([[text('{"deck":'),stop]]);let sends=0;
 const workflow=createPresentationWorkflow({directory,store,defaultEnabled:true,generate:f.generate,extract:()=>{},download:()=>{},send:async()=>{sends++;return{status:'api_accepted'};}});t.after(()=>workflow.close());
 const result=await workflow.handle({person:store.person('mom'),route:store.route('mom'),message:{id:'bad-output',text:'做一页PPT：合成活动'}});
 assert.equal(f.calls.length,2);assert.equal(sends,0);assert.doesNotMatch(result.reply,/JSON|模型|完整结束|字段|schema/i);assert.match(result.reply,/材料|保留|继续|再试/);
 const state=JSON.parse(readFileSync(join(directory,'presentations.json')));assert.equal(state.tasks[0].status,'failed');assert.match(state.tasks[0].errorCode,/^presentation_model_/);assert.equal(state.tasks[0].version,0);assert.equal(existsSync(join(directory,'presentation-files'))?readdirSync(join(directory,'presentation-files')).length:0,0);
 assert.equal(workflow.snapshot().tasks[0].bindingGeneration,1);
});

test('a render failure cannot initiate another model generation',async t=>{
 const write=PptxGenJS.prototype.write;PptxGenJS.prototype.write=async()=>{throw new Error('synthetic rendering failure');};t.after(()=>{PptxGenJS.prototype.write=write;});
 const f=generator([valid]);await assert.rejects(()=>f.generate(input),/synthetic rendering failure/);assert.equal(f.calls.length,1);
});
