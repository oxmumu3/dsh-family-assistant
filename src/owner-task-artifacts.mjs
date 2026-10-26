import {lstatSync,readdirSync,realpathSync,openSync,fstatSync,readSync,closeSync,constants} from 'node:fs';
import {join,resolve,isAbsolute,parse,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {unzipSync} from 'fflate';
import {inflateRawSync} from 'node:zlib';

const TEXT_EXT=/\.(md|txt|csv|json)$/iu,EXT=/\.(md|txt|csv|json|pptx|docx|xlsx|pdf)$/iu,UUID='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const directoryPattern=new RegExp('^family-output/([A-Za-z0-9_-]{1,80})/owner-task-('+UUID+')/('+UUID+')$');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Object.assign(new Error('owner_artifact_'+code),{code:'owner_artifact_'+code});};
const object=(value,keys,required=keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Object.keys(value).every(key=>keys.includes(key))&&required.every(key=>Object.hasOwn(value,key));
const text=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max&&!/[\x00-\x1f\x7f]/u.test(value);
const personId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,80}$/u.test(value);
const privateName=/(?:^|[._\-\s])(?:credentials?|secrets?|tokens?|passwords?|passwd|api[_\- ]?keys?|private[_\- ]?keys?|id[_\- ]?(?:rsa|dsa|ecdsa|ed25519)|keychain)(?:$|[._\-\s])|凭据|密钥|私钥|令牌|密码/iu;
const sensitive=[/-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/u,/\b(?:api[_\- ]?key|access[_\- ]?token|refresh[_\- ]?token|auth[_\- ]?token|token|password|passwd|client[_\- ]?secret|secret(?:[_\- ]?key)?|credential)["']?\s*[:=]\s*["']?\S/iu,/\bauthorization\s*:\s*(?:bearer|basic)\s+\S/iu,/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/u,/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,/(?:密码|口令|密钥|令牌|私钥)\s*[:：=]\s*\S/u,/https?:\/\/[^\s/:@]+:[^\s/@]+@/iu];
const safeName=value=>text(value,180)&&!value.startsWith('.')&&!/[\\/:]/u.test(value)&&!privateName.test(value)&&EXT.test(value);
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const sameFile=(a,b)=>same(a,b)&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
function scopeOf(scope){
 if(!object(scope,['personId','relativeDirectory','workspacePathHash'])||!personId(scope.personId)||!text(scope.relativeDirectory,300)||!/^[a-f0-9]{64}$/u.test(scope.workspacePathHash))fail('invalid_scope');
 const match=scope.relativeDirectory.match(directoryPattern);if(!match||match[1]!==scope.personId)fail('invalid_scope');return scope;
}
export function createOwnerTaskArtifactScope({personId:id,taskId,requestId,cwd}={}){
 if(!personId(id)||!new RegExp('^'+UUID+'$').test(taskId??'')||!new RegExp('^'+UUID+'$').test(requestId??'')||!text(cwd,4096)||!isAbsolute(cwd))fail('invalid_scope');
 return{personId:id,relativeDirectory:`family-output/${id}/owner-task-${taskId}/${requestId}`,workspacePathHash:hash(resolve(cwd))};
}
export function ownerTaskArtifactInstructions(scope){scopeOf(scope);return`\n\n交付约束：本次对家人的文字和文件投递由家庭助手独立接管；本原生会话只完成用户要求的项目处理和保存成果，不自行向家人发送，不调用微信或其他消息通路，不用 family_assistant 外发，也不建立额外日程。用户原文中的投递对象仅供理解稿件受众，不是让本会话再次发送。请将本次要交给家人的最终稿件保存到当前项目的 ${scope.relativeDirectory}/ 目录直属位置。可用 UTF-8 .md、.txt、.csv、.json（每个不超过128KiB），或真实生成的静态 .pptx、.docx、.xlsx、.pdf（每个不超过10MiB），最多4个文件。Office 不包含宏、外部链接或嵌入对象，PDF 不包含脚本、附件或自动操作。只放本次明确要求交付的成果，不要复制凭据、系统说明或其他源资料，不用链接、隐藏文件、归档包或可执行文件。最终文字直接概述成果，不展示本机绝对路径。没有生成稿件就明确说明，不能宣称文件已送达。`;}
export function sanitizeOwnerTaskText(value,{cwd}={}){
 if(typeof value!=='string')return'';
 let result=value.slice(0,24000).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu,'');
 if(sensitive.some(pattern=>pattern.test(result)))return'原生任务已结束，但文字包含不适合自动转交的信息；请 Owner 在控制台核对。';
 result=result.replace(/file:\/\/[^\s<>"'，。；、)\]}]+/giu,'[成果文件]');
 if(typeof cwd==='string'&&cwd)result=result.replaceAll(cwd,'[项目目录]');
 return result.replace(/(?<![A-Za-z0-9_:\/])\/(?!\/)(?:[^\s"'<>，。；、)\]}/]+\/)+[^\s"'<>，。；、)\]}/]+/gu,'[本地路径]').replace(/\b[A-Za-z]:[\\/][^\s"'<>，。；、)\]}]+/gu,'[本地路径]');
}
function chain(root,relativePath,{file=false}={}){
 const rows=[];let current=parse(root).root;
 for(const part of root.slice(current.length).split('/').filter(Boolean)){current=join(current,part);const info=lstatSync(current);if(info.isSymbolicLink()||!info.isDirectory())fail('unsafe_path');rows.push({path:current,info});}
 if(realpathSync(root)!==root)fail('unsafe_path');
 for(const[index,part]of (relativePath?relativePath.split('/'):[]).entries()){
  if(!part||part.startsWith('.')||/[\\:]/u.test(part))fail('unsafe_path');current=join(current,part);const info=lstatSync(current),last=index===relativePath.split('/').length-1;
  if(info.isSymbolicLink()||(file&&last?!info.isFile()||info.nlink!==1:!info.isDirectory()))fail('unsafe_path');rows.push({path:current,info});
 }
 if(realpathSync(current)!==current)fail('unsafe_path');return{path:current,rows,info:rows.at(-1).info};
}
const unchanged=(a,b)=>a.rows.length===b.rows.length&&a.rows.every((row,index)=>row.path===b.rows[index].path&&same(row.info,b.rows[index].info));
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crc32=bytes=>{let n=0xffffffff;for(const byte of bytes)n=crcTable[(n^byte)&255]^(n>>>8);return(n^0xffffffff)>>>0;};
const utf8=bytes=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('invalid_format');}};
// Central-directory claims and local headers are checked before any inflation.
// zlib limits actual output as well: forged sizes cannot allocate an unbounded ZIP bomb.
function officeEntries(bytes){
 const bad=()=>fail('invalid_format'),expandedLimit=32*1024*1024,entryLimit=16*1024*1024;
 const u16=o=>o>=0&&o+2<=bytes.length?bytes.readUInt16LE(o):bad(),u32=o=>o>=0&&o+4<=bytes.length?bytes.readUInt32LE(o):bad();let end=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(u32(i)===0x06054b50&&i+22+u16(i+20)===bytes.length){end=i;break;}
 if(end<0||u16(end+4)||u16(end+6)||u16(end+8)!==u16(end+10))bad();const count=u16(end+10),centralSize=u32(end+12),centralOffset=u32(end+16);if(!count||count>1024||centralOffset+centralSize!==end||centralOffset>=end)bad();
 const entries=[],names=new Set();let offset=centralOffset,total=0;
 for(let i=0;i<count;i++){
  if(u32(offset)!==0x02014b50||offset+46>end)bad();const flags=u16(offset+8),compression=u16(offset+10),crc=u32(offset+16),size=u32(offset+20),originalSize=u32(offset+24),nameLength=u16(offset+28),local=u32(offset+42),next=offset+46+nameLength+u16(offset+30)+u16(offset+32);
  if(next>end||!nameLength||u16(offset+34)||flags&0x2041||![0,8].includes(compression)||size===0xffffffff||originalSize===0xffffffff||local===0xffffffff)bad();const name=utf8(bytes.subarray(offset+46,offset+46+nameLength));
  if(names.has(name)||name.length>512||/^[\/]|[\\:\x00-\x1f\x7f]/u.test(name)||name.split('/').some(p=>p==='..'||p.startsWith('.')&&p!=='.rels')||privateName.test(name))bad();names.add(name);total+=originalSize;if(total>expandedLimit||originalSize>entryLimit)bad();
  if(u32(local)!==0x04034b50||local+30>centralOffset||u16(local+6)!==flags||u16(local+8)!==compression)bad();const localNameLength=u16(local+26),start=local+30+localNameLength+u16(local+28),finish=start+size;
  if(start>centralOffset||finish>centralOffset||localNameLength!==nameLength||!bytes.subarray(local+30,local+30+localNameLength).equals(bytes.subarray(offset+46,offset+46+nameLength)))bad();let localEnd=finish;
  if(flags&8){let descriptor=finish;if(u32(descriptor)===0x08074b50)descriptor+=4;if(descriptor+12>centralOffset||u32(descriptor)!==crc||u32(descriptor+4)!==size||u32(descriptor+8)!==originalSize)bad();localEnd=descriptor+12;}else if(u32(local+14)!==crc||u32(local+18)!==size||u32(local+22)!==originalSize)bad();
  entries.push({name,size,originalSize,compression,crc,start,finish,local,localEnd});offset=next;
 }
 if(offset!==end)bad();const ranges=[...entries].sort((a,b)=>a.local-b.local);if(ranges[0].local!==0||ranges.some((e,i)=>i&&e.local<ranges[i-1].localEnd))bad();let inspected=0;
 unzipSync(bytes,{filter(info){const e=entries[inspected++];if(!e||['name','size','originalSize','compression'].some(key=>e[key]!==info[key]))bad();return false;}});if(inspected!==entries.length)bad();
 const output=new Map();let actual=0;for(const e of entries){const compressed=bytes.subarray(e.start,e.finish),inflated=e.compression===0?null:inflateRawSync(compressed,{maxOutputLength:Math.max(1,Math.min(e.originalSize+1,expandedLimit-actual+1)),info:true});if(inflated&&inflated.engine.bytesWritten!==compressed.length)bad();const content=inflated?inflated.buffer:compressed;actual+=content.length;if(actual>expandedLimit||content.length!==e.originalSize||crc32(content)!==e.crc)bad();output.set(e.name,content);}return output;
}
function xmlEntities(value){return value.replace(/&([^;\s]+);|&/gu,(_,key)=>{const standard={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};if(Object.hasOwn(standard,key))return standard[key];if(key&&/^#(?:[0-9]+|x[0-9a-f]+)$/iu.test(key)){const n=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));if(n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)&&!(n<32&&![9,10,13].includes(n)))return String.fromCodePoint(n);}fail('invalid_format');});}
function inspectXml(bytes,onElement=()=>{}){
 const xml=utf8(bytes);if(/<!DOCTYPE|<!ENTITY/iu.test(xml)||/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(xml))fail('invalid_format');const stack=[];let i=0,roots=0,first;
 while(i<xml.length){
  if(xml[i]!=='<'){let end=xml.indexOf('<',i);if(end<0)end=xml.length;const raw=xml.slice(i,end);if(raw.includes(']]>')||!stack.length&&raw.trim())fail('invalid_format');xmlEntities(raw);i=end;continue;}
  if(xml.startsWith('<!--',i)){const end=xml.indexOf('-->',i+4);if(end<0||xml.slice(i+4,end).includes('--'))fail('invalid_format');i=end+3;continue;}
  if(xml.startsWith('<![CDATA[',i)){const end=xml.indexOf(']]>',i+9);if(end<0||!stack.length)fail('invalid_format');i=end+3;continue;}
  if(xml.startsWith('<?',i)){const end=xml.indexOf('?>',i+2);if(end<0)fail('invalid_format');i=end+2;continue;}
  const close=/^<\/([A-Za-z_][\w.:-]*)\s*>/u.exec(xml.slice(i));if(close){if(stack.pop()!==close[1])fail('invalid_format');i+=close[0].length;continue;}
  const open=/^<([A-Za-z_][\w.:-]*)/u.exec(xml.slice(i));if(!open)fail('invalid_format');const tag=open[1];i+=open[0].length;const attrs={};let selfClosing=false;
  for(;;){const ws=/^\s*/u.exec(xml.slice(i))[0];i+=ws.length;if(xml.startsWith('/>',i)){selfClosing=true;i+=2;break;}if(xml[i]==='>'){i++;break;}if(!ws)fail('invalid_format');const attr=/^([A-Za-z_][\w.:-]*)\s*=\s*("[^"<]*"|'[^'<]*')/u.exec(xml.slice(i));if(!attr||Object.hasOwn(attrs,attr[1]))fail('invalid_format');attrs[attr[1]]=xmlEntities(attr[2].slice(1,-1));i+=attr[0].length;}
  if(!first)first={tag,attrs};onElement(tag,attrs);if(!stack.length&&++roots!==1)fail('invalid_format');if(!selfClosing){stack.push(tag);if(stack.length>256)fail('invalid_format');}
 }
 if(stack.length||roots!==1)fail('invalid_format');return first;
}
function validateContent(bytes,relativePath){
 if(TEXT_EXT.test(relativePath)){const content=utf8(bytes);if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(content)||sensitive.some(pattern=>pattern.test(content)))fail('unsafe_content');if(/\.json$/iu.test(relativePath)){try{JSON.parse(content);}catch{fail('invalid_text');}}return;}
 if(/\.pdf$/iu.test(relativePath)){const raw=bytes.toString('latin1');if(!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/u.test(raw)||! /%%EOF\s*$/u.test(raw)||!/\btrailer\b|\/Type\s*\/XRef\b/u.test(raw))fail('invalid_format');const decoded=raw.replace(/#([0-9a-f]{2})/giu,(_,value)=>String.fromCharCode(parseInt(value,16)));if(/\/(?:JavaScript|JS|OpenAction|AA|Launch|EmbeddedFile|Filespec|RichMedia|Encrypt|AcroForm|ObjStm)\b/iu.test(decoded)||sensitive.some(pattern=>pattern.test(decoded)))fail('unsafe_content');return;}
 const files=officeEntries(bytes),extension=relativePath.split('.').at(-1).toLowerCase(),mains={pptx:['ppt/presentation.xml','presentationml.presentation.main+xml','presentation','http://schemas.openxmlformats.org/presentationml/2006/main'],docx:['word/document.xml','wordprocessingml.document.main+xml','document','http://schemas.openxmlformats.org/wordprocessingml/2006/main'],xlsx:['xl/workbook.xml','spreadsheetml.sheet.main+xml','workbook','http://schemas.openxmlformats.org/spreadsheetml/2006/main']},[main,type,root,namespace]=mains[extension]??[];
 if(!main||!files.has('[Content_Types].xml')||!files.has('_rels/.rels')||!files.has(main))fail('invalid_format');
 let contentType=false,mainRelationship=false;for(const[name,content]of files){if(name.endsWith('/'))continue;if(/(?:^|\/)(?:embeddings|activeX|externalLinks|customUI)(?:\/|$)|vbaProject|oleObject/iu.test(name))fail('unsafe_content');if(/\.(?:xml|rels)$/iu.test(name)){const xml=utf8(content);if(/\bmacroEnabled\b|vbaProject|oleObject/iu.test(xml)||sensitive.some(pattern=>pattern.test(xmlEntities(xml))))fail('unsafe_content');const first=inspectXml(content,(tag,attrs)=>{const local=tag.split(':').at(-1);if(local==='Relationship'){if(attrs.TargetMode&&attrs.TargetMode!=='Internal'||/^(?:[A-Za-z][\w+.-]*:|\/\/)|[\\\x00-\x1f]/u.test(attrs.Target??''))fail('unsafe_content');if(name==='_rels/.rels'&&attrs.Target===main&&attrs.Type?.endsWith('/officeDocument'))mainRelationship=true;}if(name==='[Content_Types].xml'&&local==='Override'&&attrs.PartName==='/'+main&&attrs.ContentType==='application/vnd.openxmlformats-officedocument.'+type)contentType=true;});if(name===main&&(first.tag.split(':').at(-1)!==root||!Object.values(first.attrs).includes(namespace)))fail('invalid_format');}else{if(!/\/(?:media|thumbnail)[^/]*\/[^/]+\.(?:png|jpe?g|gif|bmp)$/iu.test(name)&&!/^docProps\/thumbnail\.(?:png|jpe?g|gif|bmp)$/iu.test(name))fail('unsafe_content');const good=/\.png$/iu.test(name)?content.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):/\.jpe?g$/iu.test(name)?content[0]===255&&content[1]===216&&content[2]===255:/\.gif$/iu.test(name)?/^GIF8[79]a/u.test(content.subarray(0,6).toString('ascii')):content.subarray(0,2).toString('ascii')==='BM';if(!good)fail('invalid_format');}}
 if(!contentType||!mainRelationship)fail('invalid_format');
 if(extension==='pptx'&&![...files.keys()].some(name=>/^ppt\/slides\/slide[1-9][0-9]*\.xml$/u.test(name)))fail('invalid_format');
}
const mimeTypeFor=name=>({md:'text/markdown',txt:'text/plain',csv:'text/csv',json:'application/json',pdf:'application/pdf',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}[name.split('.').at(-1).toLowerCase()]);
function read(root,relativePath,maxBytes,signal){
 let fd;try{
  signal?.throwIfAborted();const before=chain(root,relativePath,{file:true});if(before.info.size>maxBytes)fail('too_large');
  fd=openSync(before.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const info=fstatSync(fd);if(!sameFile(before.info,info)||!info.isFile()||info.nlink!==1)fail('source_changed');
  const buffer=Buffer.alloc(maxBytes+1);let length=0;while(length<buffer.length){signal?.throwIfAborted();const count=readSync(fd,buffer,length,buffer.length-length,null);if(!count)break;length+=count;}if(length>maxBytes)fail('too_large');
  const after=chain(root,relativePath,{file:true});if(!unchanged(before,after)||!sameFile(info,fstatSync(fd))||!sameFile(info,after.info))fail('source_changed');
  const bytes=buffer.subarray(0,length);validateContent(bytes,relativePath);
  signal?.throwIfAborted();return{bytes,sha256:hash(bytes)};
 }finally{if(fd!==undefined)closeSync(fd);}
}
/** Only the new per-task recipient output directory can be enumerated/read.
 * The gateway separately verifies the Owner and captured recipient route. */
export function createOwnerTaskArtifacts({ownerAgent,maxBytes=131072,maxBinaryBytes=10*1024*1024,maxFiles=4}={}){
 if(typeof ownerAgent?.listWorkspaces!=='function'||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>131072||!Number.isSafeInteger(maxBinaryBytes)||maxBinaryBytes<1||maxBinaryBytes>10*1024*1024||!Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>4)fail('invalid_configuration');
 async function context(args,extra=[]){
  if(!object(args,['workspaceId','scope','signal','authorize',...extra],['workspaceId','scope','authorize'])||!text(args.workspaceId,240)||typeof args.authorize!=='function')fail('invalid_argument');const scope=scopeOf(args.scope);
  const guard=async phase=>{args.signal?.throwIfAborted();let value;try{value=await args.authorize({phase,capability:'read'});}catch{fail('authorization_changed');}args.signal?.throwIfAborted();if(value!==true&&value?.allowed!==true)fail('authorization_changed');};
  await guard('before_registry');const rows=await ownerAgent.listWorkspaces({signal:args.signal});await guard('after_registry');if(!Array.isArray(rows)||rows.length>10000)fail('invalid_registry');const matches=rows.filter(row=>row?.workspaceId===args.workspaceId);if(matches.length!==1||!text(matches[0].path,4096)||!isAbsolute(matches[0].path))fail('invalid_registry');const root=resolve(matches[0].path);if(hash(root)!==scope.workspacePathHash)fail('source_changed');chain(root,'');return{root,scope,guard};
 }
 const safeError=error=>{if(typeof error?.code==='string'&&error.code.startsWith('owner_artifact_'))throw error;fail(error?.name==='AbortError'?'aborted':'unavailable');};
 return Object.freeze({
  async collect(args){try{
   const{root,scope,guard}=await context(args);await guard('before_collect');let directory;try{directory=chain(root,scope.relativeDirectory);}catch(error){if(error.code==='ENOENT')return[];throw error;}
   const names=readdirSync(directory.path).sort().filter(name=>!name.startsWith('.')&&EXT.test(name));if(names.length>maxFiles)fail('too_many');const files=[];
   for(const name of names){if(!safeName(name))fail('unsafe_path');const relativePath=scope.relativeDirectory+'/'+name;await guard('before_read');const value=read(root,relativePath,TEXT_EXT.test(name)?maxBytes:maxBinaryBytes,args.signal);await guard('after_read');files.push({relativePath,name,sha256:value.sha256});}
   if(!unchanged(directory,chain(root,scope.relativeDirectory)))fail('source_changed');await guard('after_collect');return files;
  }catch(error){safeError(error);}},
  async readArtifact(args){try{
   const{root,scope,guard}=await context(args,['relativePath','expectedSha256']);if(!text(args.relativePath,1024)||!args.relativePath.startsWith(scope.relativeDirectory+'/'))fail('unsafe_path');const name=args.relativePath.slice(scope.relativeDirectory.length+1);if(!safeName(name)||args.relativePath!==scope.relativeDirectory+'/'+name)fail('unsafe_path');if(args.expectedSha256!==undefined&&!/^[a-f0-9]{64}$/u.test(args.expectedSha256))fail('invalid_argument');
   await guard('before_read');const value=read(root,args.relativePath,TEXT_EXT.test(name)?maxBytes:maxBinaryBytes,args.signal);if(args.expectedSha256&&value.sha256!==args.expectedSha256)fail('source_changed');await guard('after_read');return{name,mimeType:mimeTypeFor(name),bytes:value.bytes,relativePath:args.relativePath,sha256:value.sha256};
  }catch(error){safeError(error);}},
 });
}
