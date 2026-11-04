import {parentPort,workerData} from 'node:worker_threads';
import {decode,getDuration,isSilk} from 'silk-wasm';

const MAX_BYTES=4*1024*1024,MAX_SECONDS=120,RATE=16000;
const fail=code=>{throw Object.assign(new Error('Invalid voice audio'),{code});};
function wave(pcm,sampleRate){
  if(!pcm.length||pcm.length%2||!Number.isInteger(sampleRate)||![8000,12000,16000,24000,32000,44100,48000].includes(sampleRate))fail('format');
  const sourceSamples=pcm.length/2,seconds=sourceSamples/sampleRate;
  if(seconds>MAX_SECONDS)fail('limit');
  const count=Math.floor(sourceSamples*RATE/sampleRate);
  if(!count||count*2+44>MAX_BYTES)fail('limit');
  const wav=Buffer.alloc(44+count*2);
  wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(RATE,24);wav.writeUInt32LE(RATE*2,28);
  wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(count*2,40);
  // Raw PCM metadata has no channel field: Tencent's voice PCM is admitted as mono PCM16 only.
  for(let index=0;index<count;index++){
    const position=index*sampleRate/RATE,left=Math.min(sourceSamples-1,Math.floor(position)),right=Math.min(sourceSamples-1,left+1),fraction=position-left;
    wav.writeInt16LE(Math.round(pcm.readInt16LE(left*2)*(1-fraction)+pcm.readInt16LE(right*2)*fraction),44+index*2);
  }
  return wav;
}
async function convert(){
  const bytes=Buffer.from(workerData.bytes),descriptor=workerData.descriptor??{};
  if(!bytes.length||bytes.length>MAX_BYTES)fail('limit');
  if(descriptor.durationMs!==undefined&&(!Number.isSafeInteger(descriptor.durationMs)||descriptor.durationMs<=0||descriptor.durationMs>MAX_SECONDS*1000))fail('limit');
  if(isSilk(bytes)){
    if(descriptor.encodeType!==undefined&&descriptor.encodeType!==6)fail('format');
    const duration=getDuration(bytes);
    if(!Number.isFinite(duration)||duration<=0||duration>MAX_SECONDS*1000)fail('limit');
    // Decode at the Host's sample rate; no executable, cloud service or global codec is used.
    const result=await decode(bytes,RATE);
    if(!result.data?.length||result.data.length>MAX_SECONDS*RATE*2||result.duration>MAX_SECONDS*1000)fail('limit');
    return wave(Buffer.from(result.data),RATE);
  }
  if(bytes.length>=44&&bytes.toString('ascii',0,4)==='RIFF'){
    if(bytes.toString('ascii',8,16)!=='WAVEfmt '||bytes.readUInt32LE(4)!==bytes.length-8||bytes.readUInt32LE(16)!==16||bytes.readUInt16LE(20)!==1||bytes.readUInt16LE(22)!==1||bytes.readUInt16LE(34)!==16||bytes.toString('ascii',36,40)!=='data'||bytes.readUInt32LE(40)!==bytes.length-44)fail('format');
    const rate=bytes.readUInt32LE(24);if(bytes.readUInt32LE(28)!==rate*2||bytes.readUInt16LE(32)!==2)fail('format');
    return wave(bytes.subarray(44),rate);
  }
  if(descriptor.encodeType!==1||descriptor.bitsPerSample!==16)fail('format');
  return wave(bytes,descriptor.sampleRate);
}
try {
  const wav=await convert();parentPort.postMessage({audio:wav},[wav.buffer]);
} catch(error) {parentPort.postMessage({error:['format','limit'].includes(error?.code)?error.code:'format'});}
