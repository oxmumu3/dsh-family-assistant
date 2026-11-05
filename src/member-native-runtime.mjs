/**
 * 家人侧原生链路的薄适配层。
 *
 * 不直接抓宿主控制器：调用方注入 createAgent（真实实现用 ctx.agents），
 * 因此这一层可以在没有宿主的环境里用假实现完整测试。任何异常都向上抛，
 * 由调用方回退到旧链路——这里不吞错，也不做"看起来成功"的假回复。
 */
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function createNativeMemberRuntime({createAgent} = {}) {
  if (typeof createAgent !== 'function') throw new Error('原生链路需要注入 createAgent');

  /**
   * 跑一轮：创建（或续接）一个家人会话，提交本轮文本，等待终态并取最后一条
   * 助手文本。返回 { text, sessionId }；空回复按失败处理，交由调用方回退。
   */
  async function run({personId, sessionId, text, history = [], signal} = {}) {
    if (typeof personId !== 'string' || !personId) throw new Error('成员标识无效');
    if (typeof text !== 'string' || !text.trim()) throw new Error('本轮内容为空');
    const handle = await createAgent({personId, sessionId, history, signal});
    if (!isObject(handle) || typeof handle.sessionId !== 'string') throw new Error('宿主没有返回有效会话');
    if (typeof handle.prompt !== 'function') throw new Error('宿主会话不支持提交');
    const accepted = await handle.prompt({text});
    if (accepted === false) throw new Error('宿主拒绝了本轮提交');
    if (typeof handle.whenIdle === 'function') await handle.whenIdle();
    const reply = typeof handle.lastAssistantText === 'function' ? await handle.lastAssistantText() : '';
    if (typeof reply !== 'string' || !reply.trim()) throw new Error('宿主没有产出回复');
    return {text: reply, sessionId: handle.sessionId};
  }

  return Object.freeze({run});
}
