import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';
import {createHostResponder} from '../src/model.mjs';

test('generated reports use the current member future topic preference without changing Owner profile or other bindings',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'daily-topic-synthetic-')),inputs=[],sent=[],instruction='以后日报不讲合成护肤主题，改讲饮食结构';
 const feedback={getPreference:({personId,route})=>personId==='mom'&&route.generation===1?{instruction,revision:1}:null,adaptReport:async input=>({text:input.text,adapted:false,status:'original',revision:0})};
 const runtime=createRuntime({directory,memberReportFeedback:feedback,respond:async input=>{inputs.push(input);return{reply:'本人健康知识日报：依据提供的资料整理。',action:null};},channelFactory:()=>({status:()=>({status:'connected'}),connect:async()=>{},disconnect:async()=>{},close:async()=>{},send:async(route,text)=>{sent.push({personId:route.personId,text});return{status:'api_accepted'};}})});
 t.after(async()=>{await runtime.close();rmSync(directory,{recursive:true,force:true});});
 for(const[id,role]of[['owner','owner'],['mom','elder'],['dad','elder']]){runtime.store.addPerson({id,role,label:id,notes:'Owner提供的背景'});runtime.store.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id});}
 await runtime.start();
 for(const id of ['mom','dad']){runtime.store.enqueue({personId:id,kind:'workbench_daily',sourceKey:'synthetic-source-'+id,text:'已核实的日稿来源'});await runtime.tick();await runtime.settled();}
 assert.equal(inputs.length,2);assert.equal(inputs[0].dailyPreference,instruction);assert.equal(inputs[1].dailyPreference,null);assert.equal(runtime.store.person('mom').notes,'Owner提供的背景');assert.equal(sent.length,2);
 runtime.store.bindPerson('mom',{accountId:'new-account',peerId:'new-peer'});runtime.store.enqueue({personId:'mom',kind:'workbench_daily',sourceKey:'synthetic-source-new-binding',text:'新绑定日稿'});await runtime.tick();await runtime.settled();assert.equal(inputs.at(-1).dailyPreference,null);
});

test('the actual daily generator receives the explicit preference as member data and keeps no-news-without-sources guidance',async()=>{
 let options;const responder=createHostResponder({get:()=>({async *stream(input){options=input;yield{type:'text-delta',index:0,text:JSON.stringify({reply:'合成饮食知识日报',action:null})};yield{type:'finish',reason:{kind:'stop'}};}})},()=>({provider:'deepseek-account',model:'deepseek-flash'}));
 await responder({person:{id:'mom',label:'合成成员',timeZone:'Asia/Shanghai',interests:['合成护肤'],notes:''},history:[],notes:[],reminders:[],text:'请生成今天的个人日报',dailyPreference:'以后日报不讲合成护肤，改为饮食结构',now:'2026-10-26T10:00:00.000Z'});
 assert(options.system.includes('以后日报不讲合成护肤，改为饮食结构'));assert(options.system.includes('避免无来源的新闻'));assert.deepEqual(options.tools,[]);
});
