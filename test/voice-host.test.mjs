import test from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import {createHostVoice,OFFICIAL_VOICE_BUNDLE,LOCAL_VOICE_PROVIDER,VOICE_BODY_LIMIT} from '../src/voice-host.mjs';
import {createHttpHandler,registerHostRoutes} from '../src/http.mjs';
import {familyVoiceRequest} from '../src/voice-capture.mjs';

const local=(phase='unprepared')=>({id:LOCAL_VOICE_PROVIDER,name:'Local test recognizer',location:'host-local',languages:['auto','zh'],downloadSources:['https://models.example'],preparation:{phase}});
const deferred=()=>Promise.withResolvers();
async function until(check){for(let i=0;i<100;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,2));}throw new Error('state did not settle');}
function fixture({phase='unprepared',present=true,bundle={name:OFFICIAL_VOICE_BUNDLE,availability:'installation',installed:false,enabled:false}}={}){
  const calls=[],provider=local(phase),selection={providerId:'cloud-global',language:'en'};
  const speech={catalog:()=>({providers:[provider,{id:'cloud-global',location:'cloud',languages:['en'],preparation:{phase:'ready'}}],selection,maxAudioBytes:4*1024*1024,maxDurationSeconds:120}),
    prepare(id,options){calls.push(['prepare',id,options]);provider.preparation={phase:'downloading',resource:'model',completedBytes:123,totalBytes:1000};},
    async cancelPreparation(id){calls.push(['cancel',id]);provider.preparation={phase:'cancelled'};},
    async transcribe(input,signal){calls.push(['transcribe',input,signal]);return{text:'这是语音草稿',audioSeconds:3,inferenceSeconds:.5};}};
  const services={...(present?{speechController:speech}:{}),pluginManager:{async listBundles(){return[bundle];},
    async setBundleEnabled(name,enabled){calls.push(['enable',name,enabled]);services.speechController=speech;return{application:'applied'};},
    async installBundle(spec,options){calls.push(['install',spec,options]);services.speechController=speech;return{application:'applied'};},
    async cancelInstall(id){calls.push(['cancelInstall',id]);return 'cancelled';}}};
  const voice=createHostVoice({get:name=>services[name]},{activationTimeoutMs:10,activationPollMs:1});
  return {voice,calls,services,speech,provider,selection};
}

test('passive status does not install, activate, prepare or alter global voice preferences',async()=>{
  const {voice,calls,selection}=fixture({present:false});
  const state=await voice.status();assert.equal(state.phase,'unprepared');assert.equal(state.ready,false);
  assert.equal(state.selection.providerId,LOCAL_VOICE_PROVIDER);assert.equal(state.selection.language,'auto');
  assert.deepEqual(calls,[]);assert.deepEqual(selection,{providerId:'cloud-global',language:'en'});voice.dispose();
});

test('first-use setup enables the shipped bundle without reinstalling, then prepares local models once',async()=>{
  const {voice,calls,provider}=fixture({present:false});
  await Promise.all([voice.prepare(),voice.prepare()]);
  await until(async()=>(await voice.status()).phase==='downloading');
  assert.deepEqual(calls.map(call=>call[0]),['enable','prepare']);
  assert.equal(calls[0][1],OFFICIAL_VOICE_BUNDLE);assert.equal(calls[1][1],LOCAL_VOICE_PROVIDER);
  const state=await voice.status();assert.equal(state.providers[0].preparation.completedBytes,123);
  await voice.prepare();assert.equal(calls.length,2,'polling or another click must not duplicate preparation');
  provider.preparation={phase:'standby'};assert.equal((await voice.status()).ready,true);voice.dispose();
});

test('first activation waits for cache inspection before one prepare call, without needing a second click',async()=>{
  const {voice,calls,provider,speech}=fixture({present:false,phase:'checking'});
  let inspecting=true;
  const originalPrepare=speech.prepare;
  speech.prepare=(...args)=>{if(inspecting){calls.push(['swallowed']);return;}originalPrepare(...args);};
  await voice.prepare();await until(()=>calls.some(call=>call[0]==='enable'));
  assert.equal((await voice.status()).phase,'checking');assert.equal(calls.filter(call=>call[0]==='prepare').length,0);
  provider.preparation={phase:'unprepared'};
  queueMicrotask(()=>{inspecting=false;});
  await until(()=>calls.some(call=>call[0]==='prepare'));
  assert.deepEqual(calls.map(call=>call[0]),['enable','prepare']);assert.equal((await voice.status()).phase,'downloading');voice.dispose();
});

test('a click during an already active inspection preserves preparation intent and reuses work that starts meanwhile',async()=>{
  for(const settledPhase of ['unprepared','downloading','loading','ready','standby']){
    const {voice,calls,provider}=fixture({phase:'checking'});
    await voice.prepare();provider.preparation={phase:settledPhase};
    await until(async()=>(await voice.status()).setup.phase==='idle');
    assert.equal(calls.filter(call=>call[0]==='prepare').length,settledPhase==='unprepared'?1:0,settledPhase);
    voice.dispose();
  }
});

test('initial inspection wait is bounded and cancelled or disposed setup cannot start a late download',async()=>{
  const stuck=fixture({phase:'checking'});
  const bounded=createHostVoice({get:name=>stuck.services[name]},{activationPollMs:1,inspectionTimeoutMs:5});
  await bounded.prepare();await until(async()=>(await bounded.status()).phase==='failed');
  assert.match((await bounded.status()).message,/检查耗时/);assert.deepEqual(stuck.calls,[]);bounded.dispose();stuck.voice.dispose();
  for(const end of ['cancel','dispose']){
    const {voice,calls,provider}=fixture({phase:'checking'});await voice.prepare();
    if(end==='cancel')await voice.cancelPreparation();else voice.dispose();
    provider.preparation={phase:'unprepared'};await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(calls.filter(call=>call[0]==='prepare').length,0,end);voice.dispose();
  }
});

test('missing dependency uses only the official catalog compatible install target and never arbitrary caller specs',async()=>{
  const {voice,calls}=fixture({present:false,bundle:{name:OFFICIAL_VOICE_BUNDLE,availability:'missing',enabled:false,installTarget:{spec:`${OFFICIAL_VOICE_BUNDLE}@0.2.1-rc.2`}}});
  await voice.prepare();await until(()=>calls.some(call=>call[0]==='prepare'));
  assert.equal(calls[0][0],'install');assert.equal(calls[0][1],`${OFFICIAL_VOICE_BUNDLE}@0.2.1-rc.2`);
  assert.equal(calls[0][2].enabled,true);assert.equal(calls[0][2].saveExact,true);assert.match(calls[0][2].requestId,/^[\da-f-]{36}$/);
  voice.dispose();
});

test('existing official provider is reused without global service duplication or global selection writes',async()=>{
  const {voice,calls,selection}=fixture({phase:'ready'});
  assert.equal((await voice.prepare()).ready,true);
  const result=await voice.transcribe({audioBase64:'test'});
  assert.equal(result.text,'这是语音草稿');assert.equal(calls.length,1);assert.equal(calls[0][0],'transcribe');
  assert.equal(calls[0][1].providerId,LOCAL_VOICE_PROVIDER);assert.equal(calls[0][1].language,'auto');
  assert.deepEqual(selection,{providerId:'cloud-global',language:'en'});voice.dispose();
});

test('restart-required is surfaced and never falsely reports a ready recorder or starts model preparation',async()=>{
  const {voice,calls,services}=fixture({present:false});
  services.pluginManager.setBundleEnabled=async()=>({application:'restart-required'});
  await voice.prepare();await until(async()=>(await voice.status()).phase==='restart_required');
  assert.equal((await voice.status()).ready,false);assert.deepEqual(calls,[]);voice.dispose();
});

test('failed setup sanitizes raw diagnostics and can be retried',async()=>{
  const {voice,services,calls}=fixture({present:false});
  const activate=services.pluginManager.setBundleEnabled;
  services.pluginManager.setBundleEnabled=async()=>{throw new Error('secret=/private/person TOKEN=abc');};
  await voice.prepare();await until(async()=>(await voice.status()).phase==='failed');
  assert.doesNotMatch(JSON.stringify(await voice.status()),/secret|private|TOKEN/);
  services.pluginManager.setBundleEnabled=activate;await voice.prepare();await until(()=>calls.some(call=>call[0]==='prepare'));voice.dispose();
});

test('preparation accepts only advertised model sources and cancellation targets local provider',async()=>{
  const {voice,calls}=fixture();
  await voice.prepare({downloadSource:'https://untrusted.example'});await until(async()=>(await voice.status()).phase==='failed');
  assert.equal(calls.length,0);
  await voice.prepare({downloadSource:'https://models.example'});await until(()=>calls.some(call=>call[0]==='prepare'));
  assert.deepEqual(calls[0],['prepare',LOCAL_VOICE_PROVIDER,{downloadSource:'https://models.example'}]);
  await voice.cancelPreparation();assert.equal((await voice.status()).phase,'cancelled');assert.equal(calls.at(-1)[1],LOCAL_VOICE_PROVIDER);voice.dispose();
});

test('pending install remains asynchronous, deduplicated and cancellable without preparing later',async()=>{
  const {voice,calls,services}=fixture({present:false,bundle:{name:OFFICIAL_VOICE_BUNDLE,availability:'missing',installTarget:{spec:'official-compatible'}}});
  const gate=deferred();let installCalls=0;
  services.pluginManager.installBundle=async()=>{installCalls++;return gate.promise;};
  services.pluginManager.cancelInstall=async()=>{gate.resolve({application:'cancelled'});return 'cancelled';};
  assert.equal((await voice.prepare()).phase,'installing');
  await voice.prepare();assert.equal(installCalls,1);
  assert.equal((await voice.cancelPreparation()).phase,'cancelled');
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(calls.length,0);voice.dispose();
});

test('actual Cordis lifecycle disposes ASR requests without waiting on a manager HMR transaction',async()=>{
  const ctx=new Context(),gate=deferred();let captured;
  ctx.provide('speechController',{catalog:()=>({providers:[local('ready')],selection:{providerId:LOCAL_VOICE_PROVIDER,language:'auto'},maxAudioBytes:4*1024*1024,maxDurationSeconds:120}),
    transcribe(_input,signal){captured=signal;signal.addEventListener('abort',()=>gate.reject(signal.reason),{once:true});return gate.promise;}});
  let voice;
  const fiber=ctx.plugin({apply(scope){voice=createHostVoice(scope);scope.effect(()=>()=>voice.dispose());}});await fiber;
  const pending=voice.transcribe({audioBase64:'test'});await fiber.dispose();
  await assert.rejects(pending,/已取消/);assert.equal(captured.aborted,true);await ctx.fiber.dispose();
});

test('recording rejects cloud routing and oversized payloads before official controller, caller abort propagates',async()=>{
  const {voice,calls,speech}=fixture({phase:'ready'});
  await assert.rejects(voice.transcribe({audioBase64:'test',providerId:'cloud-global'}),/本机识别/);
  await assert.rejects(voice.transcribe({audioBase64:'a'.repeat(Math.ceil(4*1024*1024/3)*4+1)}),/超过限制/);
  assert.equal(calls.length,0);
  const abort=new AbortController();speech.transcribe=async(_input,signal)=>{abort.abort();signal.throwIfAborted();};
  await assert.rejects(voice.transcribe({audioBase64:'test'},abort.signal),/已取消/);voice.dispose();
});

test('voice HTTP is authenticated-carrier scoped, bounded and cannot call runtime message actions',async()=>{
  const calls=[],voice={status:async()=>({phase:'ready'}),prepare:async options=>{calls.push(options);return{phase:'checking'};},transcribe:async(input,signal)=>{calls.push([input,signal]);return{text:'草稿'};}};
  const handler=createHttpHandler({runtime:{action(){throw new Error('must not send a message');}},voice});
  const request=(input,extra={})=>new Request('http://dsh.internal/api/family/voice/action',{method:'POST',headers:{'Content-Type':'application/json','X-Family-Action':'1',...extra},body:JSON.stringify(input)});
  assert.equal((await handler(request({action:'setup'},{Origin:'https://evil.example'}))).status,403);
  assert.equal((await handler(request({action:'setup',spec:'anything'}))).status,400);
  assert.equal((await handler(request({action:'transcribe',audioBase64:'a'.repeat(VOICE_BODY_LIMIT)}))).status,413);
  assert.deepEqual(calls,[]);
  assert.equal((await handler(new Request('http://dsh.internal/api/family/voice'))).status,200);
  assert.equal((await handler(request({action:'setup'}))).status,200);
  const response=await handler(request({action:'transcribe',audioBase64:'test'}));assert.deepEqual(await response.json(),{text:'草稿'});
  assert.equal(calls.length,2);assert.ok(calls[1][1] instanceof AbortSignal);
});

test('chunked voice upload is cancelled at the application bound before JSON parsing or recognition',async()=>{
  let cancelled=false,pulls=0,recognitions=0;
  const handler=createHttpHandler({voice:{transcribe(){recognitions++;}}});
  const stream=new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}});
  const response=await handler(new Request('http://dsh.internal/api/family/voice/action',{method:'POST',duplex:'half',
    headers:{'Content-Type':'application/json','X-Family-Action':'1'},body:stream}));
  assert.equal(response.status,413);assert.equal(cancelled,true);assert.equal(recognitions,0);assert.ok(pulls<=8);
});

test('client catalog and audio actions survive the Host body-mode carrier and use distinct exact routes',async()=>{
  const routes=new Map(),calls=[];
  const voice={status:async()=>({ready:true,phase:'ready'}),prepare:async()=>({phase:'checking'}),
    transcribe:async input=>({text:input.audioBase64==='dGVzdA=='?'草稿':'unexpected'})};
  const unregister=registerHostRoutes({get:()=>({fetch:{register(route){
    assert.equal(routes.has(route.path),false,'Host exact route registry is keyed only by pathname');routes.set(route.path,route);return async()=>routes.delete(route.path);
  }}})},createHttpHandler({voice}));
  const request=familyVoiceRequest({fetch:async(path,init)=>{
    calls.push({path,method:init.method});const route=routes.get(path);
    assert.ok(route?.methods.includes(init.method),'client method must be owned by this exact route');
    // Reproduce the real Host carrier contract: a streaming route attaches a
    // body regardless of method, which is invalid for GET and HEAD.
    const incoming=new Request('http://dsh.internal'+path,route.requestBody==='streaming'
      ?{...init,body:new Blob([init.body??'']).stream(),duplex:'half'}:init);
    return route.fetch(incoming);
  }});
  assert.equal((await request('catalog')).ready,true);
  assert.equal((await request('prepare')).phase,'checking');
  assert.equal((await request('transcribe',{audioBase64:'dGVzdA=='})).text,'草稿');
  assert.deepEqual(calls,[{path:'/api/family/voice',method:'GET'},{path:'/api/family/voice/action',method:'POST'},{path:'/api/family/voice/action',method:'POST'}]);
  assert.equal(routes.get('/api/family/voice/action').requestBody,'streaming');
  await unregister();assert.equal(routes.size,0);
});
