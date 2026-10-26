import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostResponder} from '../src/model.mjs';

const input={person:{id:'synthetic-member',label:'测试家人',timeZone:'Asia/Shanghai',interests:[]},history:[],text:'连接上了吗？[呲牙]',now:'2026-10-26T06:00:00Z'};
const text=value=>({type:'text-delta',index:0,text:value});
const stop={type:'finish',reason:{kind:'stop'}};
function fixture(attempts,config={provider:'deepseek-account',model:'deepseek-flash'}){
 const calls=[];
 const respond=createHostResponder({get:()=>({async *stream(options){calls.push(options);yield* attempts[Math.min(calls.length-1,attempts.length-1)];}})},()=>config);
 return{respond,calls};
}

test('short official DeepSeek replies explicitly disable default high reasoning and reserve answer budget',async()=>{
 const{respond,calls}=fixture([[text('{"reply":"连接上了，我收到你的消息了。","action":null}'),stop]]);
 assert.equal((await respond(input)).reply,'连接上了，我收到你的消息了。');
 assert.equal(calls[0].reasoningEffort,'off');assert(calls[0].maxTokens>=3200);assert.deepEqual(calls[0].tools,[]);
});

test('a completed non-JSON chat response recovers once as answer-only without repairing an action',async()=>{
 const controller=new AbortController();const{respond,calls}=fixture([[text('plain output instead of JSON'),stop],[text('连接上了，我收到你的消息了。'),stop]]);
 const result=await respond({...input,signal:controller.signal});
 assert.deepEqual(result,{reply:'连接上了，我收到你的消息了。'});assert.equal(calls.length,2);
 assert.equal(calls[1].signal,controller.signal);assert.deepEqual(calls[1].tools,[]);
 assert.match(calls[1].system,/不.*执行|仅.*回复|只.*聊天/);assert.match(calls[1].system,/action.*null|操作.*禁止/);
 assert(calls[1].system.length<calls[0].system.length);assert.equal(calls[1].reasoningEffort,'off');
});

test('truncated and reasoning-only generations are discarded before one conversational recovery',async()=>{
 for(const initial of [
  [text('{"reply":"已设置提醒","action":{"type":"remind"'),{type:'finish',reason:{kind:'max-tokens'}}],
  [{type:'reasoning-delta',index:0,text:'PRIVATE_REASONING'},stop],
  [text('{"reply":"已设置提醒","action":')],
 ]){
  const{respond,calls}=fixture([initial,[text('刚才没能回复好，你的消息已经收到。'),stop]]);
  assert.deepEqual(await respond(input),{reply:'刚才没能回复好，你的消息已经收到。'});assert.equal(calls.length,2);
  assert.doesNotMatch(JSON.stringify(calls[1]),/PRIVATE_REASONING|已设置提醒/);
 }
});

test('recovery accepts valid action-null envelopes but rejects executable actions and false completion claims',async()=>{
 const initial=[text('invalid JSON'),stop];
 const ok=fixture([initial,[text('{"reply":"我在的，你可以继续说。","action":null}'),stop]]);
 assert.deepEqual(await ok.respond({...input,text:'咋回事呀'}),{reply:'我在的，你可以继续说。'});
 for(const reply of [
  JSON.stringify({reply:'已经办好',action:{type:'preference',patch:{notes:'wrong'},evidence:'咋回事呀'}}),
  '{"reply":"我在","action":',
  '已为你设置明天的提醒。',
  '我记住了，明天会提醒你。',
  '"reply":"您好","action":null',
  '["您好"]',
  '{"reply":"您好"}',
  '```text\n您好\n```',
  '提醒设置好了，明早八点叫你。',
 ]){
  const{respond,calls}=fixture([initial,[text(reply),stop]]);
  await assert.rejects(()=>respond(input));assert.equal(calls.length,2);
 }
});

test('invalid action schemas and hostile stream protocols do not enter a recovery attempt',async()=>{
 for(const chunks of [
  [text('{"reply":"待处理","action":{"type":"remember","text":"bad"}}'),stop],
  [text('{"reply":"您好","action":null}'),{type:'tool-call-delta',index:1,id:'bad',name:'exec',argumentsDelta:'{}'},stop],
  [stop,text('late')],
  [text('hidden'),{type:'finish',reason:{kind:'error'}}],
  [text('partial'),{type:'finish',reason:{kind:'max-tokens'}},{type:'tool-call-delta',index:1,id:'bad',name:'exec',argumentsDelta:'{}'}],
  [text('partial'),{type:'finish',reason:{kind:'max-tokens'}},stop],
 ]){
  const{respond,calls}=fixture([chunks,[text('must not run'),stop]]);
  await assert.rejects(()=>respond(input));assert.equal(calls.length,1);
 }
});

test('cancellation between attempts cannot initiate a recovery request',async()=>{
 const controller=new AbortController();let calls=0;
 const respond=createHostResponder({get:()=>({async *stream(){calls++;yield text('bad JSON');yield stop;controller.abort();}})},()=>({provider:'deepseek-account',model:'deepseek-flash'}));
 await assert.rejects(()=>respond({...input,signal:controller.signal}),/abort/i);assert.equal(calls,1);
});

test('unknown model providers keep their own reasoning controls',async()=>{
 const{respond,calls}=fixture([[text('{"reply":"您好","action":null}'),stop]],{provider:'custom-provider',model:'custom-model'});
 await respond(input);assert.equal(calls[0].reasoningEffort,undefined);
});
