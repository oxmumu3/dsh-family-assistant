import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerAgentHost } from '../src/owner-agent-host.mjs';

const SESSION = 'family_owner_aa000000-0000-4000-8000-000000000001';
const REQUEST = 'bb000000-0000-4000-8000-000000000002';
const intent = { workspaceId: 'workspace', cwd: '/projects/daily', sessionId: SESSION, requestId: REQUEST, prompt: '读取项目说明，准备日报草稿。' };
const event = (seq, type, data) => ({ type: 'event', event: { seq, type, data } });
const turn = ({ ended = true } = {}) => [
  event(0, 'turn/start', { turn: 1 }),
  event(1, 'user/message', { source: { kind: 'user', rpcId: REQUEST } }),
  event(2, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '草稿已完成' }] } }),
  ...(ended ? [event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } })] : []),
];

function fixture({ exists = true, records = [], timeoutMs = 1000 } = {}) {
  const calls = [], signals = [], snapshot = {
    type: 'snapshot', header: { id: SESSION, cwd: intent.cwd }, records,
    hasMore: false, cursor: 100, projections: { values: {} },
  };
  let member = exists, closed = 0;
  const workspaceController = {
    async *follow(...args) {
      assert.equal(this, workspaceController);
      assert.equal(args.length, 1);
      assert.ok(args[0] instanceof AbortSignal);
      signals.push(args[0]);
      try {
        yield { type: 'baseline', value: { items: [{ workspaceId: 'workspace', path: intent.cwd, title: '日报', sessionIds: member ? [SESSION] : [] }] } };
      } finally { closed++; }
    },
  };
  const sessionController = {
    async create(...args) {
      assert.equal(this, sessionController);
      assert.equal(args.length, 1);
      calls.push(['create', ...args]); member = true;
      return { sessionId: args[0].sessionId };
    },
    async prompt(...args) {
      assert.equal(this, sessionController);
      assert.equal(args.length, 2);
      assert.ok(args[1] instanceof AbortSignal);
      signals.push(args[1]); calls.push(['prompt', args[0]]);
      return { accepted: true };
    },
    async *follow(...args) {
      assert.equal(this, sessionController);
      assert.equal(args.length, 2);
      assert.ok(args[1] instanceof AbortSignal);
      signals.push(args[1]); calls.push(['follow', args[0]]);
      try { yield snapshot; } finally { closed++; }
    },
    async page(...args) {
      assert.equal(this, sessionController);
      assert.equal(args.length, 2);
      assert.ok(args[1] instanceof AbortSignal);
      signals.push(args[1]); calls.push(['page', args[0]]);
      return { records: turn(), hasMore: false };
    },
  };
  return {
    workspaceController, sessionController, snapshot, calls, signals,
    get closed() { return closed; },
    client: createOwnerAgentHost({ workspaceController, sessionController, timeoutMs }),
  };
}

test('backend exposes only registered-project Owner operations and closes baseline streams', async () => {
  const f = fixture();
  assert.deepEqual(Object.keys(f.client).sort(), ['ensureControlWorkspace', 'listWorkspaces', 'observe', 'start']);
  assert.deepEqual(await f.client.listWorkspaces(), [{ workspaceId: 'workspace', path: intent.cwd, title: '日报', sessionIds: [SESSION] }]);
  assert.equal(f.closed, 1);
  assert.ok(f.signals.every(signal => signal.aborted));
});

test('plain Host methods keep exact signatures, this binding, and stable native request identity', async () => {
  const f = fixture({ exists: false });
  assert.equal((await f.client.start(intent)).state, 'queued');
  assert.deepEqual(f.calls[0], ['create', { workspaceId: intent.workspaceId, sessionId: SESSION }]);
  assert.deepEqual(f.calls.find(call => call[0] === 'prompt'), ['prompt', {
    sessionId: SESSION, requestId: REQUEST, mode: 'queue', content: [{ type: 'text', text: intent.prompt }],
  }]);
  assert.deepEqual(f.calls.find(call => call[0] === 'follow')[1], {
    address: { kind: 'session', sessionId: SESSION }, maxMessages: 128, turnWindow: { minMessages: 32, minTurns: 8 },
  });
});

test('plain history pages are wrapped without changing native correlation', async () => {
  const f = fixture({ records: [event(9, 'turn/start', { turn: 2 })] });
  f.snapshot.hasMore = true;
  const result = await f.client.observe(intent);
  assert.equal(result.state, 'succeeded'); assert.equal(result.text, '草稿已完成');
  assert.deepEqual(f.calls.find(call => call[0] === 'page')[1], {
    address: { kind: 'session', sessionId: SESSION }, throughSeq: 100, beforeSeq: 9,
    maxMessages: 128, turnWindow: { minMessages: 32, minTurns: 8 },
  });
});

test('idle Host without correlated turn/end never means task success', async () => {
  const f = fixture();
  f.snapshot.projections.values.status = { state: 'idle' };
  assert.equal((await f.client.observe(intent)).state, 'unknown');
  f.snapshot.records = turn({ ended: false });
  assert.equal((await f.client.observe(intent)).state, 'running');
  f.snapshot.records = turn();
  assert.equal((await f.client.observe(intent)).state, 'succeeded');
  assert.equal(f.calls.some(call => call[0] === 'prompt'), false);
});

test('native approvals stay pending and the adapter has no approval-deciding surface', async () => {
  const f = fixture({ records: turn({ ended: false }) });
  f.snapshot.records.push(event(3, 'approval/asked', { id: 'native-approval' }));
  f.sessionController.decideApproval = () => assert.fail('must not approve');
  const result = await f.client.observe(intent);
  assert.equal(result.state, 'needs_approval'); assert.equal(result.pendingApprovals, 1);
  assert.equal(f.client.cancel, undefined);
});

test('missing or incompatible injected controllers fail closed with a safe unavailable code', async () => {
  for (const workspaceController of [undefined, {}, { follow: true }]) {
    const client = createOwnerAgentHost({ workspaceController });
    await assert.rejects(() => client.listWorkspaces(), error => error.code === 'owner_agent_controller_unavailable');
  }
  const f = fixture();
  const client = createOwnerAgentHost({ workspaceController: f.workspaceController });
  await assert.rejects(() => client.observe(intent), error => error.code === 'owner_agent_controller_unavailable');
});

test('unexpected Remote envelopes and thrown diagnostics do not masquerade as plain Host success', async () => {
  const f = fixture();
  f.sessionController.prompt = async () => ({ ok: false, error: { message: 'secret-token' } });
  await assert.rejects(() => f.client.start(intent), error => error.code === 'owner_agent_remote_failed' && !error.stack.includes('secret'));
  const g = fixture();
  g.sessionController.follow = () => { throw new Error('secret-token https://private'); };
  await assert.rejects(() => g.client.observe(intent), error => error.code === 'owner_agent_remote_failed' && !error.stack.includes('secret'));
});

test('malformed creation, registry, and observation never dispatch a prompt', async () => {
  const f = fixture({ exists: false });
  f.sessionController.create = async () => ({ ok: true, value: { sessionId: SESSION } });
  await assert.rejects(() => f.client.start(intent), error => error.code === 'owner_agent_remote_failed');
  assert.equal(f.calls.some(call => call[0] === 'prompt'), false);
  const g = fixture(); g.snapshot.header.id = 'other-session';
  await assert.rejects(() => g.client.observe(intent), error => error.code === 'owner_agent_identity_mismatch');
  const client = createOwnerAgentHost({ workspaceController: { async *follow() { yield { type: 'baseline', value: { items: [{}] } }; } } });
  await assert.rejects(() => client.listWorkspaces(), error => error.code === 'owner_agent_registry_invalid');
});

test('timeout aborts observation, preserves request identity, and recovery never resubmits accepted work', async () => {
  const f = fixture({ timeoutMs: 15 }); let promptSignal;
  f.sessionController.prompt = (request, signal) => {
    f.calls.push(['prompt', request]); promptSignal = signal;
    f.snapshot.projections.values.inbox = { 'next-turn': [{ source: { kind: 'user', rpcId: request.requestId } }] };
    return new Promise(() => {});
  };
  await assert.rejects(() => f.client.start(intent), error => error.code === 'owner_agent_unknown');
  assert.equal(promptSignal.aborted, true);
  assert.equal((await f.client.start(intent)).state, 'queued');
  assert.equal(f.calls.filter(call => call[0] === 'prompt').length, 1);
  assert.equal(f.calls.find(call => call[0] === 'prompt')[1].requestId, REQUEST);
});

test('family identifiers and arbitrary paths are rejected before native execution', async () => {
  const f = fixture();
  await assert.rejects(() => f.client.start({ ...intent, sessionId: 'family_member_mom' }), error => error.code === 'owner_agent_invalid_intent');
  await assert.rejects(() => f.client.start({ ...intent, cwd: '/other-project' }), error => error.code === 'owner_agent_identity_mismatch');
  assert.equal(f.calls.length, 0);
});
