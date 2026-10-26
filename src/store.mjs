import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const clone = value => structuredClone(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = message => { throw new Error(message); };
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : fail('无效的成员标识');
function object(value, fields) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('参数必须为对象'); for (const key of Object.keys(value)) if (!fields.includes(key)) fail('包含不支持的字段'); return value; }
function string(value, name, max = 3200, empty = false) { if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`${name}无效`); return value; }
function oneOf(value, list, name) { if (!list.includes(value)) fail(`${name}无效`); return value; }
function bool(value) { if (typeof value !== 'boolean') fail('开关必须为布尔值'); return value; }
export function validTimeZone(value) { string(value, '时区', 100); try { new Intl.DateTimeFormat('en',{timeZone:value}); } catch { fail('时区无效'); } return value; }
export function validTime(value) { if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('时间须为 HH:mm'); return value; }
export function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) fail('时间戳须带时区且精确到秒');
  const [year,month,day] = value.slice(0,10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year,month-1,day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month-1 || calendar.getUTCDate() !== day || !Number.isFinite(Date.parse(value))) fail('日期无效');
  return new Date(value).toISOString();
}
/** Legacy records belong only to the first binding; a replacement cannot inherit them. */
export function recordMatchesBinding(record,binding) {
  if(!record||typeof record!=='object')return false;
  if(record.bindingGeneration===undefined)return !binding||binding.generation===1;
  return Boolean(binding&&record.bindingGeneration===binding.generation);
}
function validateBindingGeneration(record){if(own(record,'bindingGeneration')&&(!Number.isSafeInteger(record.bindingGeneration)||record.bindingGeneration<1))fail('记录绑定版本无效');}
const personFields = ['id','role','label','timeZone','interests','notes','shareWithOwner','dailyEnabled','dailyTime','createdAt'];
const configFields = ['paused','timeZone','ownerBriefEnabled','ownerBriefTime','provider','model'];
const bindingFields = ['personId','accountId','peerId','generation','status','lastError','lastInboundAt','lastOutboundAt'];
const messageFields = ['id','personId','dir','text','kind','at','attachments','bindingGeneration'];
function attachmentMetadata(value){if(!Array.isArray(value)||value.length>4)fail('附件信息无效');return value.map(row=>{object(row,['name','size','mimeType']);string(row.name,'附件名称',180);if(/[\\/]/.test(row.name))fail('附件名称无效');if(row.size!==undefined&&(!Number.isSafeInteger(row.size)||row.size<0||row.size>10*1024*1024))fail('附件大小无效');if(row.mimeType!==undefined&&(typeof row.mimeType!=='string'||!/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/i.test(row.mimeType)))fail('附件类型无效');return clone(row);});}

const reminderFields = ['id','personId','text','dueAt','repeat','time','timeZone','status','createdAt','updateRequestIds','bindingGeneration'];
const outboxFields = ['id','personId','route','text','kind','sourceKey','status','createdAt','expiresAt','detail','authorizationRoute'];
const ownerCommandFields = ['id','requestedBy','targetPersonId','inboundMessageId','action','status','requestRoute','resultId','detail','createdAt','updatedAt'];
const ownerCommandStatuses = ['pending','scheduled','api_accepted','failed','uncertain','cancelled'];
const ownerCommandDetails = {pending:'等待执行',scheduled:'已创建提醒',api_accepted:'发送接口已接收',failed:'执行未完成',uncertain:'发送结果未知',cancelled:'操作已取消'};
const connectionStatuses = ['connected','connecting','awaiting_scan','scanned','expired','disconnected','error'];
const outboxStatuses = ['pending','dispatching','api_accepted','failed','blocked','uncertain','cancelled','expired'];
function interests(value) { if (!Array.isArray(value) || value.length > 20) fail('兴趣须为最多20项列表'); return value.map(v => string(v,'兴趣',100)); }
function validatePerson(p) { object(p,personFields); safeId(p.id); oneOf(p.role,['owner','elder'],'角色'); string(p.label,'称呼',80); validTimeZone(p.timeZone); interests(p.interests); string(p.notes,'个人备注',2000,true); oneOf(p.shareWithOwner,['none','summary','full'],'分享范围'); bool(p.dailyEnabled); validTime(p.dailyTime); timestamp(p.createdAt); }
function validateConfig(c) { object(c,configFields); bool(c.paused); validTimeZone(c.timeZone); bool(c.ownerBriefEnabled); validTime(c.ownerBriefTime); string(c.provider,'服务商',120,true); string(c.model,'模型',200,true); }
function validateRoute(r) { object(r,['personId','accountId','peerId','generation']); safeId(r.personId); string(r.accountId,'账号',200); string(r.peerId,'联系人',200); if (!Number.isSafeInteger(r.generation) || r.generation < 1) fail('绑定版本无效'); }
function ownerCommandDetail(status,detail) {
  oneOf(status,ownerCommandStatuses,'指令状态');
  if(detail!==undefined&&detail!==ownerCommandDetails[status]) fail('指令说明只能使用固定执行状态');
  return ownerCommandDetails[status];
}
function validateOwnerCommand(command,people) {
  object(command,ownerCommandFields);safeId(command.id);safeId(command.requestedBy);safeId(command.targetPersonId);
  if(people.find(p=>p.id===command.requestedBy)?.role!=='owner') fail('只有已登记 Owner 可以发起指令');
  if(people.find(p=>p.id===command.targetPersonId)?.role!=='elder') fail('指令目标必须是已登记长辈');
  string(command.inboundMessageId,'来源消息标识',512);oneOf(command.action,['send_daily','remind'],'指令动作');
  ownerCommandDetail(command.status,command.detail);validateRoute(command.requestRoute);
  if(command.requestRoute.personId!==command.requestedBy) fail('指令授权路由无效');
  if(own(command,'resultId')) safeId(command.resultId);
  timestamp(command.createdAt);timestamp(command.updatedAt);
}
function validateState(s) {
  object(s,['version','config','people','bindings','messages','reminders','outbox','ownerCommands']); if(s.version !== 1) fail('不支持的存储版本'); validateConfig(s.config);
  for(const key of ['people','bindings','messages','reminders','outbox']) if(!Array.isArray(s[key])) fail('存储列表无效');
  const ids = new Set(); for(const p of s.people) { validatePerson(p); if(ids.has(p.id)) fail('成员重复'); ids.add(p.id); }
  if(s.people.filter(p=>p.role==='owner').length > 1) fail('只能有一位 Owner');
  const bound = new Set(); const peers = new Set(); const accounts = new Set(); for(const b of s.bindings) { object(b,bindingFields); validateRoute({personId:b.personId,accountId:b.accountId,peerId:b.peerId,generation:b.generation}); if(!ids.has(b.personId)||bound.has(b.personId)||peers.has(b.peerId)||accounts.has(b.accountId)) fail('绑定冲突'); bound.add(b.personId); peers.add(b.peerId); accounts.add(b.accountId); oneOf(b.status,connectionStatuses,'连接状态'); if(own(b,'lastError')) string(b.lastError,'连接错误',500,true); for(const k of ['lastInboundAt','lastOutboundAt']) if(own(b,k)) timestamp(b[k]); }
  const messageKeys = new Set(); for(const m of s.messages) { object(m,messageFields); if(!ids.has(m.personId)) fail('未知消息成员'); string(m.id,'消息标识',512); const key=m.personId+'\0'+m.dir+'\0'+m.id; if(messageKeys.has(key)) fail('消息重复'); messageKeys.add(key); oneOf(m.dir,['in','out'],'消息方向'); string(m.text,'消息',8000); string(m.kind,'消息类型',80); timestamp(m.at);validateBindingGeneration(m);if(m.attachments!==undefined)attachmentMetadata(m.attachments); }
  const reminderIds = new Set(); for(const r of s.reminders) { object(r,reminderFields); safeId(r.id); if(reminderIds.has(r.id)||!ids.has(r.personId)) fail('提醒成员或标识无效'); reminderIds.add(r.id); string(r.text,'提醒内容',1000); timestamp(r.dueAt); oneOf(r.repeat,['once','daily'],'重复方式'); if(own(r,'time')) validTime(r.time); if(r.repeat==='daily'&&!r.time) fail('每日提醒需要时间'); validTimeZone(r.timeZone); oneOf(r.status,['active','cancelled','completed','expired'],'提醒状态'); timestamp(r.createdAt);validateBindingGeneration(r); if(own(r,'updateRequestIds')) {if(!Array.isArray(r.updateRequestIds)||r.updateRequestIds.length>1000||new Set(r.updateRequestIds).size!==r.updateRequestIds.length)fail('提醒修改记录无效');for(const id of r.updateRequestIds)string(id,'提醒请求标识',512);} }
  const sources = new Set(); const outIds=new Set(); for(const o of s.outbox) { object(o,outboxFields); safeId(o.id); if(outIds.has(o.id)||!ids.has(o.personId)||sources.has(o.sourceKey)) fail('待发标识无效'); sources.add(o.sourceKey); outIds.add(o.id); validateRoute(o.route);if(o.authorizationRoute)validateRoute(o.authorizationRoute); if(o.route.personId!==o.personId) fail('待发路由无效'); string(o.text,'发送内容',3200); string(o.kind,'发送类型',80); string(o.sourceKey,'来源标识',512); oneOf(o.status,outboxStatuses,'发送状态'); timestamp(o.createdAt); if(o.expiresAt!==null) timestamp(o.expiresAt); string(o.detail,'发送说明',500,true); }
  if(own(s,'ownerCommands')) {
    if(!Array.isArray(s.ownerCommands)) fail('指令记录列表无效');
    const commandIds=new Set();
    for(const command of s.ownerCommands) {validateOwnerCommand(command,s.people);if(commandIds.has(command.id)) fail('指令标识重复');commandIds.add(command.id);}
  }
}
function initial() { return {version:1,config:{paused:true,timeZone:'Asia/Shanghai',ownerBriefEnabled:false,ownerBriefTime:'20:00',provider:'',model:''},people:[],bindings:[],messages:[],reminders:[],outbox:[]}; }

/** Synchronous single-process store. The runtime owns the exclusive process lock. */
export function createStore({directory,now = () => new Date().toISOString()} = {}) {
  string(directory,'存储目录',4096); if(typeof now !== 'function') fail('时钟无效'); mkdirSync(directory,{recursive:true,mode:0o700});
  const file = join(directory,'family.json'); let state = existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : initial(); validateState(state);
  const clock = () => timestamp(now());
  function persist(next) { validateState(next); const temporary = join(directory,`.family-${randomUUID()}.tmp`); let fd; try { fd = openSync(temporary,'wx',0o600); writeFileSync(fd,JSON.stringify(next,null,2)+'\n'); fsyncSync(fd); closeSync(fd); fd=undefined; renameSync(temporary,file); chmodSync(file,0o600); let dirfd; try { dirfd=openSync(directory,'r'); fsyncSync(dirfd); } finally {if(dirfd!==undefined) closeSync(dirfd);} } catch(error) {if(fd!==undefined) closeSync(fd); try {unlinkSync(temporary);}catch{} throw error;} }
  function change(fn) { const next = clone(state); const result = fn(next); persist(next); state=next; return clone(result); }
  const findPerson = (s,id) => s.people.find(p=>p.id===safeId(id)) || fail('找不到成员');
  const findBinding = (s,id) => {findPerson(s,id); return s.bindings.find(b=>b.personId===id) || null;};
  const routeOf = (s,id) => { const b=findBinding(s,id); if(!b) fail('请先绑定该成员的微信'); return {personId:id,accountId:b.accountId,peerId:b.peerId,generation:b.generation}; };
  const findOut = (s,id) => s.outbox.find(o=>o.id===safeId(id)) || fail('找不到发送记录');
  const findReminder = (s,id) => s.reminders.find(r=>r.id===safeId(id)) || fail('找不到提醒');
  const currentRoute = (s,o) => {const b=findBinding(s,o.personId); return b && ['accountId','peerId','generation'].every(k=>b[k]===o.route[k]);};
  if(!existsSync(file)) persist(state);
  return {
    snapshot:()=>clone(state),
    configure(patch) { object(patch,configFields); return change(s=>{Object.assign(s.config,clone(patch)); validateConfig(s.config); return s.config;}); },
    addPerson(input) { object(input,personFields.filter(k=>k!=='createdAt')); return change(s=>{const p={id:input.id??randomUUID(),role:input.role,label:input.label,timeZone:s.config.timeZone,interests:[],notes:'',shareWithOwner:'none',dailyEnabled:false,dailyTime:'08:00',...clone(input),createdAt:clock()}; validatePerson(p); if(s.people.some(other=>other.id===p.id)) fail('成员标识已存在'); if(p.role==='owner'&&s.people.some(other=>other.role==='owner')) fail('只能添加一位 Owner'); s.people.push(p); return p;}); },
    updatePerson(id,patch) { object(patch,['label','timeZone','interests','notes','shareWithOwner','dailyEnabled','dailyTime']); return change(s=>{const p=findPerson(s,id); const previousShare=p.shareWithOwner; Object.assign(p,clone(patch)); validatePerson(p); if(p.shareWithOwner!==previousShare) for(const o of s.outbox) if(o.kind==='owner_brief'&&o.status==='pending') {o.status='cancelled';o.detail='分享设置已更改，请重新生成简报';} return p;}); },
    person:id=>clone(findPerson(state,id)),
    binding:id=>clone(findBinding(state,id)),
    bindPerson(id,input) { object(input,['accountId','peerId']); string(input.accountId,'账号',200); string(input.peerId,'联系人',200); return change(s=>{findPerson(s,id); if(s.bindings.some(b=>b.personId!==id&&(b.accountId===input.accountId||b.peerId===input.peerId))) fail('该微信联系人已绑定其他成员'); const old=findBinding(s,id); const changed=old && (old.accountId!==input.accountId||old.peerId!==input.peerId); const b={personId:id,...clone(input),generation:old ? old.generation+(changed?1:0):1,status:'connected'}; if(old) s.bindings[s.bindings.indexOf(old)]=b; else s.bindings.push(b); if(changed) for(const o of s.outbox.filter(o=>o.personId===id)) { if(o.status==='pending') {o.status='cancelled';o.detail='绑定已更换';} else if(o.status==='dispatching') {o.status='uncertain';o.detail='发送期间绑定已更换，结果待确认';} } return b;}); },
    setConnection(id,patch) { object(patch,['status','lastError','lastInboundAt','lastOutboundAt']); return change(s=>{const b=findBinding(s,id); if(!b) return null; if(own(patch,'status')) oneOf(patch.status,connectionStatuses,'连接状态'); if(own(patch,'lastError')) string(patch.lastError,'连接错误',500,true); for(const k of ['lastInboundAt','lastOutboundAt']) if(own(patch,k)) timestamp(patch[k]); Object.assign(b,clone(patch)); if(patch.status==='connected'&&!own(patch,'lastError')) delete b.lastError; return b;}); },
    route:id=>clone(routeOf(state,id)),
    recordInbound(id,input) { object(input,['id','peerId','text','at','attachments']); string(input.id,'消息标识',512); string(input.peerId,'联系人',200); string(input.text,'消息',8000); const b=findBinding(state,id); if(!b||b.peerId!==input.peerId||state.messages.some(m=>m.personId===id&&m.dir==='in'&&m.id===input.id)) return {accepted:false}; return change(s=>{const message={id:input.id,personId:id,dir:'in',text:input.text,kind:'chat',at:input.at?timestamp(input.at):clock(),bindingGeneration:b.generation,...(input.attachments?.length?{attachments:attachmentMetadata(input.attachments)}:{})}; s.messages.push(message); return {accepted:true,message};}); },
    addMessage(id,input) { object(input,['id','dir','text','kind','at','attachments']); return change(s=>{findPerson(s,id); const binding=findBinding(s,id); const m={id:input.id??randomUUID(),personId:id,...(binding?{bindingGeneration:binding.generation}:{}),dir:input.dir,text:input.text,kind:input.kind??'chat',at:input.at?timestamp(input.at):clock(),...(input.attachments?.length?{attachments:attachmentMetadata(input.attachments)}:{})}; s.messages.push(m); return m;}); },
    messages(id,{limit}={}) { findPerson(state,id); if(limit!==undefined && (!Number.isSafeInteger(limit)||limit<0||limit>10000)) fail('消息数量无效'); const messages=state.messages.filter(m=>m.personId===id); return clone(limit===undefined?messages:limit===0?[]:messages.slice(-limit)); },
    recordOwnerCommand(input) {
      object(input,['id','requestedBy','targetPersonId','inboundMessageId','action','status','resultId','detail']);
      const instant=clock();
      const command={...clone(input),requestRoute:routeOf(state,input.requestedBy),detail:ownerCommandDetail(input.status,input.detail),createdAt:instant,updatedAt:instant};
      validateOwnerCommand(command,state.people);
      const previous=state.ownerCommands?.find(row=>row.id===command.id);
      if(previous) {
        if(['requestedBy','targetPersonId','inboundMessageId','action'].some(key=>previous[key]!==command[key])) fail('指令标识属于其他请求');
        return clone(previous);
      }
      return change(s=>{(s.ownerCommands??=[]).push(command);return command;});
    },
    updateOwnerCommand(id,patch) {
      safeId(id);object(patch,['status','resultId','detail']);
      const detail=ownerCommandDetail(patch.status,patch.detail);
      if(own(patch,'resultId')) safeId(patch.resultId);
      return change(s=>{
        const command=s.ownerCommands?.find(row=>row.id===id);if(!command) fail('找不到指令记录');
        Object.assign(command,clone(patch),{detail,updatedAt:clock()});return command;
      });
    },
    ownerCommands:()=>clone(state.ownerCommands??[]),
    addReminder(input) { object(input,['id','personId','text','dueAt','repeat','time','timeZone']); if(input.id){safeId(input.id);const old=state.reminders.find(r=>r.id===input.id);if(old){if(old.personId!==input.personId||old.text!==input.text)fail('提醒标识属于其他安排');if(!recordMatchesBinding(old,findBinding(state,input.personId)))fail('提醒属于旧微信绑定，不能接管');return clone(old);}} return change(s=>{const p=findPerson(s,input.personId); const repeat=input.repeat??'once'; const timeZone=validTimeZone(input.timeZone??p.timeZone); const dueAt=timestamp(input.dueAt); let time=input.time; if(repeat==='daily'&&!time) { const parts = new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(dueAt)); time=parts.find(p=>p.type==='hour').value+':'+parts.find(p=>p.type==='minute').value; } const reminder={id:input.id??randomUUID(),personId:p.id,text:input.text,dueAt,repeat,...(time!==undefined?{time}:{}),timeZone,status:'active',createdAt:clock(),...(findBinding(s,p.id)?{bindingGeneration:findBinding(s,p.id).generation}:{})}; s.reminders.push(reminder); return reminder;}); },
    updateReminder(personId,id,patch,{requestId}={}) {
      object(patch,['text','dueAt','repeat','time']);if(!Object.keys(patch).length)fail('没有可修改的提醒内容');string(requestId,'提醒请求标识',512);
      const previous=findReminder(state,id);findPerson(state,personId);if(previous.personId!==personId)fail('不能修改其他成员的提醒');if(!recordMatchesBinding(previous,findBinding(state,personId)))fail('提醒属于旧微信绑定，当前成员不能修改');
      if(previous.updateRequestIds?.includes(requestId))return clone(previous);
      return change(s=>{
        const reminder=findReminder(s,id),occurrences=s.outbox.filter(o=>o.personId===personId&&o.sourceKey.startsWith(`reminder:${id}:`));
        if(occurrences.some(o=>['dispatching','uncertain'].includes(o.status)))fail('提醒正在发送或结果尚未确认，不能修改或撤回该消息');
        if(reminder.status!=='active'&&!(reminder.status==='completed'&&occurrences.some(o=>o.status==='pending')))fail('这条提醒已结束，不能修改');
        const nextDue=own(patch,'dueAt')?timestamp(patch.dueAt):reminder.dueAt;
        if(occurrences.some(o=>o.sourceKey===`reminder:${id}:${nextDue}`))fail('这个提醒时刻已经进入处理，请使用新的未来时间');
        if((reminder.updateRequestIds?.length??0)>=1000)fail('提醒修改记录达到容量上限');
        Object.assign(reminder,clone(patch),{dueAt:nextDue,status:'active'});
        if(reminder.repeat==='once')delete reminder.time;
        for(const o of occurrences)if(o.status==='pending'){o.status='cancelled';o.detail='提醒已修改，旧安排已取消';}
        (reminder.updateRequestIds??=[]).push(requestId);return reminder;
      });
    },
    cancelReminder(personId,id) { return change(s=>{findPerson(s,personId); const reminder=findReminder(s,id); if(reminder.personId!==personId) fail('不能取消其他成员的提醒');if(!recordMatchesBinding(reminder,findBinding(s,personId)))fail('提醒属于旧微信绑定，当前成员不能取消'); reminder.status='cancelled'; for(const o of s.outbox) if(o.personId===personId&&o.status==='pending'&&o.sourceKey.startsWith(`reminder:${id}:`)) {o.status='cancelled';o.detail='提醒已取消';} return reminder;}); },
    reminders(personId) { findPerson(state,personId); return clone(state.reminders.filter(r=>r.personId===personId)); },
    enqueue(input) { object(input,['personId','text','kind','sourceKey','expiresAt','authorizationRoute']); string(input.sourceKey,'来源标识',512); const old=state.outbox.find(o=>o.sourceKey===input.sourceKey); if(old) {if(old.personId!==input.personId) fail('来源标识属于其他成员'); return clone(old);} return change(s=>{const route=routeOf(s,input.personId); const o={id:randomUUID(),personId:input.personId,route,...(input.authorizationRoute?{authorizationRoute:clone(input.authorizationRoute)}:{}),text:input.text,kind:input.kind,sourceKey:input.sourceKey,status:'pending',createdAt:clock(),expiresAt:input.expiresAt?timestamp(input.expiresAt):null,detail:''}; s.outbox.push(o); return o;}); },
    pending:()=>clone(state.outbox.filter(o=>o.status==='pending')),
    updatePendingText(id,text) { string(text,'发送内容',3200); return change(s=>{const o=findOut(s,id); if(o.status!=='pending') fail('只能更新未发送的内容'); o.text=text; return o;}); },
    transition(id,status,detail='') { oneOf(status,outboxStatuses,'发送状态'); string(detail,'发送说明',500,true); return change(s=>{const o=findOut(s,id); if(o.status===status) return o; const allowed=o.status==='pending'?['dispatching','cancelled','expired','blocked']:o.status==='dispatching'?['api_accepted','failed','uncertain','blocked','cancelled']:[]; if(!allowed.includes(status)) fail('不允许的发送状态变化'); if(status==='dispatching') {const p=findPerson(s,o.personId); if(!currentRoute(s,o)) {o.status='cancelled';o.detail='绑定已更换';return o;} if(o.expiresAt&&Date.parse(o.expiresAt)<=Date.parse(clock())) {o.status='expired';o.detail='内容已过期';return o;} if(s.config.paused) {o.status='blocked';o.detail='家庭助手已暂停';return o;} if(o.kind==='elder_daily'&&!p.dailyEnabled || o.kind==='owner_brief'&&o.sourceKey.startsWith('owner-brief:')&&!s.config.ownerBriefEnabled) {o.status='blocked';o.detail='定时服务已停用';return o;} if(o.sourceKey.startsWith('reminder:')) {const reminderId=o.sourceKey.split(':')[1]; const r=s.reminders.find(r=>r.id===reminderId); if(r?.status==='cancelled') {o.status='cancelled';o.detail='提醒已取消';return o;}} } o.status=status;o.detail=detail; if(status==='api_accepted') s.messages.push({id:`out-${o.id}`,personId:o.personId,dir:'out',text:o.text,kind:o.kind,at:clock(),bindingGeneration:o.route.generation}); return o;}); },
    recoverDispatching() { return change(s=>{const recovered=s.outbox.filter(o=>o.status==='dispatching'); for(const o of recovered) {o.status='uncertain';o.detail='上次发送结果未知，请人工确认';} return recovered;}); },
    markReminder(id,patch) { object(patch,['status','dueAt']); return change(s=>{const r=findReminder(s,id); if(own(patch,'status')) oneOf(patch.status,['active','cancelled','completed','expired'],'提醒状态'); if(own(patch,'dueAt')) patch={...patch,dueAt:timestamp(patch.dueAt)}; Object.assign(r,clone(patch)); return r;}); },
  };
}
