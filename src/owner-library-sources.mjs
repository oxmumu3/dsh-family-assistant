import {constants,lstatSync,realpathSync,openSync,fstatSync,readFileSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const MAX_ENTRIES=20000,MAX_BYTES=8*1024*1024;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same=(a,b)=>a&&b&&a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
const instant=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fields=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=message=>{throw new Error(message);};

/** Owner-only provenance metadata: persist a request's first timestamp before
 * its library mutation. No message bodies, routes or credentials are stored. */
export function createOwnerLibrarySources({directory,now=()=>new Date().toISOString()}={}){
 const root=realpathSync(directory),identity=lstatSync(root),file=join(root,'.owner-library-sources.json');let existed=false;
 function inspect(optional=false){
  const parent=lstatSync(root);if(!parent.isDirectory()||parent.isSymbolicLink()||parent.dev!==identity.dev||parent.ino!==identity.ino)fail('Owner 资料修改来源目录已改变，未执行。');
  let stat;try{stat=lstatSync(file);}catch(error){if(error.code==='ENOENT'&&optional&&!existed)return null;fail('Owner 资料修改来源记录缺失或不可读，未执行。');}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o077)||stat.size>MAX_BYTES)fail('Owner 资料修改来源记录不可用，未执行。');existed=true;return stat;
 }
 function load(){
  const expected=inspect(true);if(!expected)return{entries:[],stat:null};let fd;
  try{fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);if(!same(expected,fstatSync(fd)))fail('Owner 资料修改来源记录刚有变化，未执行。');let value;try{value=JSON.parse(readFileSync(fd,'utf8'));}catch{fail('Owner 资料修改来源记录损坏，未执行。');}
   if(!same(expected,fstatSync(fd))||!same(expected,inspect()))fail('Owner 资料修改来源记录刚有变化，未执行。');
   if(!fields(value,['version','entries'])||value.version!==1||!Array.isArray(value.entries)||value.entries.length>MAX_ENTRIES||value.entries.some(row=>!fields(row,['key','fingerprint','at'])||!hex(row.key)||!hex(row.fingerprint)||!instant(row.at))||new Set(value.entries.map(row=>row.key)).size!==value.entries.length)fail('Owner 资料修改来源记录格式无效，未执行。');return{entries:value.entries,stat:expected};
  }finally{if(fd!==undefined)closeSync(fd);}
 }
 function persist(entries,expected){
  const bytes=JSON.stringify({version:1,entries});if(Buffer.byteLength(bytes)>MAX_BYTES)fail('Owner 资料修改来源记录达到容量上限，未执行。');
  const check=()=>{const current=inspect(true);if(expected===null?current!==null:!same(expected,current))fail('Owner 资料修改来源记录刚有变化，未执行。');};
  check();const temporary=join(root,'.owner-library-sources-'+randomUUID()+'.tmp');let fd;
  try{fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;check();renameSync(temporary,file);existed=true;const parent=openSync(root,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(parent);}finally{closeSync(parent);}}
  finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch{}}
 }
 load();
 return Object.freeze({atFor({ownerId,route,requestId,operation,entryId,expectedRevision,text}={}){
  if(typeof ownerId!=='string'||!ownerId||typeof requestId!=='string'||!requestId.trim()||requestId.length>512||!['library_update','library_delete'].includes(operation)||typeof entryId!=='string'||!Number.isSafeInteger(expectedRevision)||expectedRevision<1||operation==='library_update'&&(typeof text!=='string'||!text.trim()||text.length>24000))fail('Owner 资料修改请求无效。');
  const key=hash([ownerId,['personId','accountId','peerId','generation'].map(field=>route?.[field]),requestId]),fingerprint=hash([operation,entryId,expectedRevision,operation==='library_update'?text:null]),loaded=load(),previous=loaded.entries.find(row=>row.key===key);
  if(previous){if(previous.fingerprint!==fingerprint)fail('同一 Owner 请求已对应其他操作或内容，未重复执行。');return previous.at;}
  if(loaded.entries.length>=MAX_ENTRIES)fail('Owner 资料修改来源记录达到容量上限，未执行。');const at=new Date(now()).toISOString();persist([...loaded.entries,{key,fingerprint,at}],loaded.stat);return at;
 }});
}
