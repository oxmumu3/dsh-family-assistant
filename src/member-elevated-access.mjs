import { randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, parse, resolve } from 'node:path';

const fail = (message, code = 'elevated_access_invalid') => {
  throw Object.assign(new Error(message), { code });
};
const clone = value => structuredClone(value);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(value);
const cleanText = (value, max = 500) => {
  if (typeof value !== 'string') return '';
  if (value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) {
    fail('参数包含无效字符或超过长度限制。');
  }
  return value.trim();
};

function ensureRealDir(requested) {
  const path = resolve(requested);
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) fail('安全路径不能是符号链接。', 'elevated_access_unsafe_path');
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const real = realpathSync(path);
  let cur = parse(real).root;
  for (const part of real.slice(cur.length).split('/').filter(Boolean)) {
    cur = join(cur, part);
    const st = lstatSync(cur);
    if (st.isSymbolicLink() || !st.isDirectory()) fail('安全目录路径包含符号链接。', 'elevated_access_unsafe_path');
  }
  return real;
}

/**
 * 成员临时高权限台账（member-elevated-access.json）。
 *
 * 每个获准的家人拥有独立的隔离工作区（`<directory>-member-workspaces/<personId>`）、
 * 过期时间（expiresAt）及当前微信绑定代数（bindingGeneration）。
 * 一旦到期、换绑、或被 Owner 主动收回，所有高权限会立即失效。
 */
export function createMemberElevatedAccess({ directory, workspaceBaseDir, now = () => new Date().toISOString() } = {}) {
  if (typeof directory !== 'string' || !directory.trim()) fail('需要有效的数据目录。');
  if (typeof now !== 'function') fail('需要有效的时间函数。');

  const root = ensureRealDir(directory);
  const requestedWorkspacesRoot = resolve(workspaceBaseDir ?? `${root}-member-workspaces`);
  const file = join(root, 'member-elevated-access.json');
  const rootStat = lstatSync(root);

  const clock = () => {
    const instant = new Date(now());
    if (!Number.isFinite(+instant)) fail('时间格式无效。');
    return instant.toISOString();
  };

  function safeFile() {
    const currentRoot = lstatSync(root);
    if (currentRoot.ino !== rootStat.ino || currentRoot.dev !== rootStat.dev || realpathSync(root) !== root) {
      fail('数据目录状态已变化。', 'elevated_access_unsafe_path');
    }
    if (existsSync(file)) {
      const info = lstatSync(file);
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
        fail('高权限记录文件类型无效。', 'elevated_access_unsafe_path');
      }
    }
  }

  function validateState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1 || !Array.isArray(state.grants)) {
      fail('高权限记录格式损坏。', 'elevated_access_invalid_state');
    }
    const seen = new Set();
    for (const row of state.grants) {
      if (!row || typeof row !== 'object' || !validId(row.personId) || seen.has(row.personId)) {
        fail('高权限记录成员标识无效。', 'elevated_access_invalid_state');
      }
      seen.add(row.personId);
    }
    return state;
  }

  function save(state) {
    safeFile();
    validateState(state);
    const temporary = join(root, `.member-elevated-access-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(state, null, 2) + '\n');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, file);
      chmodSync(file, 0o600);
      fd = openSync(root, 'r');
      fsyncSync(fd);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch {}
    }
  }

  function load() {
    safeFile();
    if (!existsSync(file)) return { version: 1, grants: [] };
    let fd;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      return validateState(JSON.parse(readFileSync(fd, 'utf8')));
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  function ensureWorkspaceDir(personId) {
    if (!validId(personId)) fail('成员标识无效。');
    const wsRoot = ensureRealDir(requestedWorkspacesRoot);
    const dir = ensureRealDir(join(wsRoot, personId));
    for (const sub of ['reports', 'scripts', 'inbox']) {
      ensureRealDir(join(dir, sub));
    }
    return dir;
  }

  function project(record, { at, bindingGeneration } = {}) {
    if (!record) return null;
    const nowIso = at ?? clock();
    const nowMs = Date.parse(nowIso);
    const isPermanent = record.permanent === true || record.expiresAt === null;
    const expMs = isPermanent ? Infinity : Date.parse(record.expiresAt);
    const genOk = bindingGeneration === undefined || bindingGeneration === null
      ? true
      : (record.bindingGeneration === null ? bindingGeneration === 1 : record.bindingGeneration === bindingGeneration);
    const active = record.enabled === true && genOk && (isPermanent || (Number.isFinite(nowMs) && Number.isFinite(expMs) && nowMs < expMs));
    const remainingMinutes = !active ? 0 : isPermanent ? null : Math.max(1, Math.ceil((expMs - nowMs) / 60_000));
    const expired = !isPermanent && record.enabled === true && Number.isFinite(expMs) && Number.isFinite(nowMs) && nowMs >= expMs;
    return {
      ...clone(record),
      permanent: isPermanent,
      active,
      expired,
      generationMismatch: record.enabled === true && !expired && !genOk,
      remainingMinutes,
    };
  }

  return Object.freeze({
    workspacesRoot: requestedWorkspacesRoot,

    ensureWorkspaceDir,

    grant({ personId, bindingGeneration = null, permanent, durationHours, workspaceId = null, note = '', at } = {}) {
      if (!validId(personId)) fail('成员标识无效。');
      if (bindingGeneration !== null && (!Number.isSafeInteger(bindingGeneration) || bindingGeneration < 1)) {
        fail('目标成员微信绑定版本无效。');
      }
      const isPermanent = permanent === true || (permanent !== false && durationHours === undefined);
      if (!isPermanent && (!Number.isSafeInteger(durationHours) || durationHours < 1 || durationHours > 168)) {
        fail('临时高权限有效期须为 1 至 168 小时之间的整数，或开启常驻专业沙箱模式。');
      }
      const cleanNote = cleanText(note, 500);
      const workspacePath = ensureWorkspaceDir(personId);
      const instant = at ?? clock();
      const expiresAt = isPermanent ? null : new Date(Date.parse(instant) + durationHours * 3600_000).toISOString();
      const state = load();
      const index = state.grants.findIndex(row => row.personId === personId);
      const existing = index >= 0 ? state.grants[index] : null;
      const existingPerm = existing && (existing.permanent === true || existing.expiresAt === null);
      const reuseSession = existing
        && existing.enabled === true
        && (existing.bindingGeneration === bindingGeneration || existing.bindingGeneration === null)
        && (existingPerm || Date.parse(instant) < Date.parse(existing.expiresAt))
        && typeof existing.sessionId === 'string'
        && existing.sessionId.startsWith('family_member_elevated_');
      const sessionId = reuseSession
        ? existing.sessionId
        : `family_member_elevated_${personId}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const record = {
        personId,
        enabled: true,
        permanent: isPermanent,
        grantedAt: reuseSession && existing.grantedAt ? existing.grantedAt : instant,
        expiresAt,
        durationHours: isPermanent ? null : durationHours,
        bindingGeneration,
        workspacePath,
        workspaceId: typeof workspaceId === 'string' && workspaceId ? workspaceId : (existing?.workspaceId ?? null),
        sessionId,
        note: cleanNote,
        updatedAt: instant,
        revokedAt: null,
        revokeReason: null,
      };
      if (index >= 0) state.grants[index] = record;
      else state.grants.push(record);
      save(state);
      return project(record, { at: instant, bindingGeneration });
    },

    bindPending(personId, bindingGeneration) {
      if (!validId(personId) || !Number.isSafeInteger(bindingGeneration) || bindingGeneration < 1) return null;
      const state = load();
      const row = state.grants.find(item => item.personId === personId);
      if (!row || row.bindingGeneration !== null) return row ? project(row, { bindingGeneration }) : null;
      row.bindingGeneration = bindingGeneration;
      row.updatedAt = clock();
      save(state);
      return project(row, { bindingGeneration });
    },

    setWorkspaceId(personId, workspaceId) {
      if (!validId(personId) || typeof workspaceId !== 'string' || !workspaceId.trim()) return null;
      const state = load();
      const row = state.grants.find(item => item.personId === personId);
      if (!row) return null;
      if (row.workspaceId === workspaceId) return project(row);
      row.workspaceId = workspaceId;
      row.updatedAt = clock();
      save(state);
      return project(row);
    },

    revoke({ personId, reason = 'owner_revoked', at } = {}) {
      if (!validId(personId)) fail('成员标识无效。');
      const instant = at ?? clock();
      const state = load();
      const index = state.grants.findIndex(row => row.personId === personId);
      if (index < 0) {
        return {
          personId,
          enabled: false,
          active: false,
          expired: false,
          generationMismatch: false,
          remainingMinutes: 0,
          revokedAt: instant,
          revokeReason: cleanText(reason, 200) || 'owner_revoked',
        };
      }
      const row = state.grants[index];
      row.enabled = false;
      row.revokedAt = instant;
      row.revokeReason = cleanText(reason, 200) || 'owner_revoked';
      row.updatedAt = instant;
      save(state);
      return project(row, { at: instant });
    },

    get(personId, { at, bindingGeneration } = {}) {
      if (!validId(personId)) return null;
      const row = load().grants.find(item => item.personId === personId);
      return project(row, { at, bindingGeneration });
    },

    isActive(personId, { at, bindingGeneration } = {}) {
      return this.get(personId, { at, bindingGeneration })?.active === true;
    },

    list({ at, getBindingGeneration } = {}) {
      return load().grants.map(row => {
        const gen = typeof getBindingGeneration === 'function' ? getBindingGeneration(row.personId) : undefined;
        return project(row, { at, bindingGeneration: gen });
      });
    },

    sessionOwner(sessionId, { at, getBindingGeneration } = {}) {
      if (typeof sessionId !== 'string' || !sessionId.startsWith('family_member_elevated_')) return null;
      const row = load().grants.find(item => item.sessionId === sessionId);
      if (!row) return null;
      const gen = typeof getBindingGeneration === 'function' ? getBindingGeneration(row.personId) : undefined;
      const projected = project(row, { at, bindingGeneration: gen });
      return projected?.active ? projected : null;
    },
  });
}
