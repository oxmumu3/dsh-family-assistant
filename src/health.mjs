/**
 * 家人连接健康总览。
 *
 * 目的：让 Owner 一眼看出"谁在线、最后一条有没有送到、有没有卡住的投递"，
 * 而不是去读一堆状态码。纯函数，只做有界汇总，不包含消息正文。
 */

const TERMINAL = new Set(['api_accepted', 'failed', 'blocked', 'uncertain', 'cancelled', 'expired']);
const RECENT = 24 * 60 * 60 * 1000;

function parse(value) {
  const at = Date.parse(value ?? '');
  return Number.isFinite(at) ? at : null;
}

/** 单个家人的健康行：连接、最近收发、待发与近 24 小时失败分类。 */
export function personHealth({person, binding, outbox = [], channel, nowMs}) {
  const since = nowMs - RECENT;
  const rows = outbox.filter(row => row.personId === person.id);
  const pending = rows.filter(row => !TERMINAL.has(row.status)).length;
  const recent = rows.filter(row => (parse(row.createdAt) ?? 0) >= since);
  const failed = recent.filter(row => row.status === 'failed').length;
  const uncertain = recent.filter(row => row.status === 'uncertain').length;
  const blocked = recent.filter(row => row.status === 'blocked').length;
  const connected = channel?.connected === true || channel?.status === 'connected';
  let state = 'ok';
  if (!connected) state = 'offline';
  else if (pending > 0 || uncertain > 0) state = 'attention';
  return {
    personId: person.id,
    label: person.label,
    role: person.role,
    connected,
    channelStatus: String(channel?.status ?? binding?.status ?? 'disconnected'),
    lastInboundAt: binding?.lastInboundAt ?? null,
    lastOutboundAt: binding?.lastOutboundAt ?? null,
    pending,
    failed24h: failed,
    uncertain24h: uncertain,
    blocked24h: blocked,
    state,
  };
}

/** 整个家庭的总览：逐人一行 + 有界合计。 */
export function buildHealth({state, channelOf = () => null, now = () => new Date().toISOString()} = {}) {
  const people = Array.isArray(state?.people) ? state.people : [];
  const outbox = Array.isArray(state?.outbox) ? state.outbox : [];
  const bindings = Array.isArray(state?.bindings) ? state.bindings : [];
  const nowMs = parse(now()) ?? Date.now();
  const rows = people.map(person => personHealth({
    person,
    binding: bindings.find(row => row.personId === person.id) ?? null,
    outbox,
    channel: channelOf(person.id),
    nowMs,
  }));
  const totals = {
    people: rows.length,
    online: rows.filter(row => row.connected).length,
    attention: rows.filter(row => row.state === 'attention').length,
    offline: rows.filter(row => row.state === 'offline').length,
    pending: rows.reduce((sum, row) => sum + row.pending, 0),
    uncertain24h: rows.reduce((sum, row) => sum + row.uncertain24h, 0),
    failed24h: rows.reduce((sum, row) => sum + row.failed24h, 0),
  };
  return {version: 1, checkedAt: now(), totals, people: rows};
}

/** 人类可读的一行结论，供简报或工作台直接展示。 */
export function healthSummary(health) {
  if (!health || !Array.isArray(health.people) || !health.people.length) return '还没有登记家人。';
  const {totals} = health;
  const parts = [`${totals.online}/${totals.people} 在线`];
  if (totals.pending) parts.push(`${totals.pending} 条待发`);
  if (totals.uncertain24h) parts.push(`${totals.uncertain24h} 条结果待核对`);
  if (totals.failed24h) parts.push(`${totals.failed24h} 条近 24 小时失败`);
  if (totals.offline) parts.push(`${totals.offline} 位离线`);
  return parts.join('，');
}
