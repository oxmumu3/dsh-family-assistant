import {randomUUID,createHash} from 'node:crypto';
import {existsSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {validTimeZone,validTime} from './store.mjs';
import {localDateTimeToInstant} from './brief.mjs';
import {hasExplicitOwnerTime,assertReminderTime} from './owner-commands.mjs';
import {parseWorkbenchReply} from './workbench-model.mjs';

const clone=x=>structuredClone(x);
const fail=message=>{throw new Error(message);};
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(x)?x:fail('事项标识无效。');
const text=(x,max=6000)=>typeof x==='string'&&x.trim()&&x.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(x)?x.trim():fail('内容为空或过长。');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,40);
const routeHash=x=>createHash('sha256').update(JSON.stringify(x??null)).digest('hex');
const profileOf=p=>({label:p.label,timeZone:p.timeZone,interests:p.interests,notes:p.notes});
const safeError=e=>/token|bearer|credential|secret|https?:\/\//i.test(String(e?.message))?'服务暂时不可用，请检查连接或模型设置。':String(e?.message??'操作未完成。').slice(0,200);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function patchProfile(patch){
 if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length||Object.keys(patch).some(k=>!['label','timeZone','interests','notes'].includes(k)))fail('资料包含不支持的字段。');
 if('label'in patch)text(patch.label,80);if('timeZone'in patch)validTimeZone(patch.timeZone);
 if('interests'in patch&&(!Array.isArray(patch.interests)||patch.interests.length>20))fail('兴趣列表无效。');
 patch.interests?.forEach(x=>text(x,100));if('notes'in patch&&(typeof patch.notes!=='string'||patch.notes.length>2000))fail('资料说明过长。');return clone(patch);
}
function validatePrivateState(value){
 const plain=row=>row&&typeof row==='object'&&!Array.isArray(row);
 if(!plain(value)||Object.keys(value).some(key=>!['version','messages','cards','requests','inputs','preferences','preferenceScopes'].includes(key))||!plain(value.preferences))fail('工作台记录格式不受支持，请保留数据后检查版本。');
 for(const [personId,patch]of Object.entries(value.preferences)){id(personId);if(!plain(patch)||Object.keys(patch).some(key=>!['interests','notes'].includes(key)))fail('私密偏好记录格式无效。');if(Object.keys(patch).length)patchProfile(patch);}
 if(value.preferenceScopes!==undefined){if(!plain(value.preferenceScopes)||Object.keys(value.preferenceScopes).length>10000)fail('私密偏好范围记录格式无效。');for(const [personId,scope]of Object.entries(value.preferenceScopes)){id(personId);if(typeof scope!=='string'||!/^[a-f0-9]{64}$/.test(scope))fail('私密偏好范围记录格式无效。');}}
 for(const entry of value.inputs??[])if(entry.messageDraft!==undefined){const draft=entry.messageDraft,hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);if(!plain(draft)||Object.keys(draft).some(key=>!['origin','ownerRouteHash','cards'].includes(key))||!['wechat','console'].includes(draft.origin)||!hex(draft.ownerRouteHash)||!Array.isArray(draft.cards)||!draft.cards.length||draft.cards.length>100)fail('消息草稿来源记录无效。');for(const card of draft.cards){if(!plain(card)||Object.keys(card).some(key=>!['id','revision','recipients'].includes(key))||!Number.isSafeInteger(card.revision)||card.revision<1||!Array.isArray(card.recipients)||!card.recipients.length||card.recipients.length>100)fail('消息草稿版本记录无效。');id(card.id);for(const recipient of card.recipients){if(!plain(recipient)||Object.keys(recipient).some(key=>!['personId','routeHash'].includes(key))||!hex(recipient.routeHash))fail('消息草稿接收人记录无效。');id(recipient.personId);}}}
}
const resultStatuses=['scheduled','api_accepted','failed','uncertain','cancelled','completed'];
const publicCard=card=>{const {routes,...copy}=clone(card);if(copy.actions)copy.actions=copy.actions.map(({expectedRoute,...action})=>action);return copy;};

/** Private, single-process journal; the enclosing runtime owns its exclusive lock. */
export function createWorkbench({directory,store,plan,execute,check=async()=>null,cancel=async()=>{},now=()=>new Date().toISOString()}={}){
 const file=join(directory,'workbench.json');
 let state=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{version:1,messages:[],cards:[],requests:[],inputs:[],preferences:{}};
 if(state.version!==1||['messages','cards','requests','inputs'].some(k=>!Array.isArray(state[k]))||!state.preferences||typeof state.preferences!=='object')fail('工作台记录格式不受支持，请保留数据后检查版本。');
 validatePrivateState(state);
 let queue=Promise.resolve();
 function persist(){
  validatePrivateState(state);
  const data=JSON.stringify(state,null,2)+'\n';if(Buffer.byteLength(data)>16*1024*1024)fail('工作台记录已达到容量上限，请先导出归档。');
  const temporary=join(directory,`.workbench-${randomUUID()}.tmp`);let fd;
  try{fd=openSync(temporary,'wx',0o600);writeFileSync(fd,data);fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temporary,file);chmodSync(file,0o600);const d=openSync(directory,'r');try{fsyncSync(d);}finally{closeSync(d);}}
  catch(error){if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch{}throw error;}
 }
 const serial=work=>{const task=queue.catch(()=>{}).then(work);queue=task;return task;};
 const getCard=key=>state.cards.find(c=>c.id===id(key))??fail('没有找到这张卡片。');
 const getRequest=key=>state.requests.find(r=>r.id===id(key))??fail('没有找到这件请求。');
 const getItem=(card,key)=>card.actions?.find(a=>a.id===id(key))??fail('没有找到这项安排。');
 const touch=card=>{card.revision++;card.updatedAt=now();};
 const addMessage=(role,value,contextId,cardIds,requestId)=>state.messages.push({id:randomUUID(),role,text:value,at:now(),...(contextId?{contextId}:{}),...(cardIds?.length?{cardIds}:{}),...(requestId?{requestId}:{})});
 const route=personId=>{try{return store.route(personId);}catch{return null;}};
 const preferenceScope=personId=>createHash('sha256').update(JSON.stringify(route(personId)??{unbound:personId})).digest('hex');
 const currentPreference=personId=>{const scope=Object.hasOwn(state.preferenceScopes??{},personId)?state.preferenceScopes[personId]:undefined;const binding=store.binding(personId);const matches=scope===undefined?(!binding||binding.generation===1):scope===preferenceScope(personId);return matches&&Object.hasOwn(state.preferences,personId)?state.preferences[personId]:{};};
 const sameRequestRoute=request=>same(request.route??null,route(request.personId));
 const assertOwner=authorityRoute=>{if(authorityRoute&&store.person(authorityRoute.personId).role!=='owner')fail('只有 Owner 可以管理家人服务。');};
 const requestView=r=>{const{sourceId,route:captured,ownerRoute,...publicValue}=clone(r);return publicValue;};
 function snapshot(){return{messages:clone(state.messages.slice(-150)),cards:state.cards.map(publicCard),requests:state.requests.map(requestView)};}
 function messageDraft({requestId,origin,authorityRoute}={}){
  id(requestId);if(!['wechat','console'].includes(origin))fail('消息草稿来源无效。');const entry=state.inputs.find(row=>row.id===requestId),draft=entry?.messageDraft;if(!draft||draft.origin!==origin)return null;
  const stale={stale:true,cards:[]},owner=store.snapshot().people.find(person=>person.role==='owner');
  if(entry.status!=='complete'||!owner||routeHash(authorityRoute)!==draft.ownerRouteHash||authorityRoute&&(authorityRoute.personId!==owner.id||!same(authorityRoute,route(owner.id))))return stale;
  const cards=[];for(const reference of draft.cards){const card=state.cards.find(row=>row.id===reference.id);if(!card||card.kind!=='plan'||card.status!=='draft'||card.revision!==reference.revision||!card.actions?.length||card.actions.some(action=>action.type!=='send_message'||action.status!=='draft'||!same(action.expectedRoute??null,route(action.personId))))return stale;const recipients=[...new Set(card.actions.map(action=>action.personId))];if(recipients.length!==reference.recipients.length||reference.recipients.some(recipient=>!recipients.includes(recipient.personId)||routeHash(route(recipient.personId))!==recipient.routeHash))return stale;cards.push(publicCard(card));}
  return{stale:false,cards};
 }
 function context(value){
  if(value==null||value==='')return null;
  if(typeof value!=='string'||!/^\w+:[A-Za-z0-9_-]{1,100}$/.test(value))fail('当前对话对象无效。');
  const[k,key]=value.split(':');if(k==='card')getCard(key);else if(k==='person')store.person(key);else if(k==='request')getRequest(key);else fail('当前对话对象无效。');return value;
 }
 function selectedCard(key,ctx){
  const card=getCard(key);
  if(ctx&&ctx!==`card:${key}`&&!(card.kind==='profile'&&ctx===`person:${card.personId}`))fail('这条修改与输入框当前对象不同，请先选择正确的卡片。');
  if(!ctx&&state.cards.filter(c=>c.status==='draft').length>1)fail('有不止一张待处理卡片，请点选你要修改的那一张。');
  return card;
 }
 function summarize(card){
  if(card.kind!=='plan')return;
  const statuses=card.actions.map(a=>a.status);
  card.status=statuses.every(s=>s==='cancelled')?'cancelled':statuses.some(s=>s==='draft')?'draft':statuses.some(s=>['running','scheduled','failed','uncertain'].includes(s))?'active':'completed';
 }
 function validatedAction(a,prior,instruction){
  const person=store.person(a.personId);if(person.role!=='elder')fail('此安排请选择一位已登记的长辈。');
  if(prior&&(prior.personId!==a.personId||prior.type!==a.type))fail('请新建另一项安排，不能把已有事项换给另一位家人。');
  const result={...clone(a),id:prior?.id??randomUUID(),targetLabel:person.label,status:'draft',attempt:prior?.attempt??0,expectedRoute:prior?.expectedRoute??route(person.id)};
  if(a.type==='remind'){
   text(a.text,200);validTime(a.time);if(!['once','daily'].includes(a.repeat))fail('提醒重复方式无效。');
   const dueAt=localDateTimeToInstant(a.date,a.time,person.timeZone);if(!dueAt||Date.parse(dueAt)<=Date.parse(now()))fail('提醒时间已经过去或不存在，请说明家人当地的未来时间。');
   if((!prior||a.date!==prior.date||a.time!==prior.time)&&!hasExplicitOwnerTime(instruction,a.timeEvidence))fail('请说清楚提醒时间，例如明早八点；我不会替你猜。');if(!prior||a.date!==prior.date||a.time!==prior.time||a.repeat!==prior.repeat){
     let timing=a.timeEvidence;
     if(prior){
      if(a.date===prior.date&&!/今天|今日|今早|今晚|明天|明早|明晚|后天|\d{4}[-年]/.test(timing))timing=prior.date+' '+timing;
      if(!/早|晨|上午|凌晨|下午|晚上|傍晚|晚间|中午|午间|\d{1,2}:\d{2}/.test(timing))timing=(Number(prior.time.slice(0,2))<12?'上午':'下午')+timing;
      if(a.repeat===prior.repeat&&a.repeat==='daily'&&!/每天|每日|每晚|每早/.test(timing))timing='每天 '+timing;
     }
     assertReminderTime(a,{text:timing,target:person,now:now()});
   }result.dueAt=dueAt;result.timeZone=person.timeZone;
  }else if(a.type==='send_message')text(a.text,3000);
  else if(a.type==='daily_schedule'){if(typeof a.enabled!=='boolean')fail('请确认要开启还是停用日报。');if(a.enabled)validTime(a.time);}
  else if(a.type==='presentation_service'){if(typeof a.enabled!=='boolean')fail('请确认要开启还是停用 PPT 制作。');}
  else if(a.type==='cancel_reminder'){const reminder=store.reminders(person.id).find(r=>r.id===a.reminderId);if(!reminder)fail('没有找到这位家人的提醒。');}
  else if(a.type!=='send_daily')fail('不支持这项安排。');
  return result;
 }
 function newCard(kind){return{id:randomUUID(),kind,title:kind==='profile'?'家人资料':'家庭安排',status:'draft',revision:1,createdAt:now(),updatedAt:now()};}
 function applyProfile(op,ctx){
  const patch=patchProfile(op.patch);let card=op.cardId?selectedCard(op.cardId,ctx):ctx?.startsWith('card:')?getCard(ctx.slice(5)):null;
  if(card&&card.kind!=='profile')fail('当前不是资料卡，请先选择家人。');
  const personId=op.personId??card?.personId??(ctx?.startsWith('person:')?ctx.slice(7):null);
  if(ctx?.startsWith('person:')&&personId!==ctx.slice(7))fail('资料对象与当前家人不同。');
  if(card?.personId&&personId!==card.personId)fail('不能把资料卡换成另一位家人。');
  if(card?.status==='cancelled')fail('这张资料草稿已取消，请新建。');
  if(personId){
   const person=store.person(personId);if(person.role!=='elder')fail('Owner 身份请在服务设置中修改。');
   card??=state.cards.find(c=>c.kind==='profile'&&c.personId===personId&&c.status==='saved');
   if(!card){card=newCard('profile');state.cards.push(card);}
   const previous=profileOf(person),next={...previous,...patch};
   // Profile edits only affect owner-supplied service information, never sharing or identity.
   store.updatePerson(personId,patch);Object.assign(card,{personId,profile:next,previousProfile:previous,status:'saved',title:next.label+'的资料',detail:'已保存这次资料修正；可以撤销。'});touch(card);
  }else{
   if(!card&&!patch.label)fail('还不知道该怎么称呼这位家人，请补充称呼。');
   if(!card){card=newCard('profile');state.cards.push(card);}
   card.profile={...(card.profile??{timeZone:store.snapshot().config.timeZone,interests:[],notes:''}),...patch};
   if(!card.profile.label)fail('还不知道该怎么称呼这位家人，请补充称呼。');
   card.title=card.profile.label+'的资料';touch(card);
  }
  persist();return card.id;
 }
 async function applyOperation(op,ctx,instruction,authorityRoute){
  if(!op)return[];
  if(op.type==='profile')return[applyProfile(op,ctx)];
  if(op.type==='plan'){
   let card=op.cardId?selectedCard(op.cardId,ctx):ctx?.startsWith('card:')&&getCard(ctx.slice(5)).kind==='plan'?getCard(ctx.slice(5)):null;
   if(card&&card.kind!=='plan')fail('当前不是安排卡片。');
   if(card&&!['draft','active'].includes(card.status))fail('这张安排已结束，请新建安排。');
   const additions=op.actions.map(a=>{if(ctx?.startsWith('person:')&&a.personId!==ctx.slice(7))fail('这项安排不属于当前选中的家人。');const prior=a.id?getItem(card??fail('新安排不能引用其他事项。'),a.id):null;if(prior&&prior.status!=='draft')fail('已执行的安排不能直接修改，请先取消未发送的提醒，再新建。');return validatedAction(a,prior,instruction);});
   if(!card){card=newCard('plan');card.actions=[];state.cards.push(card);}
   for(const action of additions){const i=card.actions.findIndex(x=>x.id===action.id);if(i>=0)card.actions[i]=action;else card.actions.push(action);}
   touch(card);summarize(card);persist();return[card.id];
  }
  if(op.type==='cancel'){selectedCard(op.cardId,ctx);await cancelInternal(op);return[op.cardId];}
  if(op.type==='confirm'){
   const card=selectedCard(op.cardId,ctx);if(!/^(?:好[的，, ]*)?(?:确认(?:保存|安排|执行|发送)?|同意(?:执行|发送)?|保存(?:资料|这张资料卡|卡片)?|就这样(?:安排|执行)?|执行|发吧|安排吧)[。！!\s]*$/.test(instruction.trim()))fail('还没有确认执行，请先核对卡片。');
   await confirmInternal({cardId:card.id,revision:card.revision,authorityRoute});return[card.id];
  }
  if(op.type==='reply_request'){
   const request=getRequest(op.requestId);if(ctx&&ctx!==`request:${request.id}`)fail('当前选择的请求与回复对象不一致。');
   if(request.status==='resolved')fail('这件请求已结束。');
   const card=newCard('plan');card.title='回复'+store.person(request.personId).label;card.actions=[{id:randomUUID(),type:'reply_request',requestId:request.id,personId:request.personId,targetLabel:store.person(request.personId).label,text:text(op.text,2000),status:'draft',attempt:0,expectedRoute:request.route}];state.cards.push(card);persist();return[card.id];
  }
  fail('暂不支持这个操作，请再说明你的意图。');
 }
 function chat(input){return serial(async()=>{
  assertOwner(input.authorityRoute);
  if(Object.hasOwn(input,'profileIntake')&&input.profileIntake!==true)fail('建档模式参数无效。');
  if(Object.hasOwn(input,'profileEdit')&&input.profileEdit!==true)fail('资料编辑模式参数无效。');if(input.profileEdit&&(input.profileIntake||input.draftOnly))fail('资料编辑不能同时作为新建或项目草稿。');
  if(Object.hasOwn(input,'draftOnly')&&input.draftOnly!==true)fail('草稿模式参数无效。');
  const draftOrigin=input.messageDraftOrigin;if(draftOrigin!==undefined&&(!['wechat','console'].includes(draftOrigin)||input.draftOnly!==true||input.profileIntake||input.profileEdit))fail('消息草稿来源需要独立的 draftOnly 模式。');
  const ownerDraftRoute=clone(input.authorityRoute??null),value=text(input.text),key=id(input.requestId),ctx=context(input.contextId),fingerprintInput=input.profileEdit?[value,ctx,'profile-edit']:input.draftOnly?[value,ctx,'draft-only']:input.profileIntake?[value,ctx,'profile-intake']:[value,ctx],fingerprint=hash(draftOrigin?[...fingerprintInput,'message-draft',draftOrigin]:fingerprintInput);
  if(input.profileIntake&&ctx){const intakeCard=ctx.startsWith('card:')?getCard(ctx.slice(5)):null;if(!intakeCard||intakeCard.kind!=='profile'||intakeCard.personId||intakeCard.status!=='draft')fail('请在添加家人的资料草稿里继续补充。');}
  const editPersonId=input.profileEdit?(ctx?.startsWith('person:')?ctx.slice(7):ctx?.startsWith('card:')&&getCard(ctx.slice(5)).kind==='profile'?getCard(ctx.slice(5)).personId:null):null;
  if(input.profileEdit&&(!editPersonId||store.person(editPersonId).role!=='elder'))fail('请先选择要补充资料的已登记家人。');
  const prior=state.inputs.find(x=>x.id===key);if(prior){if(prior.fingerprint!==fingerprint)fail('重复的请求标识对应不同内容。');return snapshot();}
  if(!store.snapshot().people.some(p=>p.role==='owner'))fail('先登记你自己作为 Owner，再开始交代事情。');
  if(!plan)fail('尚未连接管理对话模型，请先选择 Harness 模型。');
  const entry={id:key,fingerprint,status:'planning',at:now()};state.inputs.push(entry);addMessage('user',value,ctx,undefined,key);persist();
  try{
   const view=snapshot(),routesBefore=new Map(store.snapshot().people.map(p=>[p.id,route(p.id)]));const output=await plan({text:input.profileEdit?'这是独立的已登记家人资料编辑。仅更新当前contextId指向的这一位家人的profile；允许合并补充偏好与资料，不能创建新人、修改其他人、安排任务、确认卡片或发消息。未知信息不猜。\n用户补充：'+value:input.profileIntake?'这是独立的添加家人对话。只整理这位新家人的 profile 资料草稿；不要更新已登记成员、确认创建、开通服务或发送消息。称呼、喜欢做的事和希望助手帮的事都来自以下描述，未知信息不猜；所需帮助写入 notes。'+(ctx?'继续修正当前这张草稿。':'不要引用其他卡片。')+'\n用户描述：'+value:value,contextId:ctx,people:store.snapshot().people.filter(p=>!input.profileEdit||p.id===editPersonId).map(p=>({...profileOf(p),id:p.id,role:p.role})),cards:input.profileEdit?view.cards.filter(card=>card.kind==='profile'&&card.personId===editPersonId):view.cards,requests:input.profileEdit?[]:view.requests,history:(input.profileEdit?view.messages.filter(message=>message.contextId===ctx):view.messages).slice(-30),now:now()});
   const result=parseWorkbenchReply(JSON.stringify(output));if(input.authorize&&!input.authorize())fail('指令期间服务或你的绑定已改变，未执行。');
   if(draftOrigin){const op=result.operation,existing=op?.cardId?getCard(op.cardId):ctx?.startsWith('card:')?getCard(ctx.slice(5)):null;if(!op||op.type!=='plan'||!op.actions?.length||op.actions.some(action=>action.type!=='send_message')||existing&&(existing.kind!=='plan'||existing.status!=='draft'||existing.actions.some(action=>action.type!=='send_message'||action.status!=='draft')))fail('这份消息草稿尚未准备好；这里只能整理待确认的消息正文，请明确收件人和完整内容。');}
   if(input.draftOnly&&result.operation){
    const op=result.operation,existing=op.cardId?getCard(op.cardId):ctx?.startsWith('card:')?getCard(ctx.slice(5)):null;
    if(!['profile','plan','reply_request'].includes(op.type)||(op.type==='profile'&&(op.personId||existing?.personId||ctx?.startsWith('person:'))))fail('项目助手只能整理待确认草稿，请在家庭助手卡片上确认后执行。');
   }
   if(input.profileEdit&&result.operation){const op=result.operation;if(op.type!=='profile'||op.personId&&op.personId!==editPersonId||op.cardId&&getCard(op.cardId).personId!==editPersonId)fail('资料编辑只能修改当前家人的资料，不能安排其他操作。');}
   if(input.profileIntake&&result.operation){const op=result.operation;if(op.type!=='profile'||op.personId||(op.cardId&&op.cardId!==ctx?.slice(5)))fail('添加家人只整理新资料草稿，请核对后点击确认创建。');}
   for(const a of result.operation?.actions??[]){if(!same(routesBefore.get(a.personId),route(a.personId)))fail('家人的绑定在理解指令时发生变化，请核对后重说。');}
   const cardIds=await applyOperation(result.operation,ctx,value,input.authorityRoute);
   if(draftOrigin){if(input.authorize&&input.authorize()!==true||ownerDraftRoute&&!same(ownerDraftRoute,route(ownerDraftRoute.personId)))fail('消息草稿的 Owner 连接已改变，尚未准备好。');const cards=cardIds.map(getCard);if(!cards.length||cards.some(card=>card.kind!=='plan'||card.status!=='draft'||!card.actions.length||card.actions.some(action=>action.type!=='send_message'||action.status!=='draft'||!same(action.expectedRoute??null,route(action.personId)))))fail('消息草稿对象或版本已改变，尚未准备好。');entry.messageDraft={origin:draftOrigin,ownerRouteHash:routeHash(ownerDraftRoute),cards:cards.map(card=>({id:card.id,revision:card.revision,recipients:[...new Set(card.actions.map(action=>action.personId))].map(personId=>({personId,routeHash:routeHash(route(personId))}))}))};}
   const reply=draftOrigin?cardIds.map(cardId=>getCard(cardId).actions.map(action=>`发给${action.targetLabel}：\n${action.text}`).join('\n\n')).join('\n\n')+'\n\n回复“确认发送”即可发送，也可以继续告诉我怎样修改。':result.operation?.type==='profile'?(getCard(cardIds[0]).status==='saved'?'资料已更新，可以撤销上次修正。':'已整理成资料卡。核对后保存，再由家人本人连接微信。'):result.operation?.type==='plan'||result.operation?.type==='reply_request'?'已整理好，请核对卡片中的对象、内容与时间后确认。':result.operation?.type==='cancel'?'已取消可取消的安排，其他事项保留。':result.operation?.type==='confirm'?'已按卡片处理，请查看各项实际状态。':result.reply;
   addMessage('assistant',reply,ctx,cardIds,key);entry.status='complete';persist();return snapshot();
  }catch(error){entry.status='failed';addMessage('assistant',safeError(error)+' 你可以补充说明后再试。',ctx,undefined,key);persist();return snapshot();}
 });}
 async function runItem(card,action,authorityRoute,authorize){
  if(authorize&&authorize()!==true)fail('当前指令授权已改变，尚未执行。');
  action.status='running';action.attempt=(action.attempt??0)+1;action.detail='正在处理';touch(card);persist();
  let result;
  try{result=action.type==='reply_request'?await replyInternal({requestId:action.requestId,text:action.text,operationId:`card-${action.id}-${action.attempt}`,authorityRoute,authorize}):await execute({...clone(action),authorityRoute,authorize,cardId:card.id,sourceKey:`workbench:${card.id}:${action.id}:${action.attempt}`});}
  catch(error){result={status:error?.sendOutcome==='failed'?'failed':'uncertain',detail:safeError(error)};}
  if(!result||!resultStatuses.includes(result.status))result={status:'uncertain',detail:'没有取得明确结果，请先核对；不会自动重试。'};
  Object.assign(action,{status:result.status,detail:result.detail??({api_accepted:'微信接口已接受，实际收信待本人确认。',scheduled:'安排已保存，尚未发送。',failed:'未完成，可检查后重试。',uncertain:'结果不明，请先核对，不会自动重发。',cancelled:'已取消',completed:'已完成'}[result.status]),...(result.resultId?{resultId:result.resultId}:{})});
  if(action.type==='daily_schedule'&&['scheduled','completed'].includes(action.status)){for(const oldCard of state.cards)for(const old of oldCard.actions??[]){if(old.id!==action.id&&old.type==='daily_schedule'&&old.personId===action.personId&&old.status==='scheduled'){old.status='completed';old.detail='已被后续每日安排替代。';touch(oldCard);summarize(oldCard);}}}
  summarize(card);touch(card);persist();
 }
 async function confirmInternal({cardId,revision,authorityRoute,authorize}){
  if(authorize&&authorize()!==true)fail('当前指令授权已改变，尚未执行。');
  assertOwner(authorityRoute);
  const card=getCard(cardId);
  if(card.kind==='profile'&&card.status==='saved')return snapshot();
  if(card.kind==='plan'&&!card.actions.some(a=>a.status==='draft'))return snapshot();
  if(!Number.isSafeInteger(revision)||card.revision!==revision)fail('卡片刚刚更新，请重新核对当前版本。');
  if(card.kind==='profile'){
   if(card.status!=='draft')fail('这张资料卡已取消。');
   const personId='family-'+hash(card.id);let person=store.snapshot().people.find(p=>p.id===personId);
   if(!person)person=store.addPerson({id:personId,role:'elder',...patchProfile(card.profile),shareWithOwner:'none',dailyEnabled:false});
   Object.assign(card,{personId:person.id,status:'saved',detail:'已建档；微信连接和日报开启分别设置。'});touch(card);persist();
  }else for(const action of card.actions.filter(a=>a.status==='draft'))await runItem(card,action,authorityRoute,authorize);
  return snapshot();
 }
 async function cancelInternal({cardId,actionId}){
  const card=getCard(cardId);
  if(card.kind==='profile'){if(card.status!=='draft')fail('已保存的资料不能作为草稿取消；可继续修改。');card.status='cancelled';touch(card);persist();return snapshot();}
  const items=actionId?[getItem(card,actionId)]:card.actions;
  for(const action of items){
   if(action.status==='draft'){action.status='cancelled';action.detail='已取消，未执行。';}
   else if(action.status==='scheduled'&&['remind','daily_schedule'].includes(action.type)){await cancel(clone(action));action.status='cancelled';action.detail='后续提醒已取消，已经提交的消息无法撤回。';}
   else if(actionId&&action.status!=='cancelled')fail('这项操作已经提交，不能撤回；结果不明时请先核对。');
  }
  touch(card);summarize(card);persist();return snapshot();
 }
 function createRequest({personId,text:value,sourceId}){
  const person=store.person(personId);if(person.role!=='elder')fail('只有家人可以发起此请求。');text(value,2000);text(sourceId,512);
  const key='request-'+hash([personId,sourceId,route(personId)]);let request=state.requests.find(r=>r.id===key);if(request)return clone(request);
  const owner=store.snapshot().people.find(p=>p.role==='owner');if(!owner)fail('尚未设置家庭联系人。');
  request={id:key,personId,text:value,status:'open',sourceId,route:route(personId),ownerRoute:route(owner.id),createdAt:now(),updatedAt:now(),responses:[]};state.requests.push(request);persist();return clone(request);
 }
 async function replyInternal({requestId,text:value,operationId,authorityRoute,authorize}){
  if(authorize&&authorize()!==true)fail('当前指令授权已改变，尚未执行。');
  const request=getRequest(requestId);text(value,2000);id(operationId);
  const duplicate=request.responses.find(r=>r.operationId===operationId);
  if(duplicate){if(duplicate.text!==value)fail('回复标识已用于其他内容。');return{status:duplicate.status,resultId:duplicate.resultId};}
  if(request.status==='resolved')fail('这件请求已结束，请先与家人确认新的事项。');
  if(request.responses.some(r=>r.by==='owner'&&['running','uncertain'].includes(r.status)))fail('上一次回复结果不明，请先核对，不要重复发送。');
  const response={by:'owner',text:value,at:now(),status:'running',operationId};request.responses.push(response);persist();
  let result;try{result=await execute({id:operationId,type:'request_reply',authorityRoute,authorize,personId:request.personId,text:value,requestId:request.id,requestText:request.text,expectedRoute:request.route,sourceKey:`request-reply:${request.id}:${operationId}`});}catch(error){result={status:error?.sendOutcome==='failed'?'failed':'uncertain',detail:safeError(error)};}
  if(!result||!resultStatuses.includes(result.status))result={status:'uncertain'};
  Object.assign(response,{status:result.status,...(result.resultId?{resultId:result.resultId}:{})});Object.assign(request,{reply:value,replyStatus:result.status,resultId:result.resultId,updatedAt:now()});
  if(result.status==='api_accepted'&&request.status!=='resolved')request.status='waiting';persist();return result;
 }
 // A stopped process cannot prove an in-flight call failed. Keep it unavailable for retry.
 for(const entry of state.inputs)if(entry.status==='planning')entry.status='interrupted';
 for(const card of state.cards)for(const action of card.actions??[])if(action.status==='running'){action.status='uncertain';action.detail='上次处理被中断，请核对状态，不会重复执行。';summarize(card);}
 for(const request of state.requests)for(const response of request.responses??[])if(response.status==='running'){response.status='uncertain';request.replyStatus='uncertain';}
 persist();
 return{
  refresh(){let dirty=false;for(const card of state.cards)for(const action of card.actions??[]){if(!['scheduled','uncertain'].includes(action.status))continue;const result=check({...clone(action),cardId:card.id,sourceKey:`workbench:${card.id}:${action.id}:${action.attempt}`});if(result&&typeof result.then!=='function'&&resultStatuses.includes(result.status)&&result.status!==action.status){Object.assign(action,result);touch(card);summarize(card);dirty=true;}}if(dirty)persist();},
  snapshot,chat,messageDraft,
  external(input,handler){return serial(async()=>{assertOwner(input.authorityRoute);const value=text(input.text),key=id(input.requestId),fingerprint=hash(['external',value,input.contextId??null]);const prior=state.inputs.find(row=>row.id===key);if(prior){if(prior.fingerprint!==fingerprint)fail('重复的请求标识对应不同内容。');return snapshot();}const entry={id:key,fingerprint,status:'planning',at:now()};state.inputs.push(entry);addMessage('user',value,null,undefined,key);persist();try{const result=await handler({confirm:confirmInternal});if(!result.deferred)addMessage('assistant',text(result.reply,24000),null,undefined,key);if(result.taskId)state.messages.at(-1).taskId=result.taskId;entry.status='complete';}catch(error){entry.status='failed';addMessage('assistant',safeError(error),null,undefined,key);}persist();return snapshot();});},
  appendExternal({reply,requestId,taskId}){return serial(()=>{const key=id(requestId);if(!state.messages.some(row=>row.requestId===key)){addMessage('assistant',text(reply,24000),null,undefined,key);if(taskId)state.messages.at(-1).taskId=taskId;persist();}return snapshot();});},
  confirm:args=>serial(()=>confirmInternal(args)),cancel:args=>serial(()=>cancelInternal(args)),
  async retry({cardId,actionId}){return serial(async()=>{const card=getCard(cardId),action=getItem(card,actionId);if(action.status!=='failed')fail('只有明确失败的操作可以重试；未知结果请先核对。');await runItem(card,action);return snapshot();});},
  async check({cardId,actionId}){return serial(async()=>{const card=getCard(cardId),action=getItem(card,actionId);const result=await check({...clone(action),cardId:card.id,sourceKey:`workbench:${card.id}:${action.id}:${action.attempt}`});if(result&&resultStatuses.includes(result.status)){Object.assign(action,result);touch(card);summarize(card);persist();}return snapshot();});},
  async undo({cardId}){return serial(()=>{const card=getCard(cardId);if(!card.previousProfile||!card.personId)fail('没有可以撤销的资料修正。');if(!same(profileOf(store.person(card.personId)),card.profile))fail('资料后来已有更新，不能覆盖；请直接说明新的修改。');store.updatePerson(card.personId,card.previousProfile);card.profile=card.previousProfile;delete card.previousProfile;card.detail='已撤销上次资料修正。';touch(card);persist();return snapshot();});},
  createRequest,reply:args=>serial(()=>replyInternal(args)),
  resolve({requestId}){return serial(()=>{const request=getRequest(requestId);request.status='resolved';request.resolvedBy='owner';request.updatedAt=now();persist();return snapshot();});},
  memberResponse({personId,requestId,text:value}){const request=getRequest(requestId);if(request.personId!==personId)fail('不能更新其他家人的请求。');if(!sameRequestRoute(request))fail('请求属于旧微信绑定，当前成员不能回应。');if(request.status!=='waiting')fail('这件请求还没有等待本人回复。');request.responses.push({by:'elder',text:text(value,2000),at:now()});request.status='resolved';request.resolvedBy='elder';request.updatedAt=now();persist();return clone(request);},
  memberRequests:personId=>clone(state.requests.filter(r=>r.personId===personId&&r.status!=='resolved'&&sameRequestRoute(r)).map(requestView)),
  savePreference(personId,patch){store.person(personId);if(Object.keys(patch).some(k=>!['interests','notes'].includes(k)))fail('只能修改自己的陪伴偏好。');const updated={...currentPreference(personId),...patchProfile(patch)};state.preferences={...state.preferences,[personId]:updated};state.preferenceScopes={...(state.preferenceScopes??{}),[personId]:preferenceScope(personId)};persist();},
  memberProfile(personId){return{...store.person(personId),...clone(currentPreference(personId))};},
  settled:()=>queue.catch(()=>{}),
 };
}
