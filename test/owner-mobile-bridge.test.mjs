import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';

async function setup(t){
 const directory=mkdtempSync(join(tmpdir(),'family-mobile-bridge-'));
 const runtime=createRuntime({directory,intervalMs:600000,respond:async()=>({reply:'普通回复'}),channelFactory:()=>({connect:async()=>{},disconnect:async()=>{},close:async()=>{},status:()=>({status:'connected'}),send:async()=>({status:'api_accepted'})})});
 t.after(async()=>{await runtime.close();rmSync(directory,{recursive:true,force:true});});
 for(const[id,role]of[['owner','owner']]){runtime.store.addPerson({id,role,label:id});runtime.store.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id});}
 await runtime.start();return runtime;
}

test('mobile task providers register, are consulted, and can be released',async t=>{
 const runtime=await setup(t);
 assert.equal(typeof runtime.familyDotBridge.registerMobileTasks,'function');
 let calls=0;
 const release=runtime.familyDotBridge.registerMobileTasks(()=>{calls++;return null;});
 assert.equal(typeof release,'function');
 assert.equal(runtime.resolveOwnerMobileTask('session-x','request-x'),null);
 assert.equal(calls,1);
 release();
 runtime.resolveOwnerMobileTask('session-x','request-x');
 assert.equal(calls,1,'释放之后不应再被调用');
});

test('mobile task registration refuses a non-function provider',async t=>{
 const runtime=await setup(t);
 assert.throws(()=>runtime.familyDotBridge.registerMobileTasks('nope'),/Mobile task provider unavailable/);
});

test('a provider that cannot authorize never yields a mobile task scope',async t=>{
 const runtime=await setup(t);
 runtime.familyDotBridge.registerMobileTasks(()=>({jobId:'job-1',origin:{sessionId:'s',bindingRevision:'a'.repeat(64)},returnBinding:{userHash:'a'.repeat(64),botHash:null},label:'项目',authorize:()=>false}));
 assert.equal(runtime.resolveOwnerMobileTask('session-x','request-x'),null);
});
