import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeixinApi } from '../src/weixin.mjs';
const reply = (body, status=200) => ({ok:status>=200&&status<300,status,text:async()=>typeof body==='string'?body:JSON.stringify(body)});
const auth={token:'secret',baseUrl:'https://ilinkai.weixin.qq.com',peerId:'peer',contextToken:'ctx',text:'你好',clientId:'c1'};
test('QR uses official POST protocol with empty local tokens and normalized confirmation', async()=>{
 const calls=[];const api=createWeixinApi({fetchImpl:async(u,o)=>{calls.push([u,o]);return reply(calls.length===1?{qrcode:'q',qrcode_img_content:'https://weixin.qq.com/q'}:{status:'confirmed',bot_token:'t',ilink_bot_id:'a',ilink_user_id:'p',baseurl:auth.baseUrl});}});
 assert.deepEqual(await api.getQr(),{qrcode:'q',qrUrl:'https://weixin.qq.com/q'});
 assert.equal(calls[0][1].method,'POST');assert.deepEqual(JSON.parse(calls[0][1].body).local_token_list,[]);
 assert.equal(calls[0][1].headers['iLink-App-Id'],'bot');
 assert.deepEqual(await api.checkQr({qrcode:'q'}),{status:'confirmed',token:'t',baseUrl:auth.baseUrl,accountId:'a',peerId:'p'});
});
test('production credential URLs reject lookalike hosts, HTTP, embedded credentials and redirects',async()=>{
 for(const baseUrl of ['http://ilinkai.weixin.qq.com','https://weixin.qq.com.evil.test','https://evil.test','https://u:p@ilinkai.weixin.qq.com','https://ilinkai.weixin.qq.com:443/a?x=1']){
  let called=false;await assert.rejects(()=>createWeixinApi({fetchImpl:async()=>{called=true;return reply({ret:0});}}).send({...auth,baseUrl}));assert.equal(called,false);
 }
 let opts;await createWeixinApi({fetchImpl:async(u,o)=>{opts=o;return reply({ret:0});}}).send(auth);assert.equal(opts.redirect,'error');
});
test('send acceptance requires explicit success and rejects API business failures',async()=>{
 for(const body of [{ret:0},{errcode:0},{message_id:'18446744073709551615'}]){
  let count=0;const api=createWeixinApi({fetchImpl:async()=>{count++;return reply(body);}});assert.equal((await api.send(auth)).status,'api_accepted');assert.equal(count,1);
 }
 for(const body of [{ret:-1},{ret:0,errcode:-14},{message_id:'1',ret:-2}]){
  await assert.rejects(()=>createWeixinApi({fetchImpl:async()=>reply(body)}).send(auth),e=>e.sendOutcome==='failed');
 }
});
test('network and unconfirmed send outcomes are uncertain without retry',async()=>{
 for(const fetchImpl of [async()=>{throw new Error('socket gone');},async()=>reply({}),async()=>reply('bad json'),async()=>reply({},502)]){
  let count=0;await assert.rejects(()=>createWeixinApi({fetchImpl:async(...a)=>{count++;return fetchImpl(...a);}}).send(auth),e=>e.sendOutcome==='uncertain');assert.equal(count,1);
 }
});
test('poll parses direct text, transcribed voice, unsupported media and lossless uint64 IDs',async()=>{
 const api=createWeixinApi({fetchImpl:async()=>reply('{"ret":0,"get_updates_buf":"next","msgs":[{"message_id":18446744073709551615,"from_user_id":"p","message_type":1,"context_token":"ct","item_list":[{"type":1,"text_item":{"text":"a"}},{"type":3,"voice_item":{"text":"b"}},{"type":2}]}]}')});
 const r=await api.poll({...auth,cursor:'old'});assert.equal(r.cursor,'next');assert.equal(r.messages[0].id,'18446744073709551615');assert.equal(r.messages[0].text,'a\nb');assert.equal(r.messages[0].unsupported,true);assert.equal(r.messages[0].contextToken,'ct');
});
test('QR credentials cannot supply arbitrary outbound baseurl',async()=>{
 const api=createWeixinApi({fetchImpl:async()=>reply({status:'confirmed',bot_token:'t',ilink_bot_id:'a',ilink_user_id:'p',baseurl:'https://evil.test'})});await assert.rejects(()=>api.checkQr({qrcode:'q'}));
});
test('QR polling recovers transient network failures and passes manual code on safe IDC redirect',async()=>{
 const calls=[];let n=0;const api=createWeixinApi({fetchImpl:async(u,o)=>{calls.push([u,o]);n++;if(n===1)throw new Error('network');if(n===2)return reply({status:'scaned_but_redirect',redirect_host:'ilinkai2.weixin.qq.com'});return reply({status:'wait'});}});
 assert.deepEqual(await api.checkQr({qrcode:'q'}),{status:'wait'});assert.deepEqual(await api.checkQr({qrcode:'q'}),{status:'scaned'});await api.checkQr({qrcode:'q',verifyCode:'1234'});assert.equal(new URL(calls[2][0]).hostname,'ilinkai2.weixin.qq.com');assert.equal(new URL(calls[2][0]).searchParams.get('verify_code'),'1234');
});

const sensitive='Bearer token-test-secret https://private.example.test/peer?context=private-context';
const unsafeError=(extra={})=>Object.assign(new Error(sensitive),{name:sensitive,code:sensitive,stack:sensitive,...extra});
function checkDiagnostic(error,{reason,phase,httpStatus,code,requestTimeout=false,externalAbort=false}) {
 assert.equal(error.sendOutcome,'uncertain');
 assert.equal(error.message,`发送结果尚未确认，请勿自动重发（${reason}）`);
 assert.equal(error.cause,undefined);
 const diagnostic=error.diagnostic;
 assert.ok(diagnostic,'send failures need a bounded diagnostic');
 assert.equal(Number.isFinite(diagnostic.elapsedMs)&&diagnostic.elapsedMs>=0,true);
 assert.deepEqual(diagnostic,{phase,elapsedMs:diagnostic.elapsedMs,...(httpStatus===undefined?{}:{httpStatus}),...(code===undefined?{}:{code}),requestTimeout,externalAbort});
 assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`,/token-test-secret|private\.example|private-context/);
 return true;
}
const diagnosticCases=[
 {name:'connect timeout from the fetch cause',reason:'连接超时',phase:'request',code:'UND_ERR_CONNECT_TIMEOUT',fetchImpl:async()=>{throw unsafeError({cause:unsafeError({code:'UND_ERR_CONNECT_TIMEOUT'})});}},
 {name:'known socket reset',reason:'连接失败',phase:'request',code:'ECONNRESET',fetchImpl:async()=>{throw unsafeError({code:'ECONNRESET'});}},
 {name:'unknown error strings',reason:'连接失败',phase:'request',fetchImpl:async()=>{throw unsafeError({cause:unsafeError()});}},
 {name:'HTTP 503',reason:'HTTP状态异常',phase:'http',httpStatus:503,fetchImpl:async()=>reply(sensitive,503)},
 {name:'invalid HTTP metadata',reason:'HTTP状态异常',phase:'http',fetchImpl:async()=>({ok:false,status:sensitive,text:async()=>sensitive})},
 {name:'body read failure',reason:'响应读取失败',phase:'read',httpStatus:200,fetchImpl:async()=>({ok:true,status:200,text:async()=>{throw unsafeError();}})},
 {name:'malformed JSON',reason:'响应格式无效',phase:'parse',httpStatus:200,fetchImpl:async()=>reply(sensitive)},
 {name:'non-object JSON',reason:'响应格式无效',phase:'parse',httpStatus:200,fetchImpl:async()=>reply(JSON.stringify([sensitive]))},
 {name:'missing acknowledgement',reason:'响应未确认',phase:'ack',httpStatus:200,fetchImpl:async()=>reply({debug:sensitive})},
];
for(const scenario of diagnosticCases)test(`send diagnoses ${scenario.name} without disclosing input or retrying`,async()=>{
 let calls=0;
 const api=createWeixinApi({fetchImpl:async(...args)=>{calls++;return scenario.fetchImpl(...args);}});
 await assert.rejects(()=>api.send(auth),error=>checkDiagnostic(error,scenario));
 assert.equal(calls,1);
});
test('send diagnoses its own request deadline without retrying',async t=>{
 const timeout=AbortSignal.abort(new DOMException(sensitive,'TimeoutError'));
 t.mock.method(AbortSignal,'timeout',()=>timeout);
 let calls=0;
 const api=createWeixinApi({fetchImpl:async(_url,{signal})=>{calls++;throw signal.reason;}});
 await assert.rejects(()=>api.send(auth),error=>checkDiagnostic(error,{reason:'请求超时',phase:'request',requestTimeout:true}));
 assert.equal(calls,1);
});
test('send diagnoses external cancellation without exposing the reason or retrying',async()=>{
 const controller=new AbortController();let calls=0;
 const api=createWeixinApi({fetchImpl:async(_url,{signal})=>{calls++;controller.abort(unsafeError());throw signal.reason;}});
 await assert.rejects(()=>api.send({...auth,signal:controller.signal}),error=>checkDiagnostic(error,{reason:'请求中断',phase:'request',externalAbort:true}));
 assert.equal(calls,1);
});
test('business rejection keeps failed outcome and never exports an untrusted response code',async()=>{
 for(const ret of [-14,sensitive]){
  let calls=0;
  const api=createWeixinApi({fetchImpl:async()=>{calls++;return reply({ret});}});
  await assert.rejects(()=>api.send(auth),error=>{
   assert.equal(error.sendOutcome,'failed');assert.equal(error.message,'微信接口拒绝了请求');
   assert.equal(error.code,typeof ret==='number'?ret:undefined);
   assert.doesNotMatch(JSON.stringify(error),/token-test-secret|private\.example|private-context/);
   return true;
  });
  assert.equal(calls,1);
 }
});
