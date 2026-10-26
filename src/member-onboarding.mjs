import { mkdirSync, lstatSync, realpathSync, openSync, readFileSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, fstatSync, fchmodSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { timestamp } from './store.mjs';

const clone = value => structuredClone(value);
const routeKeys = ['personId', 'accountId', 'peerId', 'generation'];
const sameRoute = (a, b) => Boolean(a && b && routeKeys.every(key => a[key] === b[key]));
const toolNames = { ai_digest: 'AI 日报', weather: '天气', presentation: 'PPT 制作' };
const toolExamples = { ai_digest: 'AI 日报', weather: '查天气', presentation: '帮我把这段材料做成 PPT' };
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function object(value, fields, required = fields, code = 'INVALID_ARGUMENT') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !fields.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(code, '欢迎记录或参数格式无效。');
}
function text(value, max = 200, code = 'INVALID_ARGUMENT') {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(code, '欢迎记录或参数格式无效。');
  return value;
}
function personId(value, code = 'INVALID_ARGUMENT') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(value)) fail(code, '成员标识无效。');
  return value;
}
function validRoute(value, code = 'INVALID_ARGUMENT') {
  object(value, routeKeys, routeKeys, code); personId(value.personId, code); text(value.accountId, 200, code); text(value.peerId, 200, code);
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) fail(code, '欢迎绑定版本无效。');
  return value;
}
const sourceKeyFor = route => `member-welcome:v1:${route.personId}:${createHash('sha256').update(JSON.stringify(routeKeys.map(key => route[key]))).digest('hex')}`;
function statOrNull(path) { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; fail('IO_ERROR', '无法检查欢迎记录。'); } }

/** Describes actual member capabilities and admits a first-binding welcome.
 * The runtime owns its single-process lock, outbox, transport and status changes.
 * No family notes, messages, project contents or executor results are read here. */
export function createMemberOnboarding({ directory, store, toolbox, access, presentations, projectExecutorAvailable = false, generalAgentAvailable = false, now = () => new Date().toISOString() } = {}) {
  if (typeof directory !== 'string' || !directory.trim() || directory.length > 4096 || directory.includes('\0') || typeof store?.snapshot !== 'function' || typeof now !== 'function' || typeof projectExecutorAvailable !== 'boolean' || typeof generalAgentAvailable !== 'boolean') fail('INVALID_ARGUMENT', '缺少有效的欢迎服务配置。');
  const supplied = resolve(directory), before = statOrNull(supplied);
  if (before && (before.isSymbolicLink() || !before.isDirectory())) fail('UNSAFE_PATH', '欢迎记录目录不能是链接或普通文件。');
  mkdirSync(supplied, { recursive: true, mode: 0o700 });
  const root = realpathSync(supplied), rootIdentity = lstatSync(root), file = join(root, 'member-onboarding.json');
  const clock = () => timestamp(now());
  function stateOfStore() {
    const state = store.snapshot();
    if (!state || !Array.isArray(state.people) || !Array.isArray(state.bindings)) fail('INVALID_STATE', '无法核对当前成员与绑定。');
    return state;
  }
  function member(id) {
    personId(id); const person = stateOfStore().people.find(row => row.id === id);
    if (!person) fail('UNKNOWN_PERSON', '没有找到当前家庭成员。');
    return person;
  }
  function binding(id) {
    const value = stateOfStore().bindings.find(row => row.personId === id);
    return value ? { route: validRoute(Object.fromEntries(routeKeys.map(key => [key, value[key]]))), connected: value.status === 'connected' } : null;
  }
  function secureFile(optional = false) {
    const current = statOrNull(root);
    if (!current || current.isSymbolicLink() || !current.isDirectory() || current.ino !== rootIdentity.ino || current.dev !== rootIdentity.dev) fail('UNSAFE_PATH', '欢迎记录目录在运行期间发生变化。');
    const info = statOrNull(file);
    if (!info) { if (optional) return null; fail('INVALID_STATE', '欢迎记录缺失，未自动重建。'); }
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) fail('UNSAFE_PATH', '欢迎记录不能是链接或特殊文件。');
    if (info.size > 2 * 1024 * 1024) fail('INVALID_STATE', '欢迎记录超过容量上限。');
    return info;
  }
  function validate(state) {
    const invalid = 'INVALID_STATE'; object(state, ['version', 'members'], ['version', 'members'], invalid);
    if (state.version !== 1 || !Array.isArray(state.members) || state.members.length > 5000) fail(invalid, '欢迎记录版本或格式不受支持，请保留原文件后检查。');
    const ids = new Set();
    for (const row of state.members) {
      object(row, ['personId', 'status', 'createdAt', 'route', 'sourceKey', 'outboxId', 'enqueuedAt'], ['personId', 'status', 'createdAt'], invalid);
      personId(row.personId, invalid);
      if (ids.has(row.personId) || !['baseline', 'eligible', 'enqueued', 'suppressed'].includes(row.status)) fail(invalid, '欢迎记录重复或状态无效。');
      ids.add(row.personId);
      try { timestamp(row.createdAt); if (row.enqueuedAt !== undefined) timestamp(row.enqueuedAt); } catch { fail(invalid, '欢迎记录时间无效。'); }
      if (['eligible', 'enqueued'].includes(row.status)) {
        validRoute(row.route, invalid);
        if (row.route.personId !== row.personId || row.sourceKey !== sourceKeyFor(row.route)) fail(invalid, '欢迎记录的绑定范围无效。');
      } else if (row.route !== undefined || row.sourceKey !== undefined) fail(invalid, '未获准的欢迎记录不能携带发送范围。');
      if (row.status === 'enqueued') {
        personId(row.outboxId, invalid);
        if (!row.enqueuedAt) fail(invalid, '欢迎入队记录不完整。');
      } else if (row.outboxId !== undefined || row.enqueuedAt !== undefined) fail(invalid, '欢迎入队状态无效。');
    }
    return state;
  }
  function read() {
    const expected = secureFile(); let fd;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== expected.ino || opened.dev !== expected.dev) fail('UNSAFE_PATH', '读取期间欢迎记录发生变化。');
      let value; try { value = JSON.parse(readFileSync(fd, 'utf8')); } catch { fail('INVALID_STATE', '欢迎记录无法解析，请保留原文件后检查。'); }
      return validate(value);
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  function save(state, initial = false) {
    validate(state); secureFile(initial); const temporary = join(root, `.member-onboarding-${randomUUID()}.tmp`); let fd;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      fchmodSync(fd, 0o600); writeFileSync(fd, JSON.stringify(state, null, 2) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined;
      secureFile(initial); renameSync(temporary, file);
      const dirfd = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(dirfd); } finally { closeSync(dirfd); }
    } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch {} }
  }
  if (secureFile(true)) read();
  else {
    const ids = [...new Set(stateOfStore().bindings.map(row => personId(row.personId)))];
    save({ version: 1, members: ids.map(id => ({ personId: id, status: 'baseline', createdAt: clock() })) }, true);
  }

  function describe(id) {
    member(id); const state = stateOfStore(), owner = state.people.find(row => row.role === 'owner');
    const catalog = typeof toolbox?.catalog === 'function' ? toolbox.catalog({ personId: owner?.id ?? id }) : [];
    const grants = owner && typeof toolbox?.assignments === 'function' ? toolbox.assignments({ actorId: owner.id, personId: id }) : [];
    const service = typeof presentations?.snapshot === 'function' ? presentations.snapshot() : null;
    const pptEnabled = service?.available === true && service.people?.some(row => row.personId === id && row.enabled === true);
    const tools = [];
    for (const toolId of Object.keys(toolNames)) {
      const grant = grants.find(row => row.personId === id && row.toolId === toolId), item = catalog.find(row => row.toolId === toolId);
      const executorAvailable = item?.executorAvailable === true, scheduled = grant?.schedule?.enabled === true;
      const allowInvoke = toolId === 'presentation' ? pptEnabled : executorAvailable && grant?.allowInvoke === true;
      if (!allowInvoke && !(scheduled && executorAvailable && toolId !== 'presentation')) continue;
      tools.push({ toolId, title: toolNames[toolId], allowInvoke, scheduled: scheduled && executorAvailable, sourceStatus: 'not_checked', ...(scheduled && executorAvailable ? { time: grant.schedule.time, timeZone: grant.schedule.timeZone } : {}) });
    }
    const policy = typeof access?.get === 'function' ? access.get(id) : { workspaceIds: [], capabilities: [] };
    const workspaceIds = Array.isArray(policy.workspaceIds) ? clone(policy.workspaceIds) : [];
    const capabilities = Array.isArray(policy.capabilities) ? ['read', 'task', 'write'].filter(value => policy.capabilities.includes(value)) : [];
    const available = projectExecutorAvailable && workspaceIds.length > 0 && capabilities.includes('read') && capabilities.includes('task');
    const projects = { workspaceIds, capabilities, available, canRead: available, canWrite: available && capabilities.includes('write') };
    const lines = generalAgentAvailable
      ? ['直接告诉我想做什么，我可以：', '• 解释问题、写稿，整理、分析和修改你收到的材料和日报；需要时保存本人的稿件。', '• 查询公开信息；有来源才说明事实，查询受阻会告诉你。', '• 记事，并找回你让我保存的内容。', '• 设置日程和提醒；查看你自己的日程、提醒，按你的要求修改或取消。', '我只使用你的材料和获准资料；Owner 的私人项目仍需单独授权。', '下面的快捷工具是预设服务；解释、写稿和整理本人材料不需要先开通它们。']
      : ['你目前可以直接让我：', '• 记事，并找回你让我保存的内容。', '• 设置日程和提醒；查看你自己的日程、提醒，按你的要求修改或取消。'];
    const examples = generalAgentAvailable
      ? ['把我刚收到的日报改得简短一点', '帮我写一段给朋友的祝福', '帮我查一下今天的公开信息', '明天上午九点提醒我给花浇水']
      : ['帮我记住：周末出门要带雨伞', '明天上午九点提醒我给花浇水', '我有哪些日程和提醒？'];
    for (const item of tools) {
      let line = `• ${item.title}：`;
      if (item.allowInvoke) {
        line += item.toolId === 'ai_digest' ? '读取为你授权的日报资料。' : item.toolId === 'weather' ? '查询为你设置的城市天气。' : '发送主题和材料，制作可编辑 PPT 并继续修改。';
        examples.push(toolExamples[item.toolId]);
      }
      if (item.scheduled) line += generalAgentAvailable
        ? `每天 ${item.time}（${item.timeZone}）按安排投送。${item.allowInvoke ? '' : '这个预设服务仅按安排投送，一般查询和材料处理仍可直接告诉我。'}这是由 Owner 安排的预设投送，想调整投送时间可以告诉我转达需求。`
        : `每天 ${item.time}（${item.timeZone}）按安排推送${item.allowInvoke ? '。' : '，不能临时调用。'}这是由 Owner 安排的投送，想调整可以告诉我转达需求。`;
      lines.push(line);
    }
    if (projects.available) {
      lines.push(`• 项目资料：读取你获准的 ${workspaceIds.length} 个项目中的资料，按问题整理和回答。${projects.canWrite ? '可以在本人专属目录创建新文件，不会覆盖原文件。' : ''}`);
      examples.push(projects.canWrite ? '把我获准项目里的资料整理成一份新文件' : '帮我整理已获准项目里的资料要点');
    }
    if (tools.length) lines.push('工具是否取得有效内容，以每次执行结果为准。');
    lines.push('例如你可以说：', ...examples.map(value => `“${value}”`));
    return { personId: id, text: lines.join('\n'), examples, tools, projects };
  }
  function shortWelcomeText(id) {
    const help = describe(id), personalized = help.tools.find(item => item.allowInvoke);
    if (generalAgentAvailable) {
      const ppt = help.tools.some(item => item.toolId === 'presentation' && item.allowInvoke);
      return `我是乐乐，欢迎你。直接告诉我想做什么：解释问题、写稿，整理或修改你收到的材料和日报，也能查公开信息、记事和安排自己的提醒。${ppt ? '还可以制作并继续修改 PPT。' : ''}\n\nOwner 的私人项目需单独授权。\n试着说：“把刚收到的日报改短一点。”\n想了解更多，问“你能帮我做什么”。`;
    }
    const example = personalized ? toolExamples[personalized.toolId] : help.projects.available ? help.examples.at(-1) : null;
    const examples = example ? [example, ...help.examples.slice(0, 2)] : help.examples.slice(0, 3);
    return `我是乐乐，欢迎你。你可以在这里让我记事、安排自己的日程提醒，也能查询、改期或取消。\n\n试着说：\n${examples.map(value => `“${value}”`).join('\n')}\n\n想看当前已开通的能力，直接问“你能帮我做什么”。`;
  }
  function suppress(state, row) {
    Object.assign(row, { status: 'suppressed' }); delete row.route; delete row.sourceKey; save(state);
  }
  function enqueued(state, row, outbox) {
    row.status = 'enqueued'; row.outboxId = outbox.id; row.enqueuedAt = clock(); save(state);
  }
  return Object.freeze({
    describe,
    matchesWelcome(input) {
      try {
        object(input, ['personId', 'text']);
        return typeof input.text === 'string' && input.text === shortWelcomeText(input.personId);
      } catch { return false; }
    },
    markBound(id, identity, options = {}) {
      member(id); object(identity, ['accountId', 'peerId']); text(identity.accountId); text(identity.peerId);
      object(options, ['newBinding'], []);
      if (options.newBinding !== undefined && typeof options.newBinding !== 'boolean') fail('INVALID_ARGUMENT', '绑定首次状态无效。');
      const current = binding(id);
      if (!current || !current.connected || current.route.accountId !== identity.accountId || current.route.peerId !== identity.peerId) fail('INVALID_ARGUMENT', '绑定身份与当前成员通路不一致。');
      const state = read(), old = state.members.find(row => row.personId === id);
      if (old) {
        if (old.status === 'eligible' && !sameRoute(old.route, current.route)) suppress(state, old);
        return { eligible: old.status === 'eligible', ...(old.status === 'eligible' ? { sourceKey: old.sourceKey } : {}) };
      }
      if (options.newBinding === false || current.route.generation !== 1) {
        state.members.push({ personId: id, status: 'suppressed', createdAt: clock() }); save(state); return { eligible: false };
      }
      const row = { personId: id, status: 'eligible', createdAt: clock(), route: current.route, sourceKey: sourceKeyFor(current.route) };
      state.members.push(row); save(state); return { eligible: true, sourceKey: row.sourceKey };
    },
    admit(id) {
      member(id); const state = read(), row = state.members.find(value => value.personId === id);
      if (row?.status !== 'eligible') return null;
      const outbox = stateOfStore().outbox?.find(value => value.sourceKey === row.sourceKey);
      if (outbox) {
        if (outbox.personId !== id || !sameRoute(outbox.route, row.route)) fail('INVALID_STATE', '欢迎入队范围与原绑定不一致。');
        enqueued(state, row, outbox); return null;
      }
      const current = binding(id);
      if (!current || !sameRoute(current.route, row.route)) { suppress(state, row); return null; }
      if (!current.connected) return null;
      return { personId: id, text: shortWelcomeText(id), kind: 'member_welcome', sourceKey: row.sourceKey, route: clone(row.route), authorizationRoute: clone(row.route) };
    },
    markEnqueued(input) {
      object(input, ['personId', 'sourceKey', 'outboxId']); member(input.personId); text(input.sourceKey, 512); personId(input.outboxId);
      const state = read(), row = state.members.find(value => value.personId === input.personId);
      const outbox = stateOfStore().outbox?.find(value => value.id === input.outboxId && value.sourceKey === input.sourceKey && value.personId === input.personId);
      if (!row || !['eligible', 'enqueued'].includes(row.status) || row.sourceKey !== input.sourceKey || !outbox || !sameRoute(outbox.route, row.route)) fail('INVALID_ARGUMENT', '没有找到原绑定对应的欢迎入队记录。');
      if (row.status === 'eligible') enqueued(state, row, outbox);
      return { enqueued: true };
    },
  });
}
