import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';
import {createImportantEvents} from '../src/important-events.mjs';
const decision=(id,text,notify=true)=>({decision:notify?'notify':'ignore',urgency:'soon',category:'needs_help',relatedIncidentId:null,subject:'self',eventState:'current',evidence:[{messageId:id,quote:text}],clarificationKind:null});
for(const [delay,mode] of [[0,'notify'],[40,'notify'],[0,'ignore'],[0,'disabled'],[0,'unknown'],[0,'failed'],[40,'rebindOwner'],[40,'rebindMember']])test('same-source HELP joins or falls back safely: '+mode+' delay='+delay,async t=>{
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'help-source-join-')));let receipt;
 const runtime=createRuntime({directory,now:()=> '2026-10-27T02:00:00Z',intervalMs:60000,
  memberAgent:{run:async input=>{receipt=await input.requestOwnerHelp({text:input.text,evidence:input.text,requestId:'same-source-help',authorize:async()=>true});return{state:'succeeded',text:'已记录'};},snapshot:()=>({active:0}),close:async()=>{}},
  classifyImportantEvent:async input=>{if(delay)await new Promise(resolve=>setTimeout(resolve,delay));if(mode==='rebindOwner')runtime.store.bindPerson('owner',{accountId:'new-owner',peerId:'new-owner'});if(mode==='rebindMember')runtime.store.bindPerson('member',{accountId:'new-member',peerId:'new-member'});return decision(input.message.id,input.message.text,mode!=='ignore');},
  channelFactory:()=>({connect:async()=>{},disconnect:async()=>{},close:async()=>{},status:()=>({status:'connected'}),send:async route=>{if(route.personId==='owner'&&['unknown','failed'].includes(mode))throw Object.assign(Error('synthetic transport failure'),{sendOutcome:mode==='failed'?'failed':'uncertain'});return{status:'api_accepted'};}})});
 t.after(async()=>{await runtime.close();rmSync(directory,{recursive:true,force:true});});
 for(const[id,role]of[['owner','owner'],['member','elder']]){runtime.store.addPerson({id,role,label:id});runtime.store.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id});}
 await runtime.start();if(mode!=='disabled')await runtime.action({action:'attention_configure',enabled:true});
 await runtime.receive('member',{id:'source-1',peerId:'peer-member',text:'我这件事需要家里帮忙处理'});await runtime.settled();
 const owner=runtime.status().outbox.filter(row=>row.personId==='owner');if(mode.startsWith('rebind')){assert.equal(owner.length,0);return;}assert.equal(owner.length,1);assert.equal(owner[0].kind,['ignore','disabled'].includes(mode)?'workflow_request':'important_event');assert.equal(receipt.status,['unknown','failed'].includes(mode)?mode:'api_accepted');
});
for(const notify of [false,true])test('source lookup joins durable classification without re-dispatch, notify='+notify,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'notice-source-ledger-')),owner={personId:'owner',createdAt:'2026-10-01T00:00:00Z',routeHash:'a'.repeat(64)},member={personId:'member',createdAt:'2026-10-01T00:00:00Z',routeHash:'b'.repeat(64)};let calls=0,valid=true;
 const options={directory,now:()=> '2026-10-27T02:00:00Z',classify:async input=>decision(input.messageId,input.text,notify),notify:async()=>{calls++;return{status:'unknown',outboxId:'unknown-row'};},getDelivery:async()=>null,isCurrent:()=>valid};
 let events=createImportantEvents(options);t.after(async()=>{await events.close();rmSync(directory,{recursive:true,force:true});});
 assert.equal(typeof events.ownerDeliveryForSource,'function');assert.equal(await events.ownerDeliveryForSource({memberScope:member,sourceId:'none'}),null);
 events.configure({enabled:true,ownerScope:owner});events.admit({memberScope:member,sourceId:'source-1',text:'我需要家里帮忙处理',receivedAt:options.now()});
 const found=await events.ownerDeliveryForSource({memberScope:member,sourceId:'source-1'});assert.equal(found?.status??null,notify?'unknown':null);assert.equal(calls,notify?1:0);
 await events.close();events=createImportantEvents(options);assert.equal((await events.ownerDeliveryForSource({memberScope:member,sourceId:'source-1'}))?.status??null,notify?'unknown':null);assert.equal(calls,notify?1:0);
 valid=false;const revoked=await events.ownerDeliveryForSource({memberScope:member,sourceId:'source-1'});assert.equal(revoked.status,'cancelled');assert.equal(revoked.blocked,true);
});
