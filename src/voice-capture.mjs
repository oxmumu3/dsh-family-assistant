/* Main-frame microphone capture. PCM conversion follows the official DeepSeek
 * Harness client-ui-voice-input audio.ts (MIT, DeepSeek-AI); see notices.
 * Recognition belongs to the official Host service. This module cannot send a
 * conversation message and never persists audio or transcripts. */

export function encodeFamilyWave(samples) {
  const bytes = new Uint8Array(44 + samples.length * 2), view = new DataView(bytes.buffer);
  const text = (at, value) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (const [i, sample] of samples.entries()) {
    const value = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

function familyVoiceError(kind) { const error = new Error(kind); error.kind = kind; return error; }

export class FamilyRecording {
  constructor({ env = globalThis } = {}) {
    this.env = env; this.lifetime = new env.AbortController(); this.chunks = [];
    this.samples = new Float32Array(256); this.disposal = null; this.finishing = false;
  }
  async start(onError) {
    const env = this.env;
    if (!env.navigator?.mediaDevices?.getUserMedia || !env.MediaRecorder) throw familyVoiceError('unavailable');
    const stream = await env.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    if (this.lifetime.signal.aborted) { stream.getTracks().forEach(track => track.stop()); throw familyVoiceError('cancelled'); }
    this.stream = stream;
    try {
      this.context = new env.AudioContext(); this.analyser = this.context.createAnalyser(); this.analyser.fftSize = this.samples.length;
      this.context.createMediaStreamSource(stream).connect(this.analyser);
      if (this.context.state === 'suspended') await this.context.resume();
      this.lifetime.signal.throwIfAborted();
      const interrupted = () => {
        if (this.lifetime.signal.aborted || this.finishing) return;
        void this.dispose().catch(() => {}); onError?.(familyVoiceError('interrupted'));
      };
      for (const track of stream.getTracks()) track.addEventListener('ended', interrupted, { signal: this.lifetime.signal });
      this.recorder = new env.MediaRecorder(stream);
      this.recorder.ondataavailable = event => { if (!this.lifetime.signal.aborted && event.data.size) this.chunks.push(event.data); };
      this.recorder.onerror = interrupted; this.recorder.start();
    } catch (error) { await this.dispose().catch(() => {}); throw error; }
  }
  amplitude() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    return Math.sqrt(this.samples.reduce((sum, value) => sum + value * value, 0) / this.samples.length);
  }
  async stop(maxDurationSeconds) {
    const recorder = this.recorder, context = this.context, env = this.env;
    if (!recorder || !context || recorder.state !== 'recording') { await this.dispose(); throw familyVoiceError('empty'); }
    this.finishing = true;
    try {
      await new Promise((resolve, reject) => {
        let timer;
        const settle = (error) => { env.clearTimeout(timer); this.lifetime.signal.removeEventListener('abort', aborted); error ? reject(error) : resolve(); };
        const aborted = () => settle(familyVoiceError('cancelled'));
        recorder.onstop = () => settle(); recorder.onerror = () => settle(familyVoiceError('empty'));
        this.lifetime.signal.addEventListener('abort', aborted, { once: true });
        timer = env.setTimeout(() => settle(familyVoiceError('interrupted')), 5000);
        try { recorder.stop(); } catch (error) { settle(error); }
      });
      this.stream?.getTracks().forEach(track => track.stop());
      this.lifetime.signal.throwIfAborted();
      const blob = new env.Blob(this.chunks, { type: recorder.mimeType });
      if (!blob.size) throw familyVoiceError('empty');
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      this.lifetime.signal.throwIfAborted();
      const offline = new env.OfflineAudioContext(1, Math.max(1, Math.floor(Math.min(decoded.duration, maxDurationSeconds) * 16000)), 16000);
      const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
      const resampled = await offline.startRendering();
      this.lifetime.signal.throwIfAborted();
      return encodeFamilyWave(resampled.getChannelData(0));
    } finally { await this.dispose().catch(() => {}); }
  }
  dispose() {
    if (this.disposal) return this.disposal;
    this.lifetime.abort(familyVoiceError('cancelled'));
    try { if (this.recorder?.state === 'recording') this.recorder.stop(); } catch { /* Release tracks even after device failure. */ }
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    const context = this.context; this.context = null; this.analyser = null; this.chunks = [];
    this.disposal = Promise.resolve().then(() => { if (context && context.state !== 'closed') return context.close(); });
    return this.disposal;
  }
}

function voiceMessage(error) {
  if (error?.name === 'NotAllowedError' || error?.kind === 'permission') return '麦克风权限未打开。请在系统设置中允许 Harness 使用麦克风后重试。';
  if (['NotFoundError', 'OverconstrainedError'].includes(error?.name)) return '没有找到可用麦克风，请接好麦克风后重试。';
  if (error?.name === 'NotReadableError' || error?.kind === 'interrupted') return '录音已中断，请检查麦克风连接后重试。';
  if (error?.kind === 'unavailable') return '当前窗口无法使用麦克风，请在 Harness 桌面版中打开家庭助手。';
  if (error?.kind === 'empty') return '没有识别到说话内容，请重新说一次。';
  if (error?.kind === 'tooLarge') return '这段录音太长，请分成几次说。';
  return '语音识别暂时未完成，请重试。你也可以继续输入文字。';
}

/** Short, authenticated same-origin facade; the Host pins the local recognizer. */
export function familyVoiceRequest(env = globalThis) {
  return async (action, body = {}, signal) => {
    const response = await env.fetch(action === 'catalog' ? '/api/family/voice' : '/api/family/voice/action', {
      method: action === 'catalog' ? 'GET' : 'POST', credentials: 'same-origin', signal,
      ...(action === 'catalog' ? {} : { headers: { 'Content-Type': 'application/json', 'X-Family-Action': '1' }, body: JSON.stringify({ ...body, action }) }),
    });
    if (!response.ok) throw familyVoiceError('service');
    const value = await response.json(); signal?.throwIfAborted(); return value;
  };
}

/** Main-frame resource owner. Subscribers receive data only; no draft or message mutation. */
export function createFamilyVoice({ env = globalThis, request = familyVoiceRequest(env), createRecording = () => new FamilyRecording({ env }) } = {}) {
  const listeners = new Set(), lifetime = new env.AbortController();
  let state = { phase: 'idle', readiness: null, elapsedSeconds: 0, level: 0, message: '', transcript: '', capture: null };
  let active = null, generation = 0, contextKey = null, disposed = false, poll = null, refreshPending = null;
  const publish = patch => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) { try { listener({ ...state }); } catch { /* A frame's UI cannot break capture cleanup. */ } }
  };
  const clearTimers = item => { env.clearTimeout(item?.timer); env.clearInterval(item?.meter); };
  const release = item => { if (!item || item.released) return; item.released = true; clearTimers(item); item.abort.abort(); void item.recording?.dispose().catch(() => {}); };
  const ready = () => state.readiness?.ready === true && ['ready', 'standby', 'waking'].includes(state.readiness?.phase);
  const stopPolling = () => { if (poll !== null) env.clearTimeout(poll); poll = null; };
  const schedulePoll = () => {
    stopPolling();
    if (disposed || !listeners.size || !['installing', 'enabling', 'checking', 'downloading', 'loading', 'waking', 'cancelling'].includes(state.readiness?.phase)) return;
    poll = env.setTimeout(() => { poll = null; void refresh(); }, 1500);
  };
  async function refresh() {
    if (disposed) return state;
    if (refreshPending) return refreshPending;
    refreshPending = (async () => {
      try {
        const readiness = await request('catalog', {}, lifetime.signal);
        if (disposed) return state;
        // A start request owns checking until it acquires the microphone or
        // enters setup. Emitting idle here would close the frame's recorder
        // panel just before capture starts, hiding its Stop/Cancel controls.
        const phase = active || ['checking', 'transcript', 'error'].includes(state.phase) ? state.phase : readiness.ready ? 'idle' : 'setup';
        publish({ readiness, phase, ...(phase === 'idle' ? { message: '' } : {}) });
      } catch (error) {
        if (!disposed && !active) publish({ phase: 'unavailable', readiness: null, message: '语音服务暂时无法连接，请稍后重试。' });
      } finally { refreshPending = null; schedulePoll(); }
      return state;
    })();
    return refreshPending;
  }
  function cancel() {
    generation++; const previous = active; active = null; release(previous);
    publish({ phase: 'idle', elapsedSeconds: 0, level: 0, message: '', transcript: '', capture: null });
  }
  async function stop() {
    const item = active;
    if (!item || item.phase !== 'recording') return state;
    item.phase = 'transcribing'; clearTimers(item); publish({ phase: 'transcribing', level: 0, message: '正在转成文字…' });
    try {
      const audio = await item.recording.stop(item.maxDurationSeconds);
      if (active !== item || disposed) return state;
      if (audio.byteLength > item.maxAudioBytes) throw familyVoiceError('tooLarge');
      let binary = ''; for (let i = 0; i < audio.length; i += 8192) binary += String.fromCharCode(...audio.subarray(i, i + 8192));
      const result = await request('transcribe', { audioBase64: env.btoa(binary), providerId: 'sensevoice-local', language: 'auto' }, item.abort.signal);
      if (active !== item || disposed) return state;
      const transcript = typeof result?.text === 'string' ? result.text.trim() : '';
      if (!transcript) throw familyVoiceError('empty');
      publish({ phase: 'transcript', transcript, capture: item.capture, message: '文字已准备好，请检查后发送。' });
    } catch (error) {
      if (active === item && !disposed) publish({ phase: 'error', message: voiceMessage(error), transcript: '', capture: null, level: 0 });
    } finally { release(item); if (active === item) active = null; }
    return state;
  }
  async function start(capture = {}) {
    if (disposed || active) return state;
    const run = ++generation;
    contextKey = String(capture.contextKey ?? '');
    const insertion = { contextKey, draft: String(capture.draft ?? ''), selectionStart: Number(capture.selectionStart) || 0, selectionEnd: Number(capture.selectionEnd) || 0 };
    publish({ phase: 'checking', message: '正在检查语音输入…', transcript: '', capture: null, elapsedSeconds: 0, level: 0 });
    await refresh();
    if (disposed || run !== generation) return state;
    if (!ready()) { publish({ phase: state.phase === 'unavailable' ? 'unavailable' : 'setup', message: state.readiness?.message || '首次使用需准备官方本地语音组件，准备好后即可直接说话。' }); return state; }
    const item = { recording: createRecording(), abort: new env.AbortController(), capture: insertion, phase: 'requesting', released: false,
      maxDurationSeconds: Math.min(120, Math.max(1, Number(state.readiness.maxDurationSeconds) || 120)), maxAudioBytes: Math.min(4 * 1024 * 1024, Number(state.readiness.maxAudioBytes) || 4 * 1024 * 1024) };
    active = item; publish({ phase: 'requesting', message: '请允许使用麦克风…', capture: insertion });
    if (active !== item || disposed) return state;
    try {
      await item.recording.start(error => {
        if (active !== item || disposed) return;
        active = null; release(item); publish({ phase: 'error', message: voiceMessage(error), level: 0, capture: null });
      });
      if (active !== item || disposed) return state;
      item.phase = 'recording'; item.startedAt = env.Date.now();
      publish({ phase: 'recording', message: '正在听，讲完点「停止并转文字」。' });
      if (active !== item || disposed) return state;
      item.meter = env.setInterval(() => {
        if (active === item) publish({ elapsedSeconds: Math.min(item.maxDurationSeconds, Math.floor((env.Date.now() - item.startedAt) / 1000)), level: Math.min(1, item.recording.amplitude() * 5) });
      }, 150);
      item.timer = env.setTimeout(() => { void stop(); }, item.maxDurationSeconds * 1000);
    } catch (error) {
      release(item);
      if (active === item && !disposed) { active = null; publish({ phase: 'error', message: voiceMessage(error), level: 0, capture: null }); }
    }
    return state;
  }
  async function prepare() {
    if (disposed || active) return state;
    publish({ phase: 'setup', message: '正在准备官方本地语音组件…', transcript: '', capture: null });
    try { const readiness = await request('prepare', {}, lifetime.signal); if (!disposed) publish({ readiness, phase: readiness.ready ? 'idle' : 'setup' }); }
    catch { if (!disposed) publish({ phase: 'error', message: '语音组件准备未完成，请重试。' }); }
    schedulePoll(); return state;
  }
  async function cancelPreparation() {
    if (disposed) return state;
    try { await request('cancel_preparation', {}, lifetime.signal); await refresh(); }
    catch { if (!disposed) publish({ phase: 'error', message: '准备任务暂时无法取消，请刷新状态后重试。' }); }
    return state;
  }
  const hidden = () => { if (env.document?.hidden && active) cancel(); };
  const blur = () => { if (active?.phase === 'recording') cancel(); };
  const escape = event => { if (event.key === 'Escape' && active) { event.preventDefault(); cancel(); } };
  env.document?.addEventListener('visibilitychange', hidden); env.document?.addEventListener('keydown', escape); env.addEventListener?.('blur', blur);
  return {
    status: () => ({ ...state }), refresh, prepare, cancelPreparation, start, stop, cancel,
    contextChanged(key) { const next = String(key ?? ''); if (contextKey !== null && next !== contextKey) cancel(); contextKey = next; },
    subscribe(listener) { listeners.add(listener); try { listener({ ...state }); } catch {} schedulePoll(); return () => { listeners.delete(listener); if (!listeners.size) stopPolling(); }; },
    dispose() { if (disposed) return; cancel(); disposed = true; lifetime.abort(); stopPolling(); listeners.clear(); env.document?.removeEventListener('visibilitychange', hidden); env.document?.removeEventListener('keydown', escape); env.removeEventListener?.('blur', blur); },
  };
}
