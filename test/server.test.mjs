import test from 'node:test';
import assert from 'node:assert/strict';
import {startLocalServer} from '../src/server.mjs';

test('loopback workbench exchanges launch token for private cookie and blocks unauthenticated state',async t=>{
  const runtime={status:()=>({version:1,config:{paused:true},people:[]}),channels:{status:()=>({})}};
  const server=await startLocalServer({runtime,port:0});t.after(()=>server.close());
  const root=new URL(server.url);const noAuth=await fetch(new URL('/family/api',root));assert.equal(noAuth.status,401);
  const exchange=await fetch(root,{redirect:'manual'});assert.equal(exchange.status,303);
  const cookie=exchange.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
  const auth=await fetch(new URL('/family/api',root),{headers:{Cookie:cookie.split(';')[0]}});
  assert.equal(auth.status,200);assert.equal((await auth.json()).config.paused,true);
  const crossOrigin=await fetch(new URL('/family/api',root),{method:'POST',headers:{Cookie:cookie.split(';')[0],Origin:'https://evil.example','Content-Type':'application/json','X-Family-Action':'1'},body:'{"action":"start"}'});
  assert.equal(crossOrigin.status,403);
});
