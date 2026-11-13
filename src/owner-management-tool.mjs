import {createHash,randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {mkdirSync,lstatSync,realpathSync,openSync,fstatSync,readFileSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync,constants} from 'node:fs';

const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const fields=(value,allowed,required=allowed)=>plain(value)&&Object.keys(value).every(key=>allowed.includes(key))&&required.every(key=>Object.hasOwn(value,key));
const string=(value,max=512)=>typeof value==='string'&&value.trim()&&value.length<=max&&!/[\x00-\x1f\x7f]/u.test(value);
const content=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)&&Buffer.from(value).toString('utf8')===value;
const canonical=value=>JSON.stringify(value,(_key,item)=>plain(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const clone=value=>structuredClone(value),hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const utf8Prefix=(value,max)=>{const bytes=Buffer.from(String(value??''));if(bytes.length<=max)return bytes.toString();let end=max;while(end>0&&(bytes[end]&0xc0)===0x80)end--;return bytes.subarray(0,end).toString('utf8');};
const fail=(message,code='owner_management_forbidden')=>{throw Object.assign(new Error(message),{code});};
const routeHash=route=>hash(route??null);
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const visible=value=>value.replace(/```[\s\S]*?```|`[^`\n]*`|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'/gu,part=>part.replace(/[^\n]/gu,' '));
const negatedRecipientCommand=prefix=>/(?:不要|别|不用|无需|不必|不能|禁止|先不|暂不|不再|停止)[^。！？!?；;\n]{0,24}(?:告诉|转告|通知|发给|发送给|给|跟|对|为)\s*$/u.test(prefix);
export const isOwnerManagementConfirmation=text=>typeof text==='string'&&/^(?:好(?:的)?[，,\s]*)?(?:确认(?:保存|安排|执行|发送)?|同意(?:执行|发送)?|就这样(?:安排|执行)?|执行|发吧|发送吧|安排吧)[。！!\s]*$/u.test(text.trim());
/** Service drafts made from one Owner native session are visible only inside
 * that same session. HTTP/console keep their existing default context. */
export const ownerServiceContextId=sessionId=>'owner-session-'+createHash('sha256').update(String(sessionId??'')).digest('hex').slice(0,40);

function aliases(person){
 const values=[person.label];
 if(/妈|母亲/.test(person.label))values.push('妈妈','我妈','母亲','爸妈','爸爸妈妈','父母');
 if(/爸|父亲/.test(person.label))values.push('爸爸','我爸','父亲','爸妈','爸爸妈妈','父母');
 return [...new Set(values.filter(value=>string(value,100)))].sort((a,b)=>b.length-a.length);
}

/** Draft/review/hold instructions belong to the handling of a message. Quoted
 * payload text is masked so its own conditional or "don't send" wording does
 * not change what the current Owner asked the assistant to do. */
export function isOwnerMessageDraftIntent({userText,people}={}){
 if(!content(userText,64000)||!Array.isArray(people))return false;
 const speech=visible(userText);
 if(/^(?:你(?:现在)?)?(?:能不能|可不可以|能否|是否|会不会)[\s，,]*/u.test(speech.trim()))return false;
 const handling=/草稿|起草|先拟|先给我看|先让我看|等我(?:确认|同意|看过)|暂缓(?:发|发送)|(?:先|暂时|暂|现在)?(?:别|不要|不用|不)(?:直接|马上|立刻|立即)?(?:发(?:送)?|转告|转达)/u;
 if(!handling.test(speech))return false;
 for(const person of people.filter(row=>plain(row)&&row.role==='elder'&&string(row.label,100))){
  for(const name of aliases(person))for(const match of speech.matchAll(new RegExp(escape(name),'gu'))){
   const prefix=speech.slice(0,match.index).split(/[。！？!?；;\n]/u).at(-1)??'';
   if(negatedRecipientCommand(prefix))continue;
   if(/解释|讨论|什么意思|材料(?:里|中)|文章(?:里|中)|里面写|原文(?:是|为)|如果|假如|假设|比如|例如|举例|设想/u.test(prefix))continue;
   if(/(?:告诉|转告|通知|发给|发送给|给|跟|对|为)\s*$/u.test(prefix))return true;
  }
 }
 return false;
}

/** A model-supplied target, evidence or authorization claim cannot replace the
 * verified current human request. This deliberately handles literal messages;
 * generated project deliverables keep the Runtime's separate delivery target. */
export function ownerLiteralMessageAuthorized({userText,target,people,text}={}){
 if(!content(userText,64000)||!plain(target)||!string(target.id,100)||!string(target.label,100)||!Array.isArray(people)||!content(text,2800))return false;
 if(isOwnerMessageDraftIntent({userText,people}))return false;
 const body=text.trim(),speech=visible(userText);
 if(/^(?:你(?:现在)?)?(?:能不能|可不可以|能否|是否|会不会)[\s，,]*/u.test(speech.trim()))return false;
 const plural=new Set(['爸妈','爸爸妈妈','父母']);
 for(const name of aliases(target)){
  const owners=people.filter(person=>person.role==='elder'&&aliases(person).includes(name));
  if(!plural.has(name)&&owners.length!==1||plural.has(name)&&owners.length!==2)continue;
  const pattern=new RegExp(escape(name),'gu');
  for(const match of speech.matchAll(pattern)){
   const prefix=speech.slice(0,match.index).split(/[。！？!?；;\n]/u).at(-1)??'',at=match.index+name.length;
   if(negatedRecipientCommand(prefix))continue;
   if(/明早|明天|后天|明晚|每天|每日|每晚|每早|定时|今晚|\d{4}[-/.年]\d{1,2}|\d{1,2}[:：]\d{2}|(?:早上|上午|下午|晚上|凌晨|中午|今天|今日).{0,8}[一二两三四五六七八九十\d]+(?:点|时)/u.test(prefix))continue;
   if(/解释|讨论|什么意思|材料(?:里|中)|文章(?:里|中)|里面写|原文(?:是|为)|如果|假如|假设|比如|例如|举例|设想|(?:没(?:有)?(?:让|叫|要求|授权)|并未(?:让|要求)|不是让|没有同意|未授权)|(?:不要|别|不用|无需|不必|不能|禁止|先不).{0,18}(?:发送|发给|告诉|转告|通知|联系|外发)/u.test(prefix))continue;
   const command=prefix.match(/(?:告诉|转告|通知|发给|发送给|给|跟|对)\s*$/u)?.[0];if(!command)continue;
   const start=userText.indexOf(body,at);if(start<at)continue;
   const gap=userText.slice(at,start),tail=userText.slice(start+body.length).trim();
   if(!/^(?:\s|[，,：:“「『"']){0,12}(?:(?:都|各)?(?:发(?:送)?(?:一(?:条|句))?(?:微信|消息|话)?|说|转达|转告|捎话)(?:\s|[，,：:“「『"']){0,12})?$/u.test(gap))continue;
   if(['给','跟','对'].includes(command.trim())&&!/发|说|转达|转告|捎话/u.test(gap))continue;
   if(!/^[。！？!?，,\s”」』"']*(?:(?:可以吗|好吗|行吗|谢谢|麻烦了)[。！？!?\s”」』"']*)?$/u.test(tail))continue;
   return true;
  }
 }
 return false;
}

const intentOf=card=>({id:card.id,revision:card.revision,kind:card.kind,...(card.personId?{personId:card.personId}:{}),...(card.profile?{profile:card.profile}:{}),...(card.patch?{patch:card.patch}:{}),...(card.actions?{actions:card.actions.map(action=>Object.fromEntries(Object.entries(action).filter(([key])=>!['status','attempt','detail','expectedRoute','authorityRoute'].includes(key))))}:{} )});
const publicCard=card=>{
 const project=value=>Array.isArray(value)?value.map(project):plain(value)?Object.fromEntries(Object.entries(value).filter(([key])=>!['routes','route','expectedRoute','authorityRoute','accountId','peerId','token','contextToken'].includes(key)).map(([key,item])=>[key,project(item)])):value;
 return project(card);
};
/** The one model-visible handoff for a shown service draft. The readable reply
 * stays exactly what the Owner saw; this reference is appended to the tool
 * result so the next turn's service_confirm can submit the precise draft id and
 * revision. It is internal wiring: never part of the Owner-facing reply, and the
 * model never has to read local storage or guess an id. */
export const serviceDraftReferenceMarker='[family_assistant:service_draft]';
export function serviceDraftReference(draft){
 if(!plain(draft)||typeof draft.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(draft.id)||!Number.isSafeInteger(draft.revision)||draft.revision<1)return null;
 // Only a ready WeChat-session draft can be confirmed next turn; other states
 // must be re-displayed, so handing out an id would invite a guaranteed reject.
 if(draft.status!=='ready'||draft.origin!=='wechat')return null;
 if(typeof draft.summary!=='string'||!draft.summary.trim())return null;
 return{draftId:draft.id,revision:draft.revision};
}
const wireServiceDraft=value=>plain(value)&&typeof value.draftId==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value.draftId)&&Number.isSafeInteger(value.revision)&&value.revision>=1?{draftId:value.draftId,revision:value.revision}:null;

function journalFor(directory){
 if(!string(directory,4096))fail('Owner 工具需要私有数据目录。');
 const requested=resolve(directory);let before;try{before=lstatSync(requested);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(before&&(before.isSymbolicLink()||!before.isDirectory()))fail('Owner 工具目录不能是链接。');mkdirSync(requested,{recursive:true,mode:0o700});
 const root=realpathSync(requested),identity=lstatSync(root),file=join(root,'owner-native-management.json');
 const secure=(optional=false)=>{const directoryStat=lstatSync(root);if(directoryStat.isSymbolicLink()||!directoryStat.isDirectory()||directoryStat.dev!==identity.dev||directoryStat.ino!==identity.ino||realpathSync(root)!==root)fail('Owner 工具目录已改变。');let stat;try{stat=lstatSync(file);}catch(error){if(error.code==='ENOENT'&&optional)return null;throw error;}if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)||stat.size>4*1024*1024)fail('Owner 工具记录路径或权限无效。');return stat;};
 const validate=state=>{
  if(!fields(state,['version','drafts','confirmations'])||state.version!==1||!Array.isArray(state.drafts)||!Array.isArray(state.confirmations)||state.drafts.length>2000||state.confirmations.length>2000)fail('Owner 工具记录格式无效。');
  for(const row of state.drafts){if(!fields(row,['sessionId','sourceRequestId','taskId','origin','ownerId','ownerRouteHash','cardId','revision','cardIntentHash','recipients'])||![row.sessionId,row.sourceRequestId,row.taskId,row.ownerId,row.cardId].every(value=>string(value))||!['console','wechat'].includes(row.origin)||!hex(row.ownerRouteHash)||!hex(row.cardIntentHash)||!Number.isSafeInteger(row.revision)||row.revision<1||!Array.isArray(row.recipients)||row.recipients.length>100||row.recipients.some(item=>!fields(item,['personId','routeHash'])||!string(item.personId,100)||!hex(item.routeHash)))fail('Owner 草稿来源记录无效。');}
  const seen=new Set();for(const row of state.confirmations){if(!fields(row,['key','status','result'],['key','status'])||!hex(row.key)||seen.has(row.key)||!['dispatching','completed','failed','unknown'].includes(row.status)||row.result!==undefined&&(!plain(row.result)||Buffer.byteLength(JSON.stringify(row.result))>16000))fail('Owner 确认记录无效。');seen.add(row.key);}return state;
 };
 const read=()=>{const stat=secure();let fd;try{fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);const opened=fstatSync(fd);if(opened.dev!==stat.dev||opened.ino!==stat.ino||opened.nlink!==1)fail('Owner 工具记录读取时发生变化。');return validate(JSON.parse(readFileSync(fd,'utf8')));}finally{if(fd!==undefined)closeSync(fd);}};
 const write=(state,initial=false)=>{validate(state);const body=JSON.stringify(state);if(Buffer.byteLength(body)>4*1024*1024)fail('Owner 工具记录容量已满。');secure(initial);const temporary=join(root,'.owner-native-management-'+randomUUID()+'.tmp');let fd;try{fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,body);fsyncSync(fd);closeSync(fd);fd=undefined;secure(initial);renameSync(temporary,file);const parent=openSync(root,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(parent);}finally{closeSync(parent);}}finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch{}}};
 if(!secure(true))write({version:1,drafts:[],confirmations:[]},true);else{const state=read();let changed=false;for(const row of state.confirmations)if(row.status==='dispatching'){row.status='unknown';row.result={status:'unknown',text:'上次确认结果尚未核实，没有自动重新执行。'};changed=true;}if(changed)write(state);}
 // Runtime holds the process lock. Mutations read and commit synchronously,
 // with no await between them, including when several scoped factories exist.
 return{read,mutate(change){const state=read(),result=change(state);write(state);return result;}};
}

const operationKeys={status:['action'],preview_brief:['action'],history_page:['action','personId','before','limit','query'],library_query:['action','personId','before','limit','query','date','kind'],draft_management:['action','text','contextId'],send_message:['action','personId','text'],confirm_management:['action','cardId','revision'],
 important_update:['action','incidentId','status'],important_reply:['action','incidentId','text'],important_alert:['action','enabled'],family_reply:['action','requestId','text'],workflow_reply:['action','request','status','note'],dismiss_relay:['action','relayId'],service_request:['action','text','requestId'],service_confirm:['action','draftId','revision'],reminder:['action','op','text','dueAt','repeat','reminderId']};
function checkArgs(args){
 if(!plain(args)||!Object.hasOwn(operationKeys,args.action)||Object.keys(args).some(key=>!operationKeys[args.action].includes(key)))fail('不支持的操作或参数。','owner_management_invalid');
 if(['draft_management','send_message'].includes(args.action)&&!content(args.text,args.action==='send_message'?2800:6000))fail('请提供完整且长度适当的正文。','owner_management_invalid');
 if(['history_page','library_query','send_message'].includes(args.action)&&!string(args.personId,100))fail('请先用 status 核对目标成员。','owner_management_invalid');
 if(args.action==='important_update'&&(!string(args.incidentId,100)||!['acknowledged','resolved','muted'].includes(args.status)))fail('请用事项编号和已知悉/已解决/不再提醒。','owner_management_invalid');
 if(args.action==='important_alert'&&typeof args.enabled!=='boolean')fail('请说明是开启还是关闭重要事项提醒。','owner_management_invalid');
 if(args.action==='important_reply'&&(!string(args.incidentId,100)||!content(args.text,2800)))fail('请用事项编号和要转给家人的正文。','owner_management_invalid');
 if(args.action==='family_reply'&&(!string(args.requestId,512)||!content(args.text,2000)))fail('请用请求编号和要回复家人的正文。','owner_management_invalid');
 if(args.action==='workflow_reply'&&(!/^wf-[a-f0-9]{12}$/.test(String(args.request??''))||!['pending','accepted','completed','declined'].includes(args.status)||args.note!==undefined&&!content(args.note,2000)))fail('请用 wf- 需求编号、需求状态和可选说明。','owner_management_invalid');
 if(args.action==='dismiss_relay'&&!string(args.relayId,100))fail('请用背景里的转告编号。','owner_management_invalid');
 if(args.action==='service_request'&&!content(args.text,6000))fail('请说明要给哪位家人开通或调整什么服务。','owner_management_invalid');
 if(args.action==='reminder'&&(!['list','add','cancel'].includes(args.op)||args.op==='add'&&(!content(args.text,200)||!string(args.dueAt,80))||args.op==='cancel'&&!string(args.reminderId,100)||args.repeat!==undefined&&!['once','daily'].includes(args.repeat)))fail('请说明提醒操作、内容、时间和重复方式。','owner_management_invalid');
 if(args.contextId!==undefined&&(!string(args.contextId,120)||!/^(?:card|person):[A-Za-z0-9_-]{1,100}$/.test(args.contextId)))fail('草稿对象参数无效。','owner_management_invalid');
 if(args.action==='confirm_management'&&(!string(args.cardId,100)||!Number.isSafeInteger(args.revision)||args.revision<1))fail('确认需要当前草稿标识和精确版本。','owner_management_invalid');
 if(args.action==='service_confirm'&&(!string(args.draftId,100)||!Number.isSafeInteger(args.revision)||args.revision<1))fail('确认服务草稿需要当前草稿标识和精确版本。','owner_management_invalid');
 if(args.limit!==undefined&&(!Number.isSafeInteger(args.limit)||args.limit<1||args.limit>(args.action==='library_query'?10:100))||args.query!==undefined&&(typeof args.query!=='string'||args.query.length>200||/[\x00-\x1f\x7f]/u.test(args.query))||args.before!==undefined&&(typeof args.before!=='string'||!(args.action==='library_query'?/^entry-[a-f0-9]{48}$/:/^fh1_[A-Za-z0-9_-]{43}$/).test(args.before)))fail('历史查询参数无效。','owner_management_invalid');
 if(args.date!==undefined&&!string(args.date,40)||args.kind!==undefined&&!['diary','fact','preference','task','file'].includes(args.kind))fail('资料库查询参数无效。','owner_management_invalid');
}
const receiptText=status=>['api_accepted','accepted','completed'].includes(status)?'已提交给家人的微信接口；实际收信待本人确认。':['unknown','uncertain','dispatching','pending'].includes(status)?'发送结果尚未确认，没有自动重发。':'这次发送未完成，没有自动重发。';
function confirmationResult(value,cardId,revision){
 const card=value?.card??value?.workbench?.cards?.find(row=>row.id===cardId)??value?.cards?.find(row=>row.id===cardId);
 if(!card)return{status:'unknown',cardId,revision,text:'确认结果尚未核实，没有自动重复执行。'};
 const statuses=(card.actions??[]).map(action=>action.status),status=statuses.some(item=>['uncertain','running'].includes(item))?'unknown':statuses.some(item=>item==='failed')?'failed':card.status==='saved'||statuses.length&&statuses.every(item=>['api_accepted','completed','scheduled','cancelled'].includes(item))?'completed':'unknown';
 return{status,cardId,revision,text:status==='completed'?'已按这份已确认草稿处理；微信接口接受不代表手机实收。':status==='failed'?'这份草稿未全部完成，没有自动重新执行。':'这份草稿的执行结果尚未确认，没有自动重新执行。'};
}

export function createOwnerManagementTool({runtime,directory}={}){
 if(!runtime?.store||typeof runtime.ownerAuthorityForSession!=='function')fail('Owner 会话授权接口尚未就绪。');
 const journal=journalFor(directory),active=new Map();
 const currentRoute=personId=>{try{return runtime.store.route(personId);}catch{return null;}};
 async function authorityFor(execution){
  execution?.signal?.throwIfAborted();const sessionId=execution?.agent?.id,callId=execution?.rootCallId??execution?.callId;
  if(!string(sessionId)||!string(callId))fail('缺少真实 Owner 会话及工具请求标识。');
  const authority=await runtime.ownerAuthorityForSession({sessionId,callId,signal:execution?.signal});
  if(!authority||![authority.taskId,authority.requestId,authority.sourceRequestId,authority.personId].every(value=>string(value))||!['console','wechat'].includes(authority.origin)||typeof authority.authorize!=='function')fail('当前工具不属于已验证的 Owner 请求。');
  const guard=async()=>{execution?.signal?.throwIfAborted();if(await authority.authorize()!==true||runtime.store.person(authority.personId)?.role!=='owner')fail('Owner 身份、请求或微信绑定已改变。');execution?.signal?.throwIfAborted();};await guard();return{authority,guard,sessionId,callId,signal:execution?.signal};
 }
 const cardsOf=state=>state?.workbench?.cards??state?.cards??[];
 const recipientsFor=card=>[...new Set((card.actions??[]).map(action=>action.personId).filter(Boolean))].map(personId=>({personId,routeHash:routeHash(currentRoute(personId))}));
 async function execute(args,execution){
  checkArgs(args);const scope=await authorityFor(execution),{authority,guard,sessionId,callId,signal}=scope;
  if(args.action==='status'){
   const state=runtime.status(),people=state.people.map(person=>({id:person.id,label:person.label,role:person.role,timeZone:person.timeZone,status:person.binding?.status??'unbound'}));await guard();
   const value={paused:state.config.paused,people,attention:state.attention??{enabled:false,incidents:[]},capabilities:{directOwnerMessages:true,ownerLocalHistory:'full',inlineDraftConfirmation:true,briefSharingOnlyControlsAutomaticBrief:true,importantEventAlerts:Boolean(state.attention?.enabled)}};return{...value,text:JSON.stringify(value)};
  }
  if(args.action==='history_page'){
   const value=await runtime.action({action:'history_page',personId:args.personId,...(args.before?{before:args.before}:{}),...(args.limit!==undefined?{limit:args.limit}:{}),...(args.query!==undefined?{query:args.query}:{})});await guard();return{...value,text:JSON.stringify(value)};
  }
  if(args.action==='library_query'){
   const target=runtime.store.person(args.personId),route=currentRoute(args.personId);
   if(!target||!route)fail('这位家人的微信尚未连接，未返回资料库内容。');
   const value=await runtime.action({...args,limit:args.limit??6});await guard();
   if(routeHash(currentRoute(args.personId))!==routeHash(route))fail('这位家人的微信绑定已经改变，未返回旧资料。');
   const visible=(value.entries??[]).filter(row=>row.key!=='report-style'),maximum=Math.floor(8500/Math.max(1,visible.length));
   const entries=visible.map(row=>({id:row.id,kind:row.kind,date:row.date,datePrecision:row.datePrecision,revision:row.revision,status:row.status,text:utf8Prefix(row.text,maximum),...(Buffer.byteLength(String(row.text??''))>maximum?{truncated:true}:{}),...(row.readOnly?{readOnly:true}:{}),...(row.notice?{notice:utf8Prefix(row.notice,300)}:{}),sources:(row.sources??[]).slice(-1).map(({id,at,providedBy})=>({id:utf8Prefix(id,160),at,providedBy}))}));
   const preference=value.reportPreference;
   const result={entries,nextBefore:value.nextBefore??null,...(value.date?{date:value.date}:{}),...(value.notice?{notice:value.notice}:{}),reportPreference:preference?{instruction:utf8Prefix(preference.instruction,4000),revision:preference.revision,updatedAt:preference.updatedAt,readOnly:true,source:'本人日报服务的当前生效设置'}:null};
   let rendered=JSON.stringify(result);
   while(Buffer.byteLength(JSON.stringify({...result,text:rendered}))>24000){
    const largest=entries.reduce((selected,row)=>Buffer.byteLength(row.text)>Buffer.byteLength(selected?.text??'')?row:selected,null);
    if(largest&&largest.text){largest.text=utf8Prefix(largest.text,Math.floor(Buffer.byteLength(largest.text)/2));largest.truncated=true;}
    else if(result.reportPreference?.instruction){result.reportPreference.instruction=utf8Prefix(result.reportPreference.instruction,Math.floor(Buffer.byteLength(result.reportPreference.instruction)/2));result.reportPreference.truncated=true;}
    else if(entries.length){entries.pop();result.nextBefore=entries.at(-1)?.id??value.nextBefore??null;}
    else break;
    rendered=JSON.stringify(result);
   }
   return{...result,text:rendered};
  }
  if(args.action==='preview_brief'){const state=await runtime.action({action:'preview_brief'});await guard();return{text:state.lastBrief.text};}
  if(args.action==='send_message'){
   if(authority.deliveryTarget)return{status:'delivery_managed',text:'本轮成果已有统一交付目标，请只生成交付正文；不要再次调用发送工具。'};
   const target=runtime.store.person(args.personId),people=runtime.store.snapshot().people;
   if(!target||target.role!=='elder'||!ownerLiteralMessageAuthorized({userText:authority.userText,target,people,text:args.text}))return{status:'needs_input',text:'请在这个会话说清楚要发给哪位家人、完整正文是什么；能力询问或模型自述不算发送指令。'};
   await guard();if(typeof runtime.ownerSendForSession!=='function')fail('Owner 直接发送接口尚未就绪。');
   const result=await runtime.ownerSendForSession({sessionId,callId,personId:args.personId,text:args.text.trim(),signal});await guard();return{status:result?.status??'unknown',personId:args.personId,...(string(result?.outboxId,100)?{outboxId:result.outboxId}:{}),text:receiptText(result?.status)};
  }
  if(args.action==='draft_management'){
   const requestId='host-'+hash([sessionId,authority.sourceRequestId,args.text,args.contextId??null]);
   const state=await runtime.action({action:'owner_chat',text:args.text,...(args.contextId?{contextId:args.contextId}:{}),requestId,draftOnly:true});await guard();
   const messages=state.workbench.messages.filter(message=>message.requestId===requestId),ids=new Set(messages.flatMap(message=>message.cardIds??[])),cards=state.workbench.cards.filter(card=>ids.has(card.id)&&card.status==='draft');
   journal.mutate(saved=>{for(const card of cards){const row={sessionId,sourceRequestId:authority.sourceRequestId,taskId:authority.taskId,origin:authority.origin,ownerId:authority.personId,ownerRouteHash:routeHash(authority.route),cardId:card.id,revision:card.revision,cardIntentHash:hash(intentOf(card)),recipients:recipientsFor(card)};const old=saved.drafts.findIndex(item=>item.sessionId===sessionId&&item.cardId===card.id&&item.revision===card.revision);if(old<0)saved.drafts.push(row);else if(canonical(saved.drafts[old])!==canonical(row))fail('草稿的会话来源或版本发生冲突。');}});await guard();
   const value={cards:cards.map(publicCard),requestId};return{...value,text:cards.length?JSON.stringify({message:'请核对以下草稿；你可直接在当前会话回复“确认”，无需返回工作台。尚未执行或发送。',...value}):messages.filter(message=>message.role==='assistant').at(-1)?.text??'请补充具体对象与内容。'};
  }
  if(args.action==='confirm_management'){
  if(!isOwnerManagementConfirmation(authority.userText))return{status:'needs_input',text:'请明确确认上一条在本会话展示的草稿；新话题不会执行旧草稿。'};
  if(authority.deliveryTarget)return{status:'needs_input',text:'本轮已有统一成果交付，请不要同时确认另一项发送。'};
  const saved=journal.read(),candidates=saved.drafts.filter(row=>row.sessionId===sessionId&&row.sourceRequestId===authority.previousSourceRequestId&&row.origin===authority.origin&&row.ownerId===authority.personId&&row.ownerRouteHash===routeHash(authority.route));
  if(candidates.length!==1||candidates[0].cardId!==args.cardId||candidates[0].revision!==args.revision)return{status:'needs_input',text:'没有唯一对应上一条本会话草稿的这个版本，请重新说明要处理的安排。'};
  const draft=candidates[0],key=hash([sessionId,authority.sourceRequestId,args.cardId,args.revision]);
  if(active.has(key)){const result=await active.get(key);await guard();return clone(result);}const previous=saved.confirmations.find(row=>row.key===key);if(previous){await guard();return clone(previous.result??{status:previous.status,text:'此前确认结果尚未核实，没有自动重新执行。'});}
  const card=cardsOf(runtime.status()).find(row=>row.id===args.cardId);
  if(!card||card.status!=='draft'||card.revision!==args.revision||hash(intentOf(card))!==draft.cardIntentHash||draft.recipients.some(row=>routeHash(currentRoute(row.personId))!==row.routeHash))return{status:'needs_input',text:'草稿内容、版本或接收人的绑定已改变，请核对新草稿后再确认。'};
  await guard();
  if(active.has(key)){const result=await active.get(key);await guard();return clone(result);}
  const replay=journal.mutate(current=>{const old=current.confirmations.find(row=>row.key===key);if(old)return clone(old);const currentDrafts=current.drafts.filter(row=>row.sessionId===sessionId&&row.sourceRequestId===authority.previousSourceRequestId&&row.origin===authority.origin&&row.ownerId===authority.personId&&row.ownerRouteHash===routeHash(authority.route));if(currentDrafts.length!==1||canonical(currentDrafts[0])!==canonical(draft))fail('待确认草稿在处理期间已改变。');current.confirmations.push({key,status:'dispatching'});return null;});
  if(replay){await guard();return clone(replay.result??{status:replay.status,text:'此前确认仍在处理或结果尚未核实，没有重复执行。'});}
  const pending=(async()=>{let result;try{if(typeof runtime.ownerConfirmForSession!=='function')fail('Owner 会话确认接口尚未就绪。');await guard();result=confirmationResult(await runtime.ownerConfirmForSession({sessionId,callId,cardId:args.cardId,revision:args.revision,signal}),args.cardId,args.revision);await guard();}catch{result={status:'unknown',cardId:args.cardId,revision:args.revision,text:'这次确认的执行结果尚未核实，没有自动重新执行。'};}journal.mutate(current=>{const row=current.confirmations.find(item=>item.key===key);if(!row)fail('Owner 确认记录已改变。');row.status=result.status;row.result=result;});await guard();return clone(result);})();active.set(key,pending);try{return await pending;}finally{if(active.get(key)===pending)active.delete(key);}
  }
  // 家庭动作映射：以前靠固定短语或规划器接的事，现在都由这个工具承接。
  if(args.action==='important_update'||args.action==='important_reply'){
   const value=await runtime.action({action:'attention_respond',incidentId:args.incidentId,...(args.action==='important_reply'?{text:args.text}:{status:args.status})});await guard();
   return{...value,text:value.text??'已记录。'};
  }
  if(args.action==='important_alert'){
   const value=await runtime.action({action:'attention_configure',enabled:args.enabled});await guard();
   return{enabled:value.attention?.enabled??args.enabled,text:args.enabled?'已开启重要事项主动提醒，从新收到的家人消息开始判断；普通聊天不会逐条通知。':'已关闭重要事项主动提醒，家人的正常对话和明确转告照常。'};
  }
  if(args.action==='family_reply'){
   if(authority.deliveryTarget)return{status:'needs_input',text:'本轮已有统一成果交付，请不要再单独回复家人；先把统一成果处理完。'};
   const body=args.text.trim();
   // Only unquoted words the Owner actually said in this turn may leave. A
   // refusal/defer/draft/example sentence blocks the whole turn, even when the
   // quoted payload appears in it.
   const spoken=visible(authority.userText);
   if(!spoken.includes(body))return{status:'needs_input',text:'这句回复不在你本轮原话里（引用或别处文字不算授权）。请先自己说清楚要回复家人的正文，我不会替你说。'};
   if(/(?:先别|别先|别回|不要回|不用回|暂不|暂时不|等(?:一下|会|会儿)?再|晚点再|回头再|草稿|先给我看|等我确认|引用|示例|比如|例如)/u.test(authority.userText))return{status:'needs_input',text:'你本轮明确说了先别回、延后、草稿或只是举例；这轮不会发出回复。'};
   const requests=runtime.status()?.workbench?.requests;
   if(Array.isArray(requests)&&requests.length){
    const request=requests.find(row=>row.id===args.requestId);
    if(!request)return{status:'needs_input',text:'没有找到这项正在等主人回应的家人托问。'};
    if(request.status==='resolved')return{status:'needs_input',text:'这件托问已经结束，不能再回复；有新的事请让家人重新发起。'};
    const refs=Array.isArray(authority.familyRequestIds)?authority.familyRequestIds:[];
    const open=requests.filter(row=>['open','waiting'].includes(row.status));
    if(refs.length){
     if(!refs.includes(args.requestId))return{status:'needs_input',text:'这项编号不在本轮程序保存的家人托问回执里；请核对背景里的请求编号。'};
     const candidates=open.filter(row=>refs.includes(row.id));
     if(candidates.length>1)return{status:'needs_input',text:'这轮背景里有多件家人托问，无法唯一确定是哪一件；请先说明要回复哪一位家人。'};
    }else{
     if(open.length!==1)return{status:'needs_input',text:'当前没有唯一一件等待你回复的家人托问；请先说明要回复哪一件。'};
     if(open[0].id!==args.requestId)return{status:'needs_input',text:'这项编号不是当前唯一等待你回复的家人托问；请核对背景里的请求编号。'};
    }
   }
   const value=await runtime.action({action:'family_reply',requestId:args.requestId,text:args.text});await guard();return{...value,text:value.text??'已处理。'};
  }
  if(args.action==='workflow_reply'){
   const value=await runtime.action({action:'workflow_reply',request:args.request,status:args.status,...(args.note!==undefined?{note:args.note}:{})});await guard();
   return{...value,text:value.notification?.reply??'已记录这项需求的进展。'};
  }
  if(args.action==='dismiss_relay'){await runtime.action({action:'dismiss_relay',relayId:args.relayId});await guard();return{status:'completed',relayId:args.relayId,text:'已把这条转告标为处理完；已经发出的内容不会改动。'};}
  if(args.action==='service_request'){
   if(typeof runtime.ownerServiceDraftForSession!=='function')fail('Owner 会话服务草稿接口尚未就绪。');
   const value=await runtime.ownerServiceDraftForSession({sessionId,callId,text:args.text,signal});await guard();
   const reference=serviceDraftReference(value?.draft);
   return{...value,text:value.reply??value.text??'已记录这次服务安排。',...(reference?{serviceDraft:reference}:{})};
  }
  if(args.action==='service_confirm'){
   const explicit=/^确认\s+[A-Za-z0-9_-]{1,100}\s+(?:v)?\d{1,9}$/u.test(String(authority.userText??'').trim());
   if(!isOwnerManagementConfirmation(authority.userText)&&!explicit)return{status:'needs_input',text:'请先看当前会话展示的服务草稿，并明确回复“确认”后才会保存。'};
   if(authority.deliveryTarget)return{status:'needs_input',text:'本轮已有统一成果交付，请不要同时确认服务草稿。'};
   if(typeof runtime.ownerServiceConfirmForSession!=='function')fail('Owner 会话服务确认接口尚未就绪。');
   const value=await runtime.ownerServiceConfirmForSession({sessionId,callId,draftId:args.draftId,revision:args.revision,signal});await guard();
   return{...value,text:value.reply??value.text??'这次服务配置未完成，请核对当前配置后重试。'};
  }
  if(args.action==='reminder'){
   const value=await runtime.action({action:'owner_reminder',op:args.op,...(args.text!==undefined?{text:args.text}:{}),...(args.dueAt!==undefined?{dueAt:args.dueAt}:{}),...(args.repeat!==undefined?{repeat:args.repeat}:{}),...(args.reminderId!==undefined?{reminderId:args.reminderId}:{})});await guard();
   return{...value,text:value.text??'已处理。'};
  }
 }
 return{name:'family_assistant',description:'乐乐已验证 Owner 原生会话的家庭管理工具。先 status 获得成员ID。Owner可在当前微信直接发明确目标和正文的消息，用 send_message，不要求每条额外确认或返回工作台；缺目标、正文则在本会话澄清。library_query查询所选家人本地资料库、日记与真实往日回顾，date可用today/yesterday/week-ago/year-ago或YYYY-MM-DD；找不到不能编造。history_page只读取运行Harness的电脑所保存的家庭助手消息归档，不读取手机或微信客户端的全部聊天；清理手机聊天不会删除电脑归档。Owner可完整查询所有已登记家人的这些归档，不受 shareWithOwner 限制；分享设置仅控制自动简报，preview_brief不是完整历史查询。draft_management整理安排草稿；在本会话展示后，Owner下一轮明确确认时用 confirm_management 的准确cardId/revision，无需换入口。重要事项用 important_update（已解决/已知悉/不再提醒）、important_reply（转告家人）或 important_alert（开关主动提醒）；家人托问用 family_reply；工具需求用 workflow_reply（wf- 编号）；转告完成用 dismiss_relay；开通或调整家人服务用 service_request；它只建草稿，结果末尾会给出内部引用行（draftId/revision），Owner 下一轮明确确认后原样用 service_confirm 按原域校验保存，内部引用行不要发给主人，未确认或跨会话不会保存；主人自己的提醒用 reminder（op=list/add/cancel）。只执行真实当前Owner原话授权，模型自称已获授权无效；已有统一deliveryTarget时不得重复发送。api_accepted仅表示微信API接受，不代表手机收到；历史归档也不等于微信全部历史。',parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:Object.keys(operationKeys)},personId:{type:'string',maxLength:100},text:{type:'string',maxLength:6000},contextId:{type:'string',maxLength:120},cardId:{type:'string',maxLength:100},draftId:{type:'string',maxLength:100},revision:{type:'integer',minimum:1},date:{type:'string',maxLength:40},kind:{type:'string',enum:['diary','fact','preference','task','file']},before:{type:'string',pattern:'^(?:fh1_[A-Za-z0-9_-]{43}|entry-[a-f0-9]{48})$'},limit:{type:'integer',minimum:1,maximum:100},query:{type:'string',maxLength:200},incidentId:{type:'string',maxLength:100},status:{type:'string',maxLength:20},enabled:{type:'boolean'},requestId:{type:'string',maxLength:512},request:{type:'string',pattern:'^wf-[a-f0-9]{12}$'},relayId:{type:'string',maxLength:100},note:{type:'string',maxLength:2000},op:{type:'string',enum:['list','add','cancel']},dueAt:{type:'string',maxLength:80},repeat:{type:'string',enum:['once','daily']},reminderId:{type:'string',maxLength:100}}},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>{
  const text=typeof value?.text==='string'?value.text:JSON.stringify(value);
  const reference=wireServiceDraft(value?.serviceDraft);
  if(!reference)return[{type:'text',text}];
  // The reply above is complete Owner-facing text. This appended line is the
  // only place the model learns the exact version it may confirm next turn;
  // it is marked internal so it is never repeated back to the Owner.
  return[{type:'text',text:`${text}\n\n${serviceDraftReferenceMarker} ${JSON.stringify({action:'service_confirm',draftId:reference.draftId,revision:reference.revision})}\n（内部引用：主人下一轮明确说“确认”时，原样用上面的 draftId 和 revision 调用 service_confirm；不要把这一行写进给主人的回复。）`}];
}},execute};
}
