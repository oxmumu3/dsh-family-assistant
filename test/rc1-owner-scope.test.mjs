import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {AgentRegistry} from '@deepseek-ai/dsh-agent';
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection';
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt';
import {ToolRuntime} from '@deepseek-ai/dsh-tools';
import {createScope} from '@deepseek-ai/dsh-scope';
import * as Native from '@deepseek-ai/dsh-tool-executor-native';
import {PtcExecutor} from '@deepseek-ai/dsh-tool-executor-ptc';
import {HostConnectionService} from '@deepseek-ai/dsh-client-connection';
import {installOwnerDotReadGuard} from '../src/owner-dot-read-guard.mjs';
import {createOwnerPromptScope} from '../src/owner-prompt-scope.mjs';
import {ownerPromptSection,OWNER_SECTION_NAME} from '../src/owner-prompt.mjs';
import * as plugin from '../index.js';

async function fixture(t,{native=true}={}){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose());
 await ctx.plugin(SystemPrompt,{includeHarnessIdentity:false});
 await ctx.plugin(SessionProjectionRegistry);
 await ctx.plugin(AgentRegistry);
 await ctx.plugin(ToolRuntime);
 if(native)await ctx.plugin(Native);
 let scopeHost;
 await ctx.plugin({name:'synthetic-family-scope-owner',inject:['agents','tools','systemPrompt'],apply:context=>{scopeHost=context;}});
 const agent=async id=>{
  const value={id,session:{id},status:'idle'};
  const scope=createScope(scopeHost,value);value.ctx=scope.ctx;
  const unregister=value.ctx.agents.register(value);await unregister;
  return {...scope,agent:value,unregister};
 };
 return {ctx,agent};
}

test('actual rc1 Registry scopes Family tools and full policy to Owner, then releases them',async t=>{
 const {ctx,agent}=await fixture(t);
 const directory=await mkdtemp(join(tmpdir(),'family-rc1-scopes-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 new HostConnectionService(ctx,[],{isAuthenticated:()=>false,authenticateApi:()=>undefined});
 ctx.provide('llm',{listProviders:()=>[],chat:()=>assert.fail('No model calls')});
 const fiber=ctx.plugin(plugin,{storageDir:directory});await fiber;
 const owner=await agent('family_owner_synthetic'),other=await agent('unrelated_synthetic');
 await new Promise(resolve=>setImmediate(resolve));
 for(const name of ['family_assistant','family_owner_projects']){
  assert.ok(ctx.tools.get(name,owner.agent));assert.equal(ctx.tools.get(name,other.agent),undefined);assert.equal(ctx.tools.get(name),undefined);
 }
 const policy=ownerPromptSection().text;
 const assembly=await ctx.systemPrompt.assemble({agent:owner.agent,scope:owner.agent});
 assert.equal(assembly.sections.filter(row=>row.name===OWNER_SECTION_NAME).length,1);
 assert.equal(assembly.sections.find(row=>row.name===OWNER_SECTION_NAME).text,policy);
 assert.equal((await ctx.systemPrompt.assemble({agent:other.agent,scope:other.agent})).sections.some(row=>row.name===OWNER_SECTION_NAME),false);
 await owner.unregister();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(ctx.agents.get(owner.agent.id),undefined);assert.equal(ctx.tools.get('family_assistant',owner.agent),undefined);
 assert.equal((await ctx.systemPrompt.assemble({scope:owner.agent})).sections.some(row=>row.name===OWNER_SECTION_NAME),false);
 await fiber.dispose();await assert.rejects(access(join(directory,'runtime.lock')),error=>error.code==='ENOENT');
 await owner.dispose();await other.dispose();
});

test('actual rc1 scoped policy revalidates assembly and retains inline policy when a complete prompt hides it',async t=>{
 const {ctx,agent}=await fixture(t);const owner=await agent('family_owner_policy');
 const policy=ownerPromptSection();const scope=createOwnerPromptScope();t.after(()=>scope.close());
 assert.equal((await scope.attach(owner.agent)).verified,true);
 const request={content:[{type:'text',text:policy.text+'\n\n合成请求'}]};
 assert.equal((await scope.prepareRequest(owner.agent.id,request)).verified,true);assert.ok(!request.content[0].text.includes(policy.text));
 const release=owner.agent.ctx.systemPrompt.section({name:'synthetic-complete',order:1,text:'合成完整提示',complete:true});
 const fallback={content:[{type:'text',text:policy.text+'\n\n合成请求'}]};
 assert.equal((await scope.prepareRequest(owner.agent.id,fallback)).applied,false);assert.ok(fallback.content[0].text.includes(policy.text));
 await release();await scope.detach(owner.agent.id);await owner.unregister();await owner.dispose();
});

test('actual rc1 Owner guard selects official native only in its own scope and still denies unsafe tools',async t=>{
 const {ctx,agent}=await fixture(t,{native:false});
 const globalPtc=new PtcExecutor(ctx);ctx.tools.setExecutor(globalPtc);
 let unsafeCalls=0,allowedCalls=0;
 ctx.tools.register({name:'unsafe_synthetic',description:'Synthetic denial target',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>[]},execute:()=>{unsafeCalls++;return{};}});
 ctx.tools.register({name:'project_companion',description:'Synthetic allowed target',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>[]},execute:()=>{allowedCalls++;return{};}});
 const owner=await agent('family_owner_guard'),other=await agent('unrelated_guard');
 const guard=installOwnerDotReadGuard({ctx,getTasks:()=>[{sessionId:owner.agent.id,origin:'wechat',state:'running',prompt:'查看合成项目'}]});t.after(()=>guard.close());
 await guard.prepare(owner.agent.id);
 assert.ok(ctx.tools.selectExecutor(owner.agent) instanceof Native.NativeToolExecutor);
 assert.equal(ctx.tools.selectExecutor(other.agent),globalPtc);assert.equal(ctx.tools.selectExecutor(),globalPtc);
 const result=await ctx.tools.execute({agent:owner.agent,signal:new AbortController().signal,calls:[{type:'tool_call',id:'synthetic-denied',name:'unsafe_synthetic',arguments:'{}'}]});
 assert.equal(unsafeCalls,0);assert.equal(result.results[0].result.isError,true);
 assert.match(JSON.stringify(result.results[0].result),/本轮仅允许受控项目/);
 const allowed=await ctx.tools.execute({agent:owner.agent,signal:new AbortController().signal,calls:[{type:'tool_call',id:'synthetic-allowed',name:'project_companion',arguments:'{}'}]});
 assert.equal(allowedCalls,1);assert.equal(allowed.results[0].result.isError,false);
 await owner.unregister();await owner.dispose();await other.unregister();await other.dispose();
 assert.throws(()=>ctx.tools.selectExecutor(owner.agent),/executor/i);
});

test('actual rc1 conflicting per-agent executor blocks Owner preparation without changing any selection',async t=>{
 const {ctx,agent}=await fixture(t);const owner=await agent('family_owner_conflict');
 const prior=new PtcExecutor(owner.agent.ctx);owner.agent.ctx.tools.setExecutor(prior);
 const guard=installOwnerDotReadGuard({ctx,getTasks:()=>[{sessionId:owner.agent.id,state:'running',prompt:'查看合成项目'}]});t.after(()=>guard.close());
 await assert.rejects(()=>guard.prepare(owner.agent.id),/Only one tool executor/);
 assert.equal(ctx.tools.selectExecutor(owner.agent),prior);assert.ok(ctx.tools.selectExecutor() instanceof Native.NativeToolExecutor);
 await owner.unregister();await owner.dispose();
});

test('closing the Owner guard during native-module acquisition prevents a late scoped selection',async t=>{
 const {ctx,agent}=await fixture(t,{native:false});const globalPtc=new PtcExecutor(ctx);ctx.tools.setExecutor(globalPtc);
 const owner=await agent('family_owner_closing');
 const guard=installOwnerDotReadGuard({ctx,getTasks:()=>[{sessionId:owner.agent.id,state:'running',prompt:'查看合成项目'}]});
 const rejected=assert.rejects(guard.prepare(owner.agent.id),/owner_read_guard_closed/);
 await guard.close();await rejected;assert.equal(ctx.tools.selectExecutor(owner.agent),globalPtc);
 await owner.unregister();await owner.dispose();
});
