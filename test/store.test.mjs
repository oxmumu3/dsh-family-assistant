import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
const fixed = '2026-10-21T00:00:00.000Z';
function setup() { const directory = mkdtempSync(join(tmpdir(),'family-store-')); return { directory, store:createStore({directory,now:()=>fixed}) }; }
function elder(s, id='elder') { return s.addPerson({id,role:'elder',label:'测试长辈',timeZone:'Asia/Shanghai'}); }
function bound(s,id='elder') { elder(s,id); return s.bindPerson(id,{accountId:'account-'+id,peerId:'peer-'+id}); }
test('new store is empty paused atomic private state and returns defensive clones',()=>{ const {store:s,directory}=setup(); assert.deepEqual(s.snapshot().people,[]); assert.equal(s.snapshot().config.paused,true); const p=elder(s); p.interests.push('mutation'); const state=s.snapshot(); state.people[0].label='bad'; assert.equal(s.person('elder').label,'测试长辈'); assert.deepEqual(s.person('elder').interests,[]); const reloaded=createStore({directory}); assert.equal(reloaded.person('elder').id,'elder'); assert.equal(statSync(join(directory,'family.json')).mode&0o777,0o600); });
test('person/config validation rejects unknown credentials malformed ids times timezones and duplicate owner',()=>{const {store:s}=setup(); for(const input of [{id:'../bad',role:'elder',label:'x'},{role:'elder',label:''},{role:'child',label:'x'},{role:'elder',label:'x',timeZone:'Moon/Sea'},{role:'elder',label:'x',token:'secret'}]) assert.throws(()=>s.addPerson(input)); s.addPerson({id:'owner',role:'owner',label:'Owner'}); assert.throws(()=>s.addPerson({role:'owner',label:'two'})); assert.throws(()=>s.configure({token:'x'})); assert.throws(()=>s.configure({ownerBriefTime:'25:00'})); assert.throws(()=>s.configure({paused:'false'})); assert.throws(()=>s.updatePerson('owner',{role:'elder'})); assert.equal(s.binding('owner'),null); assert.throws(()=>s.route('owner')); });
test('same binding preserves generation, real rebind cancels pending immutable routes, duplicate peer rejected',()=>{ const {store:s}=setup(); const route=bound(s); s.configure({paused:false}); const q=s.enqueue({personId:'elder',text:'hello',kind:'chat',sourceKey:'message-1'}); assert.equal(s.bindPerson('elder',{accountId:route.accountId,peerId:route.peerId}).generation,route.generation); assert.equal(s.pending().length,1); assert.deepEqual(s.enqueue({personId:'elder',text:'changed',kind:'chat',sourceKey:'message-1'}),q); elder(s,'other'); assert.throws(()=>s.bindPerson('other',{accountId:route.accountId,peerId:route.peerId})); const next=s.bindPerson('elder',{accountId:'new-account',peerId:'new-peer'}); assert.equal(next.generation,route.generation+1); assert.equal(s.snapshot().outbox[0].status,'cancelled'); assert.equal(q.route.peerId,'peer-elder'); assert.deepEqual(s.pending(),[]); });
test('inbound verifies peer and survives persistent per-person dedup without cross-person leakage',()=>{const {store:s,directory}=setup(); bound(s); bound(s,'other'); assert.equal(s.recordInbound('elder',{id:'m1',peerId:'foreign',text:'intruder'}).accepted,false); assert.equal(s.recordInbound('elder',{id:'m1',peerId:'peer-elder',text:'hello'}).accepted,true); assert.equal(s.recordInbound('elder',{id:'m1',peerId:'peer-elder',text:'again'}).accepted,false); assert.equal(s.recordInbound('other',{id:'m1',peerId:'peer-other',text:'other'}).accepted,true); assert.equal(createStore({directory}).recordInbound('elder',{id:'m1',peerId:'peer-elder',text:'restart'}).accepted,false); assert.equal(s.messages('elder').length,1); assert.equal(s.messages('other')[0].text,'other'); });
test('dispatch requires unpaused current unexpired route and explicit api acceptance before outgoing history',()=>{const {store:s}=setup(); bound(s); let q=s.enqueue({personId:'elder',text:'one',kind:'chat',sourceKey:'q1'}); assert.equal(s.transition(q.id,'dispatching').status,'blocked'); assert.equal(s.messages('elder').length,0); s.configure({paused:false}); q=s.enqueue({personId:'elder',text:'two',kind:'chat',sourceKey:'q2'}); assert.throws(()=>s.transition(q.id,'api_accepted')); assert.equal(s.transition(q.id,'dispatching').status,'dispatching'); assert.equal(s.transition(q.id,'api_accepted').status,'api_accepted'); assert.equal(s.transition(q.id,'api_accepted').status,'api_accepted'); assert.equal(s.messages('elder').length,1); assert.equal(s.messages('elder')[0].text,'two'); const old=s.enqueue({personId:'elder',text:'old',kind:'chat',sourceKey:'old',expiresAt:'2026-10-20T23:59:59Z'}); assert.equal(s.transition(old.id,'dispatching').status,'expired'); });
test('uncertain dispatch recovery persists and does not retry or claim a sent message',()=>{const {store:s,directory}=setup(); bound(s); s.configure({paused:false}); const q=s.enqueue({personId:'elder',text:'test',kind:'chat',sourceKey:'uncertain'}); s.transition(q.id,'dispatching'); const after=createStore({directory,now:()=>fixed}); assert.equal(after.recoverDispatching().length,1); assert.equal(after.snapshot().outbox[0].status,'uncertain'); assert.deepEqual(after.pending(),[]); assert.deepEqual(after.messages('elder'),[]); });
test('reminders validate and remain person-scoped with restricted system updates',()=>{const {store:s}=setup(); elder(s); elder(s,'other'); for(const patch of [{text:''},{dueAt:'tomorrow'},{dueAt:'2026-02-31T10:00:00Z'},{repeat:'weekly'},{time:'24:00'},{timeZone:'Bad/Zone'}]) assert.throws(()=>s.addReminder({personId:'elder',text:'测试提醒',dueAt:'2026-10-21T01:00:00Z',repeat:'once',...patch})); const r=s.addReminder({personId:'elder',text:'喝水',dueAt:'2026-10-21T01:00:00Z',repeat:'daily',time:'09:00'}); assert.equal(r.status,'active'); assert.equal(r.timeZone,'Asia/Shanghai'); assert.throws(()=>s.cancelReminder('other',r.id)); assert.throws(()=>s.markReminder(r.id,{text:'changed'})); assert.equal(s.cancelReminder('elder',r.id).status,'cancelled'); assert.deepEqual(s.reminders('other'),[]); });
test('corrupt or credential-bearing persisted state fails closed',()=>{const {store:s,directory}=setup(); elder(s); let state=s.snapshot(); state.config.token='secret'; writeFileSync(join(directory,'family.json'),JSON.stringify(state)); assert.throws(()=>createStore({directory})); assert.match(readFileSync(join(directory,'family.json'),'utf8'),/secret/); });
test('account or peer reuse across different members is rejected independently',()=>{const {store:s}=setup();bound(s);elder(s,'other');assert.throws(()=>s.bindPerson('other',{accountId:'account-elder',peerId:'different-peer'}));assert.throws(()=>s.bindPerson('other',{accountId:'different-account',peerId:'peer-elder'}));});
test('revoking sharing cancels pending owner brief so previously copied private content cannot send',()=>{const {store:s}=setup();bound(s);s.addPerson({id:'owner',role:'owner',label:'Owner'});s.bindPerson('owner',{accountId:'a-owner',peerId:'p-owner'});s.updatePerson('elder',{shareWithOwner:'full'});s.configure({paused:false});const queued=s.enqueue({personId:'owner',text:'private full excerpt',kind:'owner_brief',sourceKey:'manual-brief-1'});s.updatePerson('elder',{shareWithOwner:'none'});assert.equal(s.snapshot().outbox.find(o=>o.id===queued.id).status,'cancelled');assert.throws(()=>s.transition(queued.id,'dispatching'));});
test('pending text enrichment is cloned and cannot modify dispatching content or exceed transport limit',()=>{const {store:s}=setup();bound(s);s.configure({paused:false});const q=s.enqueue({personId:'elder',text:'template',kind:'elder_daily',sourceKey:'daily-template'});const result=s.updatePendingText(q.id,'个性化内容');result.text='mutation';assert.equal(s.pending()[0].text,'个性化内容');assert.throws(()=>s.updatePendingText(q.id,'x'.repeat(3201)));s.updatePerson('elder',{dailyEnabled:true});s.transition(q.id,'dispatching');assert.throws(()=>s.updatePendingText(q.id,'too late'));});
test('terminal send failures do not add history and in-flight rebinding never permits stale success',()=>{const {store:s}=setup();bound(s);s.configure({paused:false});const q=s.enqueue({personId:'elder',text:'reject me',kind:'chat',sourceKey:'rejected'});s.transition(q.id,'dispatching');assert.equal(s.transition(q.id,'failed','业务拒绝').status,'failed');assert.deepEqual(s.messages('elder'),[]);const racing=s.enqueue({personId:'elder',text:'racing',kind:'chat',sourceKey:'racing'});s.transition(racing.id,'dispatching');s.bindPerson('elder',{accountId:'a-new',peerId:'p-new'});assert.equal(s.snapshot().outbox.find(o=>o.id===racing.id).status,'uncertain');assert.throws(()=>s.transition(racing.id,'api_accepted'));});
test('successful connection status clears obsolete error text while preserving activity metadata',()=>{const {store:s}=setup();bound(s);s.setConnection('elder',{status:'error',lastError:'旧错误',lastInboundAt:fixed});s.setConnection('elder',{status:'connected'});assert.equal(s.binding('elder').lastError,undefined);assert.equal(s.binding('elder').lastInboundAt,fixed);});

test('member reminder edit keeps canonical ID and original time for text-only changes',()=>{
 const {store:s,directory}=setup();bound(s);elder(s,'other');
 const r=s.addReminder({personId:'elder',text:'散步',dueAt:'2026-10-22T01:00:00Z'});
 assert.throws(()=>s.updateReminder('other',r.id,{text:'越权'},{requestId:'u0'}),/其他成员/);
 const updated=s.updateReminder('elder',r.id,{text:'公园散步'},{requestId:'u1'});
 assert.equal(updated.id,r.id);assert.equal(updated.dueAt,r.dueAt);assert.equal(updated.text,'公园散步');
 s.updateReminder('elder',r.id,{text:'慢走'},{requestId:'u2'});
 const reloaded=createStore({directory,now:()=>fixed});
 assert.equal(reloaded.updateReminder('elder',r.id,{text:'公园散步'},{requestId:'u1'}).text,'慢走');
 assert.throws(()=>s.updateReminder('elder',r.id,{personId:'other'},{requestId:'bad'}));
});

test('reschedule atomically cancels old pending occurrence and never retracts an in-flight alarm',()=>{
 const {store:s}=setup();bound(s);s.configure({paused:false});
 const r=s.addReminder({personId:'elder',text:'散步',dueAt:'2026-10-21T01:00:00Z'});
 const pending=s.enqueue({personId:'elder',text:'旧提醒',kind:'reminder',sourceKey:`reminder:${r.id}:${r.dueAt}`});
 const updated=s.updateReminder('elder',r.id,{dueAt:'2026-10-22T01:00:00Z'},{requestId:'move'});
 assert.equal(updated.id,r.id);assert.equal(s.snapshot().outbox.find(o=>o.id===pending.id).status,'cancelled');
 assert.throws(()=>s.updateReminder('elder',r.id,{dueAt:r.dueAt},{requestId:'reuse'}),/发生|使用|处理/);
 const inFlight=s.enqueue({personId:'elder',text:'新提醒',kind:'reminder',sourceKey:`reminder:${r.id}:${updated.dueAt}`});s.transition(inFlight.id,'dispatching');
 assert.throws(()=>s.updateReminder('elder',r.id,{dueAt:'2026-10-23T01:00:00Z'},{requestId:'late'}),/发送|确认/);
 assert.equal(s.reminders('elder')[0].dueAt,updated.dueAt);assert.equal(s.snapshot().outbox.find(o=>o.id===inFlight.id).status,'dispatching');
});

test('message binding generation is server derived for inbound, manual and accepted outbound history',()=>{
 const {store:s,directory}=setup();bound(s);s.configure({paused:false});
 assert.equal(s.recordInbound('elder',{id:'private-old',peerId:'peer-elder',text:'私密旧便条'}).message.bindingGeneration,1);
 assert.equal(s.addMessage('elder',{dir:'out',text:'旧偏好确认'}).bindingGeneration,1);
 const queued=s.enqueue({personId:'elder',text:'旧回复',kind:'chat',sourceKey:'old-reply'});s.transition(queued.id,'dispatching');s.transition(queued.id,'api_accepted');assert.equal(s.messages('elder').at(-1).bindingGeneration,1);
 assert.throws(()=>s.addMessage('elder',{dir:'in',text:'伪造',bindingGeneration:1}),/字段/);
 assert.throws(()=>s.recordInbound('elder',{id:'forged',peerId:'peer-elder',text:'伪造',bindingGeneration:1}),/字段/);
 s.bindPerson('elder',{accountId:'new-account',peerId:'new-peer'});assert.equal(s.recordInbound('elder',{id:'new-chat',peerId:'new-peer',text:'新成员'}).message.bindingGeneration,2);
 const reloaded=createStore({directory,now:()=>fixed});assert.deepEqual(reloaded.messages('elder').map(row=>row.bindingGeneration),[1,1,1,2]);
 const state=s.snapshot();state.messages[0].bindingGeneration=0;writeFileSync(join(directory,'family.json'),JSON.stringify(state));assert.throws(()=>createStore({directory}),/版本|绑定/);
});

test('new reminders capture the trusted binding and cannot be edited or cancelled by a replacement binding',()=>{
 const {store:s}=setup();bound(s);const reminder=s.addReminder({personId:'elder',text:'旧账号安排',dueAt:'2026-10-22T01:00:00Z'});assert.equal(reminder.bindingGeneration,1);
 assert.throws(()=>s.addReminder({personId:'elder',text:'伪造',dueAt:'2026-10-22T01:00:00Z',bindingGeneration:1}),/字段/);
 s.bindPerson('elder',{accountId:'replacement',peerId:'replacement-peer'});
 assert.throws(()=>s.updateReminder('elder',reminder.id,{text:'修改旧安排'},{requestId:'forbidden'}),/绑定|当前/);
 assert.throws(()=>s.cancelReminder('elder',reminder.id),/绑定|当前/);
 assert.equal(s.reminders('elder')[0].status,'active');assert.equal(s.addReminder({personId:'elder',text:'新账号安排',dueAt:'2026-10-23T01:00:00Z'}).bindingGeneration,2);
});
