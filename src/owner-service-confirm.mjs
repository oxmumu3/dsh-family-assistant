import {createHash} from 'node:crypto';
import {isOwnerManagementConfirmation,ownerServiceContextId} from './owner-management-tool.mjs';
import {serviceDraftSummaryHash} from './owner-service-ledger.mjs';
import {serviceSetupErrorText} from './service-setup.mjs';

const explicitConfirmation=value=>{
  if(typeof value!=='string')return null;
  const match=value.trim().match(/^确认\s+([A-Za-z0-9_-]{1,100})\s+(?:v)?(\d{1,9})$/u);
  return match?{draftId:match[1],revision:Number(match[2])}:null;
};

/** Save one service draft only when all of these hold:
 *  - the current inbound message is the trusted Owner's own confirmation;
 *  - the exact draft id/revision is the only one this same native session
 *    returned in its immediately previous turn (ledger evidence, not model text);
 *  - the prior turn's reply actually reached the Owner's WeChat;
 *  - the Owner request and binding are still authorized right before the write.
 * The draft context is derived from the session, so another session cannot
 * confirm it. HTTP/console keep their existing serviceSetup.confirm path. */
export async function confirmOwnerServiceDraft({authority,sessionId,draftId,revision,serviceSetup,ledger,previousTurnDelivered}={}){
  if(!authority||authority.origin!=='wechat')throw new Error('服务草稿确认只在主人微信原生会话里进行。');
  if(authority.deliveryTarget)throw new Error('这轮成果由原任务统一投递，不能同时确认服务草稿。');
  if(typeof draftId!=='string'||!draftId.trim()||draftId.length>100||!Number.isSafeInteger(revision)||revision<1)throw new Error('确认服务草稿需要当前草稿标识和精确版本。');
  const explicit=explicitConfirmation(authority.userText);
  if(explicit){
    if(explicit.draftId!==draftId||explicit.revision!==revision)return{status:'needs_input',draftId,revision,text:'你原话里的草稿编号或版本与这次确认不一致，尚未保存。'};
  }else if(!isOwnerManagementConfirmation(authority.userText))throw new Error('当前消息没有确认这项服务草稿，尚未保存。');
  if(!serviceSetup||typeof serviceSetup.confirm!=='function'||typeof serviceSetup.snapshotForOwner!=='function')throw new Error('服务草稿确认接口尚未就绪。');
  const contextId=ownerServiceContextId(sessionId);
  const current=()=>{try{return serviceSetup.snapshotForOwner({actorId:authority.personId,origin:'wechat',contextId}).find(row=>row.id===draftId)??null;}catch{return null;}};
  const draft=current();
  if(!draft||draft.revision!==revision)return{status:'needs_input',draftId,revision,text:'当前会话里没有这个精确版本的服务草稿，尚未保存。请先让我重新展示。'};
  if(draft.status==='applied')return{status:'completed',draftId,revision,text:'这项服务安排已经保存过，这次没有重复执行。'};
  if(draft.status!=='ready')return{status:'needs_input',draftId,revision,text:'这项服务草稿已经处理或有更新，请核对当前内容后再确认。'};
  if(!ledger||typeof ledger.view!=='function')throw new Error('服务草稿展示记录尚未就绪。');
  const views=ledger.view({sessionId,sourceRequestId:authority.previousSourceRequestId,personId:authority.personId,contextId});
  if(views.length!==1||views[0].draftId!==draftId||views[0].revision!==revision)return{status:'needs_input',draftId,revision,text:'没有唯一对应上一轮在本会话展示的服务草稿；旧话题、其他会话或从未展示的草稿不会被保存。请先让我重新展示。'};
  const view=views[0],summary=typeof draft.summary==='string'?draft.summary:'';
  // No loose branch: a draft without displayable content, a missing verifier, or
  // a ledger row without the exact version marker and content fingerprint is
  // never enough to save, even if an older record or test double says so.
  if(!summary.trim())return{status:'needs_input',draftId,revision,text:'这份服务草稿没有可核对的展示摘要，尚未保存。请先让我重新展示。'};
  if(typeof previousTurnDelivered!=='function')return{status:'needs_input',draftId,revision,text:'缺少上一轮展示的核实记录，尚未保存。请先让我重新展示。'};
  if(typeof view.marker!=='string'||!view.marker.trim()||view.marker.length>80||typeof view.summaryHash!=='string'||serviceDraftSummaryHash(summary)!==view.summaryHash)return{status:'needs_input',draftId,revision,text:'服务草稿的展示内容或版本已经变化，尚未保存。请先让我重新展示。'};
  if(previousTurnDelivered({summary,marker:view.marker,summaryHash:view.summaryHash})!==true)return{status:'needs_input',draftId,revision,text:'上一轮展示这份草稿的回复没有完整的送达回执，或没有真正展示这个版本；这次没有保存。请先核对或让我重新展示。'};
  if(authority.authorize()!==true)throw new Error('主人当前请求或微信绑定已改变，尚未保存。');
  const authorize=()=>{try{return authority.authorize()===true;}catch{return false;}};
  const requestId='owner-service-confirm-'+createHash('sha256').update(JSON.stringify([authority.personId,authority.sourceRequestId,draftId,revision])).digest('hex').slice(0,40);
  try{
    const result=await serviceSetup.confirm({actorId:authority.personId,draftId,revision,origin:'wechat',contextId,requestId,authorize});
    if(!result||typeof result!=='object'||typeof result.reply!=='string')throw new Error('服务草稿确认没有返回可用结果。');
    const status=result.draft?.status??'unknown';
    return{status:status==='applied'?'completed':status==='ready'?'needs_input':status,...(result.draft?{draftId:result.draft.id,revision:result.draft.revision}:{draftId,revision}),text:result.reply};
  }catch(error){
    if(String(error?.code??'').startsWith('service_'))return{status:'needs_input',draftId,revision,text:serviceSetupErrorText(error)};
    throw error;
  }
}
