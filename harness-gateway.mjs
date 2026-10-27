import {mkdirSync,lstatSync,realpathSync,openSync,readFileSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync,constants} from 'node:fs';
import {join,isAbsolute,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createOwnerTaskArtifactScope,ownerTaskArtifactInstructions,sanitizeOwnerTaskText} from './owner-task-artifacts.mjs';

const clone=value=>structuredClone(value);
const states=['queued','running','needs_approval','needs_input','unknown','succeeded','failed','cancelled','cancelling'];
const terminal=state=>['succeeded','failed','cancelled'].includes(state);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const text=(value,max=24000,empty=false)=>typeof value==='string'&&value.length<=max&&(empty||value.trim())&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const object=(value,keys)=>value&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Object.keys(value).every(key=>keys.includes(key));
const routeKeys=['personId','accountId','peerId','generation'];
const validRoute=route=>object(route,routeKeys)&&routeKeys.every(key=>Object.hasOwn(route,key))&&id(route.personId)&&text(route.accountId,200)&&text(route.peerId,200)&&Number.isSafeInteger(route.generation)&&route.generation>0;
const sameRoute=(a,b)=>validRoute(a)&&b&&routeKeys.every(key=>a[key]===b[key]);
const fingerprint=input=>createHash('sha256').update(JSON.stringify([input.personId,input.route?routeKeys.map(key=>input.route[key]):null,input.workspaceId,input.prompt,...(input.origin==='console'?['console']:[]),...(input.deliveryTarget?[['delivery-target',input.deliveryTarget.personId,routeKeys.map(key=>input.deliveryTarget.route[key])]]:[]),...(input.conversationId!==undefined?[['conversation',input.conversationId]]:[])])).digest('hex');
const taskFields=['id','personId','route','workspaceId','workspaceTitle','cwd','sessionId','requestId','sourceRequestId','fingerprint','prompt','createdAt','updatedAt','state','text','notice','pendingApprovals','delivery','origin','turns','executor','permissionRevision','files','artifactDeliveries','deliveryTarget','artifactScope','conversationId'];
function validFiles(files,personId,scope){return Array.isArray(files)&&files.length<=20&&files.every(file=>object(file,['relativePath','name','sha256'])&&text(file.name,180)&&!/[\\/]/.test(file.name)&&text(file.relativePath,1024)&&file.relativePath.startsWith('family-output/'+personId+'/')&&!file.relativePath.split('/').some(part=>!part||part.startsWith('.'))&&(scope?/\.(md|txt|csv|json|pptx|docx|xlsx|pdf)$/i:/\.(md|txt|csv|json)$/i).test(file.relativePath)&&(file.sha256===undefined||/^[a-f0-9]{64}$/.test(file.sha256))&&(!scope||file.relativePath===scope.relativeDirectory+'/'+file.name&&typeof file.sha256==='string'));}
const artifactStatuses=['pending','dispatching','api_accepted','unknown','failed','suppressed'];
function validArtifactDeliveries(rows,personId,scope,files=[]){return Array.isArray(rows)&&rows.length<=20&&new Set(rows.map(row=>row.relativePath)).size===rows.length&&rows.every(row=>object(row,['relativePath','clientId','status','updatedAt'])&&files.some(file=>file.relativePath===row.relativePath&&validFiles([file],personId,scope))&&text(row.clientId,100)&&artifactStatuses.includes(row.status)&&Number.isFinite(Date.parse(row.updatedAt)));}
function validTarget(target){return object(target,['personId','route','permissionRevision','createdAt'])&&id(target.personId)&&validRoute(target.route)&&target.route.personId===target.personId&&Number.isSafeInteger(target.permissionRevision)&&target.permissionRevision>=0&&typeof target.createdAt==='string'&&Number.isFinite(Date.parse(target.createdAt));}
function validScope(scope,task,requestId=task.requestId){try{if(!task.deliveryTarget||!object(scope,['personId','relativeDirectory','workspacePathHash']))return false;const expected=createOwnerTaskArtifactScope({personId:task.deliveryTarget.personId,taskId:task.id,requestId,cwd:task.cwd});return Object.keys(expected).every(key=>scope[key]===expected[key]);}catch{return false;}}
function validTask(task){
  if(!object(task,taskFields)||!uuid(task.id)||!id(task.personId)||!text(task.workspaceId,240)||!text(task.workspaceTitle,240)||!text(task.cwd,4096)||!isAbsolute(task.cwd))return false;
  if(task.deliveryTarget!==undefined&&(!validTarget(task.deliveryTarget)||task.deliveryTarget.personId===task.personId||task.executor==='family_project'))return false;
  if(task.artifactScope!==undefined&&!validScope(task.artifactScope,task))return false;
  const recipientId=task.deliveryTarget?.personId??task.personId;
  if(task.files!==undefined&&!validFiles(task.files,recipientId,task.artifactScope)||task.artifactDeliveries!==undefined&&!validArtifactDeliveries(task.artifactDeliveries,recipientId,task.artifactScope,task.files))return false;
  if(task.origin!==undefined&&!['console','wechat'].includes(task.origin)||task.executor!==undefined&&task.executor!=='family_project'||task.executor==='family_project'&&(!Number.isSafeInteger(task.permissionRevision)||task.permissionRevision<1))return false;
  if(task.conversationId!==undefined&&(!uuid(task.conversationId)||task.executor==='family_project'))return false;
  if(task.turns!==undefined&&(!Array.isArray(task.turns)||task.turns.length>1000||!task.turns.every(turn=>object(turn,['requestId','sourceRequestId','fingerprint','prompt','state','text','at','files','artifactDeliveries','artifactScope'])&&uuid(turn.requestId)&&text(turn.sourceRequestId,512)&&/^[a-f0-9]{64}$/.test(turn.fingerprint)&&text(turn.prompt,64000)&&fingerprint({...task,prompt:turn.prompt})===turn.fingerprint&&states.includes(turn.state)&&text(turn.text,24000,true)&&Number.isFinite(Date.parse(turn.at))&&(turn.artifactScope===undefined||validScope(turn.artifactScope,task,turn.requestId))&&(turn.files===undefined||validFiles(turn.files,recipientId,turn.artifactScope))&&(turn.artifactDeliveries===undefined||validArtifactDeliveries(turn.artifactDeliveries,recipientId,turn.artifactScope,turn.files)))))return false;
  return(task.origin==='console'?task.route===null:validRoute(task.route)&&task.route.personId===task.personId)&&task.sessionId===(task.executor==='family_project'?'family_member_':'family_owner_')+(task.conversationId??task.id)&&uuid(task.requestId)&&text(task.sourceRequestId,512)&&/^[a-f0-9]{64}$/.test(task.fingerprint)&&fingerprint(task)===task.fingerprint&&text(task.prompt,64000)&&[task.createdAt,task.updatedAt].every(at=>typeof at==='string'&&Number.isFinite(Date.parse(at)))&&states.includes(task.state)&&text(task.text,24000,true)&&text(task.notice,200,true)&&Number.isSafeInteger(task.pendingApprovals)&&task.pendingApprovals>=0&&object(task.delivery,['state','at'])&&['none','dispatching','accepted','failed','unknown','suppressed'].includes(task.delivery.state)&&(task.delivery.at===undefined||Number.isFinite(Date.parse(task.delivery.at)));
}

/** Single-process durable intent ledger. The enclosing runtime owns its process lock.
 * Source request IDs deduplicate admission; native UUIDs identify one Host turn.
 * A recovered intent is observed, never re-prompted, even after an uncertain start.
 */
export function createHarnessGateway({directory,store,access,ownerAgent,familyProjectExecutor,ownerTaskArtifacts,now=()=>new Date().toISOString(),onResult=async()=>{},recoverOnCreate=true}={}){
  if(!text(directory,4096)||!store||typeof store.snapshot!=='function'||typeof now!=='function'||typeof onResult!=='function'||typeof recoverOnCreate!=='boolean')fail('gateway_invalid_argument');
  directory=resolve(directory);
  const stat=path=>{try{return lstatSync(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
  const initial=stat(directory);if(initial&&(initial.isSymbolicLink()||!initial.isDirectory()))fail('gateway_storage_symlink');
  mkdirSync(directory,{recursive:true,mode:0o700});const canonical=realpathSync(directory),file=join(directory,'harness-tasks.json');
  const checkStorage=()=>{const dir=stat(directory),entry=stat(file);if(!dir||dir.isSymbolicLink()||!dir.isDirectory()||realpathSync(directory)!==canonical||entry&&(entry.isSymbolicLink()||!entry.isFile()||entry.nlink!==1))fail('gateway_storage_symlink');};
  checkStorage();let tasks=[];
  if(stat(file)){
    let fd;try{fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);const data=readFileSync(fd,'utf8');if(data.length>16*1024*1024)fail('gateway_storage_schema');const saved=JSON.parse(data);
      if(!object(saved,['version','tasks'])||saved.version!==1||!Array.isArray(saved.tasks)||saved.tasks.length>2000||!saved.tasks.every(validTask)||new Set(saved.tasks.map(task=>task.id)).size!==saved.tasks.length||['sourceRequestId','requestId'].some(key=>{const values=saved.tasks.flatMap(task=>[task[key],...(task.turns??[]).map(turn=>turn[key])]);return new Set(values).size!==values.length;}))fail('gateway_storage_schema');tasks=saved.tasks;
    }catch(error){if(error.code?.startsWith('gateway_'))throw error;fail('gateway_storage_schema');}finally{if(fd!==undefined)closeSync(fd);}
  }
  function save(next){
    checkStorage();const temporary=join(directory,'.harness-tasks-'+randomUUID()+'.tmp');let fd;
    try{fd=openSync(temporary,'wx',0o600);writeFileSync(fd,JSON.stringify({version:1,tasks:next})+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;checkStorage();renameSync(temporary,file);const dirfd=openSync(directory,'r');try{fsyncSync(dirfd);}finally{closeSync(dirfd);}tasks=next;
    }catch(error){if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch{}throw error;}
  }
  const clock=()=>{const value=now();if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))fail('gateway_invalid_clock');return new Date(value).toISOString();};
  const update=(taskId,patch)=>{const next=clone(tasks),task=next.find(item=>item.id===taskId);Object.assign(task,patch,{updatedAt:clock()});if(!validTask(task))fail('gateway_storage_schema');save(next);return task;};
  const person=(personId,state=store.snapshot())=>{if(!id(personId))fail('gateway_invalid_person');const found=state.people?.find(item=>item.id===personId);if(!found)fail('gateway_person_not_found');return found;};
  function authorize(personId,route,{owner=true,paused=true,origin='wechat'}={}){
    const state=store.snapshot(),who=person(personId,state);if(owner&&who.role!=='owner')fail('protected_executor_required');
    if(origin==='console'){if(who.role!=='owner'||route!==null)fail('gateway_console_forbidden');return who;}
    const binding=state.bindings?.find(item=>item.personId===personId);
    if(!validRoute(route)||route.personId!==personId||!sameRoute(route,binding)||binding.status!=='connected')fail('gateway_route_binding_changed');
    if(paused&&state.config?.paused!==false)fail('gateway_paused');return who;
  }
  function familyAllowed(task,capability='task'){
    if(person(task.personId).role!=='elder')return false;
    return ['read','task',...(capability==='write'?['write']:[])].every(value=>access?.authorize({personId:task.personId,workspaceId:task.workspaceId,capability:value,expectedRevision:task.permissionRevision})?.allowed===true);
  }
  function captureTarget(value){
    if(!object(value,['personId','route'])||!['personId','route'].every(key=>Object.hasOwn(value,key))||!id(value.personId)||!validRoute(value.route)||value.route.personId!==value.personId)fail('gateway_invalid_delivery_target');
    const who=person(value.personId);if(who.role!=='elder')fail('gateway_invalid_delivery_target');
    const target={personId:value.personId,route:clone(value.route),permissionRevision:access?.get?.(value.personId)?.revision??0,createdAt:who.createdAt};
    if(!targetAllowed({deliveryTarget:target}))fail('gateway_delivery_target_changed');return target;
  }
  function targetAllowed(task){
    if(!task.deliveryTarget)return true;
    try{const target=task.deliveryTarget,state=store.snapshot(),who=person(target.personId,state),binding=state.bindings?.find(row=>row.personId===target.personId);return who.role==='elder'&&who.createdAt===target.createdAt&&state.config?.paused===false&&binding?.status==='connected'&&sameRoute(target.route,binding)&&(access?.get?.(target.personId)?.revision??0)===target.permissionRevision;}catch{return false;}
  }
  const eligible=task=>{try{authorize(task.personId,task.route,{origin:task.origin,owner:task.executor!=='family_project'});return task.executor!=='family_project'||familyAllowed(task);}catch{return false;}};
  const conversationPrompt=value=>{const marker='当前 Owner 请求原文：\n',index=value.indexOf(marker);return index<0?value:value.slice(index+marker.length);};
  const publicTask=task=>{const{route,cwd,fingerprint:hash,...view}=task;if(view.deliveryTarget)view.deliveryTarget={personId:view.deliveryTarget.personId};if(task.conversationId){view.workspaceTitle='乐乐主对话';view.prompt=conversationPrompt(view.prompt);if(view.turns)view.turns=view.turns.map(turn=>({...turn,prompt:conversationPrompt(turn.prompt)}));}return clone(view);};
  // Only the trusted Owner console uses this projection. Member contexts and
  // outward briefs use their own scope; brief sharing does not limit direct review.
  const ownerView=task=>({...publicTask(task),contentAccess:'full'});
  const readyResult=task=>task.state==='succeeded'||task.executor==='family_project'&&['needs_input','failed','unknown','cancelled'].includes(task.state)&&Boolean(task.text);

  const available=(...methods)=>{if(!ownerAgent||!methods.every(key=>typeof ownerAgent[key]==='function'))fail('owner_agent_unavailable');};
  function requireConversation(input,workspace){
    if(input.conversationId===undefined)return;
    const sessionId='family_owner_'+input.conversationId;
    if(tasks.some(task=>task.sessionId===sessionId&&(task.conversationId!==input.conversationId||task.personId!==input.personId||task.workspaceId!==input.workspaceId||(task.origin??'wechat')!==(input.origin??'wechat')||!(input.origin==='console'?task.route===null:sameRoute(task.route,input.route))||workspace&&task.cwd!==workspace.path)))fail('gateway_conversation_identity_conflict');
  }
  const lifecycle=new AbortController(),jobs=new Map(),admissions=new Map(),controllers=new Map(),activeDeliveries=new Set();let closed=false;
  const open=()=>{if(closed)fail('gateway_closed');};
  async function registry(){
    open();available('listWorkspaces');const rows=await ownerAgent.listWorkspaces({signal:lifecycle.signal});open();
    if(!Array.isArray(rows)||rows.length>10000||rows.some(row=>!row||!text(row.workspaceId,240)||!text(row.path,4096)||!isAbsolute(row.path)||!text(row.title,240))||new Set(rows.map(row=>row.workspaceId)).size!==rows.length)fail('owner_agent_registry_invalid');return rows;
  }
  async function deliver(task){
    if(closed||!readyResult(task)||task.delivery.state!=='none')return;
    if(!eligible(task)||!targetAllowed(task)){update(task.id,{delivery:{state:'suppressed',at:clock()}});return;}
    task=update(task.id,{delivery:{state:'dispatching',at:clock()}});
    const event={task:{id:task.id,personId:task.personId,workspaceId:task.workspaceId,sessionId:task.sessionId,requestId:task.requestId,route:clone(task.route),origin:task.origin??'wechat',executor:task.executor,state:task.state,files:clone(task.files??[]),...(task.conversationId?{conversationId:task.conversationId}:{}),...(task.deliveryTarget?{deliveryTarget:clone(task.deliveryTarget),artifactScope:clone(task.artifactScope)}:{})},text:task.deliveryTarget?sanitizeOwnerTaskText(task.text,{cwd:task.cwd}):task.text};
    const key=task.id+':'+task.requestId;activeDeliveries.add(key);try{await onResult(event);if(!closed)update(task.id,{delivery:{state:'accepted',at:clock()}});}catch(error){if(!closed)update(task.id,{delivery:{state:error?.sendOutcome==='failed'?'failed':'unknown',at:clock()}});}finally{activeDeliveries.delete(key);}
  }
  async function perform(taskId,method){
    let task=tasks.find(item=>item.id===taskId);if(closed||!task)return;
    if(method==='deliver'){await deliver(task);return;}
    if(!eligible(task)||method==='start'&&!targetAllowed(task)){update(task.id,{state:'unknown',notice:'任务授权或绑定已变化。',delivery:{state:'suppressed',at:clock()}});return;}
    try{
      let result;
      if(task.state==='cancelling'){task=update(task.id,{state:'cancelled',text:'已停止后续项目操作；此前写入的文件会保留，请核对已有成果。'});await deliver(task);return;}
      if(task.executor==='family_project'){
        if(method!=='start'){update(task.id,{state:'unknown',notice:'受控项目任务状态不明，没有自动重跑。'});return;}
        const execute=typeof familyProjectExecutor==='function'?familyProjectExecutor:familyProjectExecutor?.execute;
        if(typeof execute!=='function')fail('protected_executor_required');
        const control=new AbortController();controllers.set(task.id,control);try{result=await execute({personId:task.personId,workspaceId:task.workspaceId,prompt:task.prompt,history:(task.turns??[]).slice(-5).map(({prompt,text})=>({prompt,text})),signal:AbortSignal.any([lifecycle.signal,control.signal]),authorize:({capability='read'}={})=>['read','task','write'].includes(capability)&&eligible(task)&&!['cancelling','cancelled'].includes(tasks.find(row=>row.id===task.id)?.state)&&familyAllowed(task,capability)});}finally{if(controllers.get(task.id)===control)controllers.delete(task.id);}
      }else{available(method);const intent=clone(task);if(method==='start'&&task.artifactScope)intent.prompt+=ownerTaskArtifactInstructions(task.artifactScope);result=await ownerAgent[method](intent,{signal:lifecycle.signal});}if(closed)return;
      const cancelling=tasks.find(row=>row.id===task.id)?.state==='cancelling',nativeState=cancelling?'cancelled':states.includes(result?.state)?result.state:'unknown';if(cancelling)result={state:'cancelled',text:'已停止后续项目操作；此前写入的文件会保留，请核对已有成果。'};
      let nativeFiles,artifactNotice='';
      if(task.deliveryTarget&&nativeState==='succeeded'){
        try{if(typeof ownerTaskArtifacts?.collect!=='function')fail('owner_task_artifacts_unavailable');nativeFiles=await ownerTaskArtifacts.collect({workspaceId:task.workspaceId,scope:task.artifactScope,signal:lifecycle.signal,authorize:()=>eligible(task)&&targetAllowed(task)});if(!nativeFiles.length)artifactNotice='原生任务未生成指定目录中的安全成果文件，目前只有文字结果。';}
        catch{nativeFiles=[];artifactNotice='原生任务已结束，但成果文件未通过当前交付范围或安全读取检查，未投递文件。';}
      }
      const files=task.executor==='family_project'?result?.files??[]:nativeFiles;
      if(files!==undefined&&!validFiles(files,task.deliveryTarget?.personId??task.personId,task.artifactScope))fail('gateway_invalid_artifacts');
      task=update(task.id,{state:nativeState,...(files!==undefined?{files}:{}),text:typeof result?.text==='string'?result.text.slice(0,24000).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,''):'',pendingApprovals:Number.isSafeInteger(result?.pendingApprovals)&&result.pendingApprovals>=0?result.pendingApprovals:0,notice:artifactNotice});
      if(!eligible(task)&&task.delivery.state==='none')task=update(task.id,{delivery:{state:'suppressed',at:clock()}});
      await deliver(task);
    }catch{if(!closed){const cancelling=tasks.find(row=>row.id===task.id)?.state==='cancelling';task=update(task.id,{state:cancelling?'cancelled':'unknown',notice:cancelling?'已停止后续操作，已有成果保留。':'任务状态尚待核对。',...(task.executor==='family_project'?{text:cancelling?'已停止后续项目操作；此前写入的文件会保留，请核对已有成果。':'这次项目任务的结果尚未确认，请让 Owner 核对任务记录。我不会自动重跑。'}:{})});await deliver(task);}}
  }
  function schedule(taskId,method){
    if(jobs.has(taskId))return jobs.get(taskId);
    const promise=Promise.resolve().then(()=>perform(taskId,method)).finally(()=>jobs.delete(taskId));jobs.set(taskId,promise);return promise;
  }
  if(!stat(file))save(tasks);
  if(tasks.some(task=>task.delivery.state==='dispatching'||task.executor==='family_project'&&!terminal(task.state)&&task.state!=='needs_input'))save(tasks.map(task=>task.delivery.state==='dispatching'?{...task,delivery:{state:'unknown',at:clock()}}:task.executor==='family_project'&&!terminal(task.state)&&task.state!=='needs_input'?{...task,state:'unknown',notice:'上次受控任务中断，可能已有部分成果，请核对后明确继续；没有自动重跑。'}:task));
  if(tasks.some(task=>(task.artifactDeliveries??[]).some(row=>row.status==='dispatching')))save(tasks.map(task=>({...task,...(task.artifactDeliveries?{artifactDeliveries:task.artifactDeliveries.map(row=>row.status==='dispatching'?{...row,status:'unknown',updatedAt:clock()}:row)}:{})})));
  // A runtime with external delivery channels may defer native observation until
  // those channels are connected. Dispatch uncertainty above is always durable.
  if(recoverOnCreate)for(const task of tasks)if(task.executor!=='family_project'&&!terminal(task.state)||readyResult(task)&&task.delivery.state==='none')schedule(task.id,readyResult(task)?'deliver':'observe');
  const api={
    async listProjects({personId}={}){
      open();person(personId);const rows=await registry(),who=person(personId);
      if(who.role==='owner')return rows.map(row=>({workspaceId:row.workspaceId,title:row.title,path:row.path}));
      return rows.filter(row=>['read','task'].some(capability=>{try{return access?.authorize({personId,workspaceId:row.workspaceId,capability})?.allowed===true;}catch{return false;}})).map(row=>({workspaceId:row.workspaceId,title:row.title}));
    },
    async ownerToolContext(input={}){
      open();if(!object(input,['personId','sessionId','callId','signal'])||!id(input.personId)||!text(input.sessionId,240)||!text(input.callId,512)||input.signal!==undefined&&!(input.signal instanceof AbortSignal))fail('gateway_invalid_argument');
      const {personId,sessionId,callId}=input,signal=AbortSignal.any([lifecycle.signal,...(input.signal?[input.signal]:[])]),forbidden=()=>fail('gateway_owner_tool_forbidden');signal.throwIfAborted();
      if(store.snapshot().people?.find(row=>row.id===personId)?.role!=='owner')forbidden();
      // Session names are not credentials. The native request and its active
      // tool call must both be observed from a persisted Owner conversation.
      const candidates=tasks.filter(task=>task.personId===personId&&task.sessionId===sessionId&&task.conversationId&&task.executor!=='family_project'&&!terminal(task.state)&&eligible(task)).map(clone);
      if(!candidates.length||typeof ownerAgent?.observe!=='function')forbidden();
      const current=captured=>{const task=tasks.find(row=>row.id===captured.id);return !closed&&!signal.aborted&&task?.requestId===captured.requestId&&task.personId===personId&&task.sessionId===sessionId&&task.conversationId===captured.conversationId&&!terminal(task.state)&&eligible(task);};
      const read=async task=>{
        if(!current(task))forbidden();let observed;
        try{observed=await ownerAgent.observe(clone(task),{signal});}catch{signal.throwIfAborted();forbidden();}
        signal.throwIfAborted();if(!current(task))forbidden();
        if(!observed||observed.workspaceId!==task.workspaceId||observed.sessionId!==sessionId||observed.requestId!==task.requestId||observed.cwd!==task.cwd)forbidden();
        return observed;
      };
      // A long conversation may retain unknown requests outside the bounded
      // history window. Probe only the latest intent for the live session's
      // active RPC, then read that exact request instead of scanning old turns.
      const latest=candidates.at(-1),probe=await read(latest);
      if(probe.foreign!==false||!Number.isSafeInteger(probe.activeTurn)||probe.activeTurn<0||!Array.isArray(probe.activeRequestIds)||probe.activeRequestIds.length!==1)forbidden();
      const matches=candidates.filter(task=>task.requestId===probe.activeRequestIds[0]);if(matches.length!==1)forbidden();
      const task=matches[0],observed=task.id===latest.id?probe:await read(task);
      if(observed.state!=='running'||observed.requestSeen!==true||observed.queued!==false||observed.foreign!==false||!Number.isSafeInteger(observed.turn)||observed.turn<0||observed.activeTurn!==observed.turn||observed.activeTurn!==probe.activeTurn||!Array.isArray(observed.activeRequestIds)||observed.activeRequestIds.length!==1||observed.activeRequestIds[0]!==task.requestId||!Array.isArray(observed.events)||observed.events.length>10000||!observed.events.some(event=>['tool/call','tool/ptc-dispatch-start'].includes(event?.type)&&event.turn===observed.turn&&event.callId===callId&&event.status==='running')||!current(task))forbidden();
      const previous=tasks.slice(0,tasks.findIndex(row=>row.id===task.id)).filter(row=>row.personId===personId&&row.sessionId===sessionId&&row.conversationId===task.conversationId).at(-1);
      return{taskId:task.id,requestId:task.requestId,sourceRequestId:task.sourceRequestId,previousSourceRequestId:previous?.sourceRequestId??null,previousUserText:previous?conversationPrompt(previous.prompt):null,personId,origin:task.origin??'wechat',route:clone(task.route),userText:conversationPrompt(task.prompt),...(task.deliveryTarget?{deliveryTarget:clone(task.deliveryTarget)}:{}),authorize:()=>current(task)};
    },
    async submit(input){
      open();if(!object(input,['personId','route','workspaceId','prompt','requestId','origin','deliveryTarget','conversationId'])||!id(input.personId)||!(input.origin==='console'?input.route===null:validRoute(input.route))||input.origin!==undefined&&!['console','wechat'].includes(input.origin)||!text(input.workspaceId,240)||!text(input.prompt,64000)||!text(input.requestId,512)||input.conversationId!==undefined&&!uuid(input.conversationId))fail('gateway_invalid_argument');
      input=clone(input);const member=person(input.personId),family=member.role!=='owner';if(input.conversationId!==undefined&&family)fail('gateway_conversation_forbidden');if(input.deliveryTarget!==undefined&&family)fail('gateway_delivery_target_forbidden');const deliveryTarget=input.deliveryTarget!==undefined?captureTarget(input.deliveryTarget):undefined;if(deliveryTarget&&typeof ownerTaskArtifacts?.collect!=='function')fail('owner_task_artifacts_unavailable');
      if(family&&typeof familyProjectExecutor!=='function'&&typeof familyProjectExecutor?.execute!=='function')fail('protected_executor_required');
      authorize(input.personId,input.route,{origin:input.origin,owner:!family});
      const permissionRevision=family?access?.get(input.personId)?.revision:undefined;
      if(family&&!familyAllowed({...input,permissionRevision}))fail('gateway_permission_denied');const hash=fingerprint(input),existing=tasks.find(task=>task.sourceRequestId===input.requestId||(task.turns??[]).some(turn=>turn.sourceRequestId===input.requestId)),pending=admissions.get(input.requestId);
      if(existing){const entry=existing.sourceRequestId===input.requestId?existing:existing.turns.find(turn=>turn.sourceRequestId===input.requestId);if(entry.fingerprint!==hash)fail('gateway_request_identity_conflict');return publicTask(existing);}
      if(pending){if(pending.fingerprint!==hash)fail('gateway_request_identity_conflict');return pending.promise;}
      requireConversation(input);
      if(!family)available('start','observe');const promise=(async()=>{
        const projects=await registry();authorize(input.personId,input.route,{origin:input.origin,owner:!family});if(family&&!familyAllowed({...input,permissionRevision}))fail('gateway_permission_denied');if(deliveryTarget&&!targetAllowed({deliveryTarget}))fail('gateway_delivery_target_changed');const workspace=projects.find(row=>row.workspaceId===input.workspaceId);if(!workspace)fail('gateway_workspace_not_registered');
        requireConversation(input,workspace);if(tasks.length>=2000)fail('gateway_storage_full');const taskId=randomUUID(),nativeRequestId=randomUUID(),at=clock(),artifactScope=deliveryTarget?createOwnerTaskArtifactScope({personId:deliveryTarget.personId,taskId,requestId:nativeRequestId,cwd:workspace.path}):undefined;
        const task={id:taskId,personId:input.personId,route:input.route,...(input.origin?{origin:input.origin}:{}),workspaceId:workspace.workspaceId,workspaceTitle:workspace.title,cwd:workspace.path,...(family?{executor:'family_project',permissionRevision}:{}),...(deliveryTarget?{deliveryTarget,artifactScope}:{}),...(input.conversationId!==undefined?{conversationId:input.conversationId}:{}),sessionId:(family?'family_member_':'family_owner_')+(input.conversationId??taskId),requestId:nativeRequestId,sourceRequestId:input.requestId,fingerprint:hash,prompt:input.prompt,createdAt:at,updatedAt:at,state:'queued',text:'',notice:'',pendingApprovals:0,delivery:{state:'none'}};
        save([...tasks,task]);schedule(task.id,'start');return publicTask(task);
      })();admissions.set(input.requestId,{fingerprint:hash,promise});try{return await promise;}finally{admissions.delete(input.requestId);}
    },
    async continue(input){
      open();if(!object(input,['personId','route','origin','taskId','prompt','requestId'])||!id(input.personId)||!uuid(input.taskId)||!text(input.prompt,64000)||!text(input.requestId,512))fail('gateway_invalid_argument');
      let task=tasks.find(row=>row.id===input.taskId);if(!task||task.personId!==input.personId)fail('gateway_person_forbidden');
      if((input.origin??'wechat')!==(task.origin??'wechat')||!((task.origin==='console'&&input.route===null)||sameRoute(input.route,task.route)))fail('gateway_route_binding_changed');
      if(!eligible(task)||!targetAllowed(task))fail('gateway_permission_changed');
      const hash=fingerprint({...task,prompt:input.prompt}),existing=tasks.flatMap(row=>[row,...(row.turns??[])]).find(row=>row.sourceRequestId===input.requestId);
      if(existing){if(existing.fingerprint!==hash)fail('gateway_request_identity_conflict');return publicTask(task);}
      if(jobs.has(task.id))await jobs.get(task.id);task=tasks.find(row=>row.id===input.taskId);const replay=tasks.flatMap(row=>[row,...(row.turns??[])]).find(row=>row.sourceRequestId===input.requestId);if(replay){if(replay.fingerprint!==hash)fail('gateway_request_identity_conflict');return publicTask(task);}if(!eligible(task)||!targetAllowed(task))fail('gateway_permission_changed');
      if(!terminal(task.state)&&!(task.executor==='family_project'&&['unknown','needs_input'].includes(task.state)))fail('owner_agent_busy');if((task.turns??[]).length>=1000)fail('gateway_storage_full');
      const previous={requestId:task.requestId,sourceRequestId:task.sourceRequestId,fingerprint:task.fingerprint,prompt:task.prompt,state:task.state,text:task.text,at:task.updatedAt,...(task.files?{files:clone(task.files)}:{}),...(task.artifactDeliveries?{artifactDeliveries:clone(task.artifactDeliveries)}:{}),...(task.artifactScope?{artifactScope:clone(task.artifactScope)}:{})};
      const nextRequestId=randomUUID();task=update(task.id,{turns:[...(task.turns??[]),previous],requestId:nextRequestId,...(task.deliveryTarget?{artifactScope:createOwnerTaskArtifactScope({personId:task.deliveryTarget.personId,taskId:task.id,requestId:nextRequestId,cwd:task.cwd})}:{}),sourceRequestId:input.requestId,fingerprint:hash,prompt:input.prompt,state:'queued',text:'',files:[],artifactDeliveries:[],notice:'',pendingApprovals:0,delivery:{state:'none'}});schedule(task.id,'start');return publicTask(task);
    },
    async cancel({personId,taskId}={}){
      let task=await api.check({personId,taskId});if(terminal(task.state))return{task,accepted:false,requiresNativeSession:false};
      if(task.executor==='family_project'){task=update(task.id,{state:jobs.has(task.id)?'cancelling':'cancelled',notice:'停止后续操作，已有文件不会回滚。',...(!jobs.has(task.id)?{text:'已停止后续项目操作；此前写入的文件会保留，请核对已有成果。'}:{})});controllers.get(task.id)?.abort();if(task.state==='cancelled')void schedule(task.id,'deliver');return{task:publicTask(task),accepted:true,requiresNativeSession:false};}
      return{task,accepted:false,requiresNativeSession:true,notice:'请在原生会话中核对并取消当前任务；这里只回读实际状态，尚未取消。'};
    },
    async check({personId,taskId}={}){
      open();person(personId);if(!uuid(taskId))fail('gateway_invalid_task');const task=tasks.find(item=>item.id===taskId);
      if(!task||task.personId!==personId)fail('gateway_person_forbidden');authorize(personId,task.route,{paused:false,origin:task.origin,owner:task.executor!=='family_project'});if(task.executor==='family_project'&&!familyAllowed(task))fail('gateway_permission_changed');
      if(!terminal(task.state)&&task.executor!=='family_project')await schedule(task.id,'observe');else if(readyResult(task)&&task.delivery.state==='none')await schedule(task.id,'deliver');return publicTask(tasks.find(item=>item.id===task.id));
    },
    async tick(){open();await Promise.all(tasks.filter(task=>task.executor!=='family_project'&&!terminal(task.state)||readyResult(task)&&task.delivery.state==='none').map(task=>schedule(task.id,readyResult(task)?'deliver':'observe')));},
    snapshot({personId}={}){person(personId);return tasks.filter(task=>task.personId===personId&&(()=>{try{authorize(personId,task.route,{paused:false,origin:task.origin,owner:task.executor!=='family_project'});if(task.executor==='family_project'&&!familyAllowed(task))fail('gateway_permission_changed');return true;}catch{return false;}})()).map(publicTask);},
    artifactDelivery({taskId,requestId,relativePath,status}){
      open();const task=tasks.find(row=>row.id===taskId&&row.requestId===requestId);if(!task||!task.files?.some(file=>file.relativePath===relativePath))fail('gateway_invalid_artifact');
      const rows=clone(task.artifactDeliveries??[]);let row=rows.find(item=>item.relativePath===relativePath);
      if(!row){row={relativePath,clientId:'family-project-'+createHash('sha256').update(JSON.stringify([taskId,requestId,relativePath])).digest('hex'),status:'pending',updatedAt:clock()};rows.push(row);}
      if(status!==undefined){if(!artifactStatuses.includes(status))fail('gateway_invalid_argument');if(row.status!==status&&!(row.status==='pending'&&['dispatching','suppressed'].includes(status)||row.status==='dispatching'&&['api_accepted','unknown','failed','suppressed'].includes(status)))fail('gateway_artifact_outcome_fixed');row.status=status;row.updatedAt=clock();}
      update(task.id,{artifactDeliveries:rows});return clone(row);
    },
    artifactForOwner({actorId,taskId,relativePath}){
      if(person(actorId).role!=='owner')fail('gateway_person_forbidden');const task=tasks.find(row=>row.id===taskId);if(!task||task.executor!=='family_project'&&!task.artifactScope)fail('gateway_invalid_artifact');
      const entries=[{files:task.files??[],scope:task.artifactScope},...(task.turns??[]).map(turn=>({files:turn.files??[],scope:turn.artifactScope}))],entry=entries.find(entry=>entry.files.some(file=>file.relativePath===relativePath)),file=entry?.files.find(file=>file.relativePath===relativePath);if(!file)fail('gateway_invalid_artifact');return{personId:task.deliveryTarget?.personId??task.personId,workspaceId:task.workspaceId,...clone(file),...(entry.scope?{scope:clone(entry.scope)}:{})};
    },
    canDeliver({taskId,requestId}){const task=tasks.find(row=>row.id===taskId&&row.requestId===requestId);return Boolean(!closed&&task&&task.delivery.state==='dispatching'&&activeDeliveries.has(taskId+':'+requestId)&&readyResult(task)&&eligible(task)&&targetAllowed(task));},
    // This summary is for the trusted Owner control layer, not an HTTP identity.
    snapshotForOwner(){return tasks.map(ownerView);},
    // Notices were introduced with this prompt contract. Historical unknown
    // tasks must never emit a new message merely because the plugin upgraded.
    nativeNoticeTasks(){return tasks.filter(task=>task.conversationId&&task.prompt.startsWith('乐乐对话交互版本：2。\n')).map(ownerView);},
    async checkForOwner({actorId,taskId}){if(person(actorId).role!=='owner')fail('gateway_person_forbidden');const task=tasks.find(row=>row.id===taskId);if(!task)fail('gateway_invalid_task');if(eligible(task))await api.check({personId:task.personId,taskId});return ownerView(tasks.find(row=>row.id===taskId));},
    async cancelForOwner({actorId,taskId}){if(person(actorId).role!=='owner')fail('gateway_person_forbidden');const task=tasks.find(row=>row.id===taskId);if(!task)fail('gateway_invalid_task');const result=await api.cancel({personId:task.personId,taskId});return{...result,task:ownerView(tasks.find(row=>row.id===taskId))};},
    async settled(){while(jobs.size||admissions.size)await Promise.all([...jobs.values(),...Array.from(admissions.values(),entry=>entry.promise)]);},
    async close(){closed=true;lifecycle.abort();await Promise.allSettled([...jobs.values(),...Array.from(admissions.values(),entry=>entry.promise)]);}
  };return Object.freeze(api);
}
