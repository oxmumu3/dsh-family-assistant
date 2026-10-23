import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRuntime} from './src/runtime.mjs';
import {createHostResponder,modelCatalog} from './src/model.mjs';
import {createHttpHandler,registerHostRoutes} from './src/http.mjs';
import {createHostWorkbenchPlanner} from './src/workbench-model.mjs';
import {createHostOwnerPlanner} from './src/owner-commands.mjs';
import {createHostVoice} from './src/voice-host.mjs';

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
  runtime=createRuntime({directory:storageDir,respond,planOwner,planWorkbench});
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
    description:'查看家庭助手连接及服务状态，或预览已获授权的每日服务简报。每位长辈独立微信通路、记忆和提醒；Owner 收汇总。安装默认暂停且为空，不自动扫码或发送。配置、添加成员、连接微信和明确发送操作请在 Harness 左侧家庭助手工作台完成。api_accepted 只表示微信API接受，不代表手机收到或已读。此工具不读取其他项目或宿主会话。',
    parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['status','preview_brief']}}},
    output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:value.text??JSON.stringify(value)}]},
    async execute(args,execution){
      execution.signal?.throwIfAborted();
      if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>key!=='action')||!['status','preview_brief'].includes(args.action))throw new Error('不支持的操作。');
      if(args.action==='preview_brief'){const state=await runtime.action({action:'preview_brief'});return{text:state.lastBrief.text};}
      if(args.action!=='status'||Object.keys(args).some(key=>key!=='action'))throw new Error('不支持的操作。');
      const state=runtime.status();return{text:`家庭助手：${state.config.paused?'已暂停':'运行中'}；共${state.people.length}位成员。\n${state.people.map(p=>`${p.label}：${p.binding.status}`).join('\n')}\n打开 Harness 左侧 → 家庭助手管理。`,paused:state.config.paused,people:state.people.map(p=>({label:p.label,role:p.role,status:p.binding.status}))};
    },
  });
  if(!runtime.store.snapshot().config.paused)void runtime.start().catch(()=>{});
  return dispose;
}
