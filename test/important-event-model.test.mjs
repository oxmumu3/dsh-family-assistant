import test from 'node:test';
import assert from 'node:assert/strict';

const load=()=>import('../src/important-event-model.mjs');
const now='2026-10-26T18:00:00.000Z';
const input=(patch={})=>({member:{id:'qa-mom',label:'合成妈妈'},message:{id:'in-1',text:'我现在摔倒了，站不起来，需要有人来帮我。',at:now},history:[],incidents:[],now,...patch});
const decision=(patch={})=>({decision:'notify',urgency:'now',category:'safety',relatedIncidentId:null,subject:'self',eventState:'current',evidence:[{messageId:'in-1',quote:'我现在摔倒了，站不起来'}],clarificationKind:null,...patch});
function host(outputs,{chunks,config={provider:'deepseek-account',model:'deepseek-flash'},onCall}={}){
 const calls=[];return{calls,readConfig:()=>config,ctx:{get(key){assert.equal(key,'llm');return{async *stream(options){calls.push(options);onCall?.(options,calls.length);if(chunks){yield* chunks;return;}const value=outputs[Math.min(calls.length-1,outputs.length-1)];if(value instanceof Error)throw value;yield{type:'text-delta',index:0,text:typeof value==='string'?value:JSON.stringify(value)};yield{type:'finish',reason:{kind:'stop'}};}};}}};
}
async function classify(value,options,source=input()){
 const {createImportantEventClassifier}=await load(),h=host(Array.isArray(value)?value:[value],options);
 return{result:await createImportantEventClassifier(h.ctx,h.readConfig)(source),h};
}

test('classifier returns strict original-quote decision through official tools-free bounded model',async()=>{
 const expected=decision(),{result,h}=await classify(expected);
 assert.deepEqual(result,expected);assert.equal(h.calls.length,1);
 const options=h.calls[0],payload=JSON.parse(options.messages[0].content[0].text);
 assert.equal(options.provider,'deepseek-account');assert.equal(options.model,'deepseek-flash');assert.equal(options.reasoningEffort,'off');assert.deepEqual(options.tools,[]);
 assert.ok(options.maxTokens>=700&&options.maxTokens<=1800);assert.equal(payload.member.id,'qa-mom');assert.equal(payload.message.text,input().message.text);assert.equal(payload.now,now);
 assert.match(options.system,/假设|假想/);assert.match(options.system,/转发|引用/);assert.match(options.system,/改稿|修改日报/);assert.match(options.system,/不要告诉/);assert.match(options.system,/持续|连续/);assert.match(options.system,/原话|逐字/);
});

test('clarification is a fixed kind with current inbound evidence, never a model-written question or summary',async()=>{
 const source=input({message:{id:'in-1',text:'刚才那件事有点怕。',at:now}}),expected=decision({decision:'clarify',urgency:'soon',category:'needs_help',subject:'unclear',eventState:'unclear',evidence:[{messageId:'in-1',quote:'那件事有点怕'}],clarificationKind:'current_or_quote'});
 assert.deepEqual((await classify(expected,{},source)).result,expected);
 await assert.rejects(()=>classify({...expected,summary:'PRIVATE_MODEL_SUMMARY'}, {},source),{code:'important_event_classification_invalid'});
});

test('ignores resolved, historical, quoted, hypothetical and other-person events even when model requests notify',async()=>{
 for(const eventState of ['resolved','historical','quoted','hypothetical']){
  const {result}=await classify(decision({eventState}));assert.equal(result.decision,'ignore');assert.deepEqual(result.evidence,[]);
 }
 assert.equal((await classify(decision({subject:'other'}))).result.decision,'ignore');
 assert.equal((await classify(decision({subject:'unclear'}))).result.decision,'clarify');
});

test('ordinary do-not-tell instruction suppresses notifications and clarification without a model exception',async()=>{
 const text='我下周换工作，只想自己想想。不要告诉Owner。',source=input({message:{id:'in-1',text,at:now}});
 for(const action of ['notify','clarify']){
  const expected=decision({decision:action,urgency:'soon',category:'important_change',eventState:'upcoming',evidence:[{messageId:'in-1',quote:'我下周换工作'}],clarificationKind:action==='clarify'?'needs_help':null});
  const {result}=await classify(expected,{},source);assert.equal(result.decision,'ignore');assert.deepEqual(result.evidence,[]);
 }
});

test('only unmistakable current personal danger can override an explicit privacy instruction',async()=>{
 const text='我现在喘不过气，胸口很痛，不要告诉Owner。',source=input({message:{id:'in-1',text,at:now}}),expected=decision({evidence:[{messageId:'in-1',quote:'我现在喘不过气'}]});
 assert.equal((await classify(expected,{},source)).result.decision,'notify');
 for(const patch of [{urgency:'soon'},{category:'needs_help'},{subject:'family'},{eventState:'upcoming'}])assert.equal((await classify({...expected,...patch},{},source)).result.decision,'ignore');
});

test('quoted, forwarded, hypothetical, negated or resolved danger cannot bypass do-not-tell',async()=>{
 for(const text of ['转发：有人说“我现在喘不过气”。不要告诉Owner。','如果我现在喘不过气，应该怎么办？不要告诉Owner。','我现在没有喘不过气，只是在读新闻。不要告诉Owner。','我刚才喘不过气，现在已经好了。不要告诉Owner。','新闻里写着：我现在喘不过气。不要告诉Owner。']){
  const source=input({message:{id:'in-1',text,at:now}}),quote=text.includes('喘不过气')?'喘不过气':text.slice(0,8);
  const {result}=await classify(decision({evidence:[{messageId:'in-1',quote}]}),{},source);assert.equal(result.decision,'ignore',text);
 }
});

test('multi-line reference frames and urgent-looking quoted evidence cannot override privacy',async()=>{
 for(const text of ['转发：\n我现在喘不过气，不要告诉Owner。','假设下面这个场景：\n我现在喘不过气，不要告诉Owner。','新闻里的一段话：\n我现在喘不过气。\n不要告诉Owner。']){
  const {result}=await classify(decision({evidence:[{messageId:'in-1',quote:'我现在喘不过气'}]}),{},input({message:{id:'in-1',text,at:now}}));assert.equal(result.decision,'ignore',text);
 }
});

test('natural privacy wording suppresses ordinary important changes',async()=>{
 for(const ending of ['不要跟Owner说。','别告诉我儿子。','先不和我女儿提。','不要对家里说。']){
  const text='我下周换工作，'+ending;
  const {result}=await classify(decision({urgency:'soon',category:'important_change',eventState:'upcoming',evidence:[{messageId:'in-1',quote:'我下周换工作'}]}),{},input({message:{id:'in-1',text,at:now}}));assert.equal(result.decision,'ignore',text);
 }
});

test('postfix fictional or rehearsal disclaimers cannot bypass explicit privacy',async()=>{
 for(const text of ['我现在喘不过气是假的，不要告诉Owner。','我现在喘不过气。刚才这句话只是演练，不要告诉Owner。','我现在喘不过气。这段话是虚构的，不要告诉Owner。']){
  const {result}=await classify(decision({evidence:[{messageId:'in-1',quote:'我现在喘不过气'}]}),{},input({message:{id:'in-1',text,at:now}}));assert.equal(result.decision,'ignore',text);
 }
});

test('resolved existing incidents retain validated linkage and exact new evidence without notifying',async()=>{
 const source=input({message:{id:'in-1',text:'有人来帮忙了，我已经安全了。',at:now},incidents:[{id:'case-1',category:'safety',quote:'摔倒了',status:'open',urgency:'now'}]}),value=decision({decision:'ignore',relatedIncidentId:'case-1',eventState:'resolved',evidence:[{messageId:'in-1',quote:'我已经安全了'}]});
 const {result}=await classify(value,{},source);assert.equal(result.decision,'ignore');assert.equal(result.relatedIncidentId,'case-1');assert.deepEqual(result.evidence,value.evidence);
});

test('an outbound current-message descriptor cannot be classified as incoming',async()=>{
 const {createImportantEventClassifier}=await load(),h=host([decision()]);
 await assert.rejects(()=>createImportantEventClassifier(h.ctx,h.readConfig)(input({message:{...input().message,dir:'out'}})),{code:'important_event_classification_invalid'});assert.equal(h.calls.length,0);
});

test('a quoted privacy phrase is data and does not suppress a real new event',async()=>{
 const text='日报里的“不要告诉Owner”是什么意思？另外，我现在摔倒了，站不起来，需要人来帮我。';
 const {result}=await classify(decision(),{},input({message:{id:'in-1',text,at:now}}));assert.equal(result.decision,'notify');
});

test('outbound, fabricated, stale-only and partial fabricated evidence fail closed',async()=>{
 const source=input({history:[{id:'old-in',dir:'in',text:'以前摔倒过。',at:now},{id:'out-1',dir:'out',text:'请尽快向家人求助。',at:now}]});
 for(const evidence of [[{messageId:'out-1',quote:'向家人求助'}],[{messageId:'in-1',quote:'PRIVATE_FABRICATED'}],[{messageId:'old-in',quote:'以前摔倒过'}],[{messageId:'in-1',quote:'我'}]])await assert.rejects(()=>classify(decision({evidence}),{},source),{code:'important_event_classification_invalid'});
});

test('only current member metadata and scoped history/incidents enter the model',async()=>{
 const source=input({member:{id:'qa-mom',label:'合成妈妈',credentials:'PRIVATE_CREDENTIAL',route:'PRIVATE_ROUTE',notes:'PRIVATE_NOTES'},message:{...input().message,raw:'PRIVATE_RAW'},history:[{id:'own-history',text:'本人原话',dir:'in',at:now,personId:'qa-mom',raw:'PRIVATE_HISTORY_RAW'},{id:'other-history',text:'OTHER_FAMILY_PRIVATE',dir:'in',at:now,personId:'qa-dad'},{id:'tool-history',text:'PRIVATE_TOOL_RESULT',dir:'tool',at:now}],incidents:[{id:'own-incident',personId:'qa-mom',category:'safety',quote:'本人旧事',status:'open',urgency:'soon',raw:'PRIVATE_INCIDENT_RAW'},{id:'other-incident',personId:'qa-dad',category:'safety',quote:'OTHER_FAMILY_EVENT',status:'open',urgency:'soon'}],owner:{text:'PRIVATE_OWNER_HISTORY'}});
 const {h}=await classify(decision({relatedIncidentId:'own-incident'}),{},source),serialized=JSON.stringify(h.calls),payload=JSON.parse(h.calls[0].messages[0].content[0].text);
 for(const secret of ['PRIVATE_','OTHER_FAMILY'])assert.equal(serialized.includes(secret),false);
 assert.deepEqual(payload.member,{id:'qa-mom',label:'合成妈妈'});assert.equal(payload.history.length,1);assert.equal(payload.incidents.length,1);
 await assert.rejects(()=>classify(decision({relatedIncidentId:'other-incident'}),{},source),{code:'important_event_classification_invalid'});
});

test('cross-member current message and ambiguous duplicate message identifiers are rejected before model work',async()=>{
 const {createImportantEventClassifier}=await load(),h=host([decision()]),fn=createImportantEventClassifier(h.ctx,h.readConfig);
 await assert.rejects(()=>fn(input({message:{...input().message,personId:'qa-dad'}})),{code:'important_event_classification_invalid'});
 await assert.rejects(()=>fn(input({history:[{...input().message,dir:'in',text:'DIFFERENT_TEXT'}]})),{code:'important_event_classification_invalid'});
 assert.equal(h.calls.length,0);
});

test('invalid JSON or strict schema gets at most one pure classification correction',async()=>{
 const {result,h}=await classify(['{"decision":',decision()]);assert.equal(result.decision,'notify');assert.equal(h.calls.length,2);assert.deepEqual(h.calls[1].tools,[]);assert.match(h.calls[1].system,/JSON/);
 await assert.rejects(()=>classify(['not json','not json']),{code:'important_event_classification_invalid'});
 for(const patch of [{decision:'send'},{urgency:'urgent'},{clarificationKind:'write any question'},{relatedIncidentId:'unknown'},{evidence:[]},{ownerId:'forged'},{summary:'free model summary'}])await assert.rejects(()=>classify(decision(patch)),{code:'important_event_classification_invalid'});
});

test('config is read for each classification and never invents unsupported reasoning effort',async()=>{
 const {h}=await classify(decision(),{config:{provider:'custom',model:'custom-v1'}});assert.equal(Object.hasOwn(h.calls[0],'reasoningEffort'),false);
 const {createImportantEventClassifier}=await load(),empty=host([decision()],{config:{provider:'',model:'unknown'}});
 await assert.rejects(()=>createImportantEventClassifier(empty.ctx,empty.readConfig)(input()),{code:'important_event_classification_unavailable'});assert.equal(empty.calls.length,0);
});

test('stream assembles final text once and discards reasoning',async()=>{
 const expected=decision(),text=JSON.stringify(expected),chunks=[{type:'reasoning-delta',index:0,text:'PRIVATE_REASONING'},{type:'text-delta',index:1,text:'{"badpartial":'},{type:'block-end',index:1,block:{type:'text',text}},{type:'block-end',index:1,block:{type:'text',text}},{type:'text-delta',index:1,text:'duplicate tail'},{type:'finish',reason:{kind:'stop'}},{type:'usage',usage:{outputTokens:1}}];
 assert.deepEqual((await classify(expected,{chunks})).result,expected);
});

test('incomplete, errored, tool-bearing, oversized or post-finish stream is never retried',async()=>{
 const output={type:'text-delta',index:0,text:JSON.stringify(decision())};
 for(const tail of [[],[{type:'finish',reason:'max-tokens'}],[{type:'finish',reason:{kind:'error'}}],[{type:'error',error:'PRIVATE_PROVIDER_ERROR'}],[{type:'tool-call-delta',index:1,name:'shell',argumentsDelta:'{}'}],[{type:'block-start',index:1,blockType:'tool-call'}],[{type:'finish',reason:'stop'},{type:'text-delta',index:0,text:'extra'}]]){
  const h=host([decision()],{chunks:[output,...tail]}),{createImportantEventClassifier}=await load();
  await assert.rejects(()=>createImportantEventClassifier(h.ctx,h.readConfig)(input()),error=>error.code==='important_event_classification_unavailable'&&!error.message.includes('PRIVATE'));assert.equal(h.calls.length,1);
 }
 await assert.rejects(()=>classify(decision(),{chunks:[{type:'text-delta',index:0,text:'x'.repeat(12001)},{type:'finish',reason:'stop'}]}),{code:'important_event_classification_unavailable'});
});

test('cancellation before or during classification aborts and never starts a correction',async()=>{
 const {createImportantEventClassifier}=await load(),before=new AbortController();before.abort();const h=host([decision()]);
 await assert.rejects(()=>createImportantEventClassifier(h.ctx,h.readConfig)(input({signal:before.signal})),{name:'AbortError'});assert.equal(h.calls.length,0);
 const during=new AbortController(),active=host(['bad json',decision()],{onCall:()=>during.abort()});
 await assert.rejects(()=>createImportantEventClassifier(active.ctx,active.readConfig)(input({signal:during.signal})),{name:'AbortError'});assert.equal(active.calls.length,1);
});

test('input and response budgets reject oversized requests rather than silently truncating source',async()=>{
 const {createImportantEventClassifier}=await load(),h=host([decision()]),fn=createImportantEventClassifier(h.ctx,h.readConfig);
 for(const patch of [{message:{id:'in-1',text:'中'.repeat(6001),at:now}},{now:'not-a-date'},{history:Array.from({length:21},(_,i)=>({id:'h-'+i,dir:'in',text:'hello',at:now}))},{incidents:Array.from({length:21},(_,i)=>({id:'i-'+i,category:'safety',quote:'hello',status:'open',urgency:'soon'}))}])await assert.rejects(()=>fn(input(patch)),{code:'important_event_classification_invalid'});
 assert.equal(h.calls.length,0);
 const text='中'.repeat(6000),ignored=decision({decision:'ignore',evidence:[],clarificationKind:null});assert.equal((await classify(ignored,{},input({message:{id:'in-1',text,at:now}}))).result.decision,'ignore');
});
