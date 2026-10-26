import {mkdirSync,lstatSync,realpathSync,openSync,readFileSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync,fstatSync,fchmodSync,constants} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {timestamp} from './store.mjs';

const capabilities=['read','task','write'];
const clone=value=>structuredClone(value);
function fail(code,message){const error=new Error(message);error.code=code;throw error;}
function object(value,keys,code='INVALID_ARGUMENT',required=keys){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key))||required.some(key=>!Object.hasOwn(value,key)))fail(code,'权限参数或记录包含不支持的字段。');
}
function personId(value,code='INVALID_ARGUMENT'){
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(value))fail(code,'成员标识无效。');return value;
}
function workspaceId(value,code='INVALID_ARGUMENT'){
  if(typeof value!=='string'||!value.length||value.length>1024||value.trim()!==value||/[\u0000-\u001f\u007f]/.test(value))fail(code,'项目标识无效。');return value;
}
function scope(workspaceIds,requestedCapabilities,code='INVALID_ARGUMENT'){
  if(!Array.isArray(workspaceIds)||workspaceIds.length>100||!Array.isArray(requestedCapabilities)||requestedCapabilities.length>100)fail(code,'权限范围必须是有界列表。');
  for(const value of workspaceIds)workspaceId(value,code);
  if(requestedCapabilities.some(value=>!capabilities.includes(value)))fail(code,'包含未支持的项目操作。');
  const projects=[...new Set(workspaceIds)],operations=capabilities.filter(value=>requestedCapabilities.includes(value));
  if(!projects.length&&operations.length)fail(code,'先指定项目，再开通项目操作。');
  return{workspaceIds:projects,capabilities:operations};
}
function validateState(value){
  object(value,['version','policies'],'INVALID_STATE');
  if(value.version!==1||!Array.isArray(value.policies)||value.policies.length>1000)fail('INVALID_STATE','项目权限记录版本或格式不受支持，请保留原文件后检查。');
  const ids=new Set();
  for(const row of value.policies){
    object(row,['personId','workspaceIds','capabilities','revision','updatedAt'],'INVALID_STATE');personId(row.personId,'INVALID_STATE');
    if(ids.has(row.personId))fail('INVALID_STATE','成员权限记录重复。');ids.add(row.personId);
    const normalized=scope(row.workspaceIds,row.capabilities,'INVALID_STATE');
    if(normalized.workspaceIds.length!==row.workspaceIds.length||normalized.capabilities.length!==row.capabilities.length)fail('INVALID_STATE','权限记录包含重复项目或操作。');
    if(!Number.isSafeInteger(row.revision)||row.revision<1)fail('INVALID_STATE','权限版本无效。');
    try{timestamp(row.updatedAt);}catch{fail('INVALID_STATE','权限更新时间无效。');}
  }
  return value;
}
function statOrNull(path){try{return lstatSync(path);}catch(error){if(error.code==='ENOENT')return null;fail('IO_ERROR','无法检查项目权限存储。');}}

/** A private, synchronous registry. It grants scope, never Host tools or approval bypasses. */
export function createFamilyAccess({directory,store,now=()=>new Date().toISOString()}={}){
  if(typeof directory!=='string'||!directory.trim()||directory.length>4096||directory.includes('\0')||typeof store?.snapshot!=='function'||typeof now!=='function')fail('INVALID_ARGUMENT','缺少有效的项目权限存储配置。');
  const supplied=resolve(directory),before=statOrNull(supplied);
  if(before&&(before.isSymbolicLink()||!before.isDirectory()))fail('UNSAFE_PATH','项目权限目录不能是符号链接或普通文件。');
  try{mkdirSync(supplied,{recursive:true,mode:0o700});}catch{fail('IO_ERROR','无法准备项目权限目录。');}
  const root=realpathSync(supplied),rootIdentity=lstatSync(root),file=join(root,'family-access.json');
  function secureDirectory(){
    const current=statOrNull(root);
    if(!current||current.isSymbolicLink()||!current.isDirectory()||current.dev!==rootIdentity.dev||current.ino!==rootIdentity.ino)fail('UNSAFE_PATH','项目权限目录在运行期间发生变化。');
  }
  function secureFile({optional=false}={}){
    secureDirectory();const current=statOrNull(file);
    if(!current){if(optional)return null;fail('INVALID_STATE','项目权限文件缺失，请先检查存储，未自动重建。');}
    if(current.isSymbolicLink()||!current.isFile()||current.nlink!==1)fail('UNSAFE_PATH','项目权限文件不能是链接或特殊文件。');
    if(current.size>1024*1024)fail('INVALID_STATE','项目权限文件超过容量上限。');return current;
  }
  function read(){
    const expected=secureFile();let fd;
    try{
      fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);const opened=fstatSync(fd);
      if(!opened.isFile()||opened.nlink!==1||opened.dev!==expected.dev||opened.ino!==expected.ino)fail('UNSAFE_PATH','读取期间项目权限文件发生变化。');
      let parsed;try{parsed=JSON.parse(readFileSync(fd,'utf8'));}catch{fail('INVALID_STATE','项目权限文件无法解析，请保留原文件后检查。');}
      return validateState(parsed);
    }catch(error){if(error.code==='ELOOP')fail('UNSAFE_PATH','项目权限文件不能是符号链接。');if(['UNSAFE_PATH','INVALID_STATE'].includes(error.code))throw error;fail('IO_ERROR','无法读取项目权限文件。');}
    finally{if(fd!==undefined)closeSync(fd);}
  }
  function persist(value,{initial=false}={}){
    validateState(value);secureFile({optional:initial});
    const temporary=join(root,`.family-access-${randomUUID()}.tmp`);let fd;
    try{
      fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      fchmodSync(fd,0o600);writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;
      secureFile({optional:initial});renameSync(temporary,file);
      const dirfd=openSync(root,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(dirfd);}finally{closeSync(dirfd);}
    }catch(error){if(['UNSAFE_PATH','INVALID_STATE'].includes(error.code))throw error;fail('IO_ERROR','保存项目权限失败，请核对当前状态后重试。');}
    finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch{}}
  }
  function people(){
    let rows;try{rows=store.snapshot()?.people;}catch{fail('INVALID_STATE','无法核对当前家庭成员。');}
    if(!Array.isArray(rows))fail('INVALID_STATE','当前家庭成员记录无效。');return rows;
  }
  function currentPerson(id){return people().find(person=>person.id===id)||null;}
  function requirePerson(id){personId(id);const person=currentPerson(id);if(!person)fail('UNKNOWN_PERSON','没有找到当前家庭成员。');return person;}
  function owner(id){personId(id);if(currentPerson(id)?.role!=='owner')fail('FORBIDDEN','只有当前 Owner 可以管理项目权限。');}
  function rowFor(state,id){return state.policies.find(row=>row.personId===id)||{personId:id,workspaceIds:[],capabilities:[],revision:0,updatedAt:null};}
  function changed(state,id,permissions){
    const previous=rowFor(state,id),revision=previous.revision+1;if(!Number.isSafeInteger(revision))fail('INVALID_STATE','权限版本达到上限，请先检查存储。');
    let updatedAt;try{updatedAt=timestamp(now());}catch{fail('INVALID_ARGUMENT','权限更新时间无效。');}
    const row={personId:id,...permissions,revision,updatedAt},next={version:1,policies:state.policies.filter(value=>value.personId!==id)};
    next.policies.push(row);persist(next);return clone(row);
  }
  if(secureFile({optional:true}))read();else persist({version:1,policies:[]},{initial:true});
  return{
    get(id){requirePerson(id);return clone(rowFor(read(),id));},
    list(input){object(input,['actorId']);owner(input.actorId);const state=read();return people().map(person=>clone(rowFor(state,personId(person.id))));},
    grant(input){object(input,['actorId','personId','workspaceIds','capabilities']);owner(input.actorId);requirePerson(input.personId);const permissions=scope(input.workspaceIds,input.capabilities);return changed(read(),input.personId,permissions);},
    revoke(input){object(input,['actorId','personId']);owner(input.actorId);requirePerson(input.personId);return changed(read(),input.personId,{workspaceIds:[],capabilities:[]});},
    authorize(input){
      const invalid={allowed:false,reason:'invalid_request',personId:null,workspaceId:null,capability:null,revision:null,requiresHostApproval:true};
      try{object(input,['personId','workspaceId','capability','expectedRevision'],'INVALID_ARGUMENT',['personId','workspaceId','capability']);personId(input.personId);workspaceId(input.workspaceId);if(!capabilities.includes(input.capability)||('expectedRevision'in input&&(!Object.hasOwn(input,'expectedRevision')||(input.expectedRevision!==undefined&&(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)))))return invalid;}
      catch(error){if(error.code==='INVALID_ARGUMENT')return invalid;throw error;}
      const person=currentPerson(input.personId),decision={...invalid,personId:input.personId,workspaceId:input.workspaceId,capability:input.capability,reason:'unknown_person'};
      if(!person)return decision;
      const row=rowFor(read(),input.personId);decision.revision=row.revision;
      if(input.expectedRevision!==undefined&&input.expectedRevision!==row.revision)return{...decision,reason:'revision_changed'};
      if(person.role==='owner')return{...decision,allowed:true,reason:'owner'};
      if(!row.workspaceIds.length||!row.capabilities.length)return{...decision,reason:'not_granted'};
      if(!row.workspaceIds.includes(input.workspaceId))return{...decision,reason:'workspace_denied'};
      if(!row.capabilities.includes(input.capability))return{...decision,reason:'capability_denied'};
      return{...decision,allowed:true,reason:'allowed'};
    }
  };
}
