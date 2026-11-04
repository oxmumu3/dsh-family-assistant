// Scope active Family WeChat Owner context and project-control requests. This policy
// must be paired with a per-agent native presentation before dispatch; in PTC
// the model-visible run_code executes arbitrary Node APIs directly.
import {isProjectFollowupText} from './harness-planner.mjs';
import {isOwnerDotNewsIntent} from './owner-dot-news-intent.mjs';
const ACTIVE=new Set(['queued','running','needs_approval','needs_input','unknown','cancelling']);
// whale_travel authenticates the active Owner call itself and exposes game-only operations.
const allowed=new Set(['project_companion','personal_context','personal_review','ai_digest','whale_travel']);
const continuation=text=>isProjectFollowupText(text)||/^(?:请|帮我|麻烦)?\s*(?:(?:继续|刚才|刚刚|上一|这|那|上次|本次|上述).{0,16}(?:简报|报告|资料|项目|交办)|继续[。！!\s]*$|(?:再|改|补充|展开|详细|精简|总结|说说|然后|好的|好)[^。！？!?]{0,80}[。！？!?\s]*$)/u.test(text);
const independent=text=>/^(?:请|帮我)?(?:查看|看看|查一下|看下)(?:妈妈|爸爸|我妈|我爸|母亲|父亲)的(?:日程|日历)[。！!\s]*$/u.test(text.trim())||/^(?:请|帮我)?(?:修改|更改|编辑|写|运行|执行|测试)(?:这个|该)?项目(?:的)?(?:代码|文件|测试|脚本)[。！!\s]*$/u.test(text.trim());
const sensitive=text=>{
 // Preserve the existing Family-only route when the request unambiguously
 // concerns one family member's own calendar and carries no Dot/source/send.
 if(independent(text))return false;
 if(isOwnerDotNewsIntent(text))return true;
 if(/^(?:请|帮我|麻烦)?\s*第[一二两三四五六七八九1-9](?:条|项)(?:已处理|不再提醒|延后(?:\d{1,3}|[一二两三四五六七八九十]{1,3})(?:小时|天))[。！!\s]*$/u.test(text.trim()))return true;
 return /(?:\bdot\b|flomo|笔记|日历|日程|calendar|gmail|邮箱|邮件|drive|云盘|文档|表格|滴答|ticktick|个人资料|个人回顾|个人复盘|资讯兴趣|资讯日报|AI\s*日报(?:关注|主要关注|状态)|context|项目|project|dsh-project-companion)/iu.test(text);
};
export function createOwnerDotReadPolicy(getTasks){
 if(typeof getTasks!=='function')throw new TypeError('A Family task snapshot is required');
 function active(sessionId){
  if(typeof sessionId!=='string'||!sessionId.startsWith('family_owner_'))return false;
  try{
   const rows=getTasks();if(!Array.isArray(rows))return true;
   const related=rows.filter(row=>row?.sessionId===sessionId&&(row.origin==='wechat'||row.origin===undefined));
   return related.some((row,index)=>{
    if(!ACTIVE.has(row.state))return false;
    if(typeof row.prompt!=='string')return true;
    if(sensitive(row.prompt))return true;
    if(independent(row.prompt))return false;
    const history=[...related.slice(0,index).flatMap(item=>[...(Array.isArray(item.turns)?item.turns:[]),item]),...(Array.isArray(row.turns)?row.turns:[])];
    if(!history.length)return continuation(row.prompt);
    for(let i=history.length-1,checked=0;i>=0&&checked<100;i--,checked++){
     const prompt=history[i]?.prompt;if(typeof prompt!=='string')return true;
     if(sensitive(prompt))return true;
     if(independent(prompt))return false;
    }
    return true; // Missing, malformed, or overlong continuation history fails closed.
   });
  }catch{return true;}
 }
 const guard=execution=>{
  const id=String(execution?.agent?.id??'');if(!active(id)||allowed.has(execution?.name))return;
  return '本轮仅允许受控项目助理和资料只读工具；不能运行代码、扫描文件或访问其他服务。';
 };
 return Object.freeze({active,guard});
}

// Cordis publishes agent/created before its loop starts. Existing agents are
// checked immediately before session.prompt; cold agents are checked in the
// serial creation listener. A denied PTC transport is the fail-closed fallback.
export function installOwnerDotReadGuard({ctx,getTasks}){
 const tools=ctx?.get?.('tools');
 if(typeof tools?.guard!=='function'||typeof ctx?.on!=='function')throw new Error('owner_read_guard_unavailable');
 const policy=createOwnerDotReadPolicy(getTasks),overlays=new Map();let closed=false;
 const unguard=tools.guard(policy.guard);
 function refresh(agent){
  if(closed||!agent||typeof agent.id!=='string')return;
  const previous=overlays.get(agent.id);
  if(previous&&previous.agent!==agent){void previous.dispose?.();overlays.delete(agent.id);}
  if(!policy.active(agent.id)){
   // rc1 executor selections deliberately become unavailable when unloaded.
   // Keep an already selected native executor for this Owner's scope lifetime;
   // never restore a cached PTC provider or change the deployment default.
   const existing=overlays.get(agent.id);if(existing&&!existing.modern){overlays.delete(agent.id);void existing.dispose?.();}return;
  }
  if(overlays.has(agent.id))return overlays.get(agent.id).ready;
  const entry={agent,dispose:null,modern:false,ready:null};overlays.set(agent.id,entry);
  entry.ready=(async()=>{
   try{
    const scoped=agent.ctx?.get?.('tools');
    if(typeof tools.modeFor==='function'&&typeof scoped?.presentAs==='function'){
     if(tools.modeFor(agent)!=='native')entry.dispose=scoped.presentAs('native');
     if(tools.modeFor(agent)!=='native')throw new Error('owner_native_presentation_unavailable');
    }else if(typeof tools.selectExecutor==='function'&&typeof scoped?.setExecutor==='function'){
     // rc1 ships this built-in. Resolve the Host's official module lazily; do
     // not bundle an SDK copy or emulate unrestricted program execution.
     const {NativeToolExecutor}=await import('@deepseek-ai/dsh-tool-executor-native');
     if(closed||overlays.get(agent.id)!==entry)throw new Error('owner_read_guard_closed');
     entry.modern=true;
     let selected;try{selected=tools.selectExecutor(agent);}catch{}
     if(!(selected instanceof NativeToolExecutor))entry.dispose=scoped.setExecutor(new NativeToolExecutor(agent.ctx));
     if(!(tools.selectExecutor(agent) instanceof NativeToolExecutor))throw new Error('owner_native_presentation_unavailable');
    }else throw new Error('owner_native_presentation_unavailable');
   }catch(error){if(overlays.get(agent.id)===entry)overlays.delete(agent.id);await entry.dispose?.();throw error;}
  })();
  return entry.ready;
 }
 const onCreated=ctx.on('agent/created',({agent})=>refresh(agent));
 const onDisposed=ctx.on('agent/disposed',({agent})=>{const current=overlays.get(agent?.id);if(current?.agent===agent){overlays.delete(agent.id);void current.dispose?.();}});
 async function prepare(sessionId){
  if(closed)throw new Error('owner_read_guard_closed');
  const registry=ctx.get('agents',false);if(!registry||typeof registry.get!=='function'){if(policy.active(sessionId))throw new Error('owner_agent_registry_unavailable');return;}
  const agent=registry.get(sessionId);if(agent)await refresh(agent);
 }
 function refreshSession(sessionId){const registry=ctx.get('agents',false),agent=registry?.get?.(sessionId);if(agent)return refresh(agent);}
 async function close(){
  if(closed)return;closed=true;await onCreated();await onDisposed();await unguard();
  const entries=[...overlays.values()];overlays.clear();
  for(const item of entries){await item.ready?.catch(()=>{});await item.dispose?.();}
 }
 return Object.freeze({prepare,refresh,refreshSession,close});
}
