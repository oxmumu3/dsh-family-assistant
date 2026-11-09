/**
 * Can we still reach this person right now?
 *
 * The WeChat bot carrier only delivers a proactive message within 24 hours of
 * that person's own last inbound message. Measured on this machine: every send
 * inside the window arrived (16/16), and none of the 64 sends after it did.
 * The rule is also documented by another iLink-based project
 * (docs.cowagent.ai/channels/weixin); Tencent's own text has not been verified.
 *
 * This module answers the question for the UI and gates sending. It never
 * claims a delivery: `open` only means the carrier should still accept it.
 */
export const REACH_WINDOW_MS = 24 * 60 * 60 * 1000;

const HOUR = 60 * 60 * 1000;

/** Remaining window in whole hours, floored, for a human label. */
export function remainingHours(remainingMs) {
  return Math.max(0, Math.floor(remainingMs / HOUR));
}

/**
 * @param {object} input
 * @param {string} input.role owner | elder
 * @param {boolean} input.connected carrier reports a live binding
 * @param {string|null} input.lastInboundAt that person's own last message
 * @param {string} input.now ISO timestamp
 * @returns {{state: 'self'|'open'|'closed'|'offline', remainingMs: number}}
 *   self — the Owner writes here; no window applies to their own panel
 *   open — inside the window and connected
 *   closed — connected, but their last message is older than the window
 *   offline — the carrier reports no live binding
 */
export function reachFor({ role, connected, lastInboundAt, now } = {}) {
  if (role === 'owner') return { state: 'self', remainingMs: 0 };
  if (connected !== true) return { state: 'offline', remainingMs: 0 };
  const at = Date.parse(lastInboundAt ?? '');
  const current = Date.parse(now ?? '');
  // Without a trustworthy clock or timestamp we cannot claim the window is
  // open, so treat it as closed and let the message wait.
  if (!Number.isFinite(at) || !Number.isFinite(current)) return { state: 'closed', remainingMs: 0 };
  const remaining = at + REACH_WINDOW_MS - current;
  return remaining > 0 ? { state: 'open', remainingMs: remaining } : { state: 'closed', remainingMs: 0 };
}

/** Short Chinese label for the panel and for tool results. */
export function reachLabel(reach) {
  if (!reach) return '未知';
  if (reach.state === 'self') return '可随时发';
  if (reach.state === 'open') return `现在能收到（还剩 ${Math.max(1, remainingHours(reach.remainingMs))} 小时）`;
  if (reach.state === 'offline') return '离线，暂时收不到';
  return '要等对方先说一句';
}

/** True when a message to this person may be attempted now. */
export function canSendNow(reach) {
  return Boolean(reach) && (reach.state === 'self' || reach.state === 'open');
}
