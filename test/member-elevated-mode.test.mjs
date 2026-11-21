import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../src/runtime.mjs';
import { createOwnerManagementTool } from '../src/owner-management-tool.mjs';
import { checkElevatedToolExecution, isPathConfinedToWorkspace } from '../src/member-elevated-host.mjs';
import { createFamilyToolExecutors } from '../src/family-tool-executors.mjs';
import {
  SKILL_PACK_IDS,
  listSkillPackCatalog,
  readWorkspaceAgentsMd,
  readWorkspaceSkillPacks,
  syncWorkspaceSkillPacks,
  writeWorkspaceAgentsMd,
} from '../src/member-skill-packs.mjs';

const waitFor = async (check, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail('condition not met within timeout');
};

function setupConnectedPerson(dir, runtime, { id, role, label, accountId, peerId, token, timeZone = 'Asia/Shanghai' }) {
  runtime.store.addPerson({ id, role, label, timeZone });
  runtime.store.bindPerson(id, { accountId, peerId });
  const channelsDir = join(dir, 'channels', id);
  mkdirSync(channelsDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(channelsDir, 'auth.json'), JSON.stringify({
    token,
    baseUrl: 'https://ilinkai.weixin.qq.com',
    accountId,
    peerId,
    cursor: '',
    contextToken: `${id}-ctx`,
  }), { mode: 0o600 });
}

function createFakeApi(sentTexts, sentFiles = []) {
  return {
    async poll({ signal }) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
    async send({ peerId, text }) {
      sentTexts.push({ peerId, text });
      return { status: 'api_accepted', messageId: 'txt-' + sentTexts.length };
    },
    async sendFile({ peerId, name, bytes }) {
      sentFiles.push({ peerId, name, text: bytes.toString('utf8'), bytes });
      return { status: 'api_accepted', messageId: 'file-' + sentFiles.length };
    },
  };
}

function createFakeHostControllers() {
  const workspaces = [];
  const sessions = new Map();
  const agents = new Map();

  const workspaceController = {
    async *follow() {
      yield { type: 'baseline', value: { items: workspaces.map(w => ({ ...w, sessionIds: [...w.sessionIds] })) } };
    },
    async create({ path }) {
      let ws = workspaces.find(row => row.path === path);
      if (!ws) {
        ws = { workspaceId: 'ws-' + (workspaces.length + 1), path, title: 'Workspace ' + (workspaces.length + 1), sessionIds: [] };
        workspaces.push(ws);
      }
      return { workspace: { ...ws, sessionIds: [...ws.sessionIds] }, created: true };
    },
  };

  function makeFakeAgent(sessionId) {
    const events = [];
    const registered = [];
    const restrictions = [];
    const guards = [];
    const approvalHandlers = [];
    const projections = { values: { sandboxMode: 'read-only' } };
    const agent = {
      id: sessionId,
      events,
      registered,
      restrictions,
      guards,
      approvalHandlers,
      projections,
      session: {
        projections,
        append(type, data) {
          events.push({ type, data });
          if (type === 'sandbox/mode') projections.values.sandboxMode = data.mode;
        },
      },
      ctx: {
        get(name) {
          if (name !== 'tools') return null;
          return {
            definitions() {
              return [
                { name: 'read_file' }, { name: 'write_file' }, { name: 'bash' },
                { name: 'ask_user_question' }, { name: 'family_assistant' },
              ];
            },
            restrict(filter) {
              restrictions.push(filter);
              return () => {};
            },
            guard(fn) {
              guards.push(fn);
              return () => {};
            },
            register(def) {
              registered.push(def);
              return () => {};
            },
          };
        },
        on(event, handler) {
          if (event === 'approval/request') approvalHandlers.push(handler);
          return () => {};
        },
      },
      cancelledCalls: 0,
      cancel() {
        agent.cancelledCalls += 1;
      },
    };
    return agent;
  }

  let seqCounter = 0;
  let turnCounter = 0;
  let onPromptHook = null;

  const sessionController = {
    async create({ workspaceId, sessionId }) {
      const ws = workspaces.find(row => row.workspaceId === workspaceId);
      if (!ws) throw new Error('unknown workspace');
      if (!ws.sessionIds.includes(sessionId)) ws.sessionIds.push(sessionId);
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { cwd: ws.path, records: [] });
        agents.set(sessionId, makeFakeAgent(sessionId));
      }
      return { sessionId };
    },
    async prompt(request) {
      const s = sessions.get(request.sessionId);
      if (!s) throw new Error('unknown session');
      const turn = ++turnCounter;
      const text = request.content.map(c => c.text).join('\n');
      s.records.push({ type: 'event', event: { seq: ++seqCounter, type: 'turn/start', data: { turn } } });
      s.records.push({ type: 'event', event: { seq: ++seqCounter, type: 'user/message', data: { turn, source: { kind: 'user', rpcId: request.requestId }, content: [{ type: 'text', text }] } } });
      if (typeof onPromptHook === 'function') {
        void onPromptHook({
          session: s,
          sessionId: request.sessionId,
          agent: agents.get(request.sessionId),
          turn,
          requestId: request.requestId,
          text,
          pushEvent(type, data) {
            s.records.push({ type: 'event', event: { seq: ++seqCounter, type, data } });
          },
        });
      }
      return { accepted: true };
    },
    async *follow({ address }) {
      const s = sessions.get(address.sessionId);
      yield {
        type: 'snapshot',
        header: { id: address.sessionId, cwd: s?.cwd ?? '' },
        records: s ? [...s.records] : [],
        hasMore: false,
        cursor: seqCounter,
        projections: { values: {} },
      };
    },
    async page({ address }) {
      const s = sessions.get(address.sessionId);
      return { records: s ? [...s.records] : [], hasMore: false };
    },
    async cancel() {
      return { ok: true };
    },
  };

  return {
    workspaces,
    sessions,
    agents,
    workspaceController,
    sessionController,
    agentsRegistry: { get: id => agents.get(id) },
    setOnPrompt(fn) { onPromptHook = fn; },
  };
}

test('elevated_manage on family_assistant grants, lists, expires, and revokes isolated elevated builder mode', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'family-elevated-grant-')));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir + '-member-workspaces', { recursive: true, force: true });
  });

  const sentTexts = [];
  const host = createFakeHostControllers();
  let currentTimeMs = Date.parse('2026-11-21T04:00:00Z');
  let activeOwnerIntent = null;

  const controlDir = join(dir, 'owner-ctrl');
  mkdirSync(controlDir, { recursive: true });

  const runtime = createRuntime({
    directory: dir,
    api: createFakeApi(sentTexts),
    now: () => new Date(currentTimeMs).toISOString(),
    intervalMs: 600_000,
    ownerAgent: {
      ensureControlWorkspace: async () => ({ workspaceId: 'ws-owner', title: 'Owner', path: controlDir }),
      listWorkspaces: async () => [
        { workspaceId: 'ws-owner', title: 'Owner', path: controlDir, sessionIds: [] },
        ...host.workspaces,
      ],
      start: async intent => { activeOwnerIntent = intent; return { state: 'running' }; },
      observe: async intent => ({
        workspaceId: intent.workspaceId,
        sessionId: intent.sessionId,
        requestId: intent.requestId,
        cwd: intent.cwd,
        state: 'running',
        requestSeen: true,
        queued: false,
        foreign: false,
        turn: 1,
        activeTurn: 1,
        activeRequestIds: [intent.requestId],
        events: [{ type: 'tool/call', seq: 2, turn: 1, name: 'family_assistant', callId: 'call-elev-1', status: 'running' }],
      }),
    },
    elevatedControllers: {
      getWorkspaceController: () => host.workspaceController,
      getSessionController: () => host.sessionController,
      getAgents: () => host.agentsRegistry,
    },
  });
  t.after(() => runtime.close());

  setupConnectedPerson(dir, runtime, {
    id: 'owner-1', role: 'owner', label: '我',
    accountId: 'owner@im.bot', peerId: 'owner@im.wechat', token: 'tok-owner',
  });
  setupConnectedPerson(dir, runtime, {
    id: 'wkb', role: 'elder', label: '王凯伯',
    accountId: 'wkb@im.bot', peerId: 'wkb@im.wechat', token: 'tok-wkb',
  });
  await runtime.start();

  const ownerTool = createOwnerManagementTool({ runtime, directory: dir });

  // Activate Owner native turn
  await runtime.receive('owner-1', { id: 'm-owner-1', peerId: 'owner@im.wechat', text: '给王凯伯临时开高权限' });
  await waitFor(() => activeOwnerIntent !== null);

  const exec = { callId: 'call-elev-1', agent: { id: activeOwnerIntent.sessionId }, rootCallId: 'call-elev-1', signal: new AbortController().signal };

  // Cannot grant to owner
  await assert.rejects(
    () => ownerTool.execute({ action: 'elevated_manage', op: 'grant', personId: 'owner-1' }, exec),
    /家庭成员/,
  );

  // Grant 48h to wkb
  const grantRes = await ownerTool.execute({
    action: 'elevated_manage',
    op: 'grant',
    personId: 'wkb',
    durationHours: 48,
    note: '跨境并购日报自助搭建',
  }, exec);
  assert.equal(grantRes.status, 'completed');
  assert.equal(grantRes.grant.active, true);
  assert.equal(grantRes.grant.durationHours, 48);
  assert.ok(grantRes.grant.sessionId.startsWith('family_member_elevated_wkb_'));
  assert.ok(grantRes.grant.workspacePath.endsWith('/wkb'));
  assert.equal(existsSync(join(grantRes.grant.workspacePath, 'scripts')), true);
  assert.equal(existsSync(join(grantRes.grant.workspacePath, 'reports')), true);
  assert.ok(grantRes.grant.workspaceId, 'isolated workspace registered into host controller');

  const listed = await ownerTool.execute({ action: 'elevated_manage', op: 'list', personId: 'wkb' }, exec);
  assert.equal(listed.grants.length, 1);
  assert.equal(listed.grants[0].active, true);

  // Advance clock 49h -> auto-expired
  currentTimeMs += 49 * 3600_000;
  assert.equal(runtime.memberElevated.isActive('wkb', { at: new Date(currentTimeMs).toISOString(), bindingGeneration: 1 }), false);

  // Re-grant & configure skill packs + AGENTS.md via ownerTool, then revoke explicitly
  currentTimeMs = Date.parse('2026-11-21T05:00:00Z');
  await ownerTool.execute({ action: 'elevated_manage', op: 'grant', personId: 'wkb', durationHours: 24 }, exec);
  assert.equal(runtime.memberElevated.isActive('wkb', { at: new Date(currentTimeMs).toISOString(), bindingGeneration: 1 }), true);

  const packsRes = await ownerTool.execute({ action: 'elevated_manage', op: 'set_packs', personId: 'wkb', skillPacks: ['executive-reporting', 'bi-analysis'] }, exec);
  assert.equal(packsRes.status, 'completed');
  assert.deepEqual(packsRes.skillPacks.installed, ['bi-analysis', 'executive-reporting']);

  const agentsRes = await ownerTool.execute({ action: 'elevated_manage', op: 'set_agents_md', personId: 'wkb', agentsMd: '# Banker Scope\nM&A Loans' }, exec);
  assert.equal(agentsRes.status, 'completed');
  assert.equal(agentsRes.hasAgentsMd, true);

  const revoked = await ownerTool.execute({ action: 'elevated_manage', op: 'revoke', personId: 'wkb' }, exec);
  assert.equal(revoked.status, 'completed');
  assert.equal(revoked.grant.active, false);
  assert.equal(runtime.memberElevated.isActive('wkb', { at: new Date(currentTimeMs).toISOString(), bindingGeneration: 1 }), false);
});

test('elevated member bypasses legacy elder regex intercepts, waits for turn/end across multi-step tool calls, and restores legacy path upon revoke', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'family-elevated-turn-')));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir + '-member-workspaces', { recursive: true, force: true });
  });

  const sentTexts = [];
  const legacyCalls = [];
  const host = createFakeHostControllers();
  let currentTimeMs = Date.parse('2026-11-21T06:00:00Z');

  const runtime = createRuntime({
    directory: dir,
    api: createFakeApi(sentTexts),
    now: () => new Date(currentTimeMs).toISOString(),
    intervalMs: 600_000,
    respond: async () => ({ reply: '普通通道回复', action: null }),
    planOwner: async () => ({ action: null, reply: '跨成员安排需要由 Owner 发起' }),
    memberAgent: {
      prepare: ({ admissionKey }) => ({ prepared: true, canRun: true, admissionKey }),
      run: async ({ text }) => {
        legacyCalls.push(text);
        return { text: '普通乐乐回复：' + text, state: 'succeeded', actions: [], files: [], deliveries: [] };
      },
      snapshot: () => ({ active: 0, requests: [] }),
    },
    elevatedControllers: {
      getWorkspaceController: () => host.workspaceController,
      getSessionController: () => host.sessionController,
      getAgents: () => host.agentsRegistry,
    },
  });
  t.after(() => runtime.close());

  setupConnectedPerson(dir, runtime, {
    id: 'owner-1', role: 'owner', label: '我',
    accountId: 'owner@im.bot', peerId: 'owner@im.wechat', token: 'tok-o',
  });
  setupConnectedPerson(dir, runtime, {
    id: 'wkb', role: 'elder', label: '王凯伯',
    accountId: 'wkb@im.bot', peerId: 'wkb@im.wechat', token: 'tok-w',
  });
  await runtime.start();

  await runtime.action({ action: 'member_elevated_grant', personId: 'wkb', durationHours: 72, note: 'M&A daily' });

  host.setOnPrompt(async ctx => {
    // Synchronously simulate Host agent/created hook firing
    runtime.memberElevatedHost.attachAgent(ctx.agent);

    // Step 1: intermediate assistant message (must NOT cause premature return!)
    await new Promise(resolve => setTimeout(resolve, 25));
    ctx.pushEvent('assistant/message', {
      turn: ctx.turn,
      message: { content: [{ type: 'text', text: '中间态消息：我先搜一下跨境并购最新公开新闻并写好抓取脚本…' }] },
    });

    // Step 2: tool execution
    await new Promise(resolve => setTimeout(resolve, 35));
    ctx.pushEvent('tool/call', { turn: ctx.turn, name: 'bash', callId: 'tc-1' });
    ctx.pushEvent('tool/result', { turn: ctx.turn, message: { toolCallId: 'tc-1', isError: false, content: [{ type: 'text', text: 'ok' }] } });

    // Step 3: final assistant response + turn/end, containing both a local path (should be scrubbed) and an https URL (must survive)
    await new Promise(resolve => setTimeout(resolve, 25));
    ctx.pushEvent('assistant/message', {
      turn: ctx.turn,
      message: { content: [{ type: 'text', text: '王凯伯您好！已做好跨境并购日报方案（脚本放在 /Users/shan/secret/foo.py，参考源 https://www.reuters.com/markets/deals/ ）。您看推送时间定在每天早上 8:30 可以吗？' }] },
    });
    ctx.pushEvent('turn/end', { turn: ctx.turn, reason: { kind: 'completed' } });
  });

  // This exact phrasing contains 帮/设置/推送/日报 which previously triggered isOwnerCommandCandidate!
  const res1 = await runtime.receive('wkb', { id: 'wkb-msg-1', peerId: 'wkb@im.wechat', text: '帮我设置一个每天早上8点半推送的跨境并购日报' });
  assert.equal(res1.accepted, true);
  assert.equal(res1.queued, true);

  await waitFor(() => sentTexts.some(m => m.peerId === 'wkb@im.wechat' && m.text.includes('8:30')));
  await runtime.settled();

  const delivered = sentTexts.filter(m => m.peerId === 'wkb@im.wechat').map(m => m.text).join('\n');
  assert.equal(delivered.includes('中间态消息'), false, 'must wait for turn/end rather than returning intermediate step-1 text');
  assert.equal(delivered.includes('跨成员安排需要由 Owner 发起'), false, 'must bypass elder regex trap');
  assert.equal(delivered.includes('https://www.reuters.com/markets/deals/'), true, 'https source URL must be preserved');
  assert.equal(delivered.includes('/Users/shan/secret/foo.py'), false, 'local filesystem path must be scrubbed');
  assert.equal(legacyCalls.length, 0);

  // Also test "我想要一个工具..." bypasses fixedMemberCommand
  const res2 = await runtime.receive('wkb', { id: 'wkb-msg-2', peerId: 'wkb@im.wechat', text: '我想要一个工具帮我整理港股和美股并购估值对比' });
  assert.equal(res2.queued, true);
  await runtime.settled();
  assert.equal(sentTexts.some(m => m.text.includes('已记下工具需求')), false);

  // Revoke elevated access -> falls back to legacy member path
  await runtime.action({ action: 'member_elevated_revoke', personId: 'wkb' });
  await runtime.receive('wkb', { id: 'wkb-msg-3', peerId: 'wkb@im.wechat', text: '你好，今天天气怎么样' });
  await waitFor(() => legacyCalls.length === 1);
  assert.equal(legacyCalls[0], '你好，今天天气怎么样');
});

test('security boundaries enforce sandbox workspace-write, block sensitive paths & escalations, and keep custom daily digests working after revocation', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'family-elevated-e2e-')));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir + '-member-workspaces', { recursive: true, force: true });
  });

  const sentTexts = [];
  const sentFiles = [];
  const host = createFakeHostControllers();
  // Keep mocked time >= real wall-clock mtime while remaining on 2026-11-21 Asia/Shanghai
  let currentTimeMs = Math.max(Date.parse('2026-11-21T15:20:00Z'), Date.now() + 60_000);
  const synthCalls = [];

  const runtime = createRuntime({
    directory: dir,
    api: createFakeApi(sentTexts, sentFiles),
    now: () => new Date(currentTimeMs).toISOString(),
    intervalMs: 600_000,
    toolExecutors: createFamilyToolExecutors({
      ownerAgent: {
        listWorkspaces: async () => host.workspaces.map(w => ({ ...w })),
      },
      now: () => new Date(currentTimeMs).toISOString(),
    }),
    llmSynthesize: async ({ title, today, rawMaterial, editorialPrompt }) => {
      synthCalls.push({ title, today, rawMaterial, editorialPrompt });
      const parsed = JSON.parse(rawMaterial.trim());
      return `【${title}｜${today}】\n1. ${parsed.deal}\n编辑要求已应用：${editorialPrompt}\n今日采集日期：${parsed.todayEnv}`;
    },
    elevatedControllers: {
      getWorkspaceController: () => host.workspaceController,
      getSessionController: () => host.sessionController,
      getAgents: () => host.agentsRegistry,
    },
  });
  t.after(() => runtime.close());

  setupConnectedPerson(dir, runtime, {
    id: 'owner-1', role: 'owner', label: '我',
    accountId: 'owner@im.bot', peerId: 'owner@im.wechat', token: 'tok-o',
  });
  setupConnectedPerson(dir, runtime, {
    id: 'wkb', role: 'elder', label: '王凯伯',
    accountId: 'wkb@im.bot', peerId: 'wkb@im.wechat', token: 'tok-w',
  });
  await runtime.start();

  const grantRes = await runtime.action({ action: 'member_elevated_grant', personId: 'wkb', durationHours: 72 });
  const grant = grantRes.grant;

  // Create collector script + a sample markdown file in wkb's isolated workspace
  const scriptPath = join(grant.workspacePath, 'scripts', 'collect_ma.mjs');
  writeFileSync(scriptPath, `
    console.log(JSON.stringify({
      deal: '某中资医疗器械龙头拟 4.2 亿美元收购德国影像企业 75% 股权',
      todayEnv: process.env.TODAY || '',
      hasSecretLeak: Boolean(process.env.AWS_SECRET_ACCESS_KEY || process.env.OPENAI_API_KEY)
    }));
  `.trim());
  writeFileSync(join(grant.workspacePath, 'reports', 'ma-notes.md'), '# 跨境并购观察模板\n重点：估值倍数与监管审批');

  // Also test symlink containment guard directly
  const outsideFile = join(dir, 'owner-secret.txt');
  writeFileSync(outsideFile, 'TOP_SECRET');
  const symlinkInside = join(grant.workspacePath, 'reports', 'evil-link.md');
  symlinkSync(outsideFile, symlinkInside);

  assert.equal(isPathConfinedToWorkspace('scripts/collect_ma.mjs', grant.workspacePath), true);
  assert.equal(isPathConfinedToWorkspace('~/.ssh/id_ed25519', grant.workspacePath), false);
  assert.equal(isPathConfinedToWorkspace('~/.dsh/.credentials.yaml', grant.workspacePath), false);
  assert.equal(isPathConfinedToWorkspace(symlinkInside, grant.workspacePath), false, 'symlink pointing outside workspace must be blocked');

  host.setOnPrompt(async ctx => {
    runtime.memberElevatedHost.attachAgent(ctx.agent);
    const agent = ctx.agent;

    // 1. Assert synchronous sandbox/mode upgrade & tool restrictions
    assert.equal(agent.projections.values.sandboxMode, 'workspace-write');
    assert.ok(agent.restrictions.some(r => r.deny?.includes('ask_user_question') && r.deny?.includes('family_assistant')));

    // 2. Assert tools/pre-execute guard behavior
    const guard = agent.guards[0];
    assert.equal(guard({ name: 'read_file', arguments: { file_path: join(grant.workspacePath, 'scripts/collect_ma.mjs') } }), undefined);
    assert.match(String(guard({ name: 'read_file', arguments: { file_path: '~/.dsh/.credentials.yaml' } })), /工作区范围|拦截/);
    assert.match(String(guard({ name: 'read_file', arguments: { file_path: '~/Library/Mobile Documents/com~apple~CloudDocs/Agent/secret.md' } })), /工作区范围|拦截/);
    assert.match(String(guard({ name: 'bash', arguments: { command: 'cat ~/.ssh/id_ed25519' } })), /安全护栏拦截/);
    assert.match(String(guard({ name: 'bash', arguments: { command: 'launchctl load ~/Library/LaunchAgents/x.plist' } })), /安全护栏拦截/);
    assert.match(String(guard({ name: 'bash', arguments: { command: 'echo ok', sandbox_permissions: 'require_escalated' } })), /不允许提权/);
    assert.equal(guard({ name: 'bash', arguments: { command: 'node scripts/collect_ma.mjs' } }), undefined);

    // 3. Assert approval/request auto-approves workspace/web calls and rejects escalations
    const handler = agent.approvalHandlers[0];
    assert.equal(await handler({ agent, toolName: 'bash', reason: 'run script inside workspace' }, () => 'unavailable'), 'allowed-once');
    assert.equal(await handler({ agent, toolName: 'bash', reason: 'switch to danger-full-access' }, () => 'unavailable'), 'rejected');

    // 4. Invoke member_digest_service(op="save_schedule") + member_send_workspace_file
    const digestTool = agent.registered.find(tool => tool.name === 'member_digest_service');
    const fileTool = agent.registered.find(tool => tool.name === 'member_send_workspace_file');
    assert.ok(digestTool && fileTool);

    const saved = await digestTool.execute({
      op: 'save_schedule',
      slug: 'cross-border-ma',
      title: '跨境并购日报',
      scheduleTime: '08:30',
      timeZone: 'Asia/Shanghai',
      collectorScript: 'scripts/collect_ma.mjs',
      editorialPrompt: '关注中资出海与医疗器械并购，标注金额与点评',
      deliverNow: true,
    }, { agent, signal: new AbortController().signal });
    assert.equal(saved.status, 'completed');
    assert.equal(saved.deliveredToWechat, true);

    await assert.rejects(
      () => fileTool.execute({ relativePath: 'reports/evil-link.md' }, { agent, signal: new AbortController().signal }),
      /符号链接/,
    );
    const fileSent = await fileTool.execute({ relativePath: 'reports/ma-notes.md', caption: '模板已就绪' }, { agent, signal: new AbortController().signal });
    assert.equal(fileSent.status, 'api_accepted');

    ctx.pushEvent('assistant/message', {
      turn: ctx.turn,
      message: { content: [{ type: 'text', text: '已为你建好「跨境并购日报」，每天 08:30 自动采集最新案例并推送微信，今天的首期样例和说明文档也刚发给你了。' }] },
    });
    ctx.pushEvent('turn/end', { turn: ctx.turn, reason: { kind: 'completed' } });
  });

  await runtime.receive('wkb', { id: 'wkb-build-1', peerId: 'wkb@im.wechat', text: '按每天 8:30 跨境医疗并购帮我做好定时日报并先发一版看看' });
  await waitFor(() => sentFiles.length === 1 && sentTexts.some(m => m.text.includes('4.2 亿美元收购德国影像企业')));
  await runtime.settled();

  // Verify collector received no secret env leaks
  assert.equal(synthCalls.length, 1);
  assert.equal(JSON.parse(synthCalls[0].rawMaterial).hasSecretLeak, false);

  // NOW Owner revokes 王凯伯's temporary elevated permission!
  await runtime.action({ action: 'member_elevated_revoke', personId: 'wkb' });
  assert.equal(runtime.memberElevated.isActive('wkb', { at: new Date(currentTimeMs).toISOString(), bindingGeneration: 1 }), false);

  // Advance clock to next morning 08:30 Asia/Shanghai (2026-11-22T00:30:00Z)
  currentTimeMs = Math.max(Date.parse('2026-11-22T00:30:00Z'), currentTimeMs + 9 * 3600_000);
  await runtime.tick();
  await runtime.settled();

  // Verify Day 2 report was generated and delivered to 王凯伯 on WeChat EVEN AFTER revocation!
  const day2ReportPath = join(grant.workspacePath, 'reports', 'cross-border-ma', '2026-11-22-wechat.txt');
  assert.equal(existsSync(day2ReportPath), true, 'Day 2 report file must be generated before scheduled delivery');
  assert.match(readFileSync(day2ReportPath, 'utf8'), /今日采集日期：2026-11-22/);
  assert.equal(sentTexts.some(m => m.peerId === 'wkb@im.wechat' && m.text.includes('跨境并购日报｜2026-11-22')), true, 'Day 2 report must be pushed to WeChat automatically');
});


test('pro_sandbox permanent seat, anti-clobber bind_qr, QR expiry auth fallback, template collector & update_preferences work end-to-end', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'family-pro-seat-023-')));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir + '-member-workspaces', { recursive: true, force: true });
  });

  const sentTexts = [];
  const host = createFakeHostControllers();
  let currentTimeMs = Date.parse('2026-11-21T08:00:00Z');
  let qrCalls = 0;

  const api = {
    ...createFakeApi(sentTexts),
    async getQr() {
      qrCalls += 1;
      return { qrcode: 'qr-' + qrCalls, qrUrl: 'https://weixin.qq.com/x/qr-' + qrCalls };
    },
    async checkQr() {
      return { status: 'expired' };
    },
  };

  const runtime = createRuntime({
    directory: dir,
    api,
    now: () => new Date(currentTimeMs).toISOString(),
    intervalMs: 600_000,
    llmSynthesize: async ({ title, editorialPrompt }) => `【${title}】实盘简报正文（口径：${editorialPrompt.slice(0, 40)}）`,
    elevatedControllers: {
      getWorkspaceController: () => host.workspaceController,
      getSessionController: () => host.sessionController,
      getAgents: () => host.agentsRegistry,
    },
  });
  t.after(() => runtime.close());

  setupConnectedPerson(dir, runtime, {
    id: 'owner-1', role: 'owner', label: '我',
    accountId: 'owner@im.bot', peerId: 'owner@im.wechat', token: 'tok-owner',
  });
  setupConnectedPerson(dir, runtime, {
    id: 'wkb', role: 'elder', label: '王凯伯',
    accountId: 'wkb@im.bot', peerId: 'wkb@im.wechat', token: 'tok-wkb',
  });
  await runtime.start();

  // 1. bind_qr on already-connected member refuses to clobber live pollLoop unless forceRebind=true
  const protectedQr = await runtime.ownerBindQr({ personId: 'wkb', sendToOwnerWechat: false });
  assert.equal(protectedQr.status, 'already_connected');
  assert.equal(qrCalls, 0);
  assert.equal(runtime.channels.status('wkb').status, 'connected');

  // 2. Even if forced login expires, channels.mjs auto-recovers existing auth.json back to connected!
  await runtime.action({ action: 'login', personId: 'wkb' });
  await waitFor(() => runtime.channels.status('wkb').status === 'connected');
  assert.equal(runtime.store.binding('wkb').status, 'connected');

  // 3. Permanent pro_sandbox grant never expires even after 60 days, and persona switches onboarding copy
  await runtime.action({ action: 'hearth_member_update', personId: 'wkb', persona: 'pro_peer', pinganEnabled: false });
  const perm = await runtime.action({ action: 'member_elevated_grant', personId: 'wkb', note: '常驻跨境并购专业席位' });
  assert.equal(perm.grant.permanent, true);
  assert.equal(perm.grant.expiresAt, null);
  currentTimeMs += 60 * 24 * 3600_000;
  assert.equal(runtime.memberElevated.isActive('wkb', { at: new Date(currentTimeMs).toISOString(), bindingGeneration: 1 }), true);

  // 4. Custom digest with built-in collector template + update_preferences (within 24h inbound window)
  runtime.store.addMessage('wkb', { dir: 'in', text: '请给我做一个每日跨境并购新闻日报', at: new Date(currentTimeMs).toISOString() });
  const saved = await runtime.action({
    action: 'member_custom_digest_save',
    personId: 'wkb',
    slug: 'crossborder-ma',
    title: '每日跨境并购新闻日报',
    scheduleTime: '08:00',
    scheduleDays: 'daily',
    collectorScript: null,
    editorialPrompt: '至少一方为境外主体，7大栏目，严禁编造',
    deliverNow: true,
  });
  assert.equal(saved.digestResult.status, 'completed');
  assert.equal(saved.digestResult.deliveryStatus, 'api_accepted');
  assert.ok(sentTexts.some(m => m.peerId === 'wkb@im.wechat' && m.text.includes('每日跨境并购新闻日报')));

  const updated = runtime.customDigests.updatePreferences({
    personId: 'wkb',
    slug: 'crossborder-ma',
    appendNote: '5000万美元以下不进速览',
    scheduleDays: 'workdays',
  });
  assert.equal(updated.scheduleDays, 'workdays');
  assert.match(updated.editorialPrompt, /5000万美元以下不进速览/);

  // 5. CCB banker talking about "并购贷款 / 授信额度 / 跨境汇款交割" NEVER triggers elder scam safety_card!
  let bankerPromptSeen = '';
  host.setOnPrompt(async ctx => {
    runtime.memberElevatedHost.attachAgent(ctx.agent);
    bankerPromptSeen = ctx.text;
    ctx.pushEvent('assistant/message', { turn: ctx.turn, message: { content: [{ type: 'text', text: '已按跨境并购贷款口径收录。' }] } });
    ctx.pushEvent('turn/end', { turn: ctx.turn, reason: { kind: 'completed' } });
  });
  await runtime.receive('wkb', {
    id: 'msg-ccb-loan-1',
    peerId: 'wkb@im.wechat',
    text: '我是银行国际业务从业者，主要看有没有发放跨境并购贷款、授信额度和跨境转账交割的机会',
    at: new Date(currentTimeMs + 1000).toISOString(),
  });
  await waitFor(() => sentTexts.some(m => m.peerId === 'wkb@im.wechat' && m.text.includes('已按跨境并购贷款口径收录')));
  assert.equal(sentTexts.some(m => m.text.includes('先别转账') || m.text.includes('110')), false);
  assert.match(bankerPromptSeen, /跨境并购贷款/);
});

test('skill packs privacy hygiene, private plugin blocklist, AGENTS.md injection & sendImage work end-to-end', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'family-skill-packs-026-')));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir + '-member-workspaces', { recursive: true, force: true });
  });

  // 1. All 5 curated skill packs must be 100% free of Owner private/host identifiers
  const catalog = listSkillPackCatalog();
  assert.deepEqual(catalog.map(c => c.id), SKILL_PACK_IDS);
  assert.equal(catalog.length, 5);
  const srcText = readFileSync(new URL('../src/member-skill-packs.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['/Users/shan', 'miclip', 'mexico', 'oxmumu', 'piggy00544', 'finvo', 'ego-browser', 'remote-debugging-port', '--user-data-dir']) {
    assert.equal(new RegExp(forbidden, 'iu').test(srcText), false, `Forbidden token leaked into skill packs: ${forbidden}`);
  }

  // 2. syncWorkspaceSkillPacks & writeWorkspaceAgentsMd preserve member custom files & skills
  const sentTexts = [];
  const sentFiles = [];
  const sentImages = [];
  const host = createFakeHostControllers();
  const runtime = createRuntime({
    directory: dir,
    api: {
      ...createFakeApi(sentTexts, sentFiles),
      async sendImage({ peerId, bytes }) {
        sentImages.push({ peerId, bytes });
        return { status: 'api_accepted', messageId: 'img-' + sentImages.length };
      },
    },
    intervalMs: 600_000,
    elevatedControllers: {
      getWorkspaceController: () => host.workspaceController,
      getSessionController: () => host.sessionController,
      getAgents: () => host.agentsRegistry,
    },
  });
  t.after(() => runtime.close());

  setupConnectedPerson(dir, runtime, {
    id: 'owner-1', role: 'owner', label: '我',
    accountId: 'owner@im.bot', peerId: 'owner@im.wechat', token: 'tok-owner',
  });
  setupConnectedPerson(dir, runtime, {
    id: 'wkb', role: 'elder', label: '王凯伯',
    accountId: 'wkb@im.bot', peerId: 'wkb@im.wechat', token: 'tok-wkb',
  });
  await runtime.start();
  await runtime.action({ action: 'hearth_member_update', personId: 'wkb', persona: 'pro_peer', pinganEnabled: false });
  const granted = await runtime.action({ action: 'member_elevated_grant', personId: 'wkb', permanent: true, note: 'pro_peer' });
  const wsPath = granted.grant.workspacePath;

  // Create member's own custom skill & report file
  mkdirSync(join(wsPath, 'skills', 'my-custom'), { recursive: true, mode: 0o700 });
  writeFileSync(join(wsPath, 'skills', 'my-custom', 'SKILL.md'), '---\nname: my-custom\ndescription: Custom banker workflow\n---\n# Custom\n');
  mkdirSync(join(wsPath, 'reports'), { recursive: true, mode: 0o700 });
  const chartPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  writeFileSync(join(wsPath, 'reports', 'deal-chart.png'), chartPng);

  // Sync via runtime action, then shrink, ensuring custom skill & reports remain untouched
  await runtime.action({ action: 'member_skill_packs_set', personId: 'wkb', packIds: ['executive-reporting', 'bi-analysis', 'visual-one-pager'] });
  assert.deepEqual(readWorkspaceSkillPacks(wsPath).installed, ['bi-analysis', 'executive-reporting', 'visual-one-pager']);
  assert.deepEqual(readWorkspaceSkillPacks(wsPath).custom, ['my-custom']);

  await runtime.action({ action: 'member_skill_packs_set', personId: 'wkb', packIds: ['executive-reporting', 'visual-one-pager'] });
  assert.equal(existsSync(join(wsPath, 'skills', 'bi-analysis')), false);
  assert.equal(existsSync(join(wsPath, 'skills', 'my-custom', 'SKILL.md')), true);
  assert.equal(existsSync(join(wsPath, 'reports', 'deal-chart.png')), true);

  await runtime.action({
    action: 'member_workspace_agents_set',
    personId: 'wkb',
    content: '# 王凯伯专属口径\n建行总行国际业务 · 专注跨境并购贷款商机。',
  });
  assert.match(readWorkspaceAgentsMd(wsPath), /建行总行国际业务/);

  const hearthStatus = runtime.status().hearth;
  assert.equal(hearthStatus.skillPackCatalog.length, 5);
  assert.equal(hearthStatus.members.wkb.hasAgentsMd, true);
  assert.deepEqual(hearthStatus.members.wkb.skillPacks.installed, ['executive-reporting', 'visual-one-pager']);

  // 3. Tool guard blocks Owner-private plugin tools & Chrome CDP hijacks, while keeping general tools open
  const activeGrant = runtime.memberElevated.get('wkb', { bindingGeneration: 1 });
  for (const blockedTool of ['companion', 'send_wechat', 'sa_dispatch', 'kb_board', 'board_list', 'delivery_receipts', 'evidence_ledger']) {
    const blocked = checkElevatedToolExecution({ name: blockedTool, arguments: {} }, activeGrant);
    assert.equal(typeof blocked, 'string', `Expected private tool ${blockedTool} to be blocked`);
  }
  for (const blockedCmd of [
    'open /Applications/Google\\ Chrome.app --args --remote-debugging-port=9222',
    'google-chrome --user-data-dir=/Users/foo/Library/Application\\ Support/Google/Chrome',
    'npx chrome-devtools-mcp',
  ]) {
    const blocked = checkElevatedToolExecution({ name: 'bash', arguments: { command: blockedCmd } }, activeGrant);
    assert.equal(typeof blocked, 'string', `Expected Chrome/CDP command to be blocked: ${blockedCmd}`);
  }
  for (const allowedExec of [
    { name: 'web_search', arguments: { query: 'Puma Anta M&A' } },
    { name: 'read_file', arguments: { path: join(wsPath, 'AGENTS.md') } },
    { name: 'bash', arguments: { command: 'node scripts/collect.mjs' } },
    { name: 'whale_travel', arguments: { query: 'Frankfurt' } },
    { name: 'guizang_design', arguments: { mode: 'svg' } },
  ]) {
    const res = checkElevatedToolExecution(allowedExec, activeGrant);
    assert.equal(res, undefined, `Expected general tool ${allowedExec.name} to remain allowed, got: ${res}`);
  }

  // 4. Prompt injects AGENTS.md + skills list, and member_send_workspace_file routes .png -> sendImage
  let capturedPrompt = '';
  host.setOnPrompt(async ctx => {
    runtime.memberElevatedHost.attachAgent(ctx.agent);
    capturedPrompt = ctx.text;
    const fileTool = ctx.agent.registered.find(r => r.name === 'member_send_workspace_file');
    const imgReceipt = await fileTool.execute({ relativePath: 'reports/deal-chart.png', caption: '交易架构图' }, { agent: ctx.agent, signal: new AbortController().signal });
    assert.equal(imgReceipt.status, 'api_accepted');
    assert.equal(imgReceipt.isImage, true);
    ctx.pushEvent('assistant/message', { turn: ctx.turn, message: { content: [{ type: 'text', text: '架构图已发给你。' }] } });
    ctx.pushEvent('turn/end', { turn: ctx.turn, reason: { kind: 'completed' } });
  });

  await runtime.receive('wkb', { id: 'msg-wkb-chart', peerId: 'wkb@im.wechat', text: '帮我画个并购融资结构图发过来' });
  await waitFor(() => sentImages.length === 1 && sentTexts.some(m => m.text.includes('架构图已发给你')));
  assert.equal(sentImages[0].peerId, 'wkb@im.wechat');
  assert.equal(Buffer.compare(sentImages[0].bytes, chartPng), 0);
  assert.match(capturedPrompt, /专属背景与工作口径（AGENTS\.md）/);
  assert.match(capturedPrompt, /建行总行国际业务/);
  assert.match(capturedPrompt, /skills\/executive-reporting\/SKILL\.md/);
  assert.match(capturedPrompt, /skills\/my-custom\/SKILL\.md/);
});
