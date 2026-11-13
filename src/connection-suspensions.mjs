import {chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';

/**
 * 本机「本人明确断开」标记。
 *
 * 刻意独立于 family.json：旧版 .49 对 binding 字段做严格校验，往台账里加字段
 * 会让回退包无法启动。这份小文件只按成员记录是否由本人手动停用，旧版不读它，
 * 因此回退旧版仍能照原样读台账并自动连接。
 */
const version = 1;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const fail = message => { throw new Error(message); };
const clone = value => structuredClone(value);

export function createConnectionSuspensions({directory, now = () => new Date().toISOString()} = {}) {
  if (typeof directory !== 'string' || !directory) fail('手动断开状态需要独立数据目录。');
  if (typeof now !== 'function') fail('时钟无效。');
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const file = join(directory, 'connection-suspensions.json');

  function read() {
    if (!existsSync(file)) return {version, suspended: {}};
    let value;
    try { value = JSON.parse(readFileSync(file, 'utf8')); }
    catch { fail('手动断开状态文件无法读取，请先修复或移除它。'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== version ||
        !value.suspended || typeof value.suspended !== 'object' || Array.isArray(value.suspended)) fail('手动断开状态文件格式无效。');
    for (const [personId, row] of Object.entries(value.suspended)) {
      if (!safeId(personId) || !row || typeof row !== 'object' || Array.isArray(row)) fail('手动断开状态文件格式无效。');
      for (const key of Object.keys(row)) if (key !== 'at') fail('手动断开状态文件格式无效。');
      if (typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at))) fail('手动断开状态文件格式无效。');
    }
    return value;
  }

  let state = read();

  function persist(next) {
    const temporary = join(directory, `.connection-suspensions-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(next, null, 2) + '\n');
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, file); chmodSync(file, 0o600);
      let dirfd;
      try { dirfd = openSync(directory, 'r'); fsyncSync(dirfd); } finally { if (dirfd !== undefined) closeSync(dirfd); }
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch {}
      throw error;
    }
    state = next;
  }

  return {
    file,
    isSuspended: personId => safeId(personId) && Object.hasOwn(state.suspended, personId),
    mark(personId) {
      if (!safeId(personId)) fail('成员标识无效');
      if (state.suspended[personId]) return clone(state.suspended[personId]);
      const next = {version, suspended: {...state.suspended, [personId]: {at: now()}}};
      persist(next); return clone(next.suspended[personId]);
    },
    clear(personId) {
      if (!safeId(personId) || !state.suspended[personId]) return false;
      const suspended = {...state.suspended}; delete suspended[personId];
      persist({version, suspended}); return true;
    },
    snapshot: () => clone(state),
  };
}
