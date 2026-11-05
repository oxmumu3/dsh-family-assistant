/**
 * 家人回复路由：默认走旧链路，只有开关打开且原生链路可用时才尝试原生，
 * 原生失败立刻回退旧链路。纯函数，便于在没有宿主的环境里验证回退语义。
 */

export function shouldUseNative({enabled, available} = {}) {
  return enabled === true && available === true;
}

/**
 * 执行一轮家人回复。
 * - enabled 为 false 或 native 不可用：直接 legacy。
 * - native 抛错、返回空、或返回形状不对：记录原因后回退 legacy。
 * - legacy 自身抛错：向上抛，调用方按原有方式处理。
 * 返回 {route, result, nativeError}，route 只有 legacy / native 两种。
 */
export async function dispatchMemberReply({enabled, native, legacy, onNativeError} = {}) {
  if (typeof legacy !== 'function') throw new Error('缺少旧链路实现');
  if (!shouldUseNative({enabled, available: typeof native === 'function'})) {
    return {route: 'legacy', result: await legacy()};
  }
  let nativeError = null;
  try {
    const result = await native();
    if (!result || typeof result.reply !== 'string' || !result.reply.trim()) {
      nativeError = new Error('原生链路没有产出可用回复');
    } else {
      return {route: 'native', result};
    }
  } catch (error) {
    nativeError = error instanceof Error ? error : new Error(String(error));
  }
  try { onNativeError?.(nativeError); } catch { /* diagnostics must not break the turn */ }
  return {route: 'legacy', result: await legacy(), nativeError};
}
