import test from 'node:test';
import assert from 'node:assert/strict';

async function fixture(){
  const {createHttpHandler}=await import('../src/http.mjs');let writes=0;
  const runtime={status:()=>({version:1,config:{paused:true},people:[],outbox:[],reminders:[]}),action:async()=>{writes++;return{version:1};},channels:{status:()=>({qrUrl:'https://ilinkai.weixin.qq.com/qr/example'})}};
  const handler=createHttpHandler({runtime});return{handler,writes:()=>writes};
}
test('cross-origin actions are rejected before invoking runtime',async()=>{
  const{handler,writes}=await fixture();
  const response=await handler(new Request('http://127.0.0.1:3891/family/api',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json','X-Family-Action':'1'},body:'{"action":"start"}'}));
  assert.equal(response.status,403);assert.equal(writes(),0);
});
test('mutation requires explicit CSRF header and JSON',async()=>{
  const{handler,writes}=await fixture();
  const response=await handler(new Request('http://127.0.0.1/family/api',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"start"}'}));
  assert.equal(response.status,403);assert.equal(writes(),0);
});
test('oversized JSON is rejected before parsing/action',async()=>{
  const{handler,writes}=await fixture();
  const response=await handler(new Request('http://127.0.0.1/family/api',{method:'POST',headers:{'Content-Type':'application/json','X-Family-Action':'1'},body:JSON.stringify({action:'send_message',text:'a'.repeat(40000)})}));
  assert.equal(response.status,413);assert.equal(writes(),0);
});
test('authenticated-host aliases return the same state and bundled native workbench',async()=>{
  const{handler}=await fixture();
  const response=await handler(new Request('http://dsh.internal/api/family/control'));
  assert.equal((await response.json()).version,1);
  const page=await handler(new Request('http://dsh.internal/api/family/workbench'));
  assert.equal(page.status,200);const html=await page.text();assert.match(html,/家庭/);assert.match(html,/__FamilyHostFetch/);
  assert(html.lastIndexOf('<script>')>html.indexOf('<body>'),'bundled app executes after its DOM');
});
test('QR response is private SVG without remote image services',async()=>{
  const{handler}=await fixture();
  const response=await handler(new Request('http://127.0.0.1/family/qr.svg?personId=owner'));
  assert.equal(response.status,200);assert.match(response.headers.get('Content-Type'),/image\/svg/);assert.equal(response.headers.get('Cache-Control'),'no-store');
});

test('bundled native fetch bridge is executable and maps control and QR requests',async()=>{
  const{bundledWorkbench}=await import('../src/http.mjs');const{runInNewContext}=await import('node:vm');
  const html=await bundledWorkbench();const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const target={window:{},URL,parent:{__FamilyHostFetch:(url,init)=>({url,init})}};
  runInNewContext(script,target);
  assert.equal(target.window.fetch('/family/api?personId=dad').url,'/api/family/control?personId=dad');
  assert.equal(target.window.fetch('/family/qr.svg?personId=dad').url,'/api/family/qr?personId=dad');
});

test('native workbench closes over all local styles, scripts and images without external asset requests',async()=>{
 const{bundledWorkbench}=await import('../src/http.mjs');const page=await bundledWorkbench();
 assert.doesNotMatch(page,/<(?:script|link)\b[^>]*(?:src|href)=["']\/family\//i);
 assert.doesNotMatch(page,/<img\b[^>]*\ssrc=["']\/family\//i);
});

test('tool configuration errors explain a next step without exposing internal error codes',async()=>{
 const{createHttpHandler}=await import('../src/http.mjs');
 const handler=createHttpHandler({runtime:{action:async()=>{throw Object.assign(new Error('member_inactive'),{code:'member_inactive'});}}});
 const response=await handler(new Request('http://127.0.0.1/family/api',{method:'POST',headers:{'Content-Type':'application/json','X-Family-Action':'1'},body:JSON.stringify({action:'tool_invoke'})}));
 const value=await response.json();assert.equal(response.status,400);assert.match(value.error,/微信还未连接/);assert.doesNotMatch(value.error,/member_inactive/);
});
