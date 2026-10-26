import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createStore } from '../src/store.mjs';
import { createFamilyToolbox } from '../src/family-toolbox.mjs';

const implementation = await import('../src/workflow-notifications.mjs').catch(() => ({}));
const now = () => '2026-10-25T20:00:00.000Z';
function fixture(t, changes = {}) {
  assert.equal(typeof implementation.createWorkflowNotifications, 'function', 'workflow notification implementation exists');
  const directory = mkdtempSync(join(tmpdir(), 'lele-workflow-notify-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createStore({ directory, now });
  for (const [id, role, label] of [['owner', 'owner', '山'], ['mom', 'elder', '妈妈'], ['dad', 'elder', '爸爸']]) {
    store.addPerson({ id, role, label, shareWithOwner: 'none' }); store.bindPerson(id, { accountId: `account-${id}`, peerId: `peer-${id}` });
  }
  store.configure({ paused: false });
  store.addMessage('mom', { dir: 'in', text: '私人聊天不可转发', kind: 'chat' });
  const toolbox = createFamilyToolbox({ directory, store, now }), sent = [];
  let module;
  const options = { directory, store, toolbox, now, flush: async (personId, { onlyId } = {}) => {
    for (const row of store.pending().filter(row => row.personId === personId && (!onlyId || row.id === onlyId))) {
      if (!module.canDeliver(row)) { store.transition(row.id, 'cancelled'); continue; }
      const started = store.transition(row.id, 'dispatching'); if (started.status !== 'dispatching') continue;
      changes.beforeSend?.({ row: started, store });
      if (!module.canDeliver(started)) { if (store.snapshot().outbox.find(item => item.id === row.id).status === 'dispatching') store.transition(row.id, 'cancelled'); continue; }
      sent.push({ personId, text: row.text });
      store.transition(row.id, changes.outcome ?? 'api_accepted');
    }
    if (changes.throwFlush) throw Error('token=PRIVATE /private/credentials');
  } };
  module = implementation.createWorkflowNotifications(options);
  const request = (personId = 'mom', requestId = 'request-one', text = '希望增加一个每周菜谱工具') => toolbox.requestWorkflow({ personId, requestId, text });
  const notify = (row, extra = {}) => module.notify({ personId: row.personId, requestId: row.requestId, expectedRoute: store.route(row.personId), ...extra });
  const update = (row, extra = {}) => module.requestUpdate({ actorId: 'owner', personId: row.personId, requestId: row.requestId, status: 'accepted', note: '先告诉我几个人吃饭，我会帮你继续安排。', operationId: 'owner-answer-one', authorityRoute: store.route('owner'), ...extra });
  return { directory, store, toolbox, sent, request, notify, update, options, get module() { return module; }, restart() { module = implementation.createWorkflowNotifications(options); return module; } };
}

test('a new explicit workflow request proactively notifies Owner once and contains only the request', async t => {
  const f = fixture(t), request = f.request(), result = await f.notify(request);
  assert.equal(result.status, 'api_accepted'); assert.equal(result.request.requestId, request.requestId);
  assert.match(result.shortId, /^wf-[a-f0-9]{12}$/u);
  assert.match(f.sent[0].text, /妈妈.*工具|工作流/u); assert.match(f.sent[0].text, /每周菜谱/);
  assert.ok(f.sent[0].text.includes(`回复需求 ${result.shortId}：`));
  assert.deepEqual(f.sent.map(row => row.personId), ['owner']);
  assert.doesNotMatch(JSON.stringify(f.sent), /私人聊天|peer-|account-/);
  await f.notify(request); f.restart(); await f.notify(request);
  assert.equal(f.sent.length, 1); assert.deepEqual(readdirSync(f.directory).sort(), ['family-toolbox.json', 'family.json']);
});

test('an explicit Owner answer returns to the original family member and a member supplement reaches Owner', async t => {
  const f = fixture(t), request = f.request(); await f.notify(request);
  const response = await f.update(request);
  assert.equal(response.status, 'api_accepted'); assert.equal(response.request.status, 'accepted');
  assert.equal(f.sent[1].personId, 'mom'); assert.match(f.sent[1].text, /家庭联系人|代.*回复/u);
  assert.ok(f.sent[1].text.includes(`补充需求 ${response.shortId}：`));
  const context = f.module.memberContext({ personId: 'mom' }); assert.equal(context.length, 1); assert.equal(context[0].requestId, request.requestId); assert.match(JSON.stringify(context), /几个人吃饭/);
  assert.deepEqual(f.module.memberContext({ personId: 'dad' }), []);
  const follow = await f.module.followUp({ personId: 'mom', requestId: request.requestId, text: '三个人，少油少盐。', operationId: 'member-follow-one', expectedRoute: f.store.route('mom') });
  assert.equal(follow.status, 'api_accepted'); assert.equal(f.sent[2].personId, 'owner'); assert.match(f.sent[2].text, /三个人，少油少盐/);
  assert.doesNotMatch(JSON.stringify(f.sent), /私人聊天/);
  await f.update(request); await f.module.followUp({ personId: 'mom', requestId: request.requestId, text: '三个人，少油少盐。', operationId: 'member-follow-one', expectedRoute: f.store.route('mom') });
  f.restart(); await f.update(request);
  assert.equal(f.sent.length, 3);
});

test('pure status updates never fabricate or send an Owner answer', async t => {
  const f = fixture(t), request = f.request(); await f.notify(request);
  const result = await f.update(request, { note: undefined, operationId: 'status-only' });
  assert.equal(result.status, 'not_requested'); assert.equal(result.request.status, 'accepted'); assert.equal(f.sent.length, 1);
  assert.deepEqual(f.module.memberContext({ personId: 'mom' }), []);
});

test('an old Owner authority route cannot change even a status-only request after replacement', async t => {
  const f = fixture(t), request = f.request(), authorityRoute = f.store.route('owner');
  await f.notify(request); f.store.bindPerson('owner', { accountId: 'new-owner', peerId: 'new-peer-owner' });
  const result = await f.update(request, { note: undefined, authorityRoute });
  assert.equal(result.status, 'cancelled'); assert.equal(f.toolbox.listRequests({ actorId: 'owner' })[0].status, 'pending');
});

test('the same answer operation cannot change its status or content after delivery', async t => {
  const f = fixture(t), request = f.request(); await f.notify(request); await f.update(request);
  await assert.rejects(f.update(request, { note: '不同内容' }), error => error.code === 'workflow_notification_request_conflict');
  await assert.rejects(f.update(request, { status: 'declined' }), error => error.code === 'workflow_notification_request_conflict');
  assert.equal(f.sent.length, 2);
});

test('member or Owner replacement cannot reuse an old notification or route an old answer', async t => {
  for (const who of ['mom', 'owner']) {
    const f = fixture(t), request = f.request(); await f.notify(request);
    f.store.bindPerson(who, { accountId: `new-${who}`, peerId: `new-peer-${who}` });
    const response = await f.update(request); assert.notEqual(response.status, 'api_accepted');
    await f.notify(request); assert.equal(f.sent.length, 1);
    assert.deepEqual(f.module.memberContext({ personId: 'mom' }), []);
  }
});

test('notify requires the original request route and an actual family member; updates require Owner authority', async t => {
  const f = fixture(t), request = f.request();
  await assert.rejects(f.module.notify({ personId: 'mom', requestId: request.requestId }), error => error.code === 'workflow_notification_invalid_argument');
  await assert.rejects(f.update(request, { actorId: 'dad', authorityRoute: f.store.route('dad') }), error => error.code === 'workflow_notification_forbidden');
  await assert.rejects(f.update(request, { authorityRoute: f.store.route('dad') }), error => error.code === 'workflow_notification_invalid_argument');
  const wrong = await f.notify(request, { expectedRoute: f.store.route('dad') }).catch(error => ({ status: error.code }));
  assert.notEqual(wrong.status, 'api_accepted'); assert.equal(f.sent.length, 0);
});

test('a family supplement cannot be sent before an Owner answer or on another member request', async t => {
  const f = fixture(t), request = f.request(); await f.notify(request);
  const args = { personId: 'mom', requestId: request.requestId, text: '补充材料', operationId: 'follow-one', expectedRoute: f.store.route('mom') };
  const before = await f.module.followUp(args); assert.notEqual(before.status, 'api_accepted');
  await f.update(request);
  await assert.rejects(f.module.followUp({ ...args, personId: 'dad', expectedRoute: f.store.route('dad') }), error => error.code === 'workflow_notification_unknown_request');
  assert.equal(f.sent.length, 2);
});

test('failed or unknown initial notification is never retried and cancels all long-request tails', async t => {
  for (const outcome of ['failed', 'uncertain']) {
    const f = fixture(t, { outcome }), request = f.request('mom', 'long-request', '希望增加菜谱工具。'.repeat(360));
    const result = await f.notify(request); assert.equal(result.status, outcome);
    assert.equal(f.sent.length, 1); assert.equal(f.store.pending().length, 0);
    await f.notify(request); f.restart(); await f.notify(request); await f.options.flush('owner');
    assert.equal(f.sent.length, 1);
  }
});

test('failed and unknown Owner answers are not resent or exposed as a received member continuation', async t => {
  const f = fixture(t), request = f.request(); await f.notify(request);
  const options = { ...f.options, flush: async (personId, { onlyId }) => { const row = f.store.pending().find(row => row.id === onlyId); f.store.transition(row.id, 'dispatching'); f.store.transition(row.id, 'uncertain'); } };
  const module = implementation.createWorkflowNotifications(options);
  const args = { actorId: 'owner', personId: 'mom', requestId: request.requestId, status: 'accepted', note: '明确的一次答复', operationId: 'unknown-answer', authorityRoute: f.store.route('owner') };
  assert.equal((await module.requestUpdate(args)).status, 'uncertain');
  await module.requestUpdate(args); assert.deepEqual(module.memberContext({ personId: 'mom' }), []);
});

test('a later undelivered Owner answer cannot replace the accepted answer in member continuation context', async t => {
  const f = fixture(t), request = f.request(); await f.notify(request); await f.update(request);
  const module = implementation.createWorkflowNotifications({ ...f.options, flush: async (_personId, { onlyId }) => { f.store.transition(onlyId, 'dispatching'); f.store.transition(onlyId, 'failed'); } });
  const result = await module.requestUpdate({ actorId: 'owner', personId: 'mom', requestId: request.requestId, status: 'declined', note: '第二次答复尚未投递成功', operationId: 'owner-answer-two', authorityRoute: f.store.route('owner') });
  assert.equal(result.status, 'failed');
  const context = module.memberContext({ personId: 'mom' });
  assert.equal(context.length, 1); assert.equal(context[0].note, '先告诉我几个人吃饭，我会帮你继续安排。');
  assert.doesNotMatch(JSON.stringify(context), /第二次答复尚未投递成功/);
});

test('restart seals pending notifications and refuses tampered row bodies or unrecognized source keys', async t => {
  const f = fixture(t), request = f.request(); let release, started;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { started = resolve; });
  const module = implementation.createWorkflowNotifications({ ...f.options, flush: async () => { started(); await gate; } });
  const pending = module.notify({ personId: 'mom', requestId: request.requestId, expectedRoute: f.store.route('mom') }); await ready;
  const row = f.store.pending()[0]; assert.equal(module.canDeliver(row), true);
  assert.equal(module.canDeliver({ ...row, text: 'forged message' }), false);
  assert.equal(module.canDeliver({ ...row, sourceKey: 'workflow-request:forged' }), false);
  const restarted = implementation.createWorkflowNotifications(f.options); assert.equal(f.store.pending().length, 0); assert.equal(restarted.canDeliver(row), false);
  release(); assert.notEqual((await pending).status, 'api_accepted'); assert.equal(f.sent.length, 0);
});

test('a well-formed legacy outbox row cannot gain new send authority without a current explicit module attempt', async t => {
  const f = fixture(t), first = f.request(); const delivered = await f.notify(first);
  const another = f.request('mom', 'another-request'), reference = f.module.shortId(another);
  const body = f.sent[0].text.replaceAll(delivered.shortId, reference);
  const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 40);
  const row = f.store.enqueue({ personId: 'owner', text: body, kind: 'workflow_request', sourceKey: `workflow-request:${hash(JSON.stringify(['mom', 'another-request']))}:${hash(body)}:0`, authorizationRoute: f.store.route('mom') });
  assert.equal(f.module.canDeliver(row), false);
});

test('cancellation or replacement just before transport authorization stops the notification', async t => {
  const controller = new AbortController();
  const f = fixture(t, { beforeSend: () => controller.abort() }), request = f.request();
  const result = await f.notify(request, { signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(f.sent.length, 0); assert.equal(f.store.pending().length, 0);
});

test('paused or disconnected routes never dispatch and transport errors never leak their details', async t => {
  const f = fixture(t, { throwFlush: true }), request = f.request(); f.store.configure({ paused: true });
  assert.notEqual((await f.notify(request)).status, 'api_accepted'); assert.equal(f.sent.length, 0);
  const result = await f.update(request); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|credentials|\/private/);
});
