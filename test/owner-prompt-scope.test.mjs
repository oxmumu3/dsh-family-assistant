import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildOwnerTurn, ownerPromptSection, stripOwnerPolicy} from '../src/owner-prompt.mjs';
import {createOwnerPromptScope, readScope, recordScope} from '../src/owner-prompt-scope.mjs';

const SECTION = ownerPromptSection();
const policy = SECTION.text;

/** Fake Host prompt service: `mode` controls what assembly returns. */
function fakeService(mode = {value: 'ok'}, calls = {section: 0, assemble: 0, dispose: 0}) {
  return {
    calls,
    setMode(value) { mode.value = value; },
    section(section) {
      calls.section += 1;
      assert.equal(section.name, SECTION.name);
      return async () => { calls.dispose += 1; };
    },
    async assemble(context) {
      calls.assemble += 1;
      assert.equal(context.scope, context.agent, 'scope must be the real agent');
      if (mode.value === 'missing') return {sections: [{name: 'base'}]};
      if (mode.value === 'altered') return {sections: [{name: SECTION.name, text: '被改写'}]};
      if (mode.value === 'throw') throw new Error('assembly unavailable');
      return {sections: [{name: 'base'}, {name: SECTION.name, text: SECTION.text}]};
    },
  };
}

const owner = service => ({id: 'family_owner_test', ctx: {get: () => service}});
const request = text => ({sessionId: 'family_owner_test', content: [{type: 'text', text}]});
const turn = text => buildOwnerTurn({text});

test('before the first verification the inline policy is kept', async () => {
  const service = fakeService();
  const scope = createOwnerPromptScope({section: SECTION});
  const req = request(turn('帮我看看今天安排'));
  const result = await scope.prepareRequest('family_owner_unknown', req);
  assert.equal(result.applied, false);
  assert.equal(req.content[0].text, turn('帮我看看今天安排'));
  assert.equal(service.calls.assemble, 0);
});

test('after a verified attach only the original request is sent', async () => {
  const service = fakeService();
  const scope = createOwnerPromptScope({section: SECTION});
  const agent = owner(service);
  const attached = await scope.attach(agent);
  assert.equal(attached.verified, true);
  const req = request(turn('把今天的日报发我'));
  const result = await scope.prepareRequest(agent.id, req);
  assert.equal(result.applied, true);
  assert.equal(req.content[0].text, '当前 Owner 请求原文：\n把今天的日报发我');
  assert.equal(scope.isActive(agent.id), true);
});

test('upgrade history survives the strip while the policy does not', () => {
  const text = buildOwnerTurn({text: '继续那件事', legacyHistory: [{role: 'user', text: '上次'}]});
  const stripped = stripOwnerPolicy(text);
  assert.equal(stripped.stripped, true);
  assert.ok(!stripped.text.includes(policy.slice(0, 40)));
  assert.match(stripped.text, /升级前的对话背景/);
  assert.ok(stripped.text.endsWith('当前 Owner 请求原文：\n继续那件事'));
  assert.equal(stripOwnerPolicy(stripped.text).stripped, false, 'second strip is a no-op');
});

test('a section that disappears after success falls back and releases the registration', async () => {
  const service = fakeService();
  const scope = createOwnerPromptScope({section: SECTION});
  const agent = owner(service);
  assert.equal((await scope.attach(agent)).verified, true);
  service.setMode('missing');
  const req = request(turn('第二句'));
  const result = await scope.prepareRequest(agent.id, req);
  assert.equal(result.applied, false, 'must not strip when the section is gone');
  assert.equal(req.content[0].text, turn('第二句'));
  assert.equal(scope.isActive(agent.id), false);
  assert.ok(service.calls.dispose >= 1, 'stale registration released');
});

test('a section whose text changes is treated as not verified', async () => {
  const service = fakeService();
  const scope = createOwnerPromptScope({section: SECTION});
  const agent = owner(service);
  await scope.attach(agent);
  service.setMode('altered');
  const req = request(turn('第三句'));
  const result = await scope.prepareRequest(agent.id, req);
  assert.equal(result.applied, false);
  assert.equal(req.content[0].text, turn('第三句'));
});

test('a failing assembly keeps the inline policy', async () => {
  const service = fakeService();
  const scope = createOwnerPromptScope({section: SECTION});
  const agent = owner(service);
  await scope.attach(agent);
  service.setMode('throw');
  const req = request(turn('第四句'));
  const result = await scope.prepareRequest(agent.id, req);
  assert.equal(result.applied, false);
  assert.equal(req.content[0].text, turn('第四句'));
  assert.match(result.reason, /recheck_failed|register_failed/);
});

test('closing the scope stops stripping even for a previously verified agent', async () => {
  const service = fakeService();
  const scope = createOwnerPromptScope({section: SECTION});
  const agent = owner(service);
  await scope.attach(agent);
  await scope.close();
  const req = request(turn('第五句'));
  const result = await scope.prepareRequest(agent.id, req);
  assert.equal(result.applied, false);
  assert.equal(req.content[0].text, turn('第五句'));
});

test('attach is idempotent: one section registration per agent', async () => {
  const service = fakeService();
  const scope = createOwnerPromptScope({section: SECTION});
  const agent = owner(service);
  await scope.attach(agent);
  await scope.attach(agent);
  assert.equal(service.calls.section, 1);
});

test('a host without systemPrompt never strips', async () => {
  const scope = createOwnerPromptScope({section: SECTION});
  const agent = {id: 'family_owner_bare', ctx: {get: () => undefined}};
  const attached = await scope.attach(agent);
  assert.equal(attached.verified, false);
  const req = request(turn('第六句'));
  const result = await scope.prepareRequest(agent.id, req);
  assert.equal(result.applied, false);
  assert.equal(req.content[0].text, turn('第六句'));
});

test('non-owner agents are ignored', async () => {
  const service = fakeService();
  const scope = createOwnerPromptScope({section: SECTION});
  const attached = await scope.attach({id: 'session-other', ctx: {get: () => service}});
  assert.equal(attached.attached, false);
  assert.equal(service.calls.section, 0);
});

/** Assembly that stays pending until the test releases it. */
function deferredService() {
  const calls = {section: 0, assemble: 0, dispose: 0};
  let release;
  let mode = 'ok';
  const gate = new Promise(resolve => { release = resolve; });
  return {
    calls,
    setMode(value) { mode = value; },
    release() { release(); },
    section() { calls.section += 1; return async () => { calls.dispose += 1; }; },
    async assemble(context) {
      calls.assemble += 1;
      assert.equal(context.scope, context.agent);
      await gate;
      if (mode === 'ok') return {sections: [{name: SECTION.name, text: SECTION.text}]};
      return {sections: [{name: 'base'}]};
    },
  };
}

test('close during an in-flight verification keeps the inline policy', async () => {
  const service = deferredService();
  const scope = createOwnerPromptScope({section: SECTION});
  const agent = owner(service);
  const attaching = scope.attach(agent);      // hangs inside assemble
  await new Promise(resolve => setTimeout(resolve, 0));
  const closing = scope.close();              // releases while assemble is pending
  service.release();
  const attached = await attaching;
  assert.equal(attached.verified, false, 'late verification must not resurrect the scope');
  const req = request(turn('关闭中的一句'));
  const result = await scope.prepareRequest(agent.id, req);
  assert.equal(result.applied, false);
  assert.equal(req.content[0].text, turn('关闭中的一句'));
  assert.ok(service.calls.dispose >= 1);
  await closing;
});

test('detach during an in-flight verification keeps the inline policy', async () => {
  const service = deferredService();
  const scope = createOwnerPromptScope({section: SECTION});
  const agent = owner(service);
  const attaching = scope.attach(agent);
  await new Promise(resolve => setTimeout(resolve, 0));
  const detaching = scope.detach(agent.id);
  service.release();
  await attaching;
  assert.equal(scope.isActive(agent.id), false);
  const req = request(turn('解绑中的一句'));
  const result = await scope.prepareRequest(agent.id, req);
  assert.equal(result.applied, false);
  assert.equal(req.content[0].text, turn('解绑中的一句'));
  await detaching;
});

test('close during the recheck of a verified session keeps the inline policy', async () => {
  const service = fakeService();
  const scope = createOwnerPromptScope({section: SECTION});
  const agent = owner(service);
  await scope.attach(agent);
  assert.equal(scope.isActive(agent.id), true);
  // Make the next assemble hang so close() lands inside the recheck.
  let releaseRecheck;
  const gate = new Promise(resolve => { releaseRecheck = resolve; });
  const pending = {value: 'ok'};
  const realAssemble = service.assemble;
  service.assemble = async context => { await gate; return realAssemble(context); };
  const req = request(turn('复验中被关闭'));
  const inFlight = scope.prepareRequest(agent.id, req);
  await new Promise(resolve => setTimeout(resolve, 0));
  const closing = scope.close();
  releaseRecheck();
  const result = await inFlight;
  assert.equal(result.applied, false);
  assert.equal(req.content[0].text, turn('复验中被关闭'));
  await closing;
  assert.equal(pending.value, 'ok');
});

test('a disposed agent releases its scope; the same id can be recreated with a new agent', async () => {
  const first = fakeService();
  const scope = createOwnerPromptScope({section: SECTION});
  const older = {id: 'family_owner_reused', ctx: {get: () => first}};
  assert.equal((await scope.attach(older)).verified, true);
  assert.equal(scope.isActive(older.id), true);

  // What the agent/disposed handler now does.
  await scope.detach(older.id);
  assert.equal(first.calls.dispose, 1, 'the stale registration is released');
  assert.equal(scope.isActive(older.id), false);
  const stale = request(turn('解绑后旧的会话'));
  assert.equal((await scope.prepareRequest(older.id, stale)).applied, false);
  assert.equal(stale.content[0].text, turn('解绑后旧的会话'));

  // A brand-new agent object reusing the same persistent session id must register again.
  const second = fakeService();
  const newer = {id: 'family_owner_reused', ctx: {get: () => second}};
  const attached = await scope.attach(newer);
  assert.equal(attached.verified, true);
  assert.equal(second.calls.section, 1, 'exactly one fresh registration for the new agent');
  assert.equal(first.calls.section, 1, 'the old agent registered only once');

  const req = request(turn('重建后的会话'));
  const result = await scope.prepareRequest(newer.id, req);
  assert.equal(result.applied, true);
  assert.equal(req.content[0].text, '当前 Owner 请求原文：\n重建后的会话');
});

test('dispose of the plugin closes a recreated scope exactly once', async () => {
  const first = fakeService();
  const second = fakeService();
  const scope = createOwnerPromptScope({section: SECTION});
  await scope.attach({id: 'family_owner_reused2', ctx: {get: () => first}});
  await scope.detach('family_owner_reused2');
  await scope.attach({id: 'family_owner_reused2', ctx: {get: () => second}});
  await scope.close();
  assert.equal(second.calls.dispose, 1);
  const after = request(turn('关闭之后'));
  assert.equal((await scope.prepareRequest('family_owner_reused2', after)).applied, false);
  assert.equal(after.content[0].text, turn('关闭之后'));
});

test('the recorded verdict round-trips for verify-deploy', () => {
  const directory = mkdtempSync(join(tmpdir(), 'family-scope-'));
  try {
    assert.equal(readScope(directory), null);
    recordScope(directory, {sessionId: 'family_owner_x', verified: true, reason: 'section_verified', sectionLength: 2184});
    const back = readScope(directory);
    assert.equal(back.verified, true);
    assert.equal(back.reason, 'section_verified');
    assert.equal(back.sectionLength, 2184);
    assert.ok(!JSON.stringify(back).includes('乐乐'), 'record never contains policy text');
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
