// A local transport acceptance is evidence of dispatch only, not handset receipt.
const sameRoute=(a,b)=>a&&b&&['personId','accountId','peerId','generation'].every(key=>a[key]===b[key]);
export function acceptedReviewToken({review,route,rows,parts}={}){
 if(!review||!/^[a-f0-9]{64}$/.test(review.viewToken??'')||!Array.isArray(rows)||!Array.isArray(parts)||!parts.length||parts.length>10)return null;
 const prefix=`harness-task:${review.taskId}:${review.requestId}:`,matched=rows.filter(row=>typeof row.sourceKey==='string'&&row.sourceKey.startsWith(prefix));
 if(matched.length!==parts.length)return null;
 for(const [index,content] of parts.entries()){
  const found=matched.filter(row=>row.sourceKey===prefix+index),expected=`${parts.length>1?`（${index+1}/${parts.length}）\n`:''}${content}`;
  if(found.length!==1||found[0].kind!=='harness_result'||found[0].status!=='api_accepted'||found[0].text!==expected||!sameRoute(found[0].route,route)||!sameRoute(found[0].authorizationRoute,route))return null;
 }
 return review.viewToken;
}
