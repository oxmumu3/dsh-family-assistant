import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHarnessPlan,createHostHarnessPlanner} from '../src/harness-planner.mjs';
const context={text:'让家庭资料项目整理这份材料',person:{id:'owner',role:'owner'},projects:[{workspaceId:'family',title:'家庭资料'}],targets:[{personId:'mom',label:'妈妈',tools:['ai_digest']}]};
const plan=operation=>JSON.stringify({reply:'交给执行层核对。',operation});
test('native task selects an existing explicit project and preserves the original instruction',()=>{
 const result=parseHarnessPlan(plan({type:'native_task',workspaceId:'family'}),context);assert.deepEqual(result.operation,{type:'native_task',workspaceId:'family'});
 assert.throws(()=>parseHarnessPlan(plan({type:'native_task',workspaceId:'private'}),context));
 assert.throws(()=>parseHarnessPlan(plan({type:'native_task',workspaceId:'family',prompt:'forged'}),context));
});
test('tool recipients and IDs are grounded in the current user request and assigned catalogue',()=>{
 const c={...context,text:'给妈妈发今天的 AI 精选日报'};
 assert.equal(parseHarnessPlan(plan({type:'invoke_tool',personId:'mom',toolId:'ai_digest'}),c).operation.personId,'mom');
 assert.throws(()=>parseHarnessPlan(plan({type:'invoke_tool',personId:'mom',toolId:'shell'}),c));
 assert.throws(()=>parseHarnessPlan(plan({type:'invoke_tool',personId:'mom',toolId:'ai_digest'}),context));
});
test('family cannot target another person and planning never widens the provided scope',()=>{
 const c={...context,text:'给妈妈发日报',person:{id:'dad',role:'elder'}};
 assert.throws(()=>parseHarnessPlan(plan({type:'invoke_tool',personId:'mom',toolId:'ai_digest'}),c));
 assert.throws(()=>parseHarnessPlan(plan({type:'grant',personId:'mom'}),context));
});
test('no-action replies cannot claim execution and workflow requests need explicit evidence',()=>{
 assert.throws(()=>parseHarnessPlan(JSON.stringify({reply:'已发送',operation:null}),context));
 assert.throws(()=>parseHarnessPlan(plan({type:'workflow_request'}),context));
 assert.equal(parseHarnessPlan(plan({type:'workflow_request'}),{...context,text:'我想申请一个旅行工具'}).operation.type,'workflow_request');
});
test('Host planner has no tools, filters context, requires a completed text response, and does not leak stream errors',async()=>{
 let request;
 const ctx={get:()=>({async *stream(value){request=value;yield{type:'text-delta',index:0,text:plan({type:'native_task',workspaceId:'family'})};yield{type:'finish',reason:'stop'};}})};
 const result=await createHostHarnessPlanner(ctx,()=>({provider:'test',model:'test'}))({...context,projects:[{...context.projects[0],path:'/private',sessionIds:['secret']}],now:'2026-10-25T00:00:00Z'});
 assert.equal(result.operation.workspaceId,'family');assert.deepEqual(request.tools,[]);assert.doesNotMatch(JSON.stringify(request),/\/private|secret/);
 const bad=createHostHarnessPlanner({get:()=>({async *stream(){yield{type:'text-delta',index:0,text:plan(null)};throw Error('private-token');}})},()=>({provider:'test',model:'test'}));
 await assert.rejects(()=>bad(context),error=>!error.message.includes('private-token'));
});

test('natural task continuation and cancellation only select current-person task IDs with explicit evidence',()=>{
 const tasks=[{id:'task-mom',personId:'mom',origin:'wechat',workspaceTitle:'家庭资料',state:'succeeded'}],c={text:'再短一点',person:{id:'mom',role:'elder'},origin:'wechat',projects:[],targets:[],tasks};
 assert.equal(parseHarnessPlan(plan({type:'continue_task',taskId:'task-mom'}),c).operation.type,'continue_task');
 assert.equal(parseHarnessPlan(plan({type:'cancel_task',taskId:'task-mom'}),{...c,text:'停止刚才那件任务'}).operation.type,'cancel_task');
 for(const operation of [{type:'continue_task',taskId:'dad-task'},{type:'continue_task'},{type:'cancel_task',taskId:'task-mom'}])assert.throws(()=>parseHarnessPlan(plan(operation),c));
 assert.throws(()=>parseHarnessPlan(plan({type:'continue_task',taskId:'task-mom'}),{...c,text:'你好'}));
 assert.throws(()=>parseHarnessPlan(plan({type:'continue_task',taskId:'task-mom'}),{...c,tasks:[{...tasks[0],personId:'dad'}]}));
});

test('Owner native project delivery selects only one explicitly named registered recipient without requiring tool grants',()=>{
 const c={...context,text:'请用家庭资料项目给妈妈写一份文稿，并发给妈妈',targets:[{personId:'mom',label:'妈妈',tools:[]},{personId:'dad',label:'爸爸',tools:[]}]};
 const operation={type:'native_task',workspaceId:'family',recipientPersonId:'mom'};assert.equal(parseHarnessPlan(plan(operation),c).operation.recipientPersonId,'mom');
 assert.throws(()=>parseHarnessPlan(plan({...operation,recipientPersonId:'dad'}),c));assert.throws(()=>parseHarnessPlan(plan(operation),{...c,text:'妈妈说家庭资料项目不错，帮我查一下'}));
 assert.throws(()=>parseHarnessPlan(plan(operation),{...c,text:'用家庭资料项目写稿，不要发给妈妈'}));assert.throws(()=>parseHarnessPlan(plan(operation),{...c,person:{id:'dad',role:'elder'}}));
 assert.throws(()=>parseHarnessPlan(plan(operation),{...c,text:'用家庭资料项目写稿，发给妈妈和爸爸'}));
});
test('recipient aliases are bounded trusted context and raw route fields never enter a planner operation',()=>{
 const c={...context,text:'请用家庭资料项目给我爸写一份稿子',targets:[{personId:'dad',label:'爸爸',aliases:['我爸','父亲'],tools:[]}]};const operation={type:'native_task',workspaceId:'family',recipientPersonId:'dad'};assert.equal(parseHarnessPlan(plan(operation),c).operation.recipientPersonId,'dad');assert.throws(()=>parseHarnessPlan(plan({...operation,deliveryTarget:{personId:'dad',route:{peerId:'forged'}}}),c));
});
