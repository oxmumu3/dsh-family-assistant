import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

export const OFFICIAL_VOICE_BUNDLE='@deepseek-ai/dsh-experimental-voice-input-bundle';
export const LOCAL_VOICE_PROVIDER='sensevoice-local';
export const VOICE_BODY_LIMIT=6*1024*1024;
const maxAudioBytes=4*1024*1024,maxDurationSeconds=120;
const busyPhases=new Set(['checking','downloading','loading','waking','cancelling']);
const messages={
  unprepared:'首次使用需要下载官方本地语音模型，准备完成后即可开始说话。',
  unavailable:'当前 Harness 无法提供官方语音输入，请更新宿主后重试。',
  installing:'正在安装与当前 Harness 匹配的官方语音组件…',
  enabling:'正在启用官方语音输入…',
  checking:'正在检查语音模型…',downloading:'正在下载本地语音模型…',
  loading:'正在载入语音模型…',waking:'正在唤醒语音模型…',cancelling:'正在取消准备…',
  cancelled:'语音准备已取消，可以重新准备。',ready:'语音输入已就绪。',standby:'语音输入已就绪。',
  failed:'语音准备未完成，请重试。',restart_required:'官方语音组件已安装，需要重启 Harness 后使用。',
};
function failure(message,code='family-voice/unavailable'){
  const error=new Error(message);error.code=code;return error;
}
function changeFailure(result){
  if(result?.application==='restart-required')return {phase:'restart_required',message:messages.restart_required};
  if(result?.application==='cancelled')return {phase:'cancelled',message:messages.cancelled};
  if(result?.pendingBuilds?.length)return {phase:'failed',message:'官方语音组件需要在 Harness 插件管理中确认运行依赖，完成后重试。'};
  const kind=result?.packageResult?.kind;
  if(['network','timeout','not-found','no-matching-version'].includes(kind))return {phase:'failed',message:'官方语音组件下载未完成，请检查网络后重试。'};
  if(kind==='disk-full')return {phase:'failed',message:'本机磁盘空间不足，请释放空间后重试。'};
  return {phase:'failed',message:'官方语音组件未能启用，请在 Harness 插件管理中查看具体原因后重试。'};
}

/** Reuse the official Host service; installing Family never creates a second speech registry. */
export function createHostVoice(ctx,{activationTimeoutMs=10000,activationPollMs=100,inspectionTimeoutMs=30000}={}){
  const lifetime=new AbortController();
  let setup={phase:'idle'},pending=null,installRequestId=null,generation=0;
  const get=name=>{try{return ctx.get(name);}catch{return undefined;}};
  const controller=()=>get('speechController');
  const manager=()=>get('pluginManager');
  const catalog=()=>{
    const value=controller()?.catalog();
    if(!value)return null;
    // Family voice is local-only, even when the global microphone uses a cloud provider.
    const providers=(value.providers??[]).filter(provider=>provider.id===LOCAL_VOICE_PROVIDER&&provider.location==='host-local');
    return {...value,providers,selection:{providerId:LOCAL_VOICE_PROVIDER,language:'auto'},
      maxAudioBytes:Math.min(value.maxAudioBytes??maxAudioBytes,maxAudioBytes),
      maxDurationSeconds:Math.min(value.maxDurationSeconds??maxDurationSeconds,maxDurationSeconds)};
  };
  async function status(){
    const value=catalog();
    const provider=value?.providers[0];
    let phase=provider?.preparation?.phase??'unprepared';
    if(!provider&&!manager())phase='unavailable';
    if(setup.phase!=='idle'&&!(provider&&['ready','standby'].includes(phase)))phase=setup.phase;
    // Provider diagnostics can contain local paths. The UI needs progress and a recovery action only.
    const providers=(value?.providers??[]).map(item=>({...item,preparation:{...item.preparation,
      ...(item.preparation?.phase==='failed'?{message:messages.failed}:{}),
    }}));
    return {...(value??{providers:[],selection:{providerId:LOCAL_VOICE_PROVIDER,language:'auto'},maxAudioBytes,maxDurationSeconds}),
      providers,available:!!provider,phase,ready:['ready','standby'].includes(phase),
      providerId:LOCAL_VOICE_PROVIDER,language:'auto',setup:{...setup},message:setup.phase===phase&&setup.message?setup.message:messages[phase]??messages.unavailable};
  }
  async function activate(run){
    if(catalog()?.providers.length)return;
    const management=manager();
    if(!management?.listBundles)throw failure(messages.unavailable);
    const bundle=(await management.listBundles()).find(item=>item.name===OFFICIAL_VOICE_BUNDLE);
    lifetime.signal.throwIfAborted();
    if(run!==generation)return;
    if(!bundle)throw failure(messages.unavailable);
    let result;
    if(bundle.availability==='missing'){
      // The official catalog owns the exact compatible version or same-checkout path.
      if(!bundle.installTarget?.spec)throw failure(messages.unavailable);
      setup={phase:'installing'};const requestId=randomUUID();installRequestId=requestId;
      try{result=await management.installBundle(bundle.installTarget.spec,{enabled:true,saveExact:true,requestId});}
      finally{if(installRequestId===requestId)installRequestId=null;}
    }else if(!bundle.enabled){
      setup={phase:'enabling'};
      result=await management.setBundleEnabled(OFFICIAL_VOICE_BUNDLE,true);
    }
    if(run!==generation)return;
    if(result&&result.application!=='applied'){
      setup=changeFailure(result);return;
    }
    // HMR is owned by the manager. Never reload Family or touch another plugin's disabled rows.
    const deadline=Date.now()+activationTimeoutMs;
    while(!catalog()?.providers.length&&Date.now()<deadline){
      await delay(activationPollMs,undefined,{signal:lifetime.signal});
      if(run!==generation)return;
    }
    if(!catalog()?.providers.length)throw failure('官方语音服务尚未启动，请检查语音组件是否已启用后重试。');
  }
  async function afterInspection(run){
    const deadline=Date.now()+inspectionTimeoutMs;
    let observedChecking=false;
    for(;;){
      lifetime.signal.throwIfAborted();
      if(run!==generation)return null;
      const provider=catalog()?.providers[0];
      if(!provider)throw failure(messages.unavailable);
      if(provider.preparation.phase!=='checking'){
        if(observedChecking){
          // Official inspect() publishes its result before its promise finalizer
          // clears the single-flight preparation lock. Let that turn finish.
          observedChecking=false;
          await delay(0,undefined,{signal:lifetime.signal});
          continue;
        }
        return provider;
      }
      if(Date.now()>=deadline)throw failure('语音模型检查耗时较长，请稍后重试。');
      observedChecking=true;setup={phase:'checking'};
      await delay(activationPollMs,undefined,{signal:lifetime.signal});
    }
  }
  async function prepare(options={}){
    lifetime.signal.throwIfAborted();
    if(pending)return status();
    const state=await status();
    if(pending)return status();
    // A first activation's cache inspection is not a requested model download:
    // retain this click's intent until inspection has decided what is missing.
    if(state.ready||(busyPhases.has(state.phase)&&state.phase!=='checking'))return state;
    const run=++generation;
    setup={phase:catalog()?.providers.length?'checking':'installing'};
    // Preparation outlives the HTTP request. A closed observer must not restart a download.
    pending=(async()=>{
      await activate(run);
      if(run!==generation||['failed','restart_required','cancelled'].includes(setup.phase))return;
      lifetime.signal.throwIfAborted();
      const provider=await afterInspection(run),speech=controller();
      if(run!==generation)return;
      if(!speech||!provider)throw failure(messages.unavailable);
      if(options.downloadSource!==undefined&&!provider.downloadSources?.includes(options.downloadSource))throw failure('请选择官方语音组件提供的下载来源。','family-voice/source');
      if(!['ready','standby',...busyPhases].includes(provider.preparation.phase))speech.prepare(LOCAL_VOICE_PROVIDER,
        options.downloadSource===undefined?undefined:{downloadSource:options.downloadSource});
      setup={phase:'idle'};
    })().catch(error=>{
      if(run===generation&&!lifetime.signal.aborted)setup={phase:'failed',message:error?.code?.startsWith('family-voice/')?error.message:messages.failed};
    }).finally(()=>{if(run===generation)pending=null;});
    return status();
  }
  async function cancelPreparation(){
    ++generation;pending=null;setup={phase:'cancelling'};
    const requestId=installRequestId;
    if(requestId)await manager()?.cancelInstall(requestId);
    const speech=controller();
    if(catalog()?.providers.length)await speech.cancelPreparation(LOCAL_VOICE_PROVIDER);
    setup={phase:'cancelled'};
    return status();
  }
  async function transcribe(input,signal){
    lifetime.signal.throwIfAborted();
    if(input.providerId!==undefined&&input.providerId!==LOCAL_VOICE_PROVIDER)throw failure('家庭助手语音输入仅使用本机识别。','family-voice/provider');
    const speech=controller(),provider=catalog()?.providers[0];
    if(!speech||!provider||!['ready','standby'].includes(provider.preparation.phase))throw failure('语音输入尚未准备好，请先完成准备。');
    if(typeof input.audioBase64!=='string'||input.audioBase64.length>Math.ceil(maxAudioBytes/3)*4)throw failure('录音超过限制，请分段说。','family-voice/invalid-audio');
    const language=input.language??'auto';
    if(!provider.languages.includes(language))throw failure('当前语音识别不支持该语言。','family-voice/language');
    // The official controller validates canonical base64, WAV encoding, bytes and duration.
    try{return await speech.transcribe({audioBase64:input.audioBase64,providerId:LOCAL_VOICE_PROVIDER,language},
      signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal);}
    catch(error){
      if(lifetime.signal.aborted||signal?.aborted)throw failure('语音识别已取消。','family-voice/cancelled');
      throw failure('这段语音未能识别，请重试；原有文字仍然保留。','family-voice/transcription');
    }
  }
  function dispose(){
    ++generation;lifetime.abort();
    // Do not await a manager operation during HMR: its reload may be waiting for this very fiber.
    // Shared official preparation remains Host-owned and can be observed after a reload.
    if(installRequestId)void manager()?.cancelInstall(installRequestId)?.catch(()=>{});
  }
  return {status,setup:prepare,prepare,cancelPreparation,transcribe,dispose};
}
