import {existsSync,mkdirSync,lstatSync,readFileSync,writeFileSync,renameSync,unlinkSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

const clone=value=>structuredClone(value);
const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const sameRoute=(a,b)=>a&&b&&['personId','accountId','peerId','generation'].every(k=>a[k]===b[k]);
const fail=text=>{throw new Error(text);};
const statusNames={collecting:'等待补充材料',queued:'等待制作',generating:'正在制作',ready:'文件已生成',dispatching:'正在提交文件',api_accepted:'文件已提交微信接口',uncertain:'文件发送结果待核对',failed:'制作或提交未完成',cancelled:'已取消',interrupted:'制作已中断，可继续'};
const ppt=/\bppt(?:x)?\b|幻灯片|演示文稿/i;
const revision=/再.{0,8}(?:短|长|大|小|改)|第.{1,8}页|(?:上一份|昨天那份|刚才那份|这份|继续|接着做|重试|重新发送|再发)|(?:加|删|修改).{0,8}页/;
const progress=/^(?:请问|请)?(?:(?:我的|这个|这份|那个)?(?:PPT|ppt|演示文稿|幻灯片)?)?(?:做好了吗|做完了吗|进度(?:怎么样)?|(?:做)?到哪(?:了)?|状态)[。！？?!\s]*$/;
const resend=/^(?:请)?(?:重试|重新发送|再发(?:一次|一遍)?|确认重新发送)(?:这(?:个|份))?(?:PPT|ppt|演示文稿|幻灯片|文件)?[。！!\s]*$/;
const resume=/^(?:请)?(?:继续|接着做|接着制作|恢复)(?:这(?:个|份))?(?:PPT|ppt|演示文稿|幻灯片|制作|任务)?[。！!\s]*$/;
const confirmedResend=/^(?:请)?确认重新发送(?:这(?:个|份))?(?:PPT|ppt|演示文稿|幻灯片|文件)?[。！!\s]*$/;
const concreteRevision=/第.{1,8}页|(?:加|删|修改|改成|改为|增加|减少|缩短|扩展|调整|更新|换成|补充)|(?:字|文字|内容|字体).{0,8}(?:大|小|短|长)/;
const unknownReply='上次文件可能已发出，请先核对微信。确实需要再发时，请说“确认重新发送”。';
export const isPresentationCancel=text=>/^(?:请)?(?:取消|停止|不要做|不做)(?:这(?:个|份))?(?:PPT|ppt|演示文稿|幻灯片|制作|任务|了)?[。！!\s]*$/.test(text.trim());
function safeText(value,max){if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))fail('PPT资料为空或超过限制。');return value;}
function checkState(s){
 if(!s||s.version!==1||!s.services||typeof s.services!=='object'||Array.isArray(s.services)||!Array.isArray(s.tasks)||!Array.isArray(s.inputs)||s.tasks.length>500||s.inputs.length>10000)fail('PPT任务记录格式不受支持，请保留数据后检查版本。');
 for(const task of s.tasks){if(!/^[a-z0-9-]{1,80}$/i.test(task.id??'')||!statusNames[task.status]||!Number.isSafeInteger(task.version)||task.version<0||!Array.isArray(task.versions)||!Array.isArray(task.materials)||!Array.isArray(task.instructions)||!sameRoute(task.route,{...task.route,personId:task.personId}))fail('PPT任务记录格式不受支持，请保留数据后检查版本。');}
}
function syncDirectory(directory){const fd=openSync(directory,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function atomic(file,data){
 if(existsSync(file)&&lstatSync(file).isSymbolicLink())fail('PPT记录路径无效。');
 const bytes=JSON.stringify(data,null,2)+'\n';if(Buffer.byteLength(bytes)>32*1024*1024)fail('PPT记录达到容量上限，请先归档。');
 const tmp=file+'.'+randomUUID()+'.tmp';let fd;
 try{fd=openSync(tmp,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(tmp,file);syncDirectory(dirname(file));}finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(tmp);}catch{}}
}
function userError(error){
 if(/^presentation_model_[a-z_]+$/.test(error?.code??''))return'材料已保留。你可以说“继续”，我再试一次。';
 const message=String(error?.message??'请稍后重试。');
 if(error?.code||error?.path||error?.syscall||/\/(?:Users|var|private|tmp|home|etc)\//.test(message))return'文件读写暂时失败，已保存的材料和成果会保留。请稍后说“继续”。';
 return /token|bearer|credential|secret|https?:\/\//i.test(message)?'请稍后重试。':message.slice(0,180);
}

/** Fixed PPT capability. Admission is durable before the channel checkpoints an inbound page. */
export function createPresentationWorkflow({directory,store,generate,extract,download,send,defaultEnabled=false,now=()=>new Date().toISOString()}={}){
 const file=join(directory,'presentations.json'),artifacts=join(directory,'presentation-files');
 if(existsSync(file)&&lstatSync(file).isSymbolicLink())fail('PPT记录路径无效。');
 const state=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{version:1,services:{},tasks:[],inputs:[]};checkState(state);
 const controllers=new Map();let closed=false;
 const persist=()=>{checkState(state);atomic(file,state);};
 let recovered=false;
 for(const task of state.tasks){
  if(['queued','generating'].includes(task.status)){task.status='interrupted';task.detail='上次制作中断，告诉我继续即可。';recovered=true;}
  if(task.status==='dispatching'){task.status='uncertain';task.detail='上次文件提交没有明确结果，请先核对手机。';recovered=true;}
 }
 for(const input of state.inputs)if(['planned','queued','running'].includes(input.status)){input.status='interrupted';recovered=true;}
 if(recovered)persist();
 function service(personId){store.person(personId);return state.services[personId]??{enabled:defaultEnabled===true,epoch:0};}
 function latest(personId,route){return state.tasks.filter(t=>t.personId===personId&&sameRoute(t.route,route)).at(-1);}
 function update(task,status,detail=statusNames[status]){task.status=status;if(status!=='failed')delete task.errorCode;task.detail=detail;task.updatedAt=now();persist();}
 function invalidate(personId,route){
  for(const {personId:id,control} of controllers.values())if(id===personId)control.abort();
  const last=route?latest(personId,route):null;
  for(const task of state.tasks.filter(t=>t.personId===personId&&(!route||sameRoute(t.route,route)))){
   if(task===last||['collecting','queued','generating','ready','interrupted'].includes(task.status)){
    task.cancelEpoch=(task.cancelEpoch??0)+1;
    delete task.pendingMaterials;
    if(!['dispatching','uncertain'].includes(task.status)){task.status='cancelled';task.detail='后续制作已取消，已提交的文件无法撤回。';task.updatedAt=now();}
   }
  }
  for(const input of state.inputs)if(input.personId===personId&&(!route||sameRoute(input.route,route))&&['preparing','planned','queued','running','interrupted'].includes(input.status)){input.status='cancelled';delete input.payload;}
 }
 function configure(personId,enabled){
  if(store.person(personId).role!=='elder'||typeof enabled!=='boolean')fail('请选择家人并明确开启或停用PPT。');
  if(enabled&&(!generate||!extract||!download||!send))fail('PPT制作依赖尚未就绪，未开通。');
  const old=service(personId);if(old.enabled===enabled){
   if(!Object.hasOwn(state.services,personId)){state.services[personId]={enabled,epoch:old.epoch};persist();}
   return;
  }
  state.services[personId]={enabled,epoch:old.epoch+1};if(!enabled)invalidate(personId);persist();
 }
 function snapshot(){return{available:Boolean(generate&&extract&&download&&send),people:store.snapshot().people.filter(p=>p.role==='elder').map(p=>({personId:p.id,enabled:service(p.id).enabled})),tasks:state.tasks.map(t=>{const p=store.person(t.personId);return{id:t.id,personId:t.personId,bindingGeneration:t.route.generation,status:t.status,version:t.version,detail:statusNames[t.status],updatedAt:t.updatedAt,...(p.shareWithOwner!=='none'&&t.deck?{title:t.deck.title}:{})};})};}
 function cancelIfRequested(personId,route,text){
  if(!isPresentationCancel(text)||!sameRoute(store.binding(personId),route)||!latest(personId,route))return false;
  invalidate(personId,route);persist();return true;
 }
 function eligible(person,route,message){
  if(closed||person.role!=='elder'||!service(person.id).enabled||!sameRoute(store.binding(person.id),route))return false;
  const text=typeof message.text==='string'?message.text:'',task=latest(person.id,route);
  return Boolean(message.attachments?.length||ppt.test(text)||(task&&(revision.test(text)||resume.test(text)||progress.test(text.trim())||isPresentationCancel(text)||task.status==='collecting')));
 }
 function inputKey(route,message){return hash([route,message.id]);}
 function fingerprint(message){return hash([message.text??'',message.attachments??[]]);}
 // Called before family.json inbound dedup: a crash between those two durable
 // writes still leaves either an unseen message or an explicitly replayable preparation.
 function admit({person,route,message}){
  if(!eligible(person,route,message))return null;
  const key=inputKey(route,message),digest=fingerprint(message),old=state.inputs.find(i=>i.key===key);
  if(old){if(old.fingerprint&&old.fingerprint!==digest)fail('同一消息标识的材料发生变化，请作为新消息重新发送。');return{key,retryable:old.status==='preparing',created:false};}
  if(state.inputs.length>=10000)fail('PPT任务记录已满，请联系家庭联系人归档。');
  const text=safeText(message.text??'',6000),attachments=message.attachments??[];
  if(!Array.isArray(attachments)||attachments.length>4||Buffer.byteLength(JSON.stringify(attachments))>64*1024)fail('每次最多发送四份PPT资料，文件描述不能超过限制。');
  state.inputs.push({key,fingerprint:digest,personId:person.id,route:clone(route),epoch:service(person.id).epoch,status:'preparing',at:now(),reply:null,payload:{text,attachments:clone(attachments)}});persist();
  return{key,retryable:false,created:true};
 }
 function discardAdmission(admission){if(!admission?.created)return;const input=state.inputs.find(i=>i.key===admission.key);if(input?.status==='preparing'){input.status='discarded';delete input.payload;persist();}}
 function result(input,reply){input.reply=reply??null;if(input.status!=='cancelled')input.status='done';delete input.payload;persist();return{handled:true,reply:reply??null};}
 async function handle({person,route,message,signal,authorize=()=>true,defer=false,admission}){
  if(!eligible(person,route,message))return{handled:false};
  const text=safeText(message.text??'',6000),attachments=message.attachments??[];
  if(!Array.isArray(attachments)||attachments.length>4)fail('每次最多发送四份PPT资料。');
  const key=inputKey(route,message);admission??=admit({person,route,message});
  const input=state.inputs.find(i=>i.key===key);
  if(!input||admission?.key!==key||input.status!=='preparing')return{handled:true,reply:null};
  if(input.fingerprint!==fingerprint(message))fail('同一消息标识的材料发生变化，请作为新消息重新发送。');
  const epoch=input.epoch;
  const valid=()=>!closed&&!signal?.aborted&&authorize()&&service(person.id).enabled&&service(person.id).epoch===epoch&&sameRoute(store.binding(person.id),route);
  if(!valid())return result(input,null);
  let task=input.taskId?state.tasks.find(t=>t.id===input.taskId&&t.personId===person.id&&sameRoute(t.route,route)):latest(person.id,route);
  if(isPresentationCancel(text)){cancelIfRequested(person.id,route,text);return result(input,task?'后续制作已取消，已提交的文件无法撤回。':'目前没有正在制作的PPT。');}
  if(task&&progress.test(text.trim()))return result(input,statusNames[task.status]+'。');
  if(!task&&(revision.test(text)||resume.test(text))&&!attachments.length&&!/做(?:个|一个|一份|成)|新/.test(text))return result(input,'没有找到当前微信绑定下的上一份PPT，请发材料或说明新需求。');
  const fresh=/新(?:的|建|做|开|一份|一个)|重新做(?:一|个)/.test(text);
  if(!input.taskId&&(!task||fresh||task.status==='cancelled')){
   if(state.tasks.length>=500)fail('PPT任务记录已满，请联系家庭联系人归档。');
   task={id:randomUUID(),personId:person.id,route:clone(route),epoch,cancelEpoch:0,status:'collecting',version:0,versions:[],materials:[],instructions:[],detail:'等待材料或用途',createdAt:now(),updatedAt:now()};state.tasks.push(task);
  }
  if(!task)return result(input,'没有找到这次PPT任务，请重新说明需求。');
  const cancelEpoch=task.cancelEpoch??0;
  const taskLive=()=>valid()&&(task.cancelEpoch??0)===cancelEpoch&&task.status!=='cancelled'&&input.status!=='cancelled';
  const blockedUnknown=()=>task.status==='uncertain'&&!confirmedResend.test(text.trim())&&!fresh&&(resume.test(text.trim())||resend.test(text.trim())||!concreteRevision.test(text));
  if(blockedUnknown())return result(input,unknownReply);
  input.taskId=task.id;input.cancelEpoch=cancelEpoch;
  const isResend=resend.test(text.trim());
  if(!input.instructionStored&&text.trim()&&!isResend&&!resume.test(text.trim())){
   if(task.instructions.length>=60)fail('这份PPT的修改次数已达上限，请开始新任务。');
   task.instructions.push(text);input.instructionStored=true;
  }
  // Keep only the private, bounded descriptors while a download is pending.
  // This commit must precede returning to polling: later cancellation can then
  // interrupt both preparation and generation without losing the input on crash.
  if(!input.materialsStored){
   task.pendingMaterials??=[];
   for(const attachment of attachments)task.pendingMaterials.push({inputKey:key,attachment:clone(attachment)});
   input.materialsStored=true;
  }
  delete input.payload;
  input.instructionCount=task.instructions.length;input.status='planned';
  if(!['generating','dispatching'].includes(task.status)){task.status='queued';task.detail=statusNames.queued;task.updatedAt=now();}
  persist();
  async function run(){
   if(input.status!=='planned')return{handled:true,reply:null};
   if(!taskLive()){if(task.status!=='cancelled')update(task,'interrupted');return result(input,null);}
   if(blockedUnknown())return result(input,unknownReply);
   input.status='running';persist();
   const control=new AbortController();controllers.set(key,{personId:person.id,control});
   const combined=AbortSignal.any([control.signal,AbortSignal.timeout(180000),...(signal?[signal]:[])]);
   const live=()=>taskLive()&&!combined.aborted;
   const interrupted=()=>{if(task.status==='cancelled')return result(input,null);input.status='interrupted';input.reply=null;update(task,'interrupted');return{handled:true,reply:null};};
   try{
    const inputOrder=state.inputs.indexOf(input);
    // An explicit continuation may recover earlier unfinished material, but
    // cannot pull a later queued request's attachment into an earlier draft.
    for(const pending of [...(task.pendingMaterials??[])].filter(p=>{const index=state.inputs.findIndex(i=>i.key===p.inputKey);return index>=0&&index<=inputOrder;})){
     if(!live())return interrupted();
     const material=await download(route,pending.attachment,{signal:combined,authorize:live});
     if(!live())return interrupted();
     if(!Buffer.isBuffer(material.bytes)||material.bytes.length>10*1024*1024)fail('材料超过10MB，请拆分后发送。');
     const digest=hash(material.bytes);
     if(!task.materials.some(m=>m.hash===digest)){
      let value;
      try{
       value=await extract(material);safeText(value.name,180);safeText(value.text,40000);
       if(task.materials.length>=8||task.materials.reduce((n,m)=>n+m.text.length,0)+value.text.length>80000)fail('这份PPT的材料太多，请分成另一份PPT。');
      }catch(error){
       // Re-downloading the same rejected bytes cannot repair the document.
       // Keep the request and accepted material, allowing a replacement upload.
       task.pendingMaterials=(task.pendingMaterials??[]).filter(p=>p!==pending);if(!task.pendingMaterials.length)delete task.pendingMaterials;persist();throw error;
      }
      if(!live())return interrupted();
      task.materials.push({name:value.name,text:value.text,hash:digest});
     }
     task.pendingMaterials=task.pendingMaterials.filter(p=>p!==pending);if(!task.pendingMaterials.length)delete task.pendingMaterials;
     persist();
    }
    if(!input.instructionCount&&!isResend){update(task,'collecting');return result(input,'材料已保存到这次PPT任务。告诉我用途、想讲什么或希望几页，我来制作。');}
    input.materialCount=task.materials.length;persist();
    let output;
    if(isResend&&task.version>0){
     const v=task.versions.at(-1);
     if(!/^[a-z0-9-]+-v\d+(?:-[a-z0-9-]+)?\.pptx$/i.test(v.file))fail('保存的成果路径无效。');
     const path=join(artifacts,v.file);if(lstatSync(path).isSymbolicLink())fail('保存的成果路径无效。');
     const bytes=readFileSync(path);if(hash(bytes)!==v.hash)fail('保存的成果校验失败，未发送。');
     output={bytes,name:v.name,deck:task.deck};
    }else{
     if(task.version>=50)fail('这份PPT的修改次数已达上限，请开始新任务。');
     task.epoch=epoch;update(task,'generating');
     output=await generate({request:task.instructions.slice(0,input.instructionCount).slice(-12).join('\n'),materials:clone(task.materials.slice(0,input.materialCount).map(({name,text})=>({name,text}))),...(task.deck?{previous:clone(task.deck)}:{}),preferences:person.notes??'',signal:combined});
     if(!live())return interrupted();
     if(output.needsInput){update(task,'collecting');return result(input,safeText(output.reply,3000));}
     if(!Buffer.isBuffer(output.bytes)||output.bytes.length>10*1024*1024||!output.deck||typeof output.name!=='string'||!output.name.endsWith('.pptx')||/[\\/\u0000-\u001f]/.test(output.name))fail('PPT生成结果无效，尚未交付。');
     if(existsSync(artifacts)&&lstatSync(artifacts).isSymbolicLink())fail('成果目录无效。');mkdirSync(artifacts,{recursive:true,mode:0o700});
     // A unique artifact name lets a retry proceed after a crash between file
     // creation and the atomic task commit without overwriting any old version.
     const version=task.version+1,filename=task.id+'-v'+version+'-'+randomUUID()+'.pptx';
     const fd=openSync(join(artifacts,filename),'wx',0o600);try{writeFileSync(fd,output.bytes);fsyncSync(fd);}finally{closeSync(fd);}syncDirectory(artifacts);
     task.deck=clone(output.deck);task.version=version;task.versions.push({number:version,file:filename,name:output.name,hash:hash(output.bytes)});update(task,'ready');
    }
    if(!live())return interrupted();
    const clientId='family-ppt-'+randomUUID();task.attemptId=clientId;update(task,'dispatching');
    try{
     const receipt=await send(route,{name:output.name,bytes:output.bytes},{clientId,signal:combined,authorize:live});
     if(receipt?.status!=='api_accepted')throw Object.assign(new Error('文件提交结果不明。'),{sendOutcome:'uncertain'});
     store.addMessage(person.id,{id:'file-'+clientId,dir:'out',text:'[PPT文件] '+output.name,kind:'presentation_file',attachments:[{name:output.name,size:output.bytes.length,mimeType:'application/vnd.openxmlformats-officedocument.presentationml.presentation'}]});
     update(task,'api_accepted');return result(input,`第${task.version}版PPT已提交微信接口，请查看文件。可以继续说“第三页再短一点”等修改要求。`);
    }catch(error){update(task,error.sendOutcome==='failed'?'failed':'uncertain');return result(input,task.status==='uncertain'?'PPT已生成，但文件发送结果尚未确认。请先看微信是否有文件，我不会自动重发。':'PPT已生成，文件尚未成功提交。恢复连接后告诉我“重新发送”即可。');}
   }catch(error){
    if(!live())return interrupted();
    if(/^presentation_model_[a-z_]+$/.test(error?.code??''))task.errorCode=error.code;else delete task.errorCode;
    update(task,'failed');return result(input,'这次PPT没有完成。'+userError(error));
   }finally{if(controllers.get(key)?.control===control)controllers.delete(key);}
  }
  return defer?{handled:true,reply:null,run}:run();
 }
 return{configure,snapshot,admit,discardAdmission,handle,cancelIfRequested,close(){closed=true;for(const {control} of controllers.values())control.abort();}};
}
