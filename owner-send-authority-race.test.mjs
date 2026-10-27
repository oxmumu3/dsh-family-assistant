import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
async function until(predicate){for(let i=0;i<40;i++){if(predicate())return;await new Promise(setImmediate);}assert.fail('synthetic race did not reach its expected queue state');}

test('a previously queued ordinary flush cannot send a native Owner message after that tool loses authority',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'owner-send-authority-race-synthetic-')),blockerEntered=deferred(),releaseBlocker=deferred(),sent=[],intents=[],pending=[];
 const track=promise=>{pending.push(promise);void promise.catch(()=>{});return promise;};
 const instant='2026-10-26T10:00:00.000Z';
 const ownerAgent={ensureControlWorkspace:async()=>({workspaceId:'control',title:'Owner',path:join(directory,'control')}),listWorkspaces:async()=>[{workspaceId:'control',title:'Owner',path:join(directory,'control')}],start:async intent=>{intents.push(structuredClone(intent));return{state:'running'};},observe:async intent=>({workspaceId:intent.workspaceId,sessionId:intent.sessionId,requestId:intent.requestId,cwd:intent.cwd,state:'running',requestSeen:true,queued:false,foreign:false,turn:1,activeTurn:1,activeRequestIds:[intent.requestId],events:[{type:'tool/call',seq:3,turn:1,name:'family_assistant',callId:'native-send-call',status:'running'}]})};
 const runtime=createRuntime({directory,ownerAgent,now:()=>instant,intervalMs:1000000,channelFactory:()=>({status:()=>({status:'connected'}),connect:async()=>{},disconnect:async()=>{},close:async()=>{},send:async(route,text,options)=>{
  if(options.authorize()!==true)throw Object.assign(new Error('synthetic authority revoked'),{sendOutcome:'failed'});
  if(text==='SYNTHETIC_BLOCKER'){blockerEntered.resolve();await releaseBlocker.promise;}
  if(options.authorize()!==true)throw Object.assign(new Error('synthetic authority revoked'),{sendOutcome:'failed'});
  sent.push({personId:route.personId,text});return{status:'api_accepted'};
 }})});
 t.after(async()=>{releaseBlocker.resolve();await Promise.allSettled(pending);await runtime.close();rmSync(directory,{recursive:true,force:true});});
 for(const[id,role,label]of[['owner','owner','我'],['k','elder','K']]){runtime.store.addPerson({id,role,label,shareWithOwner:'none'});runtime.store.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id});}
 await runtime.start();await runtime.receive('owner',{id:'current-owner-request',peerId:'peer-owner',text:'给K发一条消息：SYNTHETIC_AUTHORIZED_BODY'});await runtime.settled();assert.equal(intents.length,1);

 // Hold one flush inside transport, then queue an ordinary flush before the
 // protected native row exists. Its pending scan happens after that row exists.
 track(runtime.action({action:'send_message',personId:'k',text:'SYNTHETIC_BLOCKER'}));await blockerEntered.promise;
 track(runtime.action({action:'send_message',personId:'k',text:'SYNTHETIC_ORDINARY_SECOND'}));
 const controller=new AbortController();track(runtime.ownerSendForSession({sessionId:intents[0].sessionId,callId:'native-send-call',personId:'k',text:'SYNTHETIC_AUTHORIZED_BODY',signal:controller.signal}));
 await until(()=>runtime.store.snapshot().outbox.some(row=>row.sourceKey.startsWith('owner-message:owner:native-owner-')));
 const protectedRow=runtime.store.snapshot().outbox.find(row=>row.sourceKey.startsWith('owner-message:owner:native-owner-'));assert.equal(protectedRow.status,'pending');
 controller.abort();releaseBlocker.resolve();await Promise.allSettled(pending);await runtime.settled();

 assert.equal(sent.some(row=>row.text.includes('SYNTHETIC_AUTHORIZED_BODY')),false,'the earlier ordinary flush must preserve the row-specific native authority');
 assert.equal(runtime.store.snapshot().outbox.find(row=>row.id===protectedRow.id).status,'cancelled');
 assert.deepEqual(sent.filter(row=>row.personId==='k').map(row=>row.text),['SYNTHETIC_BLOCKER','SYNTHETIC_ORDINARY_SECOND']);
});
