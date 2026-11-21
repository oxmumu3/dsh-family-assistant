import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../src/runtime.mjs';
import { createOwnerManagementTool } from '../src/owner-management-tool.mjs';
import { createWeixinApi } from '../src/weixin.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const waitFor = async (check, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail('condition not met within timeout');
};
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('weixin api sendImage encrypts and uploads media_type=1 and sends type=2 image_item', async () => {
  const calls = [];
  let upload, sendBody;
  const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const api = createWeixinApi({
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      if (url.endsWith('/getuploadurl')) {
        upload = JSON.parse(opts.body);
        return json({ upload_param: 'img-upload-q' });
      }
      if (url.includes('/c2c/upload')) {
        return new Response('', { headers: { 'x-encrypted-param': 'img-download-q' } });
      }
      sendBody = JSON.parse(opts.body);
      return json({ ret: 0, message_id: 'img-msg-1' });
    },
  });

  const res = await api.sendImage({
    token: 'bot-token',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    peerId: 'owner-peer',
    contextToken: 'ctx-1',
    bytes: pngBytes,
    clientId: 'qr-img-1',
  });
  assert.deepEqual(res, { status: 'api_accepted', messageId: 'img-msg-1' });
  assert.equal(calls.length, 3);
  assert.equal(upload.media_type, 1);
  assert.equal(upload.rawsize, pngBytes.length);
  assert.equal(upload.rawfilemd5, createHash('md5').update(pngBytes).digest('hex'));
  const encrypted = Buffer.from(calls[1].opts.body);
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(upload.aeskey, 'hex'), null);
  assert.deepEqual(Buffer.concat([decipher.update(encrypted), decipher.final()]), pngBytes);
  assert.equal(sendBody.msg.item_list[0].type, 2);
  assert.deepEqual(sendBody.msg.item_list[0].image_item, {
    media: {
      encrypt_query_param: 'img-download-q',
      aes_key: Buffer.from(upload.aeskey).toString('base64'),
      encrypt_type: 1,
    },
    mid_size: encrypted.length,
  });
});

test('Owner WeChat tool supports 1:1 desktop parity (add_person, bind_qr image delivery, scan completion notice, reminders, tools, access, hearth, system) and rejects non-owner calls', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'family-owner-parity-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sentTexts = [];
  const sentImages = [];
  let releaseElderScan;
  const elderQrScanned = new Promise(resolve => { releaseElderScan = resolve; });

  const api = {
    async getQr() {
      return { qrcode: 'qr-ticket-wkb', qrUrl: 'https://weixin.qq.com/x/wangkaibo-live' };
    },
    async checkQr({ qrcode }) {
      assert.equal(qrcode, 'qr-ticket-wkb');
      await elderQrScanned;
      return {
        status: 'confirmed',
        token: 'wkb-token',
        baseUrl: 'https://ilinkai.weixin.qq.com',
        accountId: 'wkb-bot@im.bot',
        peerId: 'wkb-peer@im.wechat',
      };
    },
    async poll({ signal }) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
    async send({ peerId, text }) {
      sentTexts.push({ peerId, text });
      return { status: 'api_accepted', messageId: 'txt-' + sentTexts.length };
    },
    async sendImage({ peerId, bytes }) {
      sentImages.push({ peerId, bytes });
      return { status: 'api_accepted', messageId: 'img-' + sentImages.length };
    },
  };

  let activeIntent = null;
  let turnDone = false;
  const controlDir = join(dir, 'control');
  mkdirSync(controlDir, { recursive: true });

  const time = Date.parse('2026-11-21T03:00:00Z');
  const runtime = createRuntime({
    directory: dir,
    api,
    now: () => new Date(time).toISOString(),
    intervalMs: 600_000,
    ownerAgent: {
      ensureControlWorkspace: async () => ({ workspaceId: 'ws-1', title: '日报库', path: controlDir }),
      listWorkspaces: async () => [{ workspaceId: 'ws-1', title: '日报库', path: controlDir, sessionIds: [] }],
      start: async intent => {
        activeIntent = intent;
        return { state: 'running' };
      },
      observe: async intent => ({
        workspaceId: intent.workspaceId,
        sessionId: intent.sessionId,
        requestId: intent.requestId,
        cwd: intent.cwd,
        state: turnDone ? 'succeeded' : 'running',
        ...(turnDone ? { text: '已按你的要求处理完毕。' } : {}),
        requestSeen: true,
        queued: false,
        foreign: false,
        turn: 1,
        activeTurn: turnDone ? null : 1,
        activeRequestIds: turnDone ? [] : [intent.requestId],
        events: [{
          type: 'tool/call',
          seq: 1,
          turn: 1,
          name: 'family_assistant',
          callId: 'call-1',
          status: turnDone ? 'completed' : 'running',
        }],
      }),
    },
    digestSources: async () => [{ relativePath: 'output/ai-digest/2026-11-21-wechat.txt', bytes: 1200, updatedAt: '2026-11-21T02:00:00Z' }],
    weatherSearch: async () => [{ name: 'Beijing', city: '北京', locationId: 1 }],
  });
  t.after(async () => { await runtime.close(); });

  runtime.store.addPerson({ id: 'owner', role: 'owner', label: '我' });
  runtime.store.bindPerson('owner', { accountId: 'owner-bot@im.bot', peerId: 'owner-peer@im.wechat' });
  const channelsDir = join(dir, 'channels', 'owner');
  mkdirSync(channelsDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(channelsDir, 'auth.json'), JSON.stringify({
    token: 'owner-token',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    accountId: 'owner-bot@im.bot',
    peerId: 'owner-peer@im.wechat',
    cursor: '',
    contextToken: 'owner-ctx',
  }), { mode: 0o600 });

  await runtime.start();
  await runtime.receive('owner', { id: 'msg-1', peerId: 'owner-peer@im.wechat', text: '帮我开通王凯伯并生成绑定码' });
  await waitFor(() => Boolean(activeIntent));

  const tool = createOwnerManagementTool({ runtime, directory: join(dir, 'mgmt') });
  const exec = { callId: 'call-1', agent: { id: activeIntent.sessionId }, signal: new AbortController().signal };

  // Non-owner session must still be rejected
  await assert.rejects(() => tool.execute({ action: 'add_person', label: '王凯伯' }, { ...exec, agent: { id: 'family_owner_forged' } }));

  // 1. add_person + update_person
  const added = await tool.execute({ action: 'add_person', label: '王凯伯', notes: '需要每日业务报表' }, exec);
  assert.equal(added.status, 'completed');
  assert.equal(added.label, '王凯伯');
  const wkbId = added.personId;
  assert.ok(wkbId);
  await tool.execute({ action: 'update_person', personId: wkbId, interests: ['AI行业', '日报'], shareWithOwner: 'summary' }, exec);
  assert.deepEqual(runtime.store.person(wkbId).interests, ['AI行业', '日报']);

  // 2. bind_qr sends valid PNG directly to Owner's WeChat via real ownerAuthorityForSession
  const qrRes = await tool.execute({ action: 'bind_qr', personId: wkbId }, exec);
  assert.equal(qrRes.status, 'awaiting_scan');
  assert.equal(qrRes.wechatImageStatus, 'api_accepted');
  assert.equal(sentImages.length, 1);
  assert.equal(sentImages[0].peerId, 'owner-peer@im.wechat');
  assert.equal(sentImages[0].bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  // 3. Completing scan binds member & pushes notice to Owner
  releaseElderScan();
  await waitFor(() => runtime.store.binding(wkbId)?.status === 'connected');
  await waitFor(() => sentTexts.some(m => m.peerId === 'owner-peer@im.wechat' && m.text.includes('王凯伯') && m.text.includes('已完成微信扫码绑定')));

  // 4. member_reminder + tool_manage + access_manage + hearth_manage + system_manage
  const remAdd = await tool.execute({ action: 'member_reminder', personId: wkbId, op: 'add', text: '看今天日报', dueAt: '2026-11-22T01:00:00Z', repeat: 'daily' }, exec);
  assert.equal(remAdd.status, 'completed');
  const remList = await tool.execute({ action: 'member_reminder', personId: wkbId, op: 'list' }, exec);
  assert.equal(remList.reminders.length, 1);
  await tool.execute({ action: 'member_reminder', personId: wkbId, op: 'skip_once', reminderId: remList.reminders[0].id, date: '2026-11-22' }, exec);
  await tool.execute({ action: 'member_reminder', personId: wkbId, op: 'cancel', reminderId: remList.reminders[0].id }, exec);

  const sources = await tool.execute({ action: 'tool_manage', op: 'digest_sources', workspaceId: 'ws-1', query: 'digest' }, exec);
  assert.equal(sources.sources.length, 1);
  await tool.execute({
    action: 'tool_manage',
    op: 'assign',
    personId: wkbId,
    toolId: 'ai_digest',
    resource: { workspaceId: 'ws-1', relativePath: 'output/ai-digest/2026-11-21-wechat.txt' },
    allowInvoke: true,
    schedule: { enabled: true, time: '08:30', timeZone: 'Asia/Shanghai' },
  }, exec);
  const assigns = await tool.execute({ action: 'tool_manage', op: 'assignments', personId: wkbId }, exec);
  assert.equal(assigns.assignments.length, 1);

  await tool.execute({ action: 'access_manage', op: 'grant', personId: wkbId, workspaceIds: ['ws-1'], capabilities: ['read'] }, exec);
  const policies = await tool.execute({ action: 'access_manage', op: 'list' }, exec);
  assert.equal(policies.policies.find(p => p.personId === wkbId).capabilities[0], 'read');
  await tool.execute({ action: 'access_manage', op: 'revoke', personId: wkbId }, exec);

  await tool.execute({ action: 'hearth_manage', op: 'member_update', personId: wkbId, pinganEnabled: true, pinganTime: '20:00' }, exec);
  await tool.execute({ action: 'hearth_manage', op: 'guard_update', quietHoursEnabled: true, quietStart: '23:00', quietEnd: '07:00' }, exec);
  await tool.execute({ action: 'hearth_manage', op: 'habit_save', personId: wkbId, habitId: 'h1', text: '早上发业务指标' }, exec);
  await tool.execute({ action: 'hearth_manage', op: 'habit_delete', personId: wkbId, habitId: 'h1' }, exec);

  await tool.execute({ action: 'system_manage', op: 'configure', ownerBriefTime: '21:00' }, exec);
  assert.equal(runtime.status().config.ownerBriefTime, '21:00');
  const statusOut = await tool.execute({ action: 'status' }, exec);
  assert.equal(statusOut.capabilities.fullDesktopParity, true);
  assert.equal(statusOut.capabilities.wechatQrBinding, true);
  assert.doesNotMatch(statusOut.text, /account|peer|token|route|source-draft|native-task/);

  // 5. Ended turn revokes Owner tool authority (fail-closed)
  turnDone = true;
  await runtime.tick();
  await assert.rejects(() => tool.execute({ action: 'add_person', label: '未授权' }, exec));
});

test('owner-local-control.json triggers bind_qr, writes PNG & result file, and cleans up request file', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'family-local-ctrl-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sentImages = [];
  const api = {
    async getQr() { return { qrcode: 'local-qr', qrUrl: 'https://weixin.qq.com/x/local-test' }; },
    async checkQr({ signal }) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
    async poll({ signal }) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
    async send() { return { status: 'api_accepted' }; },
    async sendImage({ peerId, bytes }) {
      sentImages.push({ peerId, bytes });
      return { status: 'api_accepted', messageId: 'local-img-1' };
    },
  };

  const runtime = createRuntime({ directory: dir, api, intervalMs: 600_000 });
  t.after(async () => { await runtime.close(); });

  runtime.store.addPerson({ id: 'owner', role: 'owner', label: '我' });
  runtime.store.bindPerson('owner', { accountId: 'owner-bot', peerId: 'owner-peer' });
  runtime.store.addPerson({ id: 'wkb', role: 'elder', label: '王凯伯' });
  const ownerChan = join(dir, 'channels', 'owner');
  mkdirSync(ownerChan, { recursive: true, mode: 0o700 });
  writeFileSync(join(ownerChan, 'auth.json'), JSON.stringify({
    token: 't', baseUrl: 'https://ilinkai.weixin.qq.com', accountId: 'owner-bot', peerId: 'owner-peer', cursor: '', contextToken: 'ctx',
  }), { mode: 0o600 });

  await runtime.start();
  await tick();

  const pngOut = join(dir, 'wkb-qr.png');
  const reqFile = join(dir, 'owner-local-control.json');
  const outFile = join(dir, 'owner-local-control-result.json');
  writeFileSync(reqFile, JSON.stringify({
    requestId: 'req-local-1',
    action: 'bind_qr',
    args: { personId: 'wkb', sendToOwnerWechat: true, savePngPath: pngOut },
  }), { mode: 0o600 });

  await waitFor(() => existsSync(outFile), 4000);
  const res = JSON.parse(readFileSync(outFile, 'utf8'));
  assert.equal(res.requestId, 'req-local-1');
  assert.equal(res.ok, true);
  assert.equal(res.result.status, 'awaiting_scan');
  assert.equal(res.result.wechatImageStatus, 'api_accepted');
  assert.equal(existsSync(reqFile), false);
  assert.equal(readFileSync(pngOut).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(sentImages.length, 1);
});
