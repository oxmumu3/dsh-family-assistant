import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOwnerDotReadPolicy} from '../src/owner-dot-read-guard.mjs';
import {createRuntime} from '../src/runtime.mjs';

const sensitiveTask = sessionId => ({sessionId, origin: 'wechat', state: 'running', prompt: '帮我看一下这个项目的代码'});

test('the bound Owner keeps the normal toolset on a sensitive project turn', () => {
  const tasks = [sensitiveTask('family_owner_abc')];
  const policy = createOwnerDotReadPolicy(() => tasks, {isOwnerSession: id => id === 'family_owner_abc'});
  assert.equal(policy.active('family_owner_abc'), true, 'the turn is still scoped for native presentation');
  for (const name of ['taskboard_create', 'taskboard_list', 'read', 'bash', 'family_assistant']) {
    assert.equal(policy.guard({agent: {id: 'family_owner_abc'}, name}), undefined, `${name} must stay available for the Owner`);
  }
});

test('a session that is not the bound Owner keeps the read-only scope', () => {
  const tasks = [sensitiveTask('family_owner_abc')];
  const policy = createOwnerDotReadPolicy(() => tasks, {isOwnerSession: () => false});
  assert.match(policy.guard({agent: {id: 'family_owner_abc'}, name: 'taskboard_create'}), /只读/);
  assert.equal(policy.guard({agent: {id: 'family_owner_abc'}, name: 'project_companion'}), undefined);
});

test('without a resolver the scope stays closed by default', () => {
  const policy = createOwnerDotReadPolicy(() => [sensitiveTask('family_owner_abc')]);
  assert.match(policy.guard({agent: {id: 'family_owner_abc'}, name: 'bash'}), /只读/);
});

test('the runtime marks only the Owner conversation as owner-bound', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'scope-'));
  const runtime = createRuntime({directory, intervalMs: 600000,
    channelFactory: () => ({status: () => ({status: 'connected'}), connect: async () => {}, disconnect: async () => {}, close: async () => {}, send: async () => ({status: 'api_accepted'})})});
  t.after(async () => { await runtime.close(); rmSync(directory, {recursive: true, force: true}); });
  assert.equal(runtime.isOwnerSessionForToolGuard('family_owner_x'), false, 'no owner registered yet');
  runtime.store.addPerson({id: 'owner', role: 'owner', label: '我'});
  runtime.store.addPerson({id: 'mom', role: 'elder', label: '妈妈'});
  runtime.store.bindPerson('owner', {accountId: 'bot-owner', peerId: 'wx-owner'});
  runtime.store.bindPerson('mom', {accountId: 'bot-mom', peerId: 'wx-mom'});
  assert.equal(runtime.isOwnerSessionForToolGuard('family_owner_abc'), true);
  assert.equal(runtime.isOwnerSessionForToolGuard('family_member_abc'), false, 'family sessions are never owner-bound');
});
