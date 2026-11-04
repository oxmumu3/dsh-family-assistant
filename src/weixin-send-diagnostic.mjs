const contextLabels={present:'有',absent:'无'},recoveryLabels={not_attempted:'未执行',without_context:'已去上下文'};
const firstLabels={minus2_rejected:'明确-2拒绝',conflict:'回执冲突'};
const finalLabels={minus2_rejected:'明确-2拒绝',other_rejected:'其他拒绝',uncertain:'结果不确定',guard_stopped:'授权停止'};
const fields=['attempts','descriptionPresent','finalResult','firstResult','initialContext','recovery'];
function validate(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==fields.join(',')||!Object.hasOwn(contextLabels,value.initialContext)||![1,2].includes(value.attempts)||!Object.hasOwn(recoveryLabels,value.recovery)||!Object.hasOwn(firstLabels,value.firstResult)||!Object.hasOwn(finalLabels,value.finalResult)||typeof value.descriptionPresent!=='boolean')return null;
 if(value.attempts===2?(value.initialContext!=='present'||value.recovery!=='without_context'||value.firstResult!=='minus2_rejected'||value.finalResult==='guard_stopped'):value.recovery!=='not_attempted')return null;
 if(value.firstResult==='conflict'&&(value.attempts!==1||value.finalResult!=='uncertain')||value.finalResult==='guard_stopped'&&(value.initialContext!=='present'||value.attempts!==1))return null;
 if(value.attempts===1&&value.firstResult==='minus2_rejected'&&!['minus2_rejected','guard_stopped'].includes(value.finalResult))return null;
 return{initialContext:value.initialContext,attempts:value.attempts,recovery:value.recovery,firstResult:value.firstResult,finalResult:value.finalResult,descriptionPresent:value.descriptionPresent};
}
/** Fixed vocabulary only; never interpolate errors, response values or identifiers. */
export function weixinSendFailureDetail(error){
 try{
  const row=validate(error?.weixinSendDiagnostic);if(!row)return null;
  return `微信投递未完成（原上下文：${contextLabels[row.initialContext]}；尝试：${row.attempts}次；替代：${recoveryLabels[row.recovery]}；首次：${firstLabels[row.firstResult]}；最后：${finalLabels[row.finalResult]}；服务端说明出现：${row.descriptionPresent?'有':'无'}）。不会自动重发。`;
 }catch{return null;}
}
const lookup=(values,label)=>Object.keys(values).find(key=>values[key]===label);
/** Legacy detail remains opaque; only our exact fixed format can be projected. */
export function readWeixinSendFailureDetail(detail){
 if(typeof detail!=='string'||detail.length>160)return null;
 const match=/^微信投递未完成（原上下文：(有|无)；尝试：([12])次；替代：(未执行|已去上下文)；首次：(明确-2拒绝|回执冲突)；最后：(明确-2拒绝|其他拒绝|结果不确定|授权停止)；服务端说明出现：(有|无)）。不会自动重发。$/u.exec(detail);
 return match?validate({initialContext:lookup(contextLabels,match[1]),attempts:Number(match[2]),recovery:lookup(recoveryLabels,match[3]),firstResult:lookup(firstLabels,match[4]),finalResult:lookup(finalLabels,match[5]),descriptionPresent:match[6]==='有'}):null;
}
