import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,realpath,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Context} from '@deepseek-ai/cordis';
import {HostConnectionService} from '@deepseek-ai/dsh-client-connection';
import {ToolRuntime} from '@deepseek-ai/dsh-tools';
import * as plugin from '../index.js';
const directory=await realpath(await mkdtemp(join(tmpdir(),'family-ci-host-'))),ctx=new Context();
const connection=new HostConnectionService(ctx,[],{isAuthenticated:()=>false,authenticateApi:()=>undefined});
const dispatcher=connection.createSharedFetchHandler('/api');
ctx.provide('systemPrompt',{tools:()=>()=>{},section:()=>()=>{},getSectionOrder:()=>0});
const tools=new ToolRuntime(ctx);
// Only the presentation/model catalog is synthetic. Any inference is forbidden.
ctx.provide('llm',{listProviders:()=>[],chat:()=>assert.fail('No model calls in compatibility CI')});
const path='/api/family/control';
const fetch=(peer=connection.browserPeer,method='GET')=>dispatcher.fetch(new Request('http://127.0.0.1'+path,{method}),peer);
try{
 assert.equal(globalThis.__dshCiNetwork?.nonLoopbackAllowed,false,'Network denial preload required');
 for(let mount=0;mount<2;mount++){
  const fiber=ctx.plugin(plugin,{storageDir:directory});await fiber;
  const response=await fetch();assert.equal(response.status,200,await response.clone().text());
  const state=await response.json();assert.equal(state.config.paused,true);assert.deepEqual(state.people,[]);
  await access(join(directory,'runtime.lock'));
  for(const name of ['family_assistant','family_owner_projects'])assert.ok(tools.get(name));
  assert.equal((await fetch({principal:{kind:'synthetic-non-owner'}})).status,403);
  assert.equal((await fetch(connection.browserPeer,'DELETE')).status,404);
  await fiber.dispose();
  assert.equal((await fetch()).status,404);
  await assert.rejects(access(join(directory,'runtime.lock')),error=>error.code==='ENOENT');
  for(const name of ['family_assistant','family_owner_projects'])assert.equal(tools.get(name),undefined);
 }
 assert.equal(globalThis.__dshCiNetwork.denied,0);
 console.log(JSON.stringify({sdk:process.env.DSH_TEST_SDK_VERSION,actualCordis:true,actualToolRuntime:true,actualHostConnectionDispatcher:true,owner:200,otherPrincipal:403,unsupportedMethod:404,disposed:404,runtimeLockReleased:true,reenabled:true,paused:true,accounts:0,modelCalls:0,realMessagesSent:0,network:globalThis.__dshCiNetwork}));
}finally{await ctx.fiber.dispose();await rm(directory,{recursive:true,force:true});}
