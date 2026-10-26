import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, lstatSync, realpathSync, openSync, readFileSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, chmodSync, constants } from 'node:fs';
import { resolve, join, parse } from 'node:path';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const clone = value => structuredClone(value);
const plain = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.keys(value).every(key => fields.includes(key));
const bounded = (value, max = 240) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(value);
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
function canonical(value) { return JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item); }
const same = (a, b) => canonical(a) === canonical(b);
const validRoute = route => plain(route, ['personId', 'accountId', 'peerId', 'generation']) && id(route.personId) && bounded(route.accountId) && bounded(route.peerId) && Number.isSafeInteger(route.generation) && route.generation > 0;
const sensitiveName = /(?:^|[._\-\s/])(?:credentials?|secrets?|tokens?|passwords?|passwd|api[_\- ]?keys?|private[_\- ]?keys?|id[_\- ]?(?:rsa|dsa|ecdsa|ed25519)|keychain)(?:$|[._\-\s/])|凭据|密钥|私钥|令牌|密码/iu;
const credentialContent = /-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----|\b(?:api[_\- ]?key|access[_\- ]?token|refresh[_\- ]?token|auth[_\- ]?token|token|password|passwd|client[_\- ]?secret|secret(?:[_\- ]?key)?|credential)["']?\s*[:=]\s*["']?\S|\bauthorization\s*:\s*(?:bearer|basic)\s+\S|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|(?:密码|口令|密钥|令牌|私钥)\s*[:：=]\s*\S|https?:\/\/[^\s/:@]+:[^\s/@]+@/iu;
function validProposal(value) {
  if (!plain(value, ['kind', 'draftId', 'revision', 'personId', 'resource', 'source', 'authorization', 'expectedRoute', 'ownerRoute']) || value.kind !== 'ai_digest_once' || value.authorization !== 'explicit_now' || !id(value.draftId) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !id(value.personId)) return false;
  const resource = value.resource, source = value.source;
  return plain(resource, ['workspaceId', 'relativePath']) && bounded(resource.workspaceId) && bounded(resource.relativePath, 1024) && !/^[\/]|[\\:]|\/{2}/u.test(resource.relativePath) && !resource.relativePath.split('/').some(part => !part || part.startsWith('.')) && !sensitiveName.test(resource.relativePath) && /\.(?:md|txt)$/iu.test(resource.relativePath) && plain(source, ['bytes', 'updatedAt']) && Number.isSafeInteger(source.bytes) && source.bytes > 0 && source.bytes <= 24000 && bounded(source.updatedAt, 60) && Number.isFinite(Date.parse(source.updatedAt)) && validRoute(value.expectedRoute) && value.expectedRoute.personId === value.personId && (value.ownerRoute === undefined || validRoute(value.ownerRoute));
}
const finalStatuses = ['api_accepted', 'failed', 'uncertain', 'cancelled'];
const phases = ['reading', 'enqueuing', 'sending', ...finalStatuses];
function parts(text) {
  const result = [];
  while (text.length) { let end = Math.min(3000, text.length); if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--; result.push(text.slice(0, end)); text = text.slice(end); }
  return result;
}
function validText(text) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 24000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text) || credentialContent.test(text)) return false;
  // A broken UTF-16 string must not be silently replaced while transmitting it.
  return Buffer.from(text, 'utf8').toString('utf8') === text;
}

/** A private journal for an explicitly requested single delivery. It never grants
 * tools, starts a schedule, runs a model, or retries a delivery with unknown state. */
export function createDigestDelivery({ directory, store, readDigest, flush, now = () => new Date().toISOString() } = {}) {
  if (!bounded(directory, 4096) || typeof store?.snapshot !== 'function' || typeof store?.enqueue !== 'function' || typeof store?.transition !== 'function' || typeof readDigest !== 'function' || typeof flush !== 'function' || typeof now !== 'function') fail('digest_delivery_invalid_argument');
  const requested = resolve(directory);
  if (existsSync(requested) && lstatSync(requested).isSymbolicLink()) fail('digest_delivery_unsafe_path');
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const root = realpathSync(requested), file = join(root, 'digest-delivery.json'), active = new Map(), activeSignals = new Map();
  function safePath() {
    let current = parse(root).root;
    for (const segment of root.slice(current.length).split('/').filter(Boolean)) { current = join(current, segment); const info = lstatSync(current); if (info.isSymbolicLink() || !info.isDirectory()) fail('digest_delivery_unsafe_path'); }
    if (realpathSync(root) !== root) fail('digest_delivery_unsafe_path');
    if (existsSync(file)) { const info = lstatSync(file); if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) fail('digest_delivery_unsafe_path'); }
  }
  const clock = () => { const instant = new Date(now()); if (!Number.isFinite(+instant)) fail('digest_delivery_invalid_argument'); return instant.toISOString(); };
  function validRecord(row) {
    return plain(row, ['id', 'key', 'fingerprint', 'actorId', 'origin', 'requestId', 'proposal', 'authorityRoute', 'ownerIdentity', 'phase', 'segments', 'createdAt', 'updatedAt']) && /^dgo-[a-f0-9]{48}$/u.test(row.id ?? '') && /^[a-f0-9]{64}$/u.test(row.key ?? '') && /^[a-f0-9]{64}$/u.test(row.fingerprint ?? '') && id(row.actorId) && ['console', 'wechat'].includes(row.origin) && bounded(row.requestId, 512) && validProposal(row.proposal) && (row.authorityRoute === null || validRoute(row.authorityRoute) && row.authorityRoute.personId === row.actorId) && plain(row.ownerIdentity, ['id', 'createdAt']) && row.ownerIdentity.id === row.actorId && (row.ownerIdentity.createdAt === null || bounded(row.ownerIdentity.createdAt, 100)) && phases.includes(row.phase) && Array.isArray(row.segments) && row.segments.length <= 24 && row.segments.every((segment, index) => plain(segment, ['sourceKey', 'textHash', 'outboxId']) && segment.sourceKey === `digest-once:${row.id}:${index}` && /^[a-f0-9]{64}$/u.test(segment.textHash ?? '') && (segment.outboxId === null || id(segment.outboxId))) && [row.createdAt, row.updatedAt].every(value => bounded(value, 60) && Number.isFinite(Date.parse(value)));
  }
  function validState(value) { return plain(value, ['version', 'records']) && value.version === 1 && Array.isArray(value.records) && value.records.length <= 2000 && value.records.every(validRecord) && new Set(value.records.map(row => row.key)).size === value.records.length; }
  function load() {
    safePath(); let fd;
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); const contents = readFileSync(fd, 'utf8'); if (Buffer.byteLength(contents) > 8 * 1024 * 1024) fail('digest_delivery_invalid_state'); const state = JSON.parse(contents); if (!validState(state)) fail('digest_delivery_invalid_state'); return state; }
    catch (error) { if (error.code === 'digest_delivery_unsafe_path') throw error; fail('digest_delivery_invalid_state'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  function save(state) {
    safePath(); if (!validState(state)) fail('digest_delivery_invalid_state'); const text = JSON.stringify(state) + '\n'; if (Buffer.byteLength(text) > 8 * 1024 * 1024) fail('digest_delivery_capacity');
    const temporary = join(root, `.digest-delivery-${randomUUID()}.tmp`); let fd;
    try { fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, text); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temporary, file); chmodSync(file, 0o600); fd = openSync(root, 'r'); fsyncSync(fd); }
    finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch {} }
  }
  safePath(); if (!existsSync(file)) save({ version: 1, records: [] });
  const lookup = key => load().records.find(row => row.key === key);
  function update(key, work) { const state = load(), record = state.records.find(row => row.key === key); if (!record) fail('digest_delivery_invalid_state'); if (finalStatuses.includes(record.phase)) return record; work(record); record.updatedAt = clock(); save(state); return record; }
  function routeMatches(snapshot, expected) { const binding = snapshot.bindings?.find(row => row.personId === expected.personId); return binding?.status === 'connected' && ['accountId', 'peerId', 'generation'].every(key => binding[key] === expected[key]); }
  function permitted(record, signal) {
    if (signal?.aborted) return false;
    const snapshot = store.snapshot(), owner = snapshot.people?.find(row => row.id === record.actorId), target = snapshot.people?.find(row => row.id === record.proposal.personId);
    return snapshot.config?.paused === false && owner?.role === 'owner' && (!owner.status || owner.status === 'active') && (owner.createdAt ?? null) === record.ownerIdentity.createdAt && Boolean(target && ['owner', 'elder'].includes(target.role) && (!target.status || target.status === 'active')) && routeMatches(snapshot, record.proposal.expectedRoute) && (!record.authorityRoute || routeMatches(snapshot, record.authorityRoute)) && (!record.proposal.ownerRoute || record.proposal.ownerRoute.personId === record.actorId && routeMatches(snapshot, record.proposal.ownerRoute));
  }
  function matchingRow(record, segment, snapshot = store.snapshot()) { return snapshot.outbox?.find(row => row.sourceKey === segment.sourceKey && (segment.outboxId === null || row.id === segment.outboxId)); }
  function cancelPending(record) {
    for (const segment of record.segments) { const row = matchingRow(record, segment); if (row?.status === 'pending') store.transition(row.id, 'cancelled', '本次试送已停止，未自动重发。'); }
  }
  function result(record) {
    const reply = record.phase === 'api_accepted' ? '本次日报已向微信接口提交；实际收信仍待本人确认。' : record.phase === 'uncertain' ? '本次日报的发送结果尚未确认，没有自动重发；请先核对已发送部分。' : record.phase === 'cancelled' ? '连接、授权或服务状态已改变，本次试送已停止。' : '本次日报尚未完成发送，未自动重试。';
    return { reply, status: finalStatuses.includes(record.phase) ? record.phase : 'uncertain', deliveryId: record.id, outboxIds: record.segments.map(segment => matchingRow(record, segment)?.id).filter(Boolean) };
  }
  function finish(key, status) { const record = update(key, row => { row.phase = status; }); if (record.phase !== 'api_accepted') cancelPending(record); return result(record); }
  // A crash can leave a file read, some enqueues, or a send without its receipt.
  // Locate even an enqueue whose returned ID had not reached this journal yet.
  const recovered = load(); let changed = false;
  for (const record of recovered.records) {
    if (!finalStatuses.includes(record.phase)) { record.phase = 'uncertain'; record.updatedAt = clock(); changed = true; }
  }
  if (changed) save(recovered);
  for (const record of recovered.records.filter(row => row.phase !== 'api_accepted')) {
    cancelPending(record);
    for (const segment of record.segments) { const row = matchingRow(record, segment); if (row?.status === 'dispatching') store.transition(row.id, 'uncertain', '上次试送结果未知，没有自动重发。'); }
  }
  function canDeliver(row) {
    try {
      if (!row || row.kind !== 'digest_once') return false;
      const record = load().records.find(record => record.segments.some(segment => segment.sourceKey === row.sourceKey));
      if (!record || record.phase !== 'sending' || !permitted(record, activeSignals.get(record.key))) return false;
      const index = record.segments.findIndex(segment => segment.sourceKey === row.sourceKey), segment = record.segments[index], snapshot = store.snapshot(), actual = matchingRow(record, segment, snapshot);
      if (!actual || segment.outboxId !== actual.id || !['pending', 'dispatching'].includes(actual.status) || actual.kind !== 'digest_once' || actual.personId !== record.proposal.personId || !same(actual.route, record.proposal.expectedRoute) || digest(actual.text) !== segment.textHash || !same(actual.authorizationRoute ?? null, record.authorityRoute) || !['id', 'kind', 'sourceKey', 'personId', 'text', 'route', 'authorizationRoute'].every(key => same(row[key] ?? null, actual[key] ?? null))) return false;
      return record.segments.slice(0, index).every(previous => matchingRow(record, previous, snapshot)?.status === 'api_accepted');
    } catch { return false; }
  }
  async function execute(record, signal) {
    const key = record.key;
    try {
      if (!permitted(record, signal)) return finish(key, 'cancelled');
      let value;
      try { value = await readDigest({ personId: record.proposal.personId, resource: clone(record.proposal.resource), source: clone(record.proposal.source), ...(signal ? { signal } : {}) }); }
      catch { return finish(key, signal?.aborted ? 'cancelled' : 'failed'); }
      record = lookup(key); if (finalStatuses.includes(record.phase)) return result(record);
      if (!permitted(record, signal)) return finish(key, 'cancelled');
      const text = typeof value === 'string' ? value : value?.text;
      if (!validText(text)) return finish(key, 'failed');
      const chunks = parts(text);
      record = update(key, row => { row.phase = 'enqueuing'; row.segments = chunks.map((chunk, index) => ({ sourceKey: `digest-once:${row.id}:${index}`, textHash: digest(chunk), outboxId: null })); });
      if (record.phase !== 'enqueuing') return result(record);
      for (const [index, chunk] of chunks.entries()) {
        if (!permitted(record, signal)) return finish(key, 'cancelled');
        const outbox = store.enqueue({ personId: record.proposal.personId, text: chunk, kind: 'digest_once', sourceKey: record.segments[index].sourceKey, ...(record.authorityRoute ? { authorizationRoute: record.authorityRoute } : {}), expiresAt: new Date(Date.parse(clock()) + 30 * 60000).toISOString() });
        record = update(key, row => { row.segments[index].outboxId = outbox.id; });
      }
      record = update(key, row => { row.phase = 'sending'; });
      for (const segment of record.segments) {
        record = lookup(key); if (finalStatuses.includes(record.phase)) return result(record);
        if (!permitted(record, signal)) return finish(key, 'cancelled');
        let row = matchingRow(record, segment);
        if (row?.status === 'api_accepted') continue;
        if (!row || row.status !== 'pending' || !canDeliver(row)) return finish(key, row?.status === 'uncertain' || row?.status === 'dispatching' ? 'uncertain' : row?.status === 'cancelled' ? 'cancelled' : 'failed');
        try { await flush(record.proposal.personId, { onlyId: row.id }); } catch {}
        record = lookup(key); if (finalStatuses.includes(record.phase)) return result(record);
        row = matchingRow(record, segment);
        if (row?.status !== 'api_accepted') return finish(key, row?.status === 'failed' || row?.status === 'blocked' || row?.status === 'expired' ? 'failed' : row?.status === 'cancelled' ? 'cancelled' : 'uncertain');
      }
      return finish(key, 'api_accepted');
    } catch { return finish(key, 'uncertain'); }
  }
  return Object.freeze({
    canDeliver,
    async deliver(args = {}) {
      if (!plain(args, ['actorId', 'origin', 'requestId', 'proposal', 'authorityRoute', 'signal']) || !id(args.actorId) || !['console', 'wechat'].includes(args.origin) || !bounded(args.requestId, 512) || !validProposal(args.proposal) || args.signal !== undefined && !(args.signal instanceof AbortSignal) || args.authorityRoute !== undefined && (!validRoute(args.authorityRoute) || args.authorityRoute.personId !== args.actorId) || args.proposal.ownerRoute && args.proposal.ownerRoute.personId !== args.actorId || args.origin === 'wechat' && (!args.authorityRoute || !args.proposal.ownerRoute || !same(args.authorityRoute, args.proposal.ownerRoute))) fail('digest_delivery_invalid_argument');
      const authorityRoute = args.authorityRoute ?? args.proposal.ownerRoute ?? null;
      if (args.proposal.ownerRoute && authorityRoute && !same(args.proposal.ownerRoute, authorityRoute)) fail('digest_delivery_invalid_argument');
      const key = digest({ actorId: args.actorId, origin: args.origin, requestId: args.requestId }), fingerprint = digest({ actorId: args.actorId, origin: args.origin, requestId: args.requestId, proposal: args.proposal, authorityRoute });
      let record = lookup(key);
      if (record) {
        if (record.fingerprint !== fingerprint) fail('digest_delivery_request_conflict');
        if (active.has(key)) return clone(await active.get(key));
        if (!finalStatuses.includes(record.phase)) return finish(key, 'uncertain');
        cancelPending(record); return result(record);
      }
      const snapshot = store.snapshot(), owner = snapshot.people?.find(row => row.id === args.actorId);
      record = { id: `dgo-${key.slice(0, 48)}`, key, fingerprint, actorId: args.actorId, origin: args.origin, requestId: args.requestId, proposal: clone(args.proposal), authorityRoute: clone(authorityRoute), ownerIdentity: { id: args.actorId, createdAt: owner?.createdAt ?? null }, phase: 'reading', segments: [], createdAt: clock(), updatedAt: clock() };
      const state = load(); if (state.records.length >= 2000) fail('digest_delivery_capacity'); state.records.push(record); save(state);
      if (args.signal) activeSignals.set(key, args.signal);
      const pending = execute(record, args.signal); active.set(key, pending);
      try { return clone(await pending); } finally { if (active.get(key) === pending) { active.delete(key); activeSignals.delete(key); } }
    },
  });
}
