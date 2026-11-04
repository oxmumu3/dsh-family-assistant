import {constants,lstatSync,realpathSync,openSync,fstatSync,readFileSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const routeKeys=['personId','accountId','peerId','generation'];
const sameRoute=(a,b)=>a&&b&&routeKeys.every(k=>a[k]===b[k]);
const validId=x=>typeof x==='string'&&/^[A-Za-z0-9._-]{1,160}$/.test(x);
const instant=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const sameFile=(a,b)=>a&&b&&['dev','ino','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);
const fields=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const fail=text=>{throw new Error(text);};
const prefix='deferred-member-notice:';
export const deferredNoticeKind='member_feature_notice';

/** Explicit Owner notices wait outside the outbox until a new member inbound.
 * One stable outbox row then owns all delivery outcomes, including uncertainty. */
export function createDeferredMemberNotices({directory,store,flush,now=()=>new Date().toISOString()}={}){
 const root=realpathSync(directory),identity=lstatSync(root),file=join(root,'deferred-member-notices.json'),active=new Set();let existed=false;
 const snapshot=()=>store.snapshot(),clock=()=>new Date(now()).toISOString();
 function inspect(optional=false){
  const parent=lstatSync(root);if(!parent.isDirectory()||parent.isSymbolicLink()||parent.dev!==identity.dev||parent.ino!==identity.ino)fail('功能通知目录已改变。');
  let info;try{info=lstatSync(file);}catch(error){if(error.code==='ENOENT'&&optional&&!existed)return null;fail('功能通知记录缺失或不可读。');}
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||(info.mode&0o077)||info.size>8*1024*1024)fail('功能通知记录不可用。');existed=true;return info;
 }
 function validate(value){
  const keys=['id','requestId','ownerId','ownerCreatedAt','personId','personCreatedAt','route','text','createdAt'];
  if(!fields(value,['version','entries'])||value.version!==1||!Array.isArray(value.entries)||value.entries.length>2000||new Set(value.entries.map(x=>x?.id)).size!==value.entries.length)fail('功能通知记录格式无效。');
  for(const e of value.entries)if(!fields(e,keys)||!validId(e.requestId)||!validId(e.ownerId)||!validId(e.personId)||!instant(e.ownerCreatedAt)||!instant(e.personCreatedAt)||!instant(e.createdAt)||!fields(e.route,routeKeys)||e.route.personId!==e.personId||!Number.isSafeInteger(e.route.generation)||e.route.generation<1||['accountId','peerId'].some(k=>typeof e.route[k]!=='string'||!e.route[k]||e.route[k].length>240)||typeof e.text!=='string'||!e.text.trim()||e.text.length>2800||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(e.text)||e.id!==hash([e.ownerId,e.ownerCreatedAt,e.requestId]))fail('功能通知记录格式无效。');
  return value.entries;
 }
 function load(){const expected=inspect(true);if(!expected)return{entries:[],stat:null};let fd;
  try{fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);if(!sameFile(expected,fstatSync(fd)))fail('功能通知记录刚有变化。');let value;try{value=JSON.parse(readFileSync(fd,'utf8'));}catch{fail('功能通知记录损坏。');}if(!sameFile(expected,fstatSync(fd))||!sameFile(expected,inspect()))fail('功能通知记录刚有变化。');return{entries:validate(value),stat:expected};}
  finally{if(fd!==undefined)closeSync(fd);}
 }
 function save(entries,expected){
  const value={version:1,entries};validate(value);const body=JSON.stringify(value);if(Buffer.byteLength(body)>8*1024*1024)fail('功能通知记录容量已满。');
  const check=()=>{const current=inspect(true);if(expected===null?current!==null:!sameFile(expected,current))fail('功能通知记录刚有变化。');};check();const temp=join(root,'.deferred-member-notice-'+randomUUID()+'.tmp');let fd;
  try{fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,body);fsyncSync(fd);closeSync(fd);fd=undefined;check();renameSync(temp,file);existed=true;const d=openSync(root,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(d);}finally{closeSync(d);}}
  finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temp);}catch{}}
 }
 function owner(){const p=snapshot().people.find(x=>x.role==='owner');if(!p)fail('请先登记 Owner。');return p;}
 function scopeCurrent(e){const s=snapshot(),p=s.people.find(x=>x.id===e.personId),o=s.people.find(x=>x.id===e.ownerId),b=s.bindings.find(x=>x.personId===e.personId);return p?.role==='elder'&&p.createdAt===e.personCreatedAt&&o?.role==='owner'&&o.createdAt===e.ownerCreatedAt&&sameRoute(b,e.route);}
 function delivery(e){return snapshot().outbox.find(x=>x.sourceKey===prefix+e.id);}
 function view(e){const row=delivery(e);return{id:e.id,personId:e.personId,requestId:e.requestId,createdAt:e.createdAt,status:row?.status??(scopeCurrent(e)?'waiting':'cancelled'),...(row?{outboxId:row.id}:{})};}
 function canDeliver(row){
  if(row.kind!==deferredNoticeKind||!row.sourceKey.startsWith(prefix))return false;
  const e=load().entries.find(x=>prefix+x.id===row.sourceKey);return Boolean(e&&active.has(e.id)&&scopeCurrent(e)&&row.personId===e.personId&&row.text===e.text&&sameRoute(row.route,e.route)&&sameRoute(row.authorizationRoute,e.route));
 }
 load();
 return Object.freeze({canDeliver,list(){owner();return{notices:load().entries.map(view)};},
  register({personId,requestId,bindingGeneration,text}={}){
   const o=owner(),s=snapshot(),p=s.people.find(x=>x.id===personId),route=store.route(personId);
   if(p?.role!=='elder'||!validId(requestId)||!Number.isSafeInteger(bindingGeneration)||route.generation!==bindingGeneration||typeof text!=='string'||!text.trim()||text.length>2800)fail('补发通知的家人、绑定或内容无效。');
   const loaded=load(),id=hash([o.id,o.createdAt,requestId]),previous=loaded.entries.find(x=>x.id===id);
   if(previous){if(previous.personId!==personId||previous.personCreatedAt!==p.createdAt||previous.text!==text||!sameRoute(previous.route,route))fail('同一通知请求已对应其他内容或绑定。');return view(previous);}
   const entry={id,requestId,ownerId:o.id,ownerCreatedAt:o.createdAt,personId,personCreatedAt:p.createdAt,route,text,createdAt:clock()};save([...loaded.entries,entry],loaded.stat);return view(entry);
  },
  async onInbound({personId,route,message}){
   const s=snapshot();if(s.config.paused||!sameRoute(s.bindings.find(x=>x.personId===personId),route))return;
   const inbound=s.messages.find(x=>x.personId===personId&&x.dir==='in'&&x.id===message.id&&x.bindingGeneration===route.generation);if(!inbound)return;
   for(const e of load().entries.filter(x=>x.personId===personId)){
    if(!scopeCurrent(e)||Date.parse(inbound.at)<Date.parse(e.createdAt)||Date.parse(inbound.at)>Date.parse(clock())+300000)continue;
    let row=delivery(e);if(row&&row.status!=='pending')continue;
    active.add(e.id);
    try{if(!row)row=store.enqueue({personId,text:e.text,kind:deferredNoticeKind,sourceKey:prefix+e.id,authorizationRoute:e.route});await flush(personId,{onlyId:row.id,authorize:()=>canDeliver(row)});}
    finally{active.delete(e.id);}
   }
  },
 });
}
