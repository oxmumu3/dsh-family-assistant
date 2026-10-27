import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMemberAgent} from '../src/member-agent.mjs';

const tool=(args,id='help-1')=>[{type:'block-end',index:0,block:{type:'tool-call',id,name:'request_owner_help',arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}];
const done=text=>[{type:'text-delta',index:0,text},{type:'finish',reason:{kind:'stop'}}];
function fixture(t,steps){
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'lele-help-grounding-'))),calls=[],sent=[];
 const agent=createMemberAgent({directory,llm:{async *stream(options){calls.push(options);const step=steps[calls.length-1];yield* typeof step==='function'?step(options):step;}},readConfig:()=>({provider:'synthetic',model:'fixture'})});
 t.after(async()=>{await agent.close();rmSync(directory,{recursive:true,force:true});});
 const input={person:{id:'member',role:'elder',createdAt:'2026-10-26T00:00:00Z'},route:{personId:'member',accountId:'synthetic-account',peerId:'synthetic-peer',generation:1},text:'请帮我问孩子周六有没有空去取资料。',requestId:'synthetic-help',authorize:async()=>true,requestOwnerHelp:async args=>{sent.push(args);return{status:'pending',id:'synthetic-case'};}};
 return{agent,input,calls,sent};
}
const bad={text:'请孩子周六取文件',evidence:'请联系孩子安排周六取文件',reason:'需要家人帮助'},good={text:'周六有没有空去取资料',evidence:'请帮我问孩子周六有没有空去取资料',reason:'需要家人帮助'};

test('a paraphrased Owner-help proposal can correct its quote once before any effect',async t=>{
 const f=fixture(t,[tool(bad),options=>{assert.equal(f.sent.length,0);const reply=options.messages.at(-1);assert.equal(reply.isError,true);assert.equal(JSON.parse(reply.content[0].text).status,'needs_correction');return tool(good,'help-corrected');},done('已记下这次求助。')]);
 const result=await f.agent.run(f.input);assert.equal(result.state,'succeeded');assert.equal(f.sent.length,1);assert.equal(f.sent[0].text,good.text);assert.equal(f.calls.length,3);
 await f.agent.run(f.input);assert.equal(f.sent.length,1);assert.equal(f.calls.length,3);
});
test('Owner-help quote correction has one bounded attempt',async t=>{
 const f=fixture(t,[tool(bad),tool(bad,'invalid-again')]);const result=await f.agent.run(f.input);assert.equal(result.state,'failed');assert.equal(f.sent.length,0);assert.equal(f.calls.length,2);
 assert.doesNotMatch(result.text,/已有文件|投递状态已保留|自动跟进/);
});
for(const text of ['不要联系孩子，只帮我整理周六的计划。','这件事先保密，请帮我问孩子周六有没有空。','比如请帮我问孩子周六有没有空。','“请帮我问孩子周六有没有空”'])test('no quote-correction round may override private or hypothetical text: '+text,async t=>{
 const f=fixture(t,[tool(bad)]);const result=await f.agent.run({...f.input,text});assert.equal(result.state,'failed');assert.equal(f.calls.length,1);assert.equal(f.sent.length,0);
});
test('a callback failure or uncertain effect is never repaired as a new quote proposal',async t=>{
 const f=fixture(t,[tool(good)]);let effects=0;const result=await f.agent.run({...f.input,requestOwnerHelp:async()=>{effects++;throw Object.assign(Error('synthetic uncertain effect'),{code:'member_agent_ungrounded_request'});}});
 assert.equal(result.state,'failed');assert.equal(effects,1);assert.equal(f.calls.length,1);
 assert.doesNotMatch(result.text,/已有文件|投递状态已保留|自动跟进/);assert.match(result.text,/可以继续补充/);
});
