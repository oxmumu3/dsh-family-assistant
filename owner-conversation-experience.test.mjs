import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';

async function fixture(t,{initial={state:'succeeded',text:'可以。直接告诉我发给谁、发什么就好。'}}={}){
 const directory=mkdtempSync(join(tmpdir(),'lele-owner-experience-'));let time=Date.parse('2026-10-26T10:00:00Z'),result=initial;
 const sent=[],starts=[];
 const runtime=createRuntime({directory,now:()=>new Date(time).toISOString(),intervalMs:1000000,
  ownerAgent:{ensureControlWorkspace:async()=>({workspaceId:'control',title:'乐乐',path:'/synthetic/control'}),listWorkspaces:async()=>[{workspaceId:'control',title:'乐乐',path:'/synthetic/control'}],start:async intent=>{starts.push(intent);if(result instanceof Error)throw result;return result;},observe:async()=>{if(result instanceof Error)throw result;return result;}},
  ownerTaskArtifacts:{collect:async()=>[]},
  channelFactory:()=>({status:()=>({status:'connected'}),connect:async()=>{},disconnect:async()=>{},close:async()=>{},send:async(route,text,options)=>{assert.equal(options.authorize(),true);sent.push({personId:route.personId,text});return{status:'api_accepted'};}}),
 });
 t.after(async()=>{await runtime.close();rmSync(directory,{recursive:true,force:true});});
 for(const[id,role,label]of[['owner','owner','我'],['k','elder','K']]){runtime.store.addPerson({id,role,label,shareWithOwner:'none'});runtime.store.bindPerson(id,{accountId:'fake-'+id,peerId:'peer-'+id});}
 await runtime.start();
 return{runtime,sent,starts,set:v=>{result=v;},advance:ms=>{time+=ms;},send:async(text,id='message')=>{await runtime.receive('owner',{id,peerId:'peer-owner',text});await runtime.settled();}};
}

test('a quick Owner question returns only the actual answer without implementation announcements',async t=>{
 const f=await fixture(t);await f.send('我可以在微信里让你帮家人办事吗？');
 assert.deepEqual(f.sent,[{personId:'owner',text:'可以。直接告诉我发给谁、发什么就好。'}]);
});
test('native replies reach Owner without waiting for the general 15-second scheduler',async t=>{
 const f=await fixture(t,{initial:{state:'queued'}});await f.send('我现在能让你做什么？');
 f.set({state:'succeeded',text:'直接告诉我想办什么就好。'});
 const deadline=Date.now()+2500;while(!f.sent.length&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
 assert.deepEqual(f.sent,[{personId:'owner',text:'直接告诉我想办什么就好。'}]);
});
test('slow Owner work gets one relevant waiting message and then the result in the same chat',async t=>{
 const f=await fixture(t,{initial:{state:'queued'}});await f.send('找到本机最新的AI日报，先给我看');
 assert.equal(f.sent.length,0);f.advance(20000);await f.runtime.tick();
 assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/查找.*日报/);assert.doesNotMatch(f.sent[0].text,/原生|Harness|任务结果/);
 await f.runtime.tick();assert.equal(f.sent.length,1);
 f.set({state:'succeeded',text:'这是已找到的日报正文。'});await f.runtime.tick();
 assert.equal(f.sent.length,2);assert.equal(f.sent[1].text,'这是已找到的日报正文。');
 await f.runtime.tick();assert.equal(f.sent.length,2);
});
for(const[state,pattern]of[['unknown',/尚未确认|中断/],['failed',/未能完成/],['needs_approval',/授权/],['needs_input',/补充/]])test(`Owner ${state} gets an honest visible state without replaying work`,async t=>{
 const f=await fixture(t,{initial:{state}});await f.send('查找我的学习资料');await f.runtime.tick();
 assert.equal(f.sent.length,1);assert.match(f.sent[0].text,pattern);assert.doesNotMatch(f.sent[0].text,/已接入|Harness 任务结果/);
 await f.runtime.tick();assert.equal(f.sent.length,1);assert.equal(f.starts.length,1);
});
test('a failed native start does not leave the Owner waiting indefinitely',async t=>{
 const f=await fixture(t,{initial:new Error('synthetic transport interruption')});await f.send('查找旧资料');await f.runtime.tick();
 assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/尚未确认|中断/);assert.equal(f.starts.length,1);
});
test('management message instructions keep the reply with Owner instead of forwarding explanations to K',async t=>{
 const f=await fixture(t,{initial:{state:'succeeded',text:'已按你的要求处理。'}});await f.send('给K发一条消息：晚上八点见。');
 assert.equal(f.starts[0].deliveryTarget,undefined);
 assert.equal(f.sent.some(row=>row.personId==='k'),false);assert.equal(f.sent.at(-1).personId,'owner');
});
test('a project request needing clarification cannot forward the question to the family recipient',async t=>{
 const f=await fixture(t,{initial:{state:'succeeded',text:'这份学习资料准备什么主题？'}});await f.send('帮我制作一份学习资料发给K，主题先问我');
 assert.equal(f.sent.some(row=>row.personId==='k'),false);assert.equal(f.sent.at(-1).personId,'owner');
});
test('Owner native prompt separates direct archived-history access, brief sharing and proactive notifications',async t=>{
 const f=await fixture(t);await f.send('能看家人记录吗？有什么重要的会告诉我吗？');
 const prompt=f.starts[0].prompt;
 assert.match(prompt,/完整.*已保存|已保存.*完整/);assert.match(prompt,/自动简报/);assert.match(prompt,/明确转告|明确求助/);
 assert.match(prompt,/不要.*工作台.*确认|无需.*工作台/);assert.match(prompt,/不.*自动.*重要|尚未.*重要/);
 assert.doesNotMatch(prompt,/它只创建草稿，已有明确卡片确认由工作台处理/);
});
