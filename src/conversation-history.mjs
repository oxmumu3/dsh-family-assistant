import {createHash} from 'node:crypto';

const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(value);
const cursorPattern=/^fh1_[A-Za-z0-9_-]{43}$/;
const fields=['viewerPersonId','personId','before','limit','query'];
const source=()=>({
  kind:'family_store_messages',
  description:'本机现存家庭助手消息归档；入站与接口已接受的出站文本，不等于微信全部历史、手机送达或已读。附件仅展示已保存的名称、类型和大小；旧记录可能缺附件信息，不代表可下载原件。',
  supportsAttachments:true
});
const fail=(message,code='INVALID_ARGUMENT')=>{const error=new Error(message);error.code=code;throw error;};
const messageCursor=message=>'fh1_'+createHash('sha256').update(JSON.stringify(['family-history-v1',message.personId,message.dir,message.id])).digest('base64url');

function optionsOf(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))fail('聊天记录参数必须为对象。');
  if(Object.keys(input).some(key=>!fields.includes(key)))fail('聊天记录参数包含不支持的字段。');
  if(!safeId(input.viewerPersonId)||!safeId(input.personId))fail('成员标识无效。');
  const limit=input.limit===undefined?50:input.limit;
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('分页消息数量须为 1 到 100 的整数。');
  if(input.before!==undefined&&(typeof input.before!=='string'||!cursorPattern.test(input.before)))fail('分页标识无效，请重新打开聊天记录。','INVALID_CURSOR');
  if(input.query!==undefined&&(typeof input.query!=='string'||input.query.length>200||/[\x00-\x1f\x7f]/u.test(input.query)))fail('搜索文字无效。');
  return{viewerPersonId:input.viewerPersonId,personId:input.personId,limit,before:input.before,query:input.query?.trim()??''};
}
function projectMessage(message){
  if(!message||typeof message!=='object'||typeof message.id!=='string'||!message.id||!['in','out'].includes(message.dir)||typeof message.text!=='string'||typeof message.kind!=='string'||typeof message.at!=='string'||!Number.isFinite(Date.parse(message.at)))fail('本机聊天归档格式不受支持，请保留数据后检查。','INVALID_ARCHIVE');
  // A future storage field must not accidentally expose routes, credentials,
  // attachment descriptors or unrelated metadata through this read-only API.
  return{id:message.id,personId:message.personId,dir:message.dir,text:message.text,kind:message.kind,at:message.at,...(Array.isArray(message.attachments)&&message.attachments.length?{attachments:message.attachments.map(({name,size,mimeType})=>({name,...(size!==undefined?{size}:{}),...(mimeType?{mimeType}:{})}))}:{})};
}

/**
 * Owner-only, read-only pagination of records still present in the local store.
 * Pages are in chronological order. before is an opaque identity anchor, never
 * an offset, so appending new messages does not shift earlier page boundaries.
 */
export function createConversationHistory({store}={}){
  if(!store||typeof store.snapshot!=='function')fail('聊天存储 store 不可用。');
  return Object.freeze({
    page(input){
      const options=optionsOf(input);
      // Direct Owner access is independent of the member's brief sharing choice.
      // One fresh snapshot supplies authorization and data, so a revoked Owner
      // role cannot keep reading through cached authorization.
      const state=store.snapshot();
      if(!state||!Array.isArray(state.people)||!Array.isArray(state.messages))fail('本机聊天归档格式不受支持，请保留数据后检查。','INVALID_ARCHIVE');
      const viewer=state.people.find(person=>person.id===options.viewerPersonId);
      if(!viewer||viewer.role!=='owner')fail('只有已登记 Owner 可以查看家庭聊天记录。','FORBIDDEN');
      const person=state.people.find(item=>item.id===options.personId);
      if(!person)fail('没有找到这位家人。','NOT_FOUND');
      const metadata={personId:person.id,historyScope:'available_local_records',source:source()};
      const rows=state.messages.filter(message=>message?.personId===person.id).map((message,index)=>{
        const projected=projectMessage(message);
        return{message:projected,index,instant:Date.parse(projected.at),cursor:messageCursor(projected)};
      }).filter(row=>!options.query||[row.message.text,...(row.message.attachments??[]).map(file=>file.name)].some(value=>value.toLocaleLowerCase().includes(options.query.toLocaleLowerCase()))).sort((left,right)=>left.instant-right.instant||left.index-right.index);
      let end=rows.length;
      if(options.before!==undefined){
        end=rows.findIndex(row=>row.cursor===options.before);
        if(end<0)fail('分页标识不属于这份现存归档，请重新打开聊天记录。','INVALID_CURSOR');
      }
      const start=Math.max(0,end-options.limit),selected=rows.slice(start,end),hasMore=start>0;
      return{...metadata,access:'full',available:true,messages:selected.map(row=>row.message),total:rows.length,hasMore,nextCursor:hasMore?selected[0].cursor:null};
    }
  });
}
