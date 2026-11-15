import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, statSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';

import {createHearthPreferences} from '../src/hearth-preferences.mjs';
import {createDeferredMemberNotices} from '../src/deferred-member-notices.mjs';
import {createStore} from '../src/store.mjs';
import {scheduleTick} from '../src/scheduler.mjs';
import {createRuntime} from '../src/runtime.mjs';

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeChannelMock({sent, connections}) {
  return () => ({
    async connect() {},
    async disconnect() {},
    async close() {},
    statuses: () => ({}),
    status: id => ({status: connections?.get(id) ?? 'connected', phase: connections?.get(id) ?? 'connected'}),
    async send(route, text) {
      sent.push({route, text});
      return {status: 'api_accepted'};
    },
  });
}

function walkVdom(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkVdom(child, visit);
    return;
  }
  visit(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) walkVdom(child, visit);
  }
}

function findVdom(node, predicate) {
  let match = null;
  walkVdom(node, cur => {
    if (!match && predicate(cur)) match = cur;
  });
  return match;
}

function vdomText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(vdomText).join('');
  if (typeof node === 'object') return vdomText(node.children);
  return '';
}

test('hearth-preferences persists with 0600 mode, checks overnight and same-day quiet hours, manages habits and skips', () => {
  const dir = makeTempDir('hearth-prefs-');
  try {
    const prefs = createHearthPreferences({directory: dir});
    const g0 = prefs.guard();
    assert.deepEqual(g0.pushRules, {relay: true, ask: true, urgent: true, digest: true});
    assert.equal(g0.quietHoursEnabled, false);

    prefs.updateGuard({quietHoursEnabled: true, quietStart: '22:30', quietEnd: '07:30', pushRules: {relay: false}});
    const fileMode = statSync(join(dir, 'hearth-preferences.json')).mode & 0o777;
    assert.equal(fileMode, 0o600);

    // Asia/Shanghai = UTC+8: 15:15Z -> 23:15 CST, 19:00Z -> 03:00 CST, 04:00Z -> 12:00 CST
    assert.equal(prefs.inQuietHours('2026-11-15T15:15:00.000Z', 'Asia/Shanghai'), true);
    assert.equal(prefs.inQuietHours('2026-11-15T19:00:00.000Z', 'Asia/Shanghai'), true);
    assert.equal(prefs.inQuietHours('2026-11-15T04:00:00.000Z', 'Asia/Shanghai'), false);

    prefs.updateGuard({quietHoursEnabled: true, quietStart: '12:00', quietEnd: '14:00'});
    assert.equal(prefs.inQuietHours('2026-11-15T05:00:00.000Z', 'Asia/Shanghai'), true);
    assert.equal(prefs.inQuietHours('2026-11-15T07:00:00.000Z', 'Asia/Shanghai'), false);

    prefs.updateMember('mom', {pinganEnabled: true, pinganTime: '20:00', codeword: '西湖秋天'});
    const added = prefs.addHabit('mom', {text: '晚饭后散步二十分钟'});
    assert.equal(added.text, '晚饭后散步二十分钟');
    const updated = prefs.updateHabit('mom', {id: added.id, text: '晚饭后散步半小时'});
    assert.equal(updated.text, '晚饭后散步半小时');
    prefs.skipReminder('rem-1', '2026-11-15');
    assert.equal(prefs.isReminderSkipped('rem-1', '2026-11-15'), true);
    assert.equal(prefs.isReminderSkipped('rem-1', '2026-11-16'), false);

    // Reload from disk in a fresh instance
    const reloaded = createHearthPreferences({directory: dir});
    assert.deepEqual(reloaded.guard().pushRules, {relay: false, ask: true, urgent: true, digest: true});
    assert.equal(reloaded.member('mom').pinganEnabled, true);
    assert.equal(reloaded.member('mom').pinganTime, '20:00');
    assert.equal(reloaded.member('mom').codeword, '西湖秋天');
    assert.equal(reloaded.member('mom').ownerHabits.length, 1);
    assert.equal(reloaded.isReminderSkipped('rem-1', '2026-11-15'), true);

    reloaded.unskipReminder('rem-1');
    assert.equal(reloaded.isReminderSkipped('rem-1', '2026-11-15'), false);
    reloaded.deleteHabit('mom', {id: added.id});
    assert.equal(reloaded.member('mom').ownerHabits.length, 0);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('scheduler skips once reminders (cancelled) and daily reminders (advanced to next day) without enqueueing', () => {
  const dir = makeTempDir('hearth-sched-');
  try {
    const store = createStore({directory: dir});
    store.configure({paused: false});
    store.addPerson({id: 'mom', role: 'elder', label: '妈妈', timeZone: 'Asia/Shanghai'});
    store.bindPerson('mom', {accountId: 'bot-mom', peerId: 'wx-mom'});

    const nowIso = '2026-11-15T01:00:00.000Z'; // 09:00 CST on 2026-11-15
    const onceSkipped = store.addReminder({id: 'r-once-skip', personId: 'mom', text: '去社区医院', dueAt: nowIso, repeat: 'once', timeZone: 'Asia/Shanghai'});
    const dailySkipped = store.addReminder({id: 'r-daily-skip', personId: 'mom', text: '测量血压', dueAt: nowIso, repeat: 'daily', time: '09:00', timeZone: 'Asia/Shanghai'});
    const normalOnce = store.addReminder({id: 'r-once-normal', personId: 'mom', text: '喝温水', dueAt: nowIso, repeat: 'once', timeZone: 'Asia/Shanghai'});

    const skippedSet = new Set([onceSkipped.id, dailySkipped.id]);
    const queued = scheduleTick(store, {
      now: nowIso,
      isReminderSkipped: (id, date) => date === '2026-11-15' && skippedSet.has(id),
    });

    assert.equal(queued.length, 1);
    assert.equal(store.snapshot().outbox.length, 1);
    assert.match(store.snapshot().outbox[0].text, /喝温水/);

    const byId = Object.fromEntries(store.reminders('mom').map(r => [r.id, r]));
    assert.equal(byId[onceSkipped.id].status, 'cancelled');
    assert.equal(byId[dailySkipped.id].status, 'active');
    assert.equal(byId[dailySkipped.id].dueAt > nowIso, true);
    assert.equal(byId[normalOnce.id].status, 'completed');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('runtime tick enqueues pingan_keepalive once in the final 4h of the 24h window and stays silent outside it', async t => {
  const dir = makeTempDir('hearth-pingan-');
  t.after(() => rmSync(dir, {recursive: true, force: true}));

  let clock = '2026-11-15T12:00:00.000Z'; // 20:00 CST
  const sent = [];
  const runtime = createRuntime({
    directory: dir,
    now: () => clock,
    intervalMs: 600000,
    respond: async () => ({reply: '收到'}),
    channelFactory: makeChannelMock({sent}),
  });
  t.after(() => runtime.close());

  runtime.store.addPerson({id: 'owner', role: 'owner', label: '我'});
  runtime.store.bindPerson('owner', {accountId: 'bot-owner', peerId: 'wx-owner'});
  runtime.store.addPerson({id: 'mom', role: 'elder', label: '妈妈'});
  runtime.store.bindPerson('mom', {accountId: 'bot-mom', peerId: 'wx-mom'});
  await runtime.start();

  // Disabled or >4h remaining stays silent
  runtime.store.setConnection('mom', {lastInboundAt: '2026-11-15T06:00:00.000Z'}); // 18h left
  await runtime.action({action: 'hearth_member_update', personId: 'mom', pinganEnabled: true, pinganTime: '20:00'});
  await runtime.tick();
  assert.equal(sent.length, 0);

  // Inside final 4h (21h after last inbound -> 3h remaining)
  runtime.store.setConnection('mom', {lastInboundAt: '2026-11-14T15:00:00.000Z'});
  await runtime.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].route.personId, 'mom');
  assert.match(sent[0].text, /问声平安/);
  assert.equal(runtime.store.snapshot().outbox.some(r => r.kind === 'pingan_keepalive' && r.status === 'api_accepted'), true);

  // Deduplicated on second tick same day / same inbound
  clock = '2026-11-15T12:05:00.000Z';
  await runtime.tick();
  assert.equal(sent.length, 1);

  // Disabled toggle prevents keepalive on a fresh date & inbound
  await runtime.action({action: 'hearth_member_update', personId: 'mom', pinganEnabled: false});
  clock = '2026-11-16T12:00:00.000Z';
  runtime.store.setConnection('mom', {lastInboundAt: '2026-11-15T15:00:00.000Z'});
  await runtime.tick();
  assert.equal(sent.length, 1);
});

test('runtime push guardrails, quiet hours, deferred notices, habits and privacy redaction work end-to-end', async t => {
  const dir = makeTempDir('hearth-guard-');
  t.after(() => rmSync(dir, {recursive: true, force: true}));

  let clock = '2026-11-15T04:00:00.000Z'; // 12:00 CST (daytime)
  const sent = [];
  const runtime = createRuntime({
    directory: dir,
    now: () => clock,
    intervalMs: 600000,
    classifyImportantEvent: async input => ({
      decision: 'notify',
      urgency: 'soon',
      category: 'needs_help',
      relatedIncidentId: null,
      subject: 'self',
      eventState: 'current',
      evidence: [{messageId: input.message.id, quote: input.message.text}],
      clarificationKind: null,
    }),
    respond: async ({text}) => {
      if (text.includes('转告')) {
        return {
          reply: '好的，我记下了。',
          action: {type: 'relay', text: '明天上午去医院拿药', evidence: text},
        };
      }
      return {reply: '收到，我在。'};
    },
    channelFactory: makeChannelMock({sent}),
  });
  t.after(() => runtime.close());

  runtime.store.addPerson({id: 'owner', role: 'owner', label: '我', timeZone: 'Asia/Shanghai'});
  runtime.store.bindPerson('owner', {accountId: 'bot-owner', peerId: 'wx-owner'});
  runtime.store.setConnection('owner', {lastInboundAt: clock});

  runtime.store.addPerson({id: 'mom', role: 'elder', label: '妈妈', shareWithOwner: 'full', timeZone: 'Asia/Shanghai'});
  runtime.store.bindPerson('mom', {accountId: 'bot-mom', peerId: 'wx-mom'});
  runtime.store.setConnection('mom', {lastInboundAt: clock});

  runtime.store.addPerson({id: 'dad', role: 'elder', label: '爸爸', shareWithOwner: 'none', timeZone: 'Asia/Shanghai'});
  runtime.store.bindPerson('dad', {accountId: 'bot-dad', peerId: 'wx-dad'});
  runtime.store.setConnection('dad', {lastInboundAt: clock});

  await runtime.start();
  await runtime.action({action: 'attention_configure', enabled: true});

  // 1. digest: false syncs ownerBriefEnabled and cancels pending scheduled owner_brief; relay: false keeps undeliverable_notice pending without pushing
  const briefRow = runtime.store.enqueue({personId: 'owner', kind: 'owner_brief', sourceKey: 'owner-brief:2026-11-15', text: '今日简报'});
  await runtime.action({action: 'hearth_guard_update', relay: false, ask: false, digest: false});
  assert.equal(runtime.status().config.ownerBriefEnabled, false);
  assert.equal(runtime.status().hearth.guard.pushRules.digest, false);
  assert.equal(runtime.store.snapshot().outbox.find(r => r.id === briefRow.id)?.status, 'cancelled');

  // Trigger undeliverable_notice when mom's proactive reminder expires outside the 24h window
  runtime.store.setConnection('mom', {lastInboundAt: '2026-11-10T00:00:00.000Z'});
  runtime.store.enqueue({personId: 'mom', kind: 'reminder', sourceKey: 'reminder:r-relay:2026-11-15T03:00:00.000Z', text: '提醒：记得明天量血压', expiresAt: '2026-11-15T03:59:00.000Z'});
  await runtime.tick();
  await runtime.settled();
  await runtime.tick();
  await runtime.settled();
  assert.equal(runtime.status().relay.length, 1);
  const relayItem = runtime.status().relay[0];
  assert.equal(sent.filter(x => x.route.personId === 'owner').length, 0, 'relay=false suppresses owner WeChat push');

  // Re-open mom's 24h window for subsequent tests
  clock = '2026-11-15T04:01:00.000Z';
  runtime.store.setConnection('mom', {lastInboundAt: clock});

  // 2. defer_and_dismiss_relay cancels pending relay and registers deferred notice; cancel_deferred_notice cancels it
  await runtime.action({action: 'defer_and_dismiss_relay', relayId: relayItem.id, personId: 'mom', text: '明天量血压'});
  assert.equal(runtime.status().relay.length, 0);
  assert.equal(runtime.status().hearth.deferredNotices.length, 1);
  assert.equal(runtime.status().hearth.deferredNotices[0].text, '明天量血压');
  const deferredId = runtime.status().hearth.deferredNotices[0].id;
  await runtime.action({action: 'cancel_deferred_notice', personId: 'mom', id: deferredId});
  assert.equal(runtime.status().hearth.deferredNotices.length, 0);

  // 3. ask: false blocks family_request & workflow_request WeChat pushes while keeping requests open
  await runtime.action({action: 'hearth_guard_update', urgent: false});
  await runtime.receive('mom', {id: 'm-wf-req', peerId: 'wx-mom', text: '申请工具：每天查老家天气', at: clock});
  await runtime.receive('mom', {id: 'm-relay-req', peerId: 'wx-mom', text: '请帮我转告孩子明天上午去医院拿药', at: clock});
  await runtime.settled();
  assert.equal(sent.filter(x => x.route.personId === 'owner').length, 0, 'ask=false suppresses WeChat push');
  assert.equal(runtime.status().hearth.workflowRequests.length, 1);
  assert.equal(runtime.status().workbench.requests.length, 1);

  // 4. quietHoursEnabled suppresses relay/ask/digest pushes while urgent important_event bypasses quiet hours
  await runtime.action({action: 'hearth_guard_update', urgent: true, relay: true, ask: true, digest: true, quietHoursEnabled: true, quietStart: '00:00', quietEnd: '23:59'});
  assert.equal(runtime.status().hearth.guard.inQuietHours, true);

  clock = '2026-11-15T04:02:00.000Z';
  await runtime.receive('mom', {id: 'm-quiet-ask', peerId: 'wx-mom', text: '请帮我转告孩子明天上午来拿钥匙', at: clock});
  await runtime.settled();
  assert.equal(sent.filter(x => x.route.personId === 'owner').some(x => x.text.includes('转告')), false, 'ask blocked during quiet hours');

  clock = '2026-11-15T04:02:30.000Z';
  await runtime.receive('mom', {id: 'm-urgent-fall', peerId: 'wx-mom', text: '我现在摔倒在地上需要帮忙', at: clock});
  await runtime.settled();
  const ownerSent = sent.filter(x => x.route.personId === 'owner');
  assert.equal(ownerSent.some(x => x.text.includes('要紧的事')), true, 'urgent important_event bypasses quiet hours');

  // 5. Habits CRUD + shareWithOwner=none privacy redaction + honest api_accepted wording
  await runtime.action({action: 'hearth_habit_save', personId: 'mom', text: '每周三提醒去社区量血糖'});
  const habits = runtime.status().hearth.members.mom.ownerHabits;
  assert.equal(habits.length, 1);
  await runtime.action({action: 'hearth_habit_delete', personId: 'mom', id: habits[0].id});
  assert.equal(runtime.status().hearth.members.mom.ownerHabits.length, 0);

  clock = '2026-11-15T04:03:00.000Z';
  await runtime.receive('dad', {id: 'd-secret', peerId: 'wx-dad', text: '我的私密家事内容不要给孩子看', at: clock});
  await runtime.settled();
  const st = runtime.status();
  assert.equal(st.hearth.members.dad.privacyProtected, true);
  assert.deepEqual(st.hearth.members.dad.recentMessages, []);
  const dadAct = st.hearth.recentActivity.find(a => a.personId === 'dad');
  assert.ok(dadAct);
  assert.equal(dadAct.statusLabel, '已提交微信接口');
  assert.doesNotMatch(JSON.stringify(st.hearth.recentActivity), /已送达|私密家事/);
});

test('deferred-member-notices supports list text and cancel()', () => {
  const dir = makeTempDir('hearth-defer-');
  try {
    const store = createStore({directory: join(dir, 'store')});
    store.addPerson({id: 'owner', role: 'owner', label: '我'});
    store.addPerson({id: 'mom', role: 'elder', label: '妈妈'});
    store.bindPerson('mom', {accountId: 'bot-mom', peerId: 'wx-mom'});
    const deferred = createDeferredMemberNotices({directory: dir, store, now: () => '2026-11-15T04:00:00.000Z'});
    const reg = deferred.register({personId: 'mom', requestId: 'req-1', bindingGeneration: 1, text: '提醒妈妈休息'});
    assert.equal(reg.status, 'waiting');
    assert.equal(reg.text, '提醒妈妈休息');
    const list1 = deferred.list().notices;
    assert.equal(list1.length, 1);
    assert.equal(list1[0].text, '提醒妈妈休息');
    const cancelled = deferred.cancel({personId: 'mom', id: list1[0].id});
    assert.equal(cancelled.cancelled, true);
    assert.equal(deferred.list().notices.length, 0);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('runtime owner_conversation_open auto-provisions default Owner on empty store with zero elders', async () => {
  const dir = makeTempDir('hearth-autoprovision-');
  const workspace = {workspaceId: 'owner-control', title: 'Owner', path: join(dir, 'control'), sessionIds: []};
  const runtime = createRuntime({
    directory: join(dir, 'private'),
    intervalMs: 600000,
    ownerAgent: {
      async ensureControlWorkspace() { return structuredClone(workspace); },
      async listWorkspaces() { return [structuredClone(workspace)]; },
      async ensureSession(intent) { return {sessionId: intent.sessionId, created: true}; },
      async start() { return {state: 'succeeded'}; },
      async observe() { return {state: 'succeeded'}; },
    },
    channelFactory: makeChannelMock({sent: []}),
  });
  try {
    assert.equal(runtime.store.snapshot().people.length, 0);
    const res = await runtime.action({action: 'owner_conversation_open'});
    assert.match(res.ownerConversation.sessionId, /^family_owner_[a-f0-9-]{36}$/);
    const people = runtime.store.snapshot().people;
    assert.equal(people.length, 1);
    assert.equal(people[0].role, 'owner');
    assert.equal(people[0].label, '我');
    assert.equal(people.filter(p => p.role !== 'owner').length, 0);
  } finally {
    await runtime.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

async function mountHearthVdom(controlPayload, {openOk = true} = {}) {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  const sessionId = 'family_owner_ee000000-0000-4000-8000-000000000099';
  const storage = new Map();
  const sessionStorage = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k),
  };
  const binding = {
    sessionId,
    ctx: {get: name => (name === 'conversation' ? {input: {requestDraftInitialization: () => ({status: 'populated'})}} : undefined)},
  };
  const reference = {ready: Promise.resolve(), binding, release() {}};
  const states = [];
  const effects = [];
  let stateIdx = 0;
  let firstRender = true;

  const React = {
    createElement: (type, props, ...children) => ({type, props: props || {}, children}),
    useState: init => {
      const i = stateIdx++;
      if (!(i in states)) states[i] = typeof init === 'function' ? init() : init;
      return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }];
    },
    useEffect: fn => {
      if (firstRender) effects.push(fn);
    },
  };

  const SessionProvider = ({children}) => ({type: 'session-provider', props: {}, children: [children]});
  const renderSlot = name => ({type: 'slot-marker', props: {'data-slot': name}, children: []});

  let definition;
  const windowObj = {
    __ModuleLoader__: {load: value => { definition = value; }},
    sessionStorage,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    Date,
    matchMedia: () => ({matches: false, addEventListener: () => {}, removeEventListener: () => {}}),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const documentObj = {
    documentElement: {classList: {contains: () => false}, getAttribute: () => null, dataset: {}},
    body: {classList: {contains: () => false}, getAttribute: () => null, dataset: {}},
    getElementById: () => null,
  };

  const fetchFn = async (url, init = {}) => {
    if (init.method === 'POST') {
      const body = JSON.parse(String(init.body || '{}'));
      if (body.action === 'owner_conversation_open') {
        if (!openOk) return {ok: false, status: 500, json: async () => ({error: 'open failed'}), text: async () => 'open failed'};
        return {ok: true, json: async () => ({ownerConversation: {sessionId, policy: 'active'}}), text: async () => '{}'};
      }
      return {ok: true, json: async () => controlPayload, text: async () => JSON.stringify(controlPayload)};
    }
    return {ok: true, json: async () => controlPayload, text: async () => JSON.stringify(controlPayload)};
  };
  windowObj.fetch = fetchFn;

  const registered = [];
  const ctxObj = {
    effect: fn => fn(),
    slots: {
      inject: (_name, fn) => fn(),
      register: (meta, component) => {
        registered.push({...meta, component});
        return () => {};
      },
    },
    events: {on: () => () => {}, emit: () => {}},
    sessions: {retain: () => reference},
  };
  const plugin = runInNewContext(source, {
    window: windowObj,
    document: documentObj,
    globalThis: windowObj,
    fetch: fetchFn,
    sessionStorage,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval: windowObj.setInterval,
    clearInterval: windowObj.clearInterval,
    Date,
    URL,
    Intl,
    MutationObserver: class { observe() {} disconnect() {} },
  });
  const resolved = definition || plugin;
  const built = typeof resolved?.factory === 'function' ? resolved.factory(() => React) : resolved;
  if (typeof built?.apply === 'function') built.apply(ctxObj);
  const main = registered.find(s => s.name === 'main');
  assert.ok(main, 'main slot must exist');

  const render = () => {
    stateIdx = 0;
    const tree = main.component({
      SessionProvider,
      renderSlot,
      session: {getSession: () => reference, createSession: async () => sessionId},
    });
    firstRender = false;
    return tree;
  };

  render();
  for (const eff of effects) {
    try { eff(); } catch {}
  }
  await new Promise(r => setTimeout(r, 30));
  return {tree: render(), render, sessionId};
}

test('src/client.js VDOM renders Warm Editorial Hearth workbench in nativeCapable mode with tabs, focus-first inbox, 24h timeline without 我, zero-elder hero, and floating cat dock', async () => {
  const sessionId = 'family_owner_ee000000-0000-4000-8000-000000000099';
  const mountHearth = mountHearthVdom;

  // Case A: 0 elders -> Hero onboarding card, tabs, steward orb, no legacy "家人状态"
  const zeroPayload = {
    config: {paused: false, ownerBriefEnabled: true, ownerBriefTime: '20:00'},
    people: [{id: 'owner', role: 'owner', label: '我', timeZone: 'Asia/Shanghai', binding: {status: 'connected'}, reach: {state: 'open', remainingMs: 80000000}}],
    reminders: [],
    relay: [],
    attention: {enabled: true, incidents: []},
    workbench: {requests: []},
    ownerConversation: {sessionId, policy: 'active'},
    hearth: {
      guard: {pushRules: {relay: true, ask: true, urgent: true, digest: true}, quietHoursEnabled: false, quietStart: '22:30', quietEnd: '07:30', inQuietHours: false},
      deferredNotices: [],
      workflowRequests: [],
      skippedReminders: {},
      members: {},
      recentActivity: [],
    },
  };
  const zero = await mountHearth(zeroPayload);
  const zeroText = vdomText(zero.tree);
  assert.match(zeroText, /家里/);
  assert.match(zeroText, /家人/);
  assert.match(zeroText, /微信与守则/);
  assert.match(zeroText, /先接上第一位家人/);
  assert.doesNotMatch(zeroText, /家人状态/);
  assert.ok(findVdom(zero.tree, n => String(n.props?.className || '').includes('hearth-workbench')));
  assert.ok(findVdom(zero.tree, n => String(n.props?.className || '').includes('hearth-dock')));
  assert.ok(findVdom(zero.tree, n => String(n.props?.className || '').includes('lele-orb-btn')));
  assert.ok(findVdom(zero.tree, n => String(n.props?.className || '').includes('whisper-chip')));

  // Case B: Populated family -> Focus-First inbox, [data-family-band] without "我", nudge + whisper + dock toggle
  const popPayload = {
    ...zeroPayload,
    people: [
      ...zeroPayload.people,
      {id: 'mom', role: 'elder', label: '妈妈', timeZone: 'Asia/Shanghai', shareWithOwner: 'full', binding: {status: 'connected'}, reach: {state: 'open', remainingMs: 43200000, label: '剩 12 小时'}},
    ],
    relay: [{id: 'rel-1', personId: 'mom', personLabel: '妈妈', text: '没送达的提醒：「记得按时吃降压药」', at: '2026-11-15T03:00:00.000Z'}],
    reminders: [{id: 'rem-1', personId: 'mom', text: '晚上吃降压药', dueAt: '2026-11-15T11:30:00.000Z', repeat: 'daily', time: '19:30', status: 'active', timeZone: 'Asia/Shanghai'}],
    hearth: {
      ...zeroPayload.hearth,
      members: {
        mom: {pinganEnabled: true, pinganTime: '20:00', codeword: '西湖秋天', ownerHabits: [{id: 'h1', text: '少说教多哄着'}], tools: [], assignments: [], access: null, presentationEnabled: false, diaryCount: 2, privacyProtected: false, recentMessages: []},
      },
      recentActivity: [{id: 'act-1', personId: 'mom', personLabel: '妈妈', at: '2026-11-15T02:00:00.000Z', status: 'api_accepted', statusLabel: '已提交微信接口', summary: '早上问候与天气'}],
    },
  };
  const pop = await mountHearth(popPayload);
  const popTree = pop.tree;
  const popText = vdomText(popTree);
  assert.doesNotMatch(popText, /家人状态/);
  assert.ok(findVdom(popTree, n => String(n.props?.className || '').includes('inbox-sheet')));
  const band = findVdom(popTree, n => n.props && n.props['data-family-band'] === true);
  assert.ok(band, 'data-family-band timeline must render');
  const bandText = vdomText(band);
  assert.match(bandText, /妈妈/);
  const bandNames = [];
  walkVdom(band, n => {
    if (String(n.props?.className || '').split(/\s+/).includes('person-name')) bandNames.push(vdomText(n));
  });
  assert.deepEqual(bandNames, ['妈妈']);
  assert.ok(findVdom(popTree, n => String(n.props?.className || '').includes('lele-nudge')));

  // Switch to 家人 and 微信与守则 tabs cleanly
  const peopleTabBtn = findVdom(popTree, n => n.type === 'button' && n.props?.role === 'tab' && vdomText(n).includes('家人'));
  assert.ok(peopleTabBtn);
  peopleTabBtn.props.onClick();
  const peopleTree = pop.render();
  assert.match(vdomText(peopleTree), /24小时防断联「平安问候」/);
  assert.match(vdomText(peopleTree), /少说教多哄着/);

  const wechatTabBtn = findVdom(peopleTree, n => n.type === 'button' && n.props?.role === 'tab' && vdomText(n).includes('微信与守则'));
  assert.ok(wechatTabBtn);
  wechatTabBtn.props.onClick();
  const wechatTree = pop.render();
  assert.match(vdomText(wechatTree), /什么时候微信找我/);
  assert.doesNotMatch(vdomText(wechatTree), /家人状态/);

  const homeTabBtn = findVdom(wechatTree, n => n.type === 'button' && n.props?.role === 'tab' && vdomText(n).includes('家里'));
  homeTabBtn.props.onClick();
  const backHome = pop.render();

  // Click .lele-orb-btn -> whisper popover opens; click 展开完整对话 -> dock opens
  const orbBtn = findVdom(backHome, n => String(n.props?.className || '').includes('lele-orb-btn'));
  orbBtn.props.onClick();
  const afterOrb = pop.render();
  assert.ok(findVdom(afterOrb, n => String(n.props?.className || '').includes('lele-whisper')));

  const expandBtn = findVdom(afterOrb, n => n.type === 'button' && vdomText(n) === '展开完整对话');
  assert.ok(expandBtn);
  expandBtn.props.onClick();
  const afterExpand = pop.render();
  assert.ok(findVdom(afterExpand, n => String(n.props?.className || '').includes('hearth-dock') && String(n.props?.className || '').includes('is-open')));
});

test('src/client.js keeps Hearth workbench mounted with zero iframe when native conversation fails to open', async () => {
  const emptyPayload = {
    config: {paused: true, ownerBriefEnabled: true, ownerBriefTime: '20:00'},
    people: [],
    reminders: [],
    relay: [],
    attention: {enabled: true, incidents: []},
    workbench: {requests: []},
    ownerConversation: null,
    hearth: {
      guard: {pushRules: {relay: true, ask: true, urgent: true, digest: true}, quietHoursEnabled: false, quietStart: '22:30', quietEnd: '07:30', inQuietHours: false},
      deferredNotices: [],
      workflowRequests: [],
      skippedReminders: {},
      members: {},
      recentActivity: [],
    },
  };
  const failed = await mountHearthVdom(emptyPayload, {openOk: false});
  assert.ok(findVdom(failed.tree, n => String(n.props?.className || '').includes('hearth-workbench')));
  assert.equal(findVdom(failed.tree, n => n.type === 'iframe'), null);
  const dockBody = findVdom(failed.tree, n => String(n.props?.className || '').includes('dock-session-body'));
  assert.ok(dockBody, 'dock session body must still render');
  assert.match(vdomText(dockBody), /重试连接/);
});
