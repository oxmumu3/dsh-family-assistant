import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
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
  runtime=createRuntime({directory:storageDir,respond,planOwner,planWorkbench,planHarness,generatePresentation,extractMaterial:extractPresentationMaterial,ownerAgent,toolExecutors,weatherSearch:weather.search,familyProjectExecutor,ownerTaskArtifacts,digestSources,memberAgent,memberReportFeedback,memberPublicTools:()=>createMemberPublicTools({weatherSearch:weather.search,weatherExecute:weather.execute})});
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
  ctx.tools.register({
    name:'family_assistant',
    description:'家庭助手的本地 Owner 管理工具。status 返回 Owner 可见的成员ID、资料及服务状态，preview_brief 预览获准分享的简报。先用 Host 正式项目/文件工具读取用户指定资料；需要交给家人时用 draft_management，把整理后的具体内容、目标成员、用户原话中的时间写入 text，形成工作台可直接确认的资料或安排卡；可继续修改同卡 contextId=card:ID。只产生草稿，不发送、不确认执行、不修改已有成员资料；用户在家庭助手中确认后才执行。没有读到资料不能编造；按成员偏好生成的日报与工具库指定文件订阅是两项独立配置；只有明确配置了资料源和时间才存在订阅，不能把未知来源说成已接通。不要将未知支持能力包装成已配置。安装默认暂停且为空，api_accepted 只表示微信API接受，不代表手机收到。',
    parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['status','preview_brief','draft_management']},text:{type:'string',maxLength:6000,description:'仅 draft_management：用户要求与已核实的资料结果；不可包含登录凭据。'},contextId:{type:'string',description:'仅 draft_management：续改时使用已有 card:ID 或 person:ID。'}}},
    output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:value.text??JSON.stringify(value)}]},
    async execute(args,execution){
      execution.signal?.throwIfAborted();
      if(!args||typeof args!=='object'||Array.isArray(args)||!['status','preview_brief','draft_management'].includes(args.action)||Object.keys(args).some(key=>!(['draft_management'].includes(args.action)?['action','text','contextId']:['action']).includes(key)))throw new Error('不支持的操作或参数。');
      if(args.action==='draft_management'){
        if(typeof execution.callId!=='string'||!execution.callId||execution.callId.length>512||typeof execution.agent?.id!=='string'||!execution.agent.id||execution.agent.id.length>512)throw new Error('缺少稳定的会话及工具请求标识，未创建草稿。');
        const requestId='host-'+createHash('sha256').update(JSON.stringify([execution.agent.id,execution.callId])).digest('hex').slice(0,40);
        const state=await runtime.action({action:'owner_chat',text:args.text,...(args.contextId?{contextId:args.contextId}:{}),requestId,draftOnly:true});
        const messages=state.workbench.messages.filter(message=>message.requestId===requestId),ids=new Set(messages.flatMap(message=>message.cardIds??[]));
        const cards=state.workbench.cards.filter(card=>ids.has(card.id));
        return{text:cards.length?'已整理为待确认卡片。请在家庭助手中核对后确认；尚未执行或发送。':messages.filter(message=>message.role==='assistant').at(-1)?.text??'未生成草稿，请补充具体需求。',cards,requestId};
      }
      if(args.action==='preview_brief'){const state=await runtime.action({action:'preview_brief'});return{text:state.lastBrief.text};}
      if(args.action!=='status'||Object.keys(args).some(key=>key!=='action'))throw new Error('不支持的操作。');
      const state=runtime.status();return{text:`家庭助手：${state.config.paused?'已暂停':'运行中'}；共${state.people.length}位成员。\n${state.people.map(p=>`${p.label}：${p.binding.status}`).join('\n')}`,paused:state.config.paused,people:state.people.map(p=>({id:p.id,label:p.label,role:p.role,timeZone:p.timeZone,interests:p.interests,notes:p.notes,dailyEnabled:p.dailyEnabled,dailyTime:p.dailyTime,status:p.binding.status})),presentations:state.presentations?.people??[]};
    },
  });
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
