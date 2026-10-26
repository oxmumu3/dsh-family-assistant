import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntime } from '../src/runtime.mjs';
import { createWeixinApi } from '../src/weixin.mjs';

// Every HTTP request below is intercepted. This is a synthetic API acceptance
// exercise; it never logs in to, sends to, or proves receipt in real WeChat.
const aliases = ['owner', 'dad', 'mom'];
const fixtures = new Map(aliases.map(person => [person, {
  person, token: `fixture-token-${person}`, accountId: `fixture-account-${person}`,
  peerId: `fixture-peer-${person}`, context: `fixture-context-${person}`,
}]));
const byToken = new Map([...fixtures.values()].map(fixture => [fixture.token, fixture]));
const pendingPolls = new Map();
const polled = new Set();
const sends = [];
let loginCount = 0;
let sequence = 0;
const now = '2026-10-21T04:00:00.000Z';
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

async function waitFor(predicate, label) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `演示等待超时：${label}`);
    await delay(2);
  }
}

const fakeFetch = async (input, options = {}) => {
  const url = new URL(input);
  assert.equal(url.origin, 'https://ilinkai.weixin.qq.com');
  assert.equal(options.redirect, 'error');
  const endpoint = url.pathname;
  if (endpoint === '/ilink/bot/get_bot_qrcode') {
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { local_token_list: [] });
    const alias = aliases[loginCount++];
    assert.ok(alias, '演示只允许三个独立登录');
    return json({ qrcode: `fixture-qr-${alias}`, qrcode_img_content: `https://weixin.qq.com/fake-demo-${alias}` });
  }
  if (endpoint === '/ilink/bot/get_qrcode_status') {
    const alias = url.searchParams.get('qrcode')?.replace('fixture-qr-', '');
    const fixture = fixtures.get(alias);
    assert.ok(fixture, '未知的演示登录');
    return json({ status: 'confirmed', bot_token: fixture.token, ilink_bot_id: fixture.accountId,
      ilink_user_id: fixture.peerId, baseurl: url.origin });
  }
  const bearer = options.headers?.Authorization;
  const fixture = byToken.get(bearer?.replace(/^Bearer /, ''));
  assert.ok(fixture, '请求必须使用对应演示账号的独立身份');
  const body = JSON.parse(options.body);
  if (endpoint === '/ilink/bot/getupdates') {
    polled.add(fixture.person);
    assert.ok(!pendingPolls.has(fixture.person), '每人只能有一个轮询');
    return new Promise((resolve, reject) => {
      const signal = options.signal;
      const finish = (value, error) => {
        signal.removeEventListener('abort', abort);
        pendingPolls.delete(fixture.person);
        error ? reject(error) : resolve(json(value));
      };
      const abort = () => finish(null, new DOMException('Aborted', 'AbortError'));
      if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
      signal.addEventListener('abort', abort, { once: true });
      pendingPolls.set(fixture.person, value => finish(value));
    });
  }
  if (endpoint === '/ilink/bot/sendmessage') {
    const message = body.msg;
    assert.equal(message.to_user_id, fixture.peerId, '收件人与凭据必须匹配');
    assert.equal(message.context_token, fixture.context, '上下文必须来自本人的入站轮询');
    const text = message.item_list[0].text_item.text;
    const failed = text === '演示接口明确拒绝';
    sends.push({ person: fixture.person, token: fixture.token, peerId: message.to_user_id,
      context: message.context_token, text, clientId: message.client_id, outcome: failed ? 'failed' : 'api_accepted' });
    return json(failed ? { ret: 4001 } : { ret: 0, message_id: `fixture-sent-${++sequence}` });
  }
  throw new Error('演示拦截了未声明的接口');
};

function inject(person) {
  const fixture = fixtures.get(person);
  const deliver = pendingPolls.get(person);
  assert.ok(deliver, '入站前该通路必须正在轮询');
  deliver({ ret: 0, get_updates_buf: `fixture-cursor-${person}`, msgs: [{
    message_id: `fixture-message-${person}`, from_user_id: fixture.peerId, to_user_id: fixture.accountId,
    message_type: 1, context_token: fixture.context, create_time_ms: Date.parse(now),
    item_list: [{ type: 1, text_item: { text: `仅${person}可见的演示聊天` } }],
  }] });
}

const directory = mkdtempSync(join(tmpdir(), 'dsh-family-demo-'));
let runtime;
let evidence;
try {
  runtime = createRuntime({ directory, api: createWeixinApi({ fetchImpl: fakeFetch }), now: () => now,
    intervalMs: 60_000, respond: async ({ person, history, text }) => {
      assert.ok(history.every(message => message.personId === person.id));
      assert.equal(text, `仅${person.id}可见的演示聊天`);
      return { reply: `${person.id} 的独立演示回复` };
    } });
  for (const person of aliases) runtime.store.addPerson({ id: person, role: person === 'owner' ? 'owner' : 'elder',
    label: `测试 ${person}`, timeZone: 'Asia/Shanghai', shareWithOwner: person === 'owner' ? 'none' : 'summary' });
  await runtime.start();
  for (const person of aliases) await runtime.action({ action: 'login', personId: person });
  await waitFor(() => aliases.every(person => runtime.channels.status(person).connected && pendingPolls.has(person)), '三个独立轮询');
  const threeIndependentLogins = loginCount === 3 && aliases.every(person => {
    const route = runtime.store.route(person);
    return route.accountId === fixtures.get(person).accountId && route.peerId === fixtures.get(person).peerId;
  });
  const threePollersLive = pendingPolls.size === 3 && polled.size === 3;
  for (const person of aliases) inject(person);
  await waitFor(() => runtime.store.snapshot().outbox.filter(row => row.kind === 'reply' && row.status === 'api_accepted').length === 3, '三路独立回复');
  await waitFor(() => pendingPolls.size === 3, '处理后继续独立轮询');
  const independentHistories = aliases.every(person => {
    const messages = runtime.store.messages(person);
    return messages.length === 2 && messages.every(message => message.personId === person) &&
      messages[0].text === `仅${person}可见的演示聊天` && messages[1].text === `${person} 的独立演示回复`;
  });
  const exactReplyRoutes = sends.length === 3 && sends.every(send => {
    const fixture = fixtures.get(send.person);
    return send.token === fixture.token && send.peerId === fixture.peerId && send.context === fixture.context;
  });

  const beforeBrief = sends.length;
  await runtime.action({ action: 'send_brief' });
  const brief = sends.slice(beforeBrief);
  const ownerOnlyBrief = brief.length === 1 && brief[0].person === 'owner' &&
    !brief[0].text.includes('仅dad可见') && !brief[0].text.includes('仅mom可见');

  await runtime.action({ action: 'add_reminder', personId: 'dad', text: '演示定时浇花', dueAt: now, repeat: 'once' });
  await runtime.tick();
  const reminderSend = sends.filter(send => send.text === '提醒：演示定时浇花');
  const elderReminderRoute = reminderSend.length === 1 && reminderSend[0].person === 'dad';

  const momOutBefore = runtime.store.messages('mom').filter(message => message.dir === 'out').length;
  await runtime.action({ action: 'send_message', personId: 'mom', text: '演示接口明确拒绝' });
  const failed = runtime.store.snapshot().outbox.filter(row => row.kind === 'manual');
  const failedSendAccurate = failed.length === 1 && failed[0].status === 'failed' &&
    runtime.store.messages('mom').filter(message => message.dir === 'out').length === momOutBefore;
  await runtime.tick();
  await runtime.tick();
  const failedAttempts = sends.filter(send => send.text === '演示接口明确拒绝').length;
  const noAutomaticRetry = failedAttempts === 1;
  const credentialsPrivate = aliases.every(person => {
    const file = join(directory, 'channels', person, 'auth.json');
    const auth = JSON.parse(readFileSync(file, 'utf8'));
    return (statSync(file).mode & 0o777) === 0o600 && auth.token === fixtures.get(person).token &&
      auth.contextToken === fixtures.get(person).context;
  }) && !JSON.stringify(runtime.status()).includes('fixture-token') &&
    !JSON.stringify(runtime.store.snapshot()).includes('fixture-context');

  const state = runtime.store.snapshot();
  evidence = {
    mode: 'local_fake_weixin', realWeChatDelivery: false, networkRequests: 0,
    checks: { threeIndependentLogins, threePollersLive, independentHistories, exactReplyRoutes, ownerOnlyBrief,
      elderReminderRoute, failedSendAccurate, noAutomaticRetry, credentialsPrivate, closedAndCleaned: false },
    counts: {
      people: state.people.length, logins: loginCount, pollAccounts: polled.size,
      inbound: state.messages.filter(message => message.dir === 'in').length,
      replyApiAccepted: state.outbox.filter(row => row.kind === 'reply' && row.status === 'api_accepted').length,
      briefApiAccepted: state.outbox.filter(row => row.kind === 'owner_brief' && row.status === 'api_accepted').length,
      welcomeApiAccepted: state.outbox.filter(row => row.kind === 'member_welcome' && row.status === 'api_accepted').length,
      reminderApiAccepted: state.outbox.filter(row => row.kind === 'reminder' && row.status === 'api_accepted').length,
      failed: state.outbox.filter(row => row.status === 'failed').length, retries: failedAttempts - 1,
    },
    apiAttempts: sends.map(send => ({ person: send.person, kind: state.outbox.find(row => row.id === send.clientId)?.kind, outcome: send.outcome })),
  };
  for (const [name, value] of Object.entries(evidence.checks)) if (name !== 'closedAndCleaned') assert.equal(value, true, name);
} finally {
  try { if (runtime) await runtime.close(); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
evidence.checks.closedAndCleaned = !existsSync(directory) && pendingPolls.size === 0;
assert.equal(evidence.checks.closedAndCleaned, true);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
