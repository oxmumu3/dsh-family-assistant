import {mkdirSync,lstatSync,realpathSync,openSync,readFileSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync,fstatSync,fchmodSync,constants} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {timestamp,recordMatchesBinding} from './store.mjs';
import {localDate,localParts,addLocalDays,localDateTimeToInstant,validDate} from './brief.mjs';
import {assertReminderTime} from './owner-commands.mjs';

const clone=value=>structuredClone(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actions=['remember','search_notes','forget_note','remind','update_reminder','cancel','list'];
const daily=/每天|每日|天天|每晚|每早|每个(?:早上|晚上|上午|下午|中午)/;
function fail(message){throw new Error(message);}
function object(value,keys,required=[]){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key))||required.some(key=>!Object.hasOwn(value,key)))fail('个人记录参数或字段无效。');}
function string(value,max=2000,{empty=false}={}){if(typeof value!=='string'||value.length>max||(!empty&&!value.trim())||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))fail('个人记录文本或标识无效。');return value;}
function id(value){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(value))fail('个人记录标识无效。');return value;}
function evidence(text,quote){string(quote,2000);if(!text.includes(quote))fail('操作依据必须逐字出自当前原话。');return quote;}
function quoted(text,quote,content){evidence(text,quote);string(content,1600);if(!quote.includes(content))fail('只能保存或修改当前原话中有依据的原文。');}
function explicit(text,pattern,label){const match=pattern.exec(text),prefix=match?text.slice(0,match.index):text;if(!match||/(?:不要|不用|别|不必|不再)|(?:如果|假如|比如|例如|假设|能不能|可以吗|会不会)/.test(prefix))fail(`请明确说明要${label}哪一项，尚未执行。`);}
function statOrNull(path){try{return lstatSync(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function validate(value){
 object(value,['version','notes','operations'],['version','notes','operations']);
 if(value.version!==1||!Array.isArray(value.notes)||!Array.isArray(value.operations)||value.notes.length>200||value.operations.length>2000)fail('个人记录格式或容量无效。');
 const ids=new Set(),ops=new Set();
 for(const row of value.notes){object(row,['id','personId','scope','text','evidence','createdAt'],['id','personId','scope','text','evidence','createdAt']);id(row.id);id(row.personId);if(!/^[a-f0-9]{64}$/.test(row.scope)||ids.has(row.id))fail('个人记录格式无效。');ids.add(row.id);string(row.text,1600);string(row.evidence,2000);if(!row.evidence.includes(row.text))fail('个人记录原话依据无效。');timestamp(row.createdAt);}
 for(const row of value.operations){object(row,['personId','scope','requestId','type','noteId'],['personId','scope','requestId','type','noteId']);id(row.personId);id(row.noteId);string(row.requestId,512);if(!/^[a-f0-9]{64}$/.test(row.scope)||!['remember','forget_note'].includes(row.type))fail('个人记录格式无效。');const key=JSON.stringify([row.personId,row.scope,row.requestId]);if(ops.has(key))fail('个人记录请求重复。');ops.add(key);}
 return value;
}
function latest(rows){const newest=rows.reduce((value,row)=>String(row.createdAt)>value?String(row.createdAt):value,'');const matches=rows.filter(row=>row.createdAt===newest);return matches.length===1?matches[0]:null;}
function matchTarget(rows,chosen,text,{noun='提醒',allowLatest=true}={}){
 const row=rows.find(row=>row.id===chosen);if(!row)fail(`没有找到本人当前可操作的${noun}，请说明具体哪一项。`);
 if(text.includes(chosen))return row;
 if(allowLatest&&/刚才(?:的)?那(?:一)?条|刚刚(?:的)?那(?:一)?条|上一条|最新(?:的)?那?条/.test(text)){
  if(latest(rows)?.id!==chosen)fail(`不止一项可能指向刚才那条，请说明具体${noun}。`);return row;
 }
 let matches=rows.filter(row=>text.includes(row.text));
 if(!matches.length){const subject=text.normalize('NFKC').split(/改(?:成|到|为)?|调整(?:成|到|为)?|换成|推迟|提前/)[0].replace(/请|麻烦|帮我|给我|把|将|取消|停止|删掉|删除|忘掉|忘记|不再提醒|(?:的)?(?:提醒|日程|安排|记录|便条|笔记|备忘|事项|那一条|那条|这条|一下)|[\s，。！？、：:]/g,'');if(subject.length>=2&&subject.length<=120)matches=rows.filter(row=>row.text.includes(subject));}
 if(matches.length!==1||matches[0].id!==chosen)fail(`请说出要操作的具体${noun}，当前指代有歧义。`);return row;
}
function stamp(instant,person){return new Date(instant).toLocaleString('zh-CN',{timeZone:person.timeZone,hour12:false});}
function resolvedWeekdayText(text,person,now){
 const normalized=text.normalize('NFKC');
 if(/每(?:个)?(?:周|星期)|每逢|隔周|隔星期/.test(normalized))fail('目前尚不支持每周重复提醒，请明确安排一次的日期和时间。');
 const pattern=/(?<![上下本这])((?:本|这|下)(?:周|星期))(?:(?:周|星期))?([一二三四五六日天])/g;
 const matches=[...normalized.matchAll(pattern)];
 if(matches.length>1)fail('请一次说明一项明确的星期日期和时间。');
 if(!matches.length){if(/周[一二三四五六日天]|星期[一二三四五六日天]|下下周|上周/.test(normalized))fail('请明确是本周还是下周，并说明具体日期时间。');return normalized;}
 const match=matches[0],today=localDate(now,person.timeZone),weekday=new Date(today+'T12:00:00Z').getUTCDay();
 const monday=addLocalDays(today,-((weekday+6)%7)),day={'一':0,'二':1,'三':2,'四':3,'五':4,'六':5,'日':6,'天':6}[match[2]];
 const expected=addLocalDays(monday,day+(match[1].startsWith('下')?7:0));
 return normalized.slice(0,match.index)+expected+' '+normalized.slice(match.index+match[0].length);
}
function groundedTime(action,text,person,now){
 let dueAt=timestamp(action.dueAt);const parts=localParts(dueAt,person.timeZone),time=`${parts.hour}:${parts.minute}`;
 if(action.time!==undefined&&action.time!==time)fail('提醒时刻与原话时间不一致。');
 if(action.timeEvidence!==undefined)evidence(text,action.timeEvidence);
 const timeText=resolvedWeekdayText(text,person,now);
 assertReminderTime({date:localDate(dueAt,person.timeZone),time,repeat:daily.test(text)?'daily':'once'},{text:timeText,target:person,now});
 const interval=text.normalize('NFKC').match(/(\d+(?:\.\d+)?|[一二两三四五六七八九十]+|半)(?:个)?(小时|分钟|分)\s*(?:以|之)?后/);
 if(interval){
  const digits={'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};const value=interval[1];const amount=value==='半'?0.5:/^\d/.test(value)?Number(value):value.includes('十')?(digits[value.split('十')[0]]??1)*10+(digits[value.split('十')[1]]??0):digits[value];
  const expected=new Date(Date.parse(now)+amount*(interval[2]==='小时'?3600000:60000)).toISOString();
  if(localDate(expected,person.timeZone)!==localDate(dueAt,person.timeZone)||`${localParts(expected,person.timeZone).hour}:${localParts(expected,person.timeZone).minute}`!==time)fail('相对提醒时间与原话不一致。');dueAt=expected;
 }else if(localDateTimeToInstant(localDate(dueAt,person.timeZone),time,person.timeZone)!==dueAt)fail('提醒时间与明确钟点不一致。');
 if(Date.parse(dueAt)<=Date.parse(now))fail('提醒时间已经过去，请明确新的未来日期和时间。');
 return{dueAt,time};
}

/** Private binding-scoped notes; calendar mutations use the existing reminder store only. */
export function createPersonalOrganizer({directory,store,now=()=>new Date().toISOString()}={}){
 string(directory,4096);if(typeof store?.person!=='function'||typeof store?.reminders!=='function'||typeof now!=='function')fail('个人记录存储配置无效。');
 const supplied=resolve(directory),before=statOrNull(supplied);if(before&&(before.isSymbolicLink()||!before.isDirectory()))fail('个人记录目录路径不能是链接。');
 mkdirSync(supplied,{recursive:true,mode:0o700});const root=realpathSync(supplied),rootIdentity=lstatSync(root),file=join(root,'personal-organizer.json');
 function secure({optional=false}={}){
  const dir=statOrNull(root);if(!dir||dir.isSymbolicLink()||!dir.isDirectory()||dir.dev!==rootIdentity.dev||dir.ino!==rootIdentity.ino)fail('个人记录目录路径发生变化。');
  const current=statOrNull(file);if(!current){if(optional)return null;fail('个人记录文件缺失，请保留现状后检查。');}
  if(current.isSymbolicLink()||!current.isFile()||current.nlink!==1)fail('个人记录文件路径不能是链接或特殊文件。');
  if((current.mode&0o077)!==0)fail('个人记录文件权限须为本人私有。');if(current.size>=2*1024*1024)fail('个人记录超过容量上限。');return current;
 }
 function read(){const expected=secure();let fd;try{fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);const current=fstatSync(fd);if(current.ino!==expected.ino||current.dev!==expected.dev||current.nlink!==1)fail('个人记录读取路径发生变化。');let value;try{value=JSON.parse(readFileSync(fd,'utf8'));}catch{fail('个人记录格式无法解析。');}return validate(value);}finally{if(fd!==undefined)closeSync(fd);}}
 function persist(value,{initial=false}={}){
  validate(value);const serialized=JSON.stringify(value,null,2)+'\n';if(Buffer.byteLength(serialized)>2*1024*1024)fail('个人记录超过容量上限。');secure({optional:initial});const temporary=join(root,`.personal-organizer-${randomUUID()}.tmp`);let fd;
  try{fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);fchmodSync(fd,0o600);writeFileSync(fd,serialized);fsyncSync(fd);closeSync(fd);fd=undefined;secure({optional:initial});renameSync(temporary,file);const dirfd=openSync(root,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(dirfd);}finally{closeSync(dirfd);}}
  finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch{}}
 }
 function member(personId){id(personId);return store.person(personId);}
 function scope(personId){const binding=store.binding(personId);return hash(binding?{accountId:binding.accountId,peerId:binding.peerId,generation:binding.generation}:{unbound:personId});}
 function currentNotes(state,personId,bindingScope){return state.notes.filter(row=>row.personId===personId&&row.scope===bindingScope);}
 function currentReminders(personId){return store.reminders(personId).filter(row=>row.status==='active'&&recordMatchesBinding(row,store.binding(personId)));}
 if(secure({optional:true}))read();else persist({version:1,notes:[],operations:[]},{initial:true});
 return{
  file,
  context(personId){member(personId);const notes=currentNotes(read(),personId,scope(personId)).map(({id,text,createdAt})=>({id,text:text.slice(0,240),createdAt}));const reminders=currentReminders(personId).map(({id,personId,text,dueAt,repeat,time,timeZone,status,createdAt})=>({id,personId,text,dueAt,repeat,...(time?{time}:{}),timeZone,status,createdAt}));return{notes,reminders,latestReminderId:latest(reminders)?.id??null};},
  execute({personId,text,action,requestId}={}){
   if(!action||!actions.includes(action.type))return null;
   const person=member(personId);string(text,8000);string(requestId,512);const instant=timestamp(now()),bindingScope=scope(personId);
   const keys={remember:['type','text','evidence'],search_notes:['type','query'],forget_note:['type','noteId','evidence'],remind:['type','text','dueAt','repeat','time','timeEvidence'],update_reminder:['type','reminderId','patch','evidence','timeEvidence'],cancel:['type','reminderId'],list:['type','query']}[action.type];object(action,keys);
   if(['remember','forget_note','search_notes'].includes(action.type)){
    const state=read(),notes=currentNotes(state,personId,bindingScope),op=state.operations.find(row=>row.personId===personId&&row.scope===bindingScope&&row.requestId===requestId);
    if(action.type==='search_notes'){
     string(action.query,120,{empty:true});if(action.query&&!text.includes(action.query))fail('查询词必须出自当前原话。');
     const rows=notes.filter(row=>!action.query||row.text.toLocaleLowerCase().includes(action.query.toLocaleLowerCase()));
     const shown=rows.slice(-8),perLine=shown.length?Math.floor(2800/shown.length):1600,truncated=rows.length>shown.length||shown.some(row=>row.text.length>perLine);
     return{reply:rows.length?`你记下过：\n${shown.map(row=>row.text.length>perLine?row.text.slice(0,perLine)+'…':row.text).join('\n')}${truncated?`\n共有${rows.length}条相关记录；可以再说具体关键词查看完整原文。`:''}`:'没有找到相关的个人记录。'};
    }
    if(op){if(op.type!==action.type)fail('这条请求标识已经用于其他操作。');return{reply:op.type==='forget_note'?'这条个人记录已删除。':notes.some(row=>row.id===op.noteId)?'这条个人记录已经记下。':'这条个人记录已删除，没有重新保存。'};}
    if(state.operations.length>=2000)fail('个人记录请求达到容量上限，请先核对存储。');
    if(action.type==='remember'){
     quoted(text,action.evidence,action.text);explicit(action.evidence,/记住|记下|记一下|存一下|保存|备忘/,'记住');if(state.notes.length>=200)fail('个人记录达到容量上限，请先删除不再需要的记录。');
     const note={id:'note-'+hash([personId,bindingScope,requestId]).slice(0,48),personId,scope:bindingScope,text:action.text,evidence:action.evidence,createdAt:instant};state.notes.push(note);state.operations.push({personId,scope:bindingScope,requestId,type:'remember',noteId:note.id});persist(state);return{reply:`已记下：${note.text}。以后可以直接问我，也可以让我忘掉这条。`};
    }
    evidence(text,action.evidence);explicit(action.evidence,/忘掉|忘记|删除|删掉|不再记|清除/,'忘掉');const note=matchTarget(notes,action.noteId,text,{noun:'个人记录'});state.notes=state.notes.filter(row=>row.id!==note.id);state.operations.push({personId,scope:bindingScope,requestId,type:'forget_note',noteId:note.id});persist(state);return{reply:'已删除这条个人记录。原来的聊天消息不会因此撤回。'};
   }
   if(action.type==='list'){
    if(action.query!==undefined){string(action.query,120,{empty:true});if(action.query&&!text.includes(action.query))fail('查询范围必须出自当前原话。');}
    const today=localDate(instant,person.timeZone),query=action.query??text;let from=null,to=null;
    if(/今天|今日/.test(query))from=to=today;
    else if(/明天|明日/.test(query))from=to=addLocalDays(today,1);
    else if(/这周|本周|下周/.test(query)){const weekday=new Date(today+'T12:00:00Z').getUTCDay(),monday=addLocalDays(today,-((weekday+6)%7));from=addLocalDays(monday,/下周/.test(query)?7:0);to=addLocalDays(from,6);}
    const dateQuery=resolvedWeekdayText(query,person,instant),dates=[...dateQuery.matchAll(/\d{4}-\d{2}-\d{2}/g)].map(match=>validDate(match[0]));
    if(dates.length===1)from=to=dates[0];else if(dates.length===2&&dates[0]<=dates[1]){from=dates[0];to=dates[1];}else if(dates.length)fail('请一次查询一个明确日期或从早到晚的一段日期。');
    const keyword=!from&&action.query&&!/所有|全部|待办|安排|日程|提醒|查看|有什么|哪些/.test(action.query)?action.query:null;
    const rows=currentReminders(personId).filter(row=>(!keyword||row.text.includes(keyword))&&(!from||(localDate(row.dueAt,person.timeZone)>=from&&localDate(row.dueAt,person.timeZone)<=to))).sort((a,b)=>a.dueAt.localeCompare(b.dueAt));
    const shown=rows.slice(0,12),perLine=shown.length?Math.max(40,Math.floor(2700/shown.length)-50):200,truncated=rows.length>shown.length||shown.some(row=>row.text.length>perLine);
    return{reply:rows.length?`你的${from?'这段时间的':'待办'}安排：\n${shown.map(row=>`${stamp(row.dueAt,person)} ${row.text.length>perLine?row.text.slice(0,perLine)+'…':row.text}${row.repeat==='daily'?'（每天）':''}`).join('\n')}${truncated?'\n更多安排请按具体日期继续查询。':''}`:'这段时间没有待执行的安排。'};
   }
   if(action.type==='remind'){
    string(action.text,200);if(!text.includes(action.text))fail('提醒内容必须有当前原话依据。');explicit(text,/提醒|安排|日程|设个|设置|记一下|记下/,'设置提醒');
    const repeat=action.repeat??'once';if(!['once','daily'].includes(repeat)||(repeat==='daily')!==daily.test(text))fail('提醒重复方式与原话不一致。');const timing=groundedTime(action,text,person,instant);
    const reminder=store.addReminder({id:'personal-'+hash([personId,bindingScope,requestId]).slice(0,48),personId,text:action.text,dueAt:timing.dueAt,repeat,...(repeat==='daily'?{time:timing.time}:{}),timeZone:person.timeZone});return{reply:`已安排${repeat==='daily'?'每日':''}提醒：${reminder.text}。时间：${stamp(reminder.dueAt,person)}（${person.timeZone}）。`,reminder};
   }
   const all=store.reminders(personId).filter(row=>recordMatchesBinding(row,store.binding(personId))),previous=all.find(row=>row.id===action.reminderId);
   if(action.type==='update_reminder'&&previous?.updateRequestIds?.includes(requestId))return{reply:`这条提醒已经修改：${previous.text}。时间：${stamp(previous.dueAt,person)}。`,reminder:previous};
   const rows=all.filter(row=>row.status==='active'||(row.status==='completed'&&store.snapshot().outbox.some(o=>o.personId===personId&&o.sourceKey.startsWith(`reminder:${row.id}:`)&&o.status==='pending')));
   const selected=matchTarget(rows,action.reminderId,text);
   if(action.type==='cancel'){explicit(text,/取消|删掉|删除|停止|不再提醒/,'取消提醒');const reminder=store.cancelReminder(personId,selected.id);return{reply:'已取消后续提醒；已经进入发送的消息无法撤回。',reminder};}
   evidence(text,action.evidence);explicit(action.evidence,/改|调整|换成|推迟|提前/,'修改提醒');object(action.patch,['text','dueAt','repeat','time']);if(!Object.keys(action.patch).length)fail('请说明具体要修改什么。');const patch=clone(action.patch);
   if(patch.text!==undefined)quoted(text,action.evidence,patch.text);
   if(patch.dueAt!==undefined){const timing=groundedTime({...patch,timeEvidence:action.timeEvidence},text,person,instant);patch.dueAt=timing.dueAt;if((patch.repeat??selected.repeat)==='daily')patch.time=timing.time;}
   else if(patch.time!==undefined||patch.repeat!==undefined||/明天|后天|今天|下午|上午|晚上|早上|\d[:：点时]|[一二两三四五六七八九十]点|周[一二三四五六日天]|星期[一二三四五六日天]|推迟|提前/.test(text))fail('修改提醒时间需要明确日期和几点，不能自行补充时间。');
   if(patch.repeat!==undefined&&(!['once','daily'].includes(patch.repeat)||(patch.repeat==='daily'&&!daily.test(text))||(patch.repeat==='once'&&!/一次|仅这次|只这次|不再每天/.test(text))))fail('重复方式必须由当前原话明确说明。');
   const reminder=store.updateReminder(personId,selected.id,patch,{requestId});return{reply:`已修改提醒：${reminder.text}。时间：${stamp(reminder.dueAt,person)}（${person.timeZone}）。`,reminder};
  },
 };
}
