/**
 * 家人侧原生链路的灰度开关。
 *
 * 默认全部关闭（文件不存在 = 全走旧链路）。按成员开启，写入采用临时文件 +
 * rename；读失败一律按关闭处理，绝不让灰度文件把家人对话卡住。
 */
import {existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';

const FILE = 'member-native-flags.json';

export function readMemberNativeFlags(directory) {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, FILE), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {version: 1, people: {}};
    if (parsed.version !== 1 || typeof parsed.people !== 'object' || Array.isArray(parsed.people)) return {version: 1, people: {}};
    const people = {};
    for (const [personId, value] of Object.entries(parsed.people)) {
      if (typeof personId === 'string' && personId && value === true) people[personId] = true;
    }
    return {version: 1, people};
  } catch {
    return {version: 1, people: {}};
  }
}

export function isMemberNative(directory, personId) {
  if (typeof personId !== 'string' || !personId) return false;
  return readMemberNativeFlags(directory).people[personId] === true;
}

export function setMemberNative(directory, personId, enabled) {
  if (typeof personId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(personId)) throw new Error('成员标识无效');
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const current = readMemberNativeFlags(directory);
  const people = {...current.people};
  if (enabled === true) people[personId] = true;
  else delete people[personId];
  const target = join(directory, FILE);
  const temporary = join(directory, `.member-native-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify({version: 1, people}, null, 2)}\n`, {mode: 0o600});
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* nothing to clean */ }
    throw error;
  }
  return {version: 1, people};
}

export function clearMemberNative(directory) {
  try { if (existsSync(join(directory, FILE))) unlinkSync(join(directory, FILE)); } catch { /* already gone */ }
}
