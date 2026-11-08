import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {createStore} from '../src/store.mjs';
import {createHarnessGateway} from '../src/harness-gateway.mjs';
import {createConsoleConversationStore, validConsoleConversation} from '../src/owner-console-conversation.mjs';

const conversationId = 'dd000000-0000-4000-8000-000000000001';
const sessionId = 'family_owner_' + conversationId;
const nativeId = 'aa000000-0000-4000-8000-0000000000aa';
const earlierId = 'aa000000-0000-4000-8000-0000000000a1';
const denied = error => error?.code === 'gateway_owner_tool_forbidden';

function fixture(t, {probe = {}, observed = {}, anchor = true, role = 'owner', withActive = true} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'owner-native-console-synthetic-'));
  const store = createStore({directory: join(directory, 'store')});
  store.addPerson({id: 'owner', role, label: 'owner'});
  store.bindPerson('owner', {accountId: 'account-owner', peerId: 'peer-owner'});
  store.configure({paused: false});
  const cwd = join(directory, 'control');
  const calls = {observe: [], active: []};
  const base = intent => ({workspaceId: intent.workspaceId, sessionId: intent.sessionId, cwd: intent.cwd, requestId: intent.requestId});
  const ownerAgent = {
    listWorkspaces: async () => [{workspaceId: 'control', title: 'Owner', path: cwd, sessionIds: [sessionId]}],
    start: async () => ({state: 'running'}),
    observe: async intent => {
      calls.observe.push(structuredClone(intent));
      return {...base(intent), state: 'running', requestSeen: true, queued: false, foreign: false, turn: 7, activeTurn: 7, activeRequestIds: [nativeId],
        requestSourceKind: 'user', requestText: '帮我看看妈妈今天说了什么',
        previousHumanRequest: {requestId: earlierId, text: '先给妈妈起草一条问候'},
        events: [{type: 'tool/call', seq: 30, turn: 7, name: 'family_assistant', callId: 'native-call', status: 'running'}], ...observed};
    },
    ...(withActive ? {observeActive: async intent => {
      calls.active.push(structuredClone(intent));
      return {...base(intent), state: 'queued', requestSeen: false, queued: false, foreign: false, activeTurn: 7, activeRequestIds: [nativeId], events: [], ...probe};
    }} : {}),
  };
  const consoleConversation = () => anchor ? {version: 1, personId: 'owner', conversationId, sessionId, workspaceId: 'control', cwd, createdAt: '2026-11-08T08:00:00.000Z'} : null;
  const gateway = createHarnessGateway({directory, store, ownerAgent, consoleConversation, recoverOnCreate: false});
  const context = (patch = {}) => gateway.ownerToolContext({personId: 'owner', sessionId, callId: 'native-call', ...patch});
  t.after(async () => { await gateway.close(); rmSync(directory, {recursive: true, force: true}); });
  return {directory, store, gateway, ownerAgent, calls, context, cwd};
}

test('a request typed into the embedded desktop conversation gets Owner tool authority from the Host record', async t => {
  const f = fixture(t);
  const context = await f.context();
  assert.equal(context.nativeConsole, true);
  assert.equal(context.origin, 'console');
  assert.equal(context.route, null);
  assert.equal(context.personId, 'owner');
  assert.equal(context.requestId, nativeId);
  assert.equal(context.sourceRequestId, 'native-console:' + nativeId);
  assert.equal(context.userText, '帮我看看妈妈今天说了什么');
  assert.equal(context.previousSourceRequestId, 'native-console:' + earlierId);
  assert.equal(context.previousUserText, '先给妈妈起草一条问候');
  assert.equal(context.authorize(), true);
  assert.equal(f.calls.active.length, 1, 'one bounded probe for the live turn');
  assert.notEqual(f.calls.active[0].requestId, nativeId, 'the probe never claims a request id');
  assert.equal(f.calls.observe.at(-1).requestId, nativeId);
  assert.equal(f.gateway.consoleConversation({personId: 'owner'}).sessionId, sessionId);
});

test('the authority stops when the Owner role or desktop anchor changes', async t => {
  let anchored = true;
  const f = fixture(t);
  const directory = mkdtempSync(join(tmpdir(), 'owner-native-console-anchor-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const gateway = createHarnessGateway({directory, store: f.store, ownerAgent: f.ownerAgent, recoverOnCreate: false,
    consoleConversation: () => anchored ? {version: 1, personId: 'owner', conversationId, sessionId, workspaceId: 'control', cwd: f.cwd, createdAt: '2026-11-08T08:00:00.000Z'} : null});
  t.after(() => gateway.close());
  const context = await gateway.ownerToolContext({personId: 'owner', sessionId, callId: 'native-call'});
  assert.equal(context.authorize(), true);
  anchored = false;
  assert.equal(context.authorize(), false);
});

for (const [kind, options] of [
  ['no desktop conversation', {anchor: false}],
  ['a member identity', {role: 'elder'}],
  ['a Host without the live-turn probe', {withActive: false}],
  ['no live turn', {probe: {activeTurn: null, activeRequestIds: []}}],
  ['two requests in one live turn', {probe: {activeRequestIds: [nativeId, earlierId]}}],
  ['a non-uuid request id', {probe: {activeRequestIds: ['forged']}}],
  ['a Host context message instead of a human request', {observed: {requestSourceKind: 'agent-instructions'}}],
  ['an empty human request', {observed: {requestText: ''}}],
  ['an unseen request', {observed: {requestSeen: false}}],
  ['a queued request', {observed: {queued: true}}],
  ['foreign same-turn input', {observed: {foreign: true}}],
  ['a finished request', {observed: {state: 'succeeded'}}],
  ['a different turn', {observed: {turn: 8}}],
  ['a different active request', {observed: {activeRequestIds: [earlierId]}}],
  ['missing tool proof', {observed: {events: []}}],
  ['another tool call', {observed: {events: [{type: 'tool/call', turn: 7, callId: 'other-call', status: 'running'}]}}],
  ['a finished tool call', {observed: {events: [{type: 'tool/call', turn: 7, callId: 'native-call', status: 'completed'}]}}],
  ['a different session in the observation', {observed: {sessionId: 'family_owner_forged'}}],
  ['a different directory in the observation', {observed: {cwd: '/unrelated'}}],
]) test(`desktop conversation authority rejects ${kind}`, async t => {
  const f = fixture(t, options);
  await assert.rejects(() => f.context(), denied);
});

test('a WeChat or forged session name never takes the desktop path', async t => {
  const f = fixture(t);
  await assert.rejects(() => f.context({sessionId: 'family_owner_ee000000-0000-4000-8000-000000000009'}), denied);
  await assert.rejects(() => f.context({sessionId: 'session-forged'}), denied);
  assert.equal(f.calls.active.length, 0, 'no Host read for an unrelated session');
});

test('a request the plugin itself submitted keeps its task authority instead of the desktop path', async t => {
  const f = fixture(t, {observed: {}});
  const task = await f.gateway.submit({personId: 'owner', route: null, origin: 'console', workspaceId: 'control', conversationId, prompt: '当前 Owner 请求原文：\n从工作台发来的请求', requestId: 'console-source'});
  await f.gateway.settled();
  // The plugin task is still active, so the durable task path answers.
  f.ownerAgent.observe = async intent => ({workspaceId: intent.workspaceId, sessionId: intent.sessionId, cwd: intent.cwd, requestId: intent.requestId, state: 'running', requestSeen: true, queued: false, foreign: false, turn: 2, activeTurn: 2, activeRequestIds: [task.requestId], events: [{type: 'tool/call', turn: 2, callId: 'native-call', status: 'running'}]});
  const context = await f.context();
  assert.equal(context.nativeConsole, undefined);
  assert.equal(context.taskId, task.id);
  assert.equal(context.sourceRequestId, 'console-source');
});

async function settledConsoleTask(f, prompt, requestId) {
  f.ownerAgent.start = async () => ({state: 'succeeded', text: '已完成'});
  const task = await f.gateway.submit({personId: 'owner', route: null, origin: 'console', workspaceId: 'control', conversationId, prompt, requestId});
  await f.gateway.settled();
  const row = f.gateway.snapshot({personId: 'owner'}).find(item => item.id === task.id);
  assert.equal(row.state, 'succeeded', 'the plugin task is settled, so only the desktop path can answer');
  return task;
}

test('a plugin-submitted request id cannot be replayed through the desktop path', async t => {
  const f = fixture(t);
  const task = await settledConsoleTask(f, '当前 Owner 请求原文：\n已完成的旧请求', 'console-old');
  f.ownerAgent.observeActive = async intent => ({workspaceId: intent.workspaceId, sessionId: intent.sessionId, cwd: intent.cwd, requestId: intent.requestId, activeTurn: 9, activeRequestIds: [task.requestId]});
  await assert.rejects(() => f.context(), denied);
});

test('a previous plugin turn maps to its own source request id for draft confirmation', async t => {
  const f = fixture(t);
  const task = await settledConsoleTask(f, '当前 Owner 请求原文：\n帮我起草发给妈妈的话', 'console-draft');
  const original = f.ownerAgent.observe;
  f.ownerAgent.observe = async intent => ({...await original(intent), previousHumanRequest: {requestId: task.requestId, text: 'host text is not used for plugin turns'}});
  const context = await f.context();
  assert.equal(context.nativeConsole, true);
  assert.equal(context.previousSourceRequestId, 'console-draft');
  assert.equal(context.previousUserText, '帮我起草发给妈妈的话');
});

test('the desktop conversation anchor stores identifiers only, atomically and privately', t => {
  const directory = mkdtempSync(join(tmpdir(), 'owner-console-store-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const store = createConsoleConversationStore({directory, now: () => '2026-11-08T08:00:00.000Z'});
  assert.equal(store.read(), null);
  const anchor = store.create({personId: 'owner', workspaceId: 'control', cwd: '/tmp/control'});
  assert.ok(validConsoleConversation(anchor));
  assert.equal(anchor.sessionId, 'family_owner_' + anchor.conversationId);
  store.write(anchor);
  const file = join(directory, 'owner-console-conversation.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort(), ['conversationId', 'createdAt', 'cwd', 'personId', 'sessionId', 'version', 'workspaceId']);
  assert.deepEqual(createConsoleConversationStore({directory}).read(), anchor);
  assert.throws(() => store.write({...anchor, sessionId: 'family_owner_other'}), /格式无效/);
  writeFileSync(file, '{"version":1,"sessionId":"session-forged"}');
  assert.equal(createConsoleConversationStore({directory}).read(), null, 'a tampered file is ignored, not trusted');
});

test('the Host panel embeds the native conversation through a session-scoped child slot', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  const slots = [];
  let definition;
  const rendered = [];
  const React = {createElement: (type, props, ...children) => ({type, props, children}), useState: value => [value, () => {}], useEffect: () => {}};
  const window = {__ModuleLoader__: {load: value => { definition = value; }}};
  runInNewContext(source, {window, document: new EventTarget(), AbortController, Date, btoa, setTimeout, clearTimeout, setInterval, clearInterval, fetch: async () => ({ok: true, text: async () => '', json: async () => ({})})});
  const plugin = definition.factory(() => React);
  assert.ok(plugin.inject.includes('sessions'));
  const ctx = {effect: fn => fn(), sessions: {retain: () => ({ready: Promise.resolve(), release() {}})}, slots: {inject: (_key, fn) => fn(), register: (metadata, component) => { slots.push({metadata, component}); }}};
  plugin.apply(ctx);
  const main = slots.find(row => row.metadata.key === 'family-assistant');
  assert.equal(JSON.stringify(main.metadata.children), JSON.stringify({'family.owner.conversation': {kind: 'single', scope: 'session'}}));
  const child = slots.find(row => row.metadata.name === 'family.owner.conversation');
  assert.ok(child, 'the child slot has a registered body');
  child.component({renderFactorySlot: (name, props) => { rendered.push({name, props}); return null; }});
  assert.equal(JSON.stringify(rendered), JSON.stringify([{name: 'conversation.content', props: {variant: 'embedded', phase: 'active', hero: false}}]));
  // With the Host's SessionProvider the panel opens on the native chat tab.
  const tree = main.component({SessionProvider: () => null, renderSlot: () => null});
  const text = JSON.stringify(tree);
  assert.match(text, /和乐乐聊/);
  assert.match(text, /正在打开和乐乐的对话/);
  // Without it (older Host), the panel keeps the overview and full workbench.
  const legacy = JSON.stringify(main.component({}));
  assert.doesNotMatch(legacy, /和乐乐聊/);
  assert.match(legacy, /完整工作台/);
});

test('opening the desktop conversation creates one clean native session and never sends anything', async t => {
  const {createRuntime} = await import('../src/runtime.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'owner-console-open-'));
  const workspace = {workspaceId: 'owner-control', title: 'Owner', path: join(directory, 'control'), sessionIds: []};
  const ensured = [], starts = [];
  let policy = null;
  const runtime = createRuntime({directory: join(directory, 'private'), intervalMs: 600000,
    ownerAgent: {
      async ensureControlWorkspace() { return structuredClone(workspace); },
      async listWorkspaces() { return [structuredClone(workspace)]; },
      async ensureSession(intent) { ensured.push(structuredClone(intent)); return {sessionId: intent.sessionId, created: ensured.length === 1}; },
      async start(intent) { starts.push(intent); return {state: 'succeeded'}; },
      async observe() { return {state: 'succeeded'}; },
    },
    ownerPromptStatus: id => policy && {sessionId: id, verified: policy === 'active', reason: policy === 'active' ? 'section_verified' : policy === 'pending' ? 'pending' : 'section_missing'},
    channelFactory: () => ({status: () => ({status: 'connected'}), connect: async () => {}, disconnect: async () => {}, close: async () => {}, send: async () => { throw new Error('nothing may be sent'); }}),
  });
  t.after(async () => { await runtime.close(); rmSync(directory, {recursive: true, force: true}); });
  runtime.store.addPerson({id: 'owner', role: 'owner', label: '我'});
  assert.equal(runtime.status().ownerConversation, null);
  const [first, second] = await Promise.all([runtime.action({action: 'owner_conversation_open'}), runtime.action({action: 'owner_conversation_open'})]);
  assert.equal(first.ownerConversation.sessionId, second.ownerConversation.sessionId, 'concurrent opens share one conversation');
  assert.match(first.ownerConversation.sessionId, /^family_owner_[a-f0-9-]{36}$/);
  assert.equal(first.ownerConversation.policy, 'unknown');
  assert.equal(ensured.length, 1);
  assert.equal(starts.length, 0, 'opening never submits a turn');
  const again = await runtime.action({action: 'owner_conversation_open'});
  assert.equal(again.ownerConversation.sessionId, first.ownerConversation.sessionId, 'the anchor survives reopening');
  policy = 'pending';
  assert.equal(runtime.status().ownerConversation.policy, 'unknown', 'a check in flight never forces the fallback');
  policy = 'active';
  assert.equal(runtime.status().ownerConversation.policy, 'active');
  policy = 'inactive';
  assert.equal(runtime.status().ownerConversation.policy, 'inactive');
  assert.equal(JSON.stringify(runtime.status().ownerConversation).includes(workspace.path), false, 'no filesystem path reaches the panel');
});

async function mountPanel({drafts, handoff, draftStatus, family = {}}) {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  const store = new Map();
  if (drafts) store.set('family-workbench-drafts-v1', JSON.stringify({drafts}));
  if (handoff) store.set('family-native-chat-handoff-v1', JSON.stringify({text: handoff}));
  const sessionStorage = {getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key)};
  const sessionId = 'family_owner_ee000000-0000-4000-8000-000000000001';
  const initialized = [];
  const binding = {sessionId, ctx: {get: name => name === 'conversation' ? {input: {requestDraftInitialization: (target, options) => { initialized.push({target, options}); return draftStatus; }}} : undefined}};
  const reference = {ready: Promise.resolve(), binding, release() {}};
  const states = [], effects = [];
  let index = 0, first = true;
  const React = {
    createElement: (type, props, ...children) => ({type, props: props || {}, children}),
    useState: initial => { const i = index++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useEffect: fn => { if (first) effects.push(fn); },
  };
  const fetch = async (url, init = {}) => ({
    ok: true,
    text: async () => '<html><head></head><body></body></html>',
    json: async () => init.method === 'POST' ? {ownerConversation: {sessionId, policy: 'active'}} : {health: family.health ?? null, workbench: family.workbench, ownerConversation: {sessionId, policy: 'active'}},
  });
  const window = {__ModuleLoader__: {load: value => { definition = value; }}, sessionStorage, AbortController, setTimeout, clearTimeout, Date};
  let definition;
  runInNewContext(source, {window, document: new EventTarget(), AbortController, Date, btoa, setTimeout, clearTimeout, setInterval, clearInterval, fetch});
  const plugin = definition.factory(() => React), slots = [];
  plugin.apply({effect: fn => fn(), sessions: {retain: () => reference, binding: () => binding}, slots: {inject: (_key, fn) => fn(), register: (metadata, component) => slots.push({metadata, component})}});
  const Panel = slots.find(row => row.metadata.key === 'family-assistant').component;
  const props = {SessionProvider: () => null, renderSlot: () => null};
  const render = () => { index = 0; const tree = Panel(props); first = false; return tree; };
  render();
  for (const effect of effects) effect();
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  const find = (node, predicate, out = []) => { if (!node || typeof node !== 'object') return out; if (predicate(node)) out.push(node); for (const child of node.children ?? []) find(child, predicate, out); return out; };
  const button = (tree, label) => find(tree, node => node.type === 'button' && JSON.stringify(node.children) === JSON.stringify([label]))[0];
  return {store, initialized, render, button, find};
}

test('an unsent line from the old chat box is handed into the native composer, not dropped', async () => {
  const panel = await mountPanel({drafts: {'': '帮我问问妈妈周末回不回家', 'card:1': '别的卡片草稿'}, draftStatus: 'applied'});
  let tree = panel.render();
  assert.match(JSON.stringify(tree), /旧对话框里还有一段没发出的话/);
  assert.match(JSON.stringify(tree), /帮我问问妈妈周末回不回家/);
  assert.equal(JSON.parse(panel.store.get('family-workbench-drafts-v1')).drafts[''], '', 'moved out of the old box so only one surface owns it');
  assert.equal(JSON.parse(panel.store.get('family-workbench-drafts-v1')).drafts['card:1'], '别的卡片草稿', 'other drafts are untouched');
  panel.button(tree, '放进输入框').props.onClick();
  assert.equal(panel.initialized.length, 1);
  assert.equal(panel.initialized[0].options.prompt, '帮我问问妈妈周末回不回家');
  assert.equal(panel.initialized[0].options.clearPreviousDraft, false, 'an existing native draft is never cleared');
  assert.equal(panel.store.has('family-native-chat-handoff-v1'), false, 'cleared only after the Host accepted it');
  tree = panel.render();
  assert.match(JSON.stringify(tree), /已放进下方输入框，确认后由你发送/);
  assert.doesNotMatch(JSON.stringify(tree), /帮我问问妈妈周末回不回家/);
});

test('a native composer that already has a draft keeps it and the old line stays available', async () => {
  const panel = await mountPanel({handoff: '先保留的旧话', draftStatus: 'preserved'});
  let tree = panel.render();
  panel.button(tree, '放进输入框').props.onClick();
  assert.equal(panel.store.has('family-native-chat-handoff-v1'), true);
  tree = panel.render();
  assert.match(JSON.stringify(tree), /没有覆盖它/);
  assert.match(JSON.stringify(tree), /先保留的旧话/);
});

test('with nothing pending the native conversation shows no handoff bar', async () => {
  const panel = await mountPanel({drafts: {'': '   '}, draftStatus: 'applied'});
  assert.doesNotMatch(JSON.stringify(panel.render()), /旧对话框里还有一段没发出的话/);
});

test('the family band shows who is in the family, what needs the Owner, and starter phrases', async () => {
  const health = {version: 1, totals: {people: 3, online: 2, pending: 1}, people: [
    {personId: 'me', label: '我', role: 'owner', connected: true, pending: 0},
    {personId: 'mom', label: '妈妈', role: 'elder', connected: true, pending: 0},
    {personId: 'dad', label: '爸爸', role: 'elder', connected: false, pending: 0},
  ]};
  const workbench = {requests: [
    {id: 'r-old', personId: 'dad', status: 'resolved', text: '旧事'},
    {id: 'r-1', personId: 'mom', status: 'open', text: '周末要不要一起吃饭'},
  ]};
  const panel = await mountPanel({draftStatus: 'applied', family: {health, workbench}});
  let tree = panel.render();
  const text = JSON.stringify(tree);
  assert.match(text, /乐乐/);
  assert.match(text, /家里的事直接跟我说/);
  assert.match(text, /妈妈/);
  assert.match(text, /爸爸/);
  assert.match(text, /离线/);
  const band = JSON.stringify(panel.find(tree, node => node.props?.['data-family-band'])[0]);
  assert.doesNotMatch(band, /"我"/, 'the Owner is not listed as a family chip');
  assert.match(text, /妈妈有件事想问你/);
  assert.match(text, /周末要不要一起吃饭/);
  assert.doesNotMatch(text, /旧事/, 'resolved requests are not shown');
  assert.doesNotMatch(text, /家人状态/, 'the band replaces the separate status tab');
  panel.button(tree, '给家人带句话').props.onClick();
  assert.equal(panel.initialized.at(-1).options.prompt, '帮我给家人带句话：');
  assert.equal(panel.initialized.at(-1).options.clearPreviousDraft, false);
  tree = panel.render();
  assert.match(JSON.stringify(tree), /已放进下方输入框/);
});

test('a starter phrase never overwrites a draft the Owner already typed', async () => {
  const panel = await mountPanel({draftStatus: 'preserved', family: {health: {version: 1, totals: {people: 1, online: 1, pending: 0}, people: [{personId: 'mom', label: '妈妈', role: 'elder', connected: true, pending: 0}]}}});
  let tree = panel.render();
  panel.button(tree, '安排一个提醒').props.onClick();
  tree = panel.render();
  assert.match(JSON.stringify(tree), /输入框里已经有内容，没有覆盖/);
});
