import {constants,openSync,closeSync,readFileSync,writeFileSync,fsyncSync,renameSync,unlinkSync,lstatSync,fstatSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const validId=value=>typeof value==='string'&&/^wechat-[a-f0-9]{64}$/.test(value);
const instant=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const validTiming=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>['receivedAt','providerCreatedAt','textHash'].includes(k))&&instant(value.receivedAt)&&(value.providerCreatedAt===undefined||instant(value.providerCreatedAt))&&(value.textHash===undefined||/^[a-f0-9]{64}$/.test(value.textHash));
const same=(a,b)=>a&&b&&a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;

// Separate private sidecar; old Family versions can continue reading their
// unchanged gateway ledger. Missing or damaged evidence never grants timing.
export function createInboundTimingLedger({directory,maxEntries=4000,fileName='owner-inbound-timing.json'}={}){
 if(!['owner-inbound-timing.json','owner-reminder-admission.json'].includes(fileName))throw Error('invalid timing ledger name');
 if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>4000)throw Error('invalid timing retention');
 const file=join(directory,fileName);let failed=false,identity=null,rows=[];
 function inspect(){try{const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o077)!==0||(typeof process.getuid==='function'&&stat.uid!==process.getuid())||stat.size>1024*1024)throw Error('timing ledger unavailable');return stat;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 try{identity=inspect();if(identity){let fd;try{fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);if(!same(identity,fstatSync(fd)))throw Error('timing ledger changed');const value=JSON.parse(readFileSync(fd,'utf8'));if(value?.version!==1||!Array.isArray(value.rows)||value.rows.length>4000||value.rows.some(row=>!validId(row?.id)||!validTiming(row?.timing))||new Set(value.rows.map(row=>row.id)).size!==value.rows.length)throw Error('timing ledger invalid');rows=value.rows;}finally{if(fd!==undefined)closeSync(fd);}}}catch{failed=true;}
 const unchanged=()=>{const current=inspect();return identity===null?current===null:same(identity,current);};
 function recordFirst(id,timing){if(failed||!validId(id)||!validTiming(timing))return false;try{if(!unchanged())throw Error('timing ledger changed');if(rows.some(row=>row.id===id))return false;const next=[...(maxEntries===1?[]:rows.slice(-(maxEntries-1))),{id,timing:structuredClone(timing)}],temp=join(directory,'.owner-inbound-timing-'+randomUUID()+'.tmp');let fd;try{fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,JSON.stringify({version:1,rows:next}));fsyncSync(fd);closeSync(fd);fd=undefined;if(!unchanged())throw Error('timing ledger changed');renameSync(temp,file);const parent=openSync(directory,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(parent);}finally{closeSync(parent);}identity=inspect();rows=next;return true;}finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temp);}catch{}}}catch{failed=true;return false;}}
 function get(id){if(failed||!validId(id))return null;try{if(!unchanged())throw Error('timing ledger changed');const found=rows.find(row=>row.id===id);return found?structuredClone(found.timing):null;}catch{failed=true;return null;}}
 return{recordFirst,get};
}
