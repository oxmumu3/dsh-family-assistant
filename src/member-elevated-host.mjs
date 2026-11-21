import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { installCollectorTemplate } from './digest-collectors.mjs';
import {
  autoSyncWorkspaceSharedSkills,
  readWorkspaceAgentsMd,
  summarizeWorkspaceSkills,
} from './member-skill-packs.mjs';

const DEFAULT_TIMEOUT_MS = 480_000;
const WAITING_NOTICE_MS = 45_000;
const POLL_MS = 350;
const MAX_MEMBER_FILE_BYTES = 10 * 1024 * 1024;
const SESSION_PREFIX = 'family_member_elevated_';

const RESTRICTED_TOOL_NAMES = [
  'ask_user_question',
  'family_assistant',
  'family_owner_projects',
  'invoke_subagent',
  'subagent',
  'spawn_agent',
  'delegate',
  'companion',
  'send_wechat',
  'sa_dispatch',
  'kb_board',
  'kb_card',
  'kb_create',
  'kb_export',
  'delivery_receipts',
  'evidence_ledger',
];

const PRIVATE_TOOL_PREFIX_RE = /^(?:family_|kb_|dot_|sa_|board_)/iu;

function isRestrictedToolName(name) {
  if (!name || name.startsWith('member_')) return false;
  return RESTRICTED_TOOL_NAMES.includes(name) || PRIVATE_TOOL_PREFIX_RE.test(name);
}

const FS_TOOL_NAMES = new Set([
  'read_file', 'write_file', 'edit_file', 'multi_edit', 'glob', 'grep',
  'ls', 'list_dir', 'list_directory', 'delete_file', 'move_file',
  'copy_file', 'mkdir', 'stat', 'view_file', 'create_file',
]);

const EXEC_TOOL_NAMES = new Set([
  'bash', 'shell', 'exec_command', 'terminal', 'run_command', 'execute_command',
]);

const PATH_ARG_KEYS = new Set([
  'path', 'file_path', 'filePath', 'target_file', 'targetFile',
  'directory', 'dir', 'cwd', 'workdir', 'workingDirectory', 'root',
  'source', 'source_path', 'sourcePath', 'dest', 'dest_path', 'destPath',
  'destination', 'target', 'file', 'filename', 'paths', 'files', 'directories',
]);

const COMMAND_ARG_KEYS = new Set(['command', 'cmd', 'script']);

const SENSITIVE_COMMAND_PATTERNS = [
  /(?:~\/|\$HOME\/|\$\{HOME\}\/|\/Users\/[^/\s"'`]+\/)(?:\.dsh|\.ssh|\.gnupg|\.aws|\.appstoreconnect|\.gemini|\.codex|\.claude|\.openclaw|\.kube|\.npmrc|\.netrc|\.gitconfig|Library\/Mobile\s*Documents|Library\/Keychains|Library\/LaunchAgents|Library\/LaunchDaemons|Library\/Application\s*Support|Desktop|Documents|Downloads|Pictures|Mail|Messages)/iu,
  /dsh-family-assistant|dsh-wechat|ag-wechat|asc-publish|superagent-ledger|family-toolbox|member-elevated-access|family\.json/iu,
  /\b(?:launchctl|crontab|osascript|sudo|su|security\s+(?:find-|dump-|unlock-)|sqlite3\b[^;\n]*(?:chat\.db|Messages|Keychain)|defaults\s+write)\b/iu,
  /(?:--remote-debugging-port|--user-data-dir|Google\/Chrome|chrome-devtools)/iu,
  /file:\/\/\//iu,
];

const SELF_SERVICE_TOOL_NAMES = new Set([
  'member_digest_service',
  'member_send_workspace_file',
  'member_reminder_service',
]);

function expandCandidatePath(raw, workspacePath) {
  let value = String(raw ?? '').trim();
  if (!value) return null;
  if (value.startsWith('file://')) {
    try {
      value = decodeURIComponent(new URL(value).pathname);
    } catch {
      return null;
    }
  }
  if (value === '~' || value.startsWith('~/')) {
    value = join(homedir(), value.slice(1));
  }
  if (value.includes('$HOME') || value.includes('${HOME}')) {
    value = value.replace(/\$\{?HOME\}?/g, homedir());
  }
  return isAbsolute(value) ? resolve(value) : resolve(workspacePath, value);
}

function insideRoot(root, candidate) {
  const realRoot = realpathSync(root);
  const diff = relative(realRoot, candidate);
  return diff === '' || (!isAbsolute(diff) && diff !== '..' && !diff.startsWith('../'));
}

function resolveWithExistingAncestor(resolvedPath) {
  let current = resolvedPath;
  const missingParts = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    missingParts.unshift(relative(parent, current));
    current = parent;
  }
  try {
    const st = lstatSync(current);
    if (st.isSymbolicLink() && !missingParts.length) {
      return realpathSync(current);
    }
    const realAncestor = realpathSync(current);
    return missingParts.length ? join(realAncestor, ...missingParts) : realAncestor;
  } catch {
    return null;
  }
}

/**
 * 判断候选路径是否严格落在成员隔离工作区（或标准 /tmp 临时目录）内。
 * 先解析最深已有真实祖先路径，防止通过符号链接或 `..` 逃逸。
 */
export function isPathConfinedToWorkspace(candidatePath, workspacePath) {
  if (typeof candidatePath !== 'string' || !candidatePath.trim() || /[\x00-\x1f\x7f]/u.test(candidatePath)) {
    return false;
  }
  if (typeof workspacePath !== 'string' || !workspacePath.trim()) return false;
  let realWorkspace;
  try {
    realWorkspace = realpathSync(workspacePath);
  } catch {
    return false;
  }
  const expanded = expandCandidatePath(candidatePath, realWorkspace);
  if (!expanded) return false;
  const resolved = resolveWithExistingAncestor(expanded);
  if (!resolved) return false;
  if (insideRoot(realWorkspace, resolved)) return true;
  for (const tmpBase of ['/tmp', '/private/tmp']) {
    try {
      if (existsSync(tmpBase) && insideRoot(realpathSync(tmpBase), resolved)) return true;
    } catch {}
  }
  return false;
}

function collectObjectIssues(value, execName, workspacePath, depth = 0) {
  if (depth > 5 || value === null || value === undefined || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const issue = collectObjectIssues(item, execName, workspacePath, depth + 1);
      if (issue) return issue;
    }
    return null;
  }
  if (value.sandboxPermissions === 'require_escalated' || value.sandbox_permissions === 'require_escalated') {
    return '临时高权限模式只能在当前隔离工作区内执行，不允许提权到沙箱之外。';
  }
  if (value.mode === 'danger-full-access' || value.sandboxMode === 'danger-full-access' || value.dangerouslyDisableSandbox === true) {
    return '临时高权限模式不允许关闭文件沙箱。';
  }

  for (const [key, entry] of Object.entries(value)) {
    if (SELF_SERVICE_TOOL_NAMES.has(execName)) continue;

    if (PATH_ARG_KEYS.has(key)) {
      const items = Array.isArray(entry) ? entry : [entry];
      for (const item of items) {
        if (typeof item === 'string' && !isPathConfinedToWorkspace(item, workspacePath)) {
          return '访问路径超出你的隔离工作区范围，已拦截。';
        }
      }
    }

    if (key === 'pattern' && typeof entry === 'string' && (entry.startsWith('/') || entry.startsWith('~') || entry.includes('$HOME') || entry.includes('..'))) {
      if (!isPathConfinedToWorkspace(entry, workspacePath)) {
        return '搜索路径模板超出你的隔离工作区范围，已拦截。';
      }
    }

    if (key === 'url' && typeof entry === 'string' && /^file:/i.test(entry.trim())) {
      return '不允许通过 URL 读取本机文件。';
    }

    if ((COMMAND_ARG_KEYS.has(key) || EXEC_TOOL_NAMES.has(execName)) && typeof entry === 'string') {
      if (SENSITIVE_COMMAND_PATTERNS.some(pattern => pattern.test(entry))) {
        return '命令涉及宿主系统或私人敏感目录，已在安全护栏拦截。';
      }
    }

    if (entry && typeof entry === 'object') {
      const nested = collectObjectIssues(entry, execName, workspacePath, depth + 1);
      if (nested) return nested;
    }
  }

  if (FS_TOOL_NAMES.has(execName) && typeof value.path === 'string' && !isPathConfinedToWorkspace(value.path, workspacePath)) {
    return '文件工具访问路径超出当前隔离工作区。';
  }
  return null;
}

/**
 * 校验临时高权限成员原生会话的每一次工具调用（tools/pre-execute 守卫）。
 * 返回 undefined 表示放行；返回中文原因字符串表示拒绝。
 */
export function checkElevatedToolExecution(exec, grant) {
  if (!grant || grant.active !== true) {
    return '临时高权限未生效、已到期或已被 Owner 收回，本次操作已停止。';
  }
  const execName = String(exec?.name ?? '');
  if (isRestrictedToolName(execName)) {
    return '当前成员高权限会话不可调用主人私人插件或交互阻塞工具。';
  }
  const issue = collectObjectIssues(exec?.arguments, execName, grant.workspacePath);
  if (issue) return issue;
  return undefined;
}

function inspectWorkspaceRelativeFile(workspacePath, relativePath, { maxBytes = MAX_MEMBER_FILE_BYTES } = {}) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || relativePath.length > 512) {
    throw new Error('文件路径无效。');
  }
  const clean = relativePath.trim();
  if (isAbsolute(clean) || /[\\\x00-\x1f\x7f]/u.test(clean)) throw new Error('请使用工作区内的相对路径。');
  const parts = clean.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error('文件路径不能包含上层目录或隐藏段。');
  }
  const wsReal = realpathSync(workspacePath);
  let cur = wsReal;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    if (!existsSync(cur)) throw new Error('指定的文件不存在：' + clean);
    const st = lstatSync(cur);
    const isFinal = i === parts.length - 1;
    if (st.isSymbolicLink()) throw new Error('安全策略禁止发送符号链接文件。');
    if (isFinal && (!st.isFile() || st.nlink !== 1)) throw new Error('只能发送工作区内的普通文件。');
    if (!isFinal && !st.isDirectory()) throw new Error('路径上级不是有效目录。');
  }
  const realFile = realpathSync(cur);
  if (!insideRoot(wsReal, realFile)) throw new Error('文件路径超出工作区范围。');
  const stat = lstatSync(realFile);
  if (stat.size <= 0 || stat.size > maxBytes) throw new Error('文件为空或超过 10MB 限制。');
  const name = parts.at(-1);
  if (!/\.(?:md|txt|csv|json|pdf|docx|pptx|xlsx|html|png|jpg|jpeg|webp|svg)$/iu.test(name)) {
    throw new Error('仅支持发送 md/txt/csv/json/pdf/docx/pptx/xlsx/html/png/jpg/jpeg/webp/svg 文档与图片。');
  }
  const isImage = /\.(?:png|jpg|jpeg|webp)$/iu.test(name);
  return { relativePath: clean, absolutePath: realFile, name, isImage, bytes: readFileSync(realFile) };
}

function buildElevatedPrompt({ person, grant, persona = 'pro_peer', sharedSkillsDir = null, text, attachments = [] }) {
  const tz = person.timeZone || 'Asia/Shanghai';
  const localNow = new Date().toLocaleString('zh-CN', { timeZone: tz, hour12: false });
  const attachedNote = attachments.length
    ? `\n\n对方本次随消息发来的文件已保存到你的工作区：\n${attachments.map(p => '- ' + p).join('\n')}`
    : '';
  const modeDesc = grant.permanent
    ? '常驻独立沙箱专业席位（长期有效）'
    : `独立沙箱自助高权限（有效期至 ${grant.expiresAt}）`;
  const agentsMd = grant.workspacePath ? readWorkspaceAgentsMd(grant.workspacePath).trim() : '';
  const installedSkills = grant.workspacePath ? summarizeWorkspaceSkills(grant.workspacePath, { sharedSkillsDir }) : [];
  const blocks = [
    `【乐乐 · 专属独立沙箱 Agent 席位】你正在微信上直接服务「${person.label}」（${tz}，当前当地时间 ${localNow}，当前模式：${modeDesc}）。`,
    `你的能力边界与武器库：你可以直接读写专属工作区「${grant.workspacePath}」、联网深度检索与抓取中英文公开权威资讯/公告、在 scripts/ 中编写或安装多源采集脚本、用 member_digest_service（支持内置模板 template="crossborder_ma" 跨境并购多源采集或 "topic_radar" 行业雷达、save_schedule 建定时、update_preferences 随时追加修改偏好口径、run_now 立即试跑推送）搭建和持续调教每日自动简报、用 member_send_workspace_file 直接把生成的 Word/Excel/CSV/PDF/HTML/Markdown 报告或 PNG/JPG 图表图片发到他微信、用 member_reminder_service 为他安排或管理微信提醒。`,
    `重要大管家原则：\n1. 只给结果、绝不甩锅或讲内部黑话：微信那头的「${person.label}」不需要知道任何终端、脚本、工具名、sessionId 或权限分层；绝不要让他自己去电脑执行操作，也不要回复空洞的框架敷衍——他要日报或调研，你就当场拉取真实可核实信源把干货做出来并配好定时。\n2. 真实溯源与持续调教：所有交易、数据、监管动态必须标注真实来源媒体，拿不到的如实写“未获取到可核实公开披露”，严禁编造；当对方回复修改意见（如调整金额门槛、重点区域、工作日/每日推送时间）时，立即调用 member_digest_service(op="update_preferences") 落盘生效。\n3. 微信阅读友好与去重：分段清晰、重点突出、不用冗余代码块；若已通过 member_digest_service(deliverNow=true) 或 member_send_workspace_file 将完整正文/文档发至微信，本轮回复只需简洁说明亮点与可微调项，不要把几千字全文重复粘第二遍（不要调用阻塞式弹窗提问工具，如需确认 1-2 个偏好直接在微信文字末尾轻问一句）。\n4. 严禁访问或提及工作区之外的宿主或主人私人目录、密钥与配置。`,
  ];
  if (persona === 'elder_care') {
    blocks.push('【长辈服务沟通风格提示】面对长辈回复请用温暖、耐心、大白话、分步讲清重点的口吻（避免生硬英文缩写与技术术语）；但底层查资料、算数据、做简报、画图、做文档等全部满血工具与技能包请照常全力使用，绝不降档敷衍。');
  }
  if (agentsMd) {
    blocks.push(`【专属背景与工作口径（AGENTS.md）】\n${agentsMd.slice(0, 3500)}`);
  }
  if (installedSkills.length) {
    blocks.push(
      `【当前工作区已装备专业能力包（执行对应深度分析、路演稿、一页纸或长文任务前，请先用 read_file 阅读相应 SKILL.md 再动手）】\n`
      + installedSkills.map(s => `- ${s.title}（${s.relativePath}）：${s.description}`).join('\n'),
    );
  }
  blocks.push(`${person.label}本轮发来的原话：\n${text}${attachedNote}`);
  return blocks.join('\n\n');
}

export function extractTurnOutcome(records, { rpcId, minTurn = 0 } = {}) {
  if (!Array.isArray(records)) return { found: false, ended: false, text: '', turn: null, terminalReason: null };
  const events = [];
  for (const record of records) {
    const event = record?.event;
    if (record?.type !== 'event' || !event || typeof event.type !== 'string') continue;
    events.push(event);
  }
  if (events.every(event => Number.isSafeInteger(event.seq))) {
    events.sort((a, b) => a.seq - b.seq);
  }

  let currentTurn = null;
  let targetTurn = null;
  let sawAnyRpcId = false;
  const turnFallbackCandidates = [];

  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === 'turn/start') {
      currentTurn = data.turn ?? currentTurn;
      if (Number.isSafeInteger(currentTurn) && currentTurn > minTurn) turnFallbackCandidates.push(currentTurn);
    }
    const turn = data.turn ?? currentTurn;
    if (event.type === 'user/message') {
      const eventRpc = data.source?.rpcId ?? data.requestId ?? null;
      if (typeof eventRpc === 'string' && eventRpc) sawAnyRpcId = true;
      if (rpcId && eventRpc === rpcId && turn !== null && turn !== undefined) {
        targetTurn = turn;
      }
    }
    if (event.type === 'turn/end' && turn === currentTurn) {
      currentTurn = null;
    }
  }

  if (targetTurn === null && !sawAnyRpcId && turnFallbackCandidates.length) {
    targetTurn = turnFallbackCandidates.at(-1);
  }

  if (targetTurn === null) {
    return { found: false, ended: false, text: '', turn: null, terminalReason: null };
  }

  let ended = false;
  let terminalReason = null;
  const texts = [];
  let streamTurn = null;
  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === 'turn/start') streamTurn = data.turn ?? streamTurn;
    const turn = data.turn ?? streamTurn;
    if (turn === targetTurn && event.type === 'assistant/message' && data.interrupted !== true) {
      const parts = Array.isArray(data.message?.content) ? data.message.content : [];
      const joined = parts.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n').trim();
      if (joined) texts.push(joined);
    }
    if (turn === targetTurn && event.type === 'turn/end') {
      ended = true;
      terminalReason = data.reason?.kind ?? 'completed';
    }
    if (event.type === 'turn/end' && turn === streamTurn) streamTurn = null;
  }

  return {
    found: true,
    ended,
    text: texts.at(-1) ?? '',
    turn: targetTurn,
    terminalReason,
  };
}

/**
 * 成员临时高权限原生宿主桥梁：
 * - 对 `family_member_elevated_*` 会话同步安装：Seatbelt `workspace-write` 沙箱、
 *   路径/命令白名单守卫、`approval/request` 有界自动放行、以及 `member_digest_service`
 *   和 `member_send_workspace_file` 自助工具。
 * - 按真实 `turn/end` 观测多步工具调用回合，不因首句中间态发言提前截断。
 */
export function createMemberElevatedHost({
  access,
  customDigests,
  getPerson,
  getBindingGeneration,
  isRouteCurrent,
  assignMemberDigest,
  disableMemberDigestSchedule,
  deliverMemberDigestNow,
  currentDigestSchedule,
  deliverMemberFile,
  manageMemberReminder,
  getWorkspaceController,
  getSessionController,
  getAgents,
  sharedSkillsDir = null,
  getPersona = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  waitingNoticeMs = WAITING_NOTICE_MS,
  pollMs = POLL_MS,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  nowMs = () => Date.now(),
  now = () => new Date().toISOString(),
} = {}) {
  const attachedScopes = new Map();
  const activeRuns = new Map();
  let closed = false;

  const isElevatedSessionId = id => typeof id === 'string' && id.startsWith(SESSION_PREFIX);

  function resolveActiveGrant(sessionId) {
    if (closed || !isElevatedSessionId(sessionId)) return null;
    return access.sessionOwner(sessionId, { at: now(), getBindingGeneration });
  }

  function scopedToolsFor(grant) {
    const tools = [];
    tools.push({
      name: 'member_digest_service',
      description: '配置、持续调教偏好、立即试跑推送、查看或暂停当前成员的专属定制简报（如跨境并购日报）。支持一键安装内置多源实盘采集器（template="crossborder_ma" 或 "topic_radar"）或指定自写脚本，并支持随时用 update_preferences 追加或修改口径、时间与工作日排期。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: { type: 'string', enum: ['status', 'save_schedule', 'update_preferences', 'run_now', 'pause'] },
          slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{1,48}$' },
          title: { type: 'string', maxLength: 120 },
          scheduleTime: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
          scheduleDays: { type: 'string', enum: ['daily', 'workdays'] },
          timeZone: { type: 'string', maxLength: 100 },
          template: { type: 'string', enum: ['crossborder_ma', 'topic_radar'] },
          keywords: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 80 } },
          collectorScript: { type: 'string', maxLength: 512 },
          editorialPrompt: { type: 'string', maxLength: 12000 },
          appendNote: { type: 'string', maxLength: 4000 },
          model: { type: 'string', maxLength: 120 },
          deliverNow: { type: 'boolean' },
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      async execute(args, execution) {
        execution?.signal?.throwIfAborted();
        const liveGrant = resolveActiveGrant(execution?.agent?.id ?? grant.sessionId);
        if (!liveGrant) throw new Error('当前席位沙箱权限未生效或已收回。');
        const personId = liveGrant.personId;
        const person = typeof getPerson === 'function' ? getPerson(personId) : null;
        const defaultTz = person?.timeZone || 'Asia/Shanghai';

        if (args.op === 'status') {
          const items = customDigests.list({ personId });
          const schedule = typeof currentDigestSchedule === 'function' ? currentDigestSchedule(personId) : null;
          const payload = { status: 'completed', items, schedule };
          return { ...payload, text: JSON.stringify(payload) };
        }

        if (args.op === 'pause') {
          const paused = customDigests.pause({ personId, ...(args.slug ? { slug: args.slug } : {}) });
          if (typeof disableMemberDigestSchedule === 'function') {
            await disableMemberDigestSchedule({ personId });
          }
          const payload = { status: 'completed', pausedCount: paused.length, text: paused.length ? `已暂停 ${paused.length} 项定制日报的每日自动生成与推送。` : '当前没有启用的定制日报。' };
          return payload;
        }

        if (args.op === 'update_preferences') {
          const updated = customDigests.updatePreferences({
            personId,
            ...(args.slug ? { slug: args.slug } : {}),
            ...(args.appendNote ? { appendNote: args.appendNote } : {}),
            ...(args.editorialPrompt ? { editorialPrompt: args.editorialPrompt } : {}),
            ...(args.scheduleTime ? { scheduleTime: args.scheduleTime } : {}),
            ...(args.scheduleDays ? { scheduleDays: args.scheduleDays } : {}),
            ...(args.model ? { model: args.model } : {}),
            enabled: true,
          });
          if (args.scheduleTime && liveGrant.workspaceId && typeof assignMemberDigest === 'function') {
            const today = new Intl.DateTimeFormat('en-CA', { timeZone: updated.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now()));
            await assignMemberDigest({
              personId,
              workspaceId: liveGrant.workspaceId,
              relativePath: `reports/${updated.slug}/${today}-wechat.txt`,
              scheduleTime: updated.scheduleTime,
              timeZone: updated.timeZone,
            });
          }
          let regenerated = null;
          let delivery = null;
          if (args.deliverNow === true) {
            regenerated = await customDigests.runDigest({ personId, slug: updated.slug, force: true, signal: execution?.signal });
            if (typeof deliverMemberDigestNow === 'function') {
              delivery = await deliverMemberDigestNow({ personId, requestId: 'elevated-upd-' + randomUUID() });
            }
          }
          return {
            status: 'completed',
            digest: updated,
            deliveredToWechat: delivery?.deliveryStatus === 'api_accepted',
            text: `已更新「${updated.title}」偏好与排期（${updated.scheduleDays === 'workdays' ? '工作日' : '每日'} ${updated.scheduleTime} ${updated.timeZone}）。${regenerated ? `\n已按新口径重新生成（${regenerated.bytes} 字节）。` : ''}`,
          };
        }

        if (args.op === 'run_now') {
          const items = customDigests.list({ personId });
          const slug = args.slug || (items.length === 1 ? items[0].slug : null);
          if (!slug) throw new Error('请指明要试跑的日报英文短名（slug）。');
          const runResult = await customDigests.runDigest({ personId, slug, force: true, signal: execution?.signal });
          let delivery = null;
          if (args.deliverNow === true && typeof deliverMemberDigestNow === 'function') {
            delivery = await deliverMemberDigestNow({ personId, requestId: 'elevated-run-' + randomUUID() });
          }
          const delivered = delivery?.deliveryStatus === 'api_accepted';
          return {
            status: 'completed',
            slug,
            relativePath: runResult.relativePath,
            bytes: runResult.bytes,
            deliveredToWechat: delivered,
            deliveryStatus: delivery?.deliveryStatus ?? null,
            preview: runResult.text.slice(0, 6000),
            text: `已成功生成今日日报「${runResult.relativePath}」（${runResult.bytes} 字节）。${delivered ? '已同步提交到该成员微信推送队列（请勿在文本回复中再次重复粘贴全部正文）。' : '尚未主动推送微信；如需发给他试看可再次调用 run_now(deliverNow=true) 或在回复中给出精华预览。'}\n\n预览：\n${runResult.text.slice(0, 4000)}`,
          };
        }

        if (args.op === 'save_schedule') {
          if (!args.slug || !args.title || !args.scheduleTime) {
            throw new Error('保存定时日报需要提供 slug、title 和 scheduleTime（HH:MM）。');
          }
          if (!liveGrant.workspaceId) {
            throw new Error('成员独立工作区尚未完成宿主登记，请稍后重试。');
          }
          let collectorScript = args.collectorScript ?? null;
          if (!collectorScript && args.template) {
            const installed = installCollectorTemplate({
              workspacePath: liveGrant.workspacePath,
              template: args.template,
              slug: args.slug,
              keywords: args.keywords ?? [],
            });
            collectorScript = installed.relativePath;
          }
          const timeZone = args.timeZone || defaultTz;
          const saved = customDigests.save({
            personId,
            slug: args.slug,
            title: args.title,
            enabled: true,
            scheduleTime: args.scheduleTime,
            scheduleDays: args.scheduleDays || 'daily',
            timeZone,
            workspacePath: liveGrant.workspacePath,
            workspaceId: liveGrant.workspaceId,
            collectorScript,
            editorialPrompt: args.editorialPrompt ?? '',
            model: args.model ?? null,
          });
          const generated = await customDigests.runDigest({ personId, slug: saved.slug, force: false, signal: execution?.signal });
          if (typeof assignMemberDigest === 'function') {
            await assignMemberDigest({
              personId,
              workspaceId: liveGrant.workspaceId,
              relativePath: generated.relativePath,
              scheduleTime: saved.scheduleTime,
              timeZone: saved.timeZone,
            });
          }
          let delivery = null;
          if (args.deliverNow === true && typeof deliverMemberDigestNow === 'function') {
            delivery = await deliverMemberDigestNow({ personId, requestId: 'elevated-sample-' + randomUUID() });
          }
          const delivered = delivery?.deliveryStatus === 'api_accepted';
          return {
            status: 'completed',
            digest: saved,
            relativePath: generated.relativePath,
            deliveredToWechat: delivered,
            deliveryStatus: delivery?.deliveryStatus ?? null,
            preview: generated.text.slice(0, 6000),
            text: `已保存并启用「${saved.title}」（${saved.scheduleDays === 'workdays' ? '工作日' : '每日'} ${saved.scheduleTime} ${saved.timeZone}，输出路径 ${generated.relativePath}）。${delivered ? '首期样例也已提交至微信推送队列。' : ''}\n\n首期内容预览：\n${generated.text.slice(0, 4000)}`,
          };
        }

        throw new Error('不支持的 member_digest_service 操作。');
      },
    });

    tools.push({
      name: 'member_send_workspace_file',
      description: '把你隔离工作区里生成好的完整文档或图片（.md/.txt/.csv/.json/.pdf/.docx/.pptx/.xlsx/.html/.png/.jpg/.jpeg/.webp/.svg，其中图片将自动作为微信原图发送）直接发到该成员的微信聊天中。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['relativePath'],
        properties: {
          relativePath: { type: 'string', maxLength: 512 },
          caption: { type: 'string', maxLength: 500 },
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      async execute(args, execution) {
        execution?.signal?.throwIfAborted();
        const liveGrant = resolveActiveGrant(execution?.agent?.id ?? grant.sessionId);
        if (!liveGrant) throw new Error('当前席位沙箱权限未生效或已收回。');
        if (typeof deliverMemberFile !== 'function') throw new Error('当前通道不支持发送文件附件。');
        const file = inspectWorkspaceRelativeFile(liveGrant.workspacePath, args.relativePath);
        const receipt = await deliverMemberFile({
          personId: liveGrant.personId,
          name: file.name,
          bytes: file.bytes,
          isImage: file.isImage,
          caption: typeof args.caption === 'string' ? args.caption.trim() : '',
          signal: execution?.signal,
        });
        const kindWord = file.isImage ? '图片' : '文件';
        return {
          status: receipt?.status ?? 'unknown',
          relativePath: file.relativePath,
          name: file.name,
          isImage: file.isImage,
          bytes: file.bytes.length,
          text: receipt?.status === 'api_accepted'
            ? `已把工作区${kindWord}「${file.name}」提交到微信${kindWord}发送接口。`
            : `工作区${kindWord}「${file.name}」发送尚未确认（状态：${receipt?.status ?? 'unknown'}）。`,
        };
      },
    });

    tools.push({
      name: 'member_reminder_service',
      description: '为当前微信成员本人查询、创建或取消定时微信提醒（只能操作本人自己的提醒）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: { type: 'string', enum: ['list', 'add', 'cancel'] },
          text: { type: 'string', maxLength: 1000 },
          dueAt: { type: 'string', maxLength: 80 },
          repeat: { type: 'string', enum: ['once', 'daily'] },
          time: { type: 'string', maxLength: 10 },
          reminderId: { type: 'string', maxLength: 100 },
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      async execute(args, execution) {
        execution?.signal?.throwIfAborted();
        const liveGrant = resolveActiveGrant(execution?.agent?.id ?? grant.sessionId);
        if (!liveGrant) throw new Error('当前席位沙箱权限未生效或已收回。');
        if (typeof manageMemberReminder !== 'function') throw new Error('提醒服务暂不可用。');
        return manageMemberReminder({ personId: liveGrant.personId, ...args });
      },
    });

    return tools;
  }

  /**
   * 同步挂载成员高权限会话作用域。绝不使用 await，避免抢输第一轮工具准备。
   */
  function attachAgent(agent) {
    if (closed || !agent || !isElevatedSessionId(agent.id)) return false;
    if (attachedScopes.has(agent.id)) return true;

    const grant = resolveActiveGrant(agent.id);
    const disposers = [];

    if (typeof agent.session?.append === 'function') {
      try {
        if (agent.session?.projections?.values?.sandboxMode !== 'workspace-write') {
          agent.session.append('sandbox/mode', { mode: 'workspace-write' });
        }
      } catch {}
    }

    const scopedTools = agent.ctx?.get?.('tools', false);
    if (scopedTools) {
      if (typeof scopedTools.definitions === 'function' && typeof scopedTools.restrict === 'function') {
        try {
          const present = (scopedTools.definitions(agent) ?? []).map(def => def?.name).filter(Boolean);
          const toDeny = [...new Set(present.filter(isRestrictedToolName))];
          if (toDeny.length) disposers.push(scopedTools.restrict({ deny: toDeny }));
        } catch {}
      }
      if (typeof scopedTools.guard === 'function') {
        try {
          disposers.push(scopedTools.guard(exec => checkElevatedToolExecution(exec, resolveActiveGrant(agent.id))));
        } catch {}
      }
      if (typeof scopedTools.register === 'function' && grant) {
        for (const def of scopedToolsFor(grant)) {
          try { disposers.push(scopedTools.register(def)); } catch {}
        }
      }
    }

    if (typeof agent.ctx?.on === 'function') {
      try {
        const offApproval = agent.ctx.on('approval/request', (req, next) => {
          if (!req?.agent || req.agent.id !== agent.id) return next();
          const liveGrant = resolveActiveGrant(agent.id);
          if (!liveGrant) return Promise.resolve('rejected');
          const reasonText = [req.reason, req.displayReason?.en, req.displayReason?.['zh-CN']].filter(Boolean).join(' ');
          if (/danger-full-access|outside.*workspace|require_escalated|\/\.ssh|\/\.dsh/iu.test(reasonText)) {
            return Promise.resolve('rejected');
          }
          return Promise.resolve('allowed-once');
        }, { prepend: true });
        if (typeof offApproval === 'function') disposers.push(offApproval);
      } catch {}
    }

    attachedScopes.set(agent.id, { agent, disposers });
    return true;
  }

  function detachAgent(agent) {
    const id = typeof agent === 'string' ? agent : agent?.id;
    const entry = id ? attachedScopes.get(id) : null;
    if (!entry) return;
    attachedScopes.delete(id);
    for (const dispose of entry.disposers) {
      try { void dispose?.(); } catch {}
    }
  }

  async function ensureWorkspace(grant, { signal } = {}) {
    const wc = typeof getWorkspaceController === 'function' ? getWorkspaceController() : null;
    if (!wc) return grant.workspaceId ? { workspaceId: grant.workspaceId, path: grant.workspacePath, sessionIds: [] } : null;
    const created = await wc.create({ path: grant.workspacePath }, signal);
    const workspace = created?.workspace ?? created;
    if (!workspace?.workspaceId) throw new Error('成员隔离工作区注册失败。');
    access.setWorkspaceId(grant.personId, workspace.workspaceId);
    grant.workspaceId = workspace.workspaceId;
    return workspace;
  }

  async function ensureSession(grant, workspace, { signal } = {}) {
    const sc = typeof getSessionController === 'function' ? getSessionController() : null;
    const agents = typeof getAgents === 'function' ? getAgents() : null;
    if (sc && workspace) {
      const existing = Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(grant.sessionId);
      if (!existing && typeof sc.create === 'function') {
        try {
          await sc.create({ workspaceId: workspace.workspaceId, sessionId: grant.sessionId }, signal);
        } catch (error) {
          if (!/already exists/iu.test(String(error?.message ?? ''))) throw error;
        }
      }
      const liveAgent = agents?.get?.(grant.sessionId);
      if (liveAgent) attachAgent(liveAgent);
      return;
    }
    if (typeof agents?.create === 'function') {
      const live = agents.get?.(grant.sessionId);
      if (live) {
        attachAgent(live);
        return;
      }
      const handle = await agents.create({ sessionId: grant.sessionId, meta: { cwd: grant.workspacePath }, ...(signal ? { signal } : {}) });
      if (handle?.agent) attachAgent(handle.agent);
      return;
    }
    throw new Error('当前宿主尚未提供成员高权限原生会话控制器。');
  }

  async function readSessionRecords(sessionId, signal) {
    const sc = typeof getSessionController === 'function' ? getSessionController() : null;
    if (!sc) throw new Error('宿主 sessionController 不可用。');
    const addr = { address: { kind: 'session', sessionId }, maxMessages: 128, turnWindow: { minMessages: 32, minTurns: 8 } };
    if (typeof sc.follow === 'function') {
      const iterator = sc.follow(addr, signal)[Symbol.asyncIterator]();
      try {
        const first = await iterator.next();
        const snapshot = first.value;
        if (!first.done && snapshot?.type === 'snapshot' && Array.isArray(snapshot.records)) {
          return snapshot.records;
        }
      } finally {
        void Promise.resolve(iterator.return?.()).catch(() => {});
      }
    }
    if (typeof sc.page === 'function') {
      const page = await sc.page(addr, signal);
      return Array.isArray(page?.records) ? page.records : [];
    }
    return [];
  }

  async function runTurn({ person, route, text, attachments = [], onWaiting, signal } = {}) {
    if (closed) throw new Error('家庭助手服务已关闭。');
    const grant = access.get(person.id, { at: now(), bindingGeneration: route.generation });
    if (!grant || !grant.active) throw new Error('成员临时高权限未生效或已到期。');

    const workspace = await ensureWorkspace(grant, { signal });
    await ensureSession(grant, workspace, { signal });
    try { autoSyncWorkspaceSharedSkills({ workspacePath: grant.workspacePath, sharedSkillsDir }); } catch {}

    let beforeMaxTurn = 0;
    try {
      const initialRecords = await readSessionRecords(grant.sessionId, signal);
      for (const rec of initialRecords) {
        const turnVal = rec?.event?.data?.turn;
        if (Number.isSafeInteger(turnVal) && turnVal > beforeMaxTurn) beforeMaxTurn = turnVal;
      }
    } catch {}

    const sc = typeof getSessionController === 'function' ? getSessionController() : null;
    if (!sc?.prompt) throw new Error('宿主 sessionController.prompt 不可用。');
    const rpcId = randomUUID();
    const persona = typeof getPersona === 'function' ? (getPersona(person.id) || 'elder_care') : 'pro_peer';
    const promptText = buildElevatedPrompt({ person, grant, persona, sharedSkillsDir, text, attachments });

    const receipt = await sc.prompt({
      sessionId: grant.sessionId,
      requestId: rpcId,
      mode: 'queue',
      content: [{ type: 'text', text: promptText }],
    }, signal);
    if (receipt?.accepted !== true) throw new Error('宿主拒绝了本轮高权限请求提交。');

    const existing = getAgents?.()?.get?.(grant.sessionId);
    if (existing) attachAgent(existing);

    const startedAt = nowMs();
    const deadline = startedAt + timeoutMs;
    let notifiedWaiting = false;
    activeRuns.set(person.id, { sessionId: grant.sessionId, rpcId, startedAt });

    try {
      for (;;) {
        if (closed || signal?.aborted) throw new Error('本轮处理已取消。');
        const stillAllowed = access.isActive(person.id, { at: now(), bindingGeneration: route.generation })
          && (typeof isRouteCurrent !== 'function' || isRouteCurrent(route) === true);
        if (!stillAllowed) {
          await cancel(person.id);
          throw new Error('临时高权限已被收回或连接已变化，本次处理已停止。');
        }

        const records = await readSessionRecords(grant.sessionId, signal);
        const outcome = extractTurnOutcome(records, { rpcId, minTurn: beforeMaxTurn });
        if (outcome.ended) {
          if (!outcome.text) throw new Error('高权限会话本轮结束但未产出有效文本回复。');
          return {
            text: outcome.text,
            sessionId: grant.sessionId,
            turn: outcome.turn,
            terminalReason: outcome.terminalReason,
          };
        }

        if (!notifiedWaiting && typeof onWaiting === 'function' && nowMs() - startedAt >= waitingNoticeMs) {
          notifiedWaiting = true;
          try { await onWaiting(); } catch {}
        }

        if (nowMs() >= deadline) {
          throw new Error('高权限会话处理超时，请稍后再试或让我查看进展。');
        }
        await sleep(pollMs);
      }
    } finally {
      const currentRun = activeRuns.get(person.id);
      if (currentRun?.rpcId === rpcId) activeRuns.delete(person.id);
    }
  }

  async function cancel(personId) {
    const active = activeRuns.get(personId);
    const grant = access.get(personId, { at: now() });
    const sessionId = active?.sessionId ?? grant?.sessionId;
    if (!sessionId) return { accepted: false };
    let invoked = false;
    const agent = getAgents?.()?.get?.(sessionId);
    if (typeof agent?.cancel === 'function') {
      try { agent.cancel({ kind: 'user' }); invoked = true; } catch {}
    }
    const sc = typeof getSessionController === 'function' ? getSessionController() : null;
    if (typeof sc?.cancel === 'function') {
      try { await sc.cancel({ sessionId }); invoked = true; } catch {}
    }
    detachAgent(sessionId);
    return { accepted: invoked, sessionId };
  }

  function isRunning(personId) {
    return activeRuns.has(personId);
  }

  function close() {
    closed = true;
    for (const id of [...attachedScopes.keys()]) detachAgent(id);
    activeRuns.clear();
  }

  return Object.freeze({
    attachAgent,
    detachAgent,
    ensureWorkspace,
    runTurn,
    cancel,
    isRunning,
    close,
  });
}
