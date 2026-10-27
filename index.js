import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRuntime} from './src/runtime.mjs';
import {createHostResponder,modelCatalog} from './src/model.mjs';
import {createHttpHandler,registerHostRoutes} from './src/http.mjs';
import {createHostWorkbenchPlanner} from './src/workbench-model.mjs';
import {createHostOwnerPlanner} from './src/owner-commands.mjs';
import {createHostVoice} from './src/voice-host.mjs';
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

export const name='family-assistant';
export const inject=['tools','llm','connection'];

/** Fresh installation is paused, empty, and does not start a QR/login/send. */
export function apply(ctx,config={}){
  const storageDir=resolve(config.storageDir??join(homedir(),'.local','share','dsh-family-assistant'));
  const voice=createHostVoice(ctx);
  let runtime;
  const respond=createHostResponder(ctx,()=>runtime.store.snapshot().config);
  const planOwner=createHostOwnerPlanner(ctx,()=>runtime.store.snapshot().config);
  const planWorkbench=createHostWorkbenchPlanner(ctx,()=>runtime.store.snapshot().config);
  const planHarness=createHostHarnessPlanner(ctx,()=>runtime.store.snapshot().config);
  const generatePresentation=createPresentationGenerator(ctx,()=>runtime.store.snapshot().config);
  // Native controllers are optional on a fresh install. Resolve at call time,
  // so adding this gateway does not start sessions or force a service restart.
  let nativeAdapter,nativeWorkspace,nativeSession;
  const native=()=>{const workspaceController=ctx.get('workspaceController'),sessionController=ctx.get('sessionController');
    if(!nativeAdapter||nativeWorkspace!==workspaceController||nativeSession!==sessionController){nativeWorkspace=workspaceController;nativeSession=sessionController;nativeAdapter=createOwnerAgentHost({workspaceController,sessionController,controlWorkspacePath:storageDir+'-owner-workspace'});}return nativeAdapter;};
  const ownerAgent=Object.fromEntries(['ensureControlWorkspace','listWorkspaces','start','observe'].map(method=>[method,(...args)=>native()[method](...args)]));
  const weather=createWeatherService();
  const toolExecutors={...createFamilyToolExecutors({ownerAgent,maxBytes:24000}),weather:weather.execute};
  const familyProjectExecutor=createFamilyProjectExecutor({ownerAgent,ctx,readConfig:()=>runtime.store.snapshot().config});
  const ownerTaskArtifacts=createOwnerTaskArtifacts({ownerAgent});
  const digestSources=createDigestSources({ownerAgent,maxBytes:24000});
  const memberAgent=createMemberAgent({directory:storageDir,ctx,readConfig:()=>runtime.store.snapshot().config});
  const memberReportFeedback=createMemberReportFeedback({directory:storageDir,ctx,readConfig:()=>runtime.store.snapshot().config});
  const classifyImportantEvent=createImportantEventClassifier(ctx,()=>runtime.store.snapshot().config);
  runtime=createRuntime({directory:storageDir,respond,planOwner,planWorkbench,planHarness,generatePresentation,extractMaterial:extractPresentationMaterial,ownerAgent,toolExecutors,weatherSearch:weather.search,familyProjectExecutor,ownerTaskArtifacts,digestSources,memberAgent,memberReportFeedback,classifyImportantEvent,memberPublicTools:()=>createMemberPublicTools({weatherSearch:weather.search,weatherExecute:weather.execute})});
  let unregister,disposal;
  const dispose=()=>disposal??=(async()=>{
    voice.dispose();
    try{await unregister?.();}
    finally{await runtime.close();}
  })();
  // Cordis constructs ordinary exported functions; own cleanup explicitly.
  ctx.effect(()=>dispose,'family-assistant: runtime');
  let cachedCatalog=null,catalogAt=0;
  const catalog=async()=>{if(!cachedCatalog||Date.now()-catalogAt>60000){cachedCatalog=await modelCatalog(ctx);catalogAt=Date.now();}return cachedCatalog;};
  try{unregister=registerHostRoutes(ctx,createHttpHandler({runtime,catalog,voice}));}
  catch(error){void dispose().catch(()=>{});throw error;}
  ctx.tools.register(createOwnerManagementTool({runtime,directory:storageDir}));
  ctx.tools.register({
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
  });
  if(!runtime.store.snapshot().config.paused)void runtime.start().catch(()=>{});
  return dispose;
}
