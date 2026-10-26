import {lstatSync,readdirSync,realpathSync,openSync,fstatSync,readSync,closeSync,constants} from 'node:fs';
import {isAbsolute,resolve,join,relative,parse} from 'node:path';
import {TextDecoder} from 'node:util';
import {normalizeDigestResource,digestSourceFamily,selectLatestDigestSource} from './digest-discovery.mjs';

const LIMIT=64*1024;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const string=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value);
const object=(value,keys,required=keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Object.keys(value).every(key=>keys.includes(key))&&required.every(key=>Object.hasOwn(value,key));
const sensitiveName=/(?:^|[._\-\s])(?:credentials?|secrets?|tokens?|passwords?|passwd|api[_\- ]?keys?|private[_\- ]?keys?|id[_\- ]?(?:rsa|dsa|ecdsa|ed25519)|keychain)(?:$|[._\-\s])|凭据|密钥|私钥|令牌|密码/iu;
const sensitiveContent=[
  /-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/u,
  /\b(?:api[_\- ]?key|access[_\- ]?token|refresh[_\- ]?token|auth[_\- ]?token|token|password|passwd|client[_\- ]?secret|secret(?:[_\- ]?key)?|credential)["']?\s*[:=]\s*["']?\S/iu,
  /\bauthorization\s*:\s*(?:bearer|basic)\s+\S/iu,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /(?:密码|口令|密钥|令牌|私钥)\s*[:：=]\s*\S/u,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/iu,
];
const sameIdentity=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const sameFile=(a,b)=>sameIdentity(a,b)&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;

function resourceInput(resource){
  if(!object(resource,['workspaceId','relativePath','selection','sourceTimeZone'],['workspaceId','relativePath'])||!string(resource.workspaceId,1024)||!string(resource.relativePath,1024))fail('digest_invalid_argument');
  const parts=resource.relativePath.split('/');
  if(isAbsolute(resource.relativePath)||/[\\:]/u.test(resource.relativePath)||parts.some(part=>!part||part.startsWith('.'))||!(/\.(?:md|txt)$/iu.test(resource.relativePath)))fail('digest_unsafe_path');
  if(parts.some(part=>sensitiveName.test(part)))fail('digest_sensitive_source');
  const normalized=normalizeDigestResource(resource);if(!normalized)fail('digest_invalid_argument');return normalized;
}
function checkpoint(signal){if(signal?.aborted)fail('digest_aborted');}
function confined(root,path){const difference=relative(root,path);return difference!==''&&!isAbsolute(difference)&&difference!=='..'&&!difference.startsWith('../');}

// Inspect every parent before opening and again before returning any bytes.
// The enclosing runtime authenticates the member, checks the fixed tool grant,
// and rechecks its revision before execution and before delivery.
function inspect(root,relativePath){
  const chain=[];let current=parse(root).root;
  for(const part of root.slice(current.length).split('/').filter(Boolean)){
    current=join(current,part);const stat=lstatSync(current);
    if(stat.isSymbolicLink()||!stat.isDirectory())fail('digest_unsafe_path');chain.push({path:current,stat});
  }
  const realRoot=realpathSync(root);
  if(realRoot!==root)fail('digest_unsafe_path');
  const parts=relativePath.split('/');
  for(let index=0;index<parts.length;index++){
    current=join(current,parts[index]);const stat=lstatSync(current),final=index===parts.length-1;
    if(stat.isSymbolicLink()||(!final&&!stat.isDirectory())||(final&&(!stat.isFile()||stat.nlink!==1)))fail('digest_unsafe_path');
    chain.push({path:current,stat});
  }
  const realFile=realpathSync(current);
  if(!confined(realRoot,realFile)||realFile!==current)fail('digest_unsafe_path');
  return{chain,path:current,file:chain.at(-1).stat};
}
function fixedFile(root,source,maxBytes,signal,expected=null){
  let fd;
  try{
    checkpoint(signal);const before=inspect(root,source.relativePath);
    if(expected&&(!sameFile(before.file,expected.file)||before.chain.length!==expected.chain.length||before.chain.some((item,index)=>item.path!==expected.chain[index].path||!sameIdentity(item.stat,expected.chain[index].stat))))fail('digest_source_changed');
    if(before.file.size>maxBytes)fail('digest_file_too_large');
    fd=openSync(before.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const opened=fstatSync(fd);
    if(!opened.isFile()||opened.nlink!==1||!sameFile(before.file,opened))fail('digest_source_changed');
    if(opened.size>maxBytes)fail('digest_file_too_large');
    const bytes=Buffer.alloc(maxBytes+1);let length=0;
    while(length<bytes.length){checkpoint(signal);const count=readSync(fd,bytes,length,bytes.length-length,null);if(!count)break;length+=count;}
    if(length>maxBytes)fail('digest_file_too_large');
    const after=fstatSync(fd),again=inspect(root,source.relativePath);
    if(!sameFile(opened,after)||!sameFile(after,again.file)||before.chain.length!==again.chain.length||before.chain.some((item,index)=>item.path!==again.chain[index].path||!sameIdentity(item.stat,again.chain[index].stat)))fail('digest_source_changed');
    checkpoint(signal);let text;
    try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,length));}catch{fail('digest_invalid_utf8');}
    if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))fail('digest_invalid_text');
    if(sensitiveContent.some(pattern=>pattern.test(text)))fail('digest_sensitive_source');
    return{text,source:{...source}};
  }catch(error){
    if(typeof error.code==='string'&&error.code.startsWith('digest_'))throw error;
    if(error.code==='ELOOP')fail('digest_unsafe_path');
    fail('digest_read_failed');
  }finally{if(fd!==undefined)closeSync(fd);}
}
function inspectDirectory(root,directory){
  const chain=[];let current=parse(root).root;
  for(const part of [...root.slice(current.length).split('/').filter(Boolean),...directory.split('/').filter(Boolean)]){
    current=join(current,part);const stat=lstatSync(current);if(stat.isSymbolicLink()||!stat.isDirectory())fail('digest_unsafe_path');chain.push({path:current,stat});
  }
  if(realpathSync(root)!==root||realpathSync(current)!==current||(current!==root&&!confined(root,current)))fail('digest_unsafe_path');
  return{path:current,chain};
}
function latestFile(root,resource,maxBytes,signal,now){
  try{
    checkpoint(signal);const family=digestSourceFamily(resource.relativePath),parent=inspectDirectory(root,family.directory),entries=readdirSync(parent.path,{withFileTypes:true});
    if(entries.length>2000)fail('digest_source_unavailable');
    const metadata=[],snapshots=new Map();
    for(const entry of entries){
      checkpoint(signal);const relativePath=family.directory+entry.name,candidate=digestSourceFamily(relativePath);
      if(!candidate||candidate.directory!==family.directory||candidate.template!==family.template)continue;
      const checked=inspect(root,relativePath);snapshots.set(relativePath,checked);
      metadata.push({relativePath,bytes:checked.file.size,updatedAt:checked.file.mtime.toISOString()});
    }
    const selected=selectLatestDigestSource({resource,sources:metadata,now});
    if(selected.bytes>maxBytes)fail('digest_file_too_large');
    const exact={workspaceId:resource.workspaceId,relativePath:selected.relativePath},result=fixedFile(root,exact,maxBytes,signal,snapshots.get(selected.relativePath)),after=inspectDirectory(root,family.directory);
    if(parent.chain.length!==after.chain.length||parent.chain.some((item,index)=>item.path!==after.chain[index].path||!sameIdentity(item.stat,after.chain[index].stat)))fail('digest_source_changed');
    return result;
  }catch(error){if(typeof error.code==='string'&&error.code.startsWith('digest_'))throw error;fail('digest_read_failed');}
}

/** Read one Owner-selected digest file. No Agent session, shell, network,
 * discovery, write access, or arbitrary member-supplied file path is exposed.
 * Credential signatures are a final rejection filter, not a secret-vault ACL.
 */
export function createFamilyToolExecutors({ownerAgent,maxBytes=LIMIT,now=()=>new Date().toISOString()}={}){
  if(typeof ownerAgent?.listWorkspaces!=='function'||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>LIMIT||typeof now!=='function')fail('digest_invalid_argument');
  return Object.freeze({
    async ai_digest(args={}){
      if(!object(args,['personId','resource','input','signal'],['resource'])||args.personId!==undefined&&!/^[A-Za-z0-9_-]{1,80}$/.test(args.personId))fail('digest_invalid_argument');
      const{resource,input,signal}=args;
      // input cannot change resource: the toolbox supplies the saved grant.
      void input;
      if(signal!==undefined&&!(signal instanceof AbortSignal))fail('digest_invalid_argument');
      checkpoint(signal);const source=resourceInput(resource);let rows;
      try{rows=await ownerAgent.listWorkspaces({signal});}catch{checkpoint(signal);fail('digest_source_unavailable');}
      checkpoint(signal);
      if(!Array.isArray(rows)||rows.length>10000)fail('digest_invalid_registry');
      const registered=new Map();
      for(const row of rows){
        if(!row||!Object.hasOwn(row,'workspaceId')||!Object.hasOwn(row,'path')||!string(row.workspaceId,1024)||!string(row.path,4096)||!isAbsolute(row.path)||row.path.split('/').some(part=>part==='.'||part==='..')||registered.has(row.workspaceId))fail('digest_invalid_registry');
        registered.set(row.workspaceId,resolve(row.path));
      }
      const root=registered.get(source.workspaceId);if(!root)fail('digest_unknown_workspace');
      return source.selection==='latest'?latestFile(root,source,maxBytes,signal,now):fixedFile(root,source,maxBytes,signal);
    },
  });
}

/** Owner-only source picker: metadata under one selected registered project.
 * Never opens file content or follows links while finding a readable source. */
export function createDigestSources({ownerAgent,maxBytes=LIMIT}={}){
  if(typeof ownerAgent?.listWorkspaces!=='function'||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>LIMIT)fail('digest_invalid_argument');
  return async({workspaceId,query='',signal}={})=>{
    if(!string(workspaceId,240)||typeof query!=='string'||query.length>120||/[\x00-\x1f\x7f]/u.test(query))fail('digest_invalid_argument');
    checkpoint(signal);let rows;try{rows=await ownerAgent.listWorkspaces({signal});}catch{checkpoint(signal);fail('digest_source_unavailable');}
    if(!Array.isArray(rows)||rows.length>10000)fail('digest_invalid_registry');
    const matches=rows.filter(row=>row?.workspaceId===workspaceId);
    if(matches.length!==1||!string(matches[0].path,4096)||!isAbsolute(matches[0].path))fail('digest_unknown_workspace');
    const root=resolve(matches[0].path),result=[],needle=query.trim().toLocaleLowerCase();let visited=0;
    const ignored=/^(?:node_modules|dist|build|vendor|venv|skills?|memory|sessions?|family-output)$/iu;
    try{
      let ancestor=parse(root).root;
      for(const part of root.slice(ancestor.length).split('/').filter(Boolean)){ancestor=join(ancestor,part);const info=lstatSync(ancestor);if(info.isSymbolicLink()||!info.isDirectory())fail('digest_unsafe_path');}
      if(realpathSync(root)!==root)fail('digest_unsafe_path');
      const visit=(folder,prefix,depth)=>{
        checkpoint(signal);if(visited>=1500||result.length>=200)return;
        for(const entry of readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
          if(++visited>1500||result.length>=200)break;
          const name=entry.name;if(name.startsWith('.')||sensitiveName.test(name)||ignored.test(name))continue;
          const path=join(folder,name),relativePath=prefix?prefix+'/'+name:name,info=lstatSync(path);
          if(info.isSymbolicLink())continue;
          if(info.isDirectory()&&depth<3){visit(path,relativePath,depth+1);continue;}
          if(!info.isFile()||info.nlink!==1||!/\.(?:md|txt)$/iu.test(name)||info.size>maxBytes||needle&&!relativePath.toLocaleLowerCase().includes(needle))continue;
          // Same confinement and ancestor-link checks as an actual invocation.
          inspect(root,relativePath);
          result.push({relativePath,name,bytes:info.size,updatedAt:info.mtime.toISOString()});
        }
      };
      visit(root,'',0);checkpoint(signal);return result;
    }catch(error){checkpoint(signal);if(typeof error.code==='string'&&error.code.startsWith('digest_'))throw error;fail('digest_read_failed');}
  };
}
