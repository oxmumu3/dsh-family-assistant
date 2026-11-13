import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';
import {createChannelManager} from '../src/channels.mjs';
import {createConnectionSuspensions} from '../src/connection-suspensions.mjs';
import {createStore} from '../src/store.mjs';

const PEOPLE = [['owner', 'owner', '我'], ['dad', 'elder', '爸爸'], ['mom', 'elder', '妈妈'], ['aunt', 'elder', '姑姑']];
const ids = PEOPLE.map(([id]) => id);
const otherIds = ids.filter(id => id !== 'owner');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label = '条件') {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (fn()) return; await wait(2); }
  assert.fail(`未等到${label}`);
}

function tempDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'family-owner-restart-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  return directory;
}

function seed(runtime) {
  const at = new Date().toISOString();
  for (const [id, role, label] of PEOPLE) {
    runtime.store.addPerson({id, role, label, shareWithOwner: 'full'});
    runtime.store.bindPerson(id, {accountId: `bot-${id}`, peerId: `wx-${id}`});
    runtime.store.setConnection(id, {lastInboundAt: at});
  }
}

function fakeChannels(state) {
  return ({onBound, onStatus} = {}) => {
    state.onBound = onBound;
    state.onStatus = onStatus;
    return {
      async connect(id, options = {}) {
        state.connects.push(id);
        if (state.blockConnect === id) await state.connectGate;
        state.tokens.push(options.resumeToken);
        await onBound(id, {accountId: `bot-${id}`, peerId: `wx-${id}`}, {resumeToken: options.resumeToken});
        state.connected.add(id);
        onStatus(id, {status: 'connected'});
      },
      async login(id, options = {}) {
        state.logins.push(id);
        state.tokens.push(options.resumeToken);
        if (state.blockLogin === id) await state.loginGate;
        if (state.bindOnLogin === false) {
          state.phases.set(id, {status: 'awaiting_scan', phase: 'awaiting_scan', qrUrl: `https://weixin.example/${id}`});
          onStatus(id, {status: 'awaiting_scan'});
          return {phase: 'awaiting_scan', qrUrl: `https://weixin.example/${id}`};
        }
        await onBound(id, {accountId: `bot-${id}`, peerId: `wx-${id}`}, {resumeToken: options.resumeToken});
        state.connected.add(id);
        onStatus(id, {status: 'connected'});
        return {phase: 'connected'};
      },
      async disconnect(id) {
        state.connected.delete(id);
        state.phases.delete(id);
        onStatus(id, {status: 'disconnected'});
      },
      async close() { state.connected.clear(); },
      status(id) {
        if (state.connected.has(id)) return {status: 'connected', phase: 'connected'};
        return state.phases.get(id) ?? {status: 'disconnected', phase: 'disconnected'};
      },
      statuses() { return [...state.connected].map(personId => ({personId, status: 'connected'})); },
      async send(route, text, {authorize} = {}) {
        if (typeof authorize === 'function' && !authorize()) throw Object.assign(new Error('未授权'), {sendOutcome: 'failed'});
        if (!state.connected.has(route.personId)) throw Object.assign(new Error('通道未连接'), {sendOutcome: 'failed'});
        state.sends.push({route, text});
        return {status: 'api_accepted'};
      },
    };
  };
}

function stateOf() {
  return {connected: new Set(), connects: [], logins: [], tokens: [], sends: [], phases: new Map(), onBound: null, onStatus: null, blockConnect: null, connectGate: null, blockLogin: null, loginGate: null, bindOnLogin: true};
}

async function boot(directory, state, {respond, now} = {}) {
  return createRuntime({
    directory,
    channelFactory: fakeChannels(state),
    respond: respond ?? (async ({person, text}) => ({reply: `${person.label}：${text}`})),
    intervalMs: 60_000,
    ...(now ? {now} : {}),
  });
}

function personView(runtime, id) {
  return runtime.status().people.find(person => person.id === id);
}

test('停用状态写在小 sidecar 里，family.json 结构不变，旧版仍能读当前台账和新增消息', async t => {
  const directory = tempDirectory(t);
  const state = stateOf();
  const runtime = await boot(directory, state);
  t.after(() => runtime.close());
  seed(runtime);
  await runtime.start();
  await runtime.receive('dad', {id: 'keep', peerId: 'wx-dad', text: '新增消息仍要能被旧版读到'});
  await runtime.action({action: 'disconnect', personId: 'owner'});
  await runtime.close();

  const ledger = JSON.parse(readFileSync(join(directory, 'family.json'), 'utf8'));
  const ownerBinding = ledger.bindings.find(row => row.personId === 'owner');
  assert.equal('suspended' in ownerBinding, false);
  const legacyBindingFields = ['personId', 'accountId', 'peerId', 'generation', 'status', 'lastError', 'lastInboundAt', 'lastOutboundAt'];
  assert.equal(Object.keys(ownerBinding).every(key => legacyBindingFields.includes(key)), true);
  const sidecar = join(directory, 'connection-suspensions.json');
  assert.equal(statSync(sidecar).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(sidecar, 'utf8')).suspended.owner !== undefined, true);

  // .49 的 store 对 binding 字段做严格白名单；当前台账仍能通过同一校验并读到新消息。
  const reopened = createStore({directory});
  assert.equal(reopened.messages('dad').some(row => row.text === '新增消息仍要能被旧版读到'), true);
  assert.equal(reopened.binding('owner').status, 'disconnected');
});

test('sidecar 原子写入并按人保存：损坏时失败关闭，清除只影响一位', async t => {
  const directory = tempDirectory(t);
  const store = createStore({directory});
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  store.addPerson({id: 'owner', role: 'owner', label: '我'});
  store.bindPerson('owner', {accountId: 'bot-owner', peerId: 'wx-owner'});

  const flag = createConnectionSuspensions({directory});
  assert.equal(flag.isSuspended('owner'), false);
  flag.mark('owner');
  assert.equal(flag.isSuspended('owner'), true);
  assert.equal(createConnectionSuspensions({directory}).isSuspended('owner'), true, '重开进程后仍是停用');
  assert.equal(flag.clear('owner'), true);
  assert.equal(flag.isSuspended('owner'), false);

  flag.mark('owner');
  writeFileSync(join(directory, 'connection-suspensions.json'), '{"version":1,"suspended":[]}\n');
  assert.throws(() => createConnectionSuspensions({directory}), /格式无效/);
});

test('旧台账无停用标记时保持原行为，重新点断开只停本人，重启后仍跳过本人', async t => {
  const directory = tempDirectory(t);
  const first = await boot(directory, stateOf());
  t.after(() => first.close());
  seed(first);
  await first.start();
  // 旧版本点过一次「断开连接」只留下连接状态，没有持久标记；更新后不猜测它。
  first.store.setConnection('owner', {status: 'disconnected'});
  await first.close();

  const legacy = stateOf();
  const replay = await boot(directory, legacy);
  t.after(() => replay.close());
  await replay.start();
  assert.deepEqual(new Set(legacy.connects), new Set(ids));

  await replay.action({action: 'disconnect', personId: 'owner'});
  await replay.close();

  const restart = stateOf();
  const reopened = await boot(directory, restart);
  t.after(() => reopened.close());
  await reopened.start();
  assert.deepEqual(new Set(restart.connects), new Set(otherIds));
  assert.equal(personView(reopened, 'owner').binding.suspended, true);
  assert.equal(personView(reopened, 'owner').binding.status, 'disconnected');
  assert.equal(personView(reopened, 'owner').binding.connected, false);
  for (const id of otherIds) assert.equal(personView(reopened, id).binding.connected, true);
});

test('停用期间普通待发维持 pending，恢复同绑定后未过期的继续、过期的过期，不误报新发送', async t => {
  const directory = tempDirectory(t);
  const state = stateOf();
  const runtime = await boot(directory, state);
  t.after(() => runtime.close());
  seed(runtime);
  await runtime.start();

  const uncertain = runtime.store.enqueue({personId: 'owner', text: '已提交但结果不明', kind: 'manual', sourceKey: 'manual:uncertain'});
  runtime.store.transition(uncertain.id, 'dispatching');
  runtime.store.transition(uncertain.id, 'uncertain');
  await runtime.action({action: 'disconnect', personId: 'owner'});

  const future = runtime.store.enqueue({personId: 'owner', text: '恢复后仍应发出', kind: 'manual', sourceKey: 'manual:future', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString()});
  const expired = runtime.store.enqueue({personId: 'owner', text: '等待期间已过期', kind: 'manual', sourceKey: 'manual:expired', expiresAt: new Date(Date.now() - 60_000).toISOString()});
  await runtime.tick();
  assert.equal(runtime.store.snapshot().outbox.find(row => row.id === future.id).status, 'pending');
  assert.equal(runtime.store.snapshot().outbox.find(row => row.id === expired.id).status, 'pending');

  // 向已停用成员新建手动发送必须明确拒绝，不能回一个像已发出的状态。
  const before = runtime.store.snapshot().outbox.length;
  await assert.rejects(() => runtime.action({action: 'send_message', personId: 'owner', text: '不该发'}), /手动断开/);
  assert.equal(runtime.store.snapshot().outbox.length, before);

  await runtime.action({action: 'connect', personId: 'owner'});
  assert.equal(runtime.store.snapshot().outbox.find(row => row.id === future.id).status, 'api_accepted');
  assert.equal(runtime.store.snapshot().outbox.find(row => row.id === expired.id).status, 'expired');
  assert.equal(runtime.store.snapshot().outbox.find(row => row.id === uncertain.id).status, 'uncertain');
  assert.equal(state.sends.filter(row => row.route.personId === 'owner').length, 1);
  assert.equal(state.sends.some(row => row.route.personId === 'owner' && row.text === '已提交但结果不明'), false);
});

test('全局暂停与网络临时失败不会被误记成手动停用；恢复只解除本人', async t => {
  const directory = tempDirectory(t);
  const state = stateOf();
  const runtime = await boot(directory, state);
  t.after(() => runtime.close());
  seed(runtime);
  await runtime.start();

  state.onStatus('dad', {status: 'error', lastError: '微信连接暂时中断，正在重试'});
  await runtime.action({action: 'pause'});
  for (const id of ids) assert.equal(personView(runtime, id).binding.suspended, false);

  await runtime.action({action: 'disconnect', personId: 'owner'});
  await runtime.action({action: 'start'});
  assert.equal(personView(runtime, 'owner').binding.suspended, true);
  assert.deepEqual(new Set(state.connects.slice(-3)), new Set(otherIds));

  await runtime.action({action: 'login', personId: 'owner'});
  assert.equal(personView(runtime, 'owner').binding.suspended, false);
  await runtime.action({action: 'start'});
  assert.deepEqual(new Set(state.connects.slice(-4)), new Set(ids));
});

test('待扫码与恢复/断开并发：旧操作的失败不会撤销新操作，只有当前显式绑定成功才恢复', async t => {
  const directory = tempDirectory(t);
  const state = stateOf();
  const runtime = await boot(directory, state);
  t.after(() => runtime.close());
  seed(runtime);
  await runtime.start();
  await runtime.action({action: 'disconnect', personId: 'owner'});

  // 扫码先卡在 getQr 阶段，随后点「恢复已有连接」。
  let releaseLogin;
  state.blockLogin = 'owner';
  state.loginGate = new Promise(resolve => { releaseLogin = resolve; });
  state.bindOnLogin = false;
  const scanning = runtime.action({action: 'login', personId: 'owner'});
  await new Promise(resolve => setImmediate(resolve));
  const restore = runtime.action({action: 'connect', personId: 'owner'});
  await restore;
  releaseLogin();
  await scanning;
  assert.equal(personView(runtime, 'owner').binding.connected, true);
  assert.equal(personView(runtime, 'owner').binding.suspended, false);

  // 反过来：扫码未完成时本人再次断开，扫码成功也不能复活。
  await runtime.action({action: 'disconnect', personId: 'owner'});
  state.blockLogin = 'owner';
  state.loginGate = new Promise(resolve => { releaseLogin = resolve; });
  state.bindOnLogin = true;
  const secondScan = runtime.action({action: 'login', personId: 'owner'});
  await new Promise(resolve => setImmediate(resolve));
  await runtime.action({action: 'disconnect', personId: 'owner'});
  releaseLogin();
  await assert.rejects(secondScan, /手动断开|暂时无法获取微信二维码/);
  assert.equal(personView(runtime, 'owner').binding.connected, false);
  assert.equal(personView(runtime, 'owner').binding.suspended, true);
});

test('扫码 token 过期后不能再被自动或迟到的绑定用来解除停用', async t => {
  const directory = tempDirectory(t);
  const state = stateOf();
  let clock = Date.parse('2026-11-13T04:00:00.000Z');
  const runtime = await boot(directory, state, {now: () => new Date(clock).toISOString()});
  t.after(() => runtime.close());
  seed(runtime);
  await runtime.start();
  await runtime.action({action: 'disconnect', personId: 'owner'});

  state.bindOnLogin = false;
  await runtime.action({action: 'login', personId: 'owner'});
  const token = state.tokens.at(-1);
  assert.ok(token);
  clock += 300_001;
  assert.throws(() => state.onBound('owner', {accountId: 'bot-owner', peerId: 'wx-owner'}, {resumeToken: token}), /手动断开/);
  assert.equal(personView(runtime, 'owner').binding.suspended, true);
});

test('真实 channel manager：扫码卡在 getQr 时点恢复已有连接，旧扫码的失败不会清掉新 token', async t => {
  const directory = tempDirectory(t);
  const api = {
    getQr: async () => ({qrcode: 'q1', qrUrl: 'https://weixin.example/qr1'}),
    checkQr: async () => ({status: 'confirmed', token: 'token-owner', baseUrl: 'https://ilinkai.weixin.qq.com', accountId: 'a-owner', peerId: 'p-owner'}),
    poll: ({signal}) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true}); }),
    send: async () => ({status: 'api_accepted'}),
  };
  const runtime = createRuntime({directory, api, channelFactory: createChannelManager, intervalMs: 60_000, respond: async () => ({reply: 'ok'})});
  t.after(() => runtime.close());
  runtime.store.addPerson({id: 'owner', role: 'owner', label: '我'});
  runtime.store.setConnection('owner', {lastInboundAt: new Date().toISOString()});

  await runtime.action({action: 'login', personId: 'owner'});
  await until(() => runtime.channels.status('owner').status === 'connected', '首次扫码连接');
  await runtime.action({action: 'disconnect', personId: 'owner'});

  let releaseQr;
  api.getQr = ({signal}) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true});
    releaseQr = () => resolve({qrcode: 'q2', qrUrl: 'https://weixin.example/qr2'});
  });
  const scanning = runtime.action({action: 'login', personId: 'owner'});
  await wait(10);
  await runtime.action({action: 'connect', personId: 'owner'});
  await assert.rejects(scanning, /暂时无法获取微信二维码/);
  assert.equal(runtime.channels.status('owner').status, 'connected');
  assert.equal(runtime.status().people.find(person => person.id === 'owner').binding.suspended, false);
  releaseQr?.();
});

test('扫码失败或未完成不会解除停用；停用通道绝不发送', async t => {
  const directory = tempDirectory(t);
  const state = stateOf();
  const runtime = await boot(directory, state);
  t.after(() => runtime.close());
  seed(runtime);
  await runtime.start();
  await runtime.action({action: 'disconnect', personId: 'owner'});

  state.bindOnLogin = false;
  state.phases.set('owner', {status: 'awaiting_scan', phase: 'awaiting_scan', qrUrl: 'https://weixin.example/owner'});
  await runtime.action({action: 'login', personId: 'owner'});
  assert.equal(personView(runtime, 'owner').binding.suspended, true);
  assert.equal(personView(runtime, 'owner').binding.status, 'awaiting_scan', '扫码阶段要显示真实进度');
  assert.equal(personView(runtime, 'owner').binding.qrUrl, 'https://weixin.example/owner');
  assert.equal(personView(runtime, 'owner').binding.connected, false);

  const queued = runtime.store.enqueue({personId: 'owner', text: '停用期间不发', kind: 'manual', sourceKey: 'manual:blocked-now'});
  await runtime.tick();
  assert.equal(runtime.store.snapshot().outbox.find(row => row.id === queued.id).status, 'pending');
  assert.equal(state.sends.length, 0);
});
