import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const mediaFailure = () => Object.assign(new Error('微信文件处理未完成，请检查文件或连接后重试'), { code: 'WEIXIN_FILE_FAILED', sendOutcome: 'failed' });
const nonempty = value => typeof value === 'string' && value.length > 0;

/** A display name is never accepted as a local path. */
export function validateFileName(name) {
  if (!nonempty(name) || name.length > 240 || name.trim() !== name || /[\\/\x00-\x1f\x7f]/u.test(name) || ['.', '..'].includes(name)) throw mediaFailure();
  return name;
}
function cdnUrl(value, operation) {
  let url; try { url = new URL(value); } catch { throw mediaFailure(); }
  if (url.protocol !== 'https:' || url.hostname !== 'novac2c.cdn.weixin.qq.com' || url.port || url.username || url.password || url.hash || url.pathname !== `/c2c/${operation}` || value.length > 8192) throw mediaFailure();
  return url.href;
}
function parameterUrl(parameter, operation, filekey) {
  if (!nonempty(parameter) || parameter.length > 4096) throw mediaFailure();
  const url = new URL(`${CDN_BASE}/${operation}`); url.searchParams.set('encrypted_query_param', parameter);
  if (filekey !== undefined) url.searchParams.set('filekey', filekey);
  return url.href;
}
function decodeKey(value) {
  if (!nonempty(value) || value.length > 64) throw mediaFailure();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw mediaFailure();
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[a-fA-F0-9]{32}$/u.test(decoded.toString('ascii'))) return Buffer.from(decoded.toString('ascii'), 'hex');
  throw mediaFailure();
}
function fileDescriptor(value) {
  if (!value || value.kind !== 'file' || !value.media || typeof value.media !== 'object') throw mediaFailure();
  validateFileName(value.name);
  if (value.media.encrypt_type !== undefined && value.media.encrypt_type !== 1) throw mediaFailure();
  if (value.len !== undefined && (typeof value.len !== 'string' || !/^[1-9]\d{0,8}$/u.test(value.len) || Number(value.len) > MAX_FILE_BYTES)) throw mediaFailure();
  if (value.md5 !== undefined && (typeof value.md5 !== 'string' || !/^[a-fA-F0-9]{32}$/u.test(value.md5))) throw mediaFailure();
  const key = decodeKey(value.media.aes_key);
  const url = value.media.full_url !== undefined ? cdnUrl(value.media.full_url, 'download') : parameterUrl(value.media.encrypt_query_param, 'download');
  return { key, url };
}

/** Retain only the protocol fields needed for an authorized later download. */
export function normalizeFileItem(item) {
  const raw = item?.file_item;
  if (!raw || typeof raw !== 'object' || !raw.media || typeof raw.media !== 'object') return null;
  const attachment = { kind: 'file', name: raw.file_name, ...Object.fromEntries(['len', 'md5'].filter(k => raw[k] !== undefined).map(k => [k, raw[k]])),
    media: Object.fromEntries(['encrypt_query_param', 'aes_key', 'encrypt_type', 'full_url'].filter(k => raw.media[k] !== undefined).map(k => [k, raw.media[k]])) };
  try { fileDescriptor(attachment); return attachment; } catch { return null; }
}
async function readBounded(response, signal) {
  const limit = MAX_FILE_BYTES + 16, declared = response.headers?.get('content-length');
  if (declared !== null && declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > limit)) throw mediaFailure();
  if (!response.body?.getReader) throw mediaFailure();
  const reader = response.body.getReader(), chunks = []; let size = 0, done = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted();
      if (next.done) { done = true; break; }
      size += next.value.byteLength; if (size > limit) throw mediaFailure(); chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, size);
  } finally { signal.removeEventListener('abort', abort); if (!done) await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function boundedSignal(signal) { return signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000); }

export async function downloadWeixinFile(fetchImpl, { attachment, signal }) {
  try {
    const { key, url } = fileDescriptor(attachment), combined = boundedSignal(signal); combined.throwIfAborted();
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: combined });
    if (!response.ok) throw mediaFailure();
    const encrypted = await readBounded(response, combined);
    if (!encrypted.length || encrypted.length % 16 !== 0) throw mediaFailure();
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    const bytes = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    if (!bytes.length || bytes.length > MAX_FILE_BYTES || (attachment.len !== undefined && bytes.length !== Number(attachment.len)) ||
        (attachment.md5 !== undefined && createHash('md5').update(bytes).digest('hex') !== attachment.md5.toLowerCase())) throw mediaFailure();
    combined.throwIfAborted(); return { name: attachment.name, bytes };
  } catch { throw mediaFailure(); }
}

/** Uploads only; caller owns the separate, possibly uncertain message submission. */
export async function uploadWeixinFile(fetchImpl, getUploadUrl, { bytes, name, peerId, clientId, signal, authorize = () => true }) {
  try {
    validateFileName(name);
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_FILE_BYTES || !nonempty(peerId) || !nonempty(clientId) || clientId.length > 200) throw mediaFailure();
    const combined = boundedSignal(signal), check = () => { combined.throwIfAborted(); if (authorize() !== true) throw mediaFailure(); };
    check(); const key = randomBytes(16), aeskey = key.toString('hex');
    const cipher = createCipheriv('aes-128-ecb', key, null), encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const result = await getUploadUrl({ filekey: clientId, media_type: 3, to_user_id: peerId, rawsize: bytes.length,
      rawfilemd5: createHash('md5').update(bytes).digest('hex'), filesize: encrypted.length, no_need_thumb: true, aeskey }, combined);
    check(); const url = result.upload_full_url !== undefined ? cdnUrl(result.upload_full_url, 'upload') : parameterUrl(result.upload_param, 'upload', clientId);
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/octet-stream' }, body: encrypted, signal: combined });
    const parameter = response.headers?.get('x-encrypted-param');
    if (response.status !== 200 || !nonempty(parameter) || parameter.length > 4096) throw mediaFailure();
    check(); return { type: 4, file_item: { file_name: name, len: String(bytes.length), media: {
      encrypt_query_param: parameter, aes_key: Buffer.from(aeskey).toString('base64'), encrypt_type: 1 } } };
  } catch { throw mediaFailure(); }
}
