import test from 'node:test';
import assert from 'node:assert/strict';

const load=()=>import('../src/owner-commands.mjs');
const people=[
  {id:'owner',role:'owner',label:'我',timeZone:'America/Mexico_City'},
  {id:'mom',role:'elder',label:'妈妈',timeZone:'Asia/Shanghai',binding:{status:'connected'}},
  {id:'dad',role:'elder',label:'爸爸',timeZone:'Asia/Shanghai',binding:{status:'connected'}},
];
const owner={...people[0],notes:'OWNER_PROFILE_PRIVATE'};
function host(output,{finish='stop'}={}){
  let captured,calls=0;
  const llm={async *stream(options){calls++;captured=options;yield{type:'reasoning-delta',index:0,text:'not public'};yield{type:'text-delta',index:1,text:typeof output==='string'?output:JSON.stringify(output)};yield{type:'finish',reason:finish};}};
  return {ctx:{get:()=>llm},readConfig:()=>({provider:'test',model:'test'}),captured:()=>captured,calls:()=>calls};
}

test('parent aliases resolve only to a unique explicitly named registered elder',async()=>{
  const {resolveOwnerTarget}=await load();
  assert.equal(resolveOwnerTarget(people,'我妈','给我妈发今天的日报').id,'mom');
  assert.equal(resolveOwnerTarget(people,'父亲','明天八点提醒父亲浇花').id,'dad');
  assert.throws(()=>resolveOwnerTarget(people,'妈妈','给我妈发今天的日报'),/原话|明确|对象/);
  assert.throws(()=>resolveOwnerTarget(people,'姥姥','给姥姥发日报'),/登记|添加|找到/);
  assert.throws(()=>resolveOwnerTarget(people,'owner','给owner发日报'),/登记|添加|长辈|找到/);
});

test('duplicate labels and instructions naming multiple people never select a fallback',async()=>{
  const {resolveOwnerTarget}=await load();
  assert.throws(()=>resolveOwnerTarget([...people,{...people[1],id:'mom2'}],'我妈','给我妈发日报'),/多|不止|明确/);
  assert.throws(()=>resolveOwnerTarget(people,'妈妈','给妈妈和爸爸都发日报'),/一位|多个|分别/);
  assert.throws(()=>resolveOwnerTarget(people,'妈妈','给妈妈和姥姥都发日报'),/一位|多个|分别/);
});

test('explicit time requires a current verbatim clock or numeric relative interval',async()=>{
  const {hasExplicitOwnerTime}=await load();
  for(const evidence of ['明早八点','明天08:30','晚上八点半','30分钟后','半小时后','两小时以后','每天上午九点'])assert.equal(hasExplicitOwnerTime('请在'+evidence+'提醒爸爸浇花',evidence),true,evidence);
  for(const evidence of ['明早','明天','睡前','饭后','一会儿','几个小时后','99点','1000点','25:00','八点左右','0分钟后'])assert.equal(hasExplicitOwnerTime('请在'+evidence+'提醒爸爸浇花',evidence),false,evidence);
  assert.equal(hasExplicitOwnerTime('明早提醒爸爸浇花','明早八点'),false);
});

test('candidate routing leaves personal reminders and ordinary Owner chat on their existing path',async()=>{
  const {isOwnerCommandCandidate}=await load();
  for(const text of ['给我妈推送一个日报','明早八点提醒我爸浇花','帮妈妈设置提醒','给姥姥发日报'])assert.equal(isOwnerCommandCandidate(text,people),true,text);
  for(const text of ['你好','今日简报','我妈最近怎么样','明早8点提醒我散步','明天八点提醒我买给妈妈的礼物'])assert.equal(isOwnerCommandCandidate(text,people),false,text);
  assert.equal(isOwnerCommandCandidate('给王阿姨发日报',[...people,{id:'aunt',role:'elder',label:'王阿姨'}]),true);
});

test('owner planner sends only the minimal roster and current instruction to its model',async()=>{
  const {createHostOwnerPlanner}=await load();
  const h=host({reply:'准备按你的要求发送。',action:{type:'send_daily',target:'我妈'}});
  const planner=createHostOwnerPlanner(h.ctx,h.readConfig);
  const result=await planner({owner,text:'给我妈推送今天的日报',people:people.map(p=>({...p,notes:'ELDER_PROFILE_PRIVATE',interests:['PRIVATE_INTEREST'],history:['PRIVATE_HISTORY'],binding:{status:'connected',token:'PRIVATE_TOKEN',peerId:'PRIVATE_PEER'}})),now:'2026-10-22T15:00:00Z'});
  assert.equal(result.action.type,'send_daily');
  const input=JSON.stringify(h.captured());
  for(const marker of ['OWNER_PROFILE_PRIVATE','ELDER_PROFILE_PRIVATE','PRIVATE_INTEREST','PRIVATE_HISTORY','PRIVATE_TOKEN','PRIVATE_PEER'])assert.equal(input.includes(marker),false,marker);
  assert.deepEqual(h.captured().tools,[]);assert.equal(h.captured().provider,'test');
  assert.match(input,/Asia\/Shanghai/);
});

test('planner accepts a fully specified reminder and preserves current time evidence',async()=>{
  const {createHostOwnerPlanner}=await load();
  const output={reply:'准备安排。',action:{type:'remind',target:'爸爸',text:'浇花',date:'2026-10-23',time:'08:00',repeat:'once',timeEvidence:'明早八点'}};
  const h=host(output);const planner=createHostOwnerPlanner(h.ctx,h.readConfig);
  assert.deepEqual(await planner({owner,text:'明早八点提醒爸爸浇花',people,now:'2026-10-22T15:00:00Z'}),output);
});

test('missing time is a clarification, and a model cannot invent evidence or a recipient',async()=>{
  const {createHostOwnerPlanner}=await load();
  const h=host({reply:'请补充具体几点提醒爸爸。',action:null});
  assert.deepEqual(await createHostOwnerPlanner(h.ctx,h.readConfig)({owner,text:'给爸爸提醒浇花',people,now:'2026-10-22T15:00:00Z'}),{reply:'请补充具体几点提醒爸爸。',action:null});
  const base={type:'remind',target:'爸爸',text:'浇花',date:'2026-10-23',time:'08:00',repeat:'once',timeEvidence:'明早'};
  for(const action of [base,{...base,timeEvidence:'明早八点'},{type:'send_daily',target:'妈妈'}]){
    const bad=host({reply:'准备处理。',action});
    await assert.rejects(()=>createHostOwnerPlanner(bad.ctx,bad.readConfig)({owner,text:'明早提醒爸爸浇花',people,now:'2026-10-22T15:00:00Z'}),/时间|原话|明确|对象|日报/);
  }
});

test('invalid model schemas, truncated results, and unsupported actions fail closed',async()=>{
  const {createHostOwnerPlanner}=await load();
  const actions=[{type:'send_daily',target:'我妈',personId:'dad'},{type:'cancel',target:'我妈'},{type:'remind',target:'我妈',text:'浇花',date:'2026-02-31',time:'08:00',repeat:'once',timeEvidence:'明天八点'}];
  for(const action of actions){const h=host({reply:'准备处理。',action});await assert.rejects(()=>createHostOwnerPlanner(h.ctx,h.readConfig)({owner,text:'明天八点提醒我妈浇花并发日报',people,now:'2026-10-22T15:00:00Z'}),/格式|字段|日期|参数|操作/);}
  for(const output of ['{"reply":"准备","action":',JSON.stringify({reply:'准备',action:null,other:'extra'})]){const h=host(output);await assert.rejects(()=>createHostOwnerPlanner(h.ctx,h.readConfig)({owner,text:'给我妈发日报',people,now:'2026-10-22T15:00:00Z'}),/JSON|格式|字段/);}
  const truncated=host({reply:'准备',action:null},{finish:'length'});await assert.rejects(()=>createHostOwnerPlanner(truncated.ctx,truncated.readConfig)({owner,text:'给我妈发日报',people,now:'2026-10-22T15:00:00Z'}),/完整|结束/);
});

test('only an actual Owner can invoke the planner and null plans cannot claim execution',async()=>{
  const {createHostOwnerPlanner}=await load();
  const h=host({reply:'已发送日报。',action:null});const planner=createHostOwnerPlanner(h.ctx,h.readConfig);
  await assert.rejects(()=>planner({owner:people[1],text:'给爸爸发日报',people,now:'2026-10-22T15:00:00Z'}),/Owner|接收人|权限/);assert.equal(h.calls(),0);
  await assert.rejects(()=>planner({owner,text:'给我妈发日报',people,now:'2026-10-22T15:00:00Z'}),/执行|确认|格式/);
});

test('negative and cancellation requests cannot be transformed into a new side effect',async()=>{
  const {createHostOwnerPlanner}=await load();
  for(const [text,action] of [
    ['不要给妈妈发日报',{type:'send_daily',target:'妈妈'}],
    ['取消明天八点提醒爸爸浇花',{type:'remind',target:'爸爸',text:'浇花',date:'2026-10-23',time:'08:00',repeat:'once',timeEvidence:'明天八点'}],
  ]){const h=host({reply:'准备处理。',action});await assert.rejects(()=>createHostOwnerPlanner(h.ctx,h.readConfig)({owner,text,people,now:'2026-10-22T15:00:00Z'}),/取消|否定|明确|新建/);}
});

async function reminderPlan({text,evidence=text,date='2026-10-23',time='08:00',now='2026-10-22T15:00:00Z',repeat='once'}){
  const {createHostOwnerPlanner}=await load();
  const action={type:'remind',target:'爸爸',text:'浇花',date,time,repeat,timeEvidence:evidence};
  const h=host({reply:'准备安排。',action});
  return createHostOwnerPlanner(h.ctx,h.readConfig)({owner,text,people,now});
}

test('model reminder clock must agree with literal hour and period instead of merely citing them',async()=>{
  await assert.rejects(()=>reminderPlan({text:'明早八点提醒爸爸浇花',time:'15:00'}),/时间|几点|不一致/);
  await assert.rejects(()=>reminderPlan({text:'明晚八点提醒爸爸浇花',time:'08:00'}),/时间|几点|不一致/);
  assert.equal((await reminderPlan({text:'明晚八点提醒爸爸浇花',time:'20:00'})).action.time,'20:00');
  await assert.rejects(()=>reminderPlan({text:'明天八点提醒爸爸浇花'}),/上午|晚上|明确|时间/);
});

test('literal colon, minute, half-hour and quarter-hour clocks are checked exactly',async()=>{
  for(const [phrase,time] of [['明天08:30','08:30'],['明早八点十五分','08:15'],['明早八点半','08:30'],['明早八点一刻','08:15'],['明晚八点三刻','20:45']]){
    assert.equal((await reminderPlan({text:phrase+'提醒爸爸浇花',time})).action.time,time);
    await assert.rejects(()=>reminderPlan({text:phrase+'提醒爸爸浇花',time:'09:00'}),/时间|几点|不一致/);
  }
});

test('relative calendar words use the target local day including when Owner and elder dates differ',async()=>{
  const now='2026-10-22T20:00:00Z'; // Dad is already on October 23 in Shanghai.
  await assert.rejects(()=>reminderPlan({text:'明早八点提醒爸爸浇花',now,date:'2026-10-23'}),/日期|时间|不一致/);
  assert.equal((await reminderPlan({text:'明早八点提醒爸爸浇花',now,date:'2026-10-24'})).action.date,'2026-10-24');
  for(const [phrase,date] of [['今天上午八点','2026-10-23'],['今晚八点','2026-10-23'],['后天上午八点','2026-10-25']])assert.equal((await reminderPlan({text:phrase+'提醒爸爸浇花',now,date,time:phrase.includes('晚')?'20:00':'08:00'})).action.date,date);
});

test('relative minutes and hours are derived from now and cannot move to an invented date',async()=>{
  const now='2026-10-22T15:45:20Z';
  for(const [phrase,date,time] of [['30分钟后','2026-10-23','00:15'],['半小时后','2026-10-23','00:15'],['两小时以后','2026-10-23','01:45']])assert.equal((await reminderPlan({text:phrase+'提醒爸爸浇花',now,date,time})).action.time,time);
  await assert.rejects(()=>reminderPlan({text:'30分钟后提醒爸爸浇花',now,date:'2026-10-24',time:'00:15'}),/日期|时间|不一致/);
  await assert.rejects(()=>reminderPlan({text:'30分钟后提醒爸爸浇花',now,date:'2026-10-23',time:'00:17'}),/时间|不一致/);
  for(const phrase of ['0分钟后','-30分钟后','负三十分钟后','几个小时后','30秒后','一刻钟后'])await assert.rejects(()=>reminderPlan({text:phrase+'提醒爸爸浇花',now,date:'2026-10-23',time:'00:15'}),/时间|分钟|小时|明确|支持/);
});

test('multiple clock choices and silently invented daily repetition fail closed',async()=>{
  await assert.rejects(()=>reminderPlan({text:'明早八点或九点提醒爸爸浇花',evidence:'八点'}),/时间|一个|明确|多个/);
  await assert.rejects(()=>reminderPlan({text:'明早八点提醒爸爸浇花',repeat:'daily'}),/每天|重复|每日/);
  assert.equal((await reminderPlan({text:'每天早上八点提醒爸爸浇花',repeat:'daily'})).action.repeat,'daily');
  await assert.rejects(()=>reminderPlan({text:'每天早上八点提醒爸爸浇花',repeat:'once'}),/每天|重复|每日/);
  assert.equal((await reminderPlan({text:'每晚八点提醒爸爸浇花',time:'20:00',repeat:'daily'})).action.repeat,'daily');
  await assert.rejects(()=>reminderPlan({text:'两天后早上八点提醒爸爸浇花',date:'2026-10-23'}),/日期|时间|明确/);
  await assert.rejects(()=>reminderPlan({text:'早上八点提醒爸爸浇花',date:'2026-10-23'}),/日期|时间|明确/);
});

test('manual daily cannot silently replace a future or recurring daily schedule',async()=>{
  const {createHostOwnerPlanner}=await load();
  for(const text of ['明天给我妈发日报','后天八点给我妈发日报','两天后给我妈发日报','过两天给我妈发日报','每天给我妈发日报','每晚给我妈发日报','今天20:00给我妈发日报','30分钟后给我妈发日报']){
    const h=host({reply:'准备发送。',action:{type:'send_daily',target:'我妈'}});
    await assert.rejects(()=>createHostOwnerPlanner(h.ctx,h.readConfig)({owner,text,people,now:'2026-10-22T15:00:00Z'}),/现在|即时|定时|目前|暂时|预约/);
  }
  const h=host({reply:'准备发送。',action:{type:'send_daily',target:'我妈'}});
  assert.equal((await createHostOwnerPlanner(h.ctx,h.readConfig)({owner,text:'现在给我妈发今天的日报',people,now:'2026-10-22T15:00:00Z'})).action.type,'send_daily');
});
