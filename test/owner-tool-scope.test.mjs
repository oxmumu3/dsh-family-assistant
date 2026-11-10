// The Owner's own sessions are ordinary Host sessions. This plugin used to
// install a tools guard that reduced a family_owner_ session to a short
// allowlist and forced the native tool presentation; both are gone. Family
// members never run in a family_owner_ session (see family-project-executor
// and owner-agent-host tests), so nothing here loosens them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function host() {
  const calls = {guard: 0, registered: [], presentAs: 0, setExecutor: 0};
  const listeners = new Map();
  const services = {
    connection: {fetch: {register() { return async () => {}; }}},
    tools: {register(tool) { calls.registered.push('global:' + tool.name); return () => {}; }, guard() { calls.guard++; return () => {}; }},
    llm: {listProviders: () => []},
    agents: {list: () => [], get: () => undefined},
  };
  const ctx = {
    get: name => services[name], tools: services.tools, effect: execute => execute(),
    on(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); return () => {}; },
  };
  const emit = (name, event) => { for (const listener of listeners.get(name) ?? []) listener(event); };
  const agent = id => ({id, ctx: {get: name => name === 'tools' ? {
    register(tool) { calls.registered.push(id + ':' + tool.name); return () => {}; },
    presentAs() { calls.presentAs++; return () => {}; },
    setExecutor() { calls.setExecutor++; return () => {}; },
  } : undefined}});
  return {ctx, emit, agent, calls};
}

test('the plugin installs no tool guard and leaves an Owner session on the Host default executor', async t => {
  const {apply} = await import('../index.js');
  const directory = mkdtempSync(join(tmpdir(), 'family-owner-full-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const {ctx, emit, agent, calls} = host();
  const dispose = await apply(ctx, {storageDir: directory}); t.after(dispose);
  emit('agent/created', {agent: agent('family_owner_abc')});
  emit('agent/created', {agent: agent('unrelated_session')});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.guard, 0, 'no tools.guard may be installed for any session');
  assert.equal(calls.presentAs, 0, 'the Owner session keeps the Host tool presentation');
  assert.equal(calls.setExecutor, 0, 'the Owner session keeps the Host tool executor');
  assert.deepEqual(calls.registered, ['family_owner_abc:family_assistant', 'family_owner_abc:family_owner_projects'], 'family tools are added to the Owner session only');
});

test('the plugin still mounts on a Host that offers no tools.guard', async t => {
  const {apply} = await import('../index.js');
  const directory = mkdtempSync(join(tmpdir(), 'family-owner-noguard-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const {ctx, emit, agent, calls} = host();
  delete ctx.get('tools').guard;
  const dispose = await apply(ctx, {storageDir: directory}); t.after(dispose);
  emit('agent/created', {agent: agent('family_owner_abc')});
  assert.deepEqual(calls.registered, ['family_owner_abc:family_assistant', 'family_owner_abc:family_owner_projects']);
});

test('the removed guard cannot return unnoticed', () => {
  assert.equal(existsSync(join(root, 'src/owner-dot-read-guard.mjs')), false);
  const entry = readFileSync(join(root, 'index.js'), 'utf8');
  for (const trace of ['tools.guard', 'owner_read_guard', 'presentAs', 'setExecutor', '本轮仅允许']) {
    assert.equal(entry.includes(trace), false, `index.js must not contain ${trace}`);
  }
  // An Owner prompt has no precondition other than the optional prompt scope.
  assert.match(entry, /beforePrompt:async \(sessionId,request\)=>\{try\{await ownerPromptScope\.prepareRequest\(sessionId,request\);\}catch\{\}\}/);
});
