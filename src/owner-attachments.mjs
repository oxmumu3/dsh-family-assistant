/** 主人附件落盘：同名文件不覆盖，且不靠「先查再写」。
 *
 * 两个执行器可能同时保存同名附件；existsSync 再 writeFileSync 的写法在
 * 两步之间有空隙，会互相覆盖。这里直接用 `wx` 独占创建：谁先建成功谁用
 * 这个名字，另一个收到 EEXIST 后换下一个编号。
 */
import {closeSync,openSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

export function safeAttachmentName(name){
  return String(name ?? 'file').replace(/[\\/\x00-\x1f\x7f]/g,'_').replace(/^\.+/,'').slice(0,120)||'file';
}

/** 返回真实落盘路径；每次调用都会新建一个文件，绝不覆盖已有文件。 */
export function writeAttachmentFile(folder,name,bytes,{max=999}={}){
  const clean=safeAttachmentName(name);
  const ext=(clean.match(/(\.[^.]{1,12})$/)??[])[1]??'';
  const base=ext?clean.slice(0,-ext.length):clean;
  for(let index=1;index<=max;index+=1){
    const suffix=index===1?'':` (${index})`;
    const target=join(folder,(base.slice(0,Math.max(1,120-suffix.length-ext.length))||'file')+suffix+ext);
    let fd;
    try{fd=openSync(target,'wx',0o600);}
    catch(error){if(error?.code==='EEXIST')continue;throw error;}
    try{writeFileSync(fd,bytes);}finally{closeSync(fd);}
    return target;
  }
  throw new Error('同名附件过多，未保存。');
}
