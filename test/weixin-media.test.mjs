import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { createWeixinApi } from '../src/weixin.mjs';

const MAX=10*1024*1024;
const auth={token:'synthetic-secret',baseUrl:'https://ilinkai.weixin.qq.com',peerId:'peer',contextToken:'context',clientId:'file-operation'};
const key=Buffer.from('0123456789abcdef');
const encrypt=bytes=>{const c=createCipheriv('aes-128-ecb',key,null);return Buffer.concat([c.update(bytes),c.final()]);};
const json=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
const attachment=(extra={})=>({kind:'file',name:'材料.txt',len:'6',media:{encrypt_query_param:'secret-query',aes_key:key.toString('base64')},...extra});

test('poll keeps file descriptors without downloading; images remain unsupported',async()=>{
 let calls=0;
 const api=createWeixinApi({fetchImpl:async()=>{calls++;return json({ret:0,msgs:[{message_id:'m',from_user_id:'peer',item_list:[{type:4,file_item:{file_name:'材料.txt',len:'6',media:attachment().media,unknown:'discard'}},{type:2,image_item:{media:{}}}]}]});}});
 const result=await api.poll(auth);assert.deepEqual(result.messages[0].attachments,[attachment()]);assert.equal(result.messages[0].unsupported,true);assert.equal(calls,1);
});
test('file download decrypts both official key encodings, verifies size/hash, and uses no bot credentials',async()=>{
 for(const aes_key of [key.toString('base64'),Buffer.from(key.toString('hex')).toString('base64')]){
  let captured;const bytes=Buffer.from('abcdef');
  const api=createWeixinApi({fetchImpl:async(url,opts)=>{captured={url,opts};return new Response(encrypt(bytes));}});
  const result=await api.downloadFile({attachment:attachment({md5:createHash('md5').update(bytes).digest('hex'),media:{aes_key,encrypt_query_param:'query /+'}})});
  assert.deepEqual(result,{name:'材料.txt',bytes});assert.equal(new URL(captured.url).searchParams.get('encrypted_query_param'),'query /+');assert.equal(captured.opts.redirect,'error');assert.equal(captured.opts.headers?.Authorization,undefined);
 }
});
test('file full URL wins, while hostile URLs, keys and filenames fail before fetching',async()=>{
 let calls=0;const api=createWeixinApi({fetchImpl:async()=>{calls++;return new Response(encrypt(Buffer.from('abcdef')));}});
 const full_url='https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=full';
 assert.equal((await api.downloadFile({attachment:attachment({media:{...attachment().media,full_url}})})).bytes.length,6);
 const bad=[attachment({name:'../private.txt'}),attachment({name:'a\\b.txt'}),attachment({len:String(MAX+1)}),attachment({media:{...attachment().media,aes_key:'abc'}}),...['http://novac2c.cdn.weixin.qq.com/c2c/download','https://novac2c.cdn.weixin.qq.com.evil.test/c2c/download','https://u:p@novac2c.cdn.weixin.qq.com/c2c/download','https://novac2c.cdn.weixin.qq.com/c2c/upload'].map(full_url=>attachment({media:{...attachment().media,full_url}}))];
 for(const value of bad)await assert.rejects(()=>api.downloadFile({attachment:value}));assert.equal(calls,1);
});
test('download refuses corrupt padding, incorrect length/hash and oversized streamed bodies without exposing URLs or keys',async()=>{
 const streams=[new Response(Buffer.alloc(15)),new Response(encrypt(Buffer.from('wrong'))),new Response(encrypt(Buffer.from('abcdef'))),new Response(new ReadableStream({start(c){c.enqueue(Buffer.alloc(MAX+17));c.close();}}))];
 const inputs=[attachment(),attachment(),attachment({md5:'0'.repeat(32)}),attachment({len:undefined})];
 for(let i=0;i<streams.length;i++){
  const api=createWeixinApi({fetchImpl:async()=>streams[i]});await assert.rejects(()=>api.downloadFile({attachment:inputs[i]}),e=>{assert.doesNotMatch(e.stack,/secret-query|MDEyMzQ1Njc4OWFiY2RlZg|wrong/);return true;});
 }
});
test('file send follows official upload and message protocol with one stable client identity',async()=>{
 const calls=[];let upload,sendBody;const bytes=Buffer.from('editable-pptx');
 const api=createWeixinApi({fetchImpl:async(url,opts)=>{calls.push({url,opts});if(url.endsWith('/getuploadurl')){upload=JSON.parse(opts.body);return json({upload_param:'upload-query'});}if(url.includes('/c2c/upload'))return new Response('',{headers:{'x-encrypted-param':'download-query'}});sendBody=JSON.parse(opts.body);return json({ret:0});}});
 assert.deepEqual(await api.sendFile({...auth,name:'演示.pptx',bytes}),{status:'api_accepted'});
 assert.equal(calls.length,3);assert.equal(upload.media_type,3);assert.equal(upload.filekey,auth.clientId);assert.equal(upload.rawsize,bytes.length);assert.equal(upload.filesize,16);assert.equal(upload.rawfilemd5,createHash('md5').update(bytes).digest('hex'));assert.equal(upload.no_need_thumb,true);
 const encrypted=Buffer.from(calls[1].opts.body),c=createDecipheriv('aes-128-ecb',Buffer.from(upload.aeskey,'hex'),null);assert.deepEqual(Buffer.concat([c.update(encrypted),c.final()]),bytes);assert.equal(calls[1].opts.headers.Authorization,undefined);assert.equal(calls[1].opts.redirect,'error');
 assert.equal(sendBody.msg.client_id,auth.clientId);assert.equal(sendBody.msg.context_token,'context');assert.equal(sendBody.msg.item_list[0].type,4);assert.deepEqual(sendBody.msg.item_list[0].file_item,{file_name:'演示.pptx',len:String(bytes.length),media:{encrypt_query_param:'download-query',aes_key:Buffer.from(upload.aeskey).toString('base64'),encrypt_type:1}});
});
test('upload failure or revoked authorization is failed before message submission; uncertain submission is never retried',async()=>{
 for(const scenario of ['network','bad-url','missing-header','revoked','send-uncertain']){
  let calls=0,allowed=true;const api=createWeixinApi({fetchImpl:async(url)=>{calls++;if(url.endsWith('/getuploadurl')){if(scenario==='network')throw new Error('secret-query');return json(scenario==='bad-url'?{upload_full_url:'https://evil.test/token'}:{upload_param:'upload-query'});}if(url.includes('/c2c/upload')){allowed=false;return new Response('',{headers:scenario==='missing-header'?{}:{'x-encrypted-param':'down'}});}return json({});}});
  await assert.rejects(()=>api.sendFile({...auth,name:'a.pptx',bytes:Buffer.from('a'),authorize:()=>scenario==='revoked'?allowed:true}),e=>{assert.equal(e.sendOutcome,scenario==='send-uncertain'?'uncertain':'failed');assert.doesNotMatch(e.stack,/secret-query|evil.test/);return true;});
  assert.equal(calls,scenario==='send-uncertain'?3:scenario==='network'||scenario==='bad-url'?1:2);
 }
});
test('outgoing unsafe names, empty/oversized content and cancellation fail without upload',async()=>{
 let calls=0;const api=createWeixinApi({fetchImpl:async()=>{calls++;return json({});}});
 for(const override of [{name:'../a'},{bytes:Buffer.alloc(0)},{bytes:Buffer.alloc(MAX+1)},{signal:AbortSignal.abort('private')}])await assert.rejects(()=>api.sendFile({...auth,name:'a.pptx',bytes:Buffer.from('a'),...override}),e=>e.sendOutcome==='failed');assert.equal(calls,0);
});
test('download abort cancels a pending stream and never returns partial plaintext',async()=>{
 const controller=new AbortController();let cancelled=false,opened;
 const ready=new Promise(r=>opened=r);
 const api=createWeixinApi({fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(Buffer.alloc(16));opened();},cancel(){cancelled=true;}}))});
 const pending=api.downloadFile({attachment:attachment(),signal:controller.signal});await ready;controller.abort('private cancellation');
 await assert.rejects(pending,e=>e.code==='WEIXIN_FILE_FAILED'&&!e.message.includes('private'));assert.equal(cancelled,true);
});
test('unsupported encryption scheme is rejected before downloading',async()=>{
 let calls=0;const api=createWeixinApi({fetchImpl:async()=>{calls++;return new Response(encrypt(Buffer.from('abcdef')));}});
 await assert.rejects(()=>api.downloadFile({attachment:attachment({media:{...attachment().media,encrypt_type:99}})}));assert.equal(calls,0);
});
