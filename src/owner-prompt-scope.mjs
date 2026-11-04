/**
 * Owner 政策的作用域生命周期。
 *
 * 探针已证明：注册在 Owner agent 作用域里的段落能被真实装配保留，文本逐字
 * 不变。这个模块把它变成长期注册，并且**每一条 Owner 消息提交前都重新装配
 * 校验一次**——宿主组合变化、HMR、或段落被 complete 段吞掉时，缓存里的
 * “已验证”不能继续用来裁掉用户消息里的政策。
 *
 * 任何一次校验失败都退回消息态：不裁剪、释放注册、记录原因，并尝试重新注册
 * 一次；仍失败就保持未生效，直到下一次消息再试。绝不因为注册过就删内联政策。
 */
import {readFileSync, writeFileSync, renameSync, unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {OWNER_SECTION_NAME, ownerPromptSection, stripOwnerPolicy} from './owner-prompt.mjs';
import {ownerAssembleContext} from './owner-prompt-probe.mjs';

const OWNER_PREFIX = 'family_owner_';
const FILE = 'owner-prompt-scope.json';

/** 与宿主装配结果比对：段落存在且文本逐字一致才算生效。 */
function matches(assembly, section) {
  const found = (assembly?.sections ?? []).find(row => row?.name === OWNER_SECTION_NAME);
  if (!found) return {ok: false, reason: 'section_missing'};
  if (typeof found.text !== 'string' || found.text !== section.text) return {ok: false, reason: 'section_text_mismatch'};
  return {ok: true, reason: 'section_verified'};
}

export function createOwnerPromptScope({section = ownerPromptSection(), onStateChange} = {}) {
  const states = new Map();
  let closed = false;

  const isOwnerSession = id => typeof id === 'string' && id.startsWith(OWNER_PREFIX);

  function publish(sessionId, verified, reason) {
    if (typeof onStateChange !== 'function') return;
    try { onStateChange({sessionId, verified, reason, sectionLength: section.text.length}); } catch { /* diagnostics only */ }
  }

  function settle(state, verified, reason) {
    state.verified = verified === true;
    state.reason = reason;
    state.summary = {attached: state.verified, verified: state.verified, reason};
    publish(state.agent?.id, state.verified, reason);
    return state.summary;
  }

  function service(agent) {
    const found = agent?.ctx?.get?.('systemPrompt');
    return typeof found?.section === 'function' && typeof found?.assemble === 'function' ? found : null;
  }

  async function register(state) {
    const api = service(state.agent);
    if (!api) return settle(state, false, 'systemPrompt_unavailable');
    try {
      state.dispose = api.section(section);
      const result = matches(await api.assemble(ownerAssembleContext(state.agent)), section);
      if (closed || states.get(state.agent.id) !== state) {
        try { await state.dispose?.(); } catch { /* already gone */ }
        state.dispose = null;
        return settle(state, false, 'scope_released');
      }
      if (!result.ok) {
        try { await state.dispose?.(); } catch { /* already gone */ }
        state.dispose = null;
      }
      return settle(state, result.ok, result.reason);
    } catch (error) {
      try { await state.dispose?.(); } catch { /* already gone */ }
      state.dispose = null;
      return settle(state, false, `register_failed:${String(error?.message ?? error).slice(0, 120)}`);
    }
  }

  /** 在真实 Owner agent 的作用域注册政策段落，并立刻用一次真实装配校验。 */
  async function attach(agent) {
    if (closed || !agent || !isOwnerSession(agent.id)) return {attached: false, verified: false, reason: 'not_owner_session'};
    const existing = states.get(agent.id);
    if (existing) return existing.promise ?? existing.summary ?? {attached: false, verified: false, reason: 'pending'};
    const state = {agent, verified: false, reason: 'pending', dispose: null, summary: null, promise: null};
    states.set(agent.id, state);
    state.promise = register(state);
    return state.promise;
  }

  /**
   * 提交前复验并（仅在复验通过时）裁剪政策前缀。
   * 失败路径：释放注册、标记未生效、尝试重新注册一次；仍失败则保持未生效。
   */
  async function prepareRequest(sessionId, request) {
    const released = reason => ({applied: false, verified: false, reason});
    if (closed) return released('scope_closed');
    const state = states.get(sessionId);
    if (!state) return released('not_attached');
    // Everything below can be interrupted by detach()/close(); each await is
    // followed by an ownership check so a late assembly can never strip inline.
    const owned = () => !closed && states.get(sessionId) === state;
    if (state.promise && !state.summary) {
      await state.promise;
      if (!owned()) return released(closed ? 'scope_closed' : 'scope_released');
    }
    const api = service(state.agent);
    if (!api) {
      settle(state, false, 'systemPrompt_unavailable');
      return released(state.reason);
    }
    let result;
    try {
      result = matches(await api.assemble(ownerAssembleContext(state.agent)), section);
    } catch (error) {
      result = {ok: false, reason: `recheck_failed:${String(error?.message ?? error).slice(0, 120)}`};
    }
    if (!owned()) return released(closed ? 'scope_closed' : 'scope_released');
    if (!result.ok) {
      // Composition changed or the registration was released: drop the stale
      // handle, then try one re-registration. Any release during that await
      // still keeps inline.
      try { await state.dispose?.(); } catch { /* already gone */ }
      state.dispose = null;
      settle(state, false, result.reason);
      const retried = await register(state);
      if (!owned()) return released(closed ? 'scope_closed' : 'scope_released');
      if (!retried.verified) return released(retried.reason);
      result = {ok: true, reason: retried.reason};
    }
    if (!owned()) return released(closed ? 'scope_closed' : 'scope_released');
    settle(state, true, result.reason);
    const content = request?.content;
    if (!Array.isArray(content) || content.length !== 1) return {applied: false, verified: true, reason: 'content_shape'};
    const block = content[0];
    if (!block || block.type !== 'text' || typeof block.text !== 'string') return {applied: false, verified: true, reason: 'content_shape'};
    const stripped = stripOwnerPolicy(block.text);
    if (!stripped.stripped) return {applied: false, verified: true, reason: 'policy_prefix_absent'};
    // Last check before the only mutation: the scope must still be open, still
    // own this session and still be verified at this exact instant.
    if (!owned() || state.verified !== true) return released('scope_released');
    block.text = stripped.text;
    return {applied: true, verified: true, reason: 'policy_in_system_prompt'};
  }

  function isActive(sessionId) {
    return states.get(sessionId)?.verified === true;
  }

  async function detach(sessionId) {
    const state = states.get(sessionId);
    if (!state) return;
    state.verified = false;
    state.released = true;
    states.delete(sessionId);
    try { await state.dispose?.(); } catch { /* already gone */ }
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const id of [...states.keys()]) await detach(id);
  }

  function status() {
    return [...states].map(([sessionId, state]) => ({sessionId, verified: state.verified === true, reason: state.reason}));
  }

  return Object.freeze({attach, prepareRequest, isActive, detach, close, status});
}

/** 把最近一次状态写进数据目录，供 verify-deploy 读取；只写小记录，不含政策正文。 */
export function recordScope(directory, change, now = () => new Date().toISOString()) {
  if (typeof directory !== 'string' || !directory) return null;
  const record = {
    version: 1,
    checkedAt: now(),
    sessionId: typeof change?.sessionId === 'string' ? change.sessionId : null,
    verified: change?.verified === true,
    reason: String(change?.reason ?? 'unknown').slice(0, 200),
    sectionLength: Number.isInteger(change?.sectionLength) ? change.sectionLength : 0,
  };
  const target = join(directory, FILE);
  const temporary = join(directory, `.owner-prompt-scope-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {mode: 0o600});
    renameSync(temporary, target);
  } catch {
    try { unlinkSync(temporary); } catch { /* nothing to clean */ }
    return null;
  }
  return record;
}

export function readScope(directory) {
  try {
    return JSON.parse(readFileSync(join(directory, FILE), 'utf8'));
  } catch {
    return null;
  }
}
