import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_AGENTS_MD_CHARS = 16_000;
const MANIFEST_NAME = '.managed-packs.json';

function fail(message, code = 'member_skill_packs_invalid') {
  throw Object.assign(new Error(message), { code });
}

function assertSafeRealDir(dirPath) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) fail('工作区路径无效。');
  const abs = resolve(dirPath);
  if (!existsSync(abs)) fail('工作区目录尚不存在。', 'member_skill_packs_missing_workspace');
  const st = lstatSync(abs);
  if (st.isSymbolicLink() || !st.isDirectory()) fail('工作区路径不能是符号链接。', 'member_skill_packs_unsafe_path');
  return realpathSync(abs);
}

function insideRoot(root, candidate) {
  const diff = relative(root, candidate);
  return diff === '' || (!diff.startsWith('..') && !diff.startsWith('/'));
}

function ensureSafeSubdir(parentReal, childName) {
  const target = join(parentReal, childName);
  if (existsSync(target)) {
    const st = lstatSync(target);
    if (st.isSymbolicLink() || !st.isDirectory()) fail(`不安全的子目录路径：${childName}`, 'member_skill_packs_unsafe_path');
  } else {
    mkdirSync(target, { recursive: true, mode: 0o700 });
  }
  const real = realpathSync(target);
  if (!insideRoot(parentReal, real)) fail(`目录越界：${childName}`, 'member_skill_packs_unsafe_path');
  return real;
}

function writeAtomicPrivateFile(dirReal, fileName, text) {
  const target = join(dirReal, fileName);
  if (existsSync(target)) {
    const st = lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
      fail(`不安全的文件路径：${fileName}`, 'member_skill_packs_unsafe_path');
    }
  }
  const tmp = join(dirReal, `.${fileName}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, target);
    chmodSync(target, 0o600);
    const dirFd = openSync(dirReal, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch {}
  }
}

function readSafePrivateFile(filePath, maxBytes = 64 * 1024) {
  if (!existsSync(filePath)) return null;
  const st = lstatSync(filePath);
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1 || st.size > maxBytes) {
    fail(`文件状态异常：${filePath}`, 'member_skill_packs_unsafe_path');
  }
  let fd;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    return readFileSync(fd, 'utf8');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const SKILL_PACKS = Object.freeze([
  {
    id: 'executive-reporting',
    title: '高管分析与汇报',
    summary: '结论先行、事实先于洞察、受众与决策锚定、表格合计闭环与手机友好表达。',
    skillMd: `---
name: executive-reporting
description: Use when turning research, deal intelligence, financial numbers, or meeting briefs into an executive report, management memo, daily brief, PDF/HTML/DOCX deliverable, or concise WeChat decision readout.
---

# 高管分析与汇报方法论

## 核心原则

1. **结论先行（Answer First）**：标题与首段两句话内直接回答读者最关心的问题（怎么判断、值不值得跟进、窗口在哪），不把方法论和检索过程当开场。
2. **事实先于洞察（Facts Before Insight）**：每部分先给清晰事实、关键数据或可对比表格，再给结构化研判。数字与结论必须一一对齐，绝不在正文里放未经素材支持的猜测。
3. **锚定受众与决策动作**：明确这篇交付物给谁看（例如业务经办、团队负责人、授信审批会或客户对接）、要支持什么决定、有哪些先决条件（CP）和时点窗口。
4. **表格与口径完整闭环**：列出份额、分布或对比数据时，补全统计窗口、计量口径、合计与未披露项标注；未知金额或未披露交易对手一律显式标「公开信息未披露」，严禁补全估值或数字。
5. **证据边界与置信分层**：明确区分「一手公告/监管披露」「权威媒体报道」与「行业推演/待核实事项」；所有未决问题或风控边界集中收口，不在每个段落重复免责声明。
6. **直接交付成品**：用户要汇报稿、一页纸、调研备忘录或日报，就直接给出可直接转发或使用的完整成品（必要时用 \`member_send_workspace_file\` 发回微信文档/图片），不停留在空洞提纲。
7. **移动端与微信阅读路径**：结论卡片化、小节标题可扫读；发微信纯文本时避免裸 Markdown \`#\`/\`**\` 符号堆砌，控制段落呼吸感；若发长文档附件，微信正文配 3–5 句精华导读。
`,
  },
  {
    id: 'bi-analysis',
    title: '商业与财务数据分析',
    summary: 'truth before story、核准口径与粒度（grain）、三轴置信分层、杜绝因果幻觉与非法汇总。',
    skillMd: `---
name: bi-analysis
description: Use when analyzing financial statements, Excel/CSV tables, valuation multiples, leverage ratios, cashflows, transaction terms, or operational KPIs where accuracy, definitions, and comparability matter.
---

# 商业与财务数据分析规范

坚持 **truth before story**：先把数字口径和事实锚定，再做归因解释，最后落成业务/授信判断。

## 分析六步序列

1. **定义待支持决策**：明确这组测算要回答什么问题（例如：标的 EBITDA 与净负债是否支撑并购贷款杠杆上限、换股与现金对价比例如何、跨境汇率敞口多大）。
2. **锁定指标合同（Metric Contract）**：每个关键指标明确：
   - **分子与分母**：如资产负债率、Net Debt / EBITDA、利息覆盖倍数；确保分子分母时间窗口与合并口径一致；
   - **粒度与口径（Grain）**：合并报表还是母公司单表、财政年度还是 TTM、币种与汇率基准日；
   - **可加性判断**：不可加指标（率值、倍数、市盈率、股价）严禁直接相加或简单算术平均。
3. **脚本复核不心算**：收到 Excel / CSV / 财报数据时，优先在工作区编写 Python / Node.js 脚本读取、清洗并校验合计数、缺失值、异常值与单位转换（千元/百万元/亿元、美元/欧元/港元/人民币）。
4. **多假设与敏感性拆解**：关键判断列出 2–4 个可证伪维度或敏感性情景（如利率上浮 50bps、EBITDA 下修 15%、汇率波动 5% 对偿债覆盖率的影响），保留输入→计算→结论的完整溯源。
5. **三轴独立定级（不混为一个总分）**：
   - **数据可信度**：已核审计口径 / 公告初步口径 / 估算参考 / 数据缺口阻塞；
   - **归因强度**：描述性统计 / 相关性对照 / 严格控制对比（相关性不得写成“导致”）；
   - **决策就绪度**：可直接支撑行动 / 附前置核查条件后可用 / 仅作线索初筛 / 数据缺失暂不可决断。
6. **硬停红线**：
   - 未披露或口径不一致的数字不得强行拼表，缺关键分母或币种必须显式标注 \`待核实\`；
   - 不自创行业阈值冒充官方/监管标准，若为通用实务经验区间须明示来源为行业惯例参考。
`,
  },
  {
    id: 'presentation-slides',
    title: '演示文稿与路演稿',
    summary: '离线自包含 HTML / PPTX 演示稿规范：一页一核心论点、高对比商务配色、零外网依赖直发微信。',
    skillMd: `---
name: presentation-slides
description: Use when creating clean executive slide decks, pitch materials, deal briefings, or structured presentations in standalone offline HTML, PPTX, or PDF format for direct WeChat delivery.
---

# 演示文稿与路演稿制作规范

## 核心标准

1. **一页一结论（Assertion-Evidence）**：每页主标题直接写这页要传达的业务判断（而非“公司简介”“财务数据”这种标签式标题），正文用 1 个关键表格、图表或 3 条短要点支撑，避免整页大段文字墙。
2. **视觉与可读性**：
   - 高对比商务编辑风格：米白或深藏青主调，配合 1 个强调色，留白占比充足；
   - 优先使用本地系统字体栈（\`PingFang SC\`, \`Microsoft YaHei\`, \`sans-serif\`），不依赖外部 CDN 在线字体或远程脚本，保证对方微信点开离线 HTML 秒开不白屏。
3. **完整结构节奏**：
   - 第 1 页：主题封面（项目/专题名称、口径、日期）；
   - 第 2 页：核心结论一页纸（3 个最重要的判断与行动窗口）；
   - 中间页：按逻辑推进（交易架构/融资路径 → 财务与覆盖测算 → 监管审查与风险条款 → 可比案例）；
   - 末页：明确下一步待办、时间节点与核查清单（Checklist）。
4. **交付方式**：
   - 需要交互翻页预览时，生成单文件自包含 \`.html\`（支持键盘左右键与屏幕点击翻页，并在首页提示“建议横向看图/浏览器打开”）；
   - 需要对方二次编辑发汇报时，优先在沙箱使用可用工具生成标准 \`.pptx\` 或规范大纲文档；
   - 生成完毕后，直接调用 \`member_send_workspace_file\` 发至对方微信，并在文字回复中给出 3 行精华导读。
`,
  },
  {
    id: 'visual-one-pager',
    title: '一页纸架构与信息图',
    summary: '0.5 秒观点直出、6 大信息图原型（结构拆解/流水线/2×2矩阵/对比表）与高清图文直发。',
    skillMd: `---
name: visual-one-pager
description: Use when a deal architecture, funding structure, cross-border guarantee path, comparison matrix, timeline, or financial trend is clearer as a one-page visual diagram (.png/.svg/.html) than prose alone.
---

# 一页纸架构与信息图方法论

## 适用分诊

- 当内容涉及**股权穿透、跨境融资结构（如内保外贷、境外 SPV 承贷、银团分层）、时间线里程碑、2×2 筛选矩阵或对比数据**时，优先配一张一页纸图解，不要只堆砌文字说明。
- 仅纯短答、无需空间对比时，不用硬画图。

## 六大核心结构原型

1. **交易与融资架构图**：左买方/母公司 → 中间融资主体（SPV/境外分行/担保增信） → 右标的公司/资产，箭头单向标注资金流、股权流与担保流，绝不四向交叉绕线。
2. **非对称对比双栏**：左（限制/风险条件或常规路径） vs 右（推荐结构/优化方案），一眼看清核心取舍。
3. **关键里程碑流水线**：签约 → 监管备案/反垄断申报（发改委/商务部/外审） → 融资关闭（Certain Funds） → 提款交割 → 投后替换。
4. **2×2 商机判断矩阵**：如横轴「担保可行性 / 信用强度」，纵轴「交易确定性 / 时间紧迫度」，精准落位优先级。
5. **三层分层栈**：交易层 / 融资与汇率对冲层 / 监管与 CP 风控层，逐层由上至下展示。
6. **数据趋势与分布图**：仅基于核实数字绘制柱状图、瀑布图或占比对比图，直接标出关键数值与单位。

## 沙箱出图与安全边界

- **矢量 SVG 优先 / Python 渲染**：可在工作区内生成干净的 \`.svg\`、离线 \`.html\`，或使用沙箱可用 Python（如 \`matplotlib\` / \`Pillow\`）渲染高清 \`.png\`。
- **严禁挂载外部个人浏览器环境**：绝不在命令行里尝试连接宿主机调试端口或读取宿主机浏览器用户配置目录。
- **字号与防重叠**：图内文字清晰不遮挡，英文与中文混排留足边距；生成后优先检验文本未截断、无乱码，再通过 \`member_send_workspace_file\` 直接将 \`.png\`（微信将自动以原图发送）或 \`.html\` 发给对方。
`,
  },
  {
    id: 'deep-writing',
    title: '深度研报与长文写作',
    summary: '一手信源溯源、去 AI 味、结论可复述、短段清晰与微信长文可读性控制。',
    skillMd: `---
name: deep-writing
description: Use when drafting deep research memos, industry analysis articles, deal case reviews, or comprehensive executive summaries requiring rigorous sourcing and natural human-readable Chinese prose.
---

# 深度研报与长文写作规范

## 写作五条底线

1. **一手事实驱动，反对空话**：先搜集整理一手公告、财务指标、交易条款、监管裁定或时间戳事件，再用文字串联洞察。缺真实论据的空泛行业背景段落一律删掉。
2. **彻底去除“AI 味”措辞**：
   - 禁滥用“综上所述”“值得注意的是”“不难看出”“这不仅……更……”等模板过渡词；
   - 不用“赋能”“抓手”“生态闭环”等空洞黑话，改用直白精确的商业与金融实务语言（例如直接写“提前设定提款先决条件”“锁定交叉货币掉期”）；
   - 允许短句和果断判断，用数据、结构与反常识机制说话。
3. **每段只讲一个核心意思**：单段尽量控制在 3–5 句，重要机制用编号或小标题拉开结构；让读者快速扫读时仅看小标题和加粗句就能抓全貌。
4. **严格透明溯源**：引用任何金额、股权比例、融资倍数或监管节点，当句紧跟真实来源与披露日期（例如“据公告｜2026-11-20”）；推演预判与客观事实分句写出。
5. **长短双版本思维**：写 2000 字以上的深度专报时，保存完整版 \`.md\` 或 \`.docx\` 通过 \`member_send_workspace_file\` 发文件，同时在微信文本回复里附一份 **200 字以内的核心提炼版**。
`,
  },
]);

export const SKILL_PACK_IDS = Object.freeze(SKILL_PACKS.map(p => p.id));

const SHARED_README = `# 亲友共享技能库（shared-skills）

将已经去除私人路径与密钥的通用能力文件夹放到本目录下（结构为 \`<技能名>/SKILL.md\`），例如：

\`\`\`
shared-skills/
  my-workflow/
    SKILL.md
\`\`\`

- 放进本目录的每个合法技能（目录名仅含小写字母/数字/连字符/下划线），会自动热同步给所有开启独立沙箱、且处于「全套自动同步」模式的亲友席位（包括新开席位）。
- 同名目录可覆盖内置能力包模板，方便主人随时升级方法论。
- 安全提醒：切勿把含本机私人路径、账号令牌或个人隐私项目名的内容放入本目录。
`;

function validSkillId(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9_-]{1,60}$/i.test(name);
}

/**
 * 初始化主人数据目录下的 `shared-skills/` 热加载共享技能库目录与说明文档。
 */
export function ensureSharedSkillsDir(sharedSkillsDir) {
  if (typeof sharedSkillsDir !== 'string' || !sharedSkillsDir.trim()) return null;
  const abs = resolve(sharedSkillsDir);
  if (existsSync(abs)) {
    const st = lstatSync(abs);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      fail('shared-skills 目录不能是符号链接。', 'member_skill_packs_unsafe_path');
    }
  } else {
    mkdirSync(abs, { recursive: true, mode: 0o700 });
  }
  const realDir = realpathSync(abs);
  const readmePath = join(realDir, 'README.md');
  if (!existsSync(readmePath)) {
    writeAtomicPrivateFile(realDir, 'README.md', SHARED_README);
  }
  return realDir;
}

function parseSharedSkillMeta(id, body) {
  const fm = body.match(/^---\n([\s\S]*?)\n---/);
  const field = k => fm?.[1]?.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '');
  const heading = body.replace(/^---\n[\s\S]*?\n---\n*/, '').match(/^#\s+(.+)$/m)?.[1]?.trim();
  const title = field('title') || heading || id;
  const summary = field('summary') || field('description') || heading || id;
  return { id, title: title.slice(0, 80), summary: summary.slice(0, 220) };
}

/**
 * 合并内置 5 套方法论能力包与 `<sharedSkillsDir>` 中主人投放的通用共享技能。
 */
export function resolveSharedSkillCatalog({ sharedSkillsDir } = {}) {
  const byId = new Map(
    SKILL_PACKS.map(p => [p.id, { ...p, source: 'builtin' }]),
  );

  if (typeof sharedSkillsDir === 'string' && sharedSkillsDir.trim() && existsSync(sharedSkillsDir)) {
    let realShared;
    try {
      const st = lstatSync(sharedSkillsDir);
      if (!st.isSymbolicLink() && st.isDirectory()) realShared = realpathSync(sharedSkillsDir);
    } catch {}

    if (realShared) {
      for (const entry of readdirSync(realShared, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || !validSkillId(entry.name)) continue;
        const sub = join(realShared, entry.name);
        let subStat;
        try { subStat = lstatSync(sub); } catch { continue; }
        if (subStat.isSymbolicLink() || !subStat.isDirectory()) continue;
        const skillPath = join(sub, 'SKILL.md');
        if (!existsSync(skillPath)) continue;
        let skillMd = '';
        try {
          skillMd = readSafePrivateFile(skillPath, 64 * 1024) ?? '';
        } catch {
          continue;
        }
        if (!skillMd.trim()) continue;
        const meta = parseSharedSkillMeta(entry.name, skillMd);
        byId.set(entry.name, {
          id: entry.name,
          title: meta.title,
          summary: meta.summary,
          skillMd,
          source: 'shared',
        });
      }
    }
  }

  return [...byId.values()];
}

export function listSkillPackCatalog({ sharedSkillsDir } = {}) {
  return resolveSharedSkillCatalog({ sharedSkillsDir }).map(({ id, title, summary, source }) => ({
    id,
    title,
    summary,
    source,
  }));
}

function readPackManifest(skillsDirReal) {
  const manifestPath = join(skillsDirReal, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return { mode: 'all', installed: [], updatedAt: null };
  try {
    const parsed = JSON.parse(readSafePrivateFile(manifestPath) || '{}');
    const mode = parsed.mode === 'custom' ? 'custom' : 'all';
    const installed = Array.isArray(parsed.installed)
      ? parsed.installed.filter(id => validSkillId(id))
      : [];
    const updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;
    return { mode, installed, updatedAt };
  } catch {
    return { mode: 'all', installed: [], updatedAt: null };
  }
}

/**
 * 同步某成员独立沙箱 `skills/` 目录内托管的能力包，不触碰任何成员自建技能目录。
 * 支持 `mode: 'all'`（同步全部内置+共享目录技能）或 `mode: 'custom'` + 指定 `packIds`。
 */
export function syncWorkspaceSkillPacks({ workspacePath, packIds, mode, sharedSkillsDir } = {}) {
  const wsReal = assertSafeRealDir(workspacePath);
  const catalog = resolveSharedSkillCatalog({ sharedSkillsDir });
  const byId = new Map(catalog.map(item => [item.id, item]));

  const wantsAll = mode === 'all' || packIds === 'all' || packIds === null || (packIds === undefined && mode !== 'custom');
  const resolvedMode = wantsAll ? 'all' : 'custom';

  let requested;
  if (wantsAll) {
    requested = catalog.map(p => p.id);
  } else {
    if (!Array.isArray(packIds)) fail('packIds 必须为数组。');
    requested = [];
    for (const rawId of packIds) {
      const id = String(rawId ?? '').trim();
      if (!byId.has(id)) fail(`不支持的能力包标识：${id}`);
      if (!requested.includes(id)) requested.push(id);
    }
  }

  const skillsDirReal = ensureSafeSubdir(wsReal, 'skills');
  const previouslyManaged = readPackManifest(skillsDirReal).installed;

  // Clean up only packs previously managed by us that are no longer selected
  for (const oldId of previouslyManaged) {
    if (!requested.includes(oldId)) {
      const targetDir = join(skillsDirReal, oldId);
      if (existsSync(targetDir)) {
        const st = lstatSync(targetDir);
        if (!st.isSymbolicLink() && st.isDirectory()) {
          rmSync(targetDir, { recursive: true, force: true });
        }
      }
    }
  }

  for (const packId of requested) {
    const pack = byId.get(packId);
    const packDirReal = ensureSafeSubdir(skillsDirReal, pack.id);
    writeAtomicPrivateFile(packDirReal, 'SKILL.md', pack.skillMd);
  }

  const updatedAt = new Date().toISOString();
  writeAtomicPrivateFile(
    skillsDirReal,
    MANIFEST_NAME,
    JSON.stringify({ version: 1, mode: resolvedMode, installed: requested, updatedAt }, null, 2) + '\n',
  );

  return readWorkspaceSkillPacks(wsReal, { sharedSkillsDir });
}

/**
 * 为指定成员独立沙箱全量同步全部内置+共享能力包，并开启全量自动跟随模式。
 */
export function syncAllSharedSkills({ workspacePath, sharedSkillsDir } = {}) {
  return syncWorkspaceSkillPacks({ workspacePath, mode: 'all', sharedSkillsDir });
}

/**
 * 若该成员处于默认全量模式（或尚未建立托管清单），自动热同步全部最新共享能力包；
 * 若主人已显式切换为自定义勾配（`mode === 'custom'`），保留定制配置不动。
 */
export function autoSyncWorkspaceSharedSkills({ workspacePath, sharedSkillsDir } = {}) {
  const wsReal = assertSafeRealDir(workspacePath);
  const skillsDir = join(wsReal, 'skills');
  if (existsSync(skillsDir)) {
    const st = lstatSync(skillsDir);
    if (!st.isSymbolicLink() && st.isDirectory()) {
      const manifest = readPackManifest(realpathSync(skillsDir));
      if (manifest.mode === 'custom') {
        return readWorkspaceSkillPacks(wsReal, { sharedSkillsDir });
      }
    }
  }
  return syncAllSharedSkills({ workspacePath: wsReal, sharedSkillsDir });
}

/**
 * 盘点某成员工作区 `skills/` 下当前已激活的托管能力包与成员自建技能目录。
 */
export function readWorkspaceSkillPacks(workspacePath, { sharedSkillsDir } = {}) {
  if (typeof workspacePath !== 'string' || !workspacePath.trim() || !existsSync(workspacePath)) {
    return { mode: 'all', installed: [], custom: [], updatedAt: null };
  }
  let wsReal;
  try {
    wsReal = assertSafeRealDir(workspacePath);
  } catch {
    return { mode: 'all', installed: [], custom: [], updatedAt: null };
  }
  const skillsDir = join(wsReal, 'skills');
  if (!existsSync(skillsDir)) return { mode: 'all', installed: [], custom: [], updatedAt: null };
  const dirStat = lstatSync(skillsDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return { mode: 'all', installed: [], custom: [], updatedAt: null };

  const skillsReal = realpathSync(skillsDir);
  const manifest = readPackManifest(skillsReal);
  const catalogIds = new Set(resolveSharedSkillCatalog({ sharedSkillsDir }).map(p => p.id));
  const managedIds = new Set([...catalogIds, ...manifest.installed]);
  const installed = [];
  const custom = [];

  for (const entry of readdirSync(skillsReal, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const sub = join(skillsReal, entry.name);
    const subStat = lstatSync(sub);
    if (subStat.isSymbolicLink() || !subStat.isDirectory()) continue;
    const skillFile = join(sub, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    if (managedIds.has(entry.name)) {
      installed.push(entry.name);
    } else {
      custom.push(entry.name);
    }
  }
  return { mode: manifest.mode, installed, custom, updatedAt: manifest.updatedAt };
}

/**
 * 提取成员工作区 skills 子目录中各 SKILL.md 的名称与简要描述，供原生会话上下文注入。
 */
export function summarizeWorkspaceSkills(workspacePath, { sharedSkillsDir } = {}) {
  if (typeof workspacePath !== 'string' || !workspacePath.trim() || !existsSync(workspacePath)) return [];
  let wsReal;
  try {
    wsReal = assertSafeRealDir(workspacePath);
  } catch {
    return [];
  }
  const skillsDir = join(wsReal, 'skills');
  if (!existsSync(skillsDir)) return [];
  const dirStat = lstatSync(skillsDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return [];
  const skillsReal = realpathSync(skillsDir);
  const catalog = resolveSharedSkillCatalog({ sharedSkillsDir });
  const catalogMap = new Map(catalog.map(p => [p.id, p]));
  const items = [];
  for (const entry of readdirSync(skillsReal, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const sub = join(skillsReal, entry.name);
    const subStat = lstatSync(sub);
    if (subStat.isSymbolicLink() || !subStat.isDirectory()) continue;
    const skillPath = join(sub, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    let body = '';
    try {
      body = readSafePrivateFile(skillPath, 64 * 1024) ?? '';
    } catch {
      continue;
    }
    const fm = body.match(/^---\n([\s\S]*?)\n---/);
    const descMatch = fm?.[1]?.match(/^description:\s*(.+)$/m);
    const packMeta = catalogMap.get(entry.name);
    items.push({
      id: entry.name,
      title: packMeta?.title ?? entry.name,
      description: packMeta?.summary ?? (descMatch?.[1]?.trim().replace(/^["']|["']$/g, '') ?? ''),
      relativePath: `skills/${entry.name}/SKILL.md`,
    });
  }
  return items;
}

/**
 * 写入或清空成员独立沙箱根目录下的 `AGENTS.md`（专属背景与工作口径卡）。
 */
export function writeWorkspaceAgentsMd({ workspacePath, content = '' } = {}) {
  const wsReal = assertSafeRealDir(workspacePath);
  if (typeof content !== 'string') fail('AGENTS.md 内容必须为字符串。');
  const trimmed = content.trim();
  const target = join(wsReal, 'AGENTS.md');
  if (!trimmed) {
    if (existsSync(target)) {
      const st = lstatSync(target);
      if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) fail('不安全的 AGENTS.md 路径。', 'member_skill_packs_unsafe_path');
      unlinkSync(target);
    }
    return { updated: true, present: false, bytes: 0 };
  }
  if (trimmed.length > MAX_AGENTS_MD_CHARS) fail(`AGENTS.md 内容不能超过 ${MAX_AGENTS_MD_CHARS} 字符。`);
  writeAtomicPrivateFile(wsReal, 'AGENTS.md', trimmed + '\n');
  return { updated: true, present: true, bytes: Buffer.byteLength(trimmed + '\n', 'utf8') };
}

/**
 * 安全读取成员沙箱根目录 `AGENTS.md`；不存在时返回空字符串。
 */
export function readWorkspaceAgentsMd(workspacePath) {
  if (typeof workspacePath !== 'string' || !workspacePath.trim() || !existsSync(workspacePath)) return '';
  try {
    const wsReal = assertSafeRealDir(workspacePath);
    return readSafePrivateFile(join(wsReal, 'AGENTS.md'), 64 * 1024) ?? '';
  } catch {
    return '';
  }
}
