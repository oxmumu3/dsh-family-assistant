/**
 * 多账号 iLink 传输层。
 *
 * 把「一个进程同时服务多个微信账号」从插件里抽出来：每个账号独立的 baseUrl、
 * 凭据、游标与 context token，**绝不回退到第一个账号**。协议实现复用
 * `src/weixin.mjs`；本模块只做账号隔离与路由，因此另一个客户端（例如同机的
 * 独立微信插件）可以直接依赖它，不必再写一份扫码、轮询与媒体处理。
 *
 * 约束：
 * - 没有默认账号；未注册的 accountId 一律拒绝。
 * - 游标与 context token 存在各自槽位，轮询互不影响。
 * - snapshot() 只暴露"有没有"，不返回凭据。
 */
import {randomUUID} from 'node:crypto';
import {createWeixinApi} from '../weixin.mjs';

const fail = (message, code = 'ilink_account_invalid') => Object.assign(new Error(message), {code});

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('账号配置必须是对象');
  if (typeof input.baseUrl !== 'string' || !/^https:\/\//.test(input.baseUrl)) throw fail('账号需要显式 https baseUrl');
  if (typeof input.token !== 'string' || !input.token.trim()) throw fail('账号缺少访问凭据');
  return {
    baseUrl: input.baseUrl,
    token: input.token,
    ...(input.peerId !== undefined ? {peerId: String(input.peerId)} : {}),
    ...(input.clientId !== undefined ? {clientId: String(input.clientId)} : {}),
  };
}

export function createIlinkAccounts({fetchImpl} = {}) {
  if (typeof fetchImpl !== 'function') throw fail('需要注入 fetch', 'ilink_fetch_required');
  const slots = new Map();

  function slot(accountId) {
    if (typeof accountId !== 'string' || !accountId) throw fail('账号标识无效');
    const found = slots.get(accountId);
    if (!found) throw fail('账号未注册，拒绝回退到其他账号', 'ilink_account_unknown');
    return found;
  }

  /** 注册或替换账号；替换会丢弃旧游标与 context token，并递增 generation。 */
  function register(accountId, input) {
    if (typeof accountId !== 'string' || !accountId) throw fail('账号标识无效');
    const settings = validate(input);
    const previous = slots.get(accountId);
    slots.set(accountId, {
      settings,
      api: createWeixinApi({fetchImpl}),
      cursor: '',
      contextToken: null,
      generation: (previous?.generation ?? 0) + 1,
    });
    return {accountId, generation: slots.get(accountId).generation};
  }

  function unregister(accountId) {
    return slots.delete(accountId);
  }

  /** 发送：只走指定账号，携带它自己的 context token；未绑定联系人直接拒绝。 */
  async function send(accountId, {text, peerId, signal} = {}) {
    const current = slot(accountId);
    const target = peerId ?? current.settings.peerId;
    if (!target) throw fail('这个账号还没有绑定联系人', 'ilink_peer_required');
    return current.api.send({
      token: current.settings.token,
      baseUrl: current.settings.baseUrl,
      peerId: String(target),
      ...(current.contextToken ? {contextToken: current.contextToken} : {}),
      text: String(text ?? ''),
      clientId: current.settings.clientId ?? randomUUID(),
      ...(signal ? {signal} : {}),
    });
  }

  /** 轮询：游标按账号隔离，返回的消息不会串到别的账号。 */
  async function poll(accountId, {signal} = {}) {
    const current = slot(accountId);
    const result = await current.api.poll({
      token: current.settings.token,
      baseUrl: current.settings.baseUrl,
      cursor: current.cursor,
      ...(signal ? {signal} : {}),
    });
    if (typeof result?.cursor === 'string' && result.cursor) current.cursor = result.cursor;
    return {accountId, cursor: current.cursor, messages: Array.isArray(result?.messages) ? result.messages : []};
  }

  /** 记录一条该账号发出的 context token，供下一次发送复用。 */
  function rememberContext(accountId, contextToken) {
    const current = slot(accountId);
    if (typeof contextToken === 'string' && contextToken) current.contextToken = contextToken;
    return Boolean(current.contextToken);
  }

  async function scan(accountId, {signal} = {}) {
    return slot(accountId).api.getQr({...(signal ? {signal} : {})});
  }

  /** 扫码确认：新的 token / baseUrl / 联系人写回该账号槽位。 */
  async function confirm(accountId, {qrcode, verifyCode, signal} = {}) {
    const current = slot(accountId);
    const result = await current.api.checkQr({qrcode, ...(verifyCode ? {verifyCode} : {}), ...(signal ? {signal} : {})});
    if (result?.status === 'confirmed') {
      if (typeof result.token === 'string' && result.token) current.settings.token = result.token;
      if (typeof result.baseUrl === 'string' && result.baseUrl) current.settings.baseUrl = result.baseUrl;
      if (typeof result.peerId === 'string' && result.peerId) current.settings.peerId = result.peerId;
    }
    return result;
  }

  /** 状态总览：只报告"有没有"，不返回凭据或正文。 */
  function snapshot() {
    return [...slots].map(([accountId, current]) => ({
      accountId,
      generation: current.generation,
      baseUrl: current.settings.baseUrl,
      hasPeer: Boolean(current.settings.peerId),
      hasCursor: Boolean(current.cursor),
      hasContextToken: Boolean(current.contextToken),
    }));
  }

  return Object.freeze({register, unregister, send, poll, scan, confirm, rememberContext, snapshot});
}
