import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRuntime} from './src/runtime.mjs';
import {createHostResponder,modelCatalog} from './src/model.mjs';
import {createHttpHandler,registerHostRoutes} from './src/http.mjs';
import {createHostWorkbenchPlanner} from './src/workbench-model.mjs';
import {createHostOwnerPlanner} from './src/owner-commands.mjs';
import {createHostVoice} from './src/voice-host.mjs';
import {createWeixinVoiceTranscriber} from './src/weixin-voice.mjs';
import {createPresentationGenerator,extractPresentationMaterial} from './src/presentations.mjs';
import {createOwnerAgentHost} from './src/owner-agent-host.mjs';
import {createHostHarnessPlanner} from './src/harness-planner.mjs';
import {createFamilyToolExecutors,createDigestSources} from './src/family-tool-executors.mjs';
import {createWeatherService} from './src/weather-service.mjs';
import {createFamilyProjectExecutor} from './src/family-project-executor.mjs';
import {createOwnerTaskArtifacts} from './src/owner-task-artifacts.mjs';
import {createMemberAgent} from './src/member-agent.mjs';
import {createMemberReportFeedback} from './src/member-report-feedback.mjs';
import {createMemberPublicTools} from './src/member-public-tools.mjs';
import {createOwnerManagementTool} from './src/owner-management-tool.mjs';
import {createImportantEventClassifier} from './src/important-event-model.mjs';
import {installOwnerDotReadGuard} from './src/owner-dot-read-guard.mjs';
import {createOwnerPromptScope,recordScope} from './src/owner-prompt-scope.mjs';
import {createNativeMemberRuntime} from './src/member-native-runtime.mjs';
import {createHostMemberSessionFactory} from './src/member-native-host.mjs';
import {ownerPromptSection} from './src/owner-prompt.mjs';

export const name='family-assistant';
export const inject=['tools','llm','connection'];

/** Fresh installation is paused, empty, and does not start a QR/login/send. */
export function apply(ctx,config={}){
  const storageDir=resolve(config.storageDir??join(homedir(),'.local','share','dsh-family-assistant'));
  const voice=createHostVoice(ctx);
  const transcribeVoice=createWeixinVoiceTranscriber({voice});
  let runtime,ownerReadGuard;
  const ownerPromptScope=createOwnerPromptScope({section:ownerPromptSection(),onStateChange:change=>{try{recordScope(storageDir,change);}catch{}}});
  const respond=createHostResponder(ctx,()=>runtime.store.snapshot().config);
  const planOwner=createHostOwnerPlanner(ctx,()=>runtime.store.snapshot().config);
  const planWorkbench=createHostWorkbenchPlanner(ctx,()=>runtime.store.snapshot().config);
  const planHarness=createHostHarnessPlanner(ctx,()=>runtime.store.snapshot().config);
  const generatePresentation=createPresentationGenerator(ctx,()=>runtime.store.snapshot().config);
  // Native controllers are optional on a fresh install. Resolve at call time,
  // so adding this gateway does not start sessions or force a service restart.
  let nativeAdapter,nativeWorkspace,nativeSession;
  const native=()=>{const workspaceController=ctx.get('workspaceController'),sessionController=ctx.get('sessionController');
    if(!nativeAdapter||nativeWorkspace!==workspaceController||nativeSession!==sessionController){nativeWorkspace=workspaceController;nativeSession=sessionController;nativeAdapter=createOwnerAgentHost({workspaceController,sessionController,controlWorkspacePath:storageDir+'-owner-workspace',beforePrompt:async (sessionId,request)=>{if(!ownerReadGuard)throw new Error('owner_read_guard_unavailable');const prepared=await ownerReadGuard.prepare(sessionId);try{await ownerPromptScope.prepareRequest(sessionId,request);}catch{}return prepared;}});}return nativeAdapter;};
  const ownerAgent=Object.fromEntries(['ensureControlWorkspace','listWorkspaces','start','observe','observeActive','ensureSession'].map(method=>[method,(...args)=>native()[method](...args)]));
  const weather=createWeatherService();
  const toolExecutors={...createFamilyToolExecutors({ownerAgent,maxBytes:24000}),weather:weather.execute};
  const familyProjectExecutor=createFamilyProjectExecutor({ownerAgent,ctx,readConfig:()=>runtime.store.snapshot().config});
  const ownerTaskArtifacts=createOwnerTaskArtifacts({ownerAgent});
  const digestSources=createDigestSources({ownerAgent,maxBytes:24000});
  const memberAgent=createMemberAgent({directory:storageDir,ctx,readConfig:()=>runtime.store.snapshot().config});
  const memberReportFeedback=createMemberReportFeedback({directory:storageDir,ctx,readConfig:()=>runtime.store.snapshot().config});
  const classifyImportantEvent=createImportantEventClassifier(ctx,()=>runtime.store.snapshot().config);
  const workspaceCurrentSync=(root,workspaceId)=>{try{const rows=ctx.get('workspaceRegistry',false)?.list?.();if(!Array.isArray(rows))return false;const byId=rows.filter(row=>row?.id===workspaceId),byPath=rows.filter(row=>row?.path===root);return byId.length===1&&byPath.length===1&&byId[0]===byPath[0];}catch{return false;}};
  // Native member link is optional: it only exists when the Host exposes the
  // agent and session controllers. The per-member flag file decides whether any
  // message actually takes it; otherwise everything stays on the legacy path.
  let memberNativeRuntime=null;
  try{
    const nativeAgents=ctx.get('agents',false),nativeSessions=ctx.get('sessionController',false);
    if(typeof nativeAgents?.create==='function'&&typeof nativeSessions?.prompt==='function'&&typeof nativeSessions?.page==='function'){
      memberNativeRuntime=createNativeMemberRuntime({createAgent:createHostMemberSessionFactory({agents:nativeAgents,sessionController:nativeSessions,cwd:storageDir+'-member-workspace'})});
    }
  }catch{memberNativeRuntime=null;}
  runtime=createRuntime({directory:storageDir,respond,planOwner,planWorkbench,planHarness,generatePresentation,extractMaterial:extractPresentationMaterial,ownerAgent,toolExecutors,weatherSearch:weather.search,familyProjectExecutor,ownerTaskArtifacts,workspaceCurrentSync,digestSources,memberAgent,memberReportFeedback,classifyImportantEvent,transcribeVoice,memberNativeRuntime,ownerPromptStatus:sessionId=>ownerPromptScope.status().find(row=>row.sessionId===sessionId)??null,onOwnerTaskSettled:sessionId=>ownerReadGuard?.refreshSession(sessionId),memberPublicTools:()=>createMemberPublicTools({weatherSearch:weather.search,weatherExecute:weather.execute})});
  let unregister,disposal;
  const dispose=()=>disposal??=(async()=>{
    try{await offAgentCreated?.();await offAgentDisposed?.();}catch{}
    for(const agent of [...ownerScopes.keys()])releaseOwnerTools({id:agent});
    voice.dispose();
    try{await unregister?.();}
    finally{try{await runtime.close();}finally{try{await ownerPromptScope.close();}finally{await ownerReadGuard?.close();}}}
  })();
  // Cordis constructs ordinary exported functions; own cleanup explicitly.
  ctx.effect(()=>dispose,'family-assistant: runtime');
  let cachedCatalog=null,catalogAt=0;
  const catalog=async()=>{if(!cachedCatalog||Date.now()-catalogAt>60000){cachedCatalog=await modelCatalog(ctx);catalogAt=Date.now();}return cachedCatalog;};
  try{
    ownerReadGuard=installOwnerDotReadGuard({ctx,getTasks:()=>runtime.ownerTasksForToolGuard()});
  }catch(error){
    // A Host without the internal tools guard cannot enforce the PTC read
    // policy. Keep the plugin usable instead of failing the whole mount; the
    // Owner bridge and every tool still authenticate by session identity.
    ownerReadGuard={prepare(){throw new Error('owner_read_guard_unavailable');},refreshSession(){},close:async()=>{}};
  }
  try{
    // Host-internal only; Cordis removes the service on plugin unload. Hosts
    // (and test harnesses) without provide simply skip this internal bridge.
    if(typeof ctx.provide==='function')ctx.provide('familyDotBridge',runtime.familyDotBridge);
    unregister=registerHostRoutes(ctx,createHttpHandler({runtime,catalog,voice}));
  }
  catch(error){void dispose().catch(()=>{});throw error;}
  // Owner tools are scoped to the Owner's own native sessions. Registering them
  // globally advertised family_assistant to every session, where every call was
  // rejected with an opaque authorization error. Scoping also keeps the tool
  // list of unrelated sessions clean.
  const ownerTools=[createOwnerManagementTool({runtime,directory:storageDir}),{
    name:'family_owner_projects',
    description:'乐乐 Owner 主对话的实时本地项目目录。返回此 Host 已登记项目的 ID、标题与真实目录；需要查找资料时先调用，再用原生文件/搜索工具自行检查候选项目，不要求 Owner 先选项目或重复路径。只能在乐乐已登记的 Owner 原生会话调用；目录本身不改变宿主工具权限。',
    parameters:{type:'object',additionalProperties:false,properties:{}},
    output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:value.text}]},
    async execute(args,execution){
      if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length)throw new Error('项目目录工具不接受额外参数。');
      execution?.signal?.throwIfAborted();
      const projects=await runtime.ownerProjectsForSession({sessionId:execution?.agent?.id,signal:execution?.signal});
      return{projects,text:JSON.stringify({projects})};
    },
  }];
  const isOwnerSession=id=>typeof id==='string'&&id.startsWith('family_owner_');
  const ownerScopes=new Map();
  function registerOwnerTools(agent){
    if(!agent||typeof agent.id!=='string'||!isOwnerSession(agent.id)||ownerScopes.has(agent.id))return false;
    const scoped=agent.ctx?.get?.('tools');
    if(typeof scoped?.register!=='function')return false;
    const disposers=ownerTools.map(definition=>scoped.register(definition));
    ownerScopes.set(agent.id,{agent,disposers});
    return true;
  }
  function releaseOwnerTools(agent){
    const entry=ownerScopes.get(agent?.id);
    if(!entry)return;
    ownerScopes.delete(agent.id);
    for(const dispose of entry.disposers){try{void dispose();}catch{}}
  }
  const agentRegistry=ctx.get('agents',false);
  const scopedToolHost=typeof ctx.on==='function'&&typeof agentRegistry?.list==='function';
  let offAgentCreated=()=>{},offAgentDisposed=()=>{};
  // The persistent scope owns registration. Its own assembly check is the gate:
  // there is no second registration of the same section name, so a duplicate-name
  // probe can never race the real one and produce a false negative.
  if(scopedToolHost){
    offAgentCreated=ctx.on('agent/created',({agent}={})=>{try{registerOwnerTools(agent);}catch{}try{void ownerPromptScope.attach(agent);}catch{}});
    offAgentDisposed=ctx.on('agent/disposed',({agent}={})=>{try{releaseOwnerTools(agent);}catch{}try{void ownerPromptScope.detach(agent?.id);}catch{}});
    // Agents created before this plugin loaded still need their Owner tools,
    // and their scope is the only honest place to run the prompt probe: no
    // synthetic identity, no second agent.
    let existing=[];try{existing=agentRegistry.list()??[];}catch{}
    for(const agent of Array.isArray(existing)?existing:[]){try{registerOwnerTools(agent);}catch{}try{void ownerPromptScope.attach(agent);}catch{}}
  }else{
    // A Host without scoped registration keeps the previous global behaviour.
    for(const definition of ownerTools)ctx.tools.register(definition);
  }
  if(!runtime.store.snapshot().config.paused)void runtime.start().catch(()=>{});
  return dispose;
}
