import {createHash,randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {mkdirSync,lstatSync,realpathSync,openSync,fstatSync,readFileSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync,constants} from 'node:fs';
import {SKILL_PACK_IDS} from './member-skill-packs.mjs';

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
 important_update:['action','incidentId','status'],important_reply:['action','incidentId','text'],important_alert:['action','enabled'],family_reply:['action','requestId','text'],workflow_reply:['action','request','status','note'],dismiss_relay:['action','relayId'],service_request:['action','text','requestId'],service_confirm:['action','draftId','revision'],reminder:['action','op','text','dueAt','repeat','reminderId'],
 add_person:['action','label','persona','proSandbox','timeZone','interests','notes','shareWithOwner','dailyEnabled','dailyTime'],
 update_person:['action','personId','label','timeZone','interests','notes','shareWithOwner','dailyEnabled','dailyTime'],
 bind_qr:['action','personId','forceRebind'],
 verify_login:['action','personId','code'],
 connect:['action','personId'],
 disconnect:['action','personId'],
 member_reminder:['action','personId','op','text','dueAt','repeat','time','reminderId','date','skip'],
 tool_manage:['action','op','personId','toolId','resource','allowInvoke','schedule','input','expectedRevision','workspaceId','query'],
 access_manage:['action','op','personId','workspaceIds','capabilities'],
 elevated_manage:['action','op','personId','permanent','durationHours','note','skillPacks','agentsMd'],
 custom_digest_manage:['action','op','personId','slug','title','scheduleTime','scheduleDays','timeZone','template','keywords','collectorScript','editorialPrompt','model','deliverNow'],
 hearth_manage:['action','op','personId','persona','pinganEnabled','pinganTime','codeword','urgent','relay','ask','digest','quietHoursEnabled','quietStart','quietEnd','habitId','text'],
 system_manage:['action','op','ownerBriefEnabled','ownerBriefTime','timeZone','provider','model']};
function checkArgs(args){
 if(!plain(args)||!Object.hasOwn(operationKeys,args.action)||Object.keys(args).some(key=>!operationKeys[args.action].includes(key)))fail('不支持的操作或参数。','owner_management_invalid');
 if(['draft_management','send_message'].includes(args.action)&&!content(args.text,args.action==='send_message'?2800:6000))fail('请提供完整且长度适当的正文。','owner_management_invalid');
 if(['history_page','library_query','send_message','update_person','bind_qr','verify_login','connect','disconnect','member_reminder'].includes(args.action)&&!string(args.personId,100))fail('请先用 status 核对目标成员。','owner_management_invalid');
 if(args.action==='add_person'&&!string(args.label,80))fail('请提供要开通的新成员称呼。','owner_management_invalid');
 if(['add_person','update_person'].includes(args.action)&&(args.label!==undefined&&!string(args.label,80)||args.timeZone!==undefined&&!string(args.timeZone,100)||args.interests!==undefined&&(!Array.isArray(args.interests)||args.interests.length>20||args.interests.some(v=>!string(v,100)))||args.notes!==undefined&&(typeof args.notes!=='string'||args.notes.length>2000)||args.shareWithOwner!==undefined&&!['none','summary','full'].includes(args.shareWithOwner)||args.dailyEnabled!==undefined&&typeof args.dailyEnabled!=='boolean'||args.dailyTime!==undefined&&!string(args.dailyTime,10)))fail('成员资料或日报设置参数无效。','owner_management_invalid');
 if(args.action==='verify_login'&&!string(args.code,20))fail('请提供微信登录验证码数字。','owner_management_invalid');
 if(args.action==='important_update'&&(!string(args.incidentId,100)||!['acknowledged','resolved','muted'].includes(args.status)))fail('请用事项编号和已知悉/已解决/不再提醒。','owner_management_invalid');
 if(args.action==='important_alert'&&typeof args.enabled!=='boolean')fail('请说明是开启还是关闭重要事项提醒。','owner_management_invalid');
 if(args.action==='important_reply'&&(!string(args.incidentId,100)||!content(args.text,2800)))fail('请用事项编号和要转给家人的正文。','owner_management_invalid');
 if(args.action==='family_reply'&&(!string(args.requestId,512)||!content(args.text,2000)))fail('请用请求编号和要回复家人的正文。','owner_management_invalid');
 if(args.action==='workflow_reply'&&(!/^wf-[a-f0-9]{12}$/.test(String(args.request??''))||!['pending','accepted','completed','declined'].includes(args.status)||args.note!==undefined&&!content(args.note,2000)))fail('请用 wf- 需求编号、需求状态和可选说明。','owner_management_invalid');
 if(args.action==='dismiss_relay'&&!string(args.relayId,100))fail('请用背景里的转告编号。','owner_management_invalid');
 if(args.action==='service_request'&&!content(args.text,6000))fail('请说明要给哪位家人开通或调整什么服务。','owner_management_invalid');
 if(args.action==='reminder'&&(!['list','add','cancel'].includes(args.op)||args.op==='add'&&(!content(args.text,200)||!string(args.dueAt,80))||args.op==='cancel'&&!string(args.reminderId,100)||args.repeat!==undefined&&!['once','daily'].includes(args.repeat)))fail('请说明提醒操作、内容、时间和重复方式。','owner_management_invalid');
 if(args.action==='member_reminder'&&(!['list','add','cancel','skip_once'].includes(args.op)||args.op==='add'&&(!content(args.text,1000)||!string(args.dueAt,80))||['cancel','skip_once'].includes(args.op)&&!string(args.reminderId,100)||args.repeat!==undefined&&!['once','daily'].includes(args.repeat)||args.time!==undefined&&!string(args.time,10)||args.skip!==undefined&&typeof args.skip!=='boolean'))fail('请说明成员提醒操作、内容、时间和提醒编号。','owner_management_invalid');
 if(args.action==='tool_manage'&&(!['catalog','assignments','assign','invoke','digest_sources'].includes(args.op)||['assignments','assign','invoke'].includes(args.op)&&!string(args.personId,100)||['assign','invoke'].includes(args.op)&&!string(args.toolId,80)||args.op==='assign'&&!plain(args.resource)||args.allowInvoke!==undefined&&typeof args.allowInvoke!=='boolean'||args.schedule!==undefined&&args.schedule!==null&&!plain(args.schedule)||args.input!==undefined&&!plain(args.input)||args.expectedRevision!==undefined&&(!Number.isSafeInteger(args.expectedRevision)||args.expectedRevision<1)||args.workspaceId!==undefined&&!string(args.workspaceId,240)))fail('请说明工具管理操作及完整参数。','owner_management_invalid');
 if(args.action==='access_manage'&&(!['list','grant','revoke'].includes(args.op)||['grant','revoke'].includes(args.op)&&!string(args.personId,100)||args.op==='grant'&&(!Array.isArray(args.workspaceIds)||!Array.isArray(args.capabilities))))fail('请说明项目权限操作（list/grant/revoke）、成员与权限范围。','owner_management_invalid');
 if(args.action==='elevated_manage'&&(!['list','grant','revoke','set_packs','set_agents_md'].includes(args.op)||['grant','revoke','set_packs','set_agents_md'].includes(args.op)&&!string(args.personId,100)||args.op==='list'&&args.personId!==undefined&&!string(args.personId,100)||args.permanent!==undefined&&typeof args.permanent!=='boolean'||args.durationHours!==undefined&&(!Number.isSafeInteger(args.durationHours)||args.durationHours<1||args.durationHours>168)||args.note!==undefined&&!content(args.note,500)||args.skillPacks!==undefined&&(!Array.isArray(args.skillPacks)||args.skillPacks.length>SKILL_PACK_IDS.length||args.skillPacks.some(id=>!SKILL_PACK_IDS.includes(id)))||args.op==='set_packs'&&!Array.isArray(args.skillPacks)||args.agentsMd!==undefined&&(typeof args.agentsMd!=='string'||args.agentsMd.length>16000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(args.agentsMd))||args.op==='set_agents_md'&&typeof args.agentsMd!=='string'))fail('请说明独立沙箱权限操作（list/grant/revoke/set_packs/set_agents_md）、目标成员与对应能力包/背景参数。','owner_management_invalid');
 if(args.action==='custom_digest_manage'&&(!['list','save','run_now','pause'].includes(args.op)||['save','run_now','pause'].includes(args.op)&&!string(args.personId,100)||args.op==='save'&&(!string(args.slug,50)||!string(args.title,120))))fail('请说明定制简报操作（list/save/run_now/pause）、目标成员及必要参数。','owner_management_invalid');
 if(args.action==='hearth_manage'&&(!['member_update','guard_update','habit_save','habit_delete'].includes(args.op)||['member_update','habit_save','habit_delete'].includes(args.op)&&!string(args.personId,100)||args.persona!==undefined&&!['elder_care','partner','pro_peer'].includes(args.persona)||args.op==='habit_save'&&!content(args.text,240)||args.op==='habit_delete'&&!string(args.habitId,120)))fail('请说明家庭守护操作及成员或规则参数。','owner_management_invalid');
 if(args.action==='system_manage'&&!['configure','start','pause','send_brief'].includes(args.op))fail('请说明系统操作（configure/start/pause/send_brief）。','owner_management_invalid');
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
   const state=runtime.status(),people=state.people.map(person=>({id:person.id,label:person.label,role:person.role,timeZone:person.timeZone,status:person.binding?.status??'unbound',notes:person.notes??'',interests:person.interests??[],shareWithOwner:person.shareWithOwner??'none',dailyEnabled:Boolean(person.dailyEnabled),dailyTime:person.dailyTime??'08:00',...(person.reach?{reach:person.reach}:{})}));await guard();
   const value={paused:state.config.paused,people,attention:state.attention??{enabled:false,incidents:[]},capabilities:{directOwnerMessages:true,ownerLocalHistory:'full',inlineDraftConfirmation:true,briefSharingOnlyControlsAutomaticBrief:true,importantEventAlerts:Boolean(state.attention?.enabled),fullDesktopParity:true,wechatQrBinding:true}};return{...value,text:JSON.stringify(value)};
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
  if(args.action==='add_person'){
   const beforeIds=new Set((runtime.status()?.people??[]).map(p=>p.id));
   const state=await runtime.action({action:'add_person',role:'elder',label:args.label.trim(),...(args.timeZone?{timeZone:args.timeZone}:{}),...(args.interests?{interests:args.interests}:{}),...(args.notes!==undefined?{notes:args.notes}:{}),...(args.shareWithOwner?{shareWithOwner:args.shareWithOwner}:{}),...(args.dailyEnabled!==undefined?{dailyEnabled:args.dailyEnabled}:{}),...(args.dailyTime?{dailyTime:args.dailyTime}:{})});await guard();
   const person=(state?.people??[]).find(p=>!beforeIds.has(p.id))||(state?.people??[]).filter(p=>p.label===args.label.trim()).at(-1);
   if(person?.id){
    if(args.persona){await runtime.action({action:'hearth_member_update',personId:person.id,persona:args.persona});}
    if(args.proSandbox===true||args.persona==='pro_peer'){await runtime.action({action:'member_elevated_grant',personId:person.id,permanent:true,note:'常驻独立沙箱专业席位'});}
   }
   return{status:'completed',personId:person?.id??null,label:person?.label??args.label.trim(),text:`已新增成员「${person?.label??args.label.trim()}」（personId: ${person?.id??'unknown'}）。如需微信扫码绑定，请紧接着调用 bind_qr。`};
  }
  if(args.action==='update_person'){
   const patch=Object.fromEntries(['label','timeZone','interests','notes','shareWithOwner','dailyEnabled','dailyTime'].filter(key=>args[key]!==undefined).map(key=>[key,args[key]]));
   await runtime.action({action:'update_person',personId:args.personId,...patch});await guard();
   return{status:'completed',personId:args.personId,text:'已更新该成员资料与日报设置。'};
  }
  if(args.action==='bind_qr'){
   if(typeof runtime.ownerBindQrForSession!=='function')fail('微信扫码绑定接口尚未就绪。');
   const res=await runtime.ownerBindQrForSession({sessionId,callId,personId:args.personId,forceRebind:args.forceRebind===true,signal});await guard();
   if(res.status==='already_connected'||res.status==='reconnected'){
    return{...res,text:res.text};
   }
   const text=res.wechatImageStatus==='api_accepted'
    ?`已为「${res.label}」生成微信绑定二维码并直接发送到你的微信聊天图片中（5分钟内有效）。请转发给${res.label}或当面扫码确认；扫码成功后我会自动发消息通知你。若手机提示输入数字验证码，直接把数字发给我即可。`
    :`已为「${res.label}」启动微信扫码绑定（5分钟内有效），二维码地址：${res.qrUrl}（图片直推状态：${res.wechatImageStatus}）。`;
   return{...res,text};
  }
  if(args.action==='verify_login'){
   await runtime.action({action:'verify_login',personId:args.personId,code:args.code.trim()});await guard();
   return{status:'completed',personId:args.personId,text:'已提交微信登录验证码，正在等待连接确认。'};
  }
  if(args.action==='connect'||args.action==='disconnect'){
   await runtime.action({action:args.action,personId:args.personId});await guard();
   return{status:'completed',personId:args.personId,text:args.action==='connect'?'已重新连接该成员的微信通道。':'已断开该成员的微信通道。'};
  }
  if(args.action==='member_reminder'){
   if(args.op==='list'){
    const rows=runtime.store.reminders(args.personId).filter(row=>['active','scheduled'].includes(row.status));await guard();
    return{reminders:rows,text:JSON.stringify({personId:args.personId,reminders:rows})};
   }
   if(args.op==='add'){
    await runtime.action({action:'add_reminder',personId:args.personId,text:args.text.trim(),dueAt:args.dueAt,...(args.repeat?{repeat:args.repeat}:{}),...(args.time?{time:args.time}:{})});await guard();
    return{status:'completed',personId:args.personId,text:'已为该成员创建提醒。'};
   }
   if(args.op==='cancel'){
    await runtime.action({action:'cancel_reminder',personId:args.personId,reminderId:args.reminderId});await guard();
    return{status:'completed',personId:args.personId,reminderId:args.reminderId,text:'已取消该成员的这条提醒。'};
   }
   await runtime.action({action:'reminder_skip_once',personId:args.personId,reminderId:args.reminderId,...(args.date?{date:args.date}:{}),...(args.skip!==undefined?{skip:args.skip}:{})});await guard();
   return{status:'completed',personId:args.personId,reminderId:args.reminderId,text:args.skip===false?'已恢复该成员本次提醒。':'已为该成员跳过这一次提醒。'};
  }
  if(args.action==='tool_manage'){
   if(args.op==='catalog'){
    const value=await runtime.action({action:'tool_catalog',...(args.personId?{personId:args.personId}:{})});await guard();
    return{catalog:value,text:JSON.stringify(value)};
   }
   if(args.op==='assignments'){
    const value=await runtime.action({action:'tool_assignments',personId:args.personId});await guard();
    return{assignments:value,text:JSON.stringify(value)};
   }
   if(args.op==='assign'){
    const value=await runtime.action({action:'tool_assign',personId:args.personId,toolId:args.toolId,resource:args.resource,allowInvoke:args.allowInvoke??true,schedule:args.schedule??null});await guard();
    return{assignment:value,text:`已为成员配置工具 ${args.toolId}。`};
   }
   if(args.op==='invoke'){
    const toolCallId=string(execution?.callId)?execution.callId:callId;
    const value=await runtime.action({action:'tool_invoke',personId:args.personId,toolId:args.toolId,requestId:`owner-tool-${toolCallId}`,input:args.input??null,...(args.expectedRevision!==undefined?{expectedRevision:args.expectedRevision}:{})});await guard();
    return{...value,text:JSON.stringify(value)};
   }
   const value=await runtime.action({action:'digest_sources',...(args.workspaceId?{workspaceId:args.workspaceId}:{}),...(args.query!==undefined?{query:args.query}:{})});await guard();
   return{sources:value,text:JSON.stringify(value)};
  }
  if(args.action==='access_manage'){
   if(args.op==='list'){
    const value=await runtime.action({action:'family_access_list'});await guard();
    return{policies:value,text:JSON.stringify(value)};
   }
   if(args.op==='grant'){
    const value=await runtime.action({action:'family_access_grant',personId:args.personId,workspaceIds:args.workspaceIds,capabilities:args.capabilities});await guard();
    return{policy:value,text:'已更新该成员的项目访问权限。'};
   }
   const value=await runtime.action({action:'family_access_revoke',personId:args.personId});await guard();
   return{policy:value,text:'已收回该成员的项目访问权限。'};
  }
  if(args.action==='elevated_manage'){
   if(args.op==='list'){
    const value=await runtime.action({action:'member_elevated_list',...(args.personId?{personId:args.personId}:{})});await guard();
    return{...value,text:JSON.stringify(value)};
   }
   if(args.op==='grant'){
    const value=await runtime.action({action:'member_elevated_grant',personId:args.personId,...(args.permanent!==undefined?{permanent:args.permanent}:{}),...(args.durationHours!==undefined?{durationHours:args.durationHours}:{}),...(args.note!==undefined?{note:args.note}:{}),...(args.skillPacks!==undefined?{skillPacks:args.skillPacks}:{}),...(args.agentsMd!==undefined?{agentsMd:args.agentsMd}:{})});await guard();
    const g=value?.grant;
    const durDesc=g?.permanent?'常驻专业沙箱模式（长期有效）':`有效期 ${g?.durationHours??args.durationHours??72} 小时，到期时间 ${g?.expiresAt??''}`;
    return{...value,text:`已为该成员开启独立沙箱满血 Agent 席位（${durDesc}，隔离工作区 ${g?.workspacePath??''}）。他现在可以直接在微信里跟乐乐提业务需求、深度检索公开信源、建立并随时调教定制简报、生成报告或图片直发微信；你随时可用 elevated_manage(op="revoke") 收回。`};
   }
   if(args.op==='set_packs'){
    const value=await runtime.action({action:'member_skill_packs_set',personId:args.personId,packIds:args.skillPacks});await guard();
    const installed=value?.skillPacks?.installed??args.skillPacks;
    return{status:'completed',personId:args.personId,skillPacks:value?.skillPacks,text:`已更新该成员独立沙箱能力包（当前已装备 ${installed.length} 项：${installed.join('、')||'无'}），仅单向共享方法论，绝不暴露主人私人目录或记忆。`};
   }
   if(args.op==='set_agents_md'){
    const value=await runtime.action({action:'member_workspace_agents_set',personId:args.personId,content:args.agentsMd});await guard();
    return{status:'completed',personId:args.personId,hasAgentsMd:value?.hasAgentsMd,text:value?.hasAgentsMd?'已将该成员专属背景与工作口径卡（AGENTS.md）写入其独立沙箱。':'已清空该成员独立沙箱的 AGENTS.md。'};
   }
   const value=await runtime.action({action:'member_elevated_revoke',personId:args.personId});await guard();
   return{...value,text:'已收回该成员的独立沙箱满血权限，恢复关怀轻沙箱模式；此前已保存的每日定制简报仍会继续按计划运行。'};
  }
  if(args.action==='custom_digest_manage'){
   if(args.op==='list'){
    const value=await runtime.action({action:'member_custom_digest_list',...(args.personId?{personId:args.personId}:{})});await guard();
    return{...value,text:JSON.stringify(value)};
   }
   if(args.op==='save'){
    const value=await runtime.action({action:'member_custom_digest_save',personId:args.personId,slug:args.slug,title:args.title,...(args.scheduleTime?{scheduleTime:args.scheduleTime}:{}),...(args.scheduleDays?{scheduleDays:args.scheduleDays}:{}),...(args.timeZone?{timeZone:args.timeZone}:{}),...(args.template?{template:args.template}:{}),...(args.keywords?{keywords:args.keywords}:{}),...(args.collectorScript?{collectorScript:args.collectorScript}:{}),...(args.editorialPrompt?{editorialPrompt:args.editorialPrompt}:{}),...(args.model?{model:args.model}:{}),...(args.deliverNow!==undefined?{deliverNow:args.deliverNow}:{})});await guard();
    return{...value.digestResult,text:`已保存并生成定制简报「${args.title}」（${value.digestResult?.bytes??0} 字节，推送状态：${value.digestResult?.deliveryStatus??'未立即推送'}）。`};
   }
   if(args.op==='run_now'){
    const value=await runtime.action({action:'member_custom_digest_run',personId:args.personId,...(args.slug?{slug:args.slug}:{}),...(args.deliverNow!==undefined?{deliverNow:args.deliverNow}:{})});await guard();
    return{...value.digestResult,text:`已重新采集并生成定制简报「${value.digestResult?.slug??''}」（${value.digestResult?.bytes??0} 字节，推送状态：${value.digestResult?.deliveryStatus??'未立即推送'}）。`};
   }
   await runtime.action({action:'member_custom_digest_pause',personId:args.personId,...(args.slug?{slug:args.slug}:{})});await guard();
   return{status:'completed',personId:args.personId,text:'已暂停该成员的定制简报定时推送。'};
  }
  if(args.action==='hearth_manage'){
   if(args.op==='member_update'){
    const patch=Object.fromEntries(['persona','pinganEnabled','pinganTime','codeword'].filter(key=>args[key]!==undefined).map(key=>[key,args[key]]));
    await runtime.action({action:'hearth_member_update',personId:args.personId,...patch});await guard();
    return{status:'completed',personId:args.personId,text:'已更新该成员的角色画像与守护设置。'};
   }
   if(args.op==='guard_update'){
    const patch=Object.fromEntries(['urgent','relay','ask','digest','quietHoursEnabled','quietStart','quietEnd'].filter(key=>args[key]!==undefined).map(key=>[key,args[key]]));
    await runtime.action({action:'hearth_guard_update',...patch});await guard();
    return{status:'completed',text:'已更新家庭守护与勿扰规则。'};
   }
   if(args.op==='habit_save'){
    await runtime.action({action:'hearth_habit_save',personId:args.personId,...(args.habitId?{id:args.habitId}:{}),text:args.text.trim()});await guard();
    return{status:'completed',personId:args.personId,text:'已保存该成员的照料习惯。'};
   }
   await runtime.action({action:'hearth_habit_delete',personId:args.personId,id:args.habitId});await guard();
   return{status:'completed',personId:args.personId,text:'已删除该成员的这条照料习惯。'};
  }
  if(args.action==='system_manage'){
   if(args.op==='configure'){
    const patch=Object.fromEntries(['ownerBriefEnabled','ownerBriefTime','timeZone','provider','model'].filter(key=>args[key]!==undefined).map(key=>[key,args[key]]));
    await runtime.action({action:'configure',...patch});await guard();
    return{status:'completed',text:'已更新家庭助手全局配置。'};
   }
   await runtime.action({action:args.op});await guard();
   return{status:'completed',text:{start:'家庭助手服务已启动。',pause:'家庭助手服务已暂停。',send_brief:'已触发发送今日家庭简报。'}[args.op]};
  }
 }
 return{name:'family_assistant',description:'乐乐已验证 Owner 原生会话的家庭全权管理工具（与电脑端工作台 1:1 对齐最高权限）。先 status 获得成员ID。Owner可在当前微信直接完成电脑工作台的全部管理操作：add_person 新增席位（可设 persona="elder_care"|"partner"|"pro_peer" 与 proSandbox=true）、update_person 修改成员资料与日报设置、bind_qr 生成微信绑定二维码并直接以聊天图片发回Owner微信（若已连接则自动防误杀保护，换绑传 forceRebind=true）、verify_login 提交登录数字验证码、connect/disconnect 重连或断开通道、member_reminder 管理成员提醒、tool_manage 查看目录/发现日报来源(digest_sources)/分配工具(assign)/调用工具(invoke)、access_manage 授权或收回成员项目权限、elevated_manage 为成员开启/查看/收回独立沙箱满血 Agent 模式（grant 默认常驻 permanent=true，也可设 1-168 小时；另支持 op="set_packs" 勾配脱敏能力包与 op="set_agents_md" 写入专属背景卡）、custom_digest_manage 查看/配置/试跑推送/暂停成员专属定制简报（支持 template="crossborder_ma"|"topic_radar"）、hearth_manage 设置角色画像/平安问候/守护勿扰/照料习惯、system_manage 配置简报或启动暂停。原有能力全部保留：send_message 直发成员消息、library_query 查资料库、history_page 查电脑保存的归档、draft_management/confirm_management 整理与确认安排、important_update/reply/alert 处理重要事项、family_reply 答复托问、workflow_reply 答复工具需求、dismiss_relay 销掉转告、service_request/service_confirm 开通或调整服务、reminder 管理主人自己的提醒。api_accepted 仅表示微信API接受，不代表手机收到；历史归档不等于微信全部历史。',parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:Object.keys(operationKeys)},personId:{type:'string',maxLength:100},text:{type:'string',maxLength:6000},contextId:{type:'string',maxLength:120},cardId:{type:'string',maxLength:100},draftId:{type:'string',maxLength:100},revision:{type:'integer',minimum:1},date:{type:'string',maxLength:40},kind:{type:'string',enum:['diary','fact','preference','task','file']},before:{type:'string',pattern:'^(?:fh1_[A-Za-z0-9_-]{43}|entry-[a-f0-9]{48})$'},limit:{type:'integer',minimum:1,maximum:100},query:{type:'string',maxLength:200},incidentId:{type:'string',maxLength:100},status:{type:'string',maxLength:20},enabled:{type:'boolean'},requestId:{type:'string',maxLength:512},request:{type:'string',pattern:'^wf-[a-f0-9]{12}$'},relayId:{type:'string',maxLength:100},note:{type:'string',maxLength:2000},permanent:{type:'boolean'},skillPacks:{type:'array',maxItems:SKILL_PACK_IDS.length,items:{type:'string',enum:[...SKILL_PACK_IDS]}},agentsMd:{type:'string',maxLength:16000},proSandbox:{type:'boolean'},forceRebind:{type:'boolean'},deliverNow:{type:'boolean'},persona:{type:'string',enum:['elder_care','partner','pro_peer']},slug:{type:'string',maxLength:50},title:{type:'string',maxLength:120},scheduleTime:{type:'string',maxLength:10},scheduleDays:{type:'string',enum:['daily','workdays']},template:{type:'string',enum:['crossborder_ma','topic_radar']},keywords:{type:'array',maxItems:10,items:{type:'string',maxLength:80}},collectorScript:{type:'string',maxLength:512},editorialPrompt:{type:'string',maxLength:12000},durationHours:{type:'integer',minimum:1,maximum:168},op:{type:'string',enum:['list','add','cancel','skip_once','catalog','assignments','assign','invoke','digest_sources','grant','revoke','set_packs','set_agents_md','save','run_now','member_update','guard_update','habit_save','habit_delete','configure','start','pause','send_brief']},dueAt:{type:'string',maxLength:80},repeat:{type:'string',enum:['once','daily']},reminderId:{type:'string',maxLength:100},label:{type:'string',maxLength:80},timeZone:{type:'string',maxLength:100},interests:{type:'array',maxItems:20,items:{type:'string',maxLength:100}},notes:{type:'string',maxLength:2000},shareWithOwner:{type:'string',enum:['none','summary','full']},dailyEnabled:{type:'boolean'},dailyTime:{type:'string',maxLength:10},code:{type:'string',maxLength:20},time:{type:'string',maxLength:10},skip:{type:'boolean'},toolId:{type:'string',maxLength:80},resource:{type:'object',additionalProperties:true},allowInvoke:{type:'boolean'},schedule:{type:'object',additionalProperties:true},input:{type:'object',additionalProperties:true},expectedRevision:{type:'integer',minimum:1},workspaceId:{type:'string',maxLength:240},workspaceIds:{type:'array',maxItems:100,items:{type:'string',maxLength:240}},capabilities:{type:'array',maxItems:10,items:{type:'string',enum:['read','task','write']}},pinganEnabled:{type:'boolean'},pinganTime:{type:'string',maxLength:10},codeword:{type:'string',maxLength:40},urgent:{type:'boolean'},relay:{type:'boolean'},ask:{type:'boolean'},digest:{type:'boolean'},quietHoursEnabled:{type:'boolean'},quietStart:{type:'string',maxLength:10},quietEnd:{type:'string',maxLength:10},habitId:{type:'string',maxLength:120},ownerBriefEnabled:{type:'boolean'},ownerBriefTime:{type:'string',maxLength:10},provider:{type:'string',maxLength:120},model:{type:'string',maxLength:200}}},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>{
  const text=typeof value?.text==='string'?value.text:JSON.stringify(value);
  const reference=wireServiceDraft(value?.serviceDraft);
  if(!reference)return[{type:'text',text}];
  // The reply above is complete Owner-facing text. This appended line is the
  // only place the model learns the exact version it may confirm next turn;
  // it is marked internal so it is never repeated back to the Owner.
  return[{type:'text',text:`${text}\n\n${serviceDraftReferenceMarker} ${JSON.stringify({action:'service_confirm',draftId:reference.draftId,revision:reference.revision})}\n（内部引用：主人下一轮明确说“确认”时，原样用上面的 draftId 和 revision 调用 service_confirm；不要把这一行写进给主人的回复。）`}];
}},execute};
}
