import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchMemberReply, shouldUseNative} from '../src/member-native-dispatch.mjs';

const legacyOk = () => async () => ({reply: '旧链路回复'});

test('the flag alone decides whether the native path is eligible', () => {
  assert.equal(shouldUseNative({enabled: true, available: true}), true);
  assert.equal(shouldUseNative({enabled: false, available: true}), false);
  assert.equal(shouldUseNative({enabled: true, available: false}), false);
});

test('a disabled member keeps the legacy path untouched', async () => {
  let nativeCalls = 0;
  const out = await dispatchMemberReply({enabled: false, native: async () => { nativeCalls += 1; return {reply: 'native'}; }, legacy: legacyOk()});
  assert.equal(out.route, 'legacy');
  assert.equal(out.result.reply, '旧链路回复');
  assert.equal(nativeCalls, 0);
});

test('an enabled member uses the native reply when it is well formed', async () => {
  const out = await dispatchMemberReply({enabled: true, native: async () => ({reply: '原生回复'}), legacy: legacyOk()});
  assert.equal(out.route, 'native');
  assert.equal(out.result.reply, '原生回复');
});

test('a native failure falls back to legacy and reports the reason', async () => {
  const seen = [];
  const out = await dispatchMemberReply({
    enabled: true,
    native: async () => { throw new Error('host unavailable'); },
    legacy: legacyOk(),
    onNativeError: error => seen.push(error.message),
  });
  assert.equal(out.route, 'legacy');
  assert.equal(out.result.reply, '旧链路回复');
  assert.deepEqual(seen, ['host unavailable']);
});

test('an empty or malformed native reply falls back as well', async () => {
  for (const native of [async () => ({reply: '   '}), async () => ({reply: 42}), async () => null]) {
    const out = await dispatchMemberReply({enabled: true, native, legacy: legacyOk()});
    assert.equal(out.route, 'legacy');
    assert.match(out.nativeError?.message ?? '', /没有产出可用回复/);
  }
});

test('a legacy failure still surfaces', async () => {
  await assert.rejects(
    () => dispatchMemberReply({enabled: false, legacy: async () => { throw new Error('legacy down'); }}),
    /legacy down/,
  );
  await assert.rejects(() => dispatchMemberReply({enabled: false}), /缺少旧链路实现/);
});
