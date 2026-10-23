import test from 'node:test';
import assert from 'node:assert/strict';

const load=()=>import('../src/workbench-model.mjs');
const wrap=operation=>JSON.stringify({reply:'请核对这份草稿。',operation});

test('workbench parser accepts a natural-language profile patch and a clarification',async()=>{
  const {parseWorkbenchReply}=await load();
  const operation={type:'profile',patch:{label:'妈妈',timeZone:'Asia/Shanghai',interests:['园艺'],notes:'喜欢慢慢聊。'}};
  assert.deepEqual(parseWorkbenchReply(wrap(operation)),{reply:'请核对这份草稿。',operation});
  assert.deepEqual(parseWorkbenchReply('```json\n{"reply":"  具体几点提醒？  ","operation":null}\n```'),{reply:'具体几点提醒？',operation:null});
  assert.deepEqual(parseWorkbenchReply(wrap({type:'profile',personId:'mom',cardId:'profile_1',patch:{notes:'',interests:[]}})).operation.patch,{notes:'',interests:[]});
});

test('workbench parser supports all scoped action types in one plan',async()=>{
  const {parseWorkbenchReply}=await load();
  const operation={type:'plan',cardId:'plan_1',actions:[
    {id:'daily_1',type:'send_daily',personId:'mom'},
    {type:'send_message',personId:'dad',text:'周末见。'},
    {type:'remind',personId:'mom',text:'浇花',date:'2026-10-24',time:'08:00',repeat:'once',timeEvidence:'明早八点'},
    {type:'daily_schedule',personId:'mom',enabled:true,time:'09:00'},
    {type:'daily_schedule',personId:'dad',enabled:false},
    {type:'cancel_reminder',personId:'dad',reminderId:'reminder_1'},
  ]};
  assert.deepEqual(parseWorkbenchReply(wrap(operation)).operation,operation);
  for(const operation of [{type:'cancel',cardId:'plan_1',actionId:'daily_1'},{type:'confirm',cardId:'plan_1'},{type:'reply_request',requestId:'request_1',text:'周六可以。'}])assert.deepEqual(parseWorkbenchReply(wrap(operation)).operation,operation);
});

test('workbench parser rejects malformed JSON, missing operation, and unrecognized fields',async()=>{
  const {parseWorkbenchReply}=await load();
  const inputs=['{"reply":"草稿","operation":','{"reply":"你好"}',JSON.stringify({reply:'你好',operation:null,tool:'exec'}),wrap({type:'profile',patch:{role:'owner'}}),wrap({type:'profile',patch:{binding:{token:'x'}}}),wrap({type:'profile',patch:{shareWithOwner:'full'}}),wrap({type:'plan',actions:[{type:'send_daily',personId:'mom',text:'secret'}]}),wrap({type:'exec',command:'touch /tmp/no'})];
  for(const input of inputs)assert.throws(()=>parseWorkbenchReply(input),/JSON|格式|字段|参数|操作/);
});

test('workbench parser validates per-type required fields, duplicate IDs and safe identifiers',async()=>{
  const {parseWorkbenchReply}=await load();
  const operations=[{type:'profile',patch:{}},{type:'plan',actions:[]},{type:'plan',actions:[{type:'send_message',personId:'mom'}]},{type:'plan',actions:[{type:'remind',personId:'mom',text:'浇花',date:'2026-10-24'}]},{type:'plan',actions:[{type:'daily_schedule',personId:'mom',enabled:'true',time:'08:00'}]},{type:'plan',actions:[{type:'daily_schedule',personId:'mom',enabled:true}]},{type:'plan',actions:[{type:'cancel_reminder',personId:'mom'}]},{type:'cancel',cardId:'../x'},{type:'reply_request',requestId:'request_1',text:''},{type:'plan',actions:[{id:'same',type:'send_daily',personId:'mom'},{id:'same',type:'send_daily',personId:'dad'}]}];
  for(const operation of operations)assert.throws(()=>parseWorkbenchReply(wrap(operation)),/格式|字段|参数|操作|标识|重复|内容|时间|卡片|数量/);
});

test('workbench parser rejects invalid calendar dates, clocks, zones and excessive values',async()=>{
  const {parseWorkbenchReply}=await load();
  const remind={type:'remind',personId:'mom',text:'浇花',date:'2026-10-24',time:'08:00',repeat:'once'};
  for(const patch of [{date:'2026-02-29'},{date:'2026-02-31'},{date:'2026-13-01'},{time:'24:00'},{time:'8:00'},{repeat:'weekly'},{text:'a'.repeat(201)},{timeEvidence:'a'.repeat(201)}])assert.throws(()=>parseWorkbenchReply(wrap({type:'plan',actions:[{...remind,...patch}]})),/日期|时间|重复|内容|参数|证据/);
  for(const patch of [{timeZone:'Planet/Mars'},{label:'a'.repeat(81)},{notes:'a'.repeat(2001)},{interests:Array(21).fill('园艺')},{interests:['a'.repeat(101)]},{label:'妈妈\u0000'}])assert.throws(()=>parseWorkbenchReply(wrap({type:'profile',patch})),/时区|称呼|备注|兴趣|参数/);
  assert.throws(()=>parseWorkbenchReply(JSON.stringify({reply:'a'.repeat(3001),operation:null})),/回复|长度|格式/);
  assert.throws(()=>parseWorkbenchReply(wrap({type:'plan',actions:Array.from({length:21},()=>({type:'send_daily',personId:'mom'}))})),/操作|数量|安排/);
  assert.throws(()=>parseWorkbenchReply(wrap({type:'plan',actions:[{type:'send_message',personId:'mom',text:'x'.repeat(3001)}]})),/内容|长度/);
  assert.throws(()=>parseWorkbenchReply(wrap({type:'reply_request',requestId:'request_1',text:'x'.repeat(2001)})),/内容|长度/);
  const withoutRepeat={...remind};delete withoutRepeat.repeat;
  assert.equal(parseWorkbenchReply(wrap({type:'plan',actions:[withoutRepeat]})).operation.actions[0].repeat,'once');
});

const people=[{id:'owner',role:'owner',label:'我',timeZone:'America/Mexico_City'},{id:'mom',role:'elder',label:'妈妈',timeZone:'Asia/Shanghai',interests:['园艺'],notes:'Owner 说喜欢花。'},{id:'dad',role:'elder',label:'爸爸',timeZone:'Asia/Shanghai'}];
const now='2026-10-23T00:00:00Z';
const plan={id:'plan_1',kind:'plan',title:'给妈妈的安排',status:'draft',revision:3,actions:[{id:'remind_1',type:'remind',personId:'mom',text:'浇花',date:'2026-10-24',time:'08:00',repeat:'once',status:'draft'},{id:'daily_1',type:'send_daily',personId:'mom',status:'draft'}]};
function host(output,{finish='stop',chunks}={}){
  let captured,calls=0;
  return{ctx:{get:()=>({async *stream(options){calls++;captured=options;if(chunks){yield* chunks;return;}yield{type:'text-delta',index:1,text:typeof output==='string'?output:JSON.stringify(output)};yield{type:'finish',reason:finish};}})},readConfig:()=>({provider:'test',model:'test'}),captured:()=>captured,calls:()=>calls};
}
async function invoke(operation,options={},hostOptions={}){
  const {createHostWorkbenchPlanner}=await load();const h=host({reply:'请核对这份草稿。',operation},hostOptions);
  const result=await createHostWorkbenchPlanner(h.ctx,h.readConfig)({text:'给妈妈发一份今天的日报',people,cards:[],requests:[],history:[],now,...options});
  return{result,h};
}

test('workbench host uses the configured model with bounded owner-visible context and no tools',async()=>{
  const {h}=await invoke(null,{text:'妈妈喜欢什么？',people:people.map(p=>({...p,credentials:'PRIVATE_TOKEN',binding:{peerId:'PRIVATE_PEER'},messages:[{text:'PRIVATE_ELDER_CHAT'}],selfPreferences:{notes:'PRIVATE_SELF_NOTES'}})),cards:[{...plan,privateData:'PRIVATE_CARD_METADATA'}],requests:[{id:'request_1',personId:'mom',text:'请问周六能来吗？',status:'open',sourceMessage:{text:'PRIVATE_SOURCE_CONVERSATION'}}],history:[{role:'tool',text:'PRIVATE_TOOL_RESULT'},...Array.from({length:45},(_,i)=>({role:i%2?'user':'assistant',text:`管理对话 ${i}`,at:now,raw:'PRIVATE_HISTORY_METADATA'}))]});
  const options=h.captured(),payload=JSON.parse(options.messages[0].content[0].text),serialized=JSON.stringify(options);
  assert.equal(options.provider,'test');assert.equal(options.model,'test');assert.deepEqual(options.tools,[]);assert.ok(options.maxTokens>=3500);
  assert.ok(payload.history.length<=30);assert.equal(payload.history.at(-1).text,'管理对话 44');assert.equal(payload.people.find(p=>p.id==='mom').notes,'Owner 说喜欢花。');
  assert.equal(payload.cards[0].revision,3);assert.equal(payload.requests[0].text,'请问周六能来吗？');
  for(const marker of ['PRIVATE_TOKEN','PRIVATE_PEER','PRIVATE_ELDER_CHAT','PRIVATE_SELF_NOTES','PRIVATE_CARD_METADATA','PRIVATE_SOURCE_CONVERSATION','PRIVATE_TOOL_RESULT','PRIVATE_HISTORY_METADATA'])assert.equal(serialized.includes(marker),false,marker);
  assert.match(options.system,/卡片|cardId/);assert.match(options.system,/同一|复用/);assert.match(options.system,/歧义|多张/);assert.match(options.system,/不能.*(?:执行|发送)|不得.*(?:执行|发送)/);
});

test('same-card correction preserves stable IDs and only returns changed actions',async()=>{
  const operation={type:'plan',cardId:'plan_1',actions:[{id:'remind_1',type:'remind',personId:'mom',text:'给阳台的花浇水',date:'2026-10-24',time:'08:00',repeat:'once'}]};
  const {result}=await invoke(operation,{text:'改成给阳台的花浇水',contextId:'card:plan_1',cards:[plan]});
  assert.deepEqual(result.operation,operation);assert.equal(plan.actions.length,2);
  const changed={...operation,actions:[{...operation.actions[0],time:'09:00',timeEvidence:'上午九点'}]};
  assert.deepEqual((await invoke(changed,{text:'时间改成上午九点',contextId:'card:plan_1',cards:[plan]})).result.operation,changed);
});

test('unknown people, cards, actions and requests fail closed without inventing IDs',async()=>{
  for(const operation of [{type:'profile',personId:'unknown',patch:{notes:'喜欢散步'}},{type:'plan',actions:[{type:'send_daily',personId:'unknown'}]},{type:'plan',actions:[{type:'send_daily',personId:'owner'}]},{type:'plan',cardId:'unknown',actions:[{type:'send_daily',personId:'mom'}]},{type:'plan',cardId:'plan_1',actions:[{id:'invented',type:'send_daily',personId:'mom'}]},{type:'cancel',cardId:'plan_1',actionId:'unknown'},{type:'reply_request',requestId:'unknown',text:'可以。'}])await assert.rejects(()=>invoke(operation,{cards:[plan]}),/标识|成员|卡片|动作|请求|长辈|找到/);
  await assert.rejects(()=>invoke({type:'plan',actions:[{id:'invented',type:'send_daily',personId:'mom'}]}),/标识|动作|卡片/);
});

test('an explicit card or request context cannot silently move to another object',async()=>{
  const other={...plan,id:'plan_2'};
  await assert.rejects(()=>invoke({type:'cancel',cardId:'plan_2'},{contextId:'card:plan_1',cards:[plan,other]}),/上下文|当前|卡片/);
  await assert.rejects(()=>invoke({type:'reply_request',requestId:'request_2',text:'可以。'},{contextId:'request:request_1',requests:[{id:'request_1',personId:'mom',text:'请问周六能来吗？',status:'open'},{id:'request_2',personId:'dad',text:'请问周日能来吗？',status:'open'}]}),/上下文|当前|请求/);
  await assert.rejects(()=>invoke(null,{contextId:'card:unknown',cards:[plan]}),/上下文|卡片|找到/);
  await assert.rejects(()=>invoke({type:'plan',actions:[{type:'send_daily',personId:'dad'}]},{text:'发今天的日报',contextId:'person:mom'}),/上下文|当前|成员|对象/);
});

test('new or changed reminder times require explicit evidence quoted from current input',async()=>{
  const remind={type:'remind',personId:'mom',text:'浇花',date:'2026-10-24',time:'08:00',repeat:'once'};
  for(const timeEvidence of [undefined,'明早','明早八点'])await assert.rejects(()=>invoke({type:'plan',actions:[{...remind,...(timeEvidence?{timeEvidence}:{})}]},{text:'明早提醒妈妈浇花'}),/时间|原话|明确/);
  const action={...remind,timeEvidence:'明早八点'};
  assert.deepEqual((await invoke({type:'plan',actions:[action]},{text:'明早八点提醒妈妈浇花'})).result.operation.actions,[action]);
  await assert.rejects(()=>invoke({type:'plan',cardId:'plan_1',actions:[{...remind,id:'remind_1',time:'09:00'}]},{text:'改成浇阳台的花',contextId:'card:plan_1',cards:[plan]}),/时间|原话|明确/);
});

test('missing information and ambiguous drafts can be clarified without any operation',async()=>{
  for(const options of [{text:'明早提醒妈妈浇花'},{text:'确认这个',cards:[plan,{...plan,id:'plan_2'}]}])assert.equal((await invoke(null,options)).result.operation,null);
});

test('explicit confirmation targets a supplied draft card',async()=>{
  assert.deepEqual((await invoke({type:'confirm',cardId:'plan_1'},{text:'确认安排',contextId:'card:plan_1',cards:[plan]})).result.operation,{type:'confirm',cardId:'plan_1'});
  await assert.rejects(()=>invoke({type:'confirm',cardId:'unknown'},{text:'确认安排',cards:[plan]}),/卡片|标识|找到/);
});

test('host stream assembles text once and never exposes reasoning',async()=>{
  const chunks=[{type:'reasoning-delta',index:0,text:'PRIVATE_REASONING'},{type:'text-delta',index:1,text:'{"reply":"你好"'},{type:'block-end',index:1,block:{type:'text',text:'{"reply":"你好","operation":null}'}},{type:'text-delta',index:1,text:'duplicate tail'},{type:'finish',reason:{kind:'stop'}}];
  assert.deepEqual((await invoke(null,{}, {chunks})).result,{reply:'你好',operation:null});
});

test('truncation, errors, model tool output and oversized streams never return proposals',async()=>{
  for(const finish of ['length',{kind:'max-tokens'},{kind:'error'},{kind:'aborted'},'tool-calls'])await assert.rejects(()=>invoke(null,{}, {finish}),/完整|结束|中断|模型/);
  const output={type:'text-delta',index:0,text:'{"reply":"草稿","operation":null}'};
  for(const poison of [{type:'tool-call-delta',index:1,id:'call_1',name:'exec',argumentsDelta:'{}'},{type:'block-start',index:1,blockType:'tool-call'},{type:'block-end',index:1,block:{type:'tool-call',name:'exec',arguments:{}}},{type:'error',error:'PRIVATE_PROVIDER_FAILURE'}])await assert.rejects(()=>invoke(null,{}, {chunks:[output,poison,{type:'finish',reason:'stop'}]}),/工具|模型|完整|异常/);
  await assert.rejects(()=>invoke(null,{}, {chunks:[output]}),/完整|结束/);
  await assert.rejects(()=>invoke(null,{}, {chunks:[{type:'text-delta',index:0,text:'x'.repeat(24001)},{type:'finish',reason:'stop'}]}),/过长|长度/);
});

test('unavailable model, invalid input and cancellation do not start model work',async()=>{
  const {createHostWorkbenchPlanner}=await load();
  await assert.rejects(()=>createHostWorkbenchPlanner({get:()=>null},()=>({}))({text:'你好',people,now}),/模型/);
  const h=host({reply:'你好',operation:null}),planner=createHostWorkbenchPlanner(h.ctx,h.readConfig);
  await assert.rejects(()=>planner({text:'',people,now}),/内容|指令/);
  await assert.rejects(()=>planner({text:'你好',people,now:'tomorrow'}),/时间/);
  const controller=new AbortController();controller.abort();await assert.rejects(()=>planner({text:'你好',people,now,signal:controller.signal}),/abort/i);assert.equal(h.calls(),0);
});

test('scheduled reminder results are available by exact ID for cancellation',async()=>{
  const operation={type:'plan',actions:[{type:'cancel_reminder',personId:'mom',reminderId:'scheduled_1'}]};
  const cards=[{...plan,actions:[{...plan.actions[0],status:'scheduled',resultId:'scheduled_1'}]}];
  assert.deepEqual((await invoke(operation,{text:'取消妈妈的浇花提醒',cards})).result.operation,operation);
  await assert.rejects(()=>invoke({...operation,actions:[{...operation.actions[0],personId:'dad'}]},{text:'取消爸爸的浇花提醒',cards}),/提醒|标识/);
  await assert.rejects(()=>invoke(operation,{cards:[{...cards[0],actions:[{...cards[0].actions[0],status:'failed'}]}]}),/提醒|标识/);
});

test('text after terminal stop and provider exceptions discard proposals and private errors',async()=>{
  await assert.rejects(()=>invoke(null,{}, {chunks:[{type:'finish',reason:'stop'},{type:'text-delta',index:0,text:'{"reply":"你好","operation":null}'}]}),/完整|结束|模型/);
  const {createHostWorkbenchPlanner}=await load();
  const planner=createHostWorkbenchPlanner({get:()=>({async *stream(){yield{type:'text-delta',index:0,text:'{"reply":"你好","operation":null}'};throw new Error('PRIVATE_PROVIDER_TOKEN');}})},()=>({provider:'test',model:'test'}));
  await assert.rejects(()=>planner({text:'你好',people,now}),error=>{assert.doesNotMatch(error.message,/PRIVATE_PROVIDER_TOKEN/);assert.match(error.message,/模型/);return true;});
});

test('bounded context retains an older explicitly selected card without forwarding all history',async()=>{
  const cards=[plan,...Array.from({length:80},(_,index)=>({...plan,id:`other_${index}`}))];
  const {h}=await invoke(null,{text:'这里怎么改？',contextId:'card:plan_1',cards,history:Array.from({length:40},()=>({role:'user',text:'x'.repeat(5000)}))});
  const payload=JSON.parse(h.captured().messages[0].content[0].text);
  assert.ok(payload.cards.some(card=>card.id==='plan_1'));assert.ok(payload.cards.length<=60);assert.ok(payload.history.every(entry=>entry.text.length<=3000));
});

test('one-time future daily delivery is not described as a recurring daily schedule',async()=>{
  const {h}=await invoke(null,{text:'明天八点给妈妈发一次日报'});
  assert.match(h.captured().system,/一次性.*日报.*(?:不支持|尚不支持)|不支持.*一次性.*日报/);
  assert.match(h.captured().system,/daily_schedule.*(?:明确.*每日|明确.*每天)|(?:明确.*每日|明确.*每天).*daily_schedule/);
});
