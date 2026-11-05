import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostMemberSessionFactory, extractionAssistantText} from '../src/member-native-host.mjs';

const record = (type, data) => ({type: 'event', event: {type, data}});

function fakeHost({accepted = true, texts = ['', '收到，已经记下了。']} = {}) {
  const state = {created: [], prompted: [], pages: 0};
  const agents = {
    async create(input) { state.created.push(input); return {agent: {id: input.sessionId}, dispose: async () => {}}; },
  };
  const sessionController = {
    async prompt(request) { state.prompted.push(request); return {accepted}; },
    async page() {
      state.pages += 1;
      const text = texts[Math.min(state.pages - 1, texts.length - 1)];
      return {records: text ? [record('assistant/message', {message: {content: [{type: 'text', text}]}})] : []};
    },
  };
  return {agents, sessionController, state};
}

test('assistant text is read from the last assistant event only', () => {
  assert.equal(extractionAssistantText([
    record('user/message', {message: {content: [{type: 'text', text: '问题'}]}}),
    record('assistant/message', {message: {content: [{type: 'text', text: '第一段'}, {type: 'text', text: '第二段'}]}}),
  ]), '第一段\n第二段');
  assert.equal(extractionAssistantText([record('user/message', {message: {content: []}})]), '');
  assert.equal(extractionAssistantText(undefined), '');
});

test('a member session is created under the member prefix and prompts the same id', async () => {
  const host = fakeHost();
  const createAgent = createHostMemberSessionFactory({agents: host.agents, sessionController: host.sessionController, cwd: '/tmp/family-member'});
  const handle = await createAgent({personId: 'k'});
  assert.match(handle.sessionId, /^family_member_k_[a-f0-9]{16}$/);
  assert.equal(host.state.created[0].meta.cwd, '/tmp/family-member');
  assert.equal(await handle.prompt({text: '帮我记住周末买花'}), true);
  assert.deepEqual(host.state.prompted[0].content, [{type: 'text', text: '帮我记住周末买花'}]);
  assert.equal(host.state.prompted[0].mode, 'queue');
});

test('whenIdle waits until an assistant reply appears', async () => {
  const host = fakeHost();
  const createAgent = createHostMemberSessionFactory({agents: host.agents, sessionController: host.sessionController, sleep: async () => {}});
  const handle = await createAgent({personId: 'k'});
  await handle.prompt({text: '你好'});
  assert.equal(await handle.whenIdle(), '收到，已经记下了。');
});

test('a rejected prompt returns false instead of pretending success', async () => {
  const host = fakeHost({accepted: false});
  const createAgent = createHostMemberSessionFactory({agents: host.agents, sessionController: host.sessionController});
  const handle = await createAgent({personId: 'k'});
  assert.equal(await handle.prompt({text: '你好'}), false);
});

test('waiting past the deadline throws so the caller can fall back', async () => {
  const host = fakeHost({texts: ['']});
  let clock = 0;
  const createAgent = createHostMemberSessionFactory({
    agents: host.agents,
    sessionController: host.sessionController,
    sleep: async () => { clock += 1000; },
    now: () => clock,
    timeoutMs: 500,
  });
  const handle = await createAgent({personId: 'k'});
  await handle.prompt({text: '你好'});
  await assert.rejects(() => handle.whenIdle(), /等待回复超时/);
});

test('a host without the required services is rejected early', () => {
  assert.throws(() => createHostMemberSessionFactory({sessionController: {}}), /agents\.create/);
  assert.throws(() => createHostMemberSessionFactory({agents: {create() {}}}), /sessionController/);
  assert.throws(() => createHostMemberSessionFactory({agents: {}, sessionController: {prompt() {}, page() {}}}), /agents\.create/);
});
