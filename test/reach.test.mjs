import test from 'node:test';
import assert from 'node:assert/strict';
import {REACH_WINDOW_MS, reachFor, reachLabel, canSendNow} from '../src/reach.mjs';

const now = '2026-11-09T04:00:00.000Z';
const ago = ms => new Date(Date.parse(now) - ms).toISOString();

test('the Owner has no window of their own on this panel', () => {
  const reach = reachFor({role: 'owner', connected: true, lastInboundAt: ago(10 * 24 * 60 * 60 * 1000), now});
  assert.equal(reach.state, 'self');
  assert.equal(canSendNow(reach), true);
});

test('a family member who wrote recently can still receive', () => {
  const reach = reachFor({role: 'elder', connected: true, lastInboundAt: ago(3 * 60 * 60 * 1000), now});
  assert.equal(reach.state, 'open');
  assert.equal(canSendNow(reach), true);
  assert.match(reachLabel(reach), /现在能收到（还剩 21 小时）/);
});

test('the window closes exactly 24 hours after their last message', () => {
  const inside = reachFor({role: 'elder', connected: true, lastInboundAt: ago(REACH_WINDOW_MS - 60_000), now});
  const past = reachFor({role: 'elder', connected: true, lastInboundAt: ago(REACH_WINDOW_MS + 60_000), now});
  assert.equal(inside.state, 'open');
  assert.equal(past.state, 'closed');
  assert.equal(canSendNow(past), false);
  assert.equal(reachLabel(past), '要等对方先说一句');
});

test('a disconnected member is never claimed as reachable', () => {
  for (const lastInboundAt of [ago(60_000), ago(30 * 24 * 60 * 60 * 1000), null]) {
    const reach = reachFor({role: 'elder', connected: false, lastInboundAt, now});
    assert.equal(reach.state, 'offline');
    assert.equal(canSendNow(reach), false);
  }
});

test('an unknown timestamp or clock is treated as closed, never as open', () => {
  assert.equal(reachFor({role: 'elder', connected: true, lastInboundAt: null, now}).state, 'closed');
  assert.equal(reachFor({role: 'elder', connected: true, lastInboundAt: 'not-a-date', now}).state, 'closed');
  assert.equal(reachFor({role: 'elder', connected: true, lastInboundAt: ago(60_000), now: 'not-a-date'}).state, 'closed');
  assert.equal(canSendNow(undefined), false);
  assert.equal(reachLabel(null), '未知');
});

test('the runtime holds a message instead of sending outside the window', async t => {
  const {createRuntime} = await import('../src/runtime.mjs');
  const {mkdtempSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'reach-runtime-'));
  const sent = [];
  const runtime = createRuntime({directory, intervalMs: 600000,
    channelFactory: () => ({status: () => ({status: 'connected'}), connect: async () => {}, disconnect: async () => {}, close: async () => {},
      send: async (route, text) => { sent.push({personId: route.personId, text}); return {status: 'api_accepted'}; }})});
  t.after(async () => { await runtime.close(); rmSync(directory, {recursive: true, force: true}); });
  for (const [id, role] of [['owner', 'owner'], ['mom', 'elder']]) {
    runtime.store.addPerson({id, role, label: id});
    runtime.store.bindPerson(id, {accountId: `bot-${id}`, peerId: `wx-${id}`});
  }
  runtime.store.configure({paused: false});
  // Mom last wrote three days ago: past the window the carrier accepts.
  runtime.store.setConnection('mom', {lastInboundAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()});
  await runtime.action({action: 'send_message', personId: 'mom', text: '记得吃降压药'});
  const held = runtime.store.snapshot().outbox.filter(row => row.personId === 'mom').at(-1);
  assert.equal(held.status, 'pending', 'the message waits instead of failing');
  assert.equal(sent.length, 0, 'nothing was handed to the carrier');
  const reach = runtime.status().health.people.find(row => row.personId === 'mom').reach;
  assert.equal(reach.state, 'closed');
  assert.equal(reachLabel(reach), '要等对方先说一句');
  // The Owner can always be reached through this panel.
  assert.equal(runtime.status().people.find(row => row.id === 'owner').reach.state, 'self');
  // As soon as she writes, the held message goes out.
  runtime.store.setConnection('mom', {lastInboundAt: new Date().toISOString()});
  await runtime.action({action: 'send_message', personId: 'mom', text: '第二条'});
  assert.ok(sent.length >= 1, 'delivery resumes inside the window');
});

test('the window is measured from the durable message log, not only the binding field', async t => {
  const {createRuntime} = await import('../src/runtime.mjs');
  const {mkdtempSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'reach-log-'));
  const sent = [];
  const runtime = createRuntime({directory, intervalMs: 600000,
    channelFactory: () => ({status: () => ({status: 'connected'}), connect: async () => {}, disconnect: async () => {}, close: async () => {},
      send: async (route, text) => { sent.push({personId: route.personId, text}); return {status: 'api_accepted'}; }})});
  t.after(async () => { await runtime.close(); rmSync(directory, {recursive: true, force: true}); });
  for (const [id, role] of [['owner', 'owner'], ['mom', 'elder']]) {
    runtime.store.addPerson({id, role, label: id});
    runtime.store.bindPerson(id, {accountId: `bot-${id}`, peerId: `wx-${id}`});
  }
  runtime.store.configure({paused: false});
  // The binding carries no lastInboundAt here: only the message log knows.
  const binding = runtime.store.binding('mom');
  assert.equal(binding.lastInboundAt, undefined);
  runtime.store.recordInbound('mom', {id: 'wrote-just-now', peerId: binding.peerId, text: '今天挺好的', at: new Date().toISOString()});
  await runtime.start();
  const health = runtime.status().health.people.find(row => row.personId === 'mom');
  assert.equal(health.reach.state, 'open', 'a recent message in the log opens the window even without the binding field');
  await runtime.action({action: 'send_message', personId: 'mom', text: '记得吃降压药'});
  assert.equal(sent.filter(row => row.personId === 'mom').length >= 1, true, 'and the message is actually sent');
});

test('a reminder that never reached the family member is reported to the owner', async t => {
  const {createRuntime} = await import('../src/runtime.mjs');
  const {mkdtempSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'reach-reminder-'));
  const sent = [];
  const runtime = createRuntime({directory, intervalMs: 600000,
    channelFactory: () => ({status: () => ({status: 'connected'}), connect: async () => {}, disconnect: async () => {}, close: async () => {},
      send: async (route, text) => { sent.push({personId: route.personId, text}); return {status: 'api_accepted'}; }})});
  t.after(async () => { await runtime.close(); rmSync(directory, {recursive: true, force: true}); });
  for (const [id, role, label] of [['owner', 'owner', '我'], ['mom', 'elder', '妈妈']]) {
    runtime.store.addPerson({id, role, label});
    runtime.store.bindPerson(id, {accountId: `bot-${id}`, peerId: `wx-${id}`});
  }
  runtime.store.configure({paused: false});
  runtime.store.recordInbound('owner', {id: 'owner-now', peerId: 'wx-owner', text: '在吗', at: new Date().toISOString()});
  // Mom has not written for three days: the carrier would refuse a proactive send.
  runtime.store.recordInbound('mom', {id: 'mom-old', peerId: 'wx-mom', text: '都好', at: new Date(Date.now() - 3 * 86400000).toISOString()});
  const row = runtime.store.enqueue({personId: 'mom', kind: 'reminder', sourceKey: 'reminder:r1:2026-11-08T09:00:00.000Z', text: '提醒：量血压', expiresAt: new Date(Date.now() - 60000).toISOString()});
  await runtime.tick(); await runtime.settled(); await runtime.tick(); await runtime.settled();
  const expired = runtime.store.snapshot().outbox.find(item => item.id === row.id);
  assert.equal(expired.status, 'expired', 'it must not be delivered late');
  assert.equal(sent.some(item => item.personId === 'mom'), false, 'nothing reached mom');
  const notice = runtime.store.snapshot().outbox.find(item => item.kind === 'undeliverable_notice');
  assert.ok(notice, 'the owner gets a row explaining the failure');
  await runtime.tick(); await runtime.settled();
  const told = sent.find(item => item.personId === 'owner' && item.text.includes('量血压'));
  assert.ok(told, 'and the owner is actually told');
  assert.match(told.text, /没有送到/);
});
