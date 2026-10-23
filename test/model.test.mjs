import test from 'node:test';
import assert from 'node:assert/strict';
import {parseModelReply} from '../src/model.mjs';

test('host model request carries only current person history and no general tools',async()=>{
  const {createHostResponder}=await import('../src/model.mjs');
  let captured;
  const llm={async *stream(options){captured=options;yield{type:'text-delta',index:0,text:'{"reply":"您好","action":null}'};yield{type:'finish',reason:'stop'};}};
  const respond=createHostResponder({get:()=>llm},()=>({provider:'test',model:'test'}));
  const result=await respond({person:{id:'dad',label:'爸爸',timeZone:'Asia/Shanghai',interests:['历史']},history:[],reminders:[],text:'你好',now:new Date().toISOString(),signal:new AbortController().signal});
  assert.equal(result.reply,'您好');assert.deepEqual(captured.tools,[]);
  assert.equal(captured.provider,'test');assert.match(captured.system,/历史/);
});

test('malformed or truncated model action is never executed',async()=>{
  const {parseModelReply}=await import('../src/model.mjs');
  assert.throws(()=>parseModelReply('{"reply":"好了","action":{"type":"remind"'),/格式|JSON|模型/);
  assert.throws(()=>parseModelReply('{"reply":"好了","action":{"type":"remind","text":"hi","dueAt":"tomorrow","personId":"mom"}}'),/参数|模型|字段/);
});

test('active reminders remain visible after many completed historical reminders',async()=>{
  const{createHostResponder}=await import('../src/model.mjs');let captured;
  const llm={async *stream(options){captured=options;yield{type:'text-delta',index:0,text:'{"reply":"您好","action":null}'};yield{type:'finish',reason:{kind:'stop'}};}};
  const respond=createHostResponder({get:()=>llm},()=>({provider:'test',model:'test'}));
  const reminders=Array.from({length:60},(_,i)=>({id:`old${i}`,personId:'dad',status:'completed',text:'旧事项'}));
  reminders.push({id:'current',personId:'dad',status:'active',text:'散步',dueAt:'2026-10-23T12:00:00Z'});
  await respond({person:{id:'dad',label:'爸爸',timeZone:'Asia/Shanghai',interests:[]},history:[],reminders,text:'取消散步提醒',now:'2026-10-22T00:00:00Z'});
  const payload=JSON.parse(captured.messages[0].content[0].text);
  assert.equal(payload.reminders.length,1);assert.equal(payload.reminders[0].id,'current');
});

test('text delta and block end assemble once while reasoning remains private',async()=>{
  const{createHostResponder}=await import('../src/model.mjs');
  const llm={async *stream(){yield{type:'reasoning-delta',index:0,text:'private reasoning'};yield{type:'text-delta',index:1,text:'{"reply":"您好"'};yield{type:'block-end',index:1,block:{type:'text',text:'{"reply":"您好","action":null}'}};yield{type:'finish',reason:{kind:'stop'}};}};
  const respond=createHostResponder({get:()=>llm},()=>({provider:'test',model:'test'}));
  assert.equal((await respond({person:{id:'dad',label:'爸爸',timeZone:'Asia/Shanghai',interests:[]},text:'你好',now:new Date().toISOString()})).reply,'您好');
});

test('personal model allows scoped relay/preferences and rejects recipient or sharing escalation',()=>{
 const relay=parseModelReply(JSON.stringify({reply:'请稍等',action:{type:'relay',text:'周六几点来看我',evidence:'帮我转告'}}));assert.equal(relay.action.type,'relay');
 assert.throws(()=>parseModelReply(JSON.stringify({reply:'请稍等',action:{type:'relay',text:'周六几点',evidence:'帮我转告',personId:'other'}})));
 assert.throws(()=>parseModelReply(JSON.stringify({reply:'记住了',action:{type:'preference',patch:{shareWithOwner:'full'},evidence:'同意'}})));
 const preference=parseModelReply(JSON.stringify({reply:'准备更新',action:{type:'preference',patch:{notes:'日报短一点'},evidence:'以后短一点'}}));assert.equal(preference.action.patch.notes,'日报短一点');
});

const personInput={person:{id:'dad',label:'爸爸',timeZone:'Asia/Shanghai',interests:[]},text:'帮我转告，周六来吗？',now:'2026-10-23T00:00:00Z'};
const relayChunk={type:'text-delta',index:0,text:JSON.stringify({reply:'待转告。',action:{type:'relay',text:'周六来吗？',evidence:'帮我转告，周六来吗？'}})};
async function streamResult(chunks,input=personInput){
  const {createHostResponder}=await import('../src/model.mjs');
  return createHostResponder({get:()=>({async *stream(){yield* chunks;}})},()=>({provider:'test',model:'test'}))(input);
}

test('personal action rejects tool output even if a text proposal and stop are present',async()=>{
  for(const tool of [{type:'tool-call-delta',index:1,id:'tool_1',name:'exec',argumentsDelta:'{}'},{type:'block-start',index:1,blockType:'tool-call'},{type:'block-end',index:1,block:{type:'tool-call',name:'exec',arguments:{}}}])await assert.rejects(()=>streamResult([relayChunk,tool,{type:'finish',reason:'stop'}]),/工具|模型|异常/);
});

test('personal action requires exactly one successful terminal finish after all content',async()=>{
  for(const chunks of [[relayChunk],[relayChunk,{type:'finish',reason:{kind:'error'}},{type:'finish',reason:'stop'}],[{type:'finish',reason:'stop'},relayChunk],[relayChunk,{type:'finish',reason:'stop'},{type:'finish',reason:'stop'}],[relayChunk,{type:'error',error:'PRIVATE_TOKEN'},{type:'finish',reason:'stop'}]])await assert.rejects(()=>streamResult(chunks),/完整|结束|模型|异常/);
  assert.equal((await streamResult([relayChunk,{type:'finish',reason:{kind:'stop'}},{type:'usage',usage:{}}])).action.type,'relay');
});

test('personal provider exceptions are sanitized and aborted requests never start',async()=>{
  const {createHostResponder}=await import('../src/model.mjs');let calls=0;
  const respond=createHostResponder({get:()=>({async *stream(){calls++;yield relayChunk;throw new Error('PRIVATE_PROVIDER_SECRET');}})},()=>({provider:'test',model:'test'}));
  await assert.rejects(()=>respond(personInput),error=>{assert.doesNotMatch(error.message,/PRIVATE_PROVIDER_SECRET/);assert.match(error.message,/模型/);return true;});
  const controller=new AbortController();controller.abort();await assert.rejects(()=>respond({...personInput,signal:controller.signal}),/abort/i);assert.equal(calls,1);
});

test('relay prompt binds consent to the selected quote and names only the known owner contact',async()=>{
  const {createHostResponder}=await import('../src/model.mjs');let captured;
  const respond=createHostResponder({get:()=>({async *stream(options){captured=options;yield relayChunk;yield{type:'finish',reason:'stop'};}})},()=>({provider:'test',model:'test'}));
  await respond({...personInput,ownerContact:{id:'owner',label:'小林',notes:'PRIVATE_OWNER_NOTES',binding:{peerId:'PRIVATE_OWNER_PEER'}}});
  const payload=JSON.parse(captured.messages[0].content[0].text);
  assert.deepEqual(payload.ownerContact,{label:'小林'});assert.doesNotMatch(JSON.stringify(captured),/PRIVATE_OWNER/);
  assert.match(captured.system,/evidence.*(?:同时|包含).*text|evidence.*转告指令.*事项/);
  assert.match(captured.system,/指定.*(?:其他|别的).*(?:询问|澄清|核对)|(?:其他|别的).*指定.*(?:询问|澄清|核对)/);
});
