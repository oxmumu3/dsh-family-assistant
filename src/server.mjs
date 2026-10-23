import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createHttpHandler} from './http.mjs';

/** Local review surface; separate from the authenticated Harness carrier. */
export async function startLocalServer({runtime,port=3891,catalog,mode='production'}={}){
  const token=randomBytes(24).toString('hex'),handler=createHttpHandler({runtime,catalog,mode});
  const equal=value=>typeof value==='string'&&Buffer.byteLength(value)===Buffer.byteLength(token)&&timingSafeEqual(Buffer.from(value),Buffer.from(token));
  const server=createServer(async(req,res)=>{
    try{
      const host=req.headers.host;
      if(!host||!new RegExp(`^(?:127\\.0\\.0\\.1|localhost):${server.address().port}$`).test(host)){res.writeHead(403).end();return;}
      const url=new URL(req.url,`http://${host}`);
      if(req.method==='GET'&&url.pathname==='/'&&equal(url.searchParams.get('token'))){
        res.writeHead(303,{'Set-Cookie':`family_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,Location:'/family/','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}).end();return;
      }
      const cookie=(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('family_session='))?.slice(15);
      if(!equal(cookie)){res.writeHead(401,{'Content-Type':'text/plain; charset=utf-8'}).end('请使用启动终端提供的工作台链接。');return;}
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>32768){res.writeHead(413).end();return;}chunks.push(chunk);}
      const body=Buffer.concat(chunks);
      const request=new Request(url,{method:req.method,headers:req.headers,...(body.length?{body}:{})});
      const response=await handler(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch{if(!res.headersSent)res.writeHead(400);res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return{server,url:`http://127.0.0.1:${server.address().port}/?token=${token}`,async close(){await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}};
}
