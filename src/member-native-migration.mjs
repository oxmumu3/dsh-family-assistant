/**
 * 家人侧迁移盘点（只读）。
 *
 * 目标是让「把家人对话从插件自写循环迁到宿主原生 agent」这件事可审计、可分步，
 * 而不是一刀切。本模块只做三件事：按绑定找到旧工作区、统计旧任务账本状态、
 * 给出能不能切换的阻塞项。它**从不写文件**，也不碰微信。
 *
 * 旧账本位置与命名由 member-agent 决定：<directory>/member-workspaces/<personId>/<bindingHash>/.member-agent.json
 */
import {readFileSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {memberScopeHash} from './member-agent.mjs';

const LEDGER = '.member-agent.json';
const BLOCKING = new Set(['prepared', 'queued', 'running', 'cancelling', 'needs_input', 'unknown']);

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** 该成员在当前绑定下的旧工作区路径；未绑定时返回 null。 */
export function legacyScopePath({directory, person, binding}) {
  if (!isObject(person) || !isObject(binding)) return null;
  const route = {personId: person.id, accountId: binding.accountId, peerId: binding.peerId, generation: binding.generation};
  if (![route.accountId, route.peerId].every(value => typeof value === 'string' && value)) return null;
  if (!Number.isSafeInteger(route.generation) || route.generation < 1) return null;
  const hash = memberScopeHash({person, route});
  return join(resolve(directory), 'member-workspaces', person.id, hash);
}

/** 只读盘点一个成员：账本是否可读、各状态计数、阻塞原因。 */
export function inspectMemberScope({directory, person, binding}) {
  const path = legacyScopePath({directory, person, binding});
  const base = {
    personId: person?.id ?? null,
    label: person?.label ?? null,
    bindingGeneration: binding?.generation ?? null,
    scopePath: path,
    hasLegacyLeadger: false,
    ledgerVersion: null,
    states: {},
    files: 0,
    deliveries: 0,
    blockers: [],
  };
  if (!path) return {...base, blockers: ['not_bound']};
  let text;
  try {
    const stat = statSync(join(path, LEDGER));
    if (!stat.isFile()) return {...base, blockers: ['ledger_not_a_file']};
    text = readFileSync(join(path, LEDGER), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return base; // 没有旧账本，迁移无历史包袱
    return {...base, blockers: [`ledger_unreadable:${error.code ?? error.message}`]};
  }
  let state;
  try { state = JSON.parse(text); } catch { return {...base, hasLegacyLeadger: true, blockers: ['ledger_invalid_json']}; }
  if (!isObject(state) || !Array.isArray(state.requests)) return {...base, hasLegacyLeadger: true, blockers: ['ledger_invalid_shape']};
  if (state.personId !== person.id) return {...base, hasLegacyLeadger: true, blockers: ['ledger_person_mismatch']};
  if (state.bindingHash && path && !path.endsWith(state.bindingHash)) return {...base, hasLegacyLeadger: true, blockers: ['ledger_binding_mismatch']};

  const states = {}, blockers = new Set();
  let files = 0, deliveries = 0;
  for (const request of state.requests) {
    if (!isObject(request) || typeof request.state !== 'string') { blockers.add('ledger_invalid_request'); continue; }
    states[request.state] = (states[request.state] ?? 0) + 1;
    files += Array.isArray(request.files) ? request.files.length : 0;
    deliveries += Array.isArray(request.deliveries) ? request.deliveries.length : 0;
    if (BLOCKING.has(request.state)) blockers.add(`pending_${request.state}`);
  }
  return {
    ...base,
    hasLegacyLeadger: true,
    ledgerVersion: state.version ?? null,
    states,
    files,
    deliveries,
    blockers: [...blockers],
  };
}

/** 整个家庭的迁移盘点：逐人结论 + 有界合计；ready 只代表"没有阻塞项"。 */
export function planMemberMigration({directory, people = [], bindings = []} = {}) {
  const elders = people.filter(person => person && person.role === 'elder');
  const rows = elders.map(person => inspectMemberScope({
    directory,
    person,
    binding: bindings.find(row => row.personId === person.id) ?? null,
  }));
  const totals = {
    people: rows.length,
    withLegacy: rows.filter(row => row.hasLegacyLeadger).length,
    blocked: rows.filter(row => row.blockers.length).length,
    pendingRequests: rows.reduce((sum, row) => sum + Object.entries(row.states).filter(([key]) => BLOCKING.has(key)).reduce((count, [, value]) => count + value, 0), 0),
  };
  return {version: 1, ready: totals.blocked === 0, totals, people: rows};
}
