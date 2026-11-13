import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime} from '../src/runtime.mjs';
import {createMemberAgent, canAskMemberOwner} from '../src/member-agent.mjs';
import {createOwnerManagementTool} from '../src/owner-management-tool.mjs';

const ordinaryAsk = '请帮我问Owner周六几点来接我。';
const ordinaryQuestion = '周六几点来接我';
const toolAsk = '我需要Owner的项目权限才能继续，请帮我问Owner能不能给我项目权限。';
const toolQuestion = '能不能给我项目权限';

function scriptedMemberLlm(state) {
  return {
    async *stream(options) {
      state.calls.push({tools: (options.tools ?? []).map(tool => tool.name)});
      if (state.round++ % 2 === 1) {
        yield {type: 'block-start', index: 0, blockType: 'text'};
        yield {type: 'text-delta', index: 0, text: '我已经处理并回复你了。'};
        yield {type: 'block-end', index: 0, block: {type: 'text', text: '我已经处理并回复你了。'}};
        yield {type: 'finish', reason: 'stop'};
        return;
      }
      const payload = JSON.parse(options.messages[0].content[0].text);
      const request = String(payload.request);
      const question = /周六几点来接我/.test(request) ? ordinaryQuestion : null;
      const ordinary = !request.includes('项目权限') && Boolean(question);
      const name = ordinary ? 'ask_owner' : 'request_owner_help';
      const args = ordinary ? {text: question, evidence: request}
        : {text: toolQuestion, evidence: request, reason: '需要 Owner 的项目权限'};
      yield {type: 'block-start', index: 0, blockType: 'tool-call'};
      yield {type: 'tool-call-delta', index: 0, id: 'call-' + name, name, argumentsDelta: JSON.stringify(args)};
      yield {type: 'block-end', index: 0, block: {type: 'tool-call', id: 'call-' + name, name, arguments: JSON.stringify(args)}};
      yield {type: 'finish', reason: 'tool-calls'};
    },
  };
}

function syntheticOwnerAgent(state, directory) {
  const workspace = {workspaceId: 'owner-control', title: 'Owner 主对话', path: join(directory, 'control'), sessionIds: []};
  return {
    async ensureControlWorkspace() { return structuredClone(workspace); },
    async listWorkspaces() { return [structuredClone(workspace)]; },
    async start(intent) {
      state.starts.push(structuredClone(intent));
      state.byRequest.set(intent.requestId, structuredClone(intent));
      return {state: 'running'};
    },
    async observe(intent) {
      const saved = state.byRequest.get(intent.requestId) ?? intent;
      return {
        workspaceId: saved.workspaceId, sessionId: saved.sessionId, requestId: saved.requestId, cwd: saved.cwd,
        state: 'running', requestSeen: true, queued: false, foreign: false,
        turn: 3, activeTurn: 3, activeRequestIds: [saved.requestId],
        events: [{type: 'tool/call', seq: 12, turn: 3, name: 'family_assistant', callId: state.callId, status: 'running'}],
      };
    },
  };
}

function channels(state) {
  return () => ({
    async connect() {}, async disconnect() {}, async close() {},
    status: () => ({status: 'connected', phase: 'connected'}),
    statuses: () => [],
    async send(route, text, options) {
      if (typeof options?.authorize === 'function' && options.authorize() !== true) throw Object.assign(new Error('未授权'), {sendOutcome: 'failed'});
      state.sent.push({personId: route.personId, text, route});
      return {status: 'api_accepted'};
    },
  });
}

function memberAskReceipt(directory) {
  const root = join(directory, 'member-workspaces', 'mom');
  for (const binding of readdirSync(root)) {
    const ledger = JSON.parse(readFileSync(join(root, binding, '.member-agent.json'), 'utf8'));
    for (const request of ledger.requests) {
      const action = request.actions.find(row => row.name === 'member_ask_owner');
      if (action?.result?.reply) return action.result;
    }
  }
  return null;
}

async function fixture(t, {memberAgent = true} = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'family-ask-owner-')));
  const state = {round: 0, calls: [], sent: [], starts: [], byRequest: new Map(), callId: 'call-family-reply'};
  const member = memberAgent
    ? createMemberAgent({directory, llm: scriptedMemberLlm(state), readConfig: () => ({provider: 'synthetic', model: 'synthetic'}), now: () => new Date().toISOString()})
    : undefined;
  const runtime = createRuntime({
    directory,
    intervalMs: 600000,
    ...(member ? {memberAgent: member} : {}),
    ownerAgent: syntheticOwnerAgent(state, directory),
    ownerTaskArtifacts: {collect: async () => []},
    respond: async input => {
      if (input.person.role === 'elder' && input.text.includes('问问家里人')) {
        const question = input.text.replace(/^.*?[：:]\s*/, '').replace(/[。.]$/, '');
        return {reply: '好，我记下了。', action: {type: 'relay', text: question, evidence: input.text}};
      }
      return {reply: '好的。'};
    },
    channelFactory: channels(state),
  });
  t.after(async () => { await runtime.close(); rmSync(directory, {recursive: true, force: true}); });
  const at = new Date().toISOString();
  for (const [id, role, label] of [['owner', 'owner', '我'], ['mom', 'elder', '妈妈'], ['dad', 'elder', '爸爸']]) {
    runtime.store.addPerson({id, role, label, timeZone: 'Asia/Shanghai', shareWithOwner: 'full'});
    runtime.store.bindPerson(id, {accountId: 'account-' + id, peerId: 'peer-' + id});
    runtime.store.setConnection(id, {lastInboundAt: at, status: 'connected'});
  }
  await runtime.start();
  const tool = createOwnerManagementTool({runtime, directory});
  const executionFor = intent => ({callId: state.callId, agent: {id: intent.sessionId}, signal: new AbortController().signal});
  const ask = async (text, id) => { await runtime.receive('mom', {id, peerId: 'peer-mom', text}); await runtime.settled(); };
  const ownerTurn = async (text = '周六下午三点可以，我去接你。') => {
    await runtime.receive('owner', {id: 'owner-turn-' + state.starts.length, peerId: 'peer-owner', text});
    const deadline = Date.now() + 2000;
    while (state.starts.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
    return state.starts.at(-1);
  };
  return {directory, state, runtime, tool, executionFor, ask, ownerTurn};
}

test('普通家人托问走 ask_owner，生成 workbench family_request 并由主人 family_reply 答回；工具需求仍走 workflow_request', async t => {
  const f = await fixture(t);
  await f.ask(ordinaryAsk, 'ordinary-ask-1');
  const ownerRows = () => f.runtime.store.snapshot().outbox.filter(row => row.personId === 'owner');
  assert.equal(ownerRows().length, 1);
  assert.equal(ownerRows()[0].kind, 'family_request');
  assert.match(ownerRows()[0].text, /^【乐乐·家人问你】妈妈的事/);
  assert.doesNotMatch(ownerRows()[0].text, /请求编号/);
  assert.equal(f.runtime.status().workbench.requests.length, 1);
  const receipt = memberAskReceipt(f.directory);
  assert.match(receipt.reply, /不代表手机已收到/);
  assert.match(receipt.reply, /不保证对方一定答复/);

  const intent = await f.ownerTurn();
  const requestId = intent.prompt.match(/请求编号 ([^\s·]+)/)?.[1];
  assert.ok(requestId, '原生背景应带真实请求编号');
  assert.match(intent.prompt, /周六几点来接我/);
  const result = await f.tool.execute({action: 'family_reply', requestId, text: '周六下午三点可以，我去接你。'}, f.executionFor(intent));
  assert.equal(result.status, 'api_accepted', JSON.stringify(result));
  await f.runtime.settled();
  assert.equal(f.state.sent.some(row => row.personId === 'mom' && row.text.includes('周六下午三点可以，我去接你')), true);
  const request = f.runtime.status().workbench.requests.find(row => row.id === requestId);
  assert.equal(request.status, 'waiting');
  assert.equal(request.replyStatus, 'api_accepted');

  await f.ask(toolAsk, 'tool-ask-2');
  const latest = ownerRows().at(-1);
  assert.equal(latest.kind, 'workflow_request');
  assert.match(latest.text, /wf-[a-f0-9]{12}/);
  assert.equal(f.runtime.status().workbench.requests.length, 1, '工具需求不得新增 family_request');
});

test('普通托问的否定、引语、假设和被截取原话不授权；工具/权限词仍归 request_owner_help', () => {
  assert.equal(canAskMemberOwner({text: ordinaryAsk, evidence: ordinaryAsk, question: ordinaryQuestion}), true);
  for (const text of [
    '不要帮我问Owner周六几点来接我。',
    '有人说“帮我问Owner周六几点来接我”，不用理。',
    '如果帮我问Owner周六几点来接我，会怎样？',
    '比如帮我问Owner周六几点来接我。',
  ]) assert.equal(canAskMemberOwner({text, evidence: text, question: ordinaryQuestion}), false, text);
  assert.equal(canAskMemberOwner({text: toolAsk, evidence: toolAsk, question: toolQuestion}), false, '工具权限申请不得走普通托问');
  assert.equal(canAskMemberOwner({text: '帮我问Owner周六几点来接我。', evidence: '帮我问Owner周六几点来接我。', question: '周六几点来接我'}), true);
});

test('五种不能转给主人的普通托问都不产生 workbench 请求或 push', async t => {
  const cases = [
    '请帮我问社区医生周六几点来接我。',
    '别告诉Owner。请帮我问周六几点来接我。',
    '我想问：周六几点来接我？',
    '这句话怎么说：请帮我问Owner周六几点来接我。',
    '我住在东湖。请帮我问Owner周六几点来接我。',
  ];
  for (const [index, text] of cases.entries()) {
    const f = await fixture(t);
    await f.ask(text, 'reject-' + index);
    assert.equal(f.runtime.status().workbench.requests.length, 0, text);
    assert.equal(f.runtime.store.snapshot().outbox.filter(row => row.personId === 'owner').length, 0, text);
  }
});

test('旧 workbench family_reply：真实往返、去重、waiting 可再答、绑定/授权/未知/已结束边界', async t => {
  const f = await fixture(t, {memberAgent: false});
  await f.ask('帮我问问家里人：周六下午三点能不能一起去公园。', 'legacy-ask-1');
  const push = f.state.sent.find(row => row.personId === 'owner' && row.text.includes('家人问你'));
  assert.ok(push);
  const progressOf = value => String(value).slice(String(value).indexOf('办事进度与待处理')).split('\n\n接口接收状态')[0];
  const before = await f.runtime.action({action: 'preview_brief'});
  assert.match(progressOf(before.lastBrief.text), /妈妈：1 件明确转达的事需要你回应/);
  assert.doesNotMatch(progressOf(before.lastBrief.text), /一起去公园/);

  const intent = await f.ownerTurn('周六下午三点可以，一起去公园。');
  const requestId = intent.prompt.match(/请求编号 ([^\s·]+)/)?.[1];
  assert.ok(requestId);
  const first = await f.tool.execute({action: 'family_reply', requestId, text: '周六下午三点可以，一起去公园。'}, f.executionFor(intent));
  assert.equal(first.status, 'api_accepted');
  await f.runtime.settled();
  const replies = () => f.state.sent.filter(row => row.personId === 'mom' && row.text.includes('关于你提到的'));
  assert.equal(replies().length, 1);
  const after = await f.runtime.action({action: 'preview_brief'});
  assert.doesNotMatch(progressOf(after.lastBrief.text), /1 件明确转达的事需要你回应/);

  const replay = await f.tool.execute({action: 'family_reply', requestId, text: '周六下午三点可以，一起去公园。'}, f.executionFor(intent));
  assert.equal(replay.resultId, first.resultId);
  assert.equal(replies().length, 1);

  // Same-turn model text which the Owner did not actually say must not leave.
  const arbitrary = await f.tool.execute({action: 'family_reply', requestId, text: '如果下雨就改周日。'}, f.executionFor(intent));
  assert.equal(arbitrary.status, 'needs_input');
  assert.equal(replies().length, 1);
  const unknown = await f.tool.execute({action: 'family_reply', requestId: 'request-unknown', text: '周六下午三点可以，一起去公园。'}, f.executionFor(intent));
  assert.equal(unknown.status, 'needs_input');

  // A later, separate Owner turn may add a different reply; same request stays open.
  const laterIntent = await f.ownerTurn('再补充一句：如果下雨就改周日。');
  const second = await f.tool.execute({action: 'family_reply', requestId, text: '如果下雨就改周日。'}, f.executionFor(laterIntent));
  assert.equal(second.status, 'api_accepted');
  await f.runtime.settled();
  assert.equal(replies().length, 2, 'waiting 中的请求可再发不同回复');

  f.runtime.store.bindPerson('mom', {accountId: 'changed-mom', peerId: 'changed-peer-mom'});
  const changedIntent = await f.ownerTurn('绑定变化后的回复');
  const changed = await f.tool.execute({action: 'family_reply', requestId, text: '绑定变化后的回复'}, f.executionFor(changedIntent));
  assert.equal(changed.status, 'failed');
  assert.equal(replies().length, 2);

  await f.runtime.action({action: 'resolve_request', requestId});
  const endedIntent = await f.ownerTurn('已结束还要回');
  const ended = await f.tool.execute({action: 'family_reply', requestId, text: '已结束还要回'}, f.executionFor(endedIntent));
  assert.equal(ended.status, 'needs_input');
  assert.equal(replies().length, 2);
});

test('本轮明确说先别回或引用示例时，引号里的正文也不出站', async t => {
  const f = await fixture(t, {memberAgent: false});
  await f.ask('帮我问问家里人：周六下午三点能不能一起去公园。', 'refuse-ask-1');
  const intent = await f.ownerTurn('先别回她，尤其别说『周六下午四点来接你。』');
  const requestId = intent.prompt.match(/请求编号 ([^\s·]+)/)?.[1];
  const result = await f.tool.execute({action: 'family_reply', requestId, text: '周六下午四点来接你。'}, f.executionFor(intent));
  assert.equal(result.status, 'needs_input');
  assert.equal(f.state.sent.filter(row => row.personId === 'mom' && row.text.includes('关于你提到的')).length, 0);
});

test('非主人或无本轮真实原生上下文不能调用 family_reply', async t => {
  const f = await fixture(t, {memberAgent: false});
  await f.ask('帮我问问家里人：周六下午三点能不能一起去公园。', 'legacy-ask-1');
  const intent = await f.ownerTurn();
  const requestId = intent.prompt.match(/请求编号 ([^\s·]+)/)?.[1];
  const before = f.state.sent.length;
  await assert.rejects(() => f.tool.execute({action: 'family_reply', requestId, text: '伪造回复'}, {callId: 'call-family-reply', agent: {id: 'family_owner_forged'}, signal: new AbortController().signal}));
  assert.equal(f.state.sent.length, before);
});
