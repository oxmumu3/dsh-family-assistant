import{dismissesDiaryConversation}from'./diary-invitations.mjs';
import {mkdirSync,lstatSync,realpathSync,openSync,readFileSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync,fstatSync,fchmodSync,constants} from 'node:fs';
import {resolve,join,parse} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {timestamp,validTimeZone} from './store.mjs';
import {localDate,validDate,addLocalDays} from './brief.mjs';
import {searchTerms,scoreRecord} from './library-search.mjs';

const MAX_BYTES=32*1024*1024,MAX_ENTRIES=10000,MAX_OPERATIONS=20000,MAX_REVISIONS=200;
const kinds=['diary','fact','preference','task','file'],routeKeys=['personId','accountId','peerId','generation'];
const clone=value=>structuredClone(value),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value)));
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,80}$/u.test(value);
const bounded=(value,max=24000)=>typeof value==='string'&&Boolean(value.trim())&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)&&Buffer.from(value).toString('utf8')===value;
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const canonical=value=>JSON.stringify(value,(_key,item)=>plain(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
function fail(code,message){throw Object.assign(new Error(message),{code});}
function fields(value,allowed,required=[]){if(!plain(value)||Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key)))fail('invalid_argument','个人资料库参数无效。');}
function string(value,max=24000){if(!bounded(value,max))fail('invalid_argument','个人资料库文字无效。');return value;}
function date(value){try{return validDate(value);}catch{fail('invalid_argument','日期无效，请使用真实的 YYYY-MM-DD 日期。');}}
function source(value){
 try{fields(value,['id','at','text','providedBy'],['id','at','text']);string(value.id,512);string(value.text);if(value.providedBy!==undefined&&!['member','owner'].includes(value.providedBy))throw Error();return{id:value.id,at:timestamp(value.at),text:value.text,providedBy:value.providedBy??'member'};}
 catch{fail('invalid_source','没有有效的原始消息来源，尚未保存。');}
}
function unquoted(value){return value.replace(/```[\s\S]*?```|`[^`\n]*`|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/gu,' ');}
function realDirective(value){const text=unquoted(value);return !/(?:如果|假如|假设|比如|例如|举例|设想|要是)/u.test(text);}
function diaryIntent(value,active){
 const text=unquoted(value),explicit=/(?:记|写|补|保存).{0,8}日记|日记\s*[:：]/u.test(text);
 if(!realDirective(value)||/(?:不要|别|不用|先不|不想|不必|无需).{0,14}(?:记|写|保存|日记)|^(?:转发|转述|听说|有人说)/u.test(text))return false;
 if(explicit)return true;
 if(dismissesDiaryConversation(text))return false;
 // Context and a native tool choice allow natural narratives, but neither can
 // reclassify a question or unrelated instruction as the member's experience.
 return !/[？?]|(?:怎么|如何|什么|为什么|能不能|可不可以|是否|吗[。！!\s]*$)|^(?:请|帮我|给我|查|查一下)/u.test(text);
}
function grounded(content,original){
 if(!bounded(content))return false;let start=original.indexOf(content);
 while(start>=0){const prefix=original.slice(0,start).split(/[，,。；;！？?!\n]/u).at(-1)??'';if(!/(?:不|没|未|别|并非|否认|无需)[^，,。；;！？?!\n]{0,8}$/u.test(prefix))return true;start=original.indexOf(content,start+1);}return false;
}
function futureIntent(value){return realDirective(value)&&!/(?:不要|别|不用|先不|不想|不必|无需).{0,14}(?:记住|保存|偏好)/u.test(unquoted(value))&&/(?:以后|今后|往后|从现在起|从今天起|每天|每日)/u.test(unquoted(value));}
function completionConfirmed(value){
 const speech=unquoted(value).replace(/'[^'\n]*'/gu,' ');
 return speech.split(/[，,。；;！？?!\n]/u).some(clause=>{
  for(const match of clause.matchAll(/已完成|已经完成|完成了|已做完|已经做完|做完了|办好了/gu))if(!/(?:不|没|未|别|并非|否认|尚未|还没|没有|不是|不算)[^，,。；;！？?!\n]{0,20}$/u.test(clause.slice(0,match.index)))return true;
  return false;
 });
}
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
function chain(path,{create=false,privateFrom}={}){
 let current=parse(path).root;const rows=[];
 for(const part of path.slice(current.length).split('/').filter(Boolean)){
  current=join(current,part);if(create)try{mkdirSync(current,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  let stat;try{stat=lstatSync(current);}catch{fail('unsafe_storage','个人资料库目录缺失或无法检查。');}
  if(!stat.isDirectory()||stat.isSymbolicLink()||privateFrom&&(current===privateFrom||current.startsWith(privateFrom+'/'))&&(stat.mode&0o077))fail('unsafe_storage','个人资料库目录必须是私有的普通目录。');
  rows.push({path:current,stat});
 }
 if(realpathSync(path)!==path)fail('unsafe_storage','个人资料库路径不能经过链接。');return rows;
}
function unchanged(before,after){return before.length===after.length&&before.every((row,i)=>row.path===after[i].path&&same(row.stat,after[i].stat));}
function statOrNull(path){try{return lstatSync(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
const schema=(properties={},required=[])=>({type:'object',additionalProperties:false,properties,...(required.length?{required}:{})});
const s=maxLength=>({type:'string',maxLength,minLength:1});

/** Private, current-binding member records. Owner access must be authenticated by
 * the caller and still uses the selected member's current route. No filesystem
 * contents outside this module's own private library are scanned or indexed. */
export function createMemberLibrary({directory,store,now=()=>new Date().toISOString()}={}){
 if(!bounded(directory,4096)||typeof store?.snapshot!=='function'||typeof now!=='function')fail('invalid_argument','个人资料库配置无效。');
 const base=resolve(directory),baseIdentity=chain(base,{create:true}),libraries=join(base,'member-libraries'),identities=new Map(),initialized=new Set();
 const clock=()=>{const value=now();return timestamp(value instanceof Date?value.toISOString():value);};
 function scope(personId,route){
  if(!id(personId))fail('invalid_argument','成员标识无效。');
  fields(route,routeKeys,routeKeys);if(route.personId!==personId||!bounded(route.accountId,200)||!bounded(route.peerId,200)||!Number.isSafeInteger(route.generation)||route.generation<1)fail('authorization_changed','当前成员或微信绑定已经改变。');
  const state=store.snapshot(),person=state?.people?.find(row=>row.id===personId),binding=state?.bindings?.find(row=>row.personId===personId);
  if(!person||!binding||!routeKeys.every(key=>binding[key]===route[key]))fail('authorization_changed','当前成员或微信绑定已经改变，未返回个人内容。');
  validTimeZone(person.timeZone);const bindingHash=hash([personId,person.createdAt??null,route.accountId,route.peerId,route.generation]);
  return{personId,person:clone(person),route:clone(route),bindingHash,root:join(libraries,personId,bindingHash)};
 }
 function authorizeNow(input){if(input.authorize!==undefined){let result;try{result=input.authorize();}catch{}if(result!==true)fail('authorization_changed','当前授权已经改变，尚未保存。');}}
 function storage(sc){
  if(!unchanged(baseIdentity,chain(base)))fail('unsafe_storage','个人资料库根目录发生变化。');
  const rows=chain(sc.root,{create:true,privateFrom:libraries}),previous=identities.get(sc.root);if(previous&&!unchanged(previous,rows))fail('unsafe_storage','个人资料库目录发生变化。');identities.set(sc.root,rows);return rows;
 }
 function secure(sc,optional=false){
  const before=storage(sc),file=join(sc.root,'library.json'),stat=statOrNull(file);
  if(!stat){if(optional)return{before,file,stat:null};fail('invalid_storage','个人资料库文件缺失，请保留现状后检查。');}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o077)!==0)fail('unsafe_storage','个人资料库文件必须是私有普通文件，不能是链接。');
  if(stat.size>MAX_BYTES)fail('storage_full','个人资料库达到容量上限，请先导出整理。');return{before,file,stat};
 }
 function validate(value,sc){
  try{
   fields(value,['version','personId','bindingHash','entries','operations'],['version','personId','bindingHash','entries','operations']);
   if(value.version!==1||value.personId!==sc.personId||value.bindingHash!==sc.bindingHash||!Array.isArray(value.entries)||!Array.isArray(value.operations)||value.entries.length>MAX_ENTRIES||value.operations.length>MAX_OPERATIONS)throw Error();
   const ids=new Set(),ops=new Set(),sources=new Map();
   for(const entry of value.entries){
    fields(entry,['id','kind','date','datePrecision','eventDateLabel','recordedDate','revision','status','text','originalText','sources','revisions','createdAt','updatedAt','key','file'],['id','kind','date','datePrecision','recordedDate','revision','status','createdAt','updatedAt']);
    if(!/^entry-[a-f0-9]{48}$/u.test(entry.id)||ids.has(entry.id)||!kinds.includes(entry.kind)||!['day','month','year','unknown'].includes(entry.datePrecision)||!Number.isSafeInteger(entry.revision)||entry.revision<1||!['active','planned','in_progress','completed','deleted'].includes(entry.status))throw Error();
    ids.add(entry.id);date(entry.recordedDate);if(entry.datePrecision==='day')date(entry.date);else if(entry.date!==null)throw Error();if(entry.eventDateLabel!==undefined)string(entry.eventDateLabel,200);timestamp(entry.createdAt);timestamp(entry.updatedAt);if(entry.key!==undefined)string(entry.key,160);
    if(entry.status==='deleted'){if(['text','originalText','sources','revisions','file'].some(key=>Object.hasOwn(entry,key)))throw Error();continue;}
    string(entry.text);string(entry.originalText);if(!Array.isArray(entry.sources)||!entry.sources.length||entry.sources.length>MAX_REVISIONS||!Array.isArray(entry.revisions)||entry.revisions.length!==entry.revision||entry.revisions.length>MAX_REVISIONS)throw Error();
    for(const item of entry.sources){const src=source(item);if(hash(src)!==hash(item))throw Error();const prior=sources.get(src.id);if(prior&&prior!==hash(src))throw Error();sources.set(src.id,hash(src));}
    if(entry.originalText!==entry.sources[0].text)throw Error();
    for(let i=0;i<entry.revisions.length;i++){const revision=entry.revisions[i];fields(revision,['revision','text','sourceId','at','oldText','newText'],['revision','text','sourceId','at']);if(revision.revision!==i+1)throw Error();const src=entry.sources.find(item=>item.id===revision.sourceId);if(!src)throw Error();if(revision.oldText!==undefined||revision.newText!==undefined){string(revision.oldText);string(revision.newText);if(!i||!entry.revisions[i-1].text.includes(revision.oldText)||!src.text.includes(revision.newText)||entry.revisions[i-1].text.replace(revision.oldText,revision.newText)!==revision.text)throw Error();}else if(!src.text.includes(revision.text))throw Error();string(revision.text);timestamp(revision.at);}
    if(entry.revisions.at(-1).text!==entry.text)throw Error();
    if(entry.kind==='file')validFile(entry.file);else if(entry.file!==undefined)throw Error();
   }
   for(const op of value.operations){fields(op,['requestId','fingerprint','entryId','type','sourceId','sourceHash'],['requestId','fingerprint','entryId','type','sourceId','sourceHash']);string(op.requestId,512);string(op.sourceId,512);if(ops.has(op.requestId)||!hex(op.fingerprint)||!hex(op.sourceHash)||!ids.has(op.entryId)||!['append','remember','update','delete'].includes(op.type))throw Error();ops.add(op.requestId);const prior=sources.get(op.sourceId);if(prior&&prior!==op.sourceHash)throw Error();sources.set(op.sourceId,op.sourceHash);}
   return value;
  }catch{fail('invalid_storage','个人资料库格式或版本无效，请保留原文件后检查。');}
 }
 function load(sc){
  const checked=secure(sc,true);
  if(!checked.stat){if(initialized.has(sc.root))fail('invalid_storage','个人资料库文件缺失，未自动重建。');const value={version:1,personId:sc.personId,bindingHash:sc.bindingHash,entries:[],operations:[]};persist(sc,value,null);initialized.add(sc.root);return{value,stat:lstatSync(checked.file)};}
  let fd;try{
   fd=openSync(checked.file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const opened=fstatSync(fd);if(!same(opened,checked.stat)||!opened.isFile()||opened.nlink!==1||opened.size>MAX_BYTES)fail('unsafe_storage','个人资料库读取时发生变化。');
   let value;try{value=JSON.parse(readFileSync(fd,'utf8'));}catch{fail('invalid_storage','个人资料库无法解析，请保留原文件后检查。');}
   const after=fstatSync(fd),live=lstatSync(checked.file);if(!same(opened,live)||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||!unchanged(checked.before,storage(sc)))fail('unsafe_storage','个人资料库读取时发生变化。');
   initialized.add(sc.root);return{value:validate(value,sc),stat:after};
  }finally{if(fd!==undefined)closeSync(fd);}
 }
 function persist(sc,value,expected){
  validate(value,sc);const bytes=JSON.stringify(value)+'\n';if(Buffer.byteLength(bytes)>MAX_BYTES)fail('storage_full','个人资料库达到容量上限，请先导出整理。');
  const checked=secure(sc,expected===null),temp=join(sc.root,'.library-'+randomUUID()+'.tmp');let fd;
  const check=()=>{const live=secure(sc,expected===null).stat;if(expected===null?live!==null:!live||!same(expected,live)||expected.size!==live.size||expected.mtimeMs!==live.mtimeMs)fail('revision_conflict','个人资料库刚有变化，请重新读取后再修改。');};
  check();try{
   fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);fchmodSync(fd,0o600);writeFileSync(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;
   if(!unchanged(checked.before,storage(sc)))fail('unsafe_storage','个人资料库写入目录发生变化。');scope(sc.personId,sc.route);check();renameSync(temp,checked.file);
   const directoryFd=openSync(sc.root,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(directoryFd);}finally{closeSync(directoryFd);}
  }finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temp);}catch{}}
 }
 function validFile(value){fields(value,['name','sha256'],['name','sha256']);if(!bounded(value.name,160)||value.name.startsWith('.')||/[\/\\:\x00-\x1f\x7f]/u.test(value.name)||!hex(value.sha256))fail('invalid_argument','资料文件索引无效。');return value;}
 function resolvedDate(value,sc,at=clock()){
  const today=localDate(at,sc.person.timeZone);if(value===undefined)return{date:null};
  if(['today','今天','今日'].includes(value))return{date:today};
  if(['yesterday','昨天','昨日'].includes(value))return{date:addLocalDays(today,-1)};
  if(['day-before-yesterday','前天'].includes(value))return{date:addLocalDays(today,-2)};
  if(['week-ago','上周的今天','上周今天'].includes(value))return{date:addLocalDays(today,-7)};
  if(['year-ago','去年的今天','去年今天'].includes(value)){const previous=String(Number(today.slice(0,4))-1).padStart(4,'0')+today.slice(4);try{return{date:date(previous)};}catch{return{date:previous,notice:`上一年没有 ${today.slice(5)} 这一天，没有改查相邻日期。`};}}
  return{date:date(value)};
 }
 function write(type,input){
  const allowed=['personId','route','requestId','text','source','date','datePrecision','eventDateLabel','authorize','id','expectedRevision','kind','key','status','file','oldText','newText'];fields(input,allowed,['personId','route','requestId','source']);
  const sc=scope(input.personId,input.route);authorizeNow(input);string(input.requestId,512);const src=source(input.source);
  let patch=type==='update'&&(input.oldText!==undefined||input.newText!==undefined),oldFragment=input.oldText,newFragment=input.newText;
  const verifyFullText=type==='update'&&!patch&&bounded(input.text)&&!grounded(input.text,src.text);
  if(patch){string(input.oldText);string(input.newText);if(input.text!==undefined||!grounded(input.newText,src.text))fail('ungrounded_content','修正内容必须逐字来自当前原话，且不能省略否定。');}
  else if(type!=='delete'){string(input.text);if(!verifyFullText&&!grounded(input.text,src.text))fail('ungrounded_content','保存的内容必须逐字来自本人或 Owner 本次原话，且不能省略否定。');}
  const loaded=load(sc),state=loaded.value,fingerprint=hash(canonical([type,Object.fromEntries(Object.entries(input).filter(([key])=>!['authorize','requestId','route','personId'].includes(key))),src])),op=state.operations.find(row=>row.requestId===input.requestId);
  if(op){if(op.fingerprint!==fingerprint)fail('request_conflict','同一请求已经对应另一项内容，未重复保存。');return{entry:clone(state.entries.find(row=>row.id===op.entryId)),replayed:true};}
  if(type==='append'){const previous=state.operations.find(row=>row.type==='append'&&row.sourceId===src.id);if(previous){if(previous.fingerprint!==fingerprint)fail('request_conflict','这条原始消息已经保存，不能按不同内容再次记入。');return{entry:clone(state.entries.find(row=>row.id===previous.entryId)),replayed:true};}}
  if(state.operations.some(row=>row.sourceId===src.id&&row.sourceHash!==hash(src)))fail('source_conflict','原始消息的文字或时间不能被后续操作改写。');
  if(type==='remember'){const deleted=state.operations.filter(row=>row.type==='remember'&&row.sourceId===src.id).map(row=>state.entries.find(entry=>entry.id===row.entryId)).find(entry=>entry?.status==='deleted');if(deleted)return{entry:clone(deleted),replayed:true};}
  if(state.operations.length>=MAX_OPERATIONS)fail('storage_full','个人资料库请求账本达到容量上限，请先导出整理。');
  let entry;const at=clock();
  if(type==='append'||type==='remember'){
   const kind=type==='append'?'diary':input.kind;if(!kinds.includes(kind)||type==='remember'&&kind==='diary')fail('invalid_argument','资料类型无效。');
   if(kind==='preference'&&!futureIntent(src.text))fail('invalid_intent','一次修改不作为长期偏好保存，请明确以后要怎样。');
   if(input.key!==undefined)string(input.key,160);if(input.file!==undefined)validFile(input.file);if(kind==='file'&&!input.file||kind!=='file'&&input.file!==undefined)fail('invalid_argument','本人文件索引需要准确文件名和版本。');
   if(input.status!==undefined&&!['active','planned','in_progress','completed'].includes(input.status)||kind!=='task'&&input.status!==undefined&&input.status!=='active')fail('invalid_argument','事项状态无效。');
   const precision=input.datePrecision??'day';if(!['day','month','year','unknown'].includes(precision))fail('invalid_argument','事件日期精度无效。');
   const event=precision==='day'?resolvedDate(input.date??'today',sc,src.at):{date:null};if(event.notice)fail('invalid_argument',event.notice);if(precision!=='day'&&input.date!==undefined)fail('invalid_argument','不确定的事件日期不能填写精确日期。');if(precision!=='day'&&input.eventDateLabel!==undefined){string(input.eventDateLabel,200);if(!src.text.includes(input.eventDateLabel))fail('ungrounded_content','事件日期描述必须来自原话，不能补造。');}
   if(input.key&&kind!=='diary')entry=state.entries.find(row=>row.kind===kind&&row.key===input.key&&row.status!=='deleted');
   if(!entry){if(state.entries.length>=MAX_ENTRIES)fail('storage_full','个人资料库达到一万条容量上限，请先导出整理。');entry={id:'entry-'+hash([sc.bindingHash,input.requestId]).slice(0,48),kind,date:event.date,datePrecision:precision,...(precision!=='day'&&input.eventDateLabel?{eventDateLabel:input.eventDateLabel}:{}),recordedDate:localDate(src.at,sc.person.timeZone),revision:0,status:kind==='task'?(input.status??'planned'):'active',text:input.text,originalText:src.text,sources:[],revisions:[],createdAt:at,updatedAt:at,...(input.key?{key:input.key}:{}),...(input.file?{file:clone(input.file)}:{})};state.entries.push(entry);}
   if(kind==='task')entry.status=input.status??'planned';if(kind==='file')entry.file=clone(input.file);
  }else{
   if(!/^entry-[a-f0-9]{48}$/u.test(input.id??'')||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1)fail('invalid_argument','请先读取要修改的记录及版本。');
   entry=state.entries.find(row=>row.id===input.id&&row.status!=='deleted');if(!entry)fail('not_found','没有找到这条有效记录。');if(entry.revision!==input.expectedRevision)fail('revision_conflict','这条记录刚有变化，请重新读取后再修改。');
  }
  if(verifyFullText){
   // A model may return the exact old body with one corrected name/place.
   // Prove that single substitution instead of trusting an ungrounded rewrite.
   const prior=Array.from(entry.text),next=Array.from(input.text);let prefix=0,suffix=0;
   while(prefix<prior.length&&prefix<next.length&&prior[prefix]===next[prefix])prefix++;
   while(suffix<prior.length-prefix&&suffix<next.length-prefix&&prior[prior.length-1-suffix]===next[next.length-1-suffix])suffix++;
   oldFragment=prior.slice(prefix,prior.length-suffix).join('');newFragment=next.slice(prefix,next.length-suffix).join('');
   if(!bounded(oldFragment)||!bounded(newFragment)||!src.text.includes(oldFragment)||!grounded(newFragment,src.text)||entry.text.indexOf(oldFragment)!==entry.text.lastIndexOf(oldFragment)||entry.text.replace(oldFragment,newFragment)!==input.text)fail('ungrounded_content','只能根据本次纠正原话替换准确的一处内容，其他事实不能改写或补造。');
   patch=true;
  }
  if(type==='delete'){entry.status='deleted';entry.revision++;for(const key of ['text','originalText','sources','revisions','file'])delete entry[key];}
  else{
   if(entry.revision>=MAX_REVISIONS)fail('storage_full','这条记录修订次数达到上限，请另存新记录。');if(patch&&!entry.text.includes(oldFragment))fail('revision_conflict','没有找到要替换的原文，请重新读取后再修改。');entry.revision++;entry.text=patch?entry.text.replace(oldFragment,newFragment):input.text;if(!entry.sources.some(row=>row.id===src.id))entry.sources.push(src);entry.revisions.push({revision:entry.revision,text:entry.text,sourceId:src.id,at,...(patch?{oldText:oldFragment,newText:newFragment}:{})});
  }
  entry.updatedAt=at;state.operations.push({requestId:input.requestId,fingerprint,entryId:entry.id,type,sourceId:src.id,sourceHash:hash(src)});authorizeNow(input);scope(input.personId,input.route);persist(sc,state,loaded.stat);return{entry:clone(entry),replayed:false};
 }
 function query(input={}){
  fields(input,['personId','route','query','date','from','to','kind','before','limit'],['personId','route']);const sc=scope(input.personId,input.route),resolved=resolvedDate(input.date,sc);
  if(input.query!==undefined)string(input.query,500);if(input.kind!==undefined&&!kinds.includes(input.kind))fail('invalid_argument','资料类型无效。');if(input.from!==undefined)date(input.from);if(input.to!==undefined)date(input.to);if(input.from&&input.to&&input.from>input.to)fail('invalid_argument','日期范围无效。');
  const limit=input.limit??30;if(!Number.isSafeInteger(limit)||limit<1||limit>200)fail('invalid_argument','每页请读取 1 到 200 条记录。');if(input.before!==undefined&&!/^entry-[a-f0-9]{48}$/u.test(input.before))fail('invalid_argument','分页位置无效。');
  const terms=searchTerms(input.query??'').filter(term=>!(input.kind==='diary'&&term==='日记')),search=terms.join(' ');
  const {value}=load(sc);let entries=value.entries.filter(row=>row.status!=='deleted'&&(!input.kind||row.kind===input.kind)&&(!resolved.date||row.date===resolved.date)&&(!input.from||row.date&&row.date>=input.from)&&(!input.to||row.date&&row.date<=input.to)).reverse();
  if(terms.length)entries=entries.map(row=>({row,score:scoreRecord([row.text,row.eventDateLabel].filter(Boolean).join('\n'),search)})).filter(item=>item.score>0).sort((a,b)=>b.score-a.score).map(item=>item.row);
  if(input.before){const index=entries.findIndex(row=>row.id===input.before);if(index<0)fail('invalid_argument','分页位置已经变化，请重新查询。');entries=entries.slice(index+1);}
  if(resolved.notice)entries=[];const selected=entries.slice(0,limit);scope(input.personId,input.route);return{entries:clone(selected),nextBefore:entries.length>limit?selected.at(-1).id:null,...(resolved.date?{date:resolved.date}:{}),...(resolved.notice?{notice:resolved.notice}:{})};
 }
 function context(input){
  fields(input,['personId','route','text'],['personId','route']);if(input.text!==undefined)string(input.text);const sc=scope(input.personId,input.route),rows=load(sc).value.entries.filter(row=>row.status!=='deleted').reverse();
  const text=input.text??'',shortTerms=[];
  for(const match of text.matchAll(/[\p{Script=Han}]{2,}/gu)){const characters=Array.from(match[0]);for(let i=0;i<characters.length-1;i++)shortTerms.push(characters[i]+characters[i+1]);}
  const shortQuery=[...new Set(shortTerms)].join(' '),related=rows.map(row=>({row,score:4*scoreRecord(row.text,text)+scoreRecord(row.text,shortQuery)})).filter(item=>item.score>0).sort((a,b)=>b.score-a.score).map(item=>item.row);
  const candidates=[...related,...rows.filter(row=>row.kind!=='diary'),...rows.filter(row=>row.kind==='diary').slice(0,1)],entries=[],seen=new Set();
  const resultFor=selected=>({entries:selected,text:selected.map(row=>`[${row.kind} ${row.date??row.recordedDate} ${row.id} v${row.revision}; 来源 ${row.sources.map(src=>`${src.id} ${src.at}`).join(', ')}] ${row.text}`).join('\n')});
  for(const row of candidates){if(seen.has(row.id))continue;const excerpt={id:row.id,kind:row.kind,date:row.date,datePrecision:row.datePrecision,recordedDate:row.recordedDate,revision:row.revision,status:row.status,text:row.text.slice(0,500),sources:row.sources.slice(-1).map(src=>({id:src.id,at:src.at,providedBy:src.providedBy})),...(row.file?{file:row.file}:{}),...(row.key?{key:row.key}:{})};if(entries.length>=12||Buffer.byteLength(JSON.stringify(resultFor([...entries,excerpt])))>16000)continue;entries.push(excerpt);seen.add(row.id);}
  scope(input.personId,input.route);return clone(resultFor(entries));
 }
 function tools({person,route,message,text,authorize}={}){
  const sc=scope(person?.id,route);string(text);if(!plain(message)||!bounded(message.id,512))fail('invalid_source','没有当前原始消息，未提供资料库工具。');const src=source({id:message.id,at:message.at,text}),captured=clone({personId:sc.personId,route:sc.route,source:src});
  const proposals=new Map(),correctable=new Set(['invalid_argument','invalid_intent','ungrounded_content','revision_conflict','not_found']);let correctionCount=0;
  async function guard(ctx={}){ctx.signal?.throwIfAborted();for(const check of [authorize,ctx.authorize])if(typeof check==='function'&&await check()!==true)fail('authorization_changed','当前授权或微信绑定已改变。');if(typeof authorize!=='function')fail('authorization_changed','缺少当前资料库授权。');ctx.signal?.throwIfAborted();scope(captured.personId,captured.route);const current=store.snapshot();if(current.config?.paused===true||current.bindings.find(row=>row.personId===captured.personId)?.status!=='connected')fail('authorization_changed','当前家庭服务已暂停或微信通路未连接。');}
  const dates={date:s(40),datePrecision:{type:'string',enum:['day','month','year','unknown']},eventDateLabel:s(200)};
  function eventArgs(args){
   if(args.datePrecision&&args.datePrecision!=='day')return args;
   const candidates=[];
   for(const match of text.matchAll(/\d{4}-\d{2}-\d{2}/gu))candidates.push(date(match[0]));
   for(const match of text.matchAll(/(\d{4})年(\d{1,2})月(\d{1,2})[日号]/gu))candidates.push(date(`${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`));
   const relative=/去年的今天|去年今天/u.test(text)?'year-ago':/上周的今天|上周今天/u.test(text)?'week-ago':/前天/u.test(text)?'day-before-yesterday':/昨天|昨日/u.test(text)?'yesterday':/今天|今日/u.test(text)?'today':null;
   if(relative){const result=resolvedDate(relative,sc,src.at);if(result.notice)fail('invalid_argument',result.notice);candidates.push(result.date);}
   if(!candidates.length)candidates.push(localDate(src.at,sc.person.timeZone));
   const selected=args.date===undefined?candidates[0]:resolvedDate(args.date,sc,src.at).date;
   if(!candidates.includes(selected))fail('ungrounded_content','事件日期需要有原话依据，不能替本人猜一个日期。');
   return{...args,date:selected};
  }
  function compactEntry(entry){
   if(entry.status==='deleted')return entry;const {originalText,revisions,sources,...rest}=entry,result={...rest,text:entry.text.slice(0,6000),sources:sources.slice(-3).map(({id,at,providedBy})=>({id,at,providedBy})),...(entry.text.length>6000?{truncated:true}:{})};
   while(Buffer.byteLength(JSON.stringify(result))>22000){result.text=result.text.slice(0,Math.floor(result.text.length/2));result.truncated=true;}return result;
  }
  function boundedResult(result){
   if(Buffer.byteLength(JSON.stringify(result))<=24000)return result;
   if(result.entry)return{...result,entry:compactEntry(result.entry)};
   const selected=[],output={...result,entries:selected};
   for(const entry of result.entries??[]){const projected=compactEntry(entry);if(Buffer.byteLength(JSON.stringify({...output,entries:[...selected,projected]}))>23000){output.nextBefore=selected.at(-1)?.id??result.nextBefore;break;}selected.push(projected);}
   return output;
  }
  function descriptor(name,description,properties,required,operation){return{name,description,parameters:schema(properties,required),async execute(args,ctx={}){
   await guard(ctx);const proposalKey=canonical([name,args]);if(proposals.has(proposalKey))return clone(proposals.get(proposalKey));
   try{fields(args,Object.keys(properties),required);const requestId='library-'+hash([src.id,name,args.id??null,args.kind??null,args.key??null]);const result=boundedResult(operation(args,requestId));await guard(ctx);return result;}
   catch(error){
    // These codes are emitted before a record commit. Source/request conflicts,
    // authorization changes and I/O/unknown outcomes are never retried here.
    if(!correctable.has(error?.code))throw error;
    if(correctionCount>=2)return{status:'failed',code:'correction_budget',message:'本轮参数仍未核对好，尚未完成这项修改。请先查准原记录，再明确一处原词和正确的新词。'};
    correctionCount++;const result={status:'needs_correction',code:error.code,message:name==='member_library_update'?'尚未修改；先读准 id 和 revision。oldText 只传要改的最短原词，newText 只传当前纠正原话里的最短新词，不要整段改写。':`这项操作尚未修改记录：${String(error.message).slice(0,180)}。请核对当前原话及查询返回的记录、版本和参数后再调用。`};proposals.set(proposalKey,result);return clone(result);
   }
  }};}
  return[
   descriptor('member_diary_append','本人讲述实际经历、想法或日记邀请/续写时保存，不要求每次说日记。普通问答、转发和假设不归为本人经历。text逐字取自本次原话，不改写、不虚构；默认只传text，省略无必要的可选字段；有明确补记日期才传date，日期不确定时才传datePrecision和原话eventDateLabel。无工具成功结果不得说已记下。',{text:s(24000),...dates},['text'],(args,requestId)=>{if(!diaryIntent(text,message.diaryContext))fail('invalid_intent','这段话还没有明确要记入日记，请先自然确认。');const result=write('append',{...captured,...eventArgs(args),requestId});return{status:'completed',text:`已记在${result.entry.date??result.entry.eventDateLabel??'日期未定'}的日记里了。`,...result};}),
   descriptor('member_library_query','查询本人已保存日记、事实、长期偏好、事项和文件索引。日期支持今天、昨天、上周的今天、去年的今天；无结果如实说明。',{query:s(500),date:s(40),from:s(10),to:s(10),kind:{type:'string',enum:kinds},before:s(80),limit:{type:'integer',minimum:1,maximum:200}},[],args=>{const result=query({personId:captured.personId,route:captured.route,...args});return{status:'completed',text:result.notice??(result.entries.length?'已找到本人保存的记录。':'没有找到对应的记录。'),...result};}),
   descriptor('member_library_update','用户明确纠正时先查询id和revision，优先只传最短oldText/newText词组（如公园→菜市场），新词逐字来自当前原话，旧词准确匹配原文；不要把整段正文塞进oldText/newText。也可给text替换全文，但只能逐字当前原话或一处可验证替换。needs_correction表示尚未修改，可按提示修正参数，最多两次；保留完整原话及修订。',{id:s(80),expectedRevision:{type:'integer',minimum:1},text:s(24000),oldText:s(24000),newText:s(24000)},['id','expectedRevision'],(args,requestId)=>{if(!realDirective(text)||!/(?:不是|纠正|改成|改为|修改|记错|说错|应是|应该是)/u.test(unquoted(text)))fail('invalid_intent','尚未确认要修改哪条记录。');return{status:'completed',text:'这条记录已修改，原话和修订来源已保留。',...write('update',{...captured,...args,requestId})};}),
   descriptor('member_library_delete','仅用户明确删除或这段别记了时，先查询准确id和revision，再删除有效记录。已有聊天不会因此撤回。',{id:s(80),expectedRevision:{type:'integer',minimum:1}},['id','expectedRevision'],(args,requestId)=>{if(!realDirective(text)||!/(?:删除|删掉|忘掉|不再记|别记|不要记|清除)/u.test(unquoted(text)))fail('invalid_intent','尚未明确要删除这条记录。');return{status:'completed',text:'已删除这条有效记录，原来的聊天消息不会因此撤回。',...write('delete',{...captured,...args,requestId})};}),
   descriptor('member_library_remember','保存本人明确提供的事实、以后生效的服务偏好与当前事项。text必须逐字来自当前消息；一次改稿不是长期偏好，想做不是完成，否定或引用完成不算本人确认。本人文件继续使用已有文件读写工具。',{kind:{type:'string',enum:['fact','preference','task']},text:s(24000),key:s(160),status:{type:'string',enum:['active','planned','in_progress','completed']}},['kind','text'],(args,requestId)=>{if(!['fact','preference','task'].includes(args.kind))fail('invalid_argument','此工具只保存本人事实、偏好和事项，不能证明文件已经存在。');if(!realDirective(text))fail('invalid_intent','假设和举例不保存为本人事实。');if(args.kind==='task'&&args.status==='completed'&&!completionConfirmed(text))fail('invalid_intent','尚未确认本人已完成，否定、引用或计划不能记成已经完成。');return{status:'completed',text:'这条本人资料已保存，可随时查回或纠正。',...write('remember',{...captured,...args,requestId})};}),
  ];
 }
 return Object.freeze({query,context,tools,append:input=>write('append',input),remember:input=>write('remember',input),update:input=>write('update',input),delete:input=>write('delete',input)});
}
