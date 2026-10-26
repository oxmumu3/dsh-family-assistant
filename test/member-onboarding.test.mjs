import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { createFamilyToolbox } from '../src/family-toolbox.mjs';
import { createFamilyAccess } from '../src/family-access.mjs';

const { createMemberOnboarding } = await import('../src/member-onboarding.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const now = () => '2026-10-25T10:00:00.000Z';
const firstIdentity = { accountId: 'synthetic-account', peerId: 'synthetic-peer' };

function fixture(t, { bound = false, executors = {}, projectExecutorAvailable = false, ppt = false } = {}) {
  assert.equal(typeof createMemberOnboarding, 'function', 'member onboarding module must be available');
  const directory = mkdtempSync(join(tmpdir(), 'member-onboarding-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createStore({ directory, now });
  store.addPerson({ id: 'owner', role: 'owner', label: '合成管理人', notes: 'OWNER_PRIVATE_CONTEXT' });
  store.addPerson({ id: 'member', role: 'elder', label: '合成成员', notes: 'PREVIOUS_PRIVATE_NOTES' });
  store.addPerson({ id: 'other', role: 'elder', label: '另一个人', notes: 'OTHER_PRIVATE_CONTEXT' });
  if (bound) store.bindPerson('member', firstIdentity);
  const toolbox = createFamilyToolbox({ directory, store, executors, now });
  const access = createFamilyAccess({ directory, store, now });
  const services = { available: ppt, people: [{ personId: 'member', enabled: ppt }], tasks: [] };
  const presentations = { snapshot: () => structuredClone(services) };
  const options = { directory, store, toolbox, access, presentations, now, projectExecutorAvailable };
  return { directory, store, toolbox, access, services, options, onboarding: createMemberOnboarding(options) };
}

function bind(f, identity = firstIdentity, newBinding = true) {
  f.store.bindPerson('member', identity);
  return f.onboarding.markBound('member', identity, { newBinding });
}

test('first-ever binding admits one welcome addressed only to its captured route', t => {
  const f = fixture(t);
  assert.equal(bind(f).eligible, true);
  const welcome = f.onboarding.admit('member');
  assert.equal(welcome.kind, 'member_welcome');
  assert.equal(welcome.personId, 'member');
  assert.deepEqual(welcome.route, f.store.route('member'));
  assert.deepEqual(welcome.authorizationRoute, welcome.route);
  assert.match(welcome.sourceKey, /^member-welcome:v1:member:[a-f0-9]{64}$/u);
  assert.match(welcome.text, /我是乐乐/u);
  assert.match(welcome.text, /你能帮我做什么/u);
  assert.ok(Array.from(welcome.text).length <= 200, 'first welcome stays short; detailed help remains available on request');
  assert.ok(welcome.text.split('\n').filter(line => line.startsWith('“')).length <= 3);
  assert.equal(f.store.snapshot().outbox.length, 0, 'module must not own delivery');
  assert.deepEqual(f.onboarding.admit('member'), welcome, 'repeat admission has same route and key');
});

test('short welcome leads with an actually granted canonical tool example plus notes and reminder examples', t => {
  const f = fixture(t, { executors: { ai_digest: () => 'synthetic digest', weather: () => 'synthetic weather' } });
  f.toolbox.assign({ actorId: 'owner', personId: 'member', toolId: 'ai_digest', resource: { workspaceId: 'synthetic-source', relativePath: 'digest.md' }, allowInvoke: true });
  f.toolbox.assign({ actorId: 'owner', personId: 'other', toolId: 'weather', resource: { city: 'OTHER_CITY_PRIVATE' }, allowInvoke: true });
  bind(f);
  const welcome = f.onboarding.admit('member');
  const examples = welcome.text.split('\n').filter(line => line.startsWith('“'));
  assert.equal(examples.length, 3);
  assert.equal(examples[0], '“AI 日报”');
  assert.match(examples[1], /记住/u);
  assert.match(examples[2], /提醒我/u);
  assert.ok(Array.from(welcome.text).length <= 200);
  assert.doesNotMatch(welcome.text, /天气|PPT|OTHER_CITY_PRIVATE|synthetic-source/u);
  assert.ok(f.onboarding.describe('member').text.length > welcome.text.length, 'self-query retains the detailed capability explanation');
});

test('welcome matching stays pure and rejects queued copy after its advertised tool is revoked', t => {
  const f = fixture(t, { executors: { ai_digest: () => 'synthetic digest' } });
  const grant = { actorId: 'owner', personId: 'member', toolId: 'ai_digest', resource: { workspaceId: 'synthetic-source', relativePath: 'digest.md' }, allowInvoke: true };
  f.toolbox.assign(grant); bind(f);
  const welcome = f.onboarding.admit('member');
  assert.equal(typeof f.onboarding.matchesWelcome, 'function');
  const before = readFileSync(join(f.directory, 'member-onboarding.json'), 'utf8');
  assert.equal(f.onboarding.matchesWelcome({ personId: 'member', text: welcome.text }), true);
  f.toolbox.assign({ ...grant, allowInvoke: false });
  assert.equal(f.onboarding.matchesWelcome({ personId: 'member', text: welcome.text }), false);
  assert.equal(readFileSync(join(f.directory, 'member-onboarding.json'), 'utf8'), before);
});

test('unchanged base welcome copy matches while malformed or unknown checks fail closed', t => {
  const f = fixture(t); bind(f);
  const welcome = f.onboarding.admit('member');
  assert.equal(typeof f.onboarding.matchesWelcome, 'function');
  assert.equal(f.onboarding.matchesWelcome({ personId: 'member', text: welcome.text }), true);
  assert.equal(f.onboarding.matchesWelcome({ personId: 'member', text: welcome.text + 'changed' }), false);
  assert.equal(f.onboarding.matchesWelcome({ personId: 'missing', text: welcome.text }), false);
  assert.equal(f.onboarding.matchesWelcome({ personId: 'member', text: welcome.text, extra: true }), false);
});

test('existing bindings form a durable upgrade baseline and reconnects do not get welcomed', t => {
  const f = fixture(t, { bound: true });
  assert.equal(f.onboarding.markBound('member', firstIdentity).eligible, false);
  assert.equal(f.onboarding.admit('member'), null);
  f.onboarding = createMemberOnboarding(f.options);
  assert.equal(bind(f, firstIdentity, false).eligible, false);
  assert.equal(f.onboarding.admit('member'), null);
  assert.deepEqual(f.store.snapshot().messages, []);
});

test('first binding admission survives restart before enqueue with the same route and source key', t => {
  const f = fixture(t); bind(f);
  const before = f.onboarding.admit('member');
  f.onboarding = createMemberOnboarding(f.options);
  assert.deepEqual(f.onboarding.admit('member'), before);
  assert.equal(statSync(join(f.directory, 'member-onboarding.json')).mode & 0o777, 0o600);
});

test('crash after enqueue is reconciled without a second admission or second outbox record', t => {
  const f = fixture(t); bind(f);
  const welcome = f.onboarding.admit('member');
  const { route, ...payload } = welcome;
  f.store.enqueue(payload);
  f.onboarding = createMemberOnboarding(f.options);
  assert.equal(f.onboarding.admit('member'), null);
  assert.equal(bind(f, firstIdentity, false).eligible, false);
  assert.equal(f.store.snapshot().outbox.length, 1);
});

test('explicit enqueue acknowledgement requires the actual matching durable outbox record', t => {
  const f = fixture(t); bind(f);
  const welcome = f.onboarding.admit('member');
  assert.throws(() => f.onboarding.markEnqueued({ personId: 'member', sourceKey: welcome.sourceKey, outboxId: 'made-up' }), { code: 'INVALID_ARGUMENT' });
  const { route, ...payload } = welcome;
  const outbox = f.store.enqueue(payload);
  f.onboarding.markEnqueued({ personId: 'member', sourceKey: welcome.sourceKey, outboxId: outbox.id });
  assert.equal(f.onboarding.admit('member'), null);
  f.onboarding = createMemberOnboarding(f.options);
  assert.equal(f.onboarding.admit('member'), null);
});

test('uncertain delivery is never admitted again after restart or reconnect', t => {
  const f = fixture(t); bind(f);
  const { route, ...payload } = f.onboarding.admit('member');
  const outbox = f.store.enqueue(payload);
  f.store.configure({ paused: false });
  f.store.transition(outbox.id, 'dispatching');
  f.store.transition(outbox.id, 'uncertain', '合成结果未知');
  f.onboarding = createMemberOnboarding(f.options);
  assert.equal(f.onboarding.admit('member'), null);
  assert.equal(bind(f, firstIdentity, false).eligible, false);
  assert.equal(f.store.snapshot().outbox[0].status, 'uncertain');
});

test('rebinding before enqueue suppresses the original route and does not welcome the replacement identity', t => {
  const f = fixture(t); bind(f);
  const captured = f.onboarding.admit('member');
  const replacement = { accountId: 'replacement-account', peerId: 'replacement-peer' };
  f.store.bindPerson('member', replacement);
  assert.equal(f.onboarding.markBound('member', replacement, { newBinding: false }).eligible, false);
  assert.equal(f.onboarding.admit('member'), null);
  f.onboarding = createMemberOnboarding(f.options);
  assert.equal(f.onboarding.admit('member'), null);
  assert.notDeepEqual(captured.route, f.store.route('member'));
  assert.doesNotMatch(f.onboarding.describe('member').text, /PREVIOUS_PRIVATE_NOTES|已经记住|继续使用你以前/u);
});

test('binding identity mismatch and stale generation fail closed without creating an eligible welcome', t => {
  const f = fixture(t);
  f.store.bindPerson('member', firstIdentity);
  assert.throws(() => f.onboarding.markBound('member', { ...firstIdentity, peerId: 'wrong-peer' }, { newBinding: true }), { code: 'INVALID_ARGUMENT' });
  f.store.bindPerson('member', { accountId: 'new-account', peerId: 'new-peer' });
  assert.equal(f.onboarding.markBound('member', { accountId: 'new-account', peerId: 'new-peer' }, { newBinding: true }).eligible, false);
  assert.equal(f.onboarding.admit('member'), null);
});

test('base help describes personal notes and own arrangement controls without inventing tools', t => {
  const f = fixture(t);
  const before = readFileSync(join(f.directory, 'member-onboarding.json'), 'utf8');
  const help = f.onboarding.describe('member');
  assert.match(help.text, /记事/u);
  assert.match(help.text, /查看.*自己的.*日程.*提醒/u);
  assert.match(help.text, /修改.*取消/u);
  assert.doesNotMatch(help.text, /修改.*定时安排/u);
  assert.deepEqual(help.tools, []);
  assert.equal(help.projects.available, false);
  assert.doesNotMatch(help.text, /AI 日报|天气|PPT|已读|已核对|OWNER_PRIVATE_CONTEXT|OTHER_PRIVATE_CONTEXT|PREVIOUS_PRIVATE_NOTES/u);
  assert.equal(readFileSync(join(f.directory, 'member-onboarding.json'), 'utf8'), before, 'describe must not change onboarding state');
});

test('actual enabled tool examples require both member permission and an available executor', t => {
  const f = fixture(t, { executors: { ai_digest: () => ({ text: 'synthetic digest' }), weather: () => ({ text: 'synthetic weather' }) } });
  f.toolbox.assign({ actorId: 'owner', personId: 'member', toolId: 'ai_digest', resource: { workspaceId: 'synthetic-source', relativePath: 'digest.md' }, allowInvoke: true });
  f.toolbox.assign({ actorId: 'owner', personId: 'other', toolId: 'weather', resource: { city: 'OTHER_CITY_PRIVATE' }, allowInvoke: true });
  f.toolbox.assign({ actorId: 'owner', personId: 'member', toolId: 'presentation', resource: { workflow: 'presentation' }, allowInvoke: true });
  const help = f.onboarding.describe('member');
  assert.deepEqual(help.tools.map(row => row.toolId), ['ai_digest']);
  assert.match(help.text, /AI 日报/u);
  assert.match(help.examples.join('\n'), /日报/u);
  assert.ok(help.examples.includes('AI 日报'), 'tool examples must match deterministic runtime routing');
  assert.equal(help.tools[0].sourceStatus, 'not_checked');
  assert.doesNotMatch(help.text, /天气|PPT|OTHER_CITY_PRIVATE|synthetic-source|digest\.md|已读取|来源已验证/u);
  assert.equal(f.toolbox.due().length, 0);
});

test('scheduled-only tools name the actual time and cannot be advertised for manual invocation', t => {
  const f = fixture(t, { executors: { weather: () => 'synthetic weather' } });
  f.toolbox.assign({ actorId: 'owner', personId: 'member', toolId: 'weather', resource: { city: '合成城市' }, allowInvoke: false, schedule: { enabled: true, time: '08:15', timeZone: 'Asia/Shanghai' } });
  const help = f.onboarding.describe('member');
  assert.equal(help.tools[0].allowInvoke, false);
  assert.match(help.text, /08:15.*Asia\/Shanghai/u);
  assert.match(help.text, /不能临时调用/u);
  assert.match(help.text, /由 Owner 安排.*想调整.*转达需求/u);
  assert.doesNotMatch(help.examples.join('\n'), /查.*天气/u);
});

test('manual weather example uses the exact supported tool command', t => {
  const f = fixture(t, { executors: { weather: () => 'synthetic weather' } });
  f.toolbox.assign({ actorId: 'owner', personId: 'member', toolId: 'weather', resource: { city: '合成城市' }, allowInvoke: true });
  assert.ok(f.onboarding.describe('member').examples.includes('查天气'));
});

test('PPT is advertised only while the real presentation workflow is enabled and available', t => {
  const f = fixture(t, { ppt: true });
  let help = f.onboarding.describe('member');
  assert.match(help.text, /PPT/u);
  assert.match(help.examples.join('\n'), /PPT/u);
  f.services.people[0].enabled = false;
  assert.doesNotMatch(f.onboarding.describe('member').text, /PPT/u);
  f.services.people[0].enabled = true; f.services.available = false;
  assert.doesNotMatch(f.onboarding.describe('member').text, /PPT/u);
});

test('project help reflects actual read/task scope and allows only own new output when write is granted', t => {
  const f = fixture(t, { projectExecutorAvailable: true });
  f.access.grant({ actorId: 'owner', personId: 'member', workspaceIds: ['synthetic-project'], capabilities: ['read', 'task'] });
  let help = f.onboarding.describe('member');
  assert.equal(help.projects.available, true);
  assert.equal(help.projects.canWrite, false);
  assert.deepEqual(help.projects.workspaceIds, ['synthetic-project']);
  assert.match(help.text, /获准的 1 个项目/u);
  assert.match(help.text, /读取.*资料/u);
  assert.doesNotMatch(help.text, /创建.*文件|任意文件|全部项目|其他家人/u);
  f.access.grant({ actorId: 'owner', personId: 'member', workspaceIds: ['synthetic-project'], capabilities: ['read', 'task', 'write'] });
  help = f.onboarding.describe('member');
  assert.equal(help.projects.canWrite, true);
  assert.match(help.text, /本人.*新文件/u);
  assert.match(help.text, /不会覆盖/u);
  f.access.revoke({ actorId: 'owner', personId: 'member' });
  assert.equal(f.onboarding.describe('member').projects.available, false);
});

test('project grants alone do not promise execution without the actual executor and read plus task', t => {
  const f = fixture(t);
  f.access.grant({ actorId: 'owner', personId: 'member', workspaceIds: ['synthetic-project'], capabilities: ['read', 'task', 'write'] });
  assert.equal(f.onboarding.describe('member').projects.available, false);
  f.options.projectExecutorAvailable = true;
  f.onboarding = createMemberOnboarding(f.options);
  f.access.grant({ actorId: 'owner', personId: 'member', workspaceIds: ['synthetic-project'], capabilities: ['read'] });
  assert.equal(f.onboarding.describe('member').projects.available, false);
  assert.doesNotMatch(f.onboarding.describe('member').text, /读取.*项目|创建.*文件/u);
});

test('unknown members and malformed versions cannot reset the durable welcome baseline', t => {
  const f = fixture(t, { bound: true });
  assert.throws(() => f.onboarding.describe('missing'), { code: 'UNKNOWN_PERSON' });
  const file = join(f.directory, 'member-onboarding.json');
  const invalid = JSON.stringify({ version: 999, members: [] });
  writeFileSync(file, invalid);
  assert.throws(() => createMemberOnboarding(f.options), { code: 'INVALID_STATE' });
  assert.equal(readFileSync(file, 'utf8'), invalid);
});

test('onboarding storage rejects symlinks instead of reading or changing their targets', t => {
  const f = fixture(t);
  const file = join(f.directory, 'member-onboarding.json');
  const target = join(f.directory, 'protected.json');
  writeFileSync(target, 'protected synthetic target'); unlinkSync(file); symlinkSync(target, file);
  assert.throws(() => createMemberOnboarding(f.options), { code: 'UNSAFE_PATH' });
  assert.equal(readFileSync(target, 'utf8'), 'protected synthetic target');
});
