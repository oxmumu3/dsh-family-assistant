import {readFile} from 'node:fs/promises';
import QRCode from 'qrcode';
import {VOICE_BODY_LIMIT} from './voice-host.mjs';
import {serviceSetupErrorText} from './service-setup.mjs';

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
  if(String(error?.code??text).startsWith('service_'))return serviceSetupErrorText(error);
  const messages={member_inactive:'这位家人的微信还未连接。可以先保存安排，连接后再调用。',not_granted:'这位家人尚未开通这项工具，请先在工具库保存安排。',not_configured:'这项工具的执行服务尚未就绪，请检查工具配置。',authorization_changed:'权限或微信绑定刚刚改变，请刷新后核对再试。',request_conflict:'这个请求已有不同内容的记录，请先核对原任务。',weather_city_ambiguous:'有多个同名城市，请在工具设置中选择具体城市。',weather_city_not_found:'没有找到这个城市，请换一个明确的城市名称。',weather_unavailable:'天气来源暂时不可用，请稍后重试。',weather_not_current:'暂未取得当天的天气预报，没有发送旧预报。',owner_agent_unavailable:'Harness 原生项目服务尚未连接，请检查宿主服务。',owner_agent_controller_unavailable:'Harness 原生项目服务尚未就绪，请检查宿主服务。',owner_agent_busy:'这个项目任务仍在处理，请等待结果或打开对应的原生会话。',digest_source_unavailable:'日报项目暂时无法读取，请重新选择资料来源。',digest_read_failed:'未能读取这份日报文件，请核对所选资料是否仍然存在。',digest_unsafe_path:'这份资料不在允许的文件范围内，请重新选择普通文本文件。'};
  if(Object.hasOwn(messages,text))return messages[text];
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
  const localName=value=>{const name=value.replace(/^\/family\//,'');if(!/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:html|css|js|png|jpe?g|svg|webp)$/.test(name)||name.split('/').some(part=>part.startsWith('.')))throw new Error('工作台资源名称无效。');return name;};
  const readLocal=(name,encoding)=>readFile(new URL(localName(name),web),encoding);
  const replaceAsync=async(source,pattern,callback)=>{const matches=[...source.matchAll(pattern)],replacements=await Promise.all(matches.map(callback));let result='',offset=0;for(let i=0;i<matches.length;i++){const match=matches[i];result+=source.slice(offset,match.index)+replacements[i];offset=match.index+match[0].length;}return result+source.slice(offset);};
  async function css(name,chain=[]){
    name=localName(name);if(chain.includes(name))throw new Error('工作台样式存在循环引用。');
    const source=await readLocal(name,'utf8');
    return replaceAsync(source,/@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*;/g,match=>css(new URL(match[1],new URL(name,'http://family.local/')).pathname.slice(1),[...chain,name]));
  }
  let index=await readLocal('index.html','utf8');const scripts=[];
  // Read scripts independently but retain their document order in srcdoc.
  const scriptRefs=[...index.matchAll(/<script\b[^>]+src=["'](\/family\/[^"']+\.js)["'][^>]*><\/script>/g)];
  scripts.push(...await Promise.all(scriptRefs.map(match=>readLocal(match[1],'utf8'))));
  index=index.replace(/<script\b[^>]+src=["'](\/family\/[^"']+\.js)["'][^>]*><\/script>/g,'');
  index=await replaceAsync(index,/<link\b[^>]+href=["'](\/family\/[^"']+\.css)["'][^>]*>/g,async match=>`<style>${(await css(match[1])).replace(/<\/style/gi,'<\\/style')}</style>`);
  index=await replaceAsync(index,/<img\b[^>]*\ssrc=["'](\/family\/[^"']+\.(png|jpe?g|svg|webp))["'][^>]*>/g,async match=>{const type={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',svg:'image/svg+xml',webp:'image/webp'}[match[2]],bytes=await readLocal(match[1]);return match[0].replace(match[1],`data:${type};base64,${bytes.toString('base64')}`);});
  const shim=`window.fetch=(input,init)=>{const u=new URL(String(input),'http://family.local');const path=u.pathname==='/family/api'?'/api/family/control':u.pathname==='/family/qr.svg'?'/api/family/qr':u.pathname;return parent.__FamilyHostFetch(path+u.search,init);};`;
  return index.replace('</body>',`<script>${shim}</script>${scripts.map(script=>`<script>${script.replace(/<\/script/gi,'<\\/script')}</script>`).join('')}</body>`);
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
        return json({...Array.isArray(snapshot)?{items:snapshot}:snapshot,mode,model:await catalog()});
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
      const local=path.match(/^\/family\/((?:assets\/)?[A-Za-z0-9_-]+\.(css|js|png|svg|webp))$/),types={css:'text/css',js:'text/javascript',png:'image/png',svg:'image/svg+xml',webp:'image/webp'};
      const asset=assets[path]??(local?[local[1],types[local[2]]]:null);if(!asset)return json({error:'没有找到此页面。'},404);
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
