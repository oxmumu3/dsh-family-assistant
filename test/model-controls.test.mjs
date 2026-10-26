import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostWorkbenchPlanner} from '../src/workbench-model.mjs';
import {createHostOwnerPlanner} from '../src/owner-commands.mjs';
import {createHostHarnessPlanner} from '../src/harness-planner.mjs';

const now='2026-10-26T06:12:17Z';
const owner={id:'owner',role:'owner',label:'我',timeZone:'Asia/Shanghai'};
const people=[owner,{id:'mom',role:'elder',label:'妈妈',timeZone:'Asia/Shanghai'}];
const planners=[
 {name:'workbench',create:createHostWorkbenchPlanner,budget:3500,output:{reply:'请补充你的想法。',operation:null},input:{text:'给妈妈发日报',people,cards:[],requests:[],history:[],now}},
 {name:'owner',create:createHostOwnerPlanner,budget:1200,output:{reply:'请补充你的想法。',action:null},input:{owner,text:'给妈妈发日报',people,now}},
 {name:'harness',create:createHostHarnessPlanner,budget:1000,output:{reply:'请补充你的想法。',operation:null},input:{text:'查一下家庭项目',person:owner,projects:[],targets:[],tasks:[],now}},
];

for(const planner of planners){
 for(const provider of ['deepseek-account','deepseek-official']){
  for(const model of ['deepseek-flash','deepseek-pro']){
   test(`${planner.name} disables thinking for verified ${provider}/${model} structured planning`,async()=>{
    let captured;
    const signal=new AbortController().signal;
    const llm={async *stream(options){captured=options;yield{type:'text-delta',index:0,text:JSON.stringify(planner.output)};yield{type:'finish',reason:{kind:'stop'}};}};
    await planner.create({get:()=>llm},()=>({provider,model}))({...planner.input,signal});
    assert.equal(captured.reasoningEffort,'off');
    assert.equal(captured.provider,provider);assert.equal(captured.model,model);
    assert.equal(captured.maxTokens,planner.budget);assert.deepEqual(captured.tools,[]);assert.equal(captured.signal,signal);
   });
  }
 }
 test(`${planner.name} leaves custom provider and unverified model reasoning controls unchanged`,async()=>{
  for(const config of [{provider:'custom',model:'deepseek-flash'},{provider:'deepseek-account',model:'custom-model'}]){
   let captured;
   const llm={async *stream(options){captured=options;yield{type:'text-delta',index:0,text:JSON.stringify(planner.output)};yield{type:'finish',reason:{kind:'stop'}};}};
   await planner.create({get:()=>llm},()=>config)(planner.input);
   assert.equal(Object.hasOwn(captured,'reasoningEffort'),false);
   assert.equal(captured.maxTokens,planner.budget);assert.deepEqual(captured.tools,[]);
  }
 });
}
