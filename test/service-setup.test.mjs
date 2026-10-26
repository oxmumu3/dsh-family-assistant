import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFamilyToolbox } from '../src/family-toolbox.mjs';
import { createServiceSetup, isServiceSetupCandidate } from '../src/service-setup.mjs';

const now = () => '2026-10-25T12:00:00.000Z';
function fixture(t, changes = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'lele-service-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const people = [{ id: 'owner', label: '山', role: 'owner', timeZone: 'America/Mexico_City', createdAt: 'owner-v1' }, { id: 'mom', label: '妈妈', role: 'elder', timeZone: 'Asia/Shanghai', createdAt: 'mom-v1' }, { id: 'dad', label: '爸爸', role: 'elder', timeZone: 'Asia/Shanghai', createdAt: 'dad-v1' }];
  const bindings = people.map(p => ({ personId: p.id, accountId: `a-${p.id}`, peerId: `p-${p.id}`, generation: 1, status: 'connected' }));
  const store = { snapshot: () => structuredClone({ people, bindings }) };
  let executions = 0, discovers = 0;
  const toolbox = createFamilyToolbox({ directory, store, now, executors: { ai_digest: () => { executions++; return 'DO NOT READ'; } } });
  const projects = [{ workspaceId: 'daily', title: '科技资讯', path: '/private/project' }];
  const files = { daily: [{ relativePath: 'reports/latest.md', name: 'latest.md', bytes: 80, updatedAt: now(), content: 'DO NOT READ', path: '/private/file' }] };
  const places = [{ id: 1816670, name: '北京', label: '北京，中国', timeZone: 'Asia/Shanghai', latitude: 1, longitude: 2 }];
  const options = { directory, store, toolbox, listProjects: async () => structuredClone(projects), digestSources: async ({ workspaceId }) => { discovers++; return structuredClone(files[workspaceId] ?? []); }, weatherSearch: async () => structuredClone(places), now, ...changes };
  const setup = createServiceSetup(options);
  let sequence = 0;
  const handle = (text, extra = {}) => setup.handle({ actorId: 'owner', text, requestId: `message-${++sequence}`, ...extra });
  return { directory, people, bindings, store, toolbox, projects, files, places, options, setup, handle, executions: () => executions, discovers: () => discovers };
}
const grant = { actorId: 'owner', personId: 'mom', toolId: 'ai_digest', resource: { workspaceId: 'daily', relativePath: 'reports/latest.md' }, allowInvoke: true, schedule: { enabled: true, time: '08:00', timeZone: 'Asia/Shanghai' } };
const confirm = (f, draft, requestId = 'confirm-1') => f.setup.confirm({ actorId: 'owner', draftId: draft.id, revision: draft.revision, requestId });

test('local material reads keep negative delivery and subscription constraints out of service setup', async t => {
  const f = fixture(t); f.toolbox.assign(grant);
  const texts = [
    '请自己找到本机 Codex 的 AI 日报项目，实际打开最新微信版日报，把正文回复给我；只回复我，不要发给 K，也不要修改订阅。',
    '请读取本地AI日报文件，不要发给妈妈，也不要修改订阅',
    '请读取本地AI日报文件，不要把AI日报发给K，只回复我',
    '请读取本地AI日报文件，不要给K推送AI日报',
    '请阅读AI日报，不要再发给K',
    '请读取本地AI日报，不要每天发给K，只回复我',
    '请打开最新AI日报正文，不要关闭订阅',
    '请读取本地文件，原文是“给妈妈开通AI日报服务”，只解释内容',
    '请解释“停止给妈妈每天推送AI日报”的意思，不要更改配置',
  ];
  for (const text of texts) {
    assert.equal(isServiceSetupCandidate(text), false, text);
    assert.equal(await f.handle(text), null, text);
    assert.equal(f.setup.snapshotForOwner({ actorId: 'owner' }).length, 0, text);
  }
  const active = await f.handle('给妈妈每天北京时间08:00发AI日报');
  const before = readFileSync(join(f.directory, 'service-setup.json'), 'utf8');
  assert.equal(await f.handle(texts[0]), null, 'a local read does not continue an unrelated active service draft');
  assert.equal(readFileSync(join(f.directory, 'service-setup.json'), 'utf8'), before);
  assert.equal(f.setup.snapshotForOwner({ actorId: 'owner' })[0].id, active.draft.id);
  assert.deepEqual(f.toolbox.assignments({ actorId: 'owner' })[0].schedule, grant.schedule);
});

test('quoted remarks beside explicit setup remain valid through persistence and restart', async t => {
  for (const text of ['给妈妈开通AI日报服务，备注“如何读懂AI”', '给妈妈开通AI日报服务，内容“不要开通AI日报”', '给妈妈开通“AI日报”', '给妈妈开通「天气服务」', '给妈妈开通“PPT制作服务”']) {
    const f = fixture(t), result = await f.handle(text);
    assert.equal(result.draft.operation, 'configure');
    const restarted = createServiceSetup(f.options);
    assert.equal(restarted.snapshotForOwner({ actorId: 'owner' })[0].id, result.draft.id);
    assert.equal((await f.handle('普通聊天')), null);
  }
});

test('explicit service changes remain candidates beside local material requests', async t => {
  const f = fixture(t); f.toolbox.assign(grant);
  for (const text of ['停止给妈妈每天推送AI日报', '不要再给妈妈每天推送AI日报', '关闭妈妈的AI日报服务']) {
    assert.equal(isServiceSetupCandidate(text), true, text);
    const result = await f.handle(text);
    assert.equal(result.draft.operation, 'disable', text);
    assert.equal(result.draft.schedule.enabled, false, text);
  }
  const text = '先读取本地资料；给妈妈开通AI日报服务';
  assert.equal(isServiceSetupCandidate(text), true);
  assert.equal((await f.handle(text)).draft.operation, 'configure');
  for (const recurring of ['给妈妈每天北京时间08:00发送你读取的本地AI日报', '每天08:00读取本地AI日报，发给妈妈']) {
    assert.equal(isServiceSetupCandidate(recurring), true, recurring);
    assert.equal((await f.handle(recurring)).draft.operation, 'configure', recurring);
  }
});

test('archived legacy false-stop evidence remains loadable without becoming a new service command', async t => {
  const f = fixture(t), legacy = await f.handle('停止给我每天推送AI日报');
  assert.equal(legacy.draft.status, 'cancelled');
  const file = join(f.directory, 'service-setup.json'), saved = JSON.parse(readFileSync(file, 'utf8'));
  const text = '请自己找到本机 Codex 的 AI 日报项目，实际打开最新微信版日报，把正文回复给我；只回复我，不要发给 K，也不要修改订阅。';
  saved.drafts[0].intentEvidence = text;
  writeFileSync(file, JSON.stringify(saved) + '\n');
  const before = readFileSync(file, 'utf8'), restarted = createServiceSetup(f.options);
  assert.equal(restarted.snapshotForOwner({ actorId: 'owner' })[0].status, 'cancelled');
  assert.equal(await restarted.handle({ actorId: 'owner', text, requestId: 'real-local-read', origin: 'wechat' }), null);
  assert.equal(readFileSync(file, 'utf8'), before, 'the archived ledger is not rewritten or reactivated');
});

test('complete digest request uses only actual metadata, waits for confirmation, and calls real assignment once', async t => {
  const f = fixture(t);
  const { draft, reply } = await f.handle('给妈妈每天北京时间早上八点发科技资讯项目的 AI 日报');
  assert.equal(draft.status, 'ready');
  assert.deepEqual(draft.resource, grant.resource);
  assert.deepEqual(draft.schedule, grant.schedule);
  assert.match(reply, /妈妈/); assert.match(reply, /08:00/); assert.match(reply, /确认/);
  assert.deepEqual(f.toolbox.assignments({ actorId: 'owner' }), []);
  assert.equal(f.executions(), 0);
  assert.doesNotMatch(JSON.stringify(f.setup.snapshotForOwner({ actorId: 'owner' })), /DO NOT READ|\/private|accountId|peerId/);
  const result = await confirm(f, draft);
  assert.equal(result.draft.status, 'applied');
  assert.equal(f.toolbox.assignments({ actorId: 'owner' })[0].revision, 1);
  assert.deepEqual(await confirm(f, draft), result);
  await confirm(f, draft, 'confirm-2');
  assert.equal(f.toolbox.assignments({ actorId: 'owner' })[0].revision, 1);
  assert.equal(f.executions(), 0);
  assert.equal(statSync(join(f.directory, 'service-setup.json')).mode & 0o777, 0o600);
});

test('multi-turn asks only missing time and zone, supports natural correction and natural explicit confirmation', async t => {
  const f = fixture(t);
  const first = await f.handle('安排妈妈每天接收 AI 日报');
  assert.deepEqual(first.draft.missing.sort(), ['time']);
  assert.doesNotMatch(first.reply, /选.*项目|几点.*称呼/);
  const second = await f.handle('每天上午8点，北京时间');
  assert.equal(second.draft.id, first.draft.id); assert.equal(second.draft.status, 'ready');
  const third = await f.handle('改到每天上午九点半');
  assert.equal(third.draft.schedule.time, '09:30'); assert.equal(third.draft.schedule.timeZone, 'Asia/Shanghai');
  assert.ok(third.draft.revision > second.draft.revision);
  await assert.rejects(() => confirm(f, second.draft), { code: 'service_draft_changed' });
  const saved = await f.handle('就这样安排');
  assert.equal(saved.draft.status, 'applied');
  assert.equal(f.toolbox.assignments({ actorId: 'owner' })[0].schedule.time, '09:30');
});

test('same-name and unknown members never silently choose another person', async t => {
  const f = fixture(t);
  const unknown = await f.handle('给外婆每天北京时间08:00发AI日报');
  assert.equal(unknown.draft.status, 'needs_input'); assert.ok(unknown.draft.missing.includes('person'));
  assert.equal(unknown.draft.personId, undefined);
  f.people.push({ id: 'mom2', label: '妈妈', role: 'elder', timeZone: 'Asia/Shanghai', createdAt: 'mom-v2' });
  const same = await f.handle('给妈妈每天北京时间08:00发AI日报');
  assert.equal(same.draft.personId, undefined); assert.equal(same.draft.choices.filter(c => c.kind === 'person').length, 2);
  const picked = await f.handle('选第二个');
  assert.equal(picked.draft.personId, 'mom2'); assert.equal(picked.draft.status, 'ready');
});

test('project and source choices are finite actual candidates with stale selection protection', async t => {
  const f = fixture(t);
  f.projects.push({ workspaceId: 'writing', title: '写作', path: '/other/private' });
  f.files.daily.push({ relativePath: 'reports/morning.md', name: 'morning.md', bytes: 30, updatedAt: now() });
  const first = await f.handle('给妈妈每天北京时间08:00发AI日报');
  assert.ok(first.draft.missing.includes('project'));
  const choice = first.draft.choices.find(c => c.kind === 'project' && c.label === '科技资讯');
  const second = await f.setup.select({ actorId: 'owner', draftId: first.draft.id, revision: first.draft.revision, choiceId: choice.id, requestId: 'pick-project' });
  assert.ok(second.draft.missing.includes('source'));
  await assert.rejects(() => f.setup.select({ actorId: 'owner', draftId: first.draft.id, revision: first.draft.revision, choiceId: choice.id, requestId: 'stale-pick' }), { code: 'service_draft_changed' });
  const third = await f.handle('选第一个');
  assert.equal(third.draft.status, 'ready');
  assert.equal(third.draft.resource.relativePath, 'reports/latest.md');
  await assert.rejects(() => f.setup.select({ actorId: 'owner', draftId: third.draft.id, revision: third.draft.revision, choiceId: 's:../../secret', requestId: 'forged' }), { code: 'service_invalid_choice' });
});

test('a named missing file does not fall back to another available source', async t => {
  const f = fixture(t);
  const first = await f.handle('给妈妈每天北京时间08:00发科技资讯项目的 absent.md AI日报');
  assert.equal(first.draft.status, 'needs_input'); assert.ok(first.draft.missing.includes('source'));
  assert.equal(first.draft.resource, undefined);
  const resolved = await f.handle('改用 latest.md');
  assert.equal(resolved.draft.status, 'ready'); assert.equal(resolved.draft.resource.relativePath, 'reports/latest.md');
  f.files.daily.length = 0;
  const changed = await confirm(f, resolved.draft);
  assert.equal(changed.draft.status, 'stale');
  assert.deepEqual(f.toolbox.assignments({ actorId: 'owner' }), []);
});

test('ambiguous, invalid or vague schedules never invent time or timezone', async t => {
  for (const request of ['每天8点', '每天早上', '每天25:00北京时间', '每天08:00 Fake/Zone', '每天早上8点或晚上9点北京时间', '每天上午8点左右北京时间']) {
    const f = fixture(t);
    const response = await f.handle(`给妈妈${request}发AI日报`);
    assert.equal(response.draft.status, 'needs_input', request);
    assert.ok(response.draft.missing.includes('time') || response.draft.missing.includes('timeZone'), request);
    assert.deepEqual(f.toolbox.assignments({ actorId: 'owner' }), []);
  }
  const f = fixture(t);
  const response = await f.handle('给妈妈每天当地时间上午八点发AI日报');
  assert.equal(response.draft.schedule.timeZone, 'Asia/Shanghai');
});

test('stop delivery preserves invocation while disabling the saved recurring schedule only after confirmation', async t => {
  const f = fixture(t); f.toolbox.assign(grant);
  const response = await f.handle('停止给妈妈每天推送AI日报');
  assert.equal(response.draft.status, 'ready'); assert.equal(response.draft.operation, 'disable');
  assert.equal(response.draft.allowInvoke, true); assert.equal(response.draft.schedule.enabled, false);
  assert.equal(f.toolbox.assignments({ actorId: 'owner' })[0].schedule.enabled, true);
  await f.handle('确认停止');
  assert.equal(f.toolbox.assignments({ actorId: 'owner' })[0].schedule.enabled, false);
});

test('weather location disambiguation selects actual ID and PPT enables only existing fixed workflow', async t => {
  const f = fixture(t); f.places.push({ id: 123, name: '北京', label: '北京，另一省', timeZone: 'Asia/Shanghai' });
  const weather = await f.handle('给妈妈启用北京天气服务');
  assert.equal(weather.draft.status, 'needs_input'); assert.ok(weather.draft.missing.includes('location'));
  const selected = await f.handle('选第一个');
  assert.deepEqual(selected.draft.resource, { city: '北京，中国', locationId: 1816670 });
  await confirm(f, selected.draft);
  const ppt = await f.handle('给爸爸开通PPT制作服务');
  assert.equal(ppt.draft.status, 'ready'); assert.deepEqual(ppt.draft.resource, { workflow: 'presentation' });
  await confirm(f, ppt.draft, 'confirm-ppt');
  assert.equal(f.toolbox.assignments({ actorId: 'owner', personId: 'dad' })[0].allowInvoke, true);
});

test('draft survives restart, and member binding, Owner role or assignment changes reject stale confirmation', async t => {
  for (const mutation of ['binding', 'assignment', 'owner', 'member']) {
    const f = fixture(t);
    const response = await f.handle('给妈妈每天北京时间08:00发AI日报');
    const restarted = createServiceSetup(f.options);
    assert.equal(restarted.snapshotForOwner({ actorId: 'owner' })[0].id, response.draft.id);
    if (mutation === 'binding') f.bindings[1].generation++;
    if (mutation === 'assignment') f.toolbox.assign({ ...grant, schedule: null });
    if (mutation === 'owner') f.people[0].role = 'elder';
    if (mutation === 'member') f.people[1].role = 'owner';
    if (mutation === 'owner') await assert.rejects(() => restarted.confirm({ actorId: 'owner', draftId: response.draft.id, revision: response.draft.revision, requestId: 'restarted-confirm' }), { code: 'service_forbidden' });
    else {
      const result = await restarted.confirm({ actorId: 'owner', draftId: response.draft.id, revision: response.draft.revision, requestId: 'restarted-confirm' });
      assert.equal(result.draft.status, 'stale', mutation);
    }
    assert.equal(JSON.parse(readFileSync(join(f.directory, 'family-toolbox.json'), 'utf8')).grants.length, mutation === 'assignment' ? 1 : 0, mutation);
  }
});

test('unrelated chat and actual PPT/project tasks stay with existing handlers; members cannot configure', async t => {
  const f = fixture(t);
  for (const request of ['今天天气怎么样', '帮妈妈做一份PPT，主题是秋游', '在科技资讯项目总结今天AI日报', '我想了解每天看AI日报有什么好处', '给妈妈提醒明早8点吃饭', '给妈妈发今天的AI日报', '乐乐支持天气服务吗']) assert.equal(await f.handle(request), null, request);
  await assert.rejects(() => f.handle('给妈妈开通PPT服务', { actorId: 'dad' }), { code: 'service_forbidden' });
});

test('drafts are private to current Owner origin and context, cancel never assigns, request conflicts reject', async t => {
  const f = fixture(t);
  const consoleDraft = await f.handle('给妈妈开通PPT服务', { requestId: 'same' });
  await assert.rejects(() => f.handle('给爸爸开通PPT服务', { requestId: 'same' }), { code: 'service_request_conflict' });
  assert.equal(await f.handle('确认开通', { origin: 'wechat' }), null);
  await assert.rejects(() => f.setup.confirm({ actorId: 'owner', draftId: consoleDraft.draft.id, revision: consoleDraft.draft.revision, requestId: 'other-origin', origin: 'wechat' }), { code: 'service_draft_context' });
  const result = await f.handle('取消这个安排'); assert.equal(result.draft.status, 'cancelled');
  assert.deepEqual(f.toolbox.assignments({ actorId: 'owner' }), []);
  assert.doesNotMatch(readFileSync(join(f.directory, 'service-setup.json'), 'utf8'), /DO NOT READ|\/private/);
});

test('negative and conditional setup language never creates the opposite configuration', async t => {
  const f = fixture(t);
  for (const text of ['不要给妈妈开通天气服务', '先别给爸爸开通PPT制作服务', '如果妈妈需要，就给妈妈开通PPT服务', '考虑以后给妈妈每天北京时间08:00发AI日报']) {
    const result = await f.handle(text);
    assert.notEqual(result?.draft?.status, 'ready', text);
    assert.equal(f.setup.snapshotForOwner({ actorId: 'owner' }).length, 0, text);
  }
  assert.deepEqual(f.toolbox.assignments({ actorId: 'owner' }), []);
});

test('an explicitly named unknown project never falls back to the only available project', async t => {
  const f = fixture(t);
  const result = await f.handle('从不存在的资料项目给妈妈每天北京时间08:00发AI日报');
  assert.equal(result.draft.status, 'needs_input'); assert.ok(result.draft.missing.includes('project'));
  assert.equal(result.draft.resource, undefined);
  const ready = await f.handle('选第一个'); assert.equal(ready.draft.status, 'ready');
  const changed = await f.handle('改用别的未知项目');
  assert.equal(changed.draft.status, 'needs_input'); assert.ok(changed.draft.missing.includes('project'));
});

test('weather time corrections preserve the already chosen real city', async t => {
  const f = fixture(t, { weatherSearch: async ({ query }) => query === '北京' ? [{ id: 1816670, label: '北京，中国', timeZone: 'Asia/Shanghai' }] : [] });
  const first = await f.handle('给妈妈每天北京时间08:00推送北京天气');
  assert.equal(first.draft.status, 'ready');
  const updated = await f.handle('改到每天上午九点半');
  assert.equal(updated.draft.status, 'ready'); assert.equal(updated.draft.schedule.time, '09:30');
  assert.deepEqual(updated.draft.resource, first.draft.resource);
});

test('persisted unknown fields, inconsistent resources and ungrounded schedule edits fail closed on restart', async t => {
  for (const mutate of [draft => { draft.hiddenContent = 'DO NOT READ'; }, draft => { draft.resource.relativePath = 'other.md'; }, draft => { draft.schedule.time = '07:00'; }, draft => { draft.time = '07:00'; draft.schedule.time = '07:00'; }, draft => { draft.resource.workspaceId = 'unregistered'; }, draft => { draft.sourceSelection.bytes = -1; }]) {
    const f = fixture(t); await f.handle('给妈妈每天北京时间08:00发AI日报');
    const file = join(f.directory, 'service-setup.json'), data = JSON.parse(readFileSync(file, 'utf8'));
    mutate(data.drafts[0]);
    const { writeFileSync } = await import('node:fs'); writeFileSync(file, JSON.stringify(data));
    assert.throws(() => createServiceSetup(f.options), { code: 'service_invalid_state' });
    assert.deepEqual(f.toolbox.assignments({ actorId: 'owner' }), []);
  }
});

test('discovery failure and assignment refusal remain truthful and never invoke a tool', async t => {
  const f = fixture(t, { listProjects: async () => { throw Error('secret source https://private'); } });
  const unavailable = await f.handle('给妈妈每天北京时间08:00发AI日报');
  assert.equal(unavailable.draft.status, 'needs_input'); assert.doesNotMatch(unavailable.reply, /secret|https/);
  const g = fixture(t);
  const ready = await g.handle('给妈妈每天北京时间08:00发AI日报');
  // The existing toolbox is frozen. Wrap only its assignment endpoint to exercise a real refusal.
  const refusing = createServiceSetup({ ...g.options, toolbox: { assignments: args => g.toolbox.assignments(args), assign: () => { throw Error('private credentials'); } } });
  const result = await refusing.confirm({ actorId: 'owner', draftId: ready.draft.id, revision: ready.draft.revision, requestId: 'refused' });
  assert.equal(result.draft.status, 'stale'); assert.doesNotMatch(result.reply, /已保存|private|credentials/);
  assert.equal(g.executions(), 0);
});

test('known member timezone is displayed as recorded context and only a real missing or conflicting timezone is asked', async t => {
  const f = fixture(t);
  const known = await f.handle('给妈妈每天早上八点推送AI日报');
  assert.equal(known.draft.status, 'ready'); assert.equal(known.draft.schedule.timeZone, 'Asia/Shanghai');
  assert.match(known.reply, /妈妈当地时间/);
  const explicit = await f.handle('时区改成America/Mexico_City');
  assert.equal(explicit.draft.schedule.timeZone, 'America/Mexico_City');
  const conflict = await f.handle('北京时间和America/Mexico_City时间');
  assert.equal(conflict.draft.status, 'needs_input'); assert.ok(conflict.draft.missing.includes('timeZone'));
  const g = fixture(t); delete g.people[1].timeZone;
  const missing = await g.handle('给妈妈每天早上八点推送AI日报');
  assert.equal(missing.draft.status, 'needs_input'); assert.ok(missing.draft.missing.includes('timeZone'));
});

test('negative send language only drafts a stop and repeated confirmations recheck current scope', async t => {
  const f = fixture(t); f.toolbox.assign(grant);
  const stop = await f.handle('别给妈妈每天北京时间08:00发AI日报');
  assert.equal(stop.draft.operation, 'disable'); assert.equal(stop.draft.schedule.enabled, false);
  const saved = await confirm(f, stop.draft);
  assert.equal(saved.draft.status, 'applied');
  f.bindings[1].generation++;
  const replay = await confirm(f, stop.draft);
  assert.equal(replay.draft.status, 'stale'); assert.doesNotMatch(replay.reply, /已保存/);
});

test('service errors use finite Chinese copy and never echo untrusted details', async () => {
  const { serviceSetupErrorText } = await import('../src/service-setup.mjs');
  assert.match(serviceSetupErrorText({ code: 'service_draft_changed' }), /变化|更新|过期/);
  assert.match(serviceSetupErrorText({ code: 'service_invalid_state' }), /保留|记录/);
  assert.doesNotMatch(serviceSetupErrorText(new Error('secret https://credentials')), /secret|https|credentials/);
});

test('helper self-reference does not add Owner as a recipient, while explicit multiple recipients stay ambiguous', async t => {
  const f = fixture(t); f.people[0].label = '我';
  const one = await f.handle('帮我给妈妈每天早上八点发AI日报');
  assert.equal(one.draft.status, 'ready'); assert.equal(one.draft.personId, 'mom');
  const many = await f.handle('给我和妈妈每天早上八点发AI日报');
  assert.equal(many.draft.status, 'needs_input'); assert.ok(many.draft.missing.includes('person'));
});

test('unsupported recurrence cannot silently become on-demand or preserve an older daily plan', async t => {
  const f = fixture(t);
  const first = await f.handle('给妈妈开通每周AI日报服务');
  assert.equal(first.draft.status, 'needs_input'); assert.ok(first.draft.missing.includes('repeat'));
  const dailyPlan = await f.handle('改成每天上午八点'); assert.equal(dailyPlan.draft.status, 'ready');
  const weekly = await f.handle('改为每周一上午八点');
  assert.equal(weekly.draft.status, 'needs_input'); assert.ok(weekly.draft.missing.includes('repeat'));
  const noSave = await f.handle('确认开通'); assert.equal(noSave.draft.status, 'needs_input');
  assert.deepEqual(f.toolbox.assignments({ actorId: 'owner' }), []);
});

test('unrelated chat never writes the setup journal, and replay returns current cancelled or rebound draft', async t => {
  const f = fixture(t), file = join(f.directory, 'service-setup.json');
  const before = readFileSync(file, 'utf8'), modified = statSync(file).mtimeMs;
  assert.equal(await f.handle('普通聊天'), null);
  assert.equal(readFileSync(file, 'utf8'), before); assert.equal(statSync(file).mtimeMs, modified);
  const first = await f.handle('给妈妈开通PPT服务', { requestId: 'original' });
  await f.handle('取消这个安排');
  const replay = await f.handle('给妈妈开通PPT服务', { requestId: 'original' });
  assert.equal(replay.draft.status, 'cancelled'); assert.equal(replay.draft.id, first.draft.id);
  const pending = await f.handle('给妈妈每天发AI日报', { requestId: 'pending' });
  assert.equal(pending.draft.status, 'needs_input');
  f.bindings[1].generation++;
  const rebound = await f.handle('给妈妈每天发AI日报', { requestId: 'pending' });
  assert.equal(rebound.draft.status, 'stale');
});

test('assignment preflight failure and partial save use accurate separate non-actionable results', async t => {
  for (const partial of [false, true]) {
    const f = fixture(t);
    const ready = await f.handle('给妈妈开通PPT服务');
    const toolbox = { assignments: args => f.toolbox.assignments(args), assign: args => { if (partial) f.toolbox.assign(args); throw Object.assign(new Error('DO NOT READ secret'), { code: partial ? 'unexpected' : 'service_presentation_unavailable' }); } };
    const setup = createServiceSetup({ ...f.options, toolbox });
    const result = await setup.confirm({ actorId: 'owner', draftId: ready.draft.id, revision: ready.draft.revision, requestId: 'apply' });
    assert.equal(result.draft.status, 'stale'); assert.match(result.reply, partial ? /结果待核对/ : /PPT.*尚未接通/);
    assert.doesNotMatch(result.reply, /DO NOT READ|secret|对象、授权或资料已有变化/);
    assert.equal(f.toolbox.assignments({ actorId: 'owner' }).length, partial ? 1 : 0);
    await setup.confirm({ actorId: 'owner', draftId: ready.draft.id, revision: ready.draft.revision, requestId: 'apply-again' });
    assert.equal(f.toolbox.assignments({ actorId: 'owner' }).length, partial ? 1 : 0);
  }
});

test('duplicate project titles and weather labels expose safe actual IDs for a meaningful choice', async t => {
  const f = fixture(t); f.projects.push({ workspaceId: 'daily2', title: '科技资讯' });
  const project = await f.handle('给妈妈每天早上八点发AI日报');
  const projectLabels = project.draft.choices.filter(row => row.kind === 'project').map(row => row.label);
  assert.equal(new Set(projectLabels).size, 2); assert.ok(projectLabels.every(label => /daily/.test(label)));
  const g = fixture(t); g.places.push({ ...g.places[0], id: 123 });
  const weather = await g.handle('给妈妈开通北京天气服务');
  const labels = weather.draft.choices.filter(row => row.kind === 'location').map(row => row.label);
  assert.equal(new Set(labels).size, 2);
});

test('offline executors are disclosed and saved setup copy never claims delivery or an invocation', async t => {
  const f = fixture(t);
  const ready = await f.handle('给妈妈开通PPT服务');
  assert.match(ready.reply, /尚未接通/);
  const saved = await confirm(f, ready.draft);
  assert.match(saved.reply, /已保存配置/); assert.match(saved.reply, /尚未接通/);
  assert.doesNotMatch(saved.reply, /已执行|已发送|已送达/);
});

test('interrupted assignment recovery remains uncertain and never repeats a possibly partial save', async t => {
  const f = fixture(t);
  const ready = await f.handle('给妈妈每天早上八点发AI日报');
  const file = join(f.directory, 'service-setup.json'), data = JSON.parse(readFileSync(file, 'utf8'));
  data.drafts[0].status = 'applying';
  const { writeFileSync } = await import('node:fs'); writeFileSync(file, JSON.stringify(data));
  f.toolbox.assign(grant);
  const restarted = createServiceSetup(f.options), recovered = restarted.snapshotForOwner({ actorId: 'owner' })[0];
  assert.equal(recovered.status, 'stale'); assert.match(recovered.summary, /结果待核对/);
  const result = await restarted.confirm({ actorId: 'owner', draftId: ready.draft.id, revision: ready.draft.revision, requestId: 'after-interruption' });
  assert.match(result.reply, /结果待核对/);
  assert.equal(f.toolbox.assignments({ actorId: 'owner' })[0].revision, 1);
});

test('polite questions with concrete delegation draft safely while capability discussions stay with chat', async t => {
  for (const text of ['能不能给妈妈每天早上八点发AI日报？', '可不可以给妈妈开通PPT服务？', '能否给爸爸每天北京时间08:00推送AI日报？']) {
    const f = fixture(t), result = await f.handle(text);
    assert.equal(result.draft.status, 'ready', text);
    assert.deepEqual(f.toolbox.assignments({ actorId: 'owner' }), []);
  }
  const f = fixture(t);
  for (const text of ['乐乐支持天气服务吗', '怎么配置AI日报', '每天看AI日报有什么好处', '我想知道能不能给妈妈开通PPT服务']) assert.equal(await f.handle(text), null, text);
});

test('existing Codex AI digest is discovered before asking for a missing daily clock', async t => {
  const f = fixture(t);
  f.projects.push({ workspaceId: 'work', title: '其他工作' });
  f.files.daily = [{ relativePath: 'output/ai-digest/2026-10-25.md', bytes: 100, updatedAt: now() }, { relativePath: 'output/ai-digest/2026-10-25-wechat.txt', bytes: 90, updatedAt: now() }];
  const first = await f.handle('给妈妈每天早上发我之前通过codex本机搞的AI日报');
  assert.deepEqual(first.draft.missing, ['time']);
  assert.equal(first.draft.resource.relativePath, 'output/ai-digest/2026-10-25-wechat.txt');
  assert.match(first.reply, /找到/); assert.doesNotMatch(first.reply, /选.*项目/);
  const followup = await f.handle('你可以自己去搜索去找吗');
  assert.equal(followup.draft.id, first.draft.id); assert.equal(followup.draft.personId, 'mom');
  assert.match(followup.reply, /找到/); assert.doesNotMatch(followup.reply, /不能|无法访问/);
  assert.deepEqual(f.toolbox.assignments({ actorId: 'owner' }), []);
});

test('explicit immediate test returns one finite delivery proposal while recurring setup stays pending', async t => {
  const f = fixture(t);
  f.files.daily = [{ relativePath: 'output/ai-digest/2026-10-25-wechat.txt', bytes: 90, updatedAt: now() }];
  const initial = await f.handle('给妈妈每天早上发我之前通过codex本机搞的AI日报');
  const text = '没事儿，我们第一轮测试，你先找到，然后你先直接立马给他推送一下看看';
  const result = await f.handle(text, { requestId: 'once-now' });
  assert.equal(result.draft.id, initial.draft.id); assert.deepEqual(result.draft.missing, ['time']);
  assert.deepEqual(result.deliveryProposal, { kind: 'ai_digest_once', draftId: result.draft.id, revision: result.draft.revision, personId: 'mom', resource: result.draft.resource, source: { bytes: 90, updatedAt: now() }, authorization: 'explicit_now', expectedRoute: { personId: 'mom', accountId: 'a-mom', peerId: 'p-mom', generation: 1 }, ownerRoute: { personId: 'owner', accountId: 'a-owner', peerId: 'p-owner', generation: 1 } });
  assert.deepEqual(await f.handle(text, { requestId: 'once-now' }), result);
  assert.equal(f.executions(), 0); assert.deepEqual(f.toolbox.assignments({ actorId: 'owner' }), []);
  assert.doesNotMatch(result.reply, /已发送|已送达|已开通/);
  const restarted = createServiceSetup(f.options);
  assert.equal(restarted.snapshotForOwner({ actorId: 'owner' })[0].schedule, null);
});

test('immediate delivery continuations require an active same-context draft and current unambiguous source', async t => {
  const f = fixture(t);
  f.files.daily = [{ relativePath: 'output/ai-digest/2026-10-25-wechat.txt', bytes: 90, updatedAt: now() }];
  assert.equal(await f.handle('你自己去搜索一下'), null);
  await f.handle('给妈妈每天早上发AI日报');
  assert.equal(await f.handle('现在直接发一次', { origin: 'wechat' }), null);
  for (const text of ['先别现在发一次', '如果现在发一次会怎么样', '你可以现在发吗', '我想知道现在发一次会怎么样', '请模拟现在发送一次', '例如现在给他发一次']) {
    assert.equal((await f.handle(text))?.deliveryProposal, undefined, text);
  }
  f.bindings[1].generation++;
  const stale = await f.handle('现在直接发一次');
  assert.equal(stale.draft.status, 'stale'); assert.equal(stale.deliveryProposal, undefined);
});

test('same-source metadata changes invalidate a cached immediate proposal instead of silently rereading', async t => {
  const f = fixture(t);
  f.files.daily = [{ relativePath: 'output/ai-digest/2026-10-25-wechat.txt', bytes: 90, updatedAt: now() }];
  await f.handle('给妈妈每天早上发AI日报');
  const text = '现在直接发一次';
  const proposed = await f.handle(text, { requestId: 'once' });
  assert.ok(proposed.deliveryProposal);
  f.files.daily[0].bytes++;
  const replay = await f.handle(text, { requestId: 'once' });
  assert.equal(replay.draft.status, 'stale'); assert.equal(replay.deliveryProposal, undefined);
  assert.deepEqual(f.toolbox.assignments({ actorId: 'owner' }), []);
});

test('metadata discovery preserves exact route across awaits and never exposes it in public drafts', async t => {
  const f = fixture(t);
  f.files.daily = [{ relativePath: 'output/ai-digest/2026-10-25-wechat.txt', bytes: 90, updatedAt: now() }];
  await f.handle('给妈妈每天早上发AI日报');
  let mutate = true;
  const setup = createServiceSetup({ ...f.options, digestSources: async () => { if (mutate) { mutate = false; f.bindings[1].generation++; } return structuredClone(f.files.daily); } });
  const result = await setup.handle({ actorId: 'owner', text: '现在直接发一次', requestId: 'during-discovery' });
  assert.equal(result.draft.status, 'stale'); assert.equal(result.deliveryProposal, undefined);
  assert.doesNotMatch(JSON.stringify(setup.snapshotForOwner({ actorId: 'owner' })), /accountId|peerId|expectedRoute|ownerRoute/);
});

test('clearly matching source choices span registered projects without exposing unrelated workspace choices', async t => {
  const f = fixture(t);
  f.projects.push({ workspaceId: 'other', title: '另一份 AI 日报' });
  f.files.daily = [{ relativePath: 'output/ai-digest/2026-10-25-wechat.txt', bytes: 90, updatedAt: now() }];
  f.files.other = [{ relativePath: 'output/ai-digest/2026-10-25-wechat.txt', bytes: 80, updatedAt: now() }];
  const first = await f.handle('给妈妈每天早上发AI日报');
  assert.ok(first.draft.missing.includes('source')); assert.ok(!first.draft.missing.includes('project'));
  assert.equal(first.draft.choices.length, 2); assert.ok(first.draft.choices.every(row => row.kind === 'source'));
  const selected = await f.handle('选第二个');
  assert.equal(selected.draft.resource.workspaceId, 'other'); assert.deepEqual(selected.draft.missing, ['time']);
});

test('existing local digest intent never selects an unrelated or stale singleton file', async t => {
  for (const relativePath of ['notes/meeting.md', 'output/ai-digest/2026-10-24-wechat.txt']) {
    const f = fixture(t);
    f.files.daily = [{ relativePath, bytes: 90, updatedAt: now() }];
    const result = await f.handle('给妈妈每天早上发我之前通过codex本机搞的AI日报');
    assert.equal(result.draft.resource, undefined, relativePath);
    assert.ok(result.draft.missing.includes('source'));
    assert.equal((await f.handle('现在直接发一次')).deliveryProposal, undefined);
  }
});

test('discovered files remain readable when an unfiltered project listing is capped before the digest folder', async t => {
  const file = { relativePath: 'output/ai-digest/2026-10-25-wechat.txt', bytes: 90, updatedAt: now() };
  const generic = Array.from({ length: 200 }, (_, index) => ({ relativePath: `docs/note-${index}.md`, bytes: 10, updatedAt: now() }));
  const f = fixture(t, { digestSources: async ({ query }) => query ? [file] : generic });
  f.projects.push({ workspaceId: 'other', title: '其他' });
  // Only the first registered workspace contains the real report.
  f.options.digestSources = async ({ query, workspaceId }) => workspaceId !== 'daily' ? [] : query ? [file] : generic;
  const setup = createServiceSetup(f.options);
  const first = await setup.handle({ actorId: 'owner', text: '给妈妈每天早上发之前本机的AI日报', requestId: 'find' });
  assert.equal(first.draft.resource?.relativePath, file.relativePath);
  const result = await setup.handle({ actorId: 'owner', text: '现在直接发一次', requestId: 'now' });
  assert.equal(result.deliveryProposal?.resource.relativePath, file.relativePath);
});

test('an immediate continuation cannot silently inherit a recipient or payload different from the digest draft', async t => {
  const f = fixture(t);
  f.files.daily = [{ relativePath: 'output/ai-digest/2026-10-25-wechat.txt', bytes: 90, updatedAt: now() }];
  const initial = await f.handle('给妈妈每天早上发之前本机的AI日报');
  for (const text of ['现在发给小李看看', '现在给小李发一次', '现在发到群里看看', '现在给他发天气', '现在给他发这段话：今晚早点睡', '现在给他发一首诗', '现在把一首诗发给他', '现在一首诗发给他', '现在把上面那张照片发给他', '现在把昨天的AI日报发给他', '现在用明天的日报给他推送一下', '现在把2026-10-24的AI日报发给他', '现在把10月24日的AI日报发给他']) {
    const result = await f.handle(text);
    assert.equal(result?.deliveryProposal, undefined, text);
    assert.equal(f.setup.snapshotForOwner({ actorId: 'owner' }).find(row => row.id === initial.draft.id).personId, 'mom');
  }
  assert.ok((await f.handle('现在给他推送一下看看')).deliveryProposal);
  assert.ok((await f.handle('现在把这份AI日报发给他')).deliveryProposal);
  assert.ok((await f.handle('现在把2026-10-25的AI日报发给他')).deliveryProposal);
});

test('a confirmed daily digest follows the latest generated report in the source zone while one-off remains exact', async t => {
  const f=fixture(t);
  f.files.daily=[{relativePath:'output/ai-digest/2026-10-25-wechat.txt',bytes:90,updatedAt:now()}];
  const ready=await f.handle('给妈妈每天北京时间早上八点发之前本机的AI日报');
  assert.deepEqual(ready.draft.resource,{workspaceId:'daily',relativePath:'output/ai-digest/2026-10-25-wechat.txt',selection:'latest',sourceTimeZone:'America/Mexico_City'});
  assert.match(ready.reply,/最新|当天/);assert.match(ready.reply,/America\/Mexico_City/);assert.match(ready.reply,/不.*(?:旧|过期)/);
  assert.deepEqual(f.toolbox.assignments({actorId:'owner'}),[]);
  const once=await f.handle('现在发一次');
  assert.deepEqual(once.deliveryProposal.resource,{workspaceId:'daily',relativePath:'output/ai-digest/2026-10-25-wechat.txt'});
  await f.handle('确认开通');
  assert.equal(f.toolbox.assignments({actorId:'owner'})[0].resource.selection,'latest');
});

test('source date follows Mexico even while the recipient is already on the next calendar day', async t => {
  const f=fixture(t,{now:()=> '2026-10-26T01:00:00.000Z'});
  f.files.daily=[{relativePath:'output/ai-digest/2026-10-25-wechat.txt',bytes:90,updatedAt:'2026-10-25T12:00:00.000Z'}];
  f.projects.push({workspaceId:'other',title:'其他'});
  const result=await f.handle('给妈妈每天北京时间08:00发之前本机的AI日报');
  assert.equal(result.draft.status,'ready');assert.equal(result.draft.resource.sourceTimeZone,'America/Mexico_City');
  assert.equal(result.draft.schedule.timeZone,'Asia/Shanghai');
  const saved=await f.handle('确认开通');assert.equal(saved.draft.status,'applied');
});

test('explicit source-zone correction stays separate from delivery time and an explicit fixed-source choice stays fixed', async t => {
  const f=fixture(t);
  f.files.daily=[{relativePath:'output/ai-digest/2026-10-25-wechat.txt',bytes:90,updatedAt:now()}];
  const ready=await f.handle('给妈妈每天北京时间08:00发AI日报，日报日期按America/Mexico_City');
  assert.equal(ready.draft.status,'ready');assert.equal(ready.draft.schedule.timeZone,'Asia/Shanghai');
  assert.equal(ready.draft.resource.sourceTimeZone,'America/Mexico_City');
  const fixed=await f.handle('改成只发这一份固定文件');
  assert.deepEqual(fixed.draft.resource,{workspaceId:'daily',relativePath:'output/ai-digest/2026-10-25-wechat.txt'});
  assert.doesNotMatch(fixed.reply,/最新已生成/);
});

test('real preview11 fixed daily ledgers remain fixed and preserve ready or applied state on upgrade', async t => {
  const gitOptions={cwd:fileURLToPath(new URL('../',import.meta.url)),encoding:'utf8',stdio:['ignore','pipe','ignore']};
  let legacySource;
  try{
    // HEAD is preview11 during the upgrade; after a new commit retain the same
    // real old module from history instead of accidentally testing current code.
    const refs=execFileSync('git',['log','-20','--format=%H','--','src/service-setup.mjs'],gitOptions).trim().split('\n');
    for(const ref of refs){const source=execFileSync('git',['show',`${ref}:src/service-setup.mjs`],gitOptions);if(source.includes('deliveryProposal')&&!source.includes('function digestResourceForDraft')){legacySource=source;break;}}
  }catch{}
  if(!legacySource){t.skip('preview11 source history is unavailable in this checkout');return;}
  for(const applied of [false,true]){
    const f=fixture(t);f.files.daily=[{relativePath:'output/ai-digest/2026-10-25-wechat.txt',bytes:90,updatedAt:now()}];
    const legacyModule=join(f.directory,'preview11-service.mjs');
    writeFileSync(legacyModule,legacySource.replaceAll("'./digest-discovery.mjs'",JSON.stringify(new URL('../src/digest-discovery.mjs',import.meta.url).href)));
    const {createServiceSetup:createLegacy}=await import(pathToFileURL(legacyModule).href);
    const legacy=createLegacy(f.options);
    let old=await legacy.handle({actorId:'owner',text:'给妈妈每天北京时间08:00发之前本机的AI日报',requestId:'legacy-ready'});
    assert.equal(old.draft.resource.selection,undefined);assert.equal(old.draft.status,'ready');
    if(applied)old=await legacy.confirm({actorId:'owner',draftId:old.draft.id,revision:old.draft.revision,requestId:'legacy-confirm'});
    const file=join(f.directory,'service-setup.json'),before=JSON.parse(readFileSync(file,'utf8')),grants=f.toolbox.assignments({actorId:'owner'});
    assert.equal(before.drafts[0].digestFound,true);assert.equal(before.drafts[0].schedule.enabled,true);assert.equal(before.drafts[0].digestFixed,undefined);
    const upgraded=createServiceSetup(f.options),draft=upgraded.snapshotForOwner({actorId:'owner'})[0];
    assert.equal(draft.status,applied?'applied':'ready');assert.deepEqual(draft.resource,old.draft.resource);assert.equal(draft.revision,old.draft.revision);
    assert.deepEqual(f.toolbox.assignments({actorId:'owner'}),grants);
    const migrated=JSON.parse(readFileSync(file,'utf8'));assert.equal(migrated.drafts[0].digestFixed,true);assert.deepEqual(migrated.requests,before.requests);
    if(!applied){const changed=await upgraded.handle({actorId:'owner',text:'改到每天上午九点',requestId:'legacy-clock'});assert.equal(changed.draft.resource.selection,undefined);}
    else{const replay=await upgraded.confirm({actorId:'owner',draftId:draft.id,revision:draft.revision,requestId:'legacy-confirm-replay'});assert.equal(replay.draft.status,'applied');assert.deepEqual(f.toolbox.assignments({actorId:'owner'}),grants);}
    const restarted=createServiceSetup(f.options);assert.equal(restarted.snapshotForOwner({actorId:'owner'})[0].resource.selection,undefined);
  }
});
