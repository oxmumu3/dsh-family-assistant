import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_BYTES = 18_000;
const MAX_SCRIPT_FILE_BYTES = 22_000;
const MAX_RAW_STDOUT_CHARS = 48_000;
const COLLECTOR_TIMEOUT_MS = 90_000;

const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
];

const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/gu,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  /\b(?:api[_\- ]?key|access[_\- ]?token|refresh[_\- ]?token|auth[_\- ]?token|token|password|passwd|client[_\- ]?secret|secret(?:[_\- ]?key)?|credential)["']?\s*[:=]\s*["']?\S+/giu,
  /\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/giu,
  /(?:密码|口令|密钥|令牌|私钥)\s*[:：=]\s*\S+/gu,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/giu,
];

const fail = (message, code = 'custom_digest_invalid') => {
  throw Object.assign(new Error(message), { code });
};
const clone = value => structuredClone(value);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(value);
const validSlug = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{1,48}$/u.test(value);
const validClock = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/u.test(value);
const validZone = value => {
  try {
    return typeof value === 'string' && value.length > 0 && value.length <= 100 && Boolean(new Intl.DateTimeFormat('en', { timeZone: value }));
  } catch {
    return false;
  }
};

function dateInZone(instant, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(instant));
}

function isWorkdayInZone(instant, timeZone) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(instant));
  return !['Sat', 'Sun'].includes(weekday);
}

function minutesInZone(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find(part => part.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

function ensureRealDir(requested) {
  const path = resolve(requested);
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) fail('安全路径不能是符号链接。', 'custom_digest_unsafe_path');
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const real = realpathSync(path);
  let cur = parse(real).root;
  for (const part of real.slice(cur.length).split('/').filter(Boolean)) {
    cur = join(cur, part);
    const st = lstatSync(cur);
    if (st.isSymbolicLink() || !st.isDirectory()) fail('目录链路包含符号链接。', 'custom_digest_unsafe_path');
  }
  return real;
}

function validateRelativePath(value, { extensions }) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) return null;
  const trimmed = value.trim();
  if (isAbsolute(trimmed) || /[\\\x00-\x1f\x7f]/u.test(trimmed)) return null;
  const parts = trimmed.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) return null;
  if (extensions && !extensions.test(trimmed)) return null;
  return trimmed;
}

function inspectConfinedTarget(workspaceRealRoot, relPath, { expectFile = false } = {}) {
  const parts = relPath.split('/');
  let cur = workspaceRealRoot;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    const st = lstatSync(cur);
    const isFinal = i === parts.length - 1;
    if (st.isSymbolicLink()) fail('目标路径不能包含符号链接。', 'custom_digest_unsafe_path');
    if (isFinal && expectFile) {
      if (!st.isFile() || st.nlink !== 1) fail('目标文件必须为普通单一文件。', 'custom_digest_unsafe_path');
    } else if (!isFinal && !st.isDirectory()) {
      fail('目标父路径必须为普通目录。', 'custom_digest_unsafe_path');
    }
  }
  const real = realpathSync(cur);
  const diff = relative(workspaceRealRoot, real);
  if (!diff || isAbsolute(diff) || diff === '..' || diff.startsWith('../')) {
    fail('目标路径超出成员工作区范围。', 'custom_digest_unsafe_path');
  }
  return { path: real, stat: lstatSync(real) };
}

function utf8Truncate(text, maxBytes) {
  let str = String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim();
  for (const pattern of CREDENTIAL_PATTERNS) str = str.replace(pattern, '[已脱敏]');
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  let sliced = buf.subarray(0, end).toString('utf8').replace(/\uFFFD$/u, '').trimEnd();
  if (sliced && /[\uD800-\uDBFF]/u.test(sliced[sliced.length - 1])) sliced = sliced.slice(0, -1);
  return sliced + '\n\n（正文已按微信投递长度上限自动截断）';
}

function extractHeadlines(text, today) {
  const lines = String(text ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length >= 6 && !/^[=\-*#]{3,}$/u.test(line))
    .slice(0, 4)
    .map(line => `${today}: ${line.slice(0, 120)}`);
  return lines;
}

/**
 * 成员定制日报引擎（member-custom-digests.json）。
 *
 * 即使临时高权限后续被 Owner 收回或自然过期，只要此定制方案仍为启用状态，
 * runtime.tick() 就会在每日推送时间前（或补发窗口内）在成员工作区沙箱中运行脚本
 * 并通过宿主 LLM 整理为 `reports/<slug>/YYYY-MM-DD-wechat.txt`，再由 family-toolbox
 * 统一完成当日唯一一次微信推送。
 */
export function createMemberCustomDigests({ directory, synthesize, now = () => new Date().toISOString() } = {}) {
  if (typeof directory !== 'string' || !directory.trim()) fail('需要有效的数据目录。');
  if (typeof now !== 'function') fail('需要有效的时间函数。');

  const root = ensureRealDir(directory);
  const file = join(root, 'member-custom-digests.json');
  const rootStat = lstatSync(root);
  const inFlight = new Map();

  const clock = () => {
    const instant = new Date(now());
    if (!Number.isFinite(+instant)) fail('时间格式无效。');
    return instant.toISOString();
  };

  function safeFile() {
    const curRoot = lstatSync(root);
    if (curRoot.ino !== rootStat.ino || curRoot.dev !== rootStat.dev || realpathSync(root) !== root) {
      fail('数据目录状态已变化。', 'custom_digest_unsafe_path');
    }
    if (existsSync(file)) {
      const info = lstatSync(file);
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
        fail('定制日报配置文件无效。', 'custom_digest_unsafe_path');
      }
    }
  }

  function validateState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1 || !Array.isArray(state.items)) {
      fail('定制日报配置格式无效。', 'custom_digest_invalid_state');
    }
    return state;
  }

  function saveState(state) {
    safeFile();
    validateState(state);
    const temporary = join(root, `.member-custom-digests-${randomUUID()}.tmp`);
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

  function loadState() {
    safeFile();
    if (!existsSync(file)) return { version: 1, items: [] };
    let fd;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      return validateState(JSON.parse(readFileSync(fd, 'utf8')));
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  function writeAtomicReport(dir, name, content) {
    const tmp = join(dir, `.${name}.${randomUUID()}.tmp`);
    let fd;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      writeFileSync(fd, content);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      const target = join(dir, name);
      renameSync(tmp, target);
      chmodSync(target, 0o600);
      return target;
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(tmp); } catch {}
    }
  }

  async function executeCollector(item, today, outputAbsPath, signal) {
    const wsReal = ensureRealDir(item.workspacePath);
    const inspected = inspectConfinedTarget(wsReal, item.collectorScript, { expectFile: true });
    const command = item.collectorScript.endsWith('.py') ? 'python3' : process.execPath;
    const env = {
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
      HOME: wsReal,
      TMPDIR: '/tmp',
      TZ: item.timeZone,
      LANG: 'en_US.UTF-8',
      TODAY: today,
      OUTPUT_PATH: outputAbsPath,
    };
    for (const key of PROXY_ENV_KEYS) {
      if (typeof process.env[key] === 'string' && process.env[key]) env[key] = process.env[key];
    }
    const result = await execFileAsync(command, [inspected.path], {
      cwd: wsReal,
      env,
      timeout: COLLECTOR_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      signal,
    });
    return String(result?.stdout ?? '').slice(0, MAX_RAW_STDOUT_CHARS);
  }

  function mutateItem(personId, slug, mutator) {
    const state = loadState();
    const row = state.items.find(item => item.personId === personId && item.slug === slug);
    if (!row) return null;
    mutator(row);
    saveState(state);
    return clone(row);
  }

  async function runDigestInternal({ personId, slug, force = false, signal } = {}) {
    if (!validId(personId) || !validSlug(slug)) fail('成员或日报标识无效。');
    const state = loadState();
    const item = state.items.find(row => row.personId === personId && row.slug === slug);
    if (!item) fail('未找到对应的定制日报方案。', 'custom_digest_not_found');

    const instant = clock();
    const today = dateInZone(instant, item.timeZone);
    const relativeDir = `reports/${item.slug}`;
    const relativePath = `${relativeDir}/${today}-wechat.txt`;
    const wsReal = ensureRealDir(item.workspacePath);
    const reportDir = ensureRealDir(join(wsReal, 'reports', item.slug));
    const targetFile = join(reportDir, `${today}-wechat.txt`);

    if (!force && item.lastGeneratedDate === today && existsSync(targetFile)) {
      try {
        const info = lstatSync(targetFile);
        if (!info.isSymbolicLink() && info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= 24_000) {
          const text = readFileSync(targetFile, 'utf8');
          if (text.trim()) {
            return { skipped: true, relativePath, bytes: Buffer.byteLength(text, 'utf8'), text };
          }
        }
      } catch {}
    }

    let rawMaterial = '';
    try {
      if (item.collectorScript) {
        rawMaterial = await executeCollector(item, today, targetFile, signal);
      }

      let finalText = '';
      const scriptProducedFile = item.collectorScript && !item.editorialPrompt?.trim() && existsSync(targetFile);
      if (scriptProducedFile) {
        const info = lstatSync(targetFile);
        if (!info.isSymbolicLink() && info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= MAX_SCRIPT_FILE_BYTES) {
          finalText = utf8Truncate(readFileSync(targetFile, 'utf8'), MAX_OUTPUT_BYTES);
        }
      }

      if (!finalText) {
        if (typeof synthesize !== 'function') fail('日报编辑合成服务尚未就绪。', 'custom_digest_synthesizer_unavailable');
        const drafted = await synthesize({
          title: item.title,
          today,
          timeZone: item.timeZone,
          editorialPrompt: item.editorialPrompt,
          rawMaterial,
          recentHeadlines: item.recentHeadlines ?? [],
          model: item.model ?? null,
          signal,
        });
        if (typeof drafted !== 'string' || !drafted.trim()) fail('日报正文生成结果为空。', 'custom_digest_empty_output');
        finalText = utf8Truncate(drafted, MAX_OUTPUT_BYTES);
      }

      writeAtomicReport(reportDir, `${today}-wechat.txt`, finalText + '\n');
      const headlines = extractHeadlines(finalText, today);
      mutateItem(personId, slug, row => {
        row.lastGeneratedDate = today;
        row.lastRunAt = clock();
        row.lastStatus = 'succeeded';
        row.lastError = null;
        row.recentHeadlines = [...(row.recentHeadlines ?? []), ...headlines].slice(-28);
        row.updatedAt = row.lastRunAt;
      });
      return { skipped: false, relativePath, bytes: Buffer.byteLength(finalText + '\n', 'utf8'), text: finalText };
    } catch (error) {
      const message = String(error?.message ?? '日报生成失败').slice(0, 240);
      try {
        mutateItem(personId, slug, row => {
          row.lastRunAt = clock();
          row.lastStatus = 'failed';
          row.lastError = message;
          row.updatedAt = row.lastRunAt;
        });
      } catch {}
      throw error;
    }
  }

  return Object.freeze({
    save(spec = {}) {
      const {
        personId, slug, title, enabled = true, scheduleTime, scheduleDays = 'daily', timeZone,
        workspacePath, workspaceId = null, collectorScript = null, editorialPrompt = '', model = null,
      } = spec;
      if (!validId(personId)) fail('成员标识无效。');
      if (!validSlug(slug)) fail('日报英文短名须为 2-49 位小写字母、数字、连字符或下划线。');
      if (typeof title !== 'string' || !title.trim() || title.length > 120) fail('日报标题无效。');
      if (typeof enabled !== 'boolean') fail('启用状态必须为布尔值。');
      if (!validClock(scheduleTime)) fail('推送时间须为 HH:MM 24小时格式。');
      if (!['daily', 'workdays'].includes(scheduleDays)) fail('推送周期须为 daily 或 workdays。');
      if (!validZone(timeZone)) fail('时区格式无效。');
      if (typeof workspacePath !== 'string' || !isAbsolute(workspacePath)) fail('工作区绝对路径无效。');
      const wsReal = ensureRealDir(workspacePath);
      let validatedScript = null;
      if (collectorScript !== null && collectorScript !== undefined && collectorScript !== '') {
        validatedScript = validateRelativePath(collectorScript, { extensions: /\.(?:mjs|js|py)$/iu });
        if (!validatedScript) fail('采集脚本须为工作区内的相对路径（.mjs / .js / .py）。');
        inspectConfinedTarget(wsReal, validatedScript, { expectFile: true });
      }
      if (typeof editorialPrompt !== 'string' || editorialPrompt.length > 12_000) fail('编辑要求长度超出限制。');
      const trimmedPrompt = editorialPrompt.trim();
      if (!validatedScript && !trimmedPrompt) fail('采集脚本和编辑要求至少须填写一项。');
      const cleanModel = typeof model === 'string' && model.trim().length <= 120 ? model.trim() : null;

      const instant = clock();
      const state = loadState();
      const index = state.items.findIndex(row => row.personId === personId && row.slug === slug);
      const existing = index >= 0 ? state.items[index] : null;
      const record = {
        personId,
        slug,
        title: title.trim(),
        enabled,
        scheduleTime,
        scheduleDays,
        timeZone,
        workspacePath: wsReal,
        workspaceId: typeof workspaceId === 'string' && workspaceId ? workspaceId : (existing?.workspaceId ?? null),
        collectorScript: validatedScript,
        editorialPrompt: trimmedPrompt,
        model: cleanModel ?? existing?.model ?? null,
        lastGeneratedDate: existing?.lastGeneratedDate ?? null,
        lastRunAt: existing?.lastRunAt ?? null,
        lastStatus: existing?.lastStatus ?? null,
        lastError: existing?.lastError ?? null,
        recentHeadlines: existing?.recentHeadlines ?? [],
        updatedAt: instant,
      };
      if (index >= 0) state.items[index] = record;
      else state.items.push(record);
      saveState(state);
      return clone(record);
    },

    updatePreferences({ personId, slug, appendNote, editorialPrompt, scheduleTime, scheduleDays, enabled, model } = {}) {
      if (!validId(personId)) fail('成员标识无效。');
      const state = loadState();
      const candidates = state.items.filter(row => row.personId === personId && (!slug || row.slug === slug));
      if (!candidates.length) fail('当前尚未建立定制简报方案，请先使用 save_schedule 创建。', 'custom_digest_not_found');
      const target = candidates[0];
      if (scheduleTime !== undefined) {
        if (!validClock(scheduleTime)) fail('推送时间须为 HH:MM 24小时格式。');
        target.scheduleTime = scheduleTime;
      }
      if (scheduleDays !== undefined) {
        if (!['daily', 'workdays'].includes(scheduleDays)) fail('推送周期须为 daily 或 workdays。');
        target.scheduleDays = scheduleDays;
      }
      if (typeof enabled === 'boolean') target.enabled = enabled;
      if (typeof model === 'string') target.model = model.trim() || null;
      if (typeof editorialPrompt === 'string' && editorialPrompt.trim()) {
        if (editorialPrompt.length > 12_000) fail('编辑要求长度超出限制。');
        target.editorialPrompt = editorialPrompt.trim();
      } else if (typeof appendNote === 'string' && appendNote.trim()) {
        const merged = `${target.editorialPrompt ? target.editorialPrompt + '\n\n' : ''}【用户追加偏好 ${clock().slice(0, 10)}】：${appendNote.trim()}`;
        target.editorialPrompt = merged.slice(-12_000);
      }
      target.updatedAt = clock();
      saveState(state);
      return clone(target);
    },

    pause({ personId, slug } = {}) {
      if (!validId(personId)) fail('成员标识无效。');
      if (slug !== undefined && !validSlug(slug)) fail('日报英文短名无效。');
      const state = loadState();
      const updated = [];
      const instant = clock();
      for (const row of state.items) {
        if (row.personId !== personId) continue;
        if (slug && row.slug !== slug) continue;
        row.enabled = false;
        row.updatedAt = instant;
        updated.push(clone(row));
      }
      if (updated.length) saveState(state);
      return updated;
    },

    get({ personId, slug } = {}) {
      if (!validId(personId) || !validSlug(slug)) return null;
      const row = loadState().items.find(item => item.personId === personId && item.slug === slug);
      return row ? clone(row) : null;
    },

    list({ personId } = {}) {
      const rows = loadState().items;
      return clone(personId ? rows.filter(item => item.personId === personId) : rows);
    },

    runDigest({ personId, slug, force = false, signal } = {}) {
      const key = `${personId}:${slug}`;
      if (inFlight.has(key)) return inFlight.get(key);
      const task = runDigestInternal({ personId, slug, force, signal }).finally(() => {
        if (inFlight.get(key) === task) inFlight.delete(key);
      });
      inFlight.set(key, task);
      return task;
    },

    async tick({ now: overrideNow, signal } = {}) {
      const instant = overrideNow ?? clock();
      const state = loadState();
      const results = [];
      for (const item of state.items.filter(row => row.enabled === true)) {
        if (signal?.aborted) break;
        try {
          if (item.scheduleDays === 'workdays' && !isWorkdayInZone(instant, item.timeZone)) continue;
          const today = dateInZone(instant, item.timeZone);
          const targetFile = join(item.workspacePath, 'reports', item.slug, `${today}-wechat.txt`);
          if (item.lastGeneratedDate === today && existsSync(targetFile)) continue;
          const [hh, mm] = item.scheduleTime.split(':').map(Number);
          const scheduleMin = hh * 60 + mm;
          const nowMin = minutesInZone(instant, item.timeZone);
          if (nowMin >= scheduleMin - 5 && nowMin <= scheduleMin + 120) {
            const outcome = await this.runDigest({ personId: item.personId, slug: item.slug, signal });
            results.push({ personId: item.personId, slug: item.slug, status: 'succeeded', ...outcome });
          }
        } catch (error) {
          results.push({ personId: item.personId, slug: item.slug, status: 'failed', error: String(error?.message ?? 'failed').slice(0, 160) });
        }
      }
      return results;
    },
  });
}
