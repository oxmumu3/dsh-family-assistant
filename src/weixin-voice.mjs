import {Worker} from 'node:worker_threads';
import {MAX_VOICE_BYTES} from './weixin-media.mjs';

const codes=new Set(['format','limit','failed','cancelled','unavailable','empty']);
const failure=code=>Object.assign(new Error(code==='unavailable'?'本机语音识别还没准备好，请让家庭联系人在工作台准备语音，或先发文字。':'这段语音没能听清，请重新说一次，或用微信转文字后发给我。'),{code:`family-voice/${codes.has(code)?code:'failed'}`});
function decodeLocal(bytes,descriptor,signal,timeoutMs){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(failure('cancelled'));
    const worker=new Worker(new URL('./weixin-voice-worker.mjs',import.meta.url),{workerData:{bytes,descriptor:{encodeType:descriptor?.encodeType,bitsPerSample:descriptor?.bitsPerSample,sampleRate:descriptor?.sampleRate,durationMs:descriptor?.durationMs}},
      resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8,stackSizeMb:2},execArgv:[]});
    let settled=false;
    const finish=(error,audio)=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);void worker.terminate();
      if(error)reject(error);else resolve(audio);
    };
    const cancel=()=>finish(failure('cancelled'));
    const timer=setTimeout(()=>finish(failure('failed')),timeoutMs);
    signal?.addEventListener('abort',cancel,{once:true});
    worker.once('message',result=>{
      if(result.error)return finish(failure(result.error));
      const audio=Buffer.from(result.audio??[]);
      if(audio.length<46||audio.length>MAX_VOICE_BYTES)return finish(failure('format'));
      finish(null,audio);
    });
    worker.once('error',()=>finish(failure('failed')));
    worker.once('exit',()=>{if(!settled)finish(failure('failed'));});
    if(signal?.aborted)cancel();
  });
}

/** Adapt authenticated inbound media to the SAME official local Host voice instance used by the workbench. */
export function createWeixinVoiceTranscriber({voice,timeoutMs=10_000}={}){
  const deadline=Number.isFinite(timeoutMs)?Math.min(30_000,Math.max(1,timeoutMs)):10_000;
  let tail=Promise.resolve();
  return input=>{
    // Keep one codec/ASR request active across members; each request keeps its original abort signal.
    const task=tail.catch(()=>{}).then(async()=>{
      const {bytes,descriptor,signal}=input??{};
      if(signal?.aborted)throw failure('cancelled');
      if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_VOICE_BYTES)throw failure('limit');
      try {
        if(typeof voice?.status!=='function'||typeof voice?.transcribe!=='function'||!(await voice.status()).ready)throw failure('unavailable');
        if(signal?.aborted)throw failure('cancelled');
        const wav=await decodeLocal(bytes,descriptor,signal,deadline);
        if(signal?.aborted)throw failure('cancelled');
        const result=await voice.transcribe({audioBase64:wav.toString('base64'),language:'auto'},signal);
        if(signal?.aborted)throw failure('cancelled');
        if(typeof result?.text!=='string'||!result.text.trim()||result.text.length>6000)throw failure('empty');
        return{text:result.text.trim()};
      } catch(error) {
        if(signal?.aborted)throw failure('cancelled');
        const code=String(error?.code??'').replace(/^family-voice\//u,'');throw failure(codes.has(code)?code:'failed');
      }
    });
    tail=task;return task;
  };
}
