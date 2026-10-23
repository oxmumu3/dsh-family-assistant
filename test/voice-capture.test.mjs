import test from 'node:test';
import assert from 'node:assert/strict';
import { createFamilyVoice, FamilyRecording, encodeFamilyWave } from '../src/voice-capture.mjs';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const ready=()=>({available:true,ready:true,phase:'ready',providerId:'sensevoice-local',language:'auto',maxDurationSeconds:120,maxAudioBytes:4*1024*1024,providers:[{id:'sensevoice-local',location:'host-local',preparation:{phase:'ready'}}]});
function fixture({catalog=ready(),transcribe=async()=>({text:'给家人安排明天的消息'}),start=async()=>{},stop=async()=>new Uint8Array([1,2]),env={}}={}){
  const calls=[],captures=[],timers=new Map();let id=0;
  const environment={AbortController,btoa,valueOf:()=>0,Date,document:new EventTarget(),addEventListener(){},removeEventListener(){},setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),setInterval:(fn,ms)=>{timers.set(++id,{fn,ms,interval:true});return id;},clearInterval:id=>timers.delete(id),...env};
  const bridge=createFamilyVoice({env:environment,request:async(action,body,signal)=>{calls.push({action,body,signal});if(action==='catalog')return catalog;if(action==='transcribe')return transcribe(body,signal);return catalog;},createRecording:()=>{const capture={disposed:0,start,stop,amplitude:()=>0.15,dispose:async()=>{capture.disposed++;}};captures.push(capture);return capture;}});
  return{bridge,calls,captures,timers,setCatalog:value=>{catalog=value;}};
}
const insertion={contextKey:'owner',draft:'现有文字',selectionStart:4,selectionEnd:4};

test('voice requires local readiness, does not record or download just by starting unprepared',async()=>{
  const f=fixture({catalog:{...ready(),ready:false,phase:'unprepared'}});await f.bridge.start(insertion);
  assert.equal(f.bridge.status().phase,'setup');assert.equal(f.captures.length,0);assert.deepEqual(f.calls.map(x=>x.action),['catalog']);
  await f.bridge.prepare();assert.equal(f.calls.some(x=>x.action==='prepare'),true);assert.equal(f.captures.length,0);f.bridge.dispose();
});
test('start readiness refresh never publishes idle before requesting and recording',async()=>{
  const f=fixture(),phases=[];f.bridge.subscribe(state=>phases.push(state.phase));
  await f.bridge.refresh();assert.equal(f.bridge.status().phase,'idle');
  phases.length=0;await f.bridge.start(insertion);
  assert.deepEqual(phases,['checking','checking','requesting','recording']);
  assert.equal(phases.includes('idle'),false);f.bridge.dispose();
});
test('passive setup refresh becomes idle when preparation completes without starting capture',async()=>{
  const f=fixture({catalog:{...ready(),ready:false,phase:'downloading'}});await f.bridge.refresh();assert.equal(f.bridge.status().phase,'setup');
  f.setCatalog(ready());await f.bridge.refresh();assert.equal(f.bridge.status().phase,'idle');assert.equal(f.captures.length,0);f.bridge.dispose();
});
test('failed start readiness refresh cannot reuse earlier ready state to open microphone',async()=>{
  const f=fixture();await f.bridge.refresh();assert.equal(f.bridge.status().readiness.ready,true);
  f.setCatalog(Promise.reject(Error('offline')));await f.bridge.start(insertion);
  assert.equal(f.bridge.status().phase,'unavailable');assert.equal(f.captures.length,0);f.bridge.dispose();
});
test('recording stops into editable text with captured draft, only local ASR and never a send action',async()=>{
  const f=fixture();let state;f.bridge.subscribe(value=>{state=value;});await f.bridge.start(insertion);assert.equal(state.phase,'recording');
  await f.bridge.stop();assert.equal(state.phase,'transcript');assert.equal(state.transcript,'给家人安排明天的消息');assert.deepEqual(state.capture,insertion);
  const call=f.calls.find(x=>x.action==='transcribe');assert.equal(call.body.providerId,'sensevoice-local');assert.equal(call.body.language,'auto');assert.equal(call.body.audioBase64,'AQI=');assert.equal(f.captures[0].disposed,1);
  assert.deepEqual(f.calls.map(x=>x.action),['catalog','transcribe']);f.bridge.cancel();assert.equal(state.transcript,'');assert.equal(state.capture,null);f.bridge.dispose();
});
test('late permission grant is cancelled and releases tracks without starting recorder',async()=>{
  const permission=deferred();let stopped=0,recorders=0;
  const recording=new FamilyRecording({env:{AbortController,navigator:{mediaDevices:{getUserMedia:()=>permission.promise}},MediaRecorder:class{constructor(){recorders++;}}}});
  const pending=recording.start();await recording.dispose();permission.resolve({getTracks:()=>[{stop(){stopped++;}}]});
  await assert.rejects(pending,/cancelled/);assert.equal(stopped,1);assert.equal(recorders,0);
});
test('context change aborts transcription and discards late result',async()=>{
  const transcription=deferred();const f=fixture({transcribe:()=>transcription.promise});await f.bridge.start(insertion);const pending=f.bridge.stop();await tick();
  const call=f.calls.find(x=>x.action==='transcribe');f.bridge.contextChanged('someone-else');assert.equal(call.signal.aborted,true);
  transcription.resolve({text:'不应插入'});await pending;assert.equal(f.bridge.status().phase,'idle');assert.equal(f.bridge.status().transcript,'');f.bridge.dispose();
});
test('permission cancelled while waiting cannot turn into a new active recording',async()=>{
  const permission=deferred();const f=fixture({start:()=>permission.promise});const pending=f.bridge.start(insertion);await tick();f.bridge.cancel();permission.resolve();await pending;
  assert.equal(f.bridge.status().phase,'idle');assert.equal(f.captures[0].disposed,1);assert.equal(f.calls.some(x=>x.action==='transcribe'),false);f.bridge.dispose();
});
test('time limit finishes capture, duplicate stop is ignored, all timers and resources close on disposal',async()=>{
  const f=fixture();await f.bridge.start(insertion);const timer=[...f.timers.values()].find(x=>x.ms===120000);assert.ok(timer);timer.fn();await tick();
  assert.equal(f.bridge.status().phase,'transcript');await f.bridge.stop();assert.equal(f.calls.filter(x=>x.action==='transcribe').length,1);
  f.bridge.dispose();assert.equal(f.timers.size,0);
});
test('subscriber exceptions do not break recording and unsubscribe stops notifications',async()=>{
  const f=fixture();f.bridge.subscribe(()=>{throw Error('consumer broke');});let seen=0;const unsub=f.bridge.subscribe(()=>{seen++;});assert.equal(seen,1);unsub();await f.bridge.start(insertion);assert.equal(seen,1);f.bridge.dispose();
});
test('context invalidation from a subscriber cannot leave a microphone request or timer behind',async()=>{
  for(const phase of ['requesting','recording']){
    let started=0;const f=fixture({start:async()=>{started++;}});f.bridge.subscribe(state=>{if(state.phase===phase)f.bridge.contextChanged('changed');});await f.bridge.start(insertion);
    assert.equal(f.bridge.status().phase,'idle');assert.equal(started,phase==='requesting'?0:1);assert.equal(f.timers.size,0);assert.equal(f.captures[0].disposed,1);f.bridge.dispose();
  }
});
test('transcript stays only in memory and blank audio is a recoverable error',async()=>{
  const f=fixture({transcribe:async()=>({text:'   '})});await f.bridge.start(insertion);await f.bridge.stop();assert.equal(f.bridge.status().phase,'error');assert.match(f.bridge.status().message,/没有识别/);assert.equal(f.bridge.status().transcript,'');f.bridge.dispose();
});
test('capture error, API failure and excess bytes release resources',async()=>{
  for(const options of [{start:async()=>{throw Object.assign(Error('denied'),{name:'NotAllowedError'});}},{transcribe:async()=>{throw Error('unavailable');}},{catalog:{...ready(),maxAudioBytes:1}}]){
    const f=fixture(options);await f.bridge.start(insertion);await f.bridge.stop();assert.equal(f.bridge.status().phase,'error');assert.equal(f.captures[0].disposed,1);assert.equal(f.timers.size,0);f.bridge.dispose();
  }
});
test('WAV encoding pins PCM16 mono 16kHz with clipped samples',()=>{
  const bytes=encodeFamilyWave(new Float32Array([-2,-1,0,1,2]));const view=new DataView(bytes.buffer);
  assert.equal(new TextDecoder().decode(bytes.slice(0,4)),'RIFF');assert.equal(view.getUint32(24,true),16000);assert.equal(view.getUint16(22,true),1);assert.equal(view.getUint16(34,true),16);
  assert.equal(view.getInt16(44,true),-32768);assert.equal(view.getInt16(48,true),0);assert.equal(view.getInt16(52,true),32767);
});

test('OS permission prompt blur does not cancel first grant; hiding page does cancel it',async()=>{
  for(const hide of [false,true]){
    const permission=deferred(),events=new EventTarget(),document=new EventTarget();
    const f=fixture({start:()=>permission.promise,env:{document,addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)}});
    const pending=f.bridge.start(insertion);await tick();assert.equal(f.bridge.status().phase,'requesting');
    events.dispatchEvent(new Event('blur'));assert.equal(f.bridge.status().phase,'requesting');
    if(hide){document.hidden=true;document.dispatchEvent(new Event('visibilitychange'));}
    permission.resolve();await pending;assert.equal(f.bridge.status().phase,hide?'idle':'recording');f.bridge.dispose();
  }
});

function mediaFixture({duration=2,decodeFailure=false,closeFailure=false}={}){
  const record={requested:0,stopped:0,closed:0,resampled:0,recorders:0},track=new EventTarget();track.stop=()=>{record.stopped++;};
  const stream={getTracks:()=>[track]};
  class Recorder {
    constructor(){record.recorders++;this.state='inactive';this.mimeType='audio/webm';}
    start(){this.state='recording';}
    stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(['synthetic'])});this.onstop?.();});}
  }
  class Audio {
    constructor(){this.state='running';}
    createAnalyser(){return{getFloatTimeDomainData:array=>array.fill(.2)};}
    createMediaStreamSource(){return{connect(){}};}
    async decodeAudioData(){if(decodeFailure)throw Error('cannot decode');return{duration};}
    async close(){record.closed++;this.state='closed';if(closeFailure)throw Error('close failed');}
  }
  class Offline {
    constructor(_channels,length){record.resampled=length;this.length=length;this.destination={};}
    createBufferSource(){return{connect(){},start(){}};}
    async startRendering(){return{getChannelData:()=>new Float32Array(this.length)};}
  }
  return{record,track,env:{AbortController,Blob,setTimeout,clearTimeout,navigator:{mediaDevices:{getUserMedia:async()=>{record.requested++;return stream;}}},MediaRecorder:Recorder,AudioContext:Audio,OfflineAudioContext:Offline}};
}

test('native recorder releases microphone, truncates overshoot, and produces canonical WAV',async()=>{
  const {env,record}=mediaFixture({duration:122,closeFailure:true});const recording=new FamilyRecording({env});
  assert.equal(record.requested,0);await recording.start();assert.equal(record.requested,1);assert.ok(recording.amplitude()>.19);
  const bytes=await recording.stop(120);assert.equal(bytes.length,44+16000*120*2);assert.equal(record.resampled,16000*120);assert.ok(record.stopped>=1);assert.equal(record.closed,1);
  await recording.dispose().catch(()=>{});assert.equal(record.closed,1);
});
test('decoder failure and device interruption always release tracks and AudioContext',async()=>{
  for(const failure of ['decoder','device']){
    const {env,record,track}=mediaFixture({decodeFailure:failure==='decoder'});let interrupted=false;const recording=new FamilyRecording({env});await recording.start(()=>{interrupted=true;});
    if(failure==='decoder')await assert.rejects(recording.stop(120),/cannot decode/);else{track.dispatchEvent(new Event('ended'));await tick();assert.equal(interrupted,true);}
    assert.ok(record.stopped>=1);assert.equal(record.closed,1);
  }
});

test('compiled Host client owns voice before iframe mounts and removes only its own bridge on unmount',async()=>{
  const source=await readFile(new URL('../src/client.js',import.meta.url),'utf8'),capture=await readFile(new URL('../src/voice-capture.mjs',import.meta.url),'utf8'),entry=await readFile(new URL('../src/client-entry.js',import.meta.url),'utf8');
  assert.ok(source.includes(capture.replace(/^export /gm,'')));assert.ok(source.includes(entry));
  const effects=[],slots=[],document=new EventTarget(),previousVoice={existing:true};let definition;
  const React={createElement:()=>null,useState:()=>['',()=>{}],useEffect:fn=>effects.push(fn)};
  const window={__ModuleLoader__:{load:value=>{definition=value;}},__FamilyVoice:previousVoice};
  runInNewContext(source,{window,document,AbortController,Date,btoa,setTimeout,clearTimeout,setInterval,clearInterval,fetch:async()=>({ok:true,text:async()=>'<html></html>'})});
  definition.factory(()=>React).apply({effect:fn=>fn(),slots:{inject:(_key,fn)=>fn(),register:(metadata,component)=>{slots.push({metadata,component});}}});
  slots.find(x=>x.metadata.key==='family-assistant').component();const cleanup=effects[0]();assert.equal(typeof window.__FamilyVoice.start,'function');assert.notEqual(window.__FamilyVoice,previousVoice);const bridge=window.__FamilyVoice;
  cleanup();assert.equal(window.__FamilyVoice,previousVoice);assert.equal(window.__FamilyHostFetch,undefined);assert.equal(bridge.status().phase,'idle');
  await tick();
});
