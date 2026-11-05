/**
 * 家人侧原生链路：把宿主 agents + sessionController 适配成
 * createNativeMemberRuntime 需要的会话句柄。
 *
 * 依据宿主真实契约：
 * - `agents.create({sessionId, meta:{cwd}, agentOptions, signal})` 返回 `{agent:{id}, dispose}`；
 * - `sessionController.prompt({sessionId, mode:'queue', content:[{type:'text',text}]}, signal)`
 *   返回 `{accepted}`；
 * - `sessionController.page({sessionId}, signal)` 返回含 `records` 的快照，
 *   每条事件在 `record.event`，助手正文在 `event.data.message.content[].text`。
 *
 * 这里不做任何静默兜底：提交未被接受、超时、没有正文都抛错，由上层回退旧链路。
 */
import {randomUUID} from 'node:crypto';

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** 从一页记录里取最后一条助手正文；没有则返回空串。 */
export function extractionAssistantText(records) {
  if (!Array.isArray(records)) return '';
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!isObject(record) || record.type !== 'event') continue;
    const event = record.event;
    if (!isObject(event) || event.type !== 'assistant/message') continue;
    const content = event.data?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n').trim();
    if (text) return text;
  }
  return '';
}

export function createHostMemberSessionFactory({
  agents,
  sessionController,
  cwd,
  agentOptions,
  sessionPrefix = 'family_member_',
  pollMs = 250,
  timeoutMs = 90_000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  if (typeof agents?.create !== 'function') throw new Error('宿主没有提供 agents.create');
  if (typeof sessionController?.prompt !== 'function' || typeof sessionController?.page !== 'function') {
    throw new Error('宿主没有提供 sessionController');
  }

  async function readText(sessionId, signal) {
    const snapshot = await sessionController.page({sessionId}, signal);
    return extractionAssistantText(snapshot?.records);
  }

  /** 工厂：与 createNativeMemberRuntime 的约定一致。 */
  return async function createAgent({personId, sessionId, signal} = {}) {
    if (typeof personId !== 'string' || !personId) throw new Error('成员标识无效');
    const id = typeof sessionId === 'string' && sessionId ? sessionId : `${sessionPrefix}${personId}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const handle = await agents.create({sessionId: id, ...(cwd ? {meta: {cwd}} : {}), ...(agentOptions ? {agentOptions} : {}), ...(signal ? {signal} : {})});
    const liveId = handle?.agent?.id;
    if (typeof liveId !== 'string' || !liveId) throw new Error('宿主没有返回有效会话');

    let submittedAt = 0;
    return {
      sessionId: liveId,
      async prompt({text} = {}) {
        const receipt = await sessionController.prompt({sessionId: liveId, mode: 'queue', content: [{type: 'text', text: String(text ?? '')}]}, signal);
        if (receipt?.accepted !== true) return false;
        submittedAt = now();
        return true;
      },
      /** 轮询到出现助手正文为止；超时抛错，交给上层回退。 */
      async whenIdle() {
        const deadline = submittedAt + timeoutMs;
        for (;;) {
          if (signal?.aborted) throw new Error('原生链路已取消');
          const text = await readText(liveId, signal);
          if (text) return text;
          if (now() >= deadline) throw new Error('原生链路等待回复超时');
          await sleep(pollMs);
        }
      },
      async lastAssistantText() {
        return readText(liveId, signal);
      },
    };
  };
}
