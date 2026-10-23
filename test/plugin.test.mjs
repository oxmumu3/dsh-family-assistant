import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';

test('plugin mounts authenticated exact routes and a read-only host tool without polling',async t=>{
  const {apply}=await import('../index.js');const directory=mkdtempSync(join(tmpdir(),'family-plugin-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));const routes=[],tools=[];
  const services={connection:{fetch:{register(route){routes.push(route);return async()=>{};}}},tools:{register(tool){tools.push(tool);return()=>{};}},llm:{listProviders:()=>[]}};
  const ctx={get:name=>services[name],tools:services.tools,effect:execute=>execute()};
  const dispose=await apply(ctx,{storageDir:directory});t.after(dispose);
  assert.deepEqual(routes.map(x=>x.path),['/api/family/control','/api/family/workbench','/api/family/qr','/api/family/voice','/api/family/voice/action']);
  const response=await routes[0].fetch(new Request('http://dsh.internal/api/family/control'));
  const state=await response.json();assert.equal(state.config.paused,true);assert.equal(state.people.length,0);
  assert.equal(tools.length,1);assert.deepEqual(tools[0].parameters.properties.action.enum,['status','preview_brief']);
});

test('actual Cordis unload releases the runtime and routes before the same plugin is enabled again',async t=>{
  const plugin=await import('../index.js');
  const directory=mkdtempSync(join(tmpdir(),'family-plugin-lifecycle-'));
  const routes=new Map(),ctx=new Context();
  t.after(async()=>{await ctx.fiber.dispose();rmSync(directory,{recursive:true,force:true});});
  ctx.provide('connection',{fetch:{register(route){
    assert.equal(routes.has(route.path),false,'a previous instance must release its route');
    routes.set(route.path,route);return async()=>{routes.delete(route.path);};
  }}});
  ctx.provide('tools',{register(){return()=>{};}});
  ctx.provide('llm',{listProviders:()=>[]});
  for(let attempt=0;attempt<2;attempt++){
    const fiber=ctx.plugin(plugin,{storageDir:directory});await fiber;
    assert.equal(routes.size,5);
    assert.equal(existsSync(join(directory,'runtime.lock')),true);
    const response=await routes.get('/api/family/control').fetch(new Request('http://dsh.internal/api/family/control'));
    assert.equal((await response.json()).config.paused,true);
    await fiber.dispose();
    assert.equal(routes.size,0,'Cordis unload must unregister the exact routes');
    assert.equal(existsSync(join(directory,'runtime.lock')),false,'Cordis unload must release the live-process lock');
  }
});
