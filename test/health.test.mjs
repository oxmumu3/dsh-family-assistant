import test from 'node:test';
import assert from 'node:assert/strict';
import {buildHealth, healthSummary, personHealth} from '../src/health.mjs';

const nowIso = '2026-11-04T20:00:00.000Z';
const person = (id, label) => ({id, label, role: 'elder'});
const binding = (personId, extra = {}) => ({personId, status: 'connected', generation: 1, lastInboundAt: '2026-11-04T19:00:00.000Z', lastOutboundAt: '2026-11-04T18:00:00.000Z', ...extra});
const outboxRow = (personId, status, createdAt = '2026-11-04T19:30:00.000Z') => ({personId, status, createdAt, text: 'secret text'});

test('an online person with no pending work reads as ok', () => {
  const row = personHealth({person: person('a', '妈妈'), binding: binding('a'), outbox: [], channel: {status: 'connected'}, nowMs: Date.parse(nowIso)});
  assert.equal(row.connected, true);
  assert.equal(row.state, 'ok');
  assert.equal(row.pending, 0);
  assert.equal(row.label, '妈妈');
});

test('an offline person is reported as offline regardless of history', () => {
  const row = personHealth({person: person('a', '爸爸'), binding: binding('a'), outbox: [], channel: {status: 'disconnected'}, nowMs: Date.parse(nowIso)});
  assert.equal(row.connected, false);
  assert.equal(row.state, 'offline');
});

test('pending, uncertain and failed are counted separately within 24 hours', () => {
  const nowMs = Date.parse(nowIso);
  const rows = [
    outboxRow('a', 'pending'),
    outboxRow('a', 'uncertain'),
    outboxRow('a', 'failed'),
    outboxRow('a', 'failed', '2026-10-01T00:00:00.000Z'),
    outboxRow('b', 'failed'),
  ];
  const row = personHealth({person: person('a', '妈妈'), binding: binding('a'), outbox: rows, channel: {status: 'connected'}, nowMs});
  assert.equal(row.pending, 1);
  assert.equal(row.uncertain24h, 1);
  assert.equal(row.failed24h, 1, 'old failures fall outside the window');
  assert.equal(row.state, 'attention');
});

test('the overview totals every registered person and never leaks message text', () => {
  const health = buildHealth({
    state: {people: [person('a', '妈妈'), person('b', '爸爸')], bindings: [binding('a'), binding('b')], outbox: [outboxRow('a', 'pending')]},
    channelOf: id => ({status: id === 'a' ? 'connected' : 'disconnected'}),
    now: () => nowIso,
  });
  assert.equal(health.totals.people, 2);
  assert.equal(health.totals.online, 1);
  assert.equal(health.totals.offline, 1);
  assert.equal(health.totals.pending, 1);
  assert.equal(health.checkedAt, nowIso);
  assert.ok(!JSON.stringify(health).includes('secret text'));
  assert.match(healthSummary(health), /1\/2 在线/);
});

test('an empty household says so instead of inventing health', () => {
  const health = buildHealth({state: {people: [], bindings: [], outbox: []}, now: () => nowIso});
  assert.equal(health.totals.people, 0);
  assert.equal(healthSummary(health), '还没有登记家人。');
});
