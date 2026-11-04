#!/usr/bin/env node
/**
 * 家庭助手部署自检（只读）。
 *
 * 回答四件事：
 *   1. 装到 profile 里的版本带不带本轮改造；
 *   2. 正在运行的服务启动于何时——注意这只能说明先后，不能证明加载了哪份代码；
 *   3. 段落探针有没有跑过、两阶段结论是什么（这是"新代码已加载"的正面证据）；
 *   4. 家庭数据是否完好：成员、绑定、消息、提醒，出站记录按状态分列。
 *
 * 用法：node scripts/verify-deploy.mjs
 */
import {readFileSync, statSync, existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';

const installed = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-family-assistant');
const dataDir = join(homedir(), '.local', 'share', 'dsh-family-assistant');
const problems = [];
const notes = [];

function check(label, ok, detail = '') {
  if (ok) notes.push(`ok   ${label}${detail ? ` · ${detail}` : ''}`);
  else problems.push(`FAIL ${label}${detail ? ` · ${detail}` : ''}`);
}
const read = path => readFileSync(path, 'utf8');
const stamp = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);

// 1. 版本与改造标记
const pkg = JSON.parse(read(join(installed, 'package.json')));
check('安装包存在', true, pkg.version);
const runtime = read(join(installed, 'src', 'runtime.mjs'));
const index = read(join(installed, 'index.js'));
const store = read(join(installed, 'src', 'store.mjs'));
const prompt = read(join(installed, 'src', 'owner-prompt.mjs'));
check('运行锁按进程起始时间判活', runtime.includes('processStartTime'));
check('关闭流程 finally 释放锁', runtime.includes('closing=(async()=>{') && runtime.includes('unlock();'));
check('出站终态衰减', store.includes('prune({outboxKeepDays'));
check('每小时 prune 已接线', runtime.includes('lastPruneAt'));
check('Owner 工具按会话作用域注册', index.includes('ownerScopes') && index.includes('agent/created'));
check('Owner 提示词已抽模块', prompt.includes('buildOwnerTurn') && !runtime.includes('乐乐对话交互版本'));
check('作用域政策模块已安装', existsSync(join(installed, 'src', 'owner-prompt-scope.mjs')) && index.includes('createOwnerPromptScope'));
check('探针模块保留作离线诊断', existsSync(join(installed, 'src', 'owner-prompt-probe.mjs')));
check('深色令牌表存在', existsSync(join(installed, 'web', 'theme-dark.css')));

// 2. 服务启动时间（只是先后，不是代码加载证明）
const lock = join(dataDir, 'runtime.lock');
const deployedAt = statSync(join(installed, 'src', 'runtime.mjs')).mtimeMs;
if (existsSync(lock)) {
  const startedAt = statSync(lock).mtimeMs;
  notes.push(startedAt < deployedAt
    ? `wait 家庭服务启动于 ${stamp(startedAt)}，早于部署 ${stamp(deployedAt)}；这只说明先后，不能证明已加载新代码`
    : `ok   家庭服务启动于 ${stamp(startedAt)}，晚于部署；仍需探针结果确认代码版本`);
} else {
  notes.push('wait 家庭服务当前没有运行锁（可能未启动或已暂停）');
}

// 3. 段落探针：唯一能正面证明新代码已加载的证据
let probe = null;
try {
  probe = JSON.parse(read(join(dataDir, 'owner-prompt-probe.json')));
} catch { /* not run yet */ }
if (!probe) {
  notes.push('wait 段落探针尚未运行（重启后进一次 Owner 会话；不会伪造身份）');
} else {
  const when = Date.parse(probe.checkedAt);
  notes.push(Number.isFinite(when) && when >= deployedAt
    ? `ok   探针于 ${stamp(when)} 跑过，晚于部署——可确认新代码已加载`
    : `wait 探针记录于 ${probe.checkedAt}，早于本次部署，不能证明当前代码`);
  notes.push(probe.survived ? 'ok   阶段一：作用域段落能被装配保留' : 'wait 阶段一：作用域段落被吞掉，维持消息态');
  if (probe.policy) {
    notes.push(probe.policy.registered
      ? `ok   阶段二：真政策段落已注册，长度 ${probe.policy.length}/${probe.policy.expectedLength}`
      : `wait 阶段二：真政策段落未出现 · ${probe.policy.reason}`);
    notes.push(probe.policy.textMatched
      ? 'ok   阶段二：段落文本与政策原文完全一致'
      : `wait 阶段二：段落文本不一致 · ${probe.policy.reason}`);
  }
  if (probe.assembleContext !== 'agent-scope') {
    notes.push('FAIL 探针记录没有标记 agent 作用域上下文，结论不可信');
    problems.push('FAIL 探针上下文缺失 · assembleContext != agent-scope');
  }
  notes.push(probe.switchAllowed
    ? 'ok   结论：可以把消息态切到 systemPrompt（两阶段都通过）'
    : 'wait 结论：暂不切换，继续用消息态注入政策');
}

// 3b. 持久注册状态：每次 Owner 消息提交前都会复验并覆盖这一条
try {
  const scope = JSON.parse(read(join(dataDir, 'owner-prompt-scope.json')));
  const at = Date.parse(scope.checkedAt);
  notes.push(Number.isFinite(at) && at >= deployedAt
    ? `ok   作用域政策最近复验于 ${stamp(at)}：${scope.verified ? '生效（消息只带原文）' : '未生效（消息保留内联政策）'} · ${scope.reason}`
    : `wait 作用域政策复验记录早于部署，或尚未产生 · ${scope.reason ?? 'unknown'}`);
  if (scope.verified !== true) notes.push('wait 当前作用域未生效：发送给 Owner 的消息仍带内联政策，这是安全的回退态');
} catch {
  notes.push('wait 尚无作用域复验记录（Owner 会话下一条消息提交时产生）');
}

// 4. 数据完好性 + 出站分状态
try {
  const state = JSON.parse(read(join(dataDir, 'family.json')));
  const owner = state.people.filter(row => row.role === 'owner').length;
  const byStatus = {};
  for (const row of state.outbox) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  const pending = (byStatus.pending ?? 0) + (byStatus.dispatching ?? 0);
  const terminal = state.outbox.length - pending;
  check('family.json 可解析', true,
    `成员 ${state.people.length}（Owner ${owner}）、绑定 ${state.bindings.length}、消息 ${state.messages.length}、提醒 ${state.reminders.length}`);
  check('只登记一位 Owner', owner <= 1);
  const bound = new Set(state.bindings.map(row => row.personId));
  check('成员与绑定一一对应', state.people.every(p => p.role === 'owner' || bound.has(p.id)), `已绑定 ${bound.size} 人`);
  notes.push(`info 出站记录 ${state.outbox.length} 条：终态 ${terminal}、待发 ${pending} · ` +
    Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join('、'));
  const open = state.outbox.filter(row => !['api_accepted', 'failed', 'blocked', 'uncertain', 'cancelled', 'expired'].includes(row.status));
  check('没有卡在非终态的旧出站', open.length <= 2, open.length ? `${open.length} 条待处理` : 'ok');
  const channels = join(dataDir, 'channels');
  const creds = existsSync(channels) ? readdirSync(channels).filter(name => existsSync(join(channels, name, 'auth.json'))).length : 0;
  check('微信凭据目录与绑定数一致', creds === state.bindings.length, `${creds} 份 auth.json / ${state.bindings.length} 个绑定`);
} catch (error) {
  problems.push(`FAIL family.json 读取失败 · ${error.message}`);
}

console.log(notes.join('\n'));
if (problems.length) {
  console.log(`\n${problems.join('\n')}`);
  console.log('\n结论：有项目不通过，先别重启，按上面的证据排查。');
  process.exitCode = 1;
} else {
  console.log('\n结论：部署与数据都正常。切换提示词注入方式前，先确认阶段一、阶段二与 switchAllowed 都为 ok。');
}
