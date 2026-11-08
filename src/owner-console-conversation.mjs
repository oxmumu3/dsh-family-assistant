/**
 * The Owner's desktop conversation anchor.
 *
 * The family panel embeds exactly one native Harness session for the Owner.
 * This file records which one, so the panel and the legacy console chat both
 * write into the same conversation. It stores identifiers only — never message
 * text — and is written atomically with private permissions.
 */
import {readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join, isAbsolute} from 'node:path';

const FILE = 'owner-console-conversation.json';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9_-]{1,80}$/;

export function validConsoleConversation(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && value.version === 1
    && typeof value.personId === 'string' && ID.test(value.personId)
    && typeof value.conversationId === 'string' && UUID.test(value.conversationId)
    && value.sessionId === 'family_owner_' + value.conversationId
    && typeof value.workspaceId === 'string' && value.workspaceId.length > 0 && value.workspaceId.length <= 240
    && typeof value.cwd === 'string' && isAbsolute(value.cwd)
    && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt));
}

export function createConsoleConversationStore({directory, now = () => new Date().toISOString()} = {}) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('会话锚点需要绝对数据目录。');
  const file = join(directory, FILE);
  let cached;
  function read() {
    if (cached !== undefined) return cached;
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      cached = validConsoleConversation(value) ? Object.freeze({...value}) : null;
    } catch {
      cached = null;
    }
    return cached;
  }
  function write(value) {
    if (!validConsoleConversation(value)) throw new Error('会话锚点格式无效。');
    mkdirSync(directory, {recursive: true, mode: 0o700});
    const temporary = join(directory, `.owner-console-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600});
      renameSync(temporary, file);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* nothing to clean */ }
      throw error;
    }
    cached = Object.freeze({...value});
    return cached;
  }
  /** A new anchor for a fresh conversation inside the given workspace. */
  function create({personId, workspaceId, cwd}) {
    const conversationId = randomUUID();
    return {version: 1, personId, conversationId, sessionId: 'family_owner_' + conversationId, workspaceId, cwd, createdAt: now()};
  }
  return Object.freeze({read, write, create});
}
