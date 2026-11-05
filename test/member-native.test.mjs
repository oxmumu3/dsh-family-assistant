import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readMemberNativeFlags, isMemberNative, setMemberNative} from '../src/member-native-flags.mjs';
import {createNativeMemberRuntime} from '../src/member-native-runtime.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'family-native-'));

test('flags default to off when the file is missing or broken', () => {
  const directory = dir();
  try {
    assert.deepEqual(readMemberNativeFlags(directory), {version: 1, people: {}});
    assert.equal(isMemberNative(directory, 'mom'), false);
    writeFileSync(join(directory, 'member-native-flags.json'), '{broken');
    assert.equal(isMemberNative(directory, 'mom'), false);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('a member can be switched on and off again', () => {
  const directory = dir();
  try {
    setMemberNative(directory, 'mom', true);
    assert.equal(isMemberNative(directory, 'mom'), true);
    assert.equal(isMemberNative(directory, 'dad'), false);
    setMemberNative(directory, 'mom', false);
    assert.equal(isMemberNative(directory, 'mom'), false);
    assert.equal(existsSync(join(directory, 'member-native-flags.json')), true);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('flags reject an unsafe member id', () => {
  const directory = dir();
  try {
    assert.throws(() => setMemberNative(directory, '../etc', true), /成员标识无效/);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('the native runtime returns the assistant text from the host handle', async () => {
  const calls = [];
  const runtime = createNativeMemberRuntime({
    createAgent: async input => {
      calls.push(input);
      return {
        sessionId: 'family_member_k',
        prompt: async payload => { calls.push(payload); return true; },
        whenIdle: async () => { calls.push('idle'); },
        lastAssistantText: async () => '好的，已经记下了。',
      };
    },
  });
  const result = await runtime.run({personId: 'k', text: '帮我记住周末买花', history: [{role: 'user', text: '在吗'}]});
  assert.deepEqual(result, {text: '好的，已经记下了。', sessionId: 'family_member_k'});
  assert.equal(calls[0].personId, 'k');
  assert.deepEqual(calls[0].history, [{role: 'user', text: '在吗'}]);
  assert.deepEqual(calls[1], {text: '帮我记住周末买花'});
});

test('the native runtime fails loudly so the caller can fall back', async () => {
  const runtime = createNativeMemberRuntime({createAgent: async () => ({sessionId: 's', prompt: async () => true, lastAssistantText: async () => ''})});
  await assert.rejects(() => runtime.run({personId: 'k', text: '你好'}), /没有产出回复/);
  await assert.rejects(() => runtime.run({personId: '', text: '你好'}), /成员标识无效/);
  await assert.rejects(() => runtime.run({personId: 'k', text: '   '}), /本轮内容为空/);

  const rejecting = createNativeMemberRuntime({createAgent: async () => ({sessionId: 's', prompt: async () => false})});
  await assert.rejects(() => rejecting.run({personId: 'k', text: '你好'}), /拒绝了本轮提交/);

  const broken = createNativeMemberRuntime({createAgent: async () => ({})});
  await assert.rejects(() => broken.run({personId: 'k', text: '你好'}), /没有返回有效会话/);

  assert.throws(() => createNativeMemberRuntime({}), /需要注入 createAgent/);
});
