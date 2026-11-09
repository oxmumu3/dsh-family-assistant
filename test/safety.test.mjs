import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';
import {safetyCard} from '../src/safety.mjs';

test('the fixed checklist triggers on a classic transfer scam', () => {
  const card = safetyCard('刚才有人打电话，说我中奖了，让我先转五千到安全账户验证');
  assert.ok(card);
  assert.equal(card.category, '安全账户');
  assert.match(card.reply, /先别转账/);
  assert.match(card.reply, /110/);
  assert.match(card.reply, /转告家里人/);
});

test('a question about scams is a conversation, not a live risk', () => {
  assert.equal(safetyCard('我想问问什么是骗子常用的说法'), null);
  assert.equal(safetyCard('今天新闻里说有人被骗了三万'), null);
});

test('an elder who forwards a scam gets the checklist instead of a model answer', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'safety-'));
  const sent = [];
  const runtime = createRuntime({directory, intervalMs: 600000,
    channelFactory: () => ({status: () => ({status: 'connected'}), connect: async () => {}, disconnect: async () => {}, close: async () => {},
      send: async (route, text) => { sent.push({personId: route.personId, text}); return {status: 'api_accepted'}; }})});
  t.after(async () => { await runtime.close(); rmSync(directory, {recursive: true, force: true}); });
  for (const [id, role, label] of [['owner', 'owner', '我'], ['dad', 'elder', '爸爸']]) {
    runtime.store.addPerson({id, role, label});
    runtime.store.bindPerson(id, {accountId: `bot-${id}`, peerId: `wx-${id}`});
  }
  runtime.store.configure({paused: false});
  runtime.store.recordInbound('dad', {id: 'd0', peerId: 'wx-dad', text: '在吗', at: new Date().toISOString()});
  await runtime.start();
  await runtime.receive('dad', {id: 'd1', peerId: 'wx-dad', text: '有个客服说我快递丢了要理赔，让我给验证码'});
  await runtime.settled();
  const card = runtime.store.snapshot().outbox.find(row => row.kind === 'safety_card');
  assert.ok(card, 'a fixed safety card is queued');
  assert.match(card.text, /先别转账/);
  const told = sent.find(row => row.personId === 'dad' && /先别转账/.test(row.text));
  assert.ok(told, 'and it actually reached dad');
  const inbound = runtime.store.messages('dad').find(row => row.id === 'd1');
  assert.ok(inbound, 'the original message is still on record');
});
