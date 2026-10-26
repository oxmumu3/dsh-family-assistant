import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerAgentClient } from '../src/owner-agent-client.mjs';

// Synthetic fixtures follow the official dsh-wechat-desktop-source contracts:
// core/session/src/types.ts, interaction/user-questions/src/types.ts,
// interaction/user-questions/src/projection.ts and compaction/compaction/src/checkpoint.ts.
const requestId = 'bb000000-0000-4000-8000-000000000002';
const sessionId = 'family_owner_aa000000-0000-4000-8000-000000000001';
const intent = { workspaceId: 'synthetic-owner', cwd: '/synthetic/project', sessionId, requestId, prompt: '整理这个项目' };
const event = (seq, type, data) => ({ type: 'event', event: { seq, type, data } });
const assistant = (seq, turn, text) => event(seq, 'assistant/message', { turn, step: 0, message: { role: 'assistant', content: [{ type: 'text', text }] }, stream: [] });
const begin = () => [event(0, 'turn/start', { turn: 1 }), event(1, 'user/message', { role: 'user', content: [{ type: 'text', text: intent.prompt }], source: { kind: 'user', rpcId: requestId } })];
const end = (seq, turn = 1) => event(seq, 'turn/end', { turn, reason: { kind: 'completed' } });
const question = { callId: 'question-1', questions: [{ id: 'format', question: '输出格式？' }], state: 'continued' };
const questionCall = seq => event(seq, 'tool/call', { turn: 1, step: 0, callId: question.callId, name: 'ask_user_question', arguments: JSON.stringify({ questions: question.questions, timeout: 30 }) });
const reply = seq => event(seq, 'user/message', { role: 'user', source: { kind: 'user-question-reply', callId: question.callId, outcome: 'answered' }, content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'format', selected: [], custom: 'Markdown' }] }) }] });
function fixture(records, values = {}) {
  const snapshot = { type: 'snapshot', header: { id: sessionId, cwd: intent.cwd }, cursor: records.at(-1)?.event.seq ?? -1, records, hasMore: false, projections: { values } };
  const remote = {
    workspace: { follow: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'baseline', value: { items: [{ workspaceId: intent.workspaceId, path: intent.cwd, title: '合成测试', sessionIds: [sessionId] }] } }; } }) },
    session: { follow: () => ({ async *[Symbol.asyncIterator]() { yield snapshot; } }) },
  };
  return { snapshot, remote, client: createOwnerAgentClient({ remote }) };
}

test('official compaction checkpoint does not turn the exact Owner request into foreign input', async () => {
  const checkpoint = event(2, 'user/message', { role: 'user', content: [{ type: 'text', text: 'synthetic context summary' }], source: { kind: 'compact-checkpoint', compactionId: 'synthetic-compact' } });
  checkpoint.event.surfaceOp = { op: 'replace', startSeq: 1, endSeq: 1 };
  const f = fixture([...begin(), checkpoint, assistant(3, 1, '整理完成'), end(4)]);
  const result = await f.client.observe(intent);
  assert.equal(result.foreign, false);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.text, '整理完成');
});

test('official model-selection notice does not hide the response to the same request', async () => {
  const f = fixture([...begin(), event(2, 'user/message', { role: 'user', source: { kind: 'model-selection', form: 'notice', summary: 'old → new' }, content: [{ type: 'text', text: '[model changed]' }] }), assistant(3, 1, '整理完成'), end(4)]);
  assert.equal((await f.client.observe(intent)).state, 'succeeded');
});

test('continued native question remains actionable after its original turn ends', async () => {
  const f = fixture([...begin(), questionCall(2), assistant(3, 1, '请补充输出格式。'), end(4)], { userQuestions: { active: [question], settled: [] } });
  const result = await f.client.observe(intent);
  assert.equal(result.state, 'needs_input');
  assert.equal(result.questions, 1);
});

test('reply to this request native question can continue in a later turn and return its final result', async () => {
  const f = fixture([...begin(), questionCall(2), assistant(3, 1, '请补充输出格式。'), end(4), event(5, 'turn/start', { turn: 2 }), reply(6), assistant(7, 2, '已按 Markdown 完成整理。'), end(8, 2)], { userQuestions: { active: [], settled: [{ callId: question.callId, answers: [{ id: 'format', selected: [], custom: 'Markdown' }] }] } });
  const result = await f.client.observe(intent);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.text, '已按 Markdown 完成整理。');
});

test('a genuine separate user request in the same turn still fails attribution closed', async () => {
  const f = fixture([...begin(), event(2, 'user/message', { role: 'user', source: { kind: 'user', rpcId: 'cc000000-0000-4000-8000-000000000003' }, content: [{ type: 'text', text: '另一位用户输入' }] }), assistant(3, 1, 'mixed response'), end(4)]);
  const result = await f.client.observe(intent);
  assert.equal(result.foreign, true);
  assert.equal(result.state, 'unknown');
  assert.equal(result.text, '');
});

test('a native question reply in the same active turn remains owned', async () => {
  const f = fixture([...begin(), questionCall(2), reply(3), assistant(4, 1, '回答后继续处理')]);
  const result = await f.client.observe(intent);
  assert.equal(result.state, 'running');
  assert.equal(result.foreign, false);
  assert.deepEqual(result.activeRequestIds, [requestId]);
});

test('queued answer to an owned continued question remains pending', async () => {
  const f = fixture([...begin(), questionCall(2), end(3)], { userQuestions: { active: [question], settled: [] }, inbox: { 'next-turn': [{ source: { kind: 'user-question-reply', callId: question.callId } }] } });
  assert.equal((await f.client.observe(intent)).state, 'queued');
});

test('PTC-dispatched native question links its later reply by subCallId', async () => {
  const f = fixture([...begin(), event(2, 'tool/ptc-dispatch', { callId: 'run-code', subCallId: question.callId, name: 'ask_user_question', arguments: { questions: question.questions }, content: [{ type: 'text', text: '{"pending":true}' }], isError: false }), end(3), event(4, 'turn/start', { turn: 2 }), reply(5), assistant(6, 2, 'PTC 问答后结果'), end(7, 2)]);
  assert.equal((await f.client.observe(intent)).text, 'PTC 问答后结果');
});

test('a related answer mixed with another request never claims that turn result', async () => {
  const f = fixture([...begin(), questionCall(2), end(3), event(4, 'turn/start', { turn: 2 }), reply(5), event(6, 'user/message', { source: { kind: 'user', rpcId: 'different-request' } }), assistant(7, 2, 'mixed private result'), end(8, 2)]);
  const result = await f.client.observe(intent);
  assert.equal(result.state, 'unknown');
  assert.equal(result.text, '');
  assert.equal(result.events.length, 0);
});

test('another request question and approval cannot affect this completed request', async () => {
  const other = 'cc000000-0000-4000-8000-000000000003';
  const f = fixture([...begin(), assistant(2, 1, '本次请求结果'), end(3), event(4, 'turn/start', { turn: 2 }), event(5, 'user/message', { source: { kind: 'user', rpcId: other } }), event(6, 'tool/call', { turn: 2, callId: 'other-question', name: 'ask_user_question' }), event(7, 'approval/asked', { id: 'other-approval' }), assistant(8, 2, 'unrelated text'.repeat(3000))], { userQuestions: { active: [{ ...question, callId: 'other-question' }], settled: [] } });
  const result = await f.client.observe(intent);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.text, '本次请求结果');
  assert.equal(result.questions, 0);
  assert.equal(result.pendingApprovals, 0);
  assert.ok(result.events.every(item => item.turn === 1));
});

test('unknown injected input still fails attribution closed', async () => {
  const f = fixture([...begin(), event(2, 'user/message', { source: { kind: 'unrecognized-extension' } }), assistant(3, 1, 'unowned result'), end(4)]);
  assert.equal((await f.client.observe(intent)).state, 'unknown');
});

test('verified official clock and skill context do not replace request identity', async () => {
  const f = fixture([...begin(), event(2, 'user/message', { source: { kind: 'time-context', form: 'notice' } }), event(3, 'user/message', { source: { kind: 'skill-catalog', form: 'catalog', entries: [] } }), assistant(4, 1, '含系统上下文的结果'), end(5)]);
  assert.equal((await f.client.observe(intent)).state, 'succeeded');
});

test('official legacy blocking question is actionable without a timed projection', async () => {
  const f = fixture([...begin(), questionCall(2)]);
  assert.equal((await f.client.observe(intent)).state, 'needs_input');
  f.snapshot.records.push(event(3, 'tool/result', { turn: 1, message: { toolCallId: question.callId, content: [{ type: 'text', text: '{"answers":[]}' }] } }));
  assert.equal((await f.client.observe(intent)).state, 'running');
});

test('concurrent identical admission shares its promise and makes one Host prompt call', async () => {
  const f = fixture([]), entered = Promise.withResolvers(), gate = Promise.withResolvers();
  let prompts = 0;
  f.remote.session.prompt = async () => { prompts++; entered.resolve(); await gate.promise; f.snapshot.projections.values.inbox = { 'next-turn': [{ source: { kind: 'user', rpcId: requestId } }] }; return { ok: true, value: { accepted: true } }; };
  const first = f.client.start(intent); await entered.promise;
  const second = f.client.start({ ...intent });
  await new Promise(resolve => setImmediate(resolve)); gate.resolve();
  await Promise.all([first, second]);
  assert.equal(first, second);
  assert.equal(prompts, 1);
});

test('different request waits for session admission then sees the active first turn as busy', async () => {
  const f = fixture([]), entered = Promise.withResolvers(), gate = Promise.withResolvers();
  let prompts = 0;
  f.remote.session.prompt = async () => { prompts++; entered.resolve(); await gate.promise; f.snapshot.records = begin(); return { ok: true, value: { accepted: true } }; };
  const first = f.client.start(intent); await entered.promise;
  const second = f.client.start({ ...intent, requestId: 'cc000000-0000-4000-8000-000000000003', prompt: 'another request' });
  const observed = second.then(value => ({ value }), error => ({ error }));
  await new Promise(resolve => setImmediate(resolve)); gate.resolve(); await first;
  assert.equal((await observed).error?.code, 'owner_agent_busy');
  assert.equal(prompts, 1);
});

test('another queued request prevents admission even before the Host starts its turn', async () => {
  const f = fixture([], { inbox: { 'next-turn': [{ source: { kind: 'user', rpcId: 'cc000000-0000-4000-8000-000000000003' } }] } });
  let prompts = 0;
  f.remote.session.prompt = async () => { prompts++; return { ok: true, value: { accepted: true } }; };
  await assert.rejects(f.client.start(intent), error => error.code === 'owner_agent_busy');
  assert.equal(prompts, 0);
});

test('concurrent reuse of a request ID with changed intent never shares or submits it', async () => {
  const f = fixture([]), entered = Promise.withResolvers(), gate = Promise.withResolvers();
  let prompts = 0;
  f.remote.session.prompt = async () => { prompts++; entered.resolve(); await gate.promise; return { ok: true, value: { accepted: true } }; };
  const first = f.client.start(intent); await entered.promise;
  const second = f.client.start({ ...intent, prompt: 'changed content' }).then(value => ({ value }), error => ({ error }));
  await new Promise(resolve => setImmediate(resolve)); gate.resolve(); await first;
  assert.equal((await second).error?.code, 'owner_agent_invalid_intent');
  assert.equal(prompts, 1);
});

test('native turn advancing after observe cannot make cancel hit that next turn', async () => {
  const f = fixture(begin()); let cancelled = 0;
  f.remote.session.follow = () => ({ async *[Symbol.asyncIterator]() { try { yield f.snapshot; } finally { f.snapshot.records = [...begin(), end(2), event(3, 'turn/start', { turn: 2 })]; } } });
  f.remote.session.cancel = async () => { cancelled++; return { ok: true, value: { accepted: true } }; };
  assert.deepEqual(await f.client.cancel(intent), { requiresNativeSession: true });
  assert.equal(cancelled, 0);
});
