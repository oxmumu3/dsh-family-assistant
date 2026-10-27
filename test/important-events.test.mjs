import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,statSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createImportantEvents} from '../src/important-events.mjs';
import * as importantModule from '../src/important-events.mjs';

const owner={personId:'owner',createdAt:'2026-10-01T00:00:00Z',routeHash:'a'.repeat(64)},member={personId:'member',createdAt:'2026-10-01T00:00:00Z',routeHash:'b'.repeat(64)},other={personId:'other',createdAt:'2026-10-01T00:00:00Z',routeHash:'c'.repeat(64)};
const decision=(quote,messageId='message-1',patch={})=>({decision:'notify',urgency:'soon',category:'needs_help',relatedIncidentId:null,subject:'self',eventState:'current',evidence:[{messageId,quote}],clarificationKind:null,...patch});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
function fixture(t,overrides={}){
 const directory=mkdtempSync(join(tmpdir(),'important-events-synthetic-')),deliveries=new Map(),sent=[],classified=[],roles=[];let time=Date.parse('2026-10-26T10:00:00Z'),result,valid=true;
 const options={directory,now:()=>new Date(time).toISOString(),classify:async input=>{classified.push(input);return typeof result==='function'?result(input):result??decision(input.text,input.messageId);},notify:async args=>{assert.equal(args.authorize(),true);sent.push(args);const delivery={status:'api_accepted',outboxId:'synthetic-'+sent.length};deliveries.set(args.key,delivery);return delivery;},getDelivery:async key=>deliveries.get(key)??null,isCurrent:(scope,role)=>{roles.push(role);return valid;},...overrides};
 const events=createImportantEvents(options),enable=()=>events.configure({enabled:true,ownerScope:owner}),admit=(text='我这件事需要家里帮忙处理',sourceId='message-1',scope=member)=>events.admit({sourceId,text,receivedAt:options.now(),memberScope:scope});
 t.after(async()=>{await events.close();rmSync(directory,{recursive:true,force:true});});
 return{directory,events,options,sent,classified,deliveries,roles,enable,admit,set:value=>{result=value;},invalidate:()=>{valid=false;},advance:ms=>{time+=ms;},make:()=>createImportantEvents(options)};
}

test('important-event admission is private, disabled by default and begins at an explicit enable baseline',async t=>{
 const f=fixture(t);assert.equal(f.events.state().settings.enabled,false);assert.equal(f.admit().accepted,false);assert.equal(f.classified.length,0);f.enable();assert.equal(f.events.admit({sourceId:'old',text:'历史事项',receivedAt:'2026-10-26T09:00:00Z',memberScope:member}).accepted,false);const row=f.admit();assert.equal(row.accepted,true);assert.equal(typeof row.then,'undefined');assert.equal(f.events.state().counts.prepared,1);assert.equal(statSync(join(f.directory,'owner-attention.json')).mode&0o777,0o600);assert.equal(f.sent.length,0);assert.equal(f.classified.length,0);
});

test('classification and delivery are separate from durable admission and use fixed evidence-backed notification text',async t=>{
 const f=fixture(t);f.enable();const row=f.admit();await f.events.run(row.id);assert.equal(f.sent.length,1);assert.equal(f.sent[0].recipient,'owner');assert.equal(f.sent[0].kind,'alert');assert.match(f.sent[0].text,/需要协助|需要.*帮忙/);assert.match(f.sent[0].text,/我这件事需要家里帮忙处理/);assert.deepEqual(f.sent[0].memberScope,member);assert.deepEqual(f.sent[0].ownerScope,owner);assert.equal(f.events.casesForOwner().length,1);assert.equal(f.events.casesForOwner()[0].delivery.status,'api_accepted');assert.ok(f.roles.includes('owner'));assert.ok(f.roles.includes('elder'));assert.equal(f.admit().accepted,false);await f.events.tick();assert.equal(f.sent.length,1);
});

test('a slow classifier never makes admission await a model and duplicate run joins one operation',async t=>{
 const gate=deferred(),f=fixture(t);f.enable();f.set(async input=>{await gate.promise;return decision(input.text,input.messageId);});const row=f.admit(),first=f.events.run(row.id),second=f.events.run(row.id);await new Promise(setImmediate);assert.equal(f.classified.length,1);const next=f.admit('今天聊聊普通生活','message-2');assert.equal(next.accepted,true);gate.resolve();await Promise.all([first,second]);assert.equal(f.sent.length,1);
});

for(const patch of[{evidence:[{messageId:'message-1',quote:'模型捏造的求助'}]},{subject:'unclear',eventState:'hypothetical'},{summary:'模型自由诊断'}])test('unsupported or ungrounded important-event decisions never create an Owner alert: '+JSON.stringify(patch),async t=>{
 const f=fixture(t);f.enable();f.set(decision('我需要帮忙','message-1',patch));await f.events.run(f.admit('我需要帮忙').id);assert.equal(f.sent.length,0);assert.equal(f.events.casesForOwner().length,0);
});

test('ordinary do-not-tell requests suppress sharing while a literal immediate safety risk has a narrow exception',async t=>{
 const f=fixture(t);f.enable();const normal='我这件事需要帮忙，但不要告诉家里人';f.set(decision(normal));await f.events.run(f.admit(normal).id);assert.equal(f.sent.length,0);
 const danger='我现在喘不过气了，先别告诉家里人';f.set(decision('我现在喘不过气了','message-2',{category:'safety',urgency:'now'}));await f.events.run(f.admit(danger,'message-2').id);assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/安全/);
 const example='如果有人说“我现在喘不过气了”，不要告诉Owner';f.set(decision('我现在喘不过气了','message-3',{category:'safety',urgency:'now',eventState:'hypothetical'}));await f.events.run(f.admit(example,'message-3').id);assert.equal(f.sent.length,1);
});

test('clarification asks only the member a fixed question and does not create an Owner case or repeat within one hour',async t=>{
 const f=fixture(t);f.enable();f.set(decision('这件事可能要帮忙','message-1',{decision:'clarify',clarificationKind:'needs_help',eventState:'unclear'}));await f.events.run(f.admit('这件事可能要帮忙').id);assert.equal(f.sent.length,1);assert.equal(f.sent[0].recipient,'member');assert.equal(f.sent[0].kind,'clarify');assert.equal(f.sent[0].text,'这件事现在还需要处理吗？有哪些地方需要家里人一起帮忙？');assert.equal(f.events.casesForOwner().length,0);
 f.set(decision('还不清楚','message-2',{decision:'clarify',clarificationKind:'current_or_quote',eventState:'unclear'}));await f.events.run(f.admit('还不清楚','message-2').id);assert.equal(f.sent.length,1);f.advance(61*60000);f.set(decision('还是不清楚','message-3',{decision:'clarify',clarificationKind:'current_or_quote',eventState:'unclear'}));await f.events.run(f.admit('还是不清楚','message-3').id);assert.equal(f.sent.length,2);assert.equal(f.sent[1].text,'你说的是现在发生在你或家人身上的情况，还是转发的内容？');
});

test('one incident coalesces repeated evidence and updates after new facts or an explicit resolution',async t=>{
 const f=fixture(t);f.enable();await f.events.run(f.admit('我需要家里帮忙').id);const incident=f.events.casesForOwner()[0];f.events.mark({id:incident.id,status:'ack'});f.set(decision('我需要家里帮忙','message-2',{relatedIncidentId:incident.id}));await f.events.run(f.admit('我需要家里帮忙','message-2').id);assert.equal(f.sent.length,1);assert.equal(f.events.casesForOwner()[0].status,'acknowledged');
 f.set(decision('明天要去窗口补交材料','message-3',{relatedIncidentId:incident.id,eventState:'upcoming'}));await f.events.run(f.admit('明天要去窗口补交材料','message-3').id);assert.equal(f.sent.length,2);assert.equal(f.events.casesForOwner().length,1);assert.equal(f.sent[1].kind,'update');
 f.set(decision('已经处理好了','message-4',{relatedIncidentId:incident.id,eventState:'resolved'}));await f.events.run(f.admit('已经处理好了','message-4').id);assert.equal(f.sent.length,3);assert.match(f.sent[2].text,/已经处理|已处理/);assert.equal(f.events.casesForOwner()[0].status,'resolved');
 f.set(decision('已经处理好了','message-5',{relatedIncidentId:incident.id,eventState:'resolved'}));await f.events.run(f.admit('已经处理好了','message-5').id);assert.equal(f.sent.length,3);
});

test('cross-member related cases and a revoked scope cannot reuse an incident or dispatch evidence',async t=>{
 const f=fixture(t);f.enable();await f.events.run(f.admit('我需要帮忙').id);const first=f.events.casesForOwner()[0];f.set(decision('我也需要帮忙','other-message',{relatedIncidentId:first.id}));await f.events.run(f.admit('我也需要帮忙','other-message',other).id);assert.equal(f.sent.length,1);f.invalidate();assert.equal(f.admit('新变化','message-3').accepted,false);
});

test('scope revocation during classification cancels the result after the await',async t=>{
 const gate=deferred(),f=fixture(t);f.enable();f.set(async input=>{await gate.promise;return decision(input.text,input.messageId);});const running=f.events.run(f.admit().id);await new Promise(setImmediate);f.invalidate();gate.resolve();await running;assert.equal(f.sent.length,0);
});

test('a pending core outbox row is followed to API acceptance without calling notify twice',async t=>{
 let f;f=fixture(t,{notify:async args=>{f.sent.push(args);const row={status:'pending',outboxId:'pending-core'};f.deliveries.set(args.key,row);return row;}});f.enable();await f.events.run(f.admit().id);assert.equal(f.sent.length,1);await f.events.tick();assert.equal(f.sent.length,1);f.deliveries.set(f.sent[0].key,{status:'api_accepted',outboxId:'pending-core'});await f.events.tick();assert.equal(f.events.casesForOwner()[0].delivery.status,'api_accepted');assert.equal(f.sent.length,1);
});

test('an uncertain dispatch with no durable core row is never automatically sent again after restart',async t=>{
 let attempts=0;const f=fixture(t,{notify:async()=>{attempts++;throw Error('synthetic uncertain network');}});f.enable();await f.events.run(f.admit().id);assert.equal(f.events.casesForOwner()[0].delivery.status,'unknown');const restarted=f.make();await restarted.resume();await restarted.tick();assert.equal(attempts,1);assert.equal(restarted.casesForOwner()[0].delivery.status,'unknown');await restarted.close();
});

test('interrupted pure classification can resume safely and credentials never reach classifier or Owner text',async t=>{
 const f=fixture(t);f.enable();const row=f.admit('我需要帮忙，账号123456789012345678，密码：secret-value');const file=join(f.directory,'owner-attention.json'),state=JSON.parse(readFileSync(file,'utf8'));state.inputs.find(item=>item.id===row.id).status='classifying';writeFileSync(file,JSON.stringify(state),{mode:0o600});const restarted=f.make();await restarted.resume();assert.equal(f.sent.length,1);assert.doesNotMatch(JSON.stringify(f.classified.map(input=>input.text)),/secret-value|123456789012345678/);assert.doesNotMatch(f.sent[0].text,/secret-value|123456789012345678/);await restarted.close();
});

test('bad classifier JSON is contained and disabling invalidates pending notification authority',async t=>{
 const f=fixture(t);f.enable();f.set('not valid JSON');await f.events.run(f.admit().id);assert.equal(f.sent.length,0);assert.equal(f.events.casesForOwner().length,0);f.set(undefined);await f.events.run(f.admit('我还需要帮忙','message-2').id);const authorize=f.sent[0].authorize;f.events.configure({enabled:false});assert.equal(authorize(),false);
});

test('a symlinked private attention ledger is rejected without reading or modifying its target',t=>{
 const f=fixture(t),target=join(f.directory,'outside.json'),file=join(f.directory,'owner-attention.json');writeFileSync(target,'private sentinel');rmSync(file);symlinkSync(target,file);assert.throws(()=>f.make(),/链接|路径|存储/);assert.equal(readFileSync(target,'utf8'),'private sentinel');
});

test('a grounded ignore-plus-resolved classification closes a notified case and emits one resolution update',async t=>{
 const f=fixture(t);f.enable();await f.events.run(f.admit('我需要帮忙').id);const incident=f.events.casesForOwner()[0];f.set(decision('这件事已经处理好了','message-2',{decision:'ignore',eventState:'resolved',relatedIncidentId:incident.id}));await f.events.run(f.admit('这件事已经处理好了','message-2').id);assert.equal(f.events.casesForOwner()[0].status,'resolved');assert.equal(f.sent.length,2);
 f.set(decision('已经办完不用担心','message-3',{decision:'ignore',eventState:'resolved',relatedIncidentId:incident.id}));await f.events.run(f.admit('已经办完不用担心','message-3').id);assert.equal(f.sent.length,2);
});

for(const text of['转发的假设场景：\n我现在喘不过气了\n不要告诉家里人','我现在喘不过气了，但已经获救安全了，不要告诉家里人'])test('a model-selected danger substring cannot override privacy in the full current context: '+text,async t=>{
 const f=fixture(t);f.enable();f.set(decision('我现在喘不过气了','message-1',{category:'safety',urgency:'now'}));await f.events.run(f.admit(text).id);assert.equal(f.sent.length,0);
});

test('a muted case stays muted for new nonurgent evidence and reopens only for a severity escalation',async t=>{
 const f=fixture(t);f.enable();await f.events.run(f.admit('这件事需要帮忙').id);const incident=f.events.casesForOwner()[0];f.events.mark({id:incident.id,status:'muted'});f.set(decision('明天需要去窗口','message-2',{relatedIncidentId:incident.id}));await f.events.run(f.admit('明天需要去窗口','message-2').id);assert.equal(f.sent.length,1);assert.equal(f.events.casesForOwner()[0].status,'muted');
 f.set(decision('我现在喘不过气了','message-3',{category:'safety',urgency:'now',relatedIncidentId:incident.id}));await f.events.run(f.admit('我现在喘不过气了','message-3').id);assert.equal(f.sent.length,2);assert.equal(f.events.casesForOwner()[0].category,'safety');f.events.mark({id:incident.id,status:'muted'});f.set(decision('我现在仍然喘不过气','message-4',{category:'safety',urgency:'now',relatedIncidentId:incident.id}));await f.events.run(f.admit('我现在仍然喘不过气','message-4').id);assert.equal(f.sent.length,2);
});

test('tick and classification completion join one notification dispatch for the same durable key',async t=>{
 const gate=deferred(),f=fixture(t,{getDelivery:async()=>{await gate.promise;return null;}});f.enable();const running=f.events.run(f.admit().id);await new Promise(setImmediate);const ticking=f.events.tick();gate.resolve();await Promise.all([running,ticking]);assert.equal(f.sent.length,1);
});

test('a core outbox lookup failure is not evidence that no prior delivery exists',async t=>{
 let available=false;const f=fixture(t,{getDelivery:async()=>{if(!available)throw Error('synthetic lookup unavailable');return null;}});f.enable();await f.events.run(f.admit().id);assert.equal(f.sent.length,0);available=true;await f.events.tick();assert.equal(f.sent.length,1);
});

test('the same credential redactor is available for the root history adapter',()=>{assert.equal(typeof importantModule.redactImportantText,'function');assert.doesNotMatch(importantModule.redactImportantText('账号123456789012345678，密码：secret-value'),/123456789012345678|secret-value/);});

test('the ledger independently suppresses ordinary clarification when the current member declined escalation',async t=>{
 const f=fixture(t);f.enable();const text='这件事暂时不清楚，不要告诉家里人';f.set(decision(text,'message-1',{decision:'clarify',eventState:'unclear',clarificationKind:'needs_help'}));await f.events.run(f.admit(text).id);assert.equal(f.sent.length,0);
});

test('old settled intake is reclaimed at capacity while unfinished intake and the recent source dedup window remain',async t=>{
 const f=fixture(t);f.enable();f.admit();const file=join(f.directory,'owner-attention.json'),state=JSON.parse(readFileSync(file,'utf8')),template=state.inputs[0];state.inputs=Array.from({length:3000},(_,index)=>({...template,id:'old-input-'+index,sourceId:'old-source-'+index,status:index===2999?'prepared':'ignored'}));writeFileSync(file,JSON.stringify(state),{mode:0o600});f.advance(31*86400000);const restarted=f.make();const next=restarted.admit({sourceId:'fresh-source',text:'这是新的事项',receivedAt:f.options.now(),memberScope:member});assert.equal(next.accepted,true);const saved=JSON.parse(readFileSync(file,'utf8'));assert.equal(saved.inputs.length,2);assert.ok(saved.inputs.some(row=>row.id==='old-input-2999'&&row.status==='prepared'));assert.equal(restarted.admit({sourceId:'fresh-source',text:'这是新的事项',receivedAt:f.options.now(),memberScope:member}).accepted,false);await restarted.close();
});

test('recent source identities cannot be evicted merely to make room and capacity failures leave a valid ledger',async t=>{
 const f=fixture(t);f.enable();f.admit();const file=join(f.directory,'owner-attention.json'),state=JSON.parse(readFileSync(file,'utf8')),template=state.inputs[0];state.inputs=Array.from({length:3000},(_,index)=>({...template,id:'recent-input-'+index,sourceId:'recent-source-'+index,status:'ignored'}));writeFileSync(file,JSON.stringify(state),{mode:0o600});const restarted=f.make();assert.throws(()=>restarted.admit({sourceId:'new-over-capacity',text:'不能挤掉近期去重记录',receivedAt:f.options.now(),memberScope:member}),/容量|上限/);assert.equal(JSON.parse(readFileSync(file,'utf8')).inputs.length,3000);await restarted.close();
});

test('old resolved cases are reclaimed but their unfinished delivery and all active cases remain',async t=>{
 const f=fixture(t);f.enable();await f.events.run(f.admit('我需要帮忙').id);const file=join(f.directory,'owner-attention.json'),state=JSON.parse(readFileSync(file,'utf8')),caseTemplate=state.cases[0],deliveryTemplate=state.deliveries[0];state.cases=Array.from({length:2000},(_,index)=>({...caseTemplate,id:'old-case-'+index,status:'resolved',eventState:'resolved'}));state.deliveries=state.cases.map((row,index)=>({...deliveryTemplate,key:'old-delivery-'+index,incidentId:row.id,status:index===1999?'unknown':'api_accepted'}));writeFileSync(file,JSON.stringify(state),{mode:0o600});f.advance(31*86400000);const restarted=f.make(),input=restarted.admit({sourceId:'new-important',text:'我需要新的重要协助',receivedAt:f.options.now(),memberScope:member});await restarted.run(input.id);const saved=JSON.parse(readFileSync(file,'utf8'));assert.equal(saved.cases.length,2);assert.ok(saved.cases.some(row=>row.id==='old-case-1999'));assert.ok(saved.deliveries.some(row=>row.key==='old-delivery-1999'&&row.status==='unknown'));await restarted.close();
});

test('settled intake retains a source hash instead of retaining a growing copy of ordinary conversation text',async t=>{
 const f=fixture(t);f.enable();const original='普通聊天里不必长期重复保存的完整原文';f.set(decision(original,'message-1',{decision:'ignore',evidence:[]}));await f.events.run(f.admit(original).id);const row=JSON.parse(readFileSync(join(f.directory,'owner-attention.json'),'utf8')).inputs[0];assert.equal(row.sourceHash.length,64);assert.equal(row.status,'ignored');assert.notEqual(row.text,original);assert.equal(f.admit(original).accepted,false);
});

test('a ledger full of active cases preserves them, reclaims old terminal delivery history, and still classifies ordinary chat',async t=>{
 const f=fixture(t);f.enable();await f.events.run(f.admit('我需要帮忙').id);const file=join(f.directory,'owner-attention.json'),state=JSON.parse(readFileSync(file,'utf8')),caseTemplate=state.cases[0],deliveryTemplate=state.deliveries[0];state.cases=Array.from({length:2000},(_,index)=>({...caseTemplate,id:'active-case-'+index,status:'open'}));state.deliveries=state.cases.flatMap((row,index)=>[0,1].map(part=>({...deliveryTemplate,key:'active-delivery-'+index+'-'+part,incidentId:row.id,status:'api_accepted'})));writeFileSync(file,JSON.stringify(state),{mode:0o600});f.advance(31*86400000);const restarted=f.make(),newCase=restarted.admit({sourceId:'full-important',text:'这是另一件需要帮忙的事',receivedAt:f.options.now(),memberScope:member});await assert.rejects(()=>restarted.run(newCase.id),/容量上限/);assert.equal(restarted.casesForOwner().length,2000);
 f.set(decision('普通聊聊天','ordinary-message',{decision:'ignore',evidence:[]}));const ordinary=restarted.admit({sourceId:'ordinary-message',text:'普通聊聊天',receivedAt:f.options.now(),memberScope:member});assert.equal((await restarted.run(ordinary.id)).status,'ignored');const saved=JSON.parse(readFileSync(file,'utf8'));assert.equal(saved.cases.length,2000);assert.equal(saved.deliveries.length,2000);assert.equal(f.sent.length,1);await restarted.close();
});

test('natural credential phrases are redacted before classification and notification, including short verification codes',async t=>{
 const f=fixture(t);f.enable();const text='我需要帮忙，验证码是834291，密码是SYNTHETIC_PASSWORD_27，银行卡为1234567890123456，账号等于99887766';await f.events.run(f.admit(text).id);assert.equal(f.sent.length,1);assert.doesNotMatch(JSON.stringify(f.classified.map(row=>row.text)),/834291|SYNTHETIC_PASSWORD_27|1234567890123456|99887766/);assert.doesNotMatch(f.sent[0].text,/834291|SYNTHETIC_PASSWORD_27|1234567890123456|99887766/);
});

test('a muted now incident can escalate for a different literal current danger but not a paraphrase of that same danger',async t=>{
 const f=fixture(t);f.enable();f.set(decision('我现在喘不过气了','message-1',{category:'safety',urgency:'now'}));await f.events.run(f.admit('我现在喘不过气了').id);const incident=f.events.casesForOwner()[0];f.events.mark({id:incident.id,status:'muted'});f.set(decision('我现在血流不止','message-2',{category:'safety',urgency:'now',relatedIncidentId:incident.id}));await f.events.run(f.admit('我现在血流不止','message-2').id);assert.equal(f.sent.length,2);f.events.mark({id:incident.id,status:'muted'});f.set(decision('我现在大出血','message-3',{category:'safety',urgency:'now',relatedIncidentId:incident.id}));await f.events.run(f.admit('我现在大出血','message-3').id);assert.equal(f.sent.length,2);
});

test('a classification failure exposes only a safe diagnostic and never creates an alert from keywords',async t=>{
 const f=fixture(t);f.enable();f.set(async()=>{throw Error('SYNTHETIC_PRIVATE_PROVIDER_DETAIL');});await f.events.run(f.admit('普通聊聊天').id);assert.equal(f.sent.length,0);assert.equal(typeof f.events.state().lastError,'string');assert.match(f.events.state().lastError,/分类/);assert.doesNotMatch(JSON.stringify(f.events.state()),/SYNTHETIC_PRIVATE_PROVIDER_DETAIL/);
 await f.events.run(f.admit('我现在喘不过气了，别告诉家里人','message-2').id);assert.equal(f.sent.length,0);assert.equal(f.events.casesForOwner().length,0);assert.equal(typeof f.events.state().lastError,'string');
});

test('a failed classifier cannot turn quoted, hypothetical, historical, negated or resolved danger into a literal fallback',async t=>{
 const f=fixture(t);f.enable();f.set('not JSON');let index=0;for(const text of['假设场景：\n我现在喘不过气了','他说：“我现在喘不过气了”','我以前喘不过气，现在没事了','我现在没有喘不过气','我现在喘不过气了，但已经获救','昨天的记录：\n我现在喘不过气了','我现在喘不过气了，这是昨天的旧消息'])await f.events.run(f.admit(text,'no-fallback-'+index++).id);assert.equal(f.sent.length,0);assert.equal(f.events.casesForOwner().length,0);assert.ok(f.events.state().lastError);
});

test('an aborted classifier records a safe aborted diagnostic and cannot issue a fallback',async t=>{
 const gate=deferred(),f=fixture(t);f.enable();f.set(async input=>{await gate.promise;input.signal.throwIfAborted();return decision(input.text,input.messageId,{category:'safety',urgency:'now'});});const running=f.events.run(f.admit('我现在喘不过气了').id);await new Promise(setImmediate);const closing=f.events.close();gate.resolve();await Promise.all([running,closing]);assert.equal(f.sent.length,0);assert.match(f.events.state().lastError,/中断/);
});

test('a later successful current-epoch classification clears the safe status diagnostic',async t=>{
 const f=fixture(t);f.enable();f.set('invalid JSON');await f.events.run(f.admit('普通聊天').id);assert.equal(typeof f.events.state().lastError,'string');f.set(decision('正常的新消息','message-2',{decision:'ignore',evidence:[]}));await f.events.run(f.admit('正常的新消息','message-2').id);assert.equal(f.events.state().lastError,null);
});

test('ordinary explicit keep-private phrases suppress a model notify decision in the ledger',async t=>{
 const f=fixture(t);f.enable();let index=0;for(const phrase of['这件事先保密','只告诉你','别外传']){const sourceId='private-'+index++,text='这件事需要家里帮忙，'+phrase;f.set(decision(text,sourceId));await f.events.run(f.admit(text,sourceId).id);}assert.equal(f.sent.length,0);assert.equal(f.events.casesForOwner().length,0);
});

test('an explicit keep-private phrase retains only the strict current personal danger exception',async t=>{
 const f=fixture(t);f.enable();const text='我现在喘不过气了，这件事先保密';f.set(decision('我现在喘不过气了','message-1',{category:'safety',urgency:'now'}));await f.events.run(f.admit(text).id);assert.equal(f.sent.length,1);assert.equal(f.sent[0].recipient,'owner');
});

test('a muted current danger recognizes a new same-sentence comma adjunct while respecting its negation',async t=>{
 const f=fixture(t);f.enable();f.set(decision('我现在无法呼吸','message-1',{category:'safety',urgency:'now'}));await f.events.run(f.admit('我现在无法呼吸').id);const incident=f.events.casesForOwner()[0];f.events.mark({id:incident.id,status:'muted'});
 const negated='我现在无法呼吸，但没有大出血';f.set(decision(negated,'message-2',{category:'safety',urgency:'now',relatedIncidentId:incident.id}));await f.events.run(f.admit(negated,'message-2').id);assert.equal(f.sent.length,1);
 const update='我现在无法呼吸，又开始大出血，需要马上有人来帮我';f.set(decision(update,'message-3',{category:'safety',urgency:'now',relatedIncidentId:incident.id}));await f.events.run(f.admit(update,'message-3').id);assert.equal(f.sent.length,2);assert.equal(f.events.casesForOwner()[0].status,'open');
});

test('a historical message header cannot produce an alert when AI classification fails',async t=>{
 const f=fixture(t);f.enable();f.set('not valid JSON');await f.events.run(f.admit('昨天我给你发过：\n我现在喘不过气了').id);assert.equal(f.sent.length,0);assert.equal(f.events.casesForOwner().length,0);assert.equal(typeof f.events.state().lastError,'string');
});
