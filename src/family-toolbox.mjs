import { mkdirSync, lstatSync, realpathSync, existsSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, chmodSync, constants } from 'node:fs';
import { resolve, join, parse } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeDigestResource } from './digest-discovery.mjs';
import { addLocalDays, localDate, localDateTimeToInstant } from './brief.mjs';
import { CATCH_UP_MS } from './scheduler.mjs';

const templates = [
  { toolId: 'ai_digest', title: 'AI 精选日报', description: '阅读已授权的日报文件' },
  { toolId: 'weather', title: '天气', description: '查询已设置城市的天气' },
  { toolId: 'presentation', title: '制作演示文稿', description: '使用已配置的演示文稿工作流' },
];
const statuses = ['queued', 'running', 'succeeded', 'failed', 'uncertain'];
const digestFailureCodes = ['digest_no_current_report', 'digest_ambiguous_source', 'digest_source_changed'];
const clone = value => structuredClone(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = (value, fields) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !fields.includes(key))) fail('invalid_argument');
  return value;
};
const text = (value, max = 240) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) fail('invalid_argument');
  return value;
};
const id = value => { text(value, 80); if (!/^[A-Za-z0-9_-]+$/u.test(value)) fail('invalid_argument'); return value; };
const tool = value => { if (!templates.some(row => row.toolId === value)) fail('invalid_argument'); return value; };
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function canonical(value) {
  return JSON.stringify(value, function (_key, item) {
    return item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
  });
}
function json(value, budget = 24_000, depth = 0) {
  if (depth > 8 || value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') fail('invalid_argument');
  if (typeof value === 'number' && !Number.isFinite(value)) fail('invalid_argument');
  if (value && typeof value === 'object') {
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid_argument');
    for (const item of Object.values(value)) json(item, budget, depth + 1);
  }
  if (JSON.stringify(value).length > budget) fail('invalid_argument');
  return clone(value);
}
function resource(toolId, value) {
  if (toolId === 'ai_digest') {
    object(value, ['workspaceId', 'relativePath', 'selection', 'sourceTimeZone']); text(value.workspaceId); text(value.relativePath, 1024);
    if (!normalizeDigestResource(value)) fail('invalid_argument');
  } else if (toolId === 'weather') { object(value, ['city','locationId']); text(value.city, 120);if(value.locationId!==undefined&&(!Number.isSafeInteger(value.locationId)||value.locationId<1))fail('invalid_argument'); }
  else { object(value, ['workflow']); if (value.workflow !== 'presentation') fail('invalid_argument'); }
  return clone(value);
}
function schedule(value = null) {
  if (value === null) return null;
  object(value, ['enabled', 'time', 'timeZone']);
  if (typeof value.enabled !== 'boolean') fail('invalid_argument');
  if (value.enabled || value.time !== undefined || value.timeZone !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(value.time ?? '')) fail('invalid_argument');
    text(value.timeZone, 100);
    try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }); } catch { fail('invalid_argument'); }
  }
  return clone(value);
}

/** Finite family tools only. Executors own their own resource confinement; no
 * Host Agent, shell, file reader, network client or delivery transport is added.
 * The runtime owns the exclusive process lock for this synchronous registry. */
export function createFamilyToolbox({ directory, store, executors = {}, now = () => new Date().toISOString() } = {}) {
  text(directory, 4096);
  if (typeof store?.snapshot !== 'function' || typeof now !== 'function') fail('invalid_argument');
  const requestedRoot = resolve(directory);
  if (existsSync(requestedRoot) && lstatSync(requestedRoot).isSymbolicLink()) fail('unsafe_path');
  mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
  const root = realpathSync(requestedRoot), file = join(root, 'family-toolbox.json'), active = new Map();
  const clock = () => { const instant = new Date(now()); if (!Number.isFinite(+instant)) fail('invalid_argument'); return instant.toISOString(); };
  function safePath() {
    let current = parse(root).root;
    for (const segment of root.slice(current.length).split('/').filter(Boolean)) {
      current = join(current, segment);
      if (!existsSync(current)) break;
      const info = lstatSync(current); if (info.isSymbolicLink() || !info.isDirectory()) fail('unsafe_path');
    }
    if (existsSync(file)) { const info = lstatSync(file); if (info.isSymbolicLink() || !info.isFile()) fail('unsafe_path'); }
  }
  safePath(); mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootIdentity = lstatSync(root);
  function validate(state) {
    try {
      object(state, ['version', 'grants', 'runs', 'requests']);
      if (state.version !== 1 || !Array.isArray(state.grants) || state.grants.length > 3000 || !Array.isArray(state.runs) || state.runs.length > 10_000 || !Array.isArray(state.requests) || state.requests.length > 3000) fail('invalid_argument');
      const keys = new Set();
      for (const row of state.grants) {
        object(row, ['personId', 'toolId', 'resource', 'allowInvoke', 'schedule', 'revision', 'updatedAt']); id(row.personId); tool(row.toolId); resource(row.toolId, row.resource); schedule(row.schedule);
        if (!Object.hasOwn(row, 'schedule') || typeof row.allowInvoke !== 'boolean' || !Number.isSafeInteger(row.revision) || row.revision < 1) fail('invalid_argument');
        text(row.updatedAt); const key = `${row.personId}/${row.toolId}`; if (keys.has(key)) fail('invalid_argument'); keys.add(key);
      }
      for (const [kind, rows] of [['run', state.runs], ['request', state.requests]]) for (const row of rows) {
        object(row, kind === 'run' ? ['personId', 'toolId', 'requestId', 'actorId', 'fingerprint', 'scope', 'revision', 'status', 'createdAt', 'updatedAt', 'result', 'reason','mode','failureCode'] : ['personId', 'requestId', 'fingerprint', 'text', 'status', 'createdAt', 'updatedAt', 'note']);
        id(row.personId); text(row.requestId, 512); text(row.fingerprint); text(row.createdAt);
        if (!/^[a-f0-9]{64}$/u.test(row.fingerprint) || new Date(row.createdAt).toISOString() !== row.createdAt) fail('invalid_argument');
        const key = `${kind}/${row.personId}/${row.requestId}`; if (keys.has(key)) fail('invalid_argument'); keys.add(key);
        if (kind === 'run') {
          tool(row.toolId); if (row.actorId !== null) id(row.actorId);if(row.mode!==undefined&&!['member','owner','scheduled'].includes(row.mode))fail('invalid_argument'); text(row.scope); text(row.updatedAt);
          if (!/^[a-f0-9]{64}$/u.test(row.scope) || new Date(row.updatedAt).toISOString() !== row.updatedAt || !statuses.includes(row.status) || !Number.isSafeInteger(row.revision) || row.revision < 1 || (row.status === 'succeeded') !== Object.hasOwn(row, 'result')) fail('invalid_argument');
          if (row.result !== undefined) json(row.result, 64_000);
          if (row.reason !== undefined && !['restart_uncertain', 'authorization_changed', 'cancelled', 'executor_failed', 'invalid_result', 'executor_pending'].includes(row.reason)) fail('invalid_argument');
          if (row.failureCode !== undefined && (row.toolId!=='ai_digest'||row.status!=='failed'||row.reason!=='executor_failed'||!digestFailureCodes.includes(row.failureCode))) fail('invalid_argument');
        } else { text(row.text, 4000); if (!['pending','accepted','completed','declined'].includes(row.status)) fail('invalid_argument');if(row.note!==undefined)text(row.note,2000);if(row.updatedAt!==undefined&&new Date(row.updatedAt).toISOString()!==row.updatedAt)fail('invalid_argument'); }
      }
    } catch { fail('invalid_state'); }
    return state;
  }
  function load() {
    safePath(); const info = lstatSync(root);
    if (info.ino !== rootIdentity.ino || info.dev !== rootIdentity.dev) fail('unsafe_path');
    let fd;
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); return validate(JSON.parse(readFileSync(fd, 'utf8'))); }
    catch (error) { if (['unsafe_path', 'invalid_state'].includes(error.code)) throw error; fail('invalid_state'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  function save(state) {
    safePath(); validate(state); const temporary = join(root, `.family-toolbox-${randomUUID()}.tmp`); let fd;
    try {
      fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, JSON.stringify(state) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, file); chmodSync(file, 0o600); fd = openSync(root, 'r'); fsyncSync(fd);
    } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch {} }
  }
  if (!existsSync(file)) save({ version: 1, grants: [], runs: [], requests: [] });
  const recovered = load();
  if (recovered.runs.some(row => ['queued', 'running'].includes(row.status))) {
    for (const row of recovered.runs) if (['queued', 'running'].includes(row.status)) { row.status = 'uncertain'; row.reason = 'restart_uncertain'; row.updatedAt = clock(); delete row.result; }
    save(recovered);
  }
  function member(personId,{active=true}={}) {
    id(personId); const snapshot = store.snapshot(), person = snapshot.people?.find(row => row.id === personId);
    if (!person) fail('unknown_person');
    const binding = snapshot.bindings?.find(row => row.personId === personId);
    if (!['owner', 'elder'].includes(person.role) || active&&(person.status !== undefined && person.status !== 'active' || binding && binding.status !== 'connected')) fail('member_inactive');
    return { person, scope: hash({ personId, role: person.role, createdAt: person.createdAt ?? null, binding: binding ? { accountId: binding.accountId, peerId: binding.peerId, generation: binding.generation } : null }) };
  }
  const owner = actorId => { if (member(actorId,{active:false}).person.role !== 'owner') fail('forbidden'); };
  const scopeOf = (personId, actorId) => hash({ person: member(personId).scope, actor: actorId === null ? null : member(actorId).scope });
  const findGrant = (state, personId, toolId) => state.grants.find(row => row.personId === personId && row.toolId === toolId);
  const output = row => clone(Object.fromEntries(['personId', 'toolId', 'requestId', 'revision', 'status', 'result', 'reason', 'failureCode'].filter(key => row[key] !== undefined).map(key => [key, row[key]])));
  function check(row) {
    try {
      const grant = findGrant(load(), row.personId, row.toolId);
      if (row.actorId !== null) owner(row.actorId);
      return scopeOf(row.personId, row.actorId) === row.scope && Boolean(grant&&(row.mode==='scheduled'?grant.schedule?.enabled===true:row.actorId!==null||grant.allowInvoke===true)) && grant.revision === row.revision;
    } catch { return false; }
  }
  function update(row, patch) {
    const state = load(), live = state.runs.find(item => item.personId === row.personId && item.requestId === row.requestId);
    if (!live || live.fingerprint !== row.fingerprint) fail('invalid_state');
    if (!['queued', 'running'].includes(live.status)) return output(live);
    Object.assign(live, patch, { updatedAt: clock() }); if (live.status !== 'succeeded') delete live.result; save(state); return output(live);
  }
  async function routeAllows(authorize, row, phase) {
    if (!authorize) return true;
    try { const decision = await authorize({ personId: row.personId, toolId: row.toolId, requestId: row.requestId, revision: row.revision, phase }); return decision === true || decision?.allowed === true; } catch { return false; }
  }
  async function execute(row, input, options) {
    const controller = new AbortController(), abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (!await routeAllows(options.authorize, row, 'before') || !check(row)) return update(row, { status: 'failed', reason: 'authorization_changed' });
      if (options.signal?.aborted) return update(row, { status: 'failed', reason: 'cancelled' });
      const started = update(row, { status: 'running' }); if (started.status !== 'running') return started;
      let value, error;
      try { value = await executors[row.toolId]({ personId: row.personId, resource: clone(findGrant(load(), row.personId, row.toolId).resource), input: clone(input), signal: controller.signal }); } catch (caught) { error = row.toolId==='ai_digest'&&digestFailureCodes.includes(caught?.code)?caught.code:true; }
      const permitted = await routeAllows(options.authorize, row, 'after');
      if (!permitted || !check(row) || options.signal?.aborted) return update(row, { status: 'uncertain', reason: options.signal?.aborted ? 'cancelled' : 'authorization_changed' });
      if (error) return update(row, { status: 'failed', reason: 'executor_failed', ...(typeof error==='string'?{failureCode:error}:{}) });
      try {
        value = json(value, 64_000);
        if (value && typeof value === 'object' && Object.hasOwn(value, 'status')) {
          if (!statuses.includes(value.status)) fail('invalid_argument');
          if (value.status !== 'succeeded') return update(row, { status: value.status, reason: value.status === 'failed' ? 'executor_failed' : 'executor_pending' });
          value = json(value.result, 64_000);
        }
      } catch { return update(row, { status: 'failed', reason: 'invalid_result' }); }
      return update(row, { status: 'succeeded', result: value });
    } finally { options.signal?.removeEventListener('abort', abort); controller.abort(); }
  }
  async function invokeInternal(args, options = {}, actorId = null) {
    object(args, ['personId', 'toolId', 'requestId', 'input', 'expectedRevision']); id(args.personId); tool(args.toolId); text(args.requestId, 512);
    if (args.expectedRevision !== undefined && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1)) fail('invalid_argument');
    if (options.authorize !== undefined && typeof options.authorize !== 'function') fail('invalid_argument');
    if (options.signal?.aborted) fail('cancelled');
    if (actorId !== null) owner(actorId);
    const input = json(args.input ?? null), scope = scopeOf(args.personId, actorId), state = load(), grant = findGrant(state, args.personId, args.toolId);
    const mode=options.scheduled===true?'scheduled':actorId!==null?'owner':'member';
    if (!grant||(mode==='scheduled'?!grant.schedule?.enabled:mode==='member'&&!grant.allowInvoke)) fail('not_granted');
    if (args.expectedRevision !== undefined && args.expectedRevision !== grant.revision) fail('authorization_changed');
    const fingerprint = hash({ ...args, input, actorId,mode }), key = `${args.personId}/${args.requestId}`, old = state.runs.find(row => row.personId === args.personId && row.requestId === args.requestId);
    if (old) {
      if (old.fingerprint !== fingerprint) fail('request_conflict');
      if (!check(old) || !await routeAllows(options.authorize, old, 'replay') || !check(old)) fail('authorization_changed');
      const result = active.has(key) ? clone(await active.get(key)) : output(old);
      if (!await routeAllows(options.authorize, old, 'replay_after') || !check(old) || options.signal?.aborted) fail('authorization_changed');
      return result;
    }
    if (typeof executors[args.toolId] !== 'function') fail('not_configured');
    const row = { personId: args.personId, toolId: args.toolId, requestId: args.requestId, actorId, fingerprint, scope,mode, revision: grant.revision, status: 'queued', createdAt: clock(), updatedAt: clock() };
    state.runs.push(row); save(state);
    const pending = execute(row, input, options); active.set(key, pending);
    try { return clone(await pending); } finally { if (active.get(key) === pending) active.delete(key); }
  }
  return Object.freeze({
    catalog({ personId }) {
      const { person } = member(personId,{active:false}), state = load();
      return clone(templates.filter(row => person.role === 'owner' || findGrant(state, personId, row.toolId)?.allowInvoke).map(row => {
        const executorAvailable=typeof executors[row.toolId]==='function',assigned=findGrant(state,personId,row.toolId)?.allowInvoke===true;
        return {...row,executorAvailable,ready:executorAvailable&&assigned,reason:!executorAvailable?'not_configured':!assigned?'not_assigned':'ready',sourceStatus:'not_checked',...(person.role==='owner'?{assignments:state.grants.filter(grant=>grant.toolId===row.toolId).map(({personId,allowInvoke,revision,schedule})=>({personId,allowInvoke,revision,scheduled:schedule?.enabled===true}))}:{revision:findGrant(state,personId,row.toolId).revision})};
      }));
    },
    assign(args) {
      object(args, ['actorId', 'personId', 'toolId', 'resource', 'allowInvoke', 'schedule']); owner(args.actorId); member(args.personId,{active:false}); tool(args.toolId);
      if (typeof args.allowInvoke !== 'boolean') fail('invalid_argument');
      const state = load(), old = findGrant(state, args.personId, args.toolId), row = { personId: args.personId, toolId: args.toolId, resource: resource(args.toolId, args.resource), allowInvoke: args.allowInvoke, schedule: schedule(args.schedule), revision: (old?.revision ?? 0) + 1, updatedAt: clock() };
      if (old) state.grants[state.grants.indexOf(old)] = row; else state.grants.push(row); save(state); return clone(row);
    },
    assignments(args) { object(args,['actorId','personId']);owner(args.actorId);if(args.personId!==undefined)member(args.personId,{active:false});return clone(load().grants.filter(row=>args.personId===undefined||row.personId===args.personId)); },
    invoke: (args, options) => invokeInternal(args, options),
    invokeScheduled: (args,options) => invokeInternal(args,{...options,scheduled:true}),
    async invokeFor(args, options) { object(args, ['actorId', 'personId', 'toolId', 'requestId', 'input', 'expectedRevision']); id(args.actorId); const { actorId, ...request } = args; return invokeInternal(request, options, actorId); },
    isCurrent(args) {
      try {
        object(args, ['personId', 'toolId', 'requestId', 'revision']); id(args.personId); tool(args.toolId); text(args.requestId, 512);
        if (!Number.isSafeInteger(args.revision) || args.revision < 1) return false;
        const row = load().runs.find(item => item.personId === args.personId && item.toolId === args.toolId && item.requestId === args.requestId);
        return row?.status === 'succeeded' && row.revision === args.revision && check(row);
      } catch { return false; }
    },
    requestWorkflow(args) {
      object(args, ['personId', 'requestId', 'text']); member(args.personId); text(args.requestId, 512); text(args.text, 4000);
      const state = load(), fingerprint = hash(args), old = state.requests.find(row => row.personId === args.personId && row.requestId === args.requestId);
      if (old) { if (old.fingerprint !== fingerprint) fail('request_conflict'); return clone(old); }
      const row = { ...clone(args), fingerprint, status: 'pending', createdAt: clock() }; state.requests.push(row); save(state); return clone(row);
    },
    listRequests({ actorId }) { owner(actorId); return clone(load().requests); },
    updateRequest(args) { object(args,['actorId','personId','requestId','status','note']);owner(args.actorId);id(args.personId);text(args.requestId,512);if(!['pending','accepted','completed','declined'].includes(args.status))fail('invalid_argument');if(args.note!==undefined)text(args.note,2000);const state=load(),row=state.requests.find(item=>item.personId===args.personId&&item.requestId===args.requestId);if(!row)fail('unknown_request');row.status=args.status;row.updatedAt=clock();if(args.note!==undefined)row.note=args.note;save(state);return clone(row); },
    serviceLedger({actorId}){owner(actorId);const shared=new Set(store.snapshot().people.filter(person=>person.role==='owner'||['summary','full'].includes(person.shareWithOwner)).map(person=>person.id));return clone(load().runs.filter(row=>shared.has(row.personId)).map(({personId,toolId,status,createdAt,updatedAt})=>({personId,toolId,status,createdAt,updatedAt})));},
    due() {
      const state=load(),instant=clock(),nowMs=Date.parse(instant);
      return state.grants.filter(row => { try { member(row.personId); return row.schedule?.enabled && typeof executors[row.toolId] === 'function'; } catch { return false; } }).flatMap(row => {
        const authorizedAt=Date.parse(row.updatedAt),day=localDate(instant,row.schedule.timeZone),time=row.schedule.time;
        if(!Number.isFinite(authorizedAt))return [];
        // Use the same DST and bounded catch-up policy as ordinary reminders.
        // Updating a grant starts a new revision; it cannot authorize an earlier occurrence.
        return [addLocalDays(day,-1),day].flatMap(date=>{
          const dueAt=localDateTimeToInstant(date,time,row.schedule.timeZone),dueMs=dueAt===null?NaN:Date.parse(dueAt);
          if(!Number.isFinite(dueMs)||dueMs<authorizedAt||dueMs>nowMs||nowMs-dueMs>CATCH_UP_MS)return [];
          const sourceKey=`tool:${row.toolId}:${row.personId}:${row.revision}:${date}:${time}`;
          // Any durable attempt owns this occurrence, even failed or uncertain work.
          if(state.runs.some(run=>run.personId===row.personId&&run.requestId===sourceKey))return [];
          return [{personId:row.personId,toolId:row.toolId,expectedRevision:row.revision,localDate:date,time,timeZone:row.schedule.timeZone,sourceKey,requestId:sourceKey}];
        });
      });
    },
  });
}
