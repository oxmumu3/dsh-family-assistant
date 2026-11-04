import test from 'node:test';
import assert from 'node:assert/strict';
import {createIlinkAccounts} from '../src/ilink/accounts.mjs';

const reply = body => ({ok: true, status: 200, text: async () => JSON.stringify(body)});
const base = {baseUrl: 'https://ilinkai.weixin.qq.com', token: 'token-a', peerId: 'peer-a', clientId: 'c-a'};
const bodyOf = options => JSON.parse(options?.body ?? '{}');

test('an unregistered account is rejected instead of falling back to another account', async () => {
  const accounts = createIlinkAccounts({fetchImpl: async () => reply({ret: 0})});
  accounts.register('a', base);
  await assert.rejects(() => accounts.send('b', {text: '你好'}), /未注册/);
  await assert.rejects(() => accounts.poll('b'), /未注册/);
  assert.throws(() => accounts.register('', base), /账号标识无效/);
});

test('two accounts keep separate credentials, peers and hosts', async () => {
  const calls = [];
  const accounts = createIlinkAccounts({fetchImpl: async (url, options) => {
    calls.push({url: String(url), body: bodyOf(options)});
    return reply({ret: 0, message_id: '1'});
  }});
  accounts.register('a', base);
  accounts.register('b', {baseUrl: 'https://ilinkai2.weixin.qq.com', token: 'token-b', peerId: 'peer-b', clientId: 'c-b'});
  await accounts.send('a', {text: '给 A'});
  await accounts.send('b', {text: '给 B'});
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /ilinkai\.weixin\.qq\.com/);
  assert.match(calls[1].url, /ilinkai2\.weixin\.qq\.com/);
  assert.equal(calls[0].body.msg.to_user_id, 'peer-a');
  assert.equal(calls[1].body.msg.to_user_id, 'peer-b');
  assert.equal(calls[1].body.msg.client_id, 'c-b');
});

test('poll cursors advance per account and never cross over', async () => {
  const seen = [];
  const accounts = createIlinkAccounts({fetchImpl: async (_url, options) => {
    const cursor = bodyOf(options).get_updates_buf ?? '';
    seen.push(cursor);
    return reply({ret: 0, get_updates_buf: cursor ? `${cursor}-more` : `next-${seen.length}`});
  }});
  accounts.register('a', base);
  accounts.register('b', base);
  assert.equal((await accounts.poll('a')).cursor, 'next-1');
  assert.equal((await accounts.poll('b')).cursor, 'next-2');
  assert.equal((await accounts.poll('a')).cursor, 'next-1-more');
  assert.equal((await accounts.poll('b')).cursor, 'next-2-more');
  assert.deepEqual(seen, ['', '', 'next-1', 'next-2']);
});

test('re-registering an account bumps its generation and drops the old cursor', async () => {
  const accounts = createIlinkAccounts({fetchImpl: async () => reply({ret: 0, get_updates_buf: 'first'})});
  assert.equal(accounts.register('a', base).generation, 1);
  await accounts.poll('a');
  assert.equal(accounts.register('a', base).generation, 2);
  const row = accounts.snapshot().find(item => item.accountId === 'a');
  assert.equal(row.hasCursor, false);
  assert.equal(row.hasPeer, true);
});

test('the snapshot never exposes credentials', () => {
  const accounts = createIlinkAccounts({fetchImpl: async () => reply({ret: 0})});
  accounts.register('a', {...base, token: 'super-secret-token'});
  const text = JSON.stringify(accounts.snapshot());
  assert.doesNotMatch(text, /super-secret-token/);
  assert.match(text, /"hasPeer":true/);
});

test('a send without a bound peer fails loudly', async () => {
  const accounts = createIlinkAccounts({fetchImpl: async () => reply({ret: 0})});
  accounts.register('a', {baseUrl: base.baseUrl, token: base.token});
  await assert.rejects(() => accounts.send('a', {text: '在吗'}), /还没有绑定联系人/);
});
