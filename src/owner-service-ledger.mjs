import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,readFileSync,lstatSync,fstatSync,realpathSync,renameSync,unlinkSync,constants} from 'node:fs';
import {join,resolve} from 'node:path';

const fail=message=>{throw Object.assign(new Error(message),{code:'service_owner_view_invalid'});};
const bounded=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/u.test(value);
const revision=value=>Number.isSafeInteger(value)&&value>0;
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const legacyFields=['sessionId','sourceRequestId','personId','origin','contextId','draftId','revision','at'];
const fields=['sessionId','sourceRequestId','personId','origin','contextId','draftId','revision','marker','summaryHash','at'];

/** Human-readable version tag kept beside the draft in the delivered reply.
 * It lets the runtime tell two revisions apart even when their summaries are
 * identical; the Owner only has to say “确认”, never copy this tag back. */
export const serviceDraftMarker=value=>`草稿第 ${value} 版`;
export const serviceDraftSummaryHash=value=>createHash('sha256').update(value).digest('hex');

/** 每个 Owner 原生会话真正展示过的那份服务草稿：只记来源、版本、可读版本
 * 标记与摘要指纹，不记正文、凭据或模型参数。确认时用它判断“上一轮同一会话
 * 唯一展示的草稿”，并用标记把实际出站回复绑定到确切版本——同一草稿两版
 * 即使摘要相同也不会串版。工作台和 HTTP 的旧草稿不写入这里，也就不会被
 * 当成展示过的草稿；旧版记录没有版本标记与摘要指纹，一律不用于确认。 */
export function createOwnerServiceLedger({directory,now=()=>new Date().toISOString(),limit=500}={}){
  if(!bounded(directory,4096))fail('服务草稿展示记录需要私有数据目录。');
  const requested=resolve(directory);let before;try{before=lstatSync(requested);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(before&&(before.isSymbolicLink()||!before.isDirectory()))fail('服务草稿展示记录目录不能是链接。');
  mkdirSync(requested,{recursive:true,mode:0o700});
  const root=realpathSync(requested),identity=lstatSync(root),file=join(root,'owner-service-drafts.json');
  const secure=(optional=false)=>{const info=lstatSync(root);if(info.isSymbolicLink()||!info.isDirectory()||info.dev!==identity.dev||info.ino!==identity.ino||realpathSync(root)!==root)fail('服务草稿展示记录目录已改变。');let stat;try{stat=lstatSync(file);}catch(error){if(error.code==='ENOENT'&&optional)return null;throw error;}if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)||stat.size>1024*1024)fail('服务草稿展示记录路径或权限无效。');return stat;};
  const legacy=state=>state&&typeof state==='object'&&!Array.isArray(state)&&[Object.prototype,null].includes(Object.getPrototypeOf(state))&&Object.keys(state).every(key=>['version','views'].includes(key))&&state.version===1&&Array.isArray(state.views)&&state.views.length<=limit&&state.views.every(row=>row&&typeof row==='object'&&!Array.isArray(row)&&[Object.prototype,null].includes(Object.getPrototypeOf(row))&&Object.keys(row).length===legacyFields.length&&legacyFields.every(key=>Object.hasOwn(row,key))&&[row.sessionId,row.sourceRequestId,row.personId,row.contextId,row.draftId].every(value=>bounded(value,512))&&row.origin==='wechat'&&revision(row.revision)&&bounded(row.at,60)&&Number.isFinite(Date.parse(row.at)))&&new Set(state.views.map(row=>[row.sessionId,row.sourceRequestId,row.draftId].join('\0'))).size===state.views.length;
  const valid=state=>state&&typeof state==='object'&&!Array.isArray(state)&&[Object.prototype,null].includes(Object.getPrototypeOf(state))&&Object.keys(state).every(key=>['version','views'].includes(key))&&state.version===2&&Array.isArray(state.views)&&state.views.length<=limit&&state.views.every(row=>row&&typeof row==='object'&&!Array.isArray(row)&&[Object.prototype,null].includes(Object.getPrototypeOf(row))&&Object.keys(row).length===fields.length&&fields.every(key=>Object.hasOwn(row,key))&&[row.sessionId,row.sourceRequestId,row.personId,row.contextId,row.draftId].every(value=>bounded(value,512))&&row.origin==='wechat'&&revision(row.revision)&&bounded(row.marker,80)&&digest(row.summaryHash)&&bounded(row.at,60)&&Number.isFinite(Date.parse(row.at)))&&new Set(state.views.map(row=>[row.sessionId,row.sourceRequestId,row.draftId].join('\0'))).size===state.views.length;
  const read=()=>{const stat=secure();let fd;try{fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);const opened=fstatSync(fd);if(opened.dev!==stat.dev||opened.ino!==stat.ino||opened.nlink!==1)fail('服务草稿展示记录读取时发生变化。');const state=JSON.parse(readFileSync(fd,'utf8'));if(valid(state))return state;
    // Old records lack the version marker and display hash, so they cannot
    // prove which revision actually reached the Owner. Keep the file readable
    // but expose no evidence until a new display is recorded.
    if(legacy(state))return{version:2,views:[]};fail('服务草稿展示记录格式无效。');}finally{if(fd!==undefined)closeSync(fd);}};
  const write=state=>{if(!valid(state))fail('服务草稿展示记录格式无效。');const body=JSON.stringify(state);secure(true);const temporary=join(root,'.owner-service-drafts-'+randomUUID()+'.tmp');let fd;try{fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,body);fsyncSync(fd);closeSync(fd);fd=undefined;secure(true);renameSync(temporary,file);const parent=openSync(root,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(parent);}finally{closeSync(parent);}}finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch{}}};
  if(!secure(true))write({version:2,views:[]});
  return Object.freeze({
    /** 同一轮里重复展示/修改同一份草稿只留一条，保留最新版本与标记。 */
    record({sessionId,sourceRequestId,personId,origin,contextId,draftId,revision:value,summary,marker}={}){
      if(![sessionId,sourceRequestId,personId,contextId,draftId].every(item=>bounded(item,512))||origin!=='wechat'||!revision(value)||typeof summary!=='string'||!summary.trim()||summary.length>6000||!bounded(marker,80))fail('服务草稿展示记录参数无效。');
      const at=new Date(now());if(!Number.isFinite(+at))fail('服务草稿展示记录时间无效。');
      const state=read(),row={sessionId,sourceRequestId,personId,origin,contextId,draftId,revision:value,marker,summaryHash:serviceDraftSummaryHash(summary),at:at.toISOString()};
      const index=state.views.findIndex(item=>item.sessionId===sessionId&&item.sourceRequestId===sourceRequestId&&item.draftId===draftId);
      if(index<0)state.views.push(row);else state.views[index]=row;
      if(state.views.length>limit)state.views.splice(0,state.views.length-limit);
      write(state);return{...row};
    },
    view({sessionId,sourceRequestId,personId,contextId}={}){
      if(![sessionId,personId,contextId].every(item=>bounded(item,512))||!bounded(sourceRequestId,512))return[];
      return read().views.filter(row=>row.sessionId===sessionId&&row.sourceRequestId===sourceRequestId&&row.personId===personId&&row.origin==='wechat'&&row.contextId===contextId).map(row=>({...row}));
    },
    /** Every draft id this Owner actually saw in this same native session. Used
     * only to keep those identifiers out of the Owner-facing final text; the
     * model's tool result and the confirmation path keep the full reference. */
    idsFor({sessionId,personId,contextId}={}){
      if(![sessionId,personId,contextId].every(item=>bounded(item,512)))return[];
      return [...new Set(read().views.filter(row=>row.sessionId===sessionId&&row.personId===personId&&row.origin==='wechat'&&row.contextId===contextId).map(row=>row.draftId))];
    },
  });
}
