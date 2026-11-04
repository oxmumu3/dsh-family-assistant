import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {probeOwnerSection,probePolicySection,runOwnerProbe,recordProbe,readProbe,sectionSurvived,PROBE_SECTION_NAME} from '../src/owner-prompt-probe.mjs';

const agentWith=(service)=>({id:'family_owner_test',ctx:{get:()=>service}});
const POLICY={name:'family-owner-role',order:50,text:'乐乐政策原文'};

test('a surviving scoped section is reported as visible',async()=>{
  let disposed=0;
  const service={section:()=>(()=>{disposed+=1;}),assemble:async()=>({sections:[{name:'base'},{name:PROBE_SECTION_NAME}]})};
  const result=await probeOwnerSection({agent:agentWith(service)});
  assert.equal(result.supported,true);
  assert.equal(result.survived,true);
  assert.equal(result.reason,'section_visible');
  assert.equal(disposed,1);
});

test('a section swallowed by a complete prompt is reported as dropped',async()=>{
  const service={section:()=>()=>{},assemble:async()=>({sections:[{name:'complete-base'}]})};
  const result=await probeOwnerSection({agent:agentWith(service)});
  assert.equal(result.supported,true);
  assert.equal(result.survived,false);
  assert.equal(result.reason,'section_dropped');
});

test('a host without the service or a failing assembly never throws',async()=>{
  const missing=await probeOwnerSection({agent:{id:'family_owner_x',ctx:{get:()=>undefined}}});
  assert.deepEqual([missing.supported,missing.survived],[false,false]);
  const broken=await probeOwnerSection({agent:agentWith({section:()=>{throw new Error('nope');},assemble:async()=>({})})});
  assert.equal(broken.supported,true);
  assert.match(broken.reason,/probe_failed/);
});

test('the verdict round-trips through the data directory',()=>{
  const directory=mkdtempSync(join(tmpdir(),'family-probe-'));
  try{
    assert.equal(readProbe(directory),null);
    recordProbe(directory,{supported:true,survived:true,reason:'section_visible',sectionNames:['base']});
    const back=readProbe(directory);
    assert.equal(back.survived,true);
    assert.equal(back.reason,'section_visible');
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('sectionSurvived tolerates a malformed assembly',()=>{
  assert.equal(sectionSurvived(undefined).survived,false);
  assert.equal(sectionSurvived({sections:null}).survived,false);
});

test('assembly receives the real agent as scope, mirroring assembleContextFor',async()=>{
  const seen=[];
  const service={section:()=>()=>{},assemble:async context=>{seen.push(context);return{sections:[{name:POLICY.name,text:POLICY.text}]};}};
  const agent={id:'family_owner_scope',ctx:{get:()=>service}};
  await probePolicySection({agent,section:POLICY});
  assert.equal(seen.length,1);
  assert.equal(seen[0].agent,agent);
  assert.equal(seen[0].scope,agent);
  assert.equal(Object.hasOwn(seen[0],'signal'),false);
});

test('the turn signal is forwarded only when the caller supplies one',async()=>{
  const seen=[];
  const signal=new AbortController().signal;
  const service={section:()=>()=>{},assemble:async context=>{seen.push(context);return{sections:[{name:PROBE_SECTION_NAME}]};}};
  const agent={id:'family_owner_signal',ctx:{get:()=>service}};
  await probeOwnerSection({agent,assembleSignal:signal});
  assert.equal(seen[0].scope,agent);
  assert.equal(seen[0].signal,signal);
  assert.deepEqual(Object.keys(seen[0]).sort(),['agent','scope','signal']);
});

test('the real policy section must survive intact before switching',async()=>{
  const good={section:()=>()=>{},assemble:async()=>({sections:[{name:'base'},{name:POLICY.name,text:POLICY.text}]})};
  const ok=await probePolicySection({agent:agentWith(good),section:POLICY});
  assert.deepEqual([ok.registered,ok.textMatched,ok.reason],[true,true,'policy_section_intact']);

  const altered={section:()=>()=>{},assemble:async()=>({sections:[{name:POLICY.name,text:'被截断'}]})};
  const bad=await probePolicySection({agent:agentWith(altered),section:POLICY});
  assert.equal(bad.registered,true);
  assert.equal(bad.textMatched,false);
  assert.equal(bad.reason,'policy_section_altered');

  const missing={section:()=>()=>{},assemble:async()=>({sections:[{name:'base'}]})};
  const gone=await probePolicySection({agent:agentWith(missing),section:POLICY});
  assert.deepEqual([gone.registered,gone.reason],[false,'policy_section_missing']);
});

test('switch is allowed only when both stages pass',async()=>{
  const dropped={section:()=>()=>{},assemble:async()=>({sections:[{name:'base'}]})};
  const no=await runOwnerProbe({agent:agentWith(dropped),section:POLICY});
  assert.equal(no.switchAllowed,false);
  assert.equal(no.policy,null);

  const intact={section:()=>()=>{},assemble:async()=>({sections:[{name:PROBE_SECTION_NAME},{name:POLICY.name,text:POLICY.text}]})};
  const yes=await runOwnerProbe({agent:agentWith(intact),section:POLICY});
  assert.equal(yes.switchAllowed,true);
  assert.equal(yes.policy.textMatched,true);
});

test('a v2 verdict keeps both stages and the switch decision on disk',()=>{
  const directory=mkdtempSync(join(tmpdir(),'family-probe2-'));
  try{
    const record=recordProbe(directory,{version:2,quick:{supported:true,survived:true,reason:'section_visible',sectionNames:['base']},policy:{registered:true,textMatched:true,length:12,expectedLength:12,reason:'policy_section_intact'},switchAllowed:true});
    assert.equal(record.version,2);
    const back=readProbe(directory);
    assert.equal(back.switchAllowed,true);
    assert.equal(back.policy.textMatched,true);
    assert.equal(back.policy.length,12);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
