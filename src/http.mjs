import {readFile} from 'node:fs/promises';
import QRCode from 'qrcode';
import {VOICE_BODY_LIMIT} from './voice-host.mjs';

const web=new URL('../web/',import.meta.url);
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const aliases={'/api/family/control':'/family/api','/api/family/workbench':'/family/','/api/family/qr':'/family/qr.svg','/api/family/voice':'/family/voice','/api/family/voice/action':'/family/voice'};
const json=(value,status=200)=>Response.json(value,{status,headers});
function trusted(request){
  if(request.headers.get('Sec-Fetch-Site')==='cross-site')return false;
  const origin=request.headers.get('Origin');if(!origin)return true;
  try{const source=new URL(origin);const host=request.headers.get('Host')??new URL(request.url).host;return /^https?:$/.test(source.protocol)&&source.host===host;}catch{return false;}
}
function errorText(error){
  const text=String(error?.message??'未完成操作，请刷新后重试。');
  return /token|bearer|credential|secret|https?:\/\//i.test(text)?'连接暂时不可用，请核对工作台状态。':text.slice(0,200);
}
async function boundedText(request,limit){
  if(!request.body)return '';
  const reader=request.body.getReader(),chunks=[];let bytes=0;
  try{
    for(;;){
      const {done,value}=await reader.read();if(done)break;
      bytes+=value.byteLength;
      if(bytes>limit){await reader.cancel();return null;}
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks,bytes).toString('utf8');
  }finally{reader.releaseLock();}
}
export async function bundledWorkbench(){
  const[index,style,script]=await Promise.all(['index.html','style.css','app.js'].map(name=>readFile(new URL(name,web),'utf8')));
  const shim=`window.fetch=(input,init)=>{const u=new URL(String(input),'http://family.local');const path=u.pathname==='/family/api'?'/api/family/control':u.pathname==='/family/qr.svg'?'/api/family/qr':u.pathname;return parent.__FamilyHostFetch(path+u.search,init);};`;
  return index.replace(/<link[^>]+href="\/family\/style.css"[^>]*>/,`<style>${style.replace(/<\/style/gi,'<\\/style')}</style>`)
    .replace(/<script[^>]+src="\/family\/app.js"[^>]*><\/script>/,'')
    .replace('</body>',`<script>${shim}</script><script>${script.replace(/<\/script/gi,'<\\/script')}</script></body>`);
}

export function createHttpHandler({runtime,catalog=async()=>({available:false,providers:[]}),voice,mode='production'}={}){
  return async request=>{
    if(!trusted(request))return json({error:'请求来源不受信任。'},403);
    const url=new URL(request.url);const path=aliases[url.pathname]??url.pathname;
    if(!['GET','POST','HEAD'].includes(request.method))return json({error:'不支持此方法。'},405);
    try{
      if(path==='/family/voice'){
        if(!voice)return json({available:false,ready:false,phase:'unavailable',providers:[],selection:{providerId:'sensevoice-local',language:'auto'},message:'请在 Harness 中使用语音输入。'});
        if(request.method==='GET')return json(await voice.status());
        if(request.method!=='POST')return json({error:'不支持此方法。'},405);
        if(request.headers.get('X-Family-Action')!=='1')return json({error:'请在家庭助手工作台执行此操作。'},403);
        if(request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json')return json({error:'请使用JSON请求。'},415);
        const length=request.headers.get('Content-Length');
        if(length&&(!/^\d+$/.test(length)||Number(length)>VOICE_BODY_LIMIT))return json({error:'录音超过限制，请分段说。'},413);
        const body=await boundedText(request,VOICE_BODY_LIMIT);
        if(body===null)return json({error:'录音超过限制，请分段说。'},413);
        let input;try{input=JSON.parse(body);}catch{return json({error:'请求格式不正确。'},400);}
        if(!input||typeof input!=='object'||Array.isArray(input))return json({error:'请求格式不正确。'},400);
        const keys={catalog:['action'],setup:['action','downloadSource'],prepare:['action','downloadSource'],cancel_preparation:['action'],transcribe:['action','audioBase64','providerId','language']};
        const allowed=keys[input.action];
        if(!allowed||Object.keys(input).some(key=>!allowed.includes(key)))return json({error:'不支持的语音操作。'},400);
        if(input.action==='catalog')return json(await voice.status());
        if(input.action==='setup'||input.action==='prepare'){
          if(input.downloadSource!==undefined&&(typeof input.downloadSource!=='string'||input.downloadSource.length>500))return json({error:'下载来源格式不正确。'},400);
          return json(await voice.prepare({downloadSource:input.downloadSource}));
        }
        if(input.action==='cancel_preparation')return json(await voice.cancelPreparation());
        const {action,...recording}=input;
        return json(await voice.transcribe(recording,request.signal));
      }
      if(path==='/family/api'){
        let snapshot;
        if(request.method==='GET')snapshot=runtime.status({personId:url.searchParams.get('personId')||undefined});
        else if(request.method==='POST'){
          if(request.headers.get('X-Family-Action')!=='1')return json({error:'请在家庭助手工作台执行此操作。'},403);
          if(request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json')return json({error:'请使用JSON请求。'},415);
          const length=request.headers.get('Content-Length');if(length&&(!/^\d+$/.test(length)||Number(length)>32768))return json({error:'请求内容过长。'},413);
          const body=await request.text();if(Buffer.byteLength(body)>32768)return json({error:'请求内容过长。'},413);
          let input;try{input=JSON.parse(body);}catch{return json({error:'请求格式不正确。'},400);}
          snapshot=await runtime.action(input);
        }else return new Response(null,{status:405,headers});
        return json({...snapshot,mode,model:await catalog()});
      }
      if(request.method!=='GET'&&request.method!=='HEAD')return json({error:'不支持此方法。'},405);
      if(path==='/family/qr.svg'){
        const personId=url.searchParams.get('personId');
        if(!personId||!/^[A-Za-z0-9_-]{1,80}$/.test(personId))return json({error:'请先选择家人。'},400);
        const status=runtime.channels.status(personId);
        if(!status?.qrUrl)return json({error:'二维码尚未生成或已失效。'},404);
        const svg=await QRCode.toString(status.qrUrl,{type:'svg',margin:2,width:240,errorCorrectionLevel:'M'});
        return new Response(request.method==='HEAD'?null:svg,{headers:{...headers,'Content-Type':'image/svg+xml; charset=utf-8'}});
      }
      const assets={'/family/':['index.html','text/html'],'/family':['index.html','text/html'],'/family/app.js':['app.js','text/javascript'],'/family/style.css':['style.css','text/css']};
      const asset=assets[path];if(!asset)return json({error:'没有找到此页面。'},404);
      const native=url.pathname==='/api/family/workbench';
      const body=native?await bundledWorkbench():await readFile(new URL(asset[0],web));
      return new Response(request.method==='HEAD'?null:body,{headers:{...headers,'Content-Type':`${asset[1]}; charset=utf-8`,'Content-Security-Policy':"default-src 'self'; img-src 'self' blob: data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"}});
    }catch(error){return json({error:errorText(error)},400);}
  };
}

/** The official Connection carrier admits only authenticated owner Peers. */
export function registerHostRoutes(ctx,handler){
  const connection=ctx.get('connection');
  if(typeof connection?.fetch?.register!=='function')throw new Error('当前 Harness 不支持家庭助手所需的认证接口，请更新宿主。');
  // This Host's streaming carrier always constructs a request body, including
  // on GET (which WHATWG Request rejects). Keep reads on a bodyless route and
  // large audio writes on their own POST-only, bounded streaming route.
  const routes=[
    {path:'/api/family/control',methods:['GET','POST'],requestBody:'buffered'},
    {path:'/api/family/workbench',methods:['GET'],requestBody:'buffered'},
    {path:'/api/family/qr',methods:['GET'],requestBody:'buffered'},
    {path:'/api/family/voice',methods:['GET'],requestBody:'buffered'},
    {path:'/api/family/voice/action',methods:['POST'],requestBody:'streaming'},
  ];
  const disposers=routes.map(route=>connection.fetch.register({...route,fetch:handler}));
  return async()=>{await Promise.all(disposers.map(dispose=>dispose()));};
}
