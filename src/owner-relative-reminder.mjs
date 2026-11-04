// Exact single-request grammar shared by ingress and execution. A lone final
// closing bracket is a copy/paste artifact only after the complete quoted body.
// Keep the original message unchanged for admission hashes and replay checks.
export function parseOwnerRelativeReminder(text){
 if(typeof text!=='string'||text.length>1000)return null;
 const match=text.match(/^\s*(?:请|帮我|麻烦)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})分钟后提醒我「([^「」\r\n]{1,80})」[。！!]?(】)?\s*$/u);
 if(!match||match[3]&&text.includes('【'))return null;
 return{amount:match[1],text:match[2]};
}
