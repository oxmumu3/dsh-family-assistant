import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,statSync,symlinkSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';
const instant='2026-10-25T03:00:00.000Z'; // 24 Oct 21:00 in Mexico City.
async function setup(){
 const {createPersonalOrganizer}=await import('../src/personal-organizer.mjs');
 const directory=mkdtempSync(join(tmpdir(),'organizer-synthetic-')),store=createStore({directory,now:()=>instant});
 for(const id of ['me','other']){store.addPerson({id,role:'elder',label:'合成成员',timeZone:'America/Mexico_City'});store.bindPerson(id,{accountId:'a-'+id,peerId:'p-'+id});}
 return{directory,store,create:()=>createPersonalOrganizer({directory,store,now:()=>instant}),organizer:createPersonalOrganizer({directory,store,now:()=>instant})};
}
const memory=(text,evidence='帮我记住：'+text)=>({type:'remember',text,evidence});
const command=(organizer,text,action,requestId='m1',personId='me')=>organizer.execute({personId,text,action,requestId});

test('notes persist exact current quote privately and query older notes without chat history',async()=>{
 const {organizer:o,store,create,directory}=await setup();
 const source='帮我记住：备用钥匙在蓝色抽屉';
 const saved=command(o,source,memory('备用钥匙在蓝色抽屉'));
 assert.match(saved.reply,/记下/);assert.equal(o.context('me').notes[0].text,'备用钥匙在蓝色抽屉');
 assert.deepEqual(o.context('other').notes,[]);assert.doesNotMatch(JSON.stringify(store.snapshot()),/蓝色抽屉/);
 for(let i=0;i<35;i++)command(o,'记住：合成条目'+i,memory('合成条目'+i,'记住：合成条目'+i),'n'+i);
 const result=command(create(),'备用钥匙放哪了',{type:'search_notes',query:'备用钥匙'},'search');
 assert.match(result.reply,/蓝色抽屉/);assert.equal(statSync(join(directory,'personal-organizer.json')).mode&0o777,0o600);
});

test('notes reject invented content, invalid fields, accidental memory and cross-member forgetting',async()=>{
 const {organizer:o}=await setup();
 assert.throws(()=>command(o,'今天很忙',memory('今天很忙','今天很忙')),/明确|记住/);
 assert.throws(()=>command(o,'记住：钥匙在抽屉',memory('钥匙在保险箱','记住：钥匙在抽屉')),/原话|依据/);
 assert.throws(()=>command(o,'记住：钥匙在抽屉',{...memory('钥匙在抽屉','记住：钥匙在抽屉'),personId:'other'}),/字段|参数/);
 command(o,'记住：钥匙在抽屉',memory('钥匙在抽屉','记住：钥匙在抽屉'));
 const note=o.context('me').notes[0];
 assert.throws(()=>command(o,'忘掉钥匙在抽屉',{type:'forget_note',noteId:note.id,evidence:'忘掉钥匙在抽屉'},'f1','other'),/本人|找到/);
 assert.throws(()=>command(o,'钥匙在抽屉',{type:'forget_note',noteId:note.id,evidence:'钥匙在抽屉'},'f2'),/明确|忘/);
 command(o,'忘掉钥匙在抽屉',{type:'forget_note',noteId:note.id,evidence:'忘掉钥匙在抽屉'},'f3');
 assert.deepEqual(o.context('me').notes,[]);
 assert.doesNotMatch(readFileSync(o.file,'utf8'),/钥匙在抽屉/);
 command(o,'记住：钥匙在抽屉',memory('钥匙在抽屉','记住：钥匙在抽屉')); // replay cannot resurrect.
 assert.deepEqual(o.context('me').notes,[]);
});

test('notes from a former binding never appear to a new peer or generation',async()=>{
 const {organizer:o,store,create}=await setup();
 command(o,'记住：合成私密便条',memory('合成私密便条','记住：合成私密便条'));
 store.bindPerson('me',{accountId:'new-account',peerId:'new-peer'});
 assert.deepEqual(o.context('me').notes,[]);assert.deepEqual(create().context('me').notes,[]);
 assert.doesNotMatch(command(o,'我记过什么',{type:'search_notes',query:''},'search').reply,/合成私密/);
});

test('notes reject symlink state, unsafe mode and oversized or unknown persisted fields',async()=>{
 const {directory,create}=await setup(),file=join(directory,'personal-organizer.json');
 const original=readFileSync(file,'utf8');chmodSync(file,0o644);assert.throws(create,/权限|私有/);chmodSync(file,0o600);
 writeFileSync(file,JSON.stringify({...JSON.parse(original),token:'secret'}));assert.throws(create,/字段|格式/);
 writeFileSync(file,' '.repeat(2*1024*1024));assert.throws(create,/容量/);
 writeFileSync(file,original);const target=join(directory,'target.json');writeFileSync(target,original);const fs=await import('node:fs');fs.unlinkSync(file);symlinkSync(target,file);assert.throws(create,/链接|路径/);
});

test('calendar edit preserves time for exact grounded text changes and dedups across restart',async()=>{
 const {organizer:o,store,create}=await setup();
 const r=store.addReminder({personId:'me',text:'散步',dueAt:'2026-10-26T15:00:00Z'});
 const action={type:'update_reminder',reminderId:r.id,patch:{text:'公园慢走'},evidence:'把散步改成公园慢走'};
 assert.match(command(o,'把散步改成公园慢走',action,'edit').reply,/已修改/);
 assert.equal(store.reminders('me')[0].dueAt,r.dueAt);
 create().execute({personId:'me',text:'把散步改成公园慢走',action,requestId:'edit'});
 assert.equal(store.reminders('me').length,1);
 assert.throws(()=>command(o,'把散步改成公园慢走',{...action,reminderId:'invented'},'bad'),/本人|找到/);
});

test('calendar dates use current member timezone and reject invented reschedule clocks',async()=>{
 const {organizer:o,store}=await setup();
 const r=store.addReminder({personId:'me',text:'散步',dueAt:'2026-10-26T15:00:00Z'});
 const action={type:'update_reminder',reminderId:r.id,patch:{dueAt:'2026-10-25T21:00:00Z'},evidence:'把散步改到明天下午三点',timeEvidence:'明天下午三点'};
 command(o,'把散步改到明天下午三点',action,'move'); // Mexico tomorrow is Oct 25, not Oct 26 UTC.
 assert.equal(store.reminders('me')[0].dueAt,'2026-10-25T21:00:00.000Z');
 for(const [text,dueAt] of [['把散步改到明天','2026-10-26T21:00:00Z'],['把散步改到明天下午三点','2026-10-26T21:00:00Z'],['把散步改一下','2026-10-25T21:30:00Z']])assert.throws(()=>command(o,text,{...action,patch:{dueAt},evidence:text,timeEvidence:text},'bad'+text),/时间|明确|原话|一致/);
});

test('latest reminder reference requires one uniquely latest active event',async()=>{
 const {organizer:o,store}=await setup();
 const a=store.addReminder({personId:'me',text:'散步',dueAt:'2026-10-26T15:00:00Z'});
 command(o,'把刚才那条改成公园慢走',{type:'update_reminder',reminderId:a.id,patch:{text:'公园慢走'},evidence:'把刚才那条改成公园慢走'},'one');
 const b=store.addReminder({personId:'me',text:'买菜',dueAt:'2026-10-27T15:00:00Z'});
 assert.throws(()=>command(o,'取消刚才那条',{type:'cancel',reminderId:b.id},'two'),/具体|不止|歧义/);
 assert.equal(store.reminders('me').filter(r=>r.status==='active').length,2);
});

test('calendar creates grounded reminders once and lists the current local week',async()=>{
 const {organizer:o,store}=await setup();
 const action={type:'remind',text:'买菜',dueAt:'2026-10-25T15:00:00Z',repeat:'once',timeEvidence:'明天上午九点'};
 command(o,'明天上午九点提醒我买菜',action,'create');command(o,'明天上午九点提醒我买菜',action,'create');
 assert.equal(store.reminders('me').length,1);
 store.addReminder({personId:'me',text:'下月行程',dueAt:'2026-11-04T15:00:00Z'});
 const listed=command(o,'这周有什么事',{type:'list',query:'这周'},'list');assert.match(listed.reply,/买菜/);assert.doesNotMatch(listed.reply,/下月行程/);
 assert.throws(()=>command(o,'明天提醒我买菜',{...action,timeEvidence:'明天'},'vague'),/时间|明确/);
});

test('negative forgetting never deletes notes and conditional note contents are stored verbatim',async()=>{
 const {organizer:o}=await setup();
 command(o,'记住：如果下雨带伞',memory('如果下雨带伞','记住：如果下雨带伞'),'conditional');
 const note=o.context('me').notes[0];
 assert.throws(()=>command(o,'不要忘记如果下雨带伞',{type:'forget_note',noteId:note.id,evidence:'不要忘记如果下雨带伞'},'negative'),/明确|尚未/);
 assert.equal(o.context('me').notes[0].text,'如果下雨带伞');
});

test('rescheduled alarm produces only the new occurrence while old pending alarm remains cancelled',async()=>{
 const {organizer:o,store}=await setup();const {scheduleTick}=await import('../src/scheduler.mjs');store.configure({paused:false});
 const r=store.addReminder({personId:'me',text:'散步',dueAt:instant});scheduleTick(store,{now:instant});
 assert.equal(store.pending().filter(row=>row.kind==='reminder').length,1);
 command(o,'把散步改到明天下午三点',{type:'update_reminder',reminderId:r.id,patch:{dueAt:'2026-10-25T21:00:00Z'},evidence:'把散步改到明天下午三点'},'reschedule');
 assert.equal(store.pending().length,0);scheduleTick(store,{now:'2026-10-25T21:00:00Z'});scheduleTick(store,{now:'2026-10-25T21:00:01Z'});
 assert.equal(store.pending().filter(row=>row.kind==='reminder').length,1);assert.equal(store.snapshot().outbox.filter(row=>row.status==='cancelled').length,1);
});

test('time grounding rejects fabricated seconds and alternative DST occurrence for a stated wall clock',async()=>{
 const {organizer:o,store}=await setup();
 assert.throws(()=>command(o,'明天上午九点提醒我买菜',{type:'remind',text:'买菜',dueAt:'2026-10-25T15:00:42Z'},'seconds'),/时间|一致/);
 assert.equal(store.reminders('me').length,0);
 store.updatePerson('me',{timeZone:'America/New_York'});
 assert.throws(()=>command(o,'2026-11-01凌晨一点半提醒我散步',{type:'remind',text:'散步',dueAt:'2026-11-01T06:30:00Z'},'dst'),/时间|一致/);
});

test('unique partial subject resolves an older note or reminder without repeating its full stored sentence',async()=>{
 const {organizer:o,store}=await setup();
 command(o,'帮我记住：备用钥匙在蓝色抽屉',memory('备用钥匙在蓝色抽屉'),'remember-keys');
 const note=o.context('me').notes[0];command(o,'忘掉备用钥匙那条',{type:'forget_note',noteId:note.id,evidence:'忘掉备用钥匙那条'},'forget-keys');
 assert.deepEqual(o.context('me').notes,[]);
 const reminder=store.addReminder({personId:'me',text:'去医院挂号',dueAt:'2026-10-26T15:00:00Z'});
 command(o,'把去医院改成去公园',{type:'update_reminder',reminderId:reminder.id,patch:{text:'去公园'},evidence:'把去医院改成去公园'},'partial-edit');
 assert.equal(store.reminders('me')[0].text,'去公园');
});

test('durable note search and calendar lists stay within WeChat transport size for long records',async()=>{
 const {organizer:o,store}=await setup();
 for(let i=0;i<8;i++){const text='合成便条'+i+'甲'.repeat(1400);command(o,'记住：'+text,memory(text,'记住：'+text),'long-'+i);}
 const searched=command(o,'列出我的记录',{type:'search_notes',query:''},'search-long');assert.ok(searched.reply.length<=3200);assert.match(searched.reply,/具体|关键词/);
 for(let i=0;i<30;i++)store.addReminder({personId:'me',text:'合成安排'+i+'乙'.repeat(800),dueAt:'2026-10-26T15:00:00Z'});
 const listed=command(o,'查看全部安排',{type:'list'},'list-long');assert.ok(listed.reply.length<=3200);assert.match(listed.reply,/查询|具体|日期/);
});

test('calendar list can query an explicit date or literal subject across all reminders',async()=>{
 const {organizer:o,store}=await setup();
 store.addReminder({personId:'me',text:'公园散步',dueAt:'2026-10-26T15:00:00Z'});store.addReminder({personId:'me',text:'买菜',dueAt:'2026-10-27T15:00:00Z'});
 const dateResult=command(o,'看看2026-10-26的安排',{type:'list',query:'2026-10-26'},'date-list');assert.match(dateResult.reply,/公园散步/);assert.doesNotMatch(dateResult.reply,/买菜/);
 const subjectResult=command(o,'散步安排在什么时候',{type:'list',query:'散步'},'subject-list');assert.match(subjectResult.reply,/公园散步/);assert.doesNotMatch(subjectResult.reply,/买菜/);
});

const localWeekBoundary='2026-10-26T01:00:00.000Z'; // Mexico Sunday evening; Shanghai Monday morning.
async function atLocalWeek(timeZone){const setupResult=await setup();setupResult.store.updatePerson('me',{timeZone});const {createPersonalOrganizer}=await import('../src/personal-organizer.mjs');return{...setupResult,organizer:createPersonalOrganizer({directory:setupResult.directory,store:setupResult.store,now:()=>localWeekBoundary})};}

test('next weekday calendar creation uses each member local ISO week around UTC midnight',async()=>{
 for(const [zone,dueAt] of [['America/Mexico_City','2026-10-30T16:00:00Z'],['Asia/Shanghai','2026-11-06T02:00:00Z']]){
  const {organizer:o,store}=await atLocalWeek(zone);
  const text='下周五上午十点社区开会，帮我记一下';
  command(o,text,{type:'remind',text:'社区开会',dueAt,timeEvidence:'下周五上午十点'},'next-friday');
  assert.equal(store.reminders('me')[0].dueAt,new Date(dueAt).toISOString());assert.equal(store.reminders('me')[0].repeat,'once');
 }
});

test('weekday reschedule supports 本周星期日 and 这周周五 without changing canonical reminder ID',async()=>{
 for(const [zone,dueAt] of [['America/Mexico_City','2026-10-26T04:00:00Z'],['Asia/Shanghai','2026-11-01T14:00:00Z']]){
  const {organizer:o,store}=await atLocalWeek(zone),r=store.addReminder({personId:'me',text:'社区开会',dueAt:'2026-11-10T02:00:00Z'});
  const text='把社区开会改到本周星期日晚上十点';command(o,text,{type:'update_reminder',reminderId:r.id,patch:{dueAt},evidence:text,timeEvidence:'本周星期日晚上十点'},'this-sunday');
  assert.equal(store.reminders('me')[0].id,r.id);assert.equal(store.reminders('me')[0].dueAt,new Date(dueAt).toISOString());
 }
 const {organizer:o,store}=await atLocalWeek('Asia/Shanghai'),r=store.addReminder({personId:'me',text:'散步',dueAt:'2026-11-10T02:00:00Z'});
 const text='把散步改到这周周五上午十点';command(o,text,{type:'update_reminder',reminderId:r.id,patch:{dueAt:'2026-10-30T02:00:00Z'},evidence:text},'this-friday');assert.equal(store.reminders('me')[0].dueAt,'2026-10-30T02:00:00.000Z');
});

test('weekday dates and clock evidence reject hallucinated weeks, past local dates, vague clocks and weekly recurrence',async()=>{
 const {organizer:o,store}=await atLocalWeek('America/Mexico_City');
 for(const [text,dueAt,error] of [
  ['下周五上午十点提醒我社区开会','2026-11-06T16:00:00Z',/时间|一致/],
  ['这周五上午十点提醒我社区开会','2026-10-23T16:00:00Z',/过去|时间/],
  ['下周五十点社区开会，帮我记一下','2026-10-30T16:00:00Z',/时间|明确/],
  ['下周五提醒我社区开会','2026-10-30T16:00:00Z',/时间|明确/],
  ['周五上午十点提醒我社区开会','2026-10-30T16:00:00Z',/本周|下周|明确/],
  ['下下周五上午十点提醒我社区开会','2026-11-06T16:00:00Z',/时间|明确|下周/],
  ['每周五上午十点提醒我社区开会','2026-10-30T16:00:00Z',/每周|重复|支持/],
  ['下周五和下周日都是上午十点提醒我社区开会','2026-10-30T16:00:00Z',/时间|明确|一项/],
 ])assert.throws(()=>command(o,text,{type:'remind',text:'社区开会',dueAt,repeat:'once'},'bad-'+text),error);
 assert.deepEqual(store.reminders('me'),[]);
});

test('next 星期天 on local Sunday belongs to the following ISO week',async()=>{
 const {organizer:o,store}=await atLocalWeek('America/Mexico_City');
 const text='下星期天上午十点提醒我社区开会';command(o,text,{type:'remind',text:'社区开会',dueAt:'2026-11-01T16:00:00Z'},'next-sunday');assert.equal(store.reminders('me')[0].dueAt,'2026-11-01T16:00:00.000Z');
});

test('weekday list filters the exact grounded local date instead of the entire week',async()=>{
 const {organizer:o,store}=await atLocalWeek('America/Mexico_City');
 store.addReminder({personId:'me',text:'周五社区开会',dueAt:'2026-10-30T16:00:00Z'});store.addReminder({personId:'me',text:'周六买菜',dueAt:'2026-10-31T16:00:00Z'});
 const result=command(o,'下周五有什么安排',{type:'list',query:'下周五'},'weekday-list');assert.match(result.reply,/社区开会/);assert.doesNotMatch(result.reply,/买菜/);
});

test('replacement peer cannot query, select, edit or cancel previous binding calendar records',async()=>{
 const {organizer:o,store}=await setup();const reminder=store.addReminder({personId:'me',text:'旧账号私密日程',dueAt:'2026-10-26T15:00:00Z'});
 store.bindPerson('me',{accountId:'replacement',peerId:'replacement-peer'});assert.deepEqual(o.context('me').reminders,[]);
 assert.doesNotMatch(command(o,'查全部安排',{type:'list'},'new-list').reply,/旧账号/);
 assert.throws(()=>command(o,'取消旧账号私密日程',{type:'cancel',reminderId:reminder.id},'new-cancel'),/本人|当前|绑定/);
 assert.throws(()=>command(o,'把旧账号私密日程改成散步',{type:'update_reminder',reminderId:reminder.id,patch:{text:'散步'},evidence:'把旧账号私密日程改成散步'},'new-edit'),/本人|当前|绑定/);
 assert.equal(store.reminders('me')[0].status,'active');
});
