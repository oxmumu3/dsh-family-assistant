import { createHash } from 'node:crypto';

const clone = value => structuredClone(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const canonical = value => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const same = (a, b) => canonical(a) === canonical(b);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex').slice(0, 40);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(value);
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value;
const validRoute = route => route && typeof route === 'object' && !Array.isArray(route) && Object.keys(route).every(key => ['personId', 'accountId', 'peerId', 'generation'].includes(key)) && id(route.personId) && text(route.accountId, 240) && text(route.peerId, 240) && Number.isSafeInteger(route.generation) && route.generation > 0;
const kinds = ['workflow_request', 'workflow_response', 'workflow_followup'];
const prefixes = { workflow_request: 'workflow-request', workflow_response: 'workflow-response', workflow_followup: 'workflow-followup' };
const statuses = ['pending', 'accepted', 'completed', 'declined'];
const statusNames = { pending: '待确认', accepted: '已接下，待继续处理', completed: '家庭联系人已标记处理完成', declined: '暂不提供' };
const requestHash = ({ personId, requestId }) => hash([personId, requestId]);
function shortId(args = {}) { if (!id(args.personId) || !text(args.requestId, 512)) fail('workflow_notification_invalid_argument'); return 'wf-' + requestHash(args).slice(0, 12); }
const publicRequest = request => clone(Object.fromEntries(['personId', 'requestId', 'text', 'status', 'createdAt', 'updatedAt', 'note'].filter(key => request[key] !== undefined).map(key => [key, request[key]])));
function chunks(value) { const result = []; while (value.length) { let end = Math.min(3000, value.length); if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1])) end--; result.push(value.slice(0, end)); value = value.slice(end); } return result; }
function sourceParts(value) {
  if (typeof value !== 'string') return null;
  const fields = value.split(':'), prefix = fields[0], kind = Object.keys(prefixes).find(key => prefixes[key] === prefix), hasOperation = kind && kind !== 'workflow_request';
  if (!kind || fields.length !== (hasOperation ? 5 : 4) || !/^[a-f0-9]{40}$/u.test(fields[1]) || hasOperation && !/^[a-f0-9]{24}$/u.test(fields[2]) || !/^[a-f0-9]{40}$/u.test(fields.at(-2)) || !/^[0-7]$/u.test(fields.at(-1))) return null;
  return { kind, requestHash: fields[1], operationHash: hasOperation ? fields[2] : null, bodyHash: fields.at(-2), index: Number(fields.at(-1)), group: fields.slice(0, -1).join(':') };
}

/** Outbox rows are the durable notification journal and binding anchors. No
 * conversation history, grants, or schedules are included in this workflow. */
export function createWorkflowNotifications({ directory, store, toolbox, flush, now = () => new Date().toISOString() } = {}) {
  void directory;
  if (typeof store?.snapshot !== 'function' || typeof store?.enqueue !== 'function' || typeof store?.transition !== 'function' || typeof toolbox?.listRequests !== 'function' || typeof toolbox?.updateRequest !== 'function' || typeof flush !== 'function' || typeof now !== 'function') fail('workflow_notification_invalid_argument');
  const active = new Map(), activeSignals = new Map(), authorizedGroups = new Set();
  const snapshot = () => store.snapshot();
  function owner(actorId) { const person = snapshot().people?.find(row => actorId ? row.id === actorId : row.role === 'owner'); if (person?.role !== 'owner' || person.status && person.status !== 'active') fail('workflow_notification_forbidden'); return person; }
  function family(personId) { const person = snapshot().people?.find(row => row.id === personId); if (person?.role !== 'elder' || person.status && person.status !== 'active') fail('workflow_notification_forbidden'); return person; }
  function request(personId, requestId, actorId = owner().id) { if (!id(personId) || !text(requestId, 512)) fail('workflow_notification_invalid_argument'); const rows = toolbox.listRequests({ actorId }); if (!Array.isArray(rows) || rows.length > 3000) fail('workflow_notification_invalid_state'); const selected = rows.filter(row => row.personId === personId && row.requestId === requestId); if (selected.length !== 1) fail('workflow_notification_unknown_request'); return selected[0]; }
  function route(personId) { const binding = snapshot().bindings?.find(row => row.personId === personId), value = binding && { personId, accountId: binding.accountId, peerId: binding.peerId, generation: binding.generation }; return validRoute(value) ? value : null; }
  function current(expected, role) { if (!validRoute(expected)) return false; const state = snapshot(), person = state.people?.find(row => row.id === expected.personId), binding = state.bindings?.find(row => row.personId === expected.personId); return state.config?.paused === false && person?.role === role && (!person.status || person.status === 'active') && binding?.status === 'connected' && same(route(person.id), expected); }
  const notifyBody = value => `${family(value.personId).label}提出了工具或工作流需求：\n${value.text}\n\n回复需求 ${shortId(value)}：你的答复`;
  const responseBody = (value, status, note) => `家庭联系人回复你的工具需求：\n${note}\n\n需求状态：${statusNames[status]}\n关于：${value.text.slice(0, 180)}\n补充需求 ${shortId(value)}：补充内容`;
  const followBody = (value, content) => `${family(value.personId).label}补充了工具需求：\n${content}\n\n关于：${value.text.slice(0, 180)}\n回复需求 ${shortId(value)}：你的答复`;
  function groupRows(group) { return snapshot().outbox.filter(row => sourceParts(row.sourceKey)?.group === group).sort((a, b) => sourceParts(a.sourceKey).index - sourceParts(b.sourceKey).index); }
  function completeGroup(group) {
    const rows = groupRows(group); if (!rows.length) return null;
    const first = sourceParts(rows[0].sourceKey), body = rows.map(row => row.text).join(''), expectedChunks = chunks(body);
    if (hash(body) !== first.bodyHash || expectedChunks.length !== rows.length || !rows.every((row, index) => { const part = sourceParts(row.sourceKey); return part?.index === index && part.kind === first.kind && row.kind === first.kind && row.text === expectedChunks[index] && text(row.text, 3000); })) return null;
    return { ...first, rows, body };
  }
  function anchors(value) { return snapshot().outbox.filter(row => { const part = sourceParts(row.sourceKey); return part?.kind === 'workflow_request' && part.requestHash === requestHash(value) && part.index === 0; }); }
  function anchor(value) { const found = anchors(value); return found.length === 1 ? completeGroup(sourceParts(found[0].sourceKey).group) : null; }
  function anchorCurrent(value, captured = anchor(value)) { const first = captured?.rows[0]; return Boolean(first && first.personId === first.route?.personId && first.authorizationRoute?.personId === value.personId && current(first.route, 'owner') && current(first.authorizationRoute, 'elder') && captured.body === notifyBody(value)); }
  function cancelRows(rows) { for (const row of rows) { const fresh = snapshot().outbox.find(item => item.id === row.id); if (fresh?.status === 'pending') store.transition(row.id, 'cancelled', '这次需求转达已停止，没有自动重发。'); } }
  function groupStatus(rows) { if (rows.length && rows.every(row => row.status === 'api_accepted')) return 'api_accepted'; if (rows.some(row => ['dispatching', 'uncertain'].includes(row.status))) return 'uncertain'; if (rows.some(row => ['failed', 'blocked', 'expired'].includes(row.status))) return 'failed'; if (rows.some(row => row.status === 'cancelled')) return 'cancelled'; return 'uncertain'; }
  function output(value, rows = [], status = groupStatus(rows)) { return { status, reply: status === 'api_accepted' ? '这次需求转达已向微信接口提交；实际收信待本人确认。' : status === 'not_requested' ? '需求状态已更新，本次没有发送答复。' : status === 'uncertain' ? '这次需求转达结果尚未确认，没有自动重发。' : '这次需求转达尚未完成，没有自动重发。', shortId: shortId(value), request: publicRequest(value), ...(rows[0] ? { outboxId: rows[0].id } : {}), outboxIds: rows.map(row => row.id) }; }
  function existingOperation(prefix, body) { const rows = snapshot().outbox.filter(row => { const part = sourceParts(row.sourceKey); return part && part.group.startsWith(prefix + ':'); }); if (!rows.length) return null; const groups = [...new Set(rows.map(row => sourceParts(row.sourceKey).group))]; if (groups.length !== 1 || groups[0] !== prefix + ':' + hash(body)) fail('workflow_notification_request_conflict'); return groupRows(groups[0]); }
  function parsedResponse(value, body) {
    const prefix = '家庭联系人回复你的工具需求：\n';
    if (!body.startsWith(prefix)) return null;
    for (const status of statuses) {
      const suffix = `\n\n需求状态：${statusNames[status]}\n关于：${value.text.slice(0, 180)}\n补充需求 ${shortId(value)}：补充内容`;
      if (!body.endsWith(suffix)) continue;
      const note = body.slice(prefix.length, -suffix.length);
      if (text(note, 2000) && responseBody(value, status, note) === body) return { status, note };
    }
    return null;
  }
  function replies(value) {
    const key = requestHash(value), captured = anchor(value); if (!anchorCurrent(value, captured)) return [];
    const original = captured.rows[0];
    return snapshot().outbox.filter(row => { const part = sourceParts(row.sourceKey); return part?.kind === 'workflow_response' && part.requestHash === key && part.index === 0; }).map(row => completeGroup(sourceParts(row.sourceKey).group)).filter(group => group && groupStatus(group.rows) === 'api_accepted' && parsedResponse(value, group.body) && group.rows.every(row => row.personId === value.personId && same(row.route, original.authorizationRoute) && same(row.authorizationRoute, original.route))).map(group => ({ ...group, response: parsedResponse(value, group.body) }));
  }
  function canDeliver(row) {
    try {
      if (!row || !kinds.includes(row.kind)) return false;
      const part = sourceParts(row.sourceKey), group = part && completeGroup(part.group), actual = group?.rows[part.index];
      if (!group || !authorizedGroups.has(part.group) || part.kind !== row.kind || !actual || !['pending', 'dispatching'].includes(actual.status) || !['id', 'kind', 'sourceKey', 'personId', 'text', 'route', 'authorizationRoute'].every(key => same(actual[key] ?? null, row[key] ?? null)) || activeSignals.get(part.group)?.aborted) return false;
      const actor = owner(), values = toolbox.listRequests({ actorId: actor.id }).filter(value => requestHash(value) === part.requestHash); if (values.length !== 1) return false;
      const value = values[0], captured = anchor(value); if (!anchorCurrent(value, captured)) return false;
      const original = captured.rows[0], toOwner = row.kind !== 'workflow_response';
      if (row.personId !== (toOwner ? actor.id : value.personId) || !same(row.route, toOwner ? original.route : original.authorizationRoute) || !same(row.authorizationRoute, toOwner ? original.authorizationRoute : original.route)) return false;
      if (row.kind === 'workflow_request' && group.body !== notifyBody(value)) return false;
      if (row.kind === 'workflow_response' && (!text(value.note, 2000) || group.body !== responseBody(value, value.status, value.note))) return false;
      if (row.kind === 'workflow_followup') {
        const prefix = `${family(value.personId).label}补充了工具需求：\n`, suffix = `\n\n关于：${value.text.slice(0, 180)}\n回复需求 ${shortId(value)}：你的答复`;
        if (!group.body.startsWith(prefix) || !group.body.endsWith(suffix) || !text(group.body.slice(prefix.length, -suffix.length), 2000) || !replies(value).length) return false;
      }
      return group.rows.slice(0, part.index).every(previous => previous.status === 'api_accepted');
    } catch { return false; }
  }
  async function send(value, rows, signal) {
    const group = sourceParts(rows[0].sourceKey).group;
    if (active.has(group)) return clone(await active.get(group));
    authorizedGroups.add(group);
    if (signal) activeSignals.set(group, signal);
    const pending = (async () => {
      for (const original of rows) {
        let row = snapshot().outbox.find(item => item.id === original.id);
        if (row.status === 'api_accepted') continue;
        if (row.status !== 'pending' || !canDeliver(row) || signal?.aborted) { cancelRows(rows); return output(value, groupRows(group)); }
        try { await flush(row.personId, { onlyId: row.id }); } catch {}
        row = snapshot().outbox.find(item => item.id === original.id);
        if (row.status !== 'api_accepted') { if (row.status === 'dispatching') store.transition(row.id, 'uncertain', '这次转达结果未知，没有自动重发。'); cancelRows(rows); return output(value, groupRows(group)); }
      }
      return output(value, groupRows(group));
    })();
    active.set(group, pending);
    try { return clone(await pending); } finally { if (active.get(group) === pending) { active.delete(group); activeSignals.delete(group); authorizedGroups.delete(group); } }
  }
  async function replay(value, rows) { const group = sourceParts(rows[0].sourceKey).group; if (active.has(group)) return clone(await active.get(group)); cancelRows(rows); return output(value, groupRows(group)); }
  function enqueue(value, kind, body, prefix, to, authority) {
    const group = prefix + ':' + hash(body), expiresAt = new Date(Date.parse(now()) + 24 * 3600000).toISOString();
    return chunks(body).map((part, index) => store.enqueue({ personId: to.personId, text: part, kind, sourceKey: `${group}:${index}`, authorizationRoute: authority, expiresAt }));
  }
  // Never resume an interrupted conversation transfer at plugin startup.
  for (const row of snapshot().outbox.filter(row => kinds.includes(row.kind))) { if (row.status === 'pending') store.transition(row.id, 'cancelled', '上次需求转达未结束，没有自动重发。'); else if (row.status === 'dispatching') store.transition(row.id, 'uncertain', '上次需求转达结果未知，没有自动重发。'); }
  return Object.freeze({
    shortId,
    canDeliver,
    async notify({ personId, requestId, expectedRoute, signal } = {}) {
      if (!validRoute(expectedRoute) || expectedRoute.personId !== personId || signal !== undefined && !(signal instanceof AbortSignal)) fail('workflow_notification_invalid_argument');
      family(personId); const value = request(personId, requestId), captured = anchor(value);
      if (captured) { if (!anchorCurrent(value, captured) || !same(expectedRoute, captured.rows[0].authorizationRoute)) return output(value, captured.rows, 'cancelled'); return replay(value, captured.rows); }
      const old = anchors(value); if (old.length) { cancelRows(old); return output(value, old, 'cancelled'); }
      const recipient = route(owner().id); if (!recipient || !current(expectedRoute, 'elder') || !current(recipient, 'owner') || signal?.aborted) return output(value, [], 'cancelled');
      const body = notifyBody(value), rows = enqueue(value, 'workflow_request', body, `workflow-request:${requestHash(value)}`, recipient, expectedRoute);
      return send(value, rows, signal);
    },
    async requestUpdate({ actorId, personId, requestId, status, note, operationId, authorityRoute, signal } = {}) {
      owner(actorId);
      if (!id(actorId) || !statuses.includes(status) || !text(operationId, 512) || note !== undefined && !text(note, 2000) || authorityRoute !== undefined && (!validRoute(authorityRoute) || authorityRoute.personId !== actorId) || signal !== undefined && !(signal instanceof AbortSignal)) fail('workflow_notification_invalid_argument');
      const value = request(personId, requestId, actorId), captured = anchor(value);
      if (authorityRoute && !same(authorityRoute, route(actorId)) || signal?.aborted) return output(value, [], 'cancelled');
      if (note === undefined) { const updated = value.status === status ? value : toolbox.updateRequest({ actorId, personId, requestId, status }); return output(updated, [], 'not_requested'); }
      if (!captured && !anchors(value).length) {
        const updated = toolbox.updateRequest({ actorId, personId, requestId, status, note });
        return { ...output(updated, [], 'not_requested'), reply: '进展和说明已保存。这项需求没有可核对的原微信上下文，未发送说明。' };
      }
      if (!captured || !anchorCurrent(value, captured) || captured.rows[0].route.personId !== actorId || authorityRoute && !same(authorityRoute, captured.rows[0].route) || signal?.aborted) return output(value, [], 'cancelled');
      const body = responseBody(value, status, note), prefix = `workflow-response:${requestHash(value)}:${hash(operationId).slice(0, 24)}`, existing = existingOperation(prefix, body);
      if (existing) return replay(value, existing);
      const rows = enqueue(value, 'workflow_response', body, prefix, captured.rows[0].authorizationRoute, captured.rows[0].route);
      let updated;
      try { updated = toolbox.updateRequest({ actorId, personId, requestId, status, note }); }
      catch { cancelRows(rows); return output(value, groupRows(sourceParts(rows[0].sourceKey).group), 'failed'); }
      return send(updated, rows, signal);
    },
    async followUp({ personId, requestId, text: content, operationId, expectedRoute, signal } = {}) {
      if (!validRoute(expectedRoute) || expectedRoute.personId !== personId || !text(content, 2000) || !text(operationId, 512) || signal !== undefined && !(signal instanceof AbortSignal)) fail('workflow_notification_invalid_argument');
      family(personId); const value = request(personId, requestId), captured = anchor(value);
      if (!captured || !anchorCurrent(value, captured) || !same(expectedRoute, captured.rows[0].authorizationRoute) || !replies(value).length || signal?.aborted) return output(value, [], 'cancelled');
      const body = followBody(value, content), prefix = `workflow-followup:${requestHash(value)}:${hash(operationId).slice(0, 24)}`, existing = existingOperation(prefix, body);
      if (existing) return replay(value, existing);
      return send(value, enqueue(value, 'workflow_followup', body, prefix, captured.rows[0].route, expectedRoute), signal);
    },
    memberContext({ personId } = {}) {
      family(personId); const actor = owner(), values = toolbox.listRequests({ actorId: actor.id });
      return values.filter(value => value.personId === personId && anchorCurrent(value) && replies(value).length).map(value => { const latest = replies(value).at(-1); return { ...publicRequest(value), status: latest.response.status, note: latest.response.note, updatedAt: latest.rows[0].createdAt, shortId: shortId(value) }; });
    },
  });
}
