import {createHash} from 'node:crypto';
import {createImportantEvents,redactImportantText} from './important-events.mjs';
import {recordMatchesBinding} from './store.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const acknowledgement=text=>/^(?:知道了|收到|我来处理|我会处理|我来跟进|已解决|已经解决了?|处理好了|不再提醒这件事|这件事不用再提醒)[。！!\s]*$/.test(text.trim());
const contextualMessage=text=>text.trim().match(/^(?:请|帮我)?(?:告诉|回复|转告)(?:她|他|这位家人)[：:]\s*([\s\S]{1,2800})$/);
// A direct relay already has a durable request and an Owner notice. Observation
// supplies the missing implicit path; it must not create a duplicate channel.
const explicitRelay=text=>/^(?:(?:请|麻烦|劳驾|帮我|请你|你帮我|我想请你|能不能帮我|可以帮我)\s*){0,4}(?:转告|捎话|带句话|帮我问|(?:告诉|通知|联系)(?:一下)?(?:Owner|家庭联系人|家人|孩子|儿子|女儿|爸爸|妈妈))/i.test(text.trim());

/** Adapts the private incident ledger to the existing binding-scoped outbox.
 * No extra conversation, global history scan, or independent sender. */
export function createRuntimeAttention({directory,store,classify,channels,flush,sendOwnerMessage,now,running,signal}={}){
 let lastError=null;
 const scopeFor=(personId,role)=>{try{const person=store.person(personId);if(!person||person.role!==role)return null;return{personId,createdAt:person.createdAt,routeHash:hash(store.route(personId))};}catch{return null;}};
 const isCurrent=(scope,role)=>{const actual=scope&&scopeFor(scope.personId,role);return Boolean(actual&&JSON.stringify(actual)===JSON.stringify(scope));};
 const ownerScope=()=>{const owner=store.snapshot().people.find(person=>person.role==='owner');return owner?scopeFor(owner.id,'owner'):null;};
 const coreDelivery=key=>store.snapshot().outbox.find(row=>row.sourceKey===key)??null;
 const events=createImportantEvents({directory,now,isCurrent,
  getDelivery:async key=>{const row=coreDelivery(key);return row?{status:row.status,outboxId:row.id}:null;},
  classify:async input=>{
   if(!running()||typeof classify!=='function')throw new Error('important_event_classification_unavailable');
   const person=store.person(input.memberScope.personId),binding=store.binding(person.id),rows=store.messages(person.id).filter(row=>recordMatchesBinding(row,binding));
   const index=rows.findIndex(row=>row.dir==='in'&&row.id===input.messageId),source=index>=0?rows[index]:null;
   const history=(index>=0?rows.slice(0,index):[]).slice(-12).map(row=>({id:row.id,text:redactImportantText(row.text).slice(0,1000),dir:row.dir,at:row.at}));
   while(Buffer.byteLength(JSON.stringify(history))>22000)history.shift();
   return classify({member:{id:person.id,label:person.label},message:{id:input.messageId,text:input.text,at:source?.at??now()},history,
    incidents:input.incidents.map(row=>({id:row.id,category:row.category,quote:row.evidence?.map(item=>item.quote).join('\n').slice(0,1000)??'',status:row.status,urgency:row.urgency})),now:now(),signal:AbortSignal.any([input.signal,signal()])});
  },
  notify:async({incident,key,text,ownerScope:owner,memberScope:member,recipient,kind,authorize})=>{
   if(!authorize()||!running())return{status:'cancelled'};
   const personId=recipient==='member'?member.personId:owner.personId,label=store.person(member.personId)?.label??'家人';
   let row=coreDelivery(key);
   if(!row){const body=recipient==='member'?text:`${label}${kind==='update'?'这件事有了更新':'有件事需要你留意'}\n\n${text}\n\n可以直接回复“我来处理”“已解决”，或“告诉${label}：……”继续安排。`;
    row=store.enqueue({personId,text:body,kind:recipient==='member'?'important_clarify':'important_event',sourceKey:key,authorizationRoute:store.route(owner.personId),expiresAt:new Date(Date.parse(now())+24*3600000).toISOString()});}
   if(channels.status(personId)?.status==='connected')await flush(personId,{onlyId:row.id,authorize});
   const fresh=coreDelivery(key);return{status:fresh.status,outboxId:fresh.id};
  },
 });
 const report=error=>{lastError=error?.code==='important_events_invalid'?'重要事项记录暂时不可用，请检查服务状态。':'重要事项判断暂时未完成；普通对话仍可继续。';};
 const safeRun=operation=>Promise.resolve().then(operation).catch(report);
 function snapshot(){const value=events.state(),scope=ownerScope(),current=value.settings.ownerScope&&scope&&isCurrent(value.settings.ownerScope,'owner');return{enabled:Boolean(value.settings.enabled&&current),available:typeof classify==='function',enabledAt:value.settings.enabledAt,
  incidents:current?events.casesForOwner().filter(row=>isCurrent(row.memberScope,'elder')).map(row=>({id:row.id,personId:row.memberScope.personId,label:store.person(row.memberScope.personId)?.label??'家人',urgency:row.urgency,category:row.category,status:row.status,quote:row.evidence?.map(item=>item.quote).join('\n').slice(0,1000)??'',reason:{safety:'家人提到了需要留意的安全情况。',needs_help:'家人表示需要协助。',important_change:'家人报告了重要安排或情况变化。',service_failure:'家人报告助手服务可能未按预期完成。'}[row.category],createdAt:row.createdAt,updatedAt:row.updatedAt,deliveryStatus:row.delivery.status})):[],
  pendingCount:value.counts.prepared+value.counts.classifying,active:value.counts.active,...(lastError||value.lastError?{lastError:lastError||value.lastError}:{})};}
 function configure(enabled){if(enabled&&typeof classify!=='function')throw new Error('重要事项判断模型尚未接通。');const scope=ownerScope();if(enabled&&!scope)throw new Error('请先绑定 Owner 微信，再开启重要事项提醒。');events.configure({enabled,...(scope?{ownerScope:scope}:{})});lastError=null;return snapshot();}
 function admit(person,message,text){try{
  if(!running()||person.role!=='elder'||message.unsupported||!message.text?.trim()||explicitRelay(text))return null;
  // Never turn an already archived message into a new alert after enable.
  if(store.messages(person.id).some(row=>row.dir==='in'&&row.id===message.id))return null;
  const scope=scopeFor(person.id,'elder');return scope?events.admit({sourceId:message.id,text:text.slice(0,6000),receivedAt:now(),memberScope:scope}):null;
 }catch(error){report(error);return null;}}
 function mark(incidentId,status){const row=events.casesForOwner().find(row=>row.id===incidentId);if(!row||!isCurrent(row.memberScope,'elder'))throw new Error('这件事的家人连接已改变，请重新查看。');return events.mark({id:incidentId,status});}
 function latestContext(personId,messageId){
  const rows=store.messages(personId).filter(row=>recordMatchesBinding(row,store.binding(personId))),index=rows.findIndex(row=>row.dir==='in'&&row.id===messageId),before=index<0?rows:rows.slice(0,index);
  for(const row of before.slice(-30).reverse()){
   if(row.dir==='out'&&row.kind==='important_event')return events.casesForOwner().find(item=>item.delivery.outboxId&&row.id==='out-'+item.delivery.outboxId&&isCurrent(item.memberScope,'elder'))??null;
   if(row.dir==='out'&&row.kind==='owner_attention_reply')continue;
   if(row.dir==='in'&&(acknowledgement(row.text)||contextualMessage(row.text)))continue;
   return null;
  }return null;
 }
 async function dialogue(person,route,message,text,{origin='wechat'}={}){
  if(person.role!=='owner'||origin!=='wechat'||!route)return null;
  const toggle=text.trim().match(/^(?:请|帮我)?(开启|打开|启用|关闭|停用|暂停)(?:家人)?重要(?:事项|消息)(?:主动)?提醒[。！!\s]*$/);
  if(toggle){const enabled=/开启|打开|启用/.test(toggle[1]);configure(enabled);return{reply:enabled?'已开启重要事项主动提醒，从新收到的家人消息开始判断；普通聊天不会逐条通知。':'已关闭重要事项主动提醒，家人的正常对话和明确转告照常。',replyKind:'owner_attention_reply'};}
  if(!acknowledgement(text)&&!contextualMessage(text))return null;
  const incident=latestContext(person.id,message.id);if(!incident)return null;
  if(!running()||!isCurrent(incident.ownerScope,'owner')||!isCurrent(incident.memberScope,'elder'))return null;
  const content=contextualMessage(text);
  if(content){const target=store.person(incident.memberScope.personId),binding=store.binding(target.id);const result=await sendOwnerMessage({personId:target.id,text:content[1].trim(),bindingGeneration:binding.generation,requestId:'attention-reply-'+hash([incident.id,route,message.id,content[1]]).slice(0,56)},{authorityRoute:route,authorize:()=>running()&&isCurrent(incident.ownerScope,'owner')&&isCurrent(incident.memberScope,'elder'),signal:signal()});
   return{reply:result.status==='api_accepted'?`已向${target.label}的微信提交你的回复。`:'这条回复的投递尚未确认，没有自动重发。',replyKind:'owner_attention_reply'};}
  const status=/解决|处理好了/.test(text)?'resolved':/不再提醒|不用再提醒/.test(text)?'muted':'acknowledged';mark(incident.id,status);
  return{reply:{resolved:'这件事已记为解决。',muted:'已将这件事静音；新的明确紧急变化仍会提醒你。',acknowledged:/我来|我会/.test(text)?'已记下这件事由你处理。':'已记下你已知悉这件事。'}[status],replyKind:'owner_attention_reply'};
 }
 async function ownerNoticeForSource(personId,messageId){
  const member=scopeFor(personId,'elder'),owner=ownerScope();if(!member||!owner)return{status:'cancelled',blocked:true,id:messageId};
  const result=await events.ownerDeliveryForSource({memberScope:member,sourceId:messageId});
  if(!running()||!isCurrent(member,'elder')||!isCurrent(owner,'owner'))throw new Error('当前连接或权限已改变。');
  return result;
 }
 return{snapshot,configure,admit,mark,dialogue,ownerNoticeForSource,canDeliver:events.canDeliver,
  run:id=>safeRun(()=>events.run(id)),resume:()=>safeRun(()=>events.resume()),tick:()=>safeRun(()=>events.tick()),settled:()=>events.settled(),close:()=>events.close()};
}
