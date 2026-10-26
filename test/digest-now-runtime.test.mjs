import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,utimesSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRuntime} from '../src/runtime.mjs';
import {createDigestSources,createFamilyToolExecutors} from '../src/family-tool-executors.mjs';

const now='2026-10-25T14:00:00.000Z';
async function fixture(t,{body='AI 日报｜2026-10-25\n这是已有上游整理的真实临时文件内容。',sendFailure}={}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'lele-digest-now-'))),directory=join(root,'private'),projects=[];let modelCalls=0,runtime;
 for(let i=0;i<14;i++){const path=join(root,'project-'+i);mkdirSync(path);projects.push({workspaceId:'project-'+i,title:i===13?'日常资料':'fixture-'+i,path,sessionIds:[]});writeFileSync(join(path,'notes.md'),'Ordinary project notes without digest content.');}
 const digest=join(projects[13].path,'output/ai-digest');mkdirSync(digest,{recursive:true});
 for(const[name,text]of[['2026-10-25-wechat.txt',body],['2026-10-25-source.md','AI source raw version'],['2026-10-24-wechat.txt','Yesterday report']]){const p=join(digest,name);writeFileSync(p,text);utimesSync(p,new Date(now),new Date(now));}
 const ownerAgent={listWorkspaces:async()=>projects},sent=[],rejectPlanner=async()=>{modelCalls++;throw Error('generic planner must not handle current digest workflow');};
 const make=()=>createRuntime({directory,now:()=>now,intervalMs:600000,ownerAgent,digestSources:createDigestSources({ownerAgent,maxBytes:24000}),toolExecutors:createFamilyToolExecutors({ownerAgent,maxBytes:24000}),respond:rejectPlanner,planWorkbench:rejectPlanner,planHarness:rejectPlanner,
  channelFactory:()=>({status:()=>({status:'connected'}),connect:async()=>{},disconnect:async()=>{},close:async()=>{},send:async(route,text,options)=>{assert.equal(options.authorize(),true);sent.push({personId:route.personId,text});if(route.personId==='k'&&sendFailure)throw Object.assign(new Error('private transport diagnostic'),{sendOutcome:sendFailure,code:-14});return{status:'api_accepted'};}})});
 runtime=make();for(const[id,role,label]of[['owner','owner','我'],['k','elder','K']]){runtime.store.addPerson({id,role,label,timeZone:'Asia/Shanghai'});runtime.store.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id});}await runtime.start();
 t.after(async()=>{await runtime.close();rmSync(root,{recursive:true,force:true});});
 return{get runtime(){return runtime;},sent,body,models:()=>modelCalls,async restart(){await runtime.close();runtime=make();await runtime.start();}};
}
const incoming=(f,id,text)=>f.runtime.receive('owner',{id,peerId:'peer-owner',text});
const sequence=[['request','给K每天早上发我之前通过codex本机搞的AI日报'],['search','你可以自己去搜索去找吗'],['send','没事儿，我们第一轮测试，你先找到，然后你先直接立马给他推送一下看看']];

test('actual-shaped three-turn WeChat request discovers a source outside the first twelve projects and sends once without daily setup or model fallback',async t=>{
 const f=await fixture(t);for(const[id,text]of sequence)await incoming(f,id,text);await f.runtime.settled();
 assert.equal(f.models(),0);assert.deepEqual(f.sent.filter(row=>row.personId==='k').map(row=>row.text),[f.body],JSON.stringify({sent:f.sent,drafts:f.runtime.status().serviceSetup,lastError:f.runtime.status().lastError}));
 assert.equal(f.runtime.store.person('k').dailyEnabled,false);assert.equal((await f.runtime.action({action:'tool_assignments',personId:'k'})).length,0);
 const pending=f.runtime.status().serviceSetup.find(row=>row.origin==='wechat'&&row.personId==='k');assert.equal(pending.status,'needs_input');assert.ok(pending.missing.includes('time'));
 assert.equal(f.sent.filter(row=>row.personId==='k').some(row=>/workspaceId|relativePath|\/Users\/|project-13|output\/ai-digest/.test(row.text)),false);
 await incoming(f,'send',sequence[2][1]);await f.runtime.tick();assert.equal(f.sent.filter(row=>row.personId==='k').length,1);
 await f.restart();await incoming(f,'send',sequence[2][1]);await f.runtime.tick();assert.equal(f.sent.filter(row=>row.personId==='k').length,1);
});
test('unknown first-part delivery suppresses remaining parts and does not retry on tick or restart',async t=>{
 const f=await fixture(t,{body:'AI 日报｜2026-10-25\n'+('合成阅读内容。'.repeat(600)),sendFailure:'uncertain'});
 for(const[id,text]of sequence)await incoming(f,id,text);await f.runtime.settled();
 assert.equal(f.sent.filter(row=>row.personId==='k').length,1);
 const rows=f.runtime.store.snapshot().outbox.filter(row=>row.kind==='digest_once');assert.ok(rows.some(row=>row.status==='uncertain'));assert.equal(rows.some(row=>row.status==='pending'),false);
 await f.runtime.tick();await f.restart();await f.runtime.tick();assert.equal(f.sent.filter(row=>row.personId==='k').length,1);
});
test('failed send retains only the safe numeric business code for troubleshooting',async t=>{
 const f=await fixture(t,{sendFailure:'failed'});
 await f.runtime.action({action:'send_message',personId:'k',text:'已授权的一次测试文本'});
 const row=f.runtime.store.snapshot().outbox.at(-1);assert.equal(row.status,'failed');assert.match(row.detail,/-14/);
 assert.equal(row.detail.includes('Bearer'),false);
});
test('authenticated Owner can resume the existing WeChat draft for one immediate send without creating a daily subscription',async t=>{
 const f=await fixture(t);await incoming(f,...sequence[0]);
 const draft=f.runtime.status().serviceSetup.find(row=>row.origin==='wechat');
 const request={action:'service_send_once',draftId:draft.id,revision:draft.revision,requestId:'resume-original'};
 await f.runtime.action(request);await f.runtime.settled();assert.deepEqual(f.sent.filter(row=>row.personId==='k').map(row=>row.text),[f.body]);
 await assert.rejects(f.runtime.action(request),/变化/);assert.equal(f.sent.filter(row=>row.personId==='k').length,1);
 assert.equal(f.runtime.store.person('k').dailyEnabled,false);assert.equal((await f.runtime.action({action:'tool_assignments',personId:'k'})).length,0);assert.equal(f.models(),0);
});
