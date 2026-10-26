import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

async function mount({previous,observeError=false,workspaces=[]}={}) {
  const entry=await readFile(new URL('../src/client-entry.js',import.meta.url),'utf8');
  const effects=[],slots=[],calls=[];let definition;
  const React={createElement:()=>null,useState:()=>['',()=>{}],useEffect:fn=>effects.push(fn)};
  const remote={privateRaw:'never expose'};
  const window={__ModuleLoader__:{load:value=>{definition=value;}},__FamilyOwnerAgent:previous};
  runInNewContext(entry,{window,AbortController,fetch:async()=>({ok:true,text:async()=>'<html></html>'}),
    createFamilyVoice:()=>({dispose(){}}),createOwnerAgentClient:({remote:value})=>{
      assert.equal(value,remote);return Object.fromEntries(['listWorkspaces','pickWorkspace','addWorkspace','start','observe','cancel'].map(name=>[name,async(...args)=>{calls.push({name,args});if(observeError&&name==='observe')throw new Error('owner_agent_identity_mismatch');return name==='listWorkspaces'?workspaces:{state:'running'};} ]));
    }});
  const plugin=definition.factory(()=>React);
  plugin.apply({get:name=>{assert.equal(name,'remote');return remote;},effect:fn=>fn(),slots:{inject:(_key,fn)=>fn(),register:(metadata,component)=>slots.push({metadata,component})},uiWorkspace:{openSession:async id=>calls.push({name:'openSession',id})},layout:{selectPanel:value=>calls.push({name:'selectPanel',value})}});
  slots.find(x=>x.metadata.key==='family-assistant').component();const cleanup=effects[0]();
  return {window,plugin,calls,cleanup};
}
test('Owner bridge declares official Host services and exposes a narrow local surface',async()=>{
  const h=await mount();
  try {
    for(const key of ['remote','remote.session','remote.workspace','uiWorkspace'])assert.ok(h.plugin.inject.includes(key));
    assert.deepEqual(Object.keys(h.window.__FamilyOwnerAgent).sort(),['addWorkspace','cancel','listWorkspaces','observe','openSession','openTask','pickWorkspace','start']);
    assert.equal(h.window.__FamilyOwnerAgent.remote,undefined);
    const intent={sessionId:'family_owner_123',requestId:'same-request'};
    await h.window.__FamilyOwnerAgent.start(intent);
    assert.equal(h.calls[0].args[0],intent);assert.equal(h.calls[0].args[1].signal.aborted,false);
  }finally{h.cleanup();}
});
test('open native approval session first verifies identity and never approves anything',async()=>{
  const h=await mount(),intent={sessionId:'family_owner_123'};
  try{await h.window.__FamilyOwnerAgent.openSession(intent);assert.deepEqual(h.calls.map(x=>x.name),['observe','openSession','selectPanel']);assert.equal(h.calls[1].id,intent.sessionId);assert.equal(h.calls[2].value,null);}finally{h.cleanup();}
  const failed=await mount({observeError:true});
  try{await assert.rejects(failed.window.__FamilyOwnerAgent.openSession(intent),/identity_mismatch/);assert.deepEqual(failed.calls.map(x=>x.name),['observe']);}finally{failed.cleanup();}
});
test('unmount aborts only bridge observation and restores previous bridge',async()=>{
  const previous={older:true},h=await mount({previous}),bridge=h.window.__FamilyOwnerAgent;
  await bridge.observe({requestId:'one'});const signal=h.calls[0].args[1].signal;h.cleanup();
  assert.equal(signal.aborted,true);assert.equal(h.window.__FamilyOwnerAgent,previous);
  await assert.rejects(bridge.start({requestId:'two'}),/owner_agent_unavailable/);
  assert.equal(h.calls.filter(x=>x.name==='cancel').length,0);
});

test('durable backend task opens native session only after official workspace and request verification',async()=>{
 const task={workspaceId:'family',sessionId:'family_owner_task',requestId:'native-request'},h=await mount({workspaces:[{workspaceId:'family',path:'/synthetic/family',sessionIds:[task.sessionId]}]});
 try{await h.window.__FamilyOwnerAgent.openTask(task);assert.deepEqual(h.calls.map(row=>row.name),['listWorkspaces','observe','openSession','selectPanel']);assert.equal(h.calls[1].args[0].cwd,'/synthetic/family');}finally{h.cleanup();}
 const denied=await mount({workspaces:[{workspaceId:'other',path:'/synthetic/private',sessionIds:[task.sessionId]}]});
 try{await assert.rejects(()=>denied.window.__FamilyOwnerAgent.openTask(task),/identity_mismatch/);assert.deepEqual(denied.calls.map(row=>row.name),['listWorkspaces']);}finally{denied.cleanup();}
});
