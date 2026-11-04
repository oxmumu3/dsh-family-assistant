import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {legacyScopePath, inspectMemberScope, planMemberMigration} from '../src/member-native-migration.mjs';
import {memberScopeHash} from '../src/member-agent.mjs';

const person = {id: 'mom', role: 'elder', label: '妈妈', createdAt: '2026-10-01T00:00:00.000Z'};
const binding = {personId: 'mom', accountId: 'acct', peerId: 'peer', generation: 2};
const ledger = requests => JSON.stringify({version: 1, personId: 'mom', bindingHash: memberScopeHash({person, route: {personId: 'mom', accountId: binding.accountId, peerId: binding.peerId, generation: binding.generation}}), requests});

function fixture(requests) {
  const directory = mkdtempSync(join(tmpdir(), 'family-migrate-'));
  const scope = legacyScopePath({directory, person, binding});
  mkdirSync(scope, {recursive: true});
  writeFileSync(join(scope, '.member-agent.json'), requests === undefined ? '{}' : ledger(requests));
  return {directory, scope};
}

test('a member with no legacy ledger is ready to migrate', () => {
  const directory = mkdtempSync(join(tmpdir(), 'family-migrate-empty-'));
  try {
    const plan = planMemberMigration({directory, people: [person], bindings: [binding]});
    assert.equal(plan.ready, true);
    assert.equal(plan.totals.withLegacy, 0);
    assert.deepEqual(plan.people[0].blockers, []);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('finished and cancelled requests do not block a switch', () => {
  const {directory} = fixture([
    {requestId: 'r1', state: 'succeeded', files: ['a.txt'], deliveries: [{}]},
    {requestId: 'r2', state: 'cancelled'},
    {requestId: 'r3', state: 'failed'},
  ]);
  try {
    const plan = planMemberMigration({directory, people: [person], bindings: [binding]});
    assert.equal(plan.ready, true);
    const row = plan.people[0];
    assert.equal(row.hasLegacyLeadger, true);
    assert.deepEqual(row.states, {succeeded: 1, cancelled: 1, failed: 1});
    assert.deepEqual([row.files, row.deliveries], [1, 1]);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('in-flight, unknown and needs_input requests block the switch', () => {
  const {directory} = fixture([
    {requestId: 'r1', state: 'running'},
    {requestId: 'r2', state: 'unknown'},
    {requestId: 'r3', state: 'prepared'},
    {requestId: 'r4', state: 'needs_input'},
    {requestId: 'r5', state: 'succeeded'},
  ]);
  try {
    const plan = planMemberMigration({directory, people: [person], bindings: [binding]});
    assert.equal(plan.ready, false);
    assert.equal(plan.totals.blocked, 1);
    assert.equal(plan.totals.pendingRequests, 4);
    assert.deepEqual(plan.people[0].blockers.sort(), ['pending_needs_input', 'pending_prepared', 'pending_running', 'pending_unknown']);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('a broken ledger is reported instead of guessed', () => {
  const {directory, scope} = fixture();
  try {
    writeFileSync(join(scope, '.member-agent.json'), '{not json');
    let row = inspectMemberScope({directory, person, binding});
    assert.deepEqual(row.blockers, ['ledger_invalid_json']);

    writeFileSync(join(scope, '.member-agent.json'), JSON.stringify({version: 1, personId: 'dad', requests: []}));
    row = inspectMemberScope({directory, person, binding});
    assert.deepEqual(row.blockers, ['ledger_person_mismatch']);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('the planner is strictly read-only', () => {
  const {directory, scope} = fixture([{requestId: 'r1', state: 'succeeded'}]);
  try {
    const file = join(scope, '.member-agent.json');
    const before = readFileSync(file, 'utf8');
    planMemberMigration({directory, people: [person], bindings: [binding]});
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('a rebinding points at a different scope, so stale ledgers are not inherited', () => {
  const directory = mkdtempSync(join(tmpdir(), 'family-migrate-rebind-'));
  try {
    const fresh = {...binding, generation: 3};
    const plan = planMemberMigration({directory, people: [person], bindings: [fresh]});
    assert.equal(plan.people[0].hasLegacyLeadger, false);
    assert.notEqual(legacyScopePath({directory, person, binding: fresh}), legacyScopePath({directory, person, binding}));
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
