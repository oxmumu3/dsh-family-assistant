import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const ID_RE = /^[A-Za-z0-9._:-]{1,120}$/u;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u;
const PUSH_RULE_KEYS = ['relay', 'ask', 'urgent', 'digest'];
const PERSONA_VALUES = ['elder_care', 'partner', 'pro_peer'];

function fail(message) {
  throw new Error(message);
}

function own(object, keys) {
  return object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(key => keys.includes(key));
}

function validInstant(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validText(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength && !CONTROL_RE.test(value);
}

function defaultState() {
  return {
    version: 1,
    guard: {
      pushRules: { relay: true, ask: true, urgent: true, digest: true },
      quietHoursEnabled: false,
      quietStart: '22:30',
      quietEnd: '07:30',
    },
    members: {},
    skippedReminders: {},
  };
}

function defaultMember() {
  return {
    persona: 'elder_care',
    pinganEnabled: false,
    pinganTime: '19:30',
    codeword: '',
    lastPinganInboundAt: null,
    lastPinganDate: null,
    ownerHabits: [],
  };
}

function validateGuard(guard) {
  if (!own(guard, ['pushRules', 'quietHoursEnabled', 'quietStart', 'quietEnd'])) fail('守护规则设置格式无效。');
  if (!own(guard.pushRules, PUSH_RULE_KEYS)) fail('推送开关设置格式无效。');
  for (const key of PUSH_RULE_KEYS) {
    if (typeof guard.pushRules[key] !== 'boolean') fail('推送开关取值无效。');
  }
  if (typeof guard.quietHoursEnabled !== 'boolean') fail('勿扰时段开关取值无效。');
  if (!TIME_RE.test(guard.quietStart ?? '') || !TIME_RE.test(guard.quietEnd ?? '')) fail('勿扰时间须为 HH:MM 格式。');
  return {
    pushRules: { ...guard.pushRules },
    quietHoursEnabled: guard.quietHoursEnabled,
    quietStart: guard.quietStart,
    quietEnd: guard.quietEnd,
  };
}

function validateHabits(habits) {
  if (!Array.isArray(habits) || habits.length > 40) fail('习惯条数过多或格式无效。');
  const seen = new Set();
  return habits.map(item => {
    if (!own(item, ['id', 'text', 'createdAt', 'updatedAt'])) fail('习惯条目格式无效。');
    if (!ID_RE.test(item.id ?? '') || seen.has(item.id)) fail('习惯标识无效或重复。');
    seen.add(item.id);
    if (!validText(item.text, 240)) fail('习惯内容不能为空，且需在 240 字以内。');
    if (!validInstant(item.createdAt) || !validInstant(item.updatedAt)) fail('习惯时间格式无效。');
    return { id: item.id, text: item.text.trim(), createdAt: item.createdAt, updatedAt: item.updatedAt };
  });
}

function validateMember(member) {
  if (!own(member, ['persona', 'pinganEnabled', 'pinganTime', 'codeword', 'lastPinganInboundAt', 'lastPinganDate', 'ownerHabits'])) {
    fail('家人守护偏好格式无效。');
  }
  const persona = member.persona ?? 'elder_care';
  if (!PERSONA_VALUES.includes(persona)) fail('成员席位角色取值无效。');
  if (typeof member.pinganEnabled !== 'boolean') fail('平安问候开关取值无效。');
  if (!TIME_RE.test(member.pinganTime ?? '')) fail('问候时间须为 HH:MM 格式。');
  if (typeof member.codeword !== 'string' || member.codeword.length > 40 || CONTROL_RE.test(member.codeword)) fail('家庭暗号须在 40 字以内。');
  if (member.lastPinganInboundAt !== null && !validInstant(member.lastPinganInboundAt)) fail('上次问平安时间格式无效。');
  if (member.lastPinganDate !== null && !DATE_RE.test(member.lastPinganDate)) fail('上次问平安日期格式无效。');
  return {
    persona,
    pinganEnabled: member.pinganEnabled,
    pinganTime: member.pinganTime,
    codeword: member.codeword.trim(),
    lastPinganInboundAt: member.lastPinganInboundAt,
    lastPinganDate: member.lastPinganDate,
    ownerHabits: validateHabits(member.ownerHabits ?? []),
  };
}

function validateState(raw) {
  if (!own(raw, ['version', 'guard', 'members', 'skippedReminders']) || raw.version !== 1) fail('守护偏好账本格式无效。');
  const guard = validateGuard(raw.guard);
  if (!raw.members || typeof raw.members !== 'object' || Array.isArray(raw.members)) fail('家人守护偏好映射无效。');
  const members = {};
  for (const [personId, value] of Object.entries(raw.members)) {
    if (!ID_RE.test(personId)) fail('家人标识无效。');
    members[personId] = validateMember(value);
  }
  if (!raw.skippedReminders || typeof raw.skippedReminders !== 'object' || Array.isArray(raw.skippedReminders)) fail('跳过提醒记录格式无效。');
  const skippedReminders = {};
  for (const [reminderId, entry] of Object.entries(raw.skippedReminders)) {
    if (!ID_RE.test(reminderId)) fail('提醒标识无效。');
    if (!own(entry, ['date', 'skippedAt']) || !DATE_RE.test(entry.date ?? '') || !validInstant(entry.skippedAt)) fail('跳过提醒记录条目无效。');
    skippedReminders[reminderId] = { date: entry.date, skippedAt: entry.skippedAt };
  }
  return { version: 1, guard, members, skippedReminders };
}

function localClockHHMM(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(instant));
  const map = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const hour = map.hour === '24' ? '00' : map.hour;
  return `${hour}:${map.minute}`;
}

/** Persistent atomic 0o600 sidecar storing Warm Editorial Hearth preferences, keepalive settings, skip-once markers, and owner-curated habits. */
export function createHearthPreferences({ directory, now = () => new Date().toISOString() }) {
  mkdirSync(directory, { recursive: true });
  const filePath = join(directory, 'hearth-preferences.json');

  function load() {
    if (!existsSync(filePath)) return { state: defaultState(), exists: false };
    const stat = statSync(filePath);
    if (!stat.isFile()) fail('守护偏好文件类型无效。');
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return { state: validateState(parsed), exists: true };
  }

  function save(nextState) {
    const validated = validateState(nextState);
    const tmp = join(directory, `.hearth-preferences-${randomUUID()}.tmp`);
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(validated, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, filePath);
    chmodSync(filePath, 0o600);
    return validated;
  }

  function mutate(fn) {
    const current = load().state;
    const next = fn(structuredClone(current));
    return save(next);
  }

  return Object.freeze({
    filePath,
    snapshot() {
      return structuredClone(load().state);
    },
    guard() {
      return structuredClone(load().state.guard);
    },
    updateGuard(patch) {
      if (!own(patch, ['pushRules', 'quietHoursEnabled', 'quietStart', 'quietEnd'])) fail('守护规则参数无效。');
      const saved = mutate(s => {
        if (patch.pushRules !== undefined) {
          if (!own(patch.pushRules, PUSH_RULE_KEYS)) fail('推送规则参数无效。');
          s.guard.pushRules = { ...s.guard.pushRules, ...patch.pushRules };
        }
        if (patch.quietHoursEnabled !== undefined) s.guard.quietHoursEnabled = patch.quietHoursEnabled;
        if (patch.quietStart !== undefined) s.guard.quietStart = patch.quietStart;
        if (patch.quietEnd !== undefined) s.guard.quietEnd = patch.quietEnd;
        return s;
      });
      return structuredClone(saved.guard);
    },
    inQuietHours(instant = now(), timeZone = 'Asia/Shanghai') {
      const g = load().state.guard;
      if (!g.quietHoursEnabled || g.quietStart === g.quietEnd) return false;
      const hhmm = localClockHHMM(instant, timeZone);
      if (g.quietStart < g.quietEnd) return hhmm >= g.quietStart && hhmm < g.quietEnd;
      return hhmm >= g.quietStart || hhmm < g.quietEnd;
    },
    member(personId) {
      if (!ID_RE.test(personId ?? '')) fail('家人标识无效。');
      const state = load().state;
      return structuredClone(state.members[personId] ?? defaultMember());
    },
    updateMember(personId, patch) {
      if (!ID_RE.test(personId ?? '')) fail('家人标识无效。');
      if (!own(patch, ['persona', 'pinganEnabled', 'pinganTime', 'codeword', 'lastPinganInboundAt', 'lastPinganDate'])) {
        fail('家人守护偏好参数无效。');
      }
      const saved = mutate(s => {
        const cur = s.members[personId] ?? defaultMember();
        s.members[personId] = { ...cur, ...patch };
        return s;
      });
      return structuredClone(saved.members[personId]);
    },
    addHabit(personId, { id = `habit-${randomUUID().slice(0, 12)}`, text } = {}) {
      if (!ID_RE.test(personId ?? '')) fail('家人标识无效。');
      if (!validText(text, 240)) fail('习惯内容不能为空，且需在 240 字以内。');
      const stamp = now();
      const saved = mutate(s => {
        const cur = s.members[personId] ?? defaultMember();
        if (cur.ownerHabits.some(item => item.id === id)) fail('该习惯已存在。');
        cur.ownerHabits = [...cur.ownerHabits, { id, text: text.trim(), createdAt: stamp, updatedAt: stamp }];
        s.members[personId] = cur;
        return s;
      });
      return structuredClone(saved.members[personId].ownerHabits.find(item => item.id === id));
    },
    updateHabit(personId, { id, text } = {}) {
      if (!ID_RE.test(personId ?? '') || !ID_RE.test(id ?? '')) fail('家人或习惯标识无效。');
      if (!validText(text, 240)) fail('习惯内容不能为空，且需在 240 字以内。');
      const stamp = now();
      const saved = mutate(s => {
        const cur = s.members[personId];
        const target = cur?.ownerHabits?.find(item => item.id === id);
        if (!target) fail('没有找到这条习惯记录。');
        target.text = text.trim();
        target.updatedAt = stamp;
        return s;
      });
      return structuredClone(saved.members[personId].ownerHabits.find(item => item.id === id));
    },
    deleteHabit(personId, { id } = {}) {
      if (!ID_RE.test(personId ?? '') || !ID_RE.test(id ?? '')) fail('家人或习惯标识无效。');
      const saved = mutate(s => {
        const cur = s.members[personId];
        if (!cur || !cur.ownerHabits.some(item => item.id === id)) fail('没有找到这条习惯记录。');
        cur.ownerHabits = cur.ownerHabits.filter(item => item.id !== id);
        return s;
      });
      return { deleted: id, habits: structuredClone(saved.members[personId].ownerHabits) };
    },
    skipReminder(reminderId, date) {
      if (!ID_RE.test(reminderId ?? '') || !DATE_RE.test(date ?? '')) fail('跳过提醒的标识或日期无效。');
      const stamp = now();
      const saved = mutate(s => {
        s.skippedReminders[reminderId] = { date, skippedAt: stamp };
        return s;
      });
      return structuredClone(saved.skippedReminders[reminderId]);
    },
    unskipReminder(reminderId) {
      if (!ID_RE.test(reminderId ?? '')) fail('提醒标识无效。');
      mutate(s => {
        delete s.skippedReminders[reminderId];
        return s;
      });
      return { reminderId, skipped: false };
    },
    isReminderSkipped(reminderId, date) {
      if (!ID_RE.test(reminderId ?? '') || !DATE_RE.test(date ?? '')) return false;
      const entry = load().state.skippedReminders[reminderId];
      return entry?.date === date;
    },
  });
}
