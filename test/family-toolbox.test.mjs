import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFamilyToolbox } from '../src/family-toolbox.mjs';

const now = () => '2026-10-25T00:00:00.000Z';
function fixture(t, executors = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'family-toolbox-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const people = [{ id: 'owner', role: 'owner', createdAt: 'owner-v1' }, { id: 'mom', role: 'elder', createdAt: 'mom-v1' }, { id: 'dad', role: 'elder', createdAt: 'dad-v1' }];
  const bindings = [{ personId: 'mom', accountId: 'account', peerId: 'peer', generation: 1, status: 'connected' }];
  const store = { snapshot: () => structuredClone({ people, bindings }) };
  const options = { directory, store, executors, now };
  return { directory, people, bindings, options, box: createFamilyToolbox(options) };
}
const grant = { actorId: 'owner', personId: 'mom', toolId: 'ai_digest', resource: { workspaceId: 'daily', relativePath: 'reports/latest.md' }, allowInvoke: true };
const request = { personId: 'mom', toolId: 'ai_digest', requestId: 'request-1', input: { topic: 'private topic' } };
const rejects = (fn, code) => assert.rejects(fn, error => error.code === code);

test('Owner latest digest grants survive restart while member input cannot change the selected source family or zone', async t => {
  const seen=[];const f=fixture(t,{ai_digest:args=>{seen.push(args.resource);return 'report';}});
  const resource={workspaceId:'daily',relativePath:'reports/2026-10-25-wechat.txt',selection:'latest',sourceTimeZone:'America/Mexico_City'};
  const assigned=f.box.assign({...grant,resource});assert.deepEqual(assigned.resource,resource);
  const restarted=createFamilyToolbox(f.options);
  const result=await restarted.invoke({...request,input:{selection:'latest',sourceTimeZone:'Asia/Shanghai',relativePath:'elsewhere/latest.md'}});
  assert.equal(result.status,'succeeded');assert.deepEqual(seen,[resource]);
  for(const patch of [{sourceTimeZone:'Fake/Zone'},{selection:'all'},{sourceTimeZone:undefined},{relativePath:'reports/notes.md'}])assert.throws(()=>f.box.assign({...grant,resource:{...resource,...patch}}),{code:'invalid_argument'});
});

test('missing current digest and ambiguous source failures retain only a finite safe cause', async t => {
  for(const failureCode of ['digest_no_current_report','digest_ambiguous_source','digest_source_changed']){
    const f=fixture(t,{ai_digest:()=>{throw Object.assign(new Error('PRIVATE_PATH secret'),{code:failureCode});}});f.box.assign(grant);
    const result=await f.box.invoke(request);assert.equal(result.reason,'executor_failed');assert.equal(result.failureCode,failureCode);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PATH|secret/);
    const restarted=createFamilyToolbox(f.options);assert.equal((await restarted.invoke(request)).failureCode,failureCode);
  }
});

test('catalog defaults closed; Owner sees fixed templates and truthful preparation state', t => {
  const { box } = fixture(t);
  assert.deepEqual(box.catalog({ personId: 'mom' }), []);
  const catalog = box.catalog({ personId: 'owner' });
  assert.deepEqual(catalog.map(row => row.toolId), ['ai_digest', 'weather', 'presentation']);
  assert.ok(catalog.every(row => !row.ready && row.reason === 'not_configured'));
  assert.throws(() => box.catalog({ personId: 'unknown' }), { code: 'unknown_person' });
});

test('only live Owner assigns, revisions advance, returned copies and member grants isolate', async t => {
  const { box, people } = fixture(t);
  assert.throws(() => box.assign({ ...grant, actorId: 'mom' }), { code: 'forbidden' });
  const first = box.assign(grant); assert.equal(first.revision, 1);
  first.resource.relativePath = 'private.md';
  assert.equal(box.catalog({ personId: 'mom' })[0].toolId, 'ai_digest');
  assert.deepEqual(box.catalog({ personId: 'dad' }), []);
  assert.doesNotMatch(JSON.stringify(box.catalog({ personId: 'owner' })), /reports|latest|private/);
  await rejects(() => box.invoke(request), 'not_configured');
  assert.equal(box.assign({ ...grant, allowInvoke: false }).revision, 2);
  assert.deepEqual(box.catalog({ personId: 'mom' }), []);
  people[0].role = 'elder';
  assert.throws(() => box.assign(grant), { code: 'forbidden' });
});

test('executor receives only scoped data after durable running write; duplicate request never executes twice', async t => {
  let calls = 0, f;
  f = fixture(t, { ai_digest: async value => {
    calls++; assert.deepEqual(Object.keys(value).sort(), ['input', 'personId', 'resource', 'signal']);
    assert.ok(value.signal instanceof AbortSignal);
    const disk = JSON.parse(readFileSync(join(f.directory, 'family-toolbox.json'), 'utf8'));
    assert.equal(disk.runs[0].status, 'running');
    value.resource.relativePath = 'mutated.md'; value.input.topic = 'mutated';
    return { text: 'digest' };
  } });
  f.box.assign(grant);
  const output = await f.box.invoke(request); assert.equal(output.status, 'succeeded'); assert.deepEqual(output.result, { text: 'digest' });
  output.result.text = 'changed';
  assert.equal((await f.box.invoke(request)).result.text, 'digest'); assert.equal(calls, 1);
  await rejects(() => f.box.invoke({ ...request, input: { topic: 'changed' } }), 'request_conflict');
  assert.equal(request.input.topic, 'private topic');
  assert.doesNotMatch(JSON.stringify(f.box.catalog({ personId: 'owner' })), /private topic|mutated\.md/);
  assert.equal(statSync(join(f.directory, 'family-toolbox.json')).mode & 0o777, 0o600);
});

test('concurrent duplicates share one admission, and executor failures are redacted', async t => {
  let release, count = 0;
  const f = fixture(t, { ai_digest: () => { count++; return new Promise(resolve => { release = resolve; }); } });
  f.box.assign(grant);
  const a = f.box.invoke(request), b = f.box.invoke(request);
  await new Promise(resolve => setImmediate(resolve)); release('done');
  assert.equal((await a).status, 'succeeded'); assert.equal((await b).status, 'succeeded'); assert.equal(count, 1);
  f.options.executors.ai_digest = () => { throw new Error('secret-token https://private'); };
  const result = await f.box.invoke({ ...request, requestId: 'failure' });
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'executor_failed');
  assert.doesNotMatch(JSON.stringify(result), /secret|https/);
});

test('revocation, reassignment and member lifecycle changes block execution and old-output replay', async t => {
  const f = fixture(t, { ai_digest: () => 'old private output' });
  f.box.assign(grant); await f.box.invoke(request);
  f.box.assign({ ...grant, resource: { workspaceId: 'new', relativePath: 'new.md' } });
  await rejects(() => f.box.invoke(request), 'authorization_changed');
  await rejects(() => f.box.invoke({ ...request, requestId: 'fresh', expectedRevision: 1 }), 'authorization_changed');
  const guarded = await f.box.invoke({ ...request, requestId: 'before-revoke' }, { authorize: () => { f.box.assign({ ...grant, allowInvoke: false }); return true; } });
  assert.equal(guarded.status, 'failed'); assert.equal(guarded.reason, 'authorization_changed');
  f.box.assign(grant); f.people.splice(1, 1);
  await rejects(() => f.box.invoke({ ...request, requestId: 'removed' }), 'unknown_person');
});

test('cancel, rebind and post-execution route guards suppress results without claiming delivery', async t => {
  const f = fixture(t, { ai_digest: () => { f.bindings[0].generation++; return 'private'; } });
  f.box.assign(grant);
  const rebound = await f.box.invoke(request);
  assert.equal(rebound.status, 'uncertain'); assert.equal(rebound.reason, 'authorization_changed'); assert.equal(rebound.result, undefined);
  f.options.executors.ai_digest = () => 'private';
  let checks = 0;
  const blocked = await f.box.invoke({ ...request, requestId: 'guarded' }, { authorize: () => ++checks === 1 });
  assert.equal(blocked.status, 'uncertain'); assert.equal(blocked.result, undefined);
  const controller = new AbortController(); controller.abort();
  await rejects(() => f.box.invoke({ ...request, requestId: 'cancelled' }, { signal: controller.signal }), 'cancelled');
  f.options.executors.ai_digest = ({ signal }) => { controller.abort(); assert.ok(signal instanceof AbortSignal); return 'private'; };
  const later = new AbortController();
  f.options.executors.ai_digest = () => { later.abort(); return 'private'; };
  const cancelled = await f.box.invoke({ ...request, requestId: 'mid-cancel' }, { signal: later.signal });
  assert.equal(cancelled.status, 'uncertain'); assert.equal(cancelled.result, undefined);
});

test('Owner delegation is a separate method with live actor validation', async t => {
  const f = fixture(t, { ai_digest: () => 'ok' }); f.box.assign(grant);
  await rejects(() => f.box.invokeFor({ ...request, actorId: 'dad' }), 'forbidden');
  await rejects(() => f.box.invokeFor(request), 'invalid_argument');
  assert.equal((await f.box.invokeFor({ ...request, actorId: 'owner' })).status, 'succeeded');
  await rejects(() => f.box.invoke({ ...request, requestId: 'forged', actorId: 'owner' }), 'invalid_argument');
});

test('duplicate waiters recheck their own route after the shared executor finishes', async t => {
  let release, checks = 0;
  const f = fixture(t, { ai_digest: () => new Promise(resolve => { release = resolve; }) }); f.box.assign(grant);
  const first = f.box.invoke(request);
  const duplicate = f.box.invoke(request, { authorize: () => ++checks === 1 });
  await new Promise(resolve => setImmediate(resolve)); release('private');
  assert.equal((await first).status, 'succeeded');
  await rejects(() => duplicate, 'authorization_changed');
});

test('a recovered run cannot be overwritten by an older in-flight executor', async t => {
  let f;
  f = fixture(t, { ai_digest: () => { createFamilyToolbox(f.options); return 'late result'; } }); f.box.assign(grant);
  assert.equal((await f.box.invoke(request)).status, 'uncertain');
});

test('outbox guard checks durable success, exact revision and live authorization without exposing results', async t => {
  const f = fixture(t, { ai_digest: () => 'private output' }); f.box.assign(grant);
  const descriptor = { personId: 'mom', toolId: 'ai_digest', requestId: 'request-1', revision: 1 };
  assert.equal(f.box.isCurrent(descriptor), false);
  await f.box.invoke(request); assert.equal(f.box.isCurrent(descriptor), true);
  assert.equal(f.box.isCurrent({ ...descriptor, revision: 2 }), false);
  assert.equal(f.box.isCurrent({ ...descriptor, role: 'owner' }), false);
  f.bindings[0].generation++; assert.equal(f.box.isCurrent(descriptor), false);
  f.bindings[0].generation--; f.box.assign({ ...grant, allowInvoke: false });
  assert.equal(f.box.isCurrent(descriptor), false);
  f.box.assign(grant); assert.equal(f.box.isCurrent(descriptor), false);
});

test('template resources, JSON input, fields and enabled schedules have strict bounds', t => {
  const { box } = fixture(t);
  for (const relativePath of ['/secret.md', '../secret.md', 'a/../secret.md', '.hidden.md', 'a/.hidden/x.md', 'a\\x.md', 'a.exe', 'a\nx.md', 'C:/x.md']) {
    assert.throws(() => box.assign({ ...grant, resource: { workspaceId: 'daily', relativePath } }), { code: 'invalid_argument' });
  }
  for (const patch of [{ toolId: 'shell' }, { resource: { workspaceId: 'daily', relativePath: 'x.md', role: 'owner' } }, { schedule: { enabled: true, time: '08:00' } }, { schedule: { enabled: true, time: '25:00', timeZone: 'Asia/Shanghai' } }, { schedule: { enabled: true, time: '08:00', timeZone: 'Fake/Zone' } }, { role: 'owner' }]) {
    assert.throws(() => box.assign({ ...grant, ...patch }), { code: 'invalid_argument' });
  }
  assert.throws(() => box.assign({ ...grant, toolId: 'presentation', resource: { workflow: 'shell' } }), { code: 'invalid_argument' });
  assert.throws(() => box.assign({ ...grant, toolId: 'weather', resource: { city: '' } }), { code: 'invalid_argument' });
});

test('daily schedules use explicit zones and stable per-revision/date/minute source keys; default schedules stay off', t => {
  const f = fixture(t, { ai_digest: () => 'ok', weather: () => 'clear' });
  f.box.assign(grant); assert.deepEqual(f.box.due(), []);
  f.box.assign({ ...grant, schedule: { enabled: true, time: '08:00', timeZone: 'Asia/Shanghai' } });
  f.box.assign({ ...grant, personId: 'dad', toolId: 'weather', resource: { city: 'Mexico City' }, schedule: { enabled: true, time: '18:00', timeZone: 'America/Mexico_City' } });
  const due = f.box.due(); assert.equal(due.length, 2);
  const mom = due.find(row => row.personId === 'mom');
  assert.equal(mom.localDate, '2026-10-25'); assert.equal(mom.time, '08:00'); assert.equal(mom.expectedRevision, 2);
  assert.deepEqual(f.box.due(), due); assert.equal(mom.requestId, mom.sourceKey);
  assert.equal(due.find(row => row.personId === 'dad').localDate, '2026-10-24');
});

test('workflow requests persist for Owner only and do not assign or run a tool', t => {
  const { box, options } = fixture(t, { presentation: () => assert.fail('must not execute') });
  const input = { personId: 'mom', requestId: 'workflow-1', text: '帮我制作社区汇报 PPT' };
  assert.equal(box.requestWorkflow(input).status, 'pending'); assert.equal(box.requestWorkflow(input).status, 'pending');
  assert.throws(() => box.requestWorkflow({ ...input, text: 'different' }), { code: 'request_conflict' });
  assert.throws(() => box.listRequests({ actorId: 'dad' }), { code: 'forbidden' });
  assert.equal(createFamilyToolbox(options).listRequests({ actorId: 'owner' }).length, 1);
  assert.deepEqual(box.catalog({ personId: 'mom' }), []);
});

test('restart marks unfinished durable work uncertain without rerun; stale authorization cannot reveal old results', async t => {
  let f, count = 0;
  f = fixture(t, { ai_digest: () => { count++; return 'done'; } }); f.box.assign(grant);
  await f.box.invoke(request);
  const file = join(f.directory, 'family-toolbox.json'), saved = JSON.parse(readFileSync(file, 'utf8'));
  saved.runs[0].status = 'running'; delete saved.runs[0].result; writeFileSync(file, JSON.stringify(saved));
  const reloaded = createFamilyToolbox(f.options);
  assert.equal((await reloaded.invoke(request)).status, 'uncertain'); assert.equal(count, 1);
});

test('unknown schemas, fields and symlink replacement fail closed without overwriting evidence', t => {
  const f = fixture(t), file = join(f.directory, 'family-toolbox.json');
  for (const value of [{ version: 99, grants: [], runs: [], requests: [] }, { version: 1, grants: [], runs: [], requests: [], ownerOverride: true }, { version: 1, grants: [{ ...grant, revision: 1 }], runs: [], requests: [] }]) {
    const data = JSON.stringify(value); writeFileSync(file, data);
    assert.throws(() => createFamilyToolbox(f.options), { code: 'invalid_state' }); assert.equal(readFileSync(file, 'utf8'), data);
  }
  const target = join(f.directory, 'target.json'); writeFileSync(target, JSON.stringify({ version: 1, grants: [], runs: [], requests: [] }));
  unlinkSync(file); symlinkSync(target, file);
  assert.throws(() => createFamilyToolbox(f.options), { code: 'unsafe_path' });
});

test('an installed executor is distinct from a member assignment and verified data source',t=>{
 const{box}=fixture(t,{ai_digest:async()=>({text:'synthetic'})});
 let row=box.catalog({personId:'owner'}).find(row=>row.toolId==='ai_digest');
 assert.equal(row.executorAvailable,true);assert.equal(row.ready,false);assert.equal(row.reason,'not_assigned');assert.equal(row.sourceStatus,'not_checked');
 box.assign(grant);row=box.catalog({personId:'mom'})[0];assert.equal(row.ready,true);assert.equal(row.sourceStatus,'not_checked');
});

test('Owner may configure a disconnected family member, while invocation waits for their live connection',async t=>{
 const{box,bindings}=fixture(t,{ai_digest:async()=>({text:'synthetic'})});bindings[0].status='disconnected';
 const saved=box.assign(grant);assert.equal(saved.personId,'mom');assert.equal(box.catalog({personId:'mom'})[0].toolId,'ai_digest');
 await rejects(()=>box.invoke(request),'member_inactive');assert.deepEqual(box.due(),[]);
});
test('trusted Owner administration does not depend on Owner WeChat being connected',t=>{
 const{box,bindings}=fixture(t);bindings.push({personId:'owner',accountId:'owner',peerId:'owner',generation:1,status:'disconnected'});
 assert.equal(box.assign(grant).personId,'mom');assert.equal(box.listRequests({actorId:'owner'}).length,0);
});
