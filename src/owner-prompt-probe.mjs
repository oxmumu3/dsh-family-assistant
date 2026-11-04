/**
 * Owner 段落探针。
 *
 * 在真实宿主里回答三个读代码答不了的问题：
 *   1. 注册到 Owner agent 作用域的 systemPrompt section，会不会出现在最终装配里；
 *   2. 真的把 13 段政策原文注册进去，装配后文本是否完整保留；
 *   3. 探针跑过之后，才能判断“把消息态切到段落注入”是否安全。
 *
 * 全部是一次性的：注册、装配、立刻注销，稳态提示词不受影响。结论写入数据
 * 目录，既作为切换门槛，也作为“新代码确实加载了”的正面证据——运行锁的时间
 * 只说明服务何时启动，说明不了加载的是哪份代码。
 */
import {readFileSync, writeFileSync, renameSync, unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';

export const PROBE_SECTION_NAME = 'family-owner-role-probe';
const FILE = 'owner-prompt-probe.json';

/** 纯函数：从一次 assembly 判断某个段落是否被保留。 */
export function sectionSurvived(assembly, name = PROBE_SECTION_NAME) {
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : [];
  return {
    survived: sections.some(section => section?.name === name),
    sectionNames: sections.map(section => String(section?.name ?? '')).filter(Boolean).slice(0, 40),
  };
}

async function withTemporarySection(service, section, work) {
  let dispose;
  try {
    dispose = service.section(section);
    return await work();
  } finally {
    try { await dispose?.(); } catch { /* registration already gone */ }
  }
}

/**
 * 与 dsh-agent 的 assembleContextFor(agent, signal) 保持一致。
 *
 * 宿主的 assemble(context) 只按 `context.scope` 合并作用域层；不传 scope 时，
 * 通过 agent.ctx 注册的段落根本不在候选集合里，探针会得到必然的假阴性。这里
 * 用真实 Owner agent 自身作为 scope，不伪造身份。
 */
export function ownerAssembleContext(agent, signal) {
  return {
    agent,
    scope: agent,
    ...(signal === undefined ? {} : {signal}),
  };
}

/** 第一阶段：最小段落能否活过装配。 */
export async function probeOwnerSection({agent, assembleSignal} = {}) {
  const service = agent?.ctx?.get?.('systemPrompt');
  if (typeof service?.section !== 'function' || typeof service?.assemble !== 'function') {
    return {supported: false, survived: false, sectionNames: [], reason: 'systemPrompt_unavailable'};
  }
  try {
    return await withTemporarySection(service, {name: PROBE_SECTION_NAME, order: 50, text: '乐乐家庭助手：Owner 主对话段落探针。'}, async () => {
      const assembly = await service.assemble(ownerAssembleContext(agent, assembleSignal));
      const result = sectionSurvived(assembly);
      return {supported: true, ...result, reason: result.survived ? 'section_visible' : 'section_dropped'};
    });
  } catch (error) {
    return {supported: true, survived: false, sectionNames: [], reason: `probe_failed:${String(error?.message ?? error).slice(0, 120)}`};
  }
}

/**
 * 第二阶段：把真正的政策段落注册进去，确认装配后文本没有被改写或截断。
 * 只有 registered 与 textMatched 同时为真，才允许把消息态切走。
 */
export async function probePolicySection({agent, section, assembleSignal} = {}) {
  const expected = typeof section?.text === 'string' ? section.text.length : 0;
  if (!section || typeof section.name !== 'string' || typeof section.text !== 'string') {
    return {registered: false, textMatched: false, length: 0, expectedLength: 0, reason: 'section_payload_invalid'};
  }
  const service = agent?.ctx?.get?.('systemPrompt');
  if (typeof service?.section !== 'function' || typeof service?.assemble !== 'function') {
    return {registered: false, textMatched: false, length: 0, expectedLength: expected, reason: 'systemPrompt_unavailable'};
  }
  try {
    return await withTemporarySection(service, section, async () => {
      const assembly = await service.assemble(ownerAssembleContext(agent, assembleSignal));
      const sections = Array.isArray(assembly?.sections) ? assembly.sections : [];
      const found = sections.find(row => row?.name === section.name);
      const text = typeof found?.text === 'string' ? found.text : '';
      return {
        registered: Boolean(found),
        textMatched: text === section.text,
        length: text.length,
        expectedLength: expected,
        reason: !found ? 'policy_section_missing' : text === section.text ? 'policy_section_intact' : 'policy_section_altered',
      };
    });
  } catch (error) {
    return {registered: false, textMatched: false, length: 0, expectedLength: expected, reason: `policy_probe_failed:${String(error?.message ?? error).slice(0, 120)}`};
  }
}

/** 两阶段串起来跑；任何异常都收敛成原因，不抛给调用方。 */
export async function runOwnerProbe({agent, section, assembleSignal} = {}) {
  const quick = await probeOwnerSection({agent, assembleSignal});
  if (!quick.survived) return {version: 2, quick, policy: null, switchAllowed: false};
  const policy = await probePolicySection({agent, section, assembleSignal});
  return {version: 2, quick, policy, switchAllowed: policy.registered === true && policy.textMatched === true};
}

export function readProbe(directory) {
  try {
    return JSON.parse(readFileSync(join(directory, FILE), 'utf8'));
  } catch {
    return null;
  }
}

export function recordProbe(directory, result, now = () => new Date().toISOString()) {
  const v2 = result?.version === 2;
  const quick = v2 ? result.quick ?? {} : result ?? {};
  const policy = v2 ? result.policy ?? null : null;
  const record = {
    version: 2,
    checkedAt: now(),
    assembleContext: 'agent-scope',
    supported: quick.supported === true,
    survived: quick.survived === true,
    reason: String(quick.reason ?? 'unknown').slice(0, 200),
    sectionNames: Array.isArray(quick.sectionNames) ? quick.sectionNames.slice(0, 40) : [],
    policy: policy && {
      registered: policy.registered === true,
      textMatched: policy.textMatched === true,
      length: Number.isInteger(policy.length) ? policy.length : 0,
      expectedLength: Number.isInteger(policy.expectedLength) ? policy.expectedLength : 0,
      reason: String(policy.reason ?? 'unknown').slice(0, 200),
    },
    switchAllowed: v2 ? result.switchAllowed === true : false,
  };
  const target = join(directory, FILE);
  const temporary = join(directory, `.owner-prompt-probe-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {mode: 0o600});
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* nothing to clean */ }
    throw error;
  }
  return record;
}
