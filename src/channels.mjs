import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWeixinApi, validateWeixinBaseUrl } from './weixin.mjs';
import { MAX_FILE_BYTES } from './weixin-media.mjs';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const present = value => typeof value === 'string' && value.trim().length > 0;
const abortError = () => new DOMException('Aborted', 'AbortError');
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(abortError()); }
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function createChannelManager({ directory, api = createWeixinApi(), transcribeVoice, lookupInboundVoice, onMessage = async () => {}, onStatus = () => {}, onBound, now = () => new Date().toISOString(), qrTimeoutMs = 300_000, qrIntervalMs = 1_000, pollRetryMs = 2_000 } = {}) {
  if (!directory || typeof onBound !== 'function') throw new Error('缺少通道配置');
  const states = new Map(); let closed = false;
  function state(personId) {
    if (!safeId(personId)) throw new Error('成员标识无效');
    if (!states.has(personId)) states.set(personId, { personId, status: 'disconnected', phase: 'disconnected', connected: false, task: Promise.resolve(), outbound: Promise.resolve(), epoch: 0 });
    return states.get(personId);
  }
  function publicStatus(s) {
    return { personId: s.personId, status: s.status, phase: s.phase, connected: s.connected,
      ...(s.qrUrl ? { qrUrl: s.qrUrl } : {}), ...(s.lastError ? { lastError: s.lastError } : {}),
      ...(s.lastInboundAt ? { lastInboundAt: s.lastInboundAt } : {}), ...(s.lastOutboundAt ? { lastOutboundAt: s.lastOutboundAt } : {}) };
  }
  function status(s, value, error) {
    s.status = s.phase = value; s.connected = value === 'connected'; s.lastError = error;
    if (!['awaiting_scan', 'scanned', 'need_verification'].includes(value)) delete s.qrUrl;
    // Status hooks must never leak transport bodies or credential strings.
    try { onStatus(s.personId, { status: value, ...(error ? { lastError: error } : {}),
      ...(s.lastInboundAt ? { lastInboundAt: s.lastInboundAt } : {}), ...(s.lastOutboundAt ? { lastOutboundAt: s.lastOutboundAt } : {}) }); } catch {}
  }
  function authPath(s, create = false) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const folder = path.join(directory, s.personId);
    if (fs.existsSync(folder) && fs.lstatSync(folder).isSymbolicLink()) throw new Error('通道目录无效');
    if (create) { fs.mkdirSync(folder, { recursive: true, mode: 0o700 }); fs.chmodSync(folder, 0o700); }
    const file = path.join(folder, 'auth.json');
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('通道凭据无效');
    return file;
  }
  function save(s) {
    const file = authPath(s, true), tmp = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(s.auth), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); fs.chmodSync(file, 0o600); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  function validAuth(auth) {
    if (!auth || ![auth.token, auth.baseUrl, auth.accountId, auth.peerId].every(present)) throw new Error('通道凭据不完整，请重新扫码');
    validateWeixinBaseUrl(auth.baseUrl);
    return { token: auth.token, baseUrl: auth.baseUrl, accountId: auth.accountId, peerId: auth.peerId,
      cursor: typeof auth.cursor === 'string' ? auth.cursor : '', contextToken: typeof auth.contextToken === 'string' ? auth.contextToken : '' };
  }
  async function stop(s) {
    const epoch = ++s.epoch; s.controller?.abort(); s.wakeVerify?.();
    await Promise.allSettled([s.task, s.outbound]);
    if (s.epoch === epoch) {
      s.controller = null; s.route = null; s.verifyCode = undefined; s.wakeVerify = null;
    }
    return epoch;
  }
  function active(s, epoch, signal) { return !closed && s.epoch === epoch && !signal.aborted; }
  async function bind(s, auth, epoch, signal, resumeToken) {
    if (!active(s, epoch, signal)) return false;
    for (const other of states.values()) if (other !== s && other.route &&
      (other.route.accountId === auth.accountId || other.route.peerId === auth.peerId)) throw new Error('该微信已连接其他成员');
    const route = await onBound(s.personId, { accountId: auth.accountId, peerId: auth.peerId }, { resumeToken });
    if (!active(s, epoch, signal)) return false;
    if (route?.personId !== s.personId || route.accountId !== auth.accountId || route.peerId !== auth.peerId || !Number.isInteger(route.generation)) throw new Error('微信绑定未确认');
    s.auth = auth; s.route = { ...route }; save(s); status(s, 'connected'); return true;
  }
  async function pollLoop(s, epoch, signal) {
    let failures = 0;
    while (active(s, epoch, signal)) {
      try {
        const result = await api.poll({ ...s.auth, signal });
        if (!active(s, epoch, signal)) break;
        // An inbound page is proof that this session recovered before handlers reply.
        status(s, 'connected');
        // The complete poll page arrived at this host time; it is not a claim
        // about when the person sent the message or whether it was delayed.
        const receivedAt=now();
        for (const message of result.messages ?? []) {
          if (!active(s, epoch, signal)) break;
          if (message.peerId !== s.auth.peerId || message.groupId || message.group_id ||
              (message.messageType !== undefined && message.messageType !== 1) ||
              (message.accountId && message.accountId !== s.auth.accountId) || !present(message.id)) continue;
          // The response may need this latest context immediately, inside onMessage.
          if (present(message.contextToken)) { s.auth.contextToken = message.contextToken; save(s); }
          let text=message.text??'',voiceError=['format','limit'].includes(message.voiceError)?message.voiceError:undefined;
          const voices=Array.isArray(message.voices)?message.voices:[];
          // Runtime owns durable dedup and unfinished admission recovery. Reuse
          // its admitted transcript, but still deliver the message to that gate.
          const knownVoice=(voices.length||voiceError||message.inputKind==='voice')&&typeof lookupInboundVoice==='function'?lookupInboundVoice(s.personId,message.id):null;
          const reuseVoice=present(knownVoice?.text)&&knownVoice.text.length<=8000;
          if(reuseVoice){text=knownVoice.text;voiceError=['unavailable','format','limit','empty','failed'].includes(knownVoice.voiceError)?knownVoice.voiceError:undefined;}
          if(voices.length>3)voiceError='limit';
          if(voices.length&&!voiceError&&!reuseVoice){
            if(typeof transcribeVoice!=='function'||typeof api.downloadVoice!=='function')voiceError='unavailable';
            else {
              const transcripts=[];
              try {
                for(const descriptor of voices){
                  if(!active(s,epoch,signal))break;
                  const audio=await api.downloadVoice({descriptor,signal});
                  if(!active(s,epoch,signal))break;
                  const result=await transcribeVoice({bytes:audio.bytes,descriptor,signal});
                  if(!active(s,epoch,signal))break;
                  if(!present(result?.text)||result.text.length>6000)throw Object.assign(new Error('No transcript'),{code:'family-voice/empty'});
                  transcripts.push(result.text.trim());
                }
                text=[text,...transcripts].filter(present).join('\n');
              } catch(error) {
                voiceError=({'family-voice/unavailable':'unavailable','family-voice/format':'format','family-voice/limit':'limit','family-voice/empty':'empty'})[error?.code]??'failed';
              }
            }
          }
          if(!active(s,epoch,signal))break;
          await onMessage(s.personId, { id: message.id, peerId: message.peerId, text,
            unsupported: !!message.unsupported, at: reuseVoice&&present(knownVoice.at)?knownVoice.at:message.at ?? now(),
            ...(voices.length||voiceError||message.inputKind==='voice'?{inputKind:'voice'}:{}),...(voiceError?{voiceError}:{}),
            sourceTiming:{receivedAt,...(typeof message.at==='string'?{providerCreatedAt:message.at}:{})},
            ...(Array.isArray(message.attachments) && message.attachments.length ? { attachments: structuredClone(message.attachments) } : {}) });
          if (!active(s, epoch, signal)) break;
          s.lastInboundAt = now();
        }
        if (!active(s, epoch, signal)) break;
        if (typeof result.cursor === 'string') s.auth.cursor = result.cursor;
        save(s); failures = 0; status(s, 'connected');
        // A gateway returning immediate empty pages must not create a hot loop.
        if (!(result.messages?.length)) await delay(100, signal);
      } catch {
        if (!active(s, epoch, signal)) break;
        failures++; status(s, 'error', '微信连接暂时中断，正在重试');
        try { await delay(Math.min(30_000, pollRetryMs * 2 ** Math.min(failures - 1, 4)), signal); } catch { break; }
      }
    }
  }
  async function loginLoop(s, qrcode, epoch, signal, resumeToken) {
    const deadline = Date.now() + Math.min(Math.max(qrTimeoutMs, 1), 300_000);
    const expiry = setTimeout(() => {
      if (s.epoch === epoch) { s.controller?.abort(); s.wakeVerify?.(); }
    }, Math.max(1, deadline - Date.now()));
    try {
      while (active(s, epoch, signal) && Date.now() < deadline) {
        const result = await api.checkQr({ qrcode, signal, ...(s.verifyCode ? { verifyCode: s.verifyCode } : {}) });
        if (!active(s, epoch, signal)) return;
        if (result.status === 'confirmed') {
          s.verifyCode = undefined;
          if (await bind(s, validAuth(result), epoch, signal, resumeToken)) { clearTimeout(expiry); await pollLoop(s, epoch, signal); }
          return;
        }
        if (result.status === 'binded_redirect') {
          const file = authPath(s);
          if (!fs.existsSync(file)) throw new Error('请重新扫码');
          if (await bind(s, validAuth(JSON.parse(fs.readFileSync(file, 'utf8'))), epoch, signal, resumeToken)) { clearTimeout(expiry); await pollLoop(s, epoch, signal); }
          return;
        }
        if (result.status === 'expired' || result.status === 'verify_code_blocked') { status(s, 'expired', '二维码已失效，请重新扫码'); return; }
        if (result.status === 'need_verifycode') {
          s.verifyCode = undefined; status(s, 'need_verification', '请输入手机微信显示的数字');
          await new Promise(resolve => { s.wakeVerify = resolve; if (signal.aborted) resolve(); });
          s.wakeVerify = null; continue;
        }
        if (result.status === 'scaned' || result.status === 'scanned') { s.verifyCode = undefined; status(s, 'scanned'); }
        else if (result.status !== 'wait') throw new Error('微信登录状态暂不支持');
        await delay(qrIntervalMs, signal);
      }
      if (s.epoch === epoch && !closed) status(s, 'expired', '二维码已超时，请重新扫码');
    } catch {
      if (s.epoch === epoch && !closed) status(s, signal.aborted && Date.now() >= deadline ? 'expired' : 'error', '微信登录未完成，请重新扫码');
    } finally { clearTimeout(expiry); s.verifyCode = undefined; s.wakeVerify = null; }
  }
  return {
    async login(personId, { resumeToken } = {}) {
      if (closed) throw new Error('家庭助手已停止');
      const s = state(personId), epoch = await stop(s);
      if (closed || s.epoch !== epoch) throw new Error('连接已被更新的操作替代');
      const controller = s.controller = new AbortController(); status(s, 'connecting');
      let resolveSetup; s.task = new Promise(resolve => { resolveSetup = resolve; });
      try {
        const qr = await api.getQr({ signal: controller.signal });
        if (!active(s, epoch, controller.signal)) throw abortError();
        s.qrUrl = qr.qrUrl; status(s, 'awaiting_scan');
        // Yield the QR to caller before the background confirmation can change it.
        const visible = publicStatus(s);
        s.task = Promise.resolve().then(() => loginLoop(s, qr.qrcode, epoch, controller.signal, resumeToken));
        return { phase: visible.phase, qrUrl: visible.qrUrl };
      } catch { if (s.epoch === epoch) status(s, 'error', '暂时无法获取微信二维码'); throw new Error('暂时无法获取微信二维码'); }
      finally { resolveSetup(); }
    },
    async connect(personId, { resumeToken } = {}) {
      if (closed) throw new Error('家庭助手已停止');
      const s = state(personId);
      if (s.connected && s.controller && !s.controller.signal.aborted) return publicStatus(s);
      const epoch = await stop(s);
      if (closed || s.epoch !== epoch) throw new Error('连接已被更新的操作替代');
      const controller = s.controller = new AbortController(); status(s, 'connecting');
      try {
        const auth = validAuth(JSON.parse(fs.readFileSync(authPath(s), 'utf8')));
        if (await bind(s, auth, epoch, controller.signal, resumeToken)) s.task = pollLoop(s, epoch, controller.signal);
        return publicStatus(s);
      } catch { status(s, 'error', '请先为该成员扫码连接微信'); throw new Error('请先为该成员扫码连接微信'); }
    },
    async submitCode(personId, code) {
      const s = state(personId);
      if (s.phase !== 'need_verification' || !s.wakeVerify || !/^\d{1,12}$/.test(String(code))) throw new Error('请输入手机微信显示的有效数字');
      s.verifyCode = String(code); status(s, 'scanned'); s.wakeVerify(); return publicStatus(s);
    },
    async disconnect(personId) { const s = state(personId), epoch = await stop(s); if (s.epoch === epoch) status(s, 'disconnected'); return publicStatus(s); },
    status(personId) { return publicStatus(state(personId)); },
    statuses() { return [...states.values()].map(publicStatus); },
    async downloadFile(route, attachment, { signal, authorize = () => true } = {}) {
      const s = route && states.get(route.personId);
      const valid = () => !closed && s && s.connected && s.route && s.controller && !s.controller.signal.aborted &&
        ['personId', 'accountId', 'peerId', 'generation'].every(key => route[key] === s.route[key]);
      const check = () => { if (!valid() || signal?.aborted || authorize() !== true) throw Object.assign(new Error('文件下载已取消、绑定或授权已变化'), { sendOutcome: 'failed' }); };
      check(); const combined = signal ? AbortSignal.any([signal, s.controller.signal]) : s.controller.signal;
      const result = await api.downloadFile({ attachment, signal: combined }); check(); return result;
    },
    async sendFile(route, file, { clientId = randomUUID(), signal, authorize = () => true } = {}) {
      const s = route && states.get(route.personId);
      const valid = () => !closed && s && s.connected && s.route && s.controller && !s.controller.signal.aborted &&
        ['personId', 'accountId', 'peerId', 'generation'].every(key => route[key] === s.route[key]);
      const allowed = () => valid() && !signal?.aborted && authorize() === true;
      if (!allowed() || !file || !present(file.name) || !Buffer.isBuffer(file.bytes) || !file.bytes.length || file.bytes.length > MAX_FILE_BYTES) throw Object.assign(new Error('微信文件接收人未连接、文件无效或授权已变化'), { sendOutcome: 'failed' });
      const bytes = Buffer.from(file.bytes), name = file.name;
      const task = s.outbound.catch(() => {}).then(async () => {
        if (!allowed()) throw Object.assign(new Error('发送已取消、绑定或指令授权已变化'), { sendOutcome: 'failed' });
        const result = await api.sendFile({ token: s.auth.token, baseUrl: s.auth.baseUrl, peerId: s.auth.peerId,
          contextToken: s.auth.contextToken, name, bytes, clientId, authorize: allowed,
          signal: signal ? AbortSignal.any([signal, s.controller.signal]) : s.controller.signal });
        if (result?.status !== 'api_accepted') throw Object.assign(new Error('发送结果尚未确认'), { sendOutcome: 'uncertain' });
        s.lastOutboundAt = now(); if (valid()) status(s, 'connected'); return result;
      });
      s.outbound = task; return task;
    },
    async send(route, text, { clientId = randomUUID(), signal, authorize = () => true } = {}) {
      const s = route && states.get(route.personId);
      const valid = () => s && s.connected && s.route && s.controller && !s.controller.signal.aborted &&
        ['personId', 'accountId', 'peerId', 'generation'].every(key => route[key] === s.route[key]);
      if (!valid() || !present(text) || !authorize()) throw Object.assign(new Error('微信接收人未连接或指令授权已变化'), { sendOutcome: 'failed' });
      const task = s.outbound.catch(() => {}).then(async () => {
        if (!valid() || signal?.aborted || !authorize()) throw Object.assign(new Error('发送已取消、绑定或指令授权已变化'), { sendOutcome: 'failed' });
        const result = await api.send({ token: s.auth.token, baseUrl: s.auth.baseUrl, peerId: s.auth.peerId,
          contextToken: s.auth.contextToken, text, clientId, signal: signal ? AbortSignal.any([signal, s.controller.signal]) : s.controller.signal,
          authorize: () => valid() && !signal?.aborted && authorize() === true });
        if (result?.status !== 'api_accepted') throw Object.assign(new Error('发送结果尚未确认'), { sendOutcome: 'uncertain' });
        s.lastOutboundAt = now(); status(s, 'connected'); return result;
      });
      s.outbound = task; return task;
    },
    async close() { closed = true; await Promise.all([...states.values()].map(async s => { await stop(s); status(s, 'disconnected'); })); },
  };
}
