import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../src/store.mjs';

const implementation = await import('../src/digest-delivery.mjs').catch(() => ({}));
const now = () => '2026-10-25T12:00:00.000Z';
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture(t, changes = {}) {
  assert.equal(typeof implementation.createDigestDelivery, 'function', 'one-off delivery implementation exists');
  const directory = mkdtempSync(join(tmpdir(), 'lele-digest-once-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createStore({ directory, now });
  for (const [id, role, label] of [['owner', 'owner', '山'], ['k', 'elder', 'K'], ['other', 'elder', '其他家人']]) {
    store.addPerson({ id, role, label }); store.bindPerson(id, { accountId: `account-${id}`, peerId: `peer-${id}` });
  }
  store.configure({ paused: false });
  const sent = [], reads = [], plainText = changes.text ?? '合成 AI 日报：三条有依据的新闻。';
  let service, flushing = 0;
  const proposal = { kind: 'ai_digest_once', draftId: 'draft-one', revision: 3, personId: 'k', resource: { workspaceId: 'personal', relativePath: 'output/ai-digest/2026-10-25-wechat.txt' }, source: { bytes: Buffer.byteLength(plainText), updatedAt: now() }, authorization: 'explicit_now', expectedRoute: store.route('k'), ownerRoute: store.route('owner') };
  const options = {
    directory, store, now,
    readDigest: async args => { reads.push(args); return changes.readDigest ? changes.readDigest(args, { store }) : { text: plainText, source: { path: '/private/source', token: 'metadata-is-not-content' } }; },
    flush: async (personId, { onlyId } = {}) => {
      flushing++;
      for (const row of store.pending().filter(row => row.personId === personId && (!onlyId || row.id === onlyId))) {
        if (!service.canDeliver(row)) { store.transition(row.id, 'cancelled'); continue; }
        const started = store.transition(row.id, 'dispatching');
        if (started.status !== 'dispatching') continue;
        if (!service.canDeliver(started)) { store.transition(row.id, 'cancelled'); continue; }
        changes.beforeSend?.({ store, row: started, index: sent.length });
        if (!service.canDeliver(started)) { store.transition(row.id, 'cancelled'); continue; }
        sent.push({ personId, text: row.text });
        store.transition(row.id, changes.outcome ?? 'api_accepted');
      }
      if (changes.throwFlush) throw Error('secret-token PRIVATE ERROR /private/source');
    },
  };
  service = implementation.createDigestDelivery(options);
  const args = { actorId: 'owner', origin: 'wechat', requestId: 'incoming-once', proposal, authorityRoute: store.route('owner') };
  return { directory, store, proposal, args, sent, reads, options, get service() { return service; }, restart() { service = implementation.createDigestDelivery(options); return service; }, flushing: () => flushing };
}

test('explicit one-off delivers only the source text once to K and never changes daily or permission state', async t => {
  const f = fixture(t), before = f.store.snapshot();
  const result = await f.service.deliver(f.args);
  assert.equal(result.status, 'api_accepted');
  assert.deepEqual(f.sent, [{ personId: 'k', text: '合成 AI 日报：三条有依据的新闻。' }]);
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.reads[0].resource, f.proposal.resource);
  assert.deepEqual(f.reads[0].source, f.proposal.source);
  assert.deepEqual(f.store.snapshot().people, before.people);
  assert.deepEqual(f.store.snapshot().reminders, before.reminders);
  assert.equal(f.store.snapshot().config.ownerBriefEnabled, false);
  assert.match(result.reply, /接口|提交/);
  assert.doesNotMatch(JSON.stringify(f.sent) + result.reply, /private|metadata-is-not-content|relativePath|workspaceId|output\/ai-digest/);
  assert.equal(statSync(join(f.directory, 'digest-delivery.json')).mode & 0o777, 0o600);
  await f.service.deliver(f.args); f.restart(); await f.service.deliver(f.args);
  assert.equal(f.reads.length, 1); assert.equal(f.sent.length, 1);
});

test('a changed proposal under the same request is rejected without another read or send', async t => {
  const f = fixture(t); await f.service.deliver(f.args);
  await assert.rejects(f.service.deliver({ ...f.args, proposal: { ...f.proposal, revision: 4 } }), error => error.code === 'digest_delivery_request_conflict');
  assert.equal(f.reads.length, 1); assert.equal(f.sent.length, 1);
});

test('non-Owner, paused service, disconnected target and mismatched captured routes cannot read or send', async t => {
  for (const condition of ['member', 'paused', 'disconnected', 'target-route', 'owner-route', 'missing-authority']) {
    const f = fixture(t);
    if (condition === 'member') f.args.actorId = 'other';
    if (condition === 'paused') f.store.configure({ paused: true });
    if (condition === 'disconnected') f.store.setConnection('k', { status: 'disconnected' });
    if (condition === 'target-route') f.store.bindPerson('k', { accountId: 'replacement', peerId: 'replacement-k' });
    if (condition === 'owner-route') f.store.bindPerson('owner', { accountId: 'replacement-owner', peerId: 'replacement-owner' });
    if (condition === 'missing-authority') delete f.args.authorityRoute;
    const result = await f.service.deliver(f.args).catch(error => ({ status: error.code }));
    assert.notEqual(result.status, 'api_accepted', condition);
    assert.equal(f.reads.length, 0, condition); assert.equal(f.sent.length, 0, condition);
  }
});

test('a target or Owner rebind, pause, or cancellation during an async read suppresses delivery', async t => {
  for (const mutation of ['target', 'owner', 'pause', 'abort']) {
    const gate = deferred(), started = deferred();
    const f = fixture(t, { readDigest: async () => { started.resolve(); await gate.promise; return { text: 'late synthetic result' }; } });
    const controller = new AbortController();
    const pending = f.service.deliver({ ...f.args, signal: controller.signal }); await started.promise;
    if (mutation === 'target') f.store.bindPerson('k', { accountId: 'new-k', peerId: 'new-peer-k' });
    if (mutation === 'owner') f.store.bindPerson('owner', { accountId: 'new-owner', peerId: 'new-peer-owner' });
    if (mutation === 'pause') f.store.configure({ paused: true });
    if (mutation === 'abort') controller.abort();
    gate.resolve(); const result = await pending;
    assert.equal(result.status, 'cancelled', mutation); assert.equal(f.sent.length, 0, mutation);
  }
});

test('parallel duplicate requests share one reading intent and one delivery', async t => {
  const gate = deferred(), started = deferred();
  const f = fixture(t, { readDigest: async () => { started.resolve(); await gate.promise; return { text: 'parallel synthetic digest' }; } });
  const first = f.service.deliver(f.args); await started.promise;
  const second = f.service.deliver(f.args); gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.deliveryId, b.deliveryId); assert.equal(a.status, 'api_accepted');
  assert.equal(f.reads.length, 1); assert.equal(f.sent.length, 1);
});

test('long text preserves content and never splits a surrogate pair', async t => {
  const text = '甲'.repeat(2999) + '鲸' + '🧪' + '乙'.repeat(3200), f = fixture(t, { text });
  const result = await f.service.deliver(f.args);
  assert.equal(result.status, 'api_accepted'); assert.equal(f.sent.length, 3);
  assert.equal(f.sent.map(row => row.text).join(''), text);
  for (const row of f.sent) { assert.ok(row.text.length <= 3000); assert.doesNotMatch(row.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u); }
});

test('failed or unknown first segment cancels every tail and replay never retries', async t => {
  for (const outcome of ['failed', 'uncertain']) {
    const f = fixture(t, { text: '合成日报。'.repeat(1400), outcome });
    const result = await f.service.deliver(f.args);
    assert.equal(result.status, outcome); assert.equal(f.sent.length, 1);
    assert.equal(f.store.pending().length, 0);
    assert.ok(f.store.snapshot().outbox.slice(1).every(row => row.status === 'cancelled'));
    f.restart(); await f.service.deliver(f.args);
    await f.options.flush('k');
    assert.equal(f.sent.length, 1); assert.equal(f.reads.length, 1);
  }
});

test('binding change immediately before a segment suppresses it and cancels pending tails', async t => {
  const f = fixture(t, { text: '合成日报。'.repeat(1400), beforeSend: ({ store }) => store.bindPerson('k', { accountId: 'new-k', peerId: 'new-k-peer' }) });
  const result = await f.service.deliver(f.args);
  assert.equal(result.status, 'uncertain'); assert.equal(f.sent.length, 0); assert.equal(f.store.pending().length, 0);
});

test('cancellation immediately before transport authorization suppresses the segment and every tail', async t => {
  const controller = new AbortController();
  const f = fixture(t, { text: '合成日报。'.repeat(1400), beforeSend: () => controller.abort() });
  const result = await f.service.deliver({ ...f.args, signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(f.sent.length, 0); assert.equal(f.store.pending().length, 0);
});

test('read errors and credential-bearing content never leak through result, outbox or subsequent replays', async t => {
  for (const invalid of ['error', 'credential', 'empty', 'unpaired']) {
    const f = fixture(t, { readDigest: async () => { if (invalid === 'error') throw Error('token=PRIVATESECRET /private/file'); return { text: invalid === 'credential' ? 'token=PRIVATESECRET' : invalid === 'empty' ? '' : '\ud800' }; } });
    const result = await f.service.deliver(f.args);
    assert.equal(result.status, 'failed', invalid); assert.equal(f.sent.length, 0, invalid);
    assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(f.store.snapshot().outbox), /PRIVATESECRET|\/private/);
    f.restart(); await f.service.deliver(f.args); assert.equal(f.reads.length, 1);
  }
});

test('restart during reading records an interrupted result and the original reader cannot later send', async t => {
  const gate = deferred(), started = deferred();
  const f = fixture(t, { readDigest: async () => { started.resolve(); await gate.promise; return { text: 'late result after restart' }; } });
  const first = f.service.deliver(f.args); await started.promise;
  f.restart(); const replay = await f.service.deliver(f.args);
  assert.equal(replay.status, 'uncertain'); assert.equal(f.reads.length, 1);
  gate.resolve(); const late = await first;
  assert.notEqual(late.status, 'api_accepted'); assert.equal(f.sent.length, 0);
});

test('restart with pending chunks cancels them and cannot authorize a forged or incomplete outbox', async t => {
  const gate = deferred(), started = deferred();
  const f = fixture(t, { text: '合成日报。'.repeat(1400) });
  const options = { ...f.options, flush: async () => { started.resolve(); await gate.promise; } };
  const firstService = implementation.createDigestDelivery(options);
  const pending = firstService.deliver(f.args); await started.promise;
  assert.ok(f.store.pending().length > 0);
  const restarted = implementation.createDigestDelivery(options);
  assert.equal(f.store.pending().length, 0);
  const replay = await restarted.deliver(f.args); assert.equal(replay.status, 'uncertain');
  const row = f.store.snapshot().outbox[0];
  assert.equal(restarted.canDeliver(row), false);
  assert.equal(restarted.canDeliver({ ...row, text: 'forged body' }), false);
  gate.resolve(); await pending; assert.equal(f.sent.length, 0);
});

test('a transport exception without a conclusive receipt stops all tail chunks', async t => {
  const f = fixture(t, { text: '合成日报。'.repeat(1400), outcome: 'uncertain', throwFlush: true });
  const result = await f.service.deliver(f.args);
  assert.equal(result.status, 'uncertain'); assert.equal(f.sent.length, 1); assert.equal(f.store.pending().length, 0);
  assert.doesNotMatch(result.reply, /secret|PRIVATE|\/private/);
});

test('a corrupt journal fails closed instead of creating a fresh send intent', async t => {
  const f = fixture(t); await f.service.deliver(f.args);
  const path = join(f.directory, 'digest-delivery.json'), data = JSON.parse(readFileSync(path, 'utf8'));
  data.version = 99; writeFileSync(path, JSON.stringify(data));
  assert.throws(() => f.restart(), error => error.code === 'digest_delivery_invalid_state');
});
