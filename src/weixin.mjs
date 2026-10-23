import { randomBytes, randomUUID } from 'node:crypto';

const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '2.4.10';
const ID_KEYS = new Set(['message_id', 'msg_id', 'svr_id']);
const SEND_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH',
]);
const SEND_PHASE_REASONS = { request: '连接失败', http: 'HTTP状态异常', read: '响应读取失败', parse: '响应格式无效', ack: '响应未确认' };

function uncertainSend(error, { phase, started, httpStatus, timed, signal }) {
  let code;
  // Never copy transport errors, causes, names, messages or response bodies into diagnostics.
  try { code = [error?.code, error?.cause?.code].find(value => SEND_CODES.has(value)); } catch {}
  const requestTimeout = timed.aborted, externalAbort = Boolean(signal?.aborted);
  const elapsed = performance.now() - started;
  const diagnostic = { phase, elapsedMs: Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0,
    ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
    ...(code ? { code } : {}), requestTimeout, externalAbort };
  const reason = externalAbort ? '请求中断' : requestTimeout ? '请求超时' :
    code === 'UND_ERR_CONNECT_TIMEOUT' ? '连接超时' :
    ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code) ? '请求超时' : SEND_PHASE_REASONS[phase];
  return Object.assign(new Error(`发送结果尚未确认，请勿自动重发（${reason}）`), { sendOutcome: 'uncertain', diagnostic });
}

/** Credential-bearing endpoints never follow server-controlled redirects. */
export function validateWeixinBaseUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com') ||
      url.username || url.password || url.port || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw Object.assign(new Error('微信服务地址无效'), { code: 'INVALID_BASE_URL', sendOutcome: 'failed' });
  }
  return url.origin;
}
function businessError(value) {
  for (const key of ['ret', 'errcode']) {
    if (value[key] !== undefined && value[key] !== 0) {
      return Object.assign(new Error('微信接口拒绝了请求'), {
        ...(Number.isSafeInteger(value[key]) ? { code: value[key] } : {}), sendOutcome: 'failed',
      });
    }
  }
}
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }
function parse(text) {
  return JSON.parse(text, (key, value, context) => ID_KEYS.has(key) && typeof value === 'number'
    ? (context?.source ?? String(value)) : value);
}
function normalizeMessage(msg) {
  const parts = []; let unsupported = false;
  for (const item of Array.isArray(msg.item_list) ? msg.item_list : []) {
    if (item.type === 1 && typeof item.text_item?.text === 'string') parts.push(item.text_item.text);
    else if (item.type === 3 && nonempty(item.voice_item?.text)) parts.push(item.voice_item.text);
    else unsupported = true;
  }
  return {
    id: String(msg.message_id ?? msg.client_id ?? ''), peerId: msg.from_user_id ?? '',
    accountId: msg.to_user_id, groupId: msg.group_id, messageType: msg.message_type,
    text: parts.join('\n'), unsupported, contextToken: msg.context_token,
    ...(Number.isFinite(msg.create_time_ms) ? { at: new Date(msg.create_time_ms).toISOString() } : {}),
  };
}

export function createWeixinApi({ fetchImpl = globalThis.fetch, baseUrl = DEFAULT_BASE } = {}) {
  const initialBase = validateWeixinBaseUrl(baseUrl);
  const qrHosts = new Map();
  async function request(host, endpoint, { token, body, signal, timeout = 15_000, send = false } = {}) {
    const base = validateWeixinBaseUrl(host);
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(2 * 65536 + 4 * 256 + 10) };
    if (body !== undefined) Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') });
    if (token) headers.Authorization = `Bearer ${token}`;
    const timed = AbortSignal.timeout(timeout);
    const started = performance.now();
    let phase = 'request', httpStatus, rejected;
    try {
      const response = await fetchImpl(new URL(endpoint, `${base}/`).href, {
        method: body === undefined ? 'GET' : 'POST', headers, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timed]) : timed,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      phase = 'http'; httpStatus = response.status;
      if (!response.ok) throw new Error('微信服务暂时不可用');
      phase = 'read'; const text = await response.text();
      phase = 'parse'; const result = parse(text);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('微信响应无效');
      rejected = businessError(result); if (rejected) throw rejected;
      phase = 'ack';
      if (send && result.ret !== 0 && result.errcode !== 0 && !nonempty(result.message_id)) throw new Error('微信响应未确认');
      return result;
    } catch (error) {
      if (send) {
        if (rejected && error === rejected) throw rejected;
        throw uncertainSend(error, { phase, started, httpStatus, timed, signal });
      }
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (timed.aborted && endpoint === 'ilink/bot/getupdates') return { msgs: [] };
      throw error;
    }
  }
  return {
    async getQr({ signal } = {}) {
      const value = await request(initialBase, 'ilink/bot/get_bot_qrcode?bot_type=3', { signal, body: { local_token_list: [] } });
      if (!nonempty(value.qrcode) || !nonempty(value.qrcode_img_content)) throw new Error('微信未返回有效二维码');
      qrHosts.set(value.qrcode, initialBase);
      return { qrcode: value.qrcode, qrUrl: value.qrcode_img_content };
    },
    async checkQr({ qrcode, signal, verifyCode }) {
      if (!nonempty(qrcode)) throw new Error('二维码无效');
      const query = new URLSearchParams({ qrcode });
      if (verifyCode !== undefined) {
        if (!/^\d{1,12}$/.test(verifyCode)) throw new Error('请输入手机上显示的数字');
        query.set('verify_code', verifyCode);
      }
      let value;
      try {
        value = await request(qrHosts.get(qrcode) ?? initialBase, `ilink/bot/get_qrcode_status?${query}`, { signal, timeout: 35_000 });
      } catch (error) {
        if (signal?.aborted || error?.sendOutcome === 'failed') throw error;
        return { status: 'wait' };
      }
      if (value.status === 'scaned_but_redirect') {
        if (!nonempty(value.redirect_host)) throw new Error('微信未返回有效服务地址');
        qrHosts.set(qrcode, validateWeixinBaseUrl(`https://${value.redirect_host}`));
        return { status: 'scaned' };
      }
      if (value.status !== 'confirmed') return { status: value.status };
      const confirmedBase = validateWeixinBaseUrl(value.baseurl ?? qrHosts.get(qrcode) ?? initialBase);
      if (![value.bot_token, value.ilink_bot_id, value.ilink_user_id].every(nonempty)) throw new Error('微信登录信息不完整');
      qrHosts.delete(qrcode);
      return { status: 'confirmed', token: value.bot_token, baseUrl: confirmedBase, accountId: value.ilink_bot_id, peerId: value.ilink_user_id };
    },
    async poll({ token, baseUrl: host, cursor = '', signal }) {
      if (!nonempty(token)) throw new Error('请先连接微信');
      const value = await request(host, 'ilink/bot/getupdates', { token, signal, timeout: 38_000,
        body: { get_updates_buf: cursor, base_info: { channel_version: CHANNEL_VERSION, bot_agent: 'DSHFamily/0.1.0' } } });
      return { messages: (Array.isArray(value.msgs) ? value.msgs : []).map(normalizeMessage),
        cursor: typeof value.get_updates_buf === 'string' ? value.get_updates_buf : cursor };
    },
    async send({ token, baseUrl: host, peerId, contextToken, text, clientId = randomUUID(), signal }) {
      if (![token, peerId, text, clientId].every(nonempty)) throw Object.assign(new Error('发送参数不完整'), { sendOutcome: 'failed' });
      const value = await request(host, 'ilink/bot/sendmessage', { token, signal, send: true, body: {
        msg: { from_user_id: '', to_user_id: peerId, client_id: clientId, message_type: 2, message_state: 2,
          item_list: [{ type: 1, text_item: { text } }], ...(contextToken ? { context_token: contextToken } : {}) },
        base_info: { channel_version: CHANNEL_VERSION, bot_agent: 'DSHFamily/0.1.0' },
      } });
      return { status: 'api_accepted', ...(nonempty(value.message_id) ? { messageId: value.message_id } : {}) };
    },
  };
}
