import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, lstatSync, realpathSync, openSync, readFileSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, chmodSync, constants } from 'node:fs';
import { resolve, join, parse } from 'node:path';
import { discoverDigestSources, rankDigestCandidates, normalizeDigestResource, digestSourceFamily } from './digest-discovery.mjs';

const clone = value => structuredClone(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const same = (a, b) => canonical(a) === canonical(b);
const bounded = (value, max = 240) => typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function canonical(value) {
  return JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
const titles = { ai_digest: 'AI 日报', weather: '天气服务', presentation: 'PPT 制作服务' };
const MOM = ['妈妈', '我妈', '母亲', '老妈'];
const DAD = ['爸爸', '我爸', '父亲', '老爸'];
const relatives = [MOM, DAD, ['外婆', '姥姥'], ['外公', '姥爷'], ['奶奶'], ['爷爷']];
const aliases = person => [...new Set([person.label, ...(MOM.includes(person.label) ? MOM : DAD.includes(person.label) ? DAD : [])])].filter(value => bounded(value, 80) && value.trim());
const nonActionSetup = value => /(?:不要|先别|别|不用|暂不|无需)[^。！？]*(?:开通|启用|开启|配置|设置|停止|停用|关闭)|如果|假如|要是|考虑|打算|也许|可能|以后/u.test(value);
const stopIntent = value => /停止|停掉|关闭|停用|撤销|取消|不要再|不再(?:给|发|推送)|(?:别|不要)[^。！？]*(?:发|送|推送|播报)/u.test(value);
const unsupportedRepeat = value => /每周|每月|每年|每小时|每隔|隔天|工作日|周末|星期|礼拜/u.test(value);
const daily = value => /每天|每日|天天|每晚|每早|每个(?:早上|晚上|上午|下午)/u.test(value);
const naturalConfirm = /^(?:确认(?:开通|安排|停止|停用|保存|启用)?|就这样(?:安排|开通|保存)?|按这个(?:安排|开通|保存))[。！!\s]*$/u;
const naturalCancel = /^(?:取消|放弃)(?:这个|这项|这次)?(?:安排|草稿|配置|设置)?[。！!\s]*$/u;
const searchDigest = value => /搜索|搜一下|查找|找一下|去找|先找到|自己[^。！？]*找/u.test(value);
const existingDigest = value => /之前|既有|已有|本机|codex/iu.test(value);
const sendDigestNow = value => /现在|立即|立刻|立马|马上/u.test(value) && /发|推送|发送|送/u.test(value) && !/(?:不要|先别|别|不用|暂不|无需)|如果|假如|假设|要是|考虑|打算|也许|可能|以后|支持|如何|怎么|为什么|是否|会不会|会怎样|想了解|想知道|模拟|假装|演示|例如|比如|确认后|同意后|可以[^。！？]*吗|能[^。！？]*吗|[？?]/u.test(value);
function sameDigestDestination(value, draft, people) {
  if (/群聊|群里|群组|微信群|邮箱|邮件|短信|Telegram|钉钉|QQ/iu.test(value)) return false;
  const person = people.find(row => row.id === draft.personId);
  if (!person) return false;
  const allowed = new Set(['他', '她', '对方', '这位家人', '该家人', '原接收人', ...aliases(person)]);
  for (const match of value.matchAll(/(?:给|向|(?:发送|推送|转发|发)到)([^，,。；;\s]+)/gu)) {
    const target = match[1].split(/推送|发送|转发|发|送|看看|一下|一次|一份|测试|试送/u)[0].replace(/(?:的)?(?:微信|手机)$/u, '');
    if (!allowed.has(target)) return false;
  }
  return true;
}
function currentDigestPayload(value, draft, people) {
  if (/昨天|昨日|前天|明天|明日|后天|上期|上一期|上次|前一期|去年|上周|上个月|下周|下个月|旧版/u.test(value)) return false;
  const sourceDate = draft.sourceSelection?.relativePath.match(/\d{4}-\d{2}-\d{2}/u)?.[0];
  for (const match of value.matchAll(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/gu)) if (`${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` !== sourceDate) return false;
  for (const match of value.matchAll(/(\d{1,2})月(\d{1,2})[日号]/gu)) if (`${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}` !== sourceDate?.slice(5)) return false;
  const actions = [...value.matchAll(/推送|发送|转发|发/gu)], action = actions.at(-1);
  if (!action) return false;
  const person = people.find(row => row.id === draft.personId);
  const current = text => {
    for (const label of [...(person ? aliases(person) : []), '这位家人', '该家人', '对方', '他', '她']) text = text.replaceAll(label, '');
    text = text.replace(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|\d{1,2}月\d{1,2}[日号]/gu, '');
    return !text.replace(/AI\s*日报|人工智能日报|日报|简报|(?:这|那)(?:一)?(?:份|期|条)|你刚找到|刚找到|找到|今天|刚才|现有|原来|之前|一次|一下|一遍|一份|试试|看看|看下|测试|试送|给|到|向|的|吧|呀|啊|了|先|现在|直接|立即|立马|马上|立刻|[，,。！？!?\s]/giu, '');
  };
  for (const match of value.matchAll(/(?:把|将|用)([^，,。；;]*?)(?=推送|发送|转发|发)/gu)) if (!current(match[1])) return false;
  const before = value.slice(0, action.index).split(/[，,。；;]/u).at(-1).replace(/没事儿?|我们|第一轮|这一轮|这次|然后|你|请|帮我|麻烦|把|将|用/gu, '');
  if (!current(before)) return false;
  return current(value.slice(action.index + action[0].length));
}
function toolIn(value) {
  const found = [/(?:AI|人工智能)\s*(?:精选|资讯|新闻)?\s*(?:日报|简报)|AI\s*(?:资讯|新闻)|ai_digest/iu.test(value) && 'ai_digest', /天气/u.test(value) && 'weather', /PPT|演示文稿/iu.test(value) && 'presentation'].filter(Boolean);
  return found.length === 1 ? found[0] : null;
}
// Retain the original evidence predicate for persisted ledgers. A historical
// false-positive draft must remain readable after command routing is tightened.
function legacyServiceSetupCandidate(value) {
  if (!bounded(value, 6000) || !value.trim() || !toolIn(value) || nonActionSetup(value)) return false;
  if (/支持.*吗|如何|怎么|有什么好处|想了解|想知道|讨论/u.test(value)) return false;
  if (stopIntent(value)) return true;
  if (/开通|启用|开启|配置|设置.*服务|安排.*服务|开放.*(?:工具|权限)|允许.*(?:使用|调用)|让.+(?:可以|能用)/u.test(value)) return true;
  return (daily(value) || unsupportedRepeat(value) || /定时/u.test(value)) && /给|为|帮|替|让|安排/u.test(value) && /发|送|接收|收到|推送|安排|播报/u.test(value) && toolIn(value) !== 'presentation';
}
const setupIntentText = value => value.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'|`[^`]*`/gu, quote => {
  const name = quote.slice(1, -1).trim();
  return /^(?:(?:AI|人工智能)\s*(?:精选)?日报|天气(?:服务|日报)?|PPT\s*(?:制作)?(?:服务)?)$/iu.test(name) ? name : '';
});
function materialReadIntent(value) {
  const clauses = setupIntentText(value).split(/[，,。；;！？!?\n]/u);
  const reading = clause => /搜索|查找|寻找|找(?:到|出|一下)?|打开|读取|阅读|读(?:一下|一遍|取)?|查看|核对/u.test(clause) && /本机|本地|Codex|项目|文件|正文|资料|(?:AI|人工智能)\s*日报/iu.test(clause);
  // A delivery prohibition attached to a local read is a scope constraint.
  // Keep an independently stated affirmative service change on its old route.
  const affirmative = clauses.filter(clause => !/不要|先别|别|不用|暂不|无需/u.test(clause));
  const recurring = affirmative.join('，');
  return clauses.some(reading) && !affirmative.some(clause => !reading(clause) && legacyServiceSetupCandidate(clause)) && !((daily(recurring) || unsupportedRepeat(recurring) || /定时/u.test(recurring)) && legacyServiceSetupCandidate(recurring));
}
/** A cheap, conservative gate; local reads and quoted commands stay native. */
export function isServiceSetupCandidate(value) {
  return bounded(value, 6000) && !materialReadIntent(value) && legacyServiceSetupCandidate(setupIntentText(value));
}
function chineseNumber(value) {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value.includes('十')) { const parts = value.split('十'); return parts.length === 2 ? (parts[0] ? digits[parts[0]] : 1) * 10 + (parts[1] ? digits[parts[1]] : 0) : NaN; }
  return digits[value] ?? NaN;
}
function clockIn(value) {
  const result = [];
  for (const match of value.matchAll(/(^|[^0-9])(\d{1,3}):(\d{1,3})(?!\d)(?::\d+)?/gu)) result.push({ hour: Number(match[2]), minute: Number(match[3]), colon: true, token: match[0].slice(match[1].length) });
  for (const match of value.matchAll(/([0-9零〇一二两三四五六七八九十]{1,3})\s*(?:点|时)(?:\s*(半|一刻|三刻|[0-9零〇一二两三四五六七八九十]{1,3}分))?/gu)) {
    const minute = match[2] === '半' ? 30 : match[2] === '一刻' ? 15 : match[2] === '三刻' ? 45 : match[2] ? chineseNumber(match[2].slice(0, -1)) : 0;
    const rest = value.slice(match.index + match[0].length);
    result.push({ hour: chineseNumber(match[1]), minute, colon: false, token: match[0], badSuffix: /^[0-9零〇一二两三四五六七八九十刻秒过多]/u.test(rest) });
  }
  if (!result.length) return null;
  if (result.length !== 1 || /左右|大概|差不多|或者|或|至/u.test(value)) return { invalid: true };
  let { hour, minute, colon, token, badSuffix } = result[0];
  if (badSuffix || token.split(':').length > 2 || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return { invalid: true };
  const morning = /早上|早晨|清晨|上午|凌晨|每早/u.test(value), evening = /下午|傍晚|晚上|晚间|每晚/u.test(value), noon = /中午|午间/u.test(value);
  if (Number(morning) + Number(evening) + Number(noon) > 1) return { invalid: true };
  if (morning && hour > 11 || evening && (hour === 0 || hour === 12)) return { invalid: true };
  if (evening && hour < 12) hour += 12;
  if (noon) { if (hour >= 1 && hour <= 2) hour += 12; else if (hour !== 11 && hour !== 12) return { invalid: true }; }
  if (!colon && !morning && !evening && !noon && hour >= 1 && hour <= 12) return { invalid: true };
  return { time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, evidence: token };
}
function zoneIn(value, person) {
  const zones = [];
  if (/北京时间|中国标准时间|中国时间|上海时间/u.test(value)) zones.push('Asia/Shanghai');
  if (/墨西哥城时间/u.test(value)) zones.push('America/Mexico_City');
  for (const match of value.matchAll(/(?:[A-Za-z_+-]+\/)+[A-Za-z_+-]+/gu)) zones.push(match[0]);
  const local = /当地时间|本地时间/u.test(value);
  if (local && person?.timeZone) zones.push(person.timeZone);
  if (!zones.length) return local ? { local: true } : null;
  const unique = [...new Set(zones)];
  if (unique.length !== 1) return { invalid: true };
  try { new Intl.DateTimeFormat('en', { timeZone: unique[0] }); } catch { return { invalid: true }; }
  return { timeZone: unique[0], local };
}
function digestZoneIn(value) {
  const match=value.match(/(?:来源|源|日报)(?:的)?(?:日期|时间)?(?:时区)?\s*(?:按|是|为|用|：|:)\s*(?:(?:[A-Za-z_+-]+\/)+[A-Za-z_+-]+|墨西哥城时间|北京时间|中国时间|上海时间)/u);
  if(!match)return null;
  const zone=zoneIn(match[0],null);return{clause:match[0],...(zone??{invalid:true})};
}
const digestZone = draft => draft.digestTimeZone ?? 'America/Mexico_City';
function digestResourceForDraft(draft) {
  const exact={workspaceId:draft.workspaceId,relativePath:draft.sourceSelection.relativePath};
  return draft.schedule?.enabled && draft.digestFound && !draft.digestFixed && !draft.digestZoneInvalid && digestSourceFamily(exact.relativePath) ? {...exact,selection:'latest',sourceTimeZone:digestZone(draft)} : exact;
}
function sourceNameIn(value) {
  const matches = [...value.matchAll(/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_\-\u4e00-\u9fff.]+\.(?:md|txt)(?![A-Za-z])/giu)].map(match => match[0].replace(/^(?:改成|改用|换成|使用|采用|根据|读取|用)+/u, ''));
  return matches.length === 1 ? matches[0] : matches.length > 1 ? '__ambiguous_source__' : null;
}
function personMatches(value, people) {
  let text = value;
  const correction = text.match(/不是[^，,。]+[，,。\s]*(?:而)?是(.+)/u) ?? text.match(/(?:换给|改给|对象改成|接收人改成)(.+)/u);
  if (correction) text = correction[1];
  const mentions = [];
  for (const person of people) for (const label of aliases(person)) {
    let at = text.indexOf(label);
    while (at !== -1) { const helperSelf = person.role === 'owner' && ['我', '我自己'].includes(label) && !/(?:给|为|让|替)$/u.test(text.slice(0, at)); if (!helperSelf && (label.length >= 2 || new RegExp(`(?:给|为|让|替|帮)${label}`, 'u').test(text))) mentions.push({ person, at, end: at + label.length }); at = text.indexOf(label, at + label.length); }
  }
  const longest = mentions.filter(row => !mentions.some(other => other.at <= row.at && other.end >= row.end && other.end - other.at > row.end - row.at));
  const selected = [...new Map(longest.map(row => [row.person.id, row.person])).values()];
  const knownRelations = relatives.filter(group => group.some(label => text.includes(label)));
  const unknownRelation = knownRelations.some(group => !people.some(person => aliases(person).some(label => group.includes(label))));
  return { selected, mentioned: Boolean(longest.length || knownRelations.length), unknownRelation };
}
function cityIn(value, people) {
  const explicit = value.match(/(?:城市|地点)(?:是|用|设为|改成|改为|：|:)?\s*([^，,。；;\s]+)/u);
  if (explicit) return explicit[1].replace(/天气(?:服务)?$/u, '');
  let text = value;
  for (const person of people) for (const label of aliases(person)) text = text.replaceAll(label, '');
  text = text.replace(/(?:AI|PPT)/giu, '').replace(/(?:[A-Za-z_+-]+\/)+[A-Za-z_+-]+/gu, '').replace(/北京时间|中国时间|上海时间|墨西哥城时间|当地时间|本地时间/gu, '')
    .replace(/[0-9零〇一二两三四五六七八九十]{1,3}(?::\d{1,3}|(?:点|时)(?:半|[0-9零〇一二两三四五六七八九十]{1,3}分)?)/gu, '')
    .replace(/请|帮我|给|为|替|帮|让|把|将|我|开通|启用|开启|设置|安排|配置|一个|一下|每天|每日|早上|上午|晚上|下午|中午|天气|服务|推送|发送|发|播报|改成|改为|改到|改用|换成|查询|查|的/gu, '').replace(/[\s，,。；;：:！!（）()]/gu, '');
  return bounded(text, 100) && text ? text : null;
}
function safeProject(row) {
  if (!row || !bounded(row.workspaceId, 240) || !row.workspaceId.trim() || !bounded(row.title ?? row.name ?? row.workspaceId, 160)) return null;
  return { workspaceId: row.workspaceId, title: row.title ?? row.name ?? row.workspaceId };
}
function safeSource(row) {
  if (!row || !bounded(row.relativePath, 1024) || /^(?:\/)|[\\:]|\/{2}/u.test(row.relativePath) || row.relativePath.split('/').some(part => !part || part.startsWith('.')) || !/\.(?:md|txt)$/iu.test(row.relativePath) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 24000 || !bounded(row.updatedAt, 60) || !Number.isFinite(Date.parse(row.updatedAt))) return null;
  return { relativePath: row.relativePath, name: row.relativePath.split('/').at(-1), bytes: row.bytes, updatedAt: row.updatedAt };
}
const choice = (kind, value, label) => ({ id: `${{ person: 'p', project: 'w', source: 's', location: 'l' }[kind]}:${hash(value).slice(0, 16)}`, kind, label, value });
const publicDraft = draft => clone(Object.fromEntries(['id', 'revision', 'status', 'personId', 'personLabel', 'toolId', 'operation', 'missing', 'resource', 'schedule', 'allowInvoke', 'summary', 'origin', 'contextId', 'createdAt', 'updatedAt'].filter(key => draft[key] !== undefined).map(key => [key, draft[key]]).concat([['choices', draft.choices.map(({ value, ...row }) => row)]])));

const plain = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.keys(value).every(key => fields.includes(key));
const digestPath = value => bounded(value, 1024) && value.trim() && !/^[\/]|[\\:]|\/{2}/u.test(value) && !value.split('/').some(part => !part || part.startsWith('.')) && /\.(?:md|txt)$/iu.test(value);
const zoneValid = value => { try { if (!bounded(value, 100) || !value.trim()) return false; new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } };
function validSchedule(value) {
  return value === null || plain(value, ['enabled', 'time', 'timeZone']) && typeof value.enabled === 'boolean' && (value.enabled || value.time !== undefined || value.timeZone !== undefined ? /^([01]\d|2[0-3]):[0-5]\d$/u.test(value.time ?? '') && zoneValid(value.timeZone) : true);
}
function validResource(toolId, value) {
  if (toolId === 'ai_digest') { const clean=normalizeDigestResource(value); return Boolean(clean) && bounded(value.workspaceId, 240) && same(value,clean); }
  if (toolId === 'weather') return plain(value, ['city', 'locationId']) && bounded(value.city, 120) && value.city.trim() && (value.locationId === undefined || Number.isSafeInteger(value.locationId) && value.locationId > 0);
  return toolId === 'presentation' && plain(value, ['workflow']) && value.workflow === 'presentation';
}
function validGrant(value, personId, toolId) {
  return value === null || plain(value, ['personId', 'toolId', 'resource', 'allowInvoke', 'schedule', 'revision', 'updatedAt']) && value.personId === personId && value.toolId === toolId && validResource(toolId, value.resource) && typeof value.allowInvoke === 'boolean' && validSchedule(value.schedule) && Number.isSafeInteger(value.revision) && value.revision > 0 && bounded(value.updatedAt, 60) && Number.isFinite(Date.parse(value.updatedAt));
}
const validLocation = value => plain(value, ['id', 'label', 'timeZone']) && Number.isSafeInteger(value.id) && value.id > 0 && bounded(value.label, 120) && value.label.trim() && zoneValid(value.timeZone);
function validChoice(row, internal = true) {
  if (!plain(row, internal ? ['id', 'kind', 'label', 'value'] : ['id', 'kind', 'label']) || !['person', 'project', 'source', 'location'].includes(row.kind) || !/^[pwsl]:[a-f0-9]{16}$/u.test(row.id ?? '') || !bounded(row.label, 1100) || !row.label.trim()) return false;
  if (!internal) return true;
  const value = row.value;
  if (row.id !== choice(row.kind, value, row.label).id) return false;
  if (row.kind === 'person') return plain(value, ['personId']) && validId(value.personId);
  if (row.kind === 'project') return plain(value, ['workspaceId', 'title']) && same(value, safeProject(value));
  if (row.kind === 'source') return plain(value, ['workspaceId', 'source']) && bounded(value.workspaceId, 240) && value.workspaceId.trim() && same(value.source, safeSource(value.source));
  return validLocation(value);
}
const publicFields = ['id', 'revision', 'status', 'personId', 'personLabel', 'toolId', 'operation', 'missing', 'resource', 'schedule', 'allowInvoke', 'summary', 'origin', 'contextId', 'createdAt', 'updatedAt', 'choices'];
const internalFields = [...publicFields, 'ownerId', 'ownerScope', 'personScope', 'expectedGrantRevision', 'baselineGrant', 'disableInvoke', 'intentEvidence', 'failureCode', 'repeatUnresolved', 'requestedSchedule', 'repeatEvidence', 'time', 'timeEvidence', 'timeInvalid', 'timeZone', 'zoneEvidence', 'zoneInvalid', 'localZone', 'zoneSource', 'personProblem', 'personCandidates', 'workspaceId', 'workspaceTitle', 'projectUnknown', 'sourceQuery', 'sourceSelection', 'cityQuery', 'location', 'discoveryError', 'digestFound', 'digestTimeZone', 'digestZoneEvidence', 'digestZoneInvalid', 'digestFixed', 'appliedGrant'];
function validDraft(draft, internal = true) {
  if (!plain(draft, internal ? internalFields : publicFields) || !validId(draft.id) || !Number.isSafeInteger(draft.revision) || draft.revision < 1 || !['needs_input', 'ready', 'applying', 'applied', 'cancelled', 'stale'].includes(draft.status) || !Object.hasOwn(titles, draft.toolId) || !['configure', 'disable'].includes(draft.operation) || !Array.isArray(draft.missing) || draft.missing.length > 10 || !draft.missing.every(key => ['person', 'project', 'source', 'location', 'time', 'timeZone', 'sourceTimeZone', 'repeat', 'schedule_unsupported'].includes(key)) || !Array.isArray(draft.choices) || draft.choices.length > 12 || !draft.choices.every(row => validChoice(row, internal)) || !bounded(draft.origin, 100) || !draft.origin.trim() || !bounded(draft.contextId, 160) || !draft.contextId.trim() || ![draft.createdAt, draft.updatedAt].every(value => bounded(value, 60) && Number.isFinite(Date.parse(value)))) return false;
  if (draft.personId !== undefined && (!validId(draft.personId) || !bounded(draft.personLabel, 80) || !draft.personLabel.trim())) return false;
  if (draft.resource !== undefined && !validResource(draft.toolId, draft.resource) || draft.schedule !== undefined && !validSchedule(draft.schedule) || draft.allowInvoke !== undefined && typeof draft.allowInvoke !== 'boolean' || draft.summary !== undefined && !bounded(draft.summary, 6000)) return false;
  if (!internal) return true;
  if (!validId(draft.ownerId) || !/^[a-f0-9]{64}$/u.test(draft.ownerScope ?? '') || typeof draft.disableInvoke !== 'boolean' || typeof draft.requestedSchedule !== 'boolean' || !bounded(draft.intentEvidence, 6000) || !legacyServiceSetupCandidate(draft.intentEvidence) && !isServiceSetupCandidate(draft.intentEvidence)) return false;
  if (draft.personId !== undefined && (!/^[a-f0-9]{64}$/u.test(draft.personScope ?? '') || !Number.isSafeInteger(draft.expectedGrantRevision) || draft.expectedGrantRevision < 0 || !validGrant(draft.baselineGrant, draft.personId, draft.toolId) || (draft.baselineGrant?.revision ?? 0) !== draft.expectedGrantRevision)) return false;
  for (const key of ['timeInvalid', 'zoneInvalid', 'localZone', 'projectUnknown', 'discoveryError', 'digestFound', 'digestZoneInvalid', 'digestFixed', 'repeatUnresolved']) if (draft[key] !== undefined && typeof draft[key] !== 'boolean') return false;
  if(draft.digestTimeZone!==undefined&&(!zoneValid(draft.digestTimeZone)||draft.digestTimeZone!=='America/Mexico_City'&&digestZoneIn(draft.digestZoneEvidence??'')?.timeZone!==draft.digestTimeZone))return false;
  if(draft.digestZoneEvidence!==undefined&&!bounded(draft.digestZoneEvidence,6000))return false;
  for (const key of ['repeatEvidence', 'timeEvidence', 'zoneEvidence']) if (draft[key] !== undefined && !bounded(draft[key], 6000)) return false;
  if (draft.failureCode !== undefined && !['service_authorization_changed', 'service_assignment_failed', 'service_assignment_uncertain', 'service_presentation_unavailable', 'service_presentation_member_required'].includes(draft.failureCode)) return false;
  if (draft.personCandidates !== undefined && (!Array.isArray(draft.personCandidates) || draft.personCandidates.length > 1000 || !draft.personCandidates.every(validId))) return false;
  if (draft.personProblem !== undefined && !['same', 'unknown'].includes(draft.personProblem)) return false;
  if (draft.workspaceId !== undefined && (!bounded(draft.workspaceId, 240) || !draft.workspaceId.trim()) || draft.workspaceTitle !== undefined && (!bounded(draft.workspaceTitle, 160) || !draft.workspaceTitle.trim())) return false;
  if (draft.sourceSelection !== undefined && !same(draft.sourceSelection, safeSource(draft.sourceSelection)) || draft.sourceQuery !== undefined && !bounded(draft.sourceQuery, 1024) || draft.cityQuery !== undefined && (!bounded(draft.cityQuery, 100) || !draft.cityQuery.trim()) || draft.location !== undefined && !validLocation(draft.location)) return false;
  if (draft.time !== undefined && (clockIn(draft.timeEvidence ?? '')?.time !== draft.time || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(draft.time))) return false;
  if (draft.zoneSource !== undefined && (!plain(draft.zoneSource, ['type', 'personId', 'timeZone']) || !['member', 'explicit'].includes(draft.zoneSource.type) || draft.zoneSource.type === 'member' && (draft.zoneSource.personId !== draft.personId || draft.zoneSource.timeZone !== draft.timeZone))) return false;
  if (draft.timeZone !== undefined && (!zoneValid(draft.timeZone) || (draft.zoneSource?.type === 'member' ? draft.zoneSource.timeZone !== draft.timeZone : zoneIn(draft.zoneEvidence ?? '', { timeZone: draft.timeZone })?.timeZone !== draft.timeZone))) return false;
  if (draft.operation === 'configure') {
    if (draft.requestedSchedule && !daily(draft.repeatEvidence ?? '')) return false;
    const expected = draft.requestedSchedule && draft.time && draft.timeZone ? { enabled: true, time: draft.time, timeZone: draft.timeZone } : null;
    if (draft.schedule !== undefined && !same(draft.schedule, expected)) return false;
    if (draft.resource !== undefined && (draft.toolId === 'ai_digest' && (!draft.sourceSelection || !same(draft.resource, digestResourceForDraft(draft))) || draft.toolId === 'weather' && (!draft.location || !same(draft.resource, { city: draft.location.label, locationId: draft.location.id })))) return false;
  } else if (draft.resource !== undefined) {
    if (!draft.baselineGrant || !same(draft.resource, draft.baselineGrant.resource) || draft.allowInvoke !== (draft.disableInvoke ? false : draft.baselineGrant.allowInvoke) || !same(draft.schedule, draft.baselineGrant.schedule ? { ...draft.baselineGrant.schedule, enabled: false } : null)) return false;
  }
  if (['ready', 'applying', 'applied'].includes(draft.status) && (!draft.personId || !draft.resource || draft.missing.length || typeof draft.allowInvoke !== 'boolean' || draft.schedule === undefined || draft.repeatUnresolved || draft.requestedSchedule && (!draft.time || !draft.timeZone || draft.toolId === 'presentation'))) return false;
  return draft.appliedGrant === undefined || validGrant(draft.appliedGrant, draft.personId, draft.toolId);
}
const validRoute = value => plain(value, ['personId', 'accountId', 'peerId', 'generation']) && validId(value.personId) && bounded(value.accountId, 240) && value.accountId.trim() && bounded(value.peerId, 240) && value.peerId.trim() && Number.isSafeInteger(value.generation) && value.generation > 0;
function validProposal(value, draft) {
  return plain(value, ['kind', 'draftId', 'revision', 'personId', 'resource', 'source', 'authorization', 'expectedRoute', 'ownerRoute']) && value.kind === 'ai_digest_once' && value.authorization === 'explicit_now' && draft?.toolId === 'ai_digest' && draft.operation === 'configure' && value.draftId === draft.id && value.revision === draft.revision && value.personId === draft.personId && validResource('ai_digest', value.resource) && value.resource.selection===undefined && same(value.resource, {workspaceId:draft.resource?.workspaceId,relativePath:draft.resource?.relativePath}) && plain(value.source, ['bytes', 'updatedAt']) && Number.isSafeInteger(value.source.bytes) && value.source.bytes > 0 && value.source.bytes <= 24000 && bounded(value.source.updatedAt, 60) && Number.isFinite(Date.parse(value.source.updatedAt)) && validRoute(value.expectedRoute) && value.expectedRoute.personId === draft.personId && (value.ownerRoute === undefined || validRoute(value.ownerRoute));
}
function validState(data) {
  return plain(data, ['version', 'drafts', 'requests']) && data.version === 1 && Array.isArray(data.drafts) && data.drafts.length <= 1000 && data.drafts.every(row => validDraft(row)) && new Set(data.drafts.map(row => row.id)).size === data.drafts.length && Array.isArray(data.requests) && data.requests.length <= 3000 && data.requests.every(row => plain(row, ['key', 'fingerprint', 'result']) && typeof row.key === 'string' && row.key.length <= 1000 && /^[a-f0-9]{64}$/u.test(row.fingerprint ?? '') && (row.result === null || plain(row.result, ['reply', 'draft', 'deliveryProposal']) && bounded(row.result.reply, 8000) && (row.result.draft === undefined || validDraft(row.result.draft, false)) && (row.result.deliveryProposal === undefined || validProposal(row.result.deliveryProposal, row.result.draft)))) && new Set(data.requests.map(row => row.key)).size === data.requests.length;
}
/** Preview11 daily drafts authorized one fixed file. Keep that narrower scope
 * on upgrade; latest selection requires a new visible proposal and confirmation. */
function preserveLegacyFixedDigests(data) {
  if (!Array.isArray(data?.drafts) || data.drafts.length>1000) return;
  for (const draft of data.drafts) {
    if (draft?.toolId!=='ai_digest' || draft.operation!=='configure' || draft.digestFound!==true || draft.requestedSchedule!==true || draft.schedule?.enabled!==true || draft.digestFixed!==undefined || ['digestTimeZone','digestZoneEvidence','digestZoneInvalid'].some(key=>Object.hasOwn(draft,key))) continue;
    if (plain(draft.resource,['workspaceId','relativePath']) && validResource('ai_digest',draft.resource)) draft.digestFixed=true;
  }
}

/** Owner-only finite setup journal. The runtime holds the exclusive process lock.
 * Discovery returns metadata only; all mutations go through the existing toolbox.
 * This service neither invokes tools nor schedules/sends messages itself. */
export function createServiceSetup({ directory, store, toolbox, listProjects, digestSources, weatherSearch, now = () => new Date().toISOString() } = {}) {
  if (!bounded(directory, 4096) || !directory || typeof store?.snapshot !== 'function' || typeof toolbox?.assign !== 'function' || typeof toolbox?.assignments !== 'function' || typeof now !== 'function') fail('service_invalid_argument');
  const requested = resolve(directory);
  if (existsSync(requested) && lstatSync(requested).isSymbolicLink()) fail('service_unsafe_path');
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const root = realpathSync(requested), file = join(root, 'service-setup.json');
  function safePath() {
    let current = parse(root).root;
    for (const segment of root.slice(current.length).split('/').filter(Boolean)) { current = join(current, segment); const info = lstatSync(current); if (info.isSymbolicLink() || !info.isDirectory()) fail('service_unsafe_path'); }
    if (existsSync(file)) { const info = lstatSync(file); if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) fail('service_unsafe_path'); }
  }
  safePath();
  function read() {
    if (!existsSync(file)) return { version: 1, drafts: [], requests: [] };
    let fd;
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); const contents = readFileSync(fd, 'utf8'); if (Buffer.byteLength(contents) > 8 * 1024 * 1024) fail('service_invalid_state'); const data = JSON.parse(contents); preserveLegacyFixedDigests(data); if (!validState(data)) fail('service_invalid_state'); return data; }
    catch (error) { if (error.code === 'service_invalid_state') throw error; fail('service_invalid_state'); } finally { if (fd !== undefined) closeSync(fd); }
  }
  let state = read(), queue = Promise.resolve();
  const serial = work => { const pending = queue.catch(() => {}).then(work); queue = pending; return pending; };
  function clock() { const time = new Date(now()); if (!Number.isFinite(+time)) fail('service_invalid_argument'); return time.toISOString(); }
  function persist() {
    safePath(); if (!validState(state)) fail('service_invalid_state'); const data = JSON.stringify(state) + '\n'; if (Buffer.byteLength(data) > 8 * 1024 * 1024) fail('service_capacity');
    const temporary = join(root, `.service-setup-${randomUUID()}.tmp`); let fd;
    try { fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, data); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temporary, file); chmodSync(file, 0o600); fd = openSync(root, 'r'); fsyncSync(fd); }
    finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch {} }
  }
  if (!existsSync(file)) persist();
  function owner(actorId) {
    if (!validId(actorId)) fail('service_invalid_argument');
    const snapshot = store.snapshot(), person = snapshot.people?.find(row => row.id === actorId);
    if (!person || person.role !== 'owner' || person.status && person.status !== 'active') fail('service_forbidden');
    return { person, snapshot };
  }
  function scope(personId) {
    const snapshot = store.snapshot(), person = snapshot.people?.find(row => row.id === personId);
    if (!person || !['owner', 'elder'].includes(person.role) || person.status && person.status !== 'active') return null;
    const binding = snapshot.bindings?.find(row => row.personId === personId);
    return hash({ personId, role: person.role, label: person.label, createdAt: person.createdAt ?? null, timeZone: person.timeZone ?? null, status: person.status ?? null, binding: binding ? { accountId: binding.accountId, peerId: binding.peerId, generation: binding.generation, status: binding.status } : null });
  }
  const grants = actorId => toolbox.assignments({ actorId });
  const existing = draft => grants(draft.ownerId).find(row => row.personId === draft.personId && row.toolId === draft.toolId) ?? null;
  function locate(args) {
    owner(args.actorId);
    if (!validId(args.draftId) || !Number.isSafeInteger(args.revision)) fail('service_invalid_argument');
    const draft = state.drafts.find(row => row.id === args.draftId && row.ownerId === args.actorId);
    if (!draft) fail('service_unknown_draft');
    if (draft.origin !== (args.origin ?? 'console') || draft.contextId !== (args.contextId ?? 'default')) fail('service_draft_context');
    if (draft.revision !== args.revision) fail('service_draft_changed');
    return draft;
  }
  function request(args, type, work) {
    owner(args.actorId);
    if (!bounded(args.requestId, 512) || !args.requestId?.trim() || !bounded(args.origin ?? 'console', 100) || !bounded(args.contextId ?? 'default', 160)) fail('service_invalid_argument');
    const key = `${args.actorId}\0${args.origin ?? 'console'}\0${args.contextId ?? 'default'}\0${args.requestId}`;
    const fingerprint = hash({ type, ...args, origin: args.origin ?? 'console', contextId: args.contextId ?? 'default' });
    const previous = state.requests.find(row => row.key === key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('service_request_conflict');
      const draft = previous.result?.draft && state.drafts.find(row => row.id === previous.result.draft.id);
      if (previous.result?.draft && !draft) return { reply: '这项配置记录已归档，请重新说出要安排的服务。' };
      if (draft) {
        const scopeChanged = draft.ownerScope !== scope(draft.ownerId) || draft.personId && draft.personScope !== scope(draft.personId);
        const assignmentChanged = draft.status === 'applied' ? !same(existing(draft), draft.appliedGrant) : ['needs_input', 'ready', 'applying'].includes(draft.status) && draft.personId && (existing(draft)?.revision ?? 0) !== draft.expectedGrantRevision;
        if (scopeChanged || assignmentChanged) { const result = stale(draft); persist(); return clone(result); }
        if (draft.status !== previous.result.draft.status || draft.revision !== previous.result.draft.revision) return response(draft);
      }
      if (previous.result?.deliveryProposal && draft) return Promise.resolve(verifyResource(draft)).then(valid => { if (!valid || !live(draft)) { const result = stale(draft); persist(); return clone(result); } return clone(previous.result); });
      return clone(previous.result);
    }
    const before = clone(state);
    return Promise.resolve().then(work).then(result => { if (result === null) { state = before; return null; } state.requests.push({ key, fingerprint, result: clone(result) }); if (state.requests.length > 3000) state.requests.splice(0, state.requests.length - 3000); persist(); return clone(result); }).catch(error => { state = before; throw error; });
  }
  function current(args) { return state.drafts.filter(row => row.ownerId === args.actorId && row.origin === (args.origin ?? 'console') && row.contextId === (args.contextId ?? 'default') && ['needs_input', 'ready'].includes(row.status)).at(-1) ?? null; }
  function stale(draft, code) { const reason = code ?? (draft.status === 'stale' ? draft.failureCode : null) ?? 'service_authorization_changed'; draft.status = 'stale'; draft.failureCode = reason; draft.updatedAt = clock(); draft.choices = []; draft.summary = serviceSetupErrorText({ code: reason }); return { reply: draft.summary, draft: publicDraft(draft) }; }
  function live(draft) {
    return draft.ownerScope === scope(draft.ownerId) && (!draft.personId || draft.personScope === scope(draft.personId)) && (!draft.personId || (existing(draft)?.revision ?? 0) === draft.expectedGrantRevision);
  }
  function setPerson(draft, person) {
    if (draft.personId === person.id) return;
    draft.personId = person.id; draft.personLabel = person.label; draft.personScope = scope(person.id); draft.baselineGrant = clone(existing(draft)); draft.expectedGrantRevision = draft.baselineGrant?.revision ?? 0;
  }
  function summary(draft) {
    const person = draft.personLabel ?? '这位家人', title = titles[draft.toolId];
    if (draft.operation === 'disable') return draft.allowInvoke ? `停止给${person}定时推送${title}；仍可由本人主动调用。` : `停用${person}的${title}及其定时推送。`;
    const detail = draft.toolId === 'ai_digest' ? `；资料：${draft.workspaceTitle} / ${draft.resource?.relativePath}${draft.resource?.selection==='latest'?`；每天取同一来源当天最新已生成的日报（源日期按 ${draft.resource.sourceTimeZone}；当天未生成则不发送旧日报）`:''}` : draft.toolId === 'weather' ? `；城市：${draft.resource?.city}` : '；使用已有 PPT 制作工作流';
    const timing = draft.zoneSource?.type === 'member' ? `按${person}当地时间 ${draft.schedule?.time}（${draft.schedule?.timeZone}）` : `${draft.schedule?.time}（${draft.schedule?.timeZone}）`;
    return `给${person}开通${title}${detail}${draft.schedule?.enabled ? `；每天 ${timing}推送` : '；由本人需要时调用'}。`;
  }
  function response(draft) {
    let unavailable = false;
    try { unavailable = draft.operation === 'configure' && toolbox.catalog?.({ personId: draft.ownerId })?.find(row => row.toolId === draft.toolId)?.executorAvailable === false; } catch {}
    const availability = unavailable ? '执行器尚未接通，接通后才能实际使用。' : '';
    if (draft.status === 'ready') { draft.summary = summary(draft); return { reply: `${draft.summary}${availability}\n确认后保存。你可以说“确认${draft.operation === 'disable' ? '停止' : '开通'}”，或直接说要改哪里。`, draft: publicDraft(draft) }; }
    if (draft.status === 'applied') return { reply: `已保存配置：${draft.summary}${availability}`, draft: publicDraft(draft) };
    if (draft.status === 'stale') return { reply: draft.summary ?? serviceSetupErrorText({ code: draft.failureCode }), draft: publicDraft(draft) };
    if (draft.status === 'cancelled') return { reply: draft.summary ?? '已取消这次配置草稿。', draft: publicDraft(draft) };
    const prompts = [];
    if (draft.toolId === 'ai_digest' && draft.digestFound && draft.resource) prompts.push(`已找到对应的 AI 日报：${draft.sourceSelection.name}。${draft.missing.includes('time') ? '也可以先说“现在发一次”试送。' : ''}`);
    if (draft.missing.includes('person')) prompts.push(draft.personProblem === 'same' ? '这个称呼对应多位已登记成员，请选一位。' : '请选一位已登记成员；未登记的家人需先添加。');
    if (draft.missing.includes('project')) prompts.push(draft.discoveryError ? '暂时无法读取已登记项目，请稍后重试。' : '请选日报所在的已登记项目。');
    if (draft.missing.includes('source')) prompts.push(draft.discoveryError ? '暂时无法读取这个项目的可选日报文件，请稍后重试。' : draft.sourceQuery ? '没有找到唯一对应的文件，请选一份现有日报文件。' : '请选一份现有日报文件。');
    if (draft.missing.includes('location')) prompts.push(draft.cityQuery ? '请选具体城市；同名城市需要区分地区。' : '天气服务要查询哪个城市？');
    if (draft.missing.includes('time')) prompts.push('每天具体几点？请说上午或晚上，或用 24 小时制，例如 08:30。');
    if (draft.missing.includes('timeZone')) prompts.push('按哪个时区？可以说“北京时间”或“家人当地时间”。');
    if (draft.missing.includes('sourceTimeZone')) prompts.push('日报日期按哪个来源时区？可以说“日报日期按墨西哥城时间”。');
    if (draft.missing.includes('repeat')) prompts.push('当前只支持每天定时推送，请说清是否每天。');
    if (draft.missing.includes('schedule_unsupported')) prompts.push('PPT 制作需要本人提供主题和资料，请按需调用；可以说“只开通，不定时”。');
    const options = draft.choices.length ? '\n' + draft.choices.map((row, index) => `${index + 1}. ${row.label}`).join('\n') + '\n可以说“选第一个”。' : '';
    draft.summary = prompts.join(' ');
    return { reply: `${draft.summary}${options}`, draft: publicDraft(draft) };
  }
  async function projects(actorId) {
    if (typeof listProjects !== 'function') fail('service_discovery_unavailable');
    const rows = await listProjects({ actorId });
    if (!Array.isArray(rows) || rows.length > 1000) fail('service_discovery_unavailable');
    const clean = rows.map(safeProject).filter(Boolean); if (new Set(clean.map(row => row.workspaceId)).size !== clean.length) fail('service_discovery_unavailable'); return clean;
  }
  async function sources(workspaceId, query = '') {
    if (typeof digestSources !== 'function') fail('service_discovery_unavailable');
    const rows = await digestSources({ workspaceId, query });
    if (!Array.isArray(rows) || rows.length > 200) fail('service_discovery_unavailable');
    const clean = rows.map(safeSource).filter(Boolean); if (new Set(clean.map(row => row.relativePath)).size !== clean.length) fail('service_discovery_unavailable'); return clean;
  }
  async function enrich(draft, value, selected = null) {
    const roster = owner(draft.ownerId).snapshot.people.filter(person => ['owner', 'elder'].includes(person.role) && (!person.status || person.status === 'active') && validId(person.id) && bounded(person.label, 80));
    draft.missing = []; draft.choices = []; delete draft.discoveryError;
    let person = roster.find(row => row.id === draft.personId);
    const mentions = personMatches(value, roster);
    if (selected?.kind === 'person') { person = roster.find(row => row.id === selected.value.personId); if (!person) fail('service_invalid_choice'); setPerson(draft, person); delete draft.personProblem; }
    else if (mentions.mentioned) {
      if (mentions.selected.length === 1 && !mentions.unknownRelation) { person = mentions.selected[0]; setPerson(draft, person); delete draft.personProblem; }
      else { delete draft.personId; delete draft.personLabel; delete draft.personScope; delete draft.baselineGrant; delete draft.expectedGrantRevision; if (draft.zoneSource?.type === 'member') { delete draft.zoneSource; delete draft.timeZone; } person = null; draft.personProblem = mentions.selected.length > 1 ? 'same' : 'unknown'; draft.personCandidates = (mentions.selected.length ? mentions.selected : roster.filter(row => row.role === 'elder')).map(row => row.id); }
    } else if (!person && /给我(?:自己)?|为我(?:自己)?|让我(?:自己)?/u.test(value)) { person = roster.find(row => row.id === draft.ownerId); setPerson(draft, person); }
    else if (!person && draft.contextId.startsWith('person:')) { person = roster.find(row => row.id === draft.contextId.slice(7)); if (person) setPerson(draft, person); }
    if (!person) {
      draft.missing.push('person'); const candidates = draft.personCandidates?.length ? roster.filter(row => draft.personCandidates.includes(row.id)) : roster.filter(row => row.role === 'elder');
      draft.choices = candidates.slice(0, 12).map(row => choice('person', { personId: row.id }, `${row.label}${candidates.filter(other => other.label === row.label).length > 1 ? `（${row.timeZone ?? ''}，${row.id}）` : ''}`));
    }
    if (draft.operation === 'disable') {
      if (!person) { draft.status = 'needs_input'; return response(draft); }
      const saved = existing(draft);
      if (!saved) { draft.status = 'cancelled'; draft.summary = `${person.label}还没有开通${titles[draft.toolId]}，无需停用。`; return response(draft); }
      draft.resource = clone(saved.resource); draft.allowInvoke = draft.disableInvoke ? false : saved.allowInvoke;
      draft.schedule = saved.schedule ? { ...saved.schedule, enabled: false } : null;
      draft.status = 'ready'; return response(draft);
    }
    if (/只开通|只启用|不定时|不要定时|按需调用|只(?:在)?(?:本人)?(?:需要|询问)时/u.test(value)) { draft.requestedSchedule = false; draft.repeatUnresolved = false; draft.schedule = null; }
    else if (unsupportedRepeat(value)) { draft.requestedSchedule = false; draft.repeatUnresolved = true; draft.schedule = null; }
    else if (daily(value)) { draft.requestedSchedule = true; draft.repeatUnresolved = false; draft.repeatEvidence = value; }
    else if (/定时|按时/u.test(value)) { draft.requestedSchedule = false; draft.repeatUnresolved = true; }
    const sourceZone=draft.toolId==='ai_digest'?digestZoneIn(value):null,deliveryValue=sourceZone?value.replace(sourceZone.clause,''):value;
    if(sourceZone){if(sourceZone.invalid){delete draft.digestTimeZone;draft.digestZoneInvalid=true;}else{draft.digestTimeZone=sourceZone.timeZone;draft.digestZoneEvidence=sourceZone.clause;delete draft.digestZoneInvalid;}}
    if(draft.toolId==='ai_digest'){
      if(/固定(?:这份|文件|来源)|只(?:用|发)(?:这|这一)份|一直发(?:这|这一)份|不要(?:换|最新)|不换文件/u.test(value))draft.digestFixed=true;
      else if(/改(?:用|为|成).*最新|每天.*(?:最新|当天|当日)/u.test(value))draft.digestFixed=false;
      if(draft.digestZoneInvalid)draft.missing.push('sourceTimeZone');
    }
    const clockValue = clockIn(deliveryValue), zone = zoneIn(deliveryValue, person);
    if (clockValue) { if (clockValue.invalid) { delete draft.time; draft.timeInvalid = true; } else { draft.time = clockValue.time; draft.timeEvidence = value; delete draft.timeInvalid; } }
    if (zone) {
      draft.zoneEvidence = deliveryValue;
      if (zone.invalid) { delete draft.timeZone; delete draft.zoneSource; draft.zoneInvalid = true; }
      else if (zone.timeZone) { draft.timeZone = zone.timeZone; draft.localZone = zone.local === true; draft.zoneSource = zone.local ? { type: 'member', personId: person.id, timeZone: person.timeZone } : { type: 'explicit' }; delete draft.zoneInvalid; }
      else draft.localZone = true;
    }
    if (person && zoneValid(person.timeZone) && !draft.zoneInvalid && (draft.localZone || !draft.timeZone || draft.zoneSource?.type === 'member')) { draft.timeZone = person.timeZone; draft.zoneSource = { type: 'member', personId: person.id, timeZone: person.timeZone }; }
    if (draft.requestedSchedule) {
      if (draft.toolId === 'presentation') draft.missing.push('schedule_unsupported');
      if (!draft.time) draft.missing.push('time');
      if (!draft.timeZone) draft.missing.push('timeZone');
      draft.schedule = draft.time && draft.timeZone ? { enabled: true, time: draft.time, timeZone: draft.timeZone } : null;
    } else { draft.schedule = null; if (draft.repeatUnresolved) draft.missing.push('repeat'); }
    draft.allowInvoke = true;
    if (draft.toolId === 'ai_digest') {
      try {
        const available = await projects(draft.ownerId);
        if (selected?.kind === 'project' || selected?.kind === 'source') { const match = available.find(row => row.workspaceId === selected.value.workspaceId); if (!match) fail('service_invalid_choice'); draft.workspaceId = match.workspaceId; draft.workspaceTitle = match.title; delete draft.projectUnknown; delete draft.sourceSelection; delete draft.resource; delete draft.sourceQuery; }
        else {
          const explicit = available.filter(row => value.includes(row.title) || value.includes(row.workspaceId));
          if (/项目/u.test(value) && explicit.length !== 1) { delete draft.workspaceId; delete draft.workspaceTitle; delete draft.sourceSelection; delete draft.resource; draft.projectUnknown = true; }
          if (explicit.length === 1 && explicit[0].workspaceId !== draft.workspaceId) { draft.workspaceId = explicit[0].workspaceId; draft.workspaceTitle = explicit[0].title; delete draft.projectUnknown; delete draft.sourceSelection; delete draft.resource; delete draft.sourceQuery; }
          else if (!draft.workspaceId && !draft.projectUnknown && available.length === 1 && !existingDigest(draft.intentEvidence)) { draft.workspaceId = available[0].workspaceId; draft.workspaceTitle = available[0].title; }
        }
        if (!available.some(row => row.workspaceId === draft.workspaceId)) { delete draft.workspaceId; delete draft.workspaceTitle; delete draft.resource; delete draft.sourceSelection; }
        if (!draft.workspaceId && !draft.projectUnknown && !sourceNameIn(value)) {
          const discovery = await discoverDigestSources({ projects: available, digestSources, now: clock, timeZone: digestZone(draft) });
          if (discovery.selected) {
            draft.workspaceId = discovery.selected.workspaceId; draft.workspaceTitle = discovery.selected.workspaceTitle; draft.sourceSelection = discovery.selected.source; draft.digestFound = true;
          } else if (discovery.candidates.length) {
            draft.missing.push('source');
            if (!draft.choices.length) draft.choices = discovery.candidates.slice(0, 12).map(row => choice('source', { workspaceId: row.workspaceId, source: row.source }, `${row.workspaceTitle} / ${row.source.relativePath}`));
          } else if (available.length === 1) {
            draft.workspaceId = available[0].workspaceId; draft.workspaceTitle = available[0].title;
          }
        }
        if (!draft.workspaceId && !draft.missing.includes('source')) { draft.missing.push('project'); if (!draft.choices.length) draft.choices = available.slice(0, 12).map(row => choice('project', row, available.filter(other => other.title === row.title).length > 1 ? `${row.title}（${row.workspaceId}）` : row.title)); }
        else if (draft.workspaceId) {
          const named = sourceNameIn(value), needle = (named ?? draft.sourceQuery)?.split('/').at(-1) ?? draft.sourceSelection?.name;
          const availableSources = await sources(draft.workspaceId, needle?.slice(-120) ?? '');
          const ranked = rankDigestCandidates(availableSources.map(source => ({ workspaceId: draft.workspaceId, workspaceTitle: draft.workspaceTitle, source })), { now: clock, timeZone: digestZone(draft) });
          if (draft.sourceSelection && (!availableSources.some(row => same(row, draft.sourceSelection)) || existingDigest(draft.intentEvidence) && !ranked.some(row => same(row.source, draft.sourceSelection)))) { delete draft.sourceSelection; delete draft.resource; }
          if (named) { draft.sourceQuery = named; delete draft.sourceSelection; delete draft.resource; }
          if (selected?.kind === 'source') {
            const match = availableSources.find(row => same(row, selected.value.source) && selected.value.workspaceId === draft.workspaceId);
            if (!match) fail('service_invalid_choice'); draft.sourceSelection = match; delete draft.sourceQuery;
          } else if (draft.sourceQuery) {
            const matches = availableSources.filter(row => row.relativePath === draft.sourceQuery || row.name === draft.sourceQuery);
            if (matches.length === 1) draft.sourceSelection = matches[0];
          } else if (!draft.sourceSelection && availableSources.length === 1 && !existingDigest(draft.intentEvidence)) draft.sourceSelection = availableSources[0];
          if (!draft.sourceSelection && !draft.sourceQuery) {
            if (ranked.length && ranked.every(row => row.family === ranked[0].family) && !ranked.slice(1).some(row => row.score === ranked[0].score && row.source.updatedAt === ranked[0].source.updatedAt)) { draft.sourceSelection = ranked[0].source; draft.digestFound = true; }
          }
          if (!draft.sourceSelection) { draft.missing.push('source'); const choices = existingDigest(draft.intentEvidence) && !draft.sourceQuery ? ranked.map(row => row.source) : availableSources; if (!draft.choices.length) draft.choices = choices.slice(0, 12).map(row => choice('source', { workspaceId: draft.workspaceId, source: row }, row.relativePath)); }
          else { draft.digestFound = ranked.some(row => same(row.source, draft.sourceSelection)); draft.resource = digestResourceForDraft(draft); }
        }
      } catch (error) { if (error.code === 'service_invalid_choice') throw error; draft.discoveryError = true; draft.missing.push(draft.workspaceId ? 'source' : 'project'); delete draft.resource; }
    } else if (draft.toolId === 'weather') {
      if (selected?.kind === 'location') { draft.location = clone(selected.value); draft.resource = { city: draft.location.label, locationId: draft.location.id }; }
      else {
        const query = cityIn(value, roster);
        if (query && query !== draft.cityQuery) { draft.cityQuery = query; delete draft.location; delete draft.resource; }
        if (!draft.location && draft.cityQuery) {
          try {
            if (typeof weatherSearch !== 'function') fail('service_discovery_unavailable');
            const rows = await weatherSearch({ query: draft.cityQuery });
            const locations = Array.isArray(rows) && rows.length <= 8 ? rows.filter(row => Number.isSafeInteger(row?.id) && row.id > 0 && bounded(row.label, 120) && row.label.trim() && bounded(row.timeZone, 100)).map(({ id, label, timeZone }) => ({ id, label, timeZone })) : [];
            if (locations.length === 1) { draft.location = locations[0]; draft.resource = { city: locations[0].label, locationId: locations[0].id }; }
            else if (!draft.choices.length) draft.choices = locations.map(row => choice('location', row, locations.filter(other => other.label === row.label).length > 1 ? `${row.label}（${row.timeZone}，${row.id}）` : row.label));
          } catch { draft.discoveryError = true; }
        }
      }
      if (!draft.location) draft.missing.push('location');
    } else draft.resource = { workflow: 'presentation' };
    draft.missing = [...new Set(draft.missing)]; draft.status = draft.missing.length ? 'needs_input' : 'ready'; return response(draft);
  }
  async function verifyResource(draft) {
    if (draft.operation === 'disable' || draft.toolId === 'presentation') return true;
    if (draft.toolId === 'ai_digest') {
      try { const registered = await projects(draft.ownerId); if (!registered.some(row => row.workspaceId === draft.workspaceId && row.title === draft.workspaceTitle)) return false; const available = await sources(draft.workspaceId, draft.sourceSelection.name.slice(-120)); if (!available.some(row => same(row, draft.sourceSelection))) return false; return !draft.digestFound || rankDigestCandidates([{ workspaceId: draft.workspaceId, workspaceTitle: draft.workspaceTitle, source: draft.sourceSelection }], { now: clock, timeZone: digestZone(draft) }).length === 1; } catch { return false; }
    }
    if (draft.toolId === 'weather') {
      try { const rows = await weatherSearch({ query: draft.cityQuery }); return Array.isArray(rows) && rows.some(row => row.id === draft.location.id && row.label === draft.location.label && row.timeZone === draft.location.timeZone); } catch { return false; }
    }
    return false;
  }
  async function confirmInner(args) {
    const draft = locate(args);
    if (draft.status === 'applied') {
      const saved = existing(draft);
      return saved && same(saved, draft.appliedGrant) && draft.ownerScope === scope(draft.ownerId) && draft.personScope === scope(draft.personId) ? response(draft) : stale(draft);
    }
    if (draft.status !== 'ready') return draft.status === 'stale' ? stale(draft) : response(draft);
    if (!validDraft(draft) || draft.zoneSource?.type === 'member' && owner(draft.ownerId).snapshot.people.find(row => row.id === draft.personId)?.timeZone !== draft.timeZone || !live(draft) || !await verifyResource(draft) || !live(draft)) return stale(draft);
    const assignment = { actorId: draft.ownerId, personId: draft.personId, toolId: draft.toolId, resource: clone(draft.resource), allowInvoke: draft.allowInvoke, schedule: clone(draft.schedule) };
    draft.status = 'applying'; draft.updatedAt = clock(); persist();
    try {
      const saved = toolbox.assign(assignment), readback = existing(draft);
      if (!saved || !readback || !same(saved, readback) || saved.revision !== draft.expectedGrantRevision + 1 || !same(saved.resource, assignment.resource) || saved.allowInvoke !== assignment.allowInvoke || !same(saved.schedule, assignment.schedule)) return stale(draft, 'service_assignment_uncertain');
      draft.appliedGrant = clone(saved); draft.status = 'applied'; draft.updatedAt = clock(); return response(draft);
    } catch (error) {
      let unchanged = false; try { unchanged = same(existing(draft), draft.baselineGrant); } catch {}
      const preflight = ['service_presentation_unavailable', 'service_presentation_member_required'].includes(error?.code) ? error.code : 'service_assignment_failed';
      return stale(draft, unchanged ? preflight : 'service_assignment_uncertain');
    }
  }
  function cancelInner(args) { const draft = locate(args); if (draft.status === 'applied') return { reply: '这项配置已经保存；如需停用，请明确说出家人和服务。', draft: publicDraft(draft) }; draft.status = 'cancelled'; draft.choices = []; draft.updatedAt = clock(); delete draft.summary; return response(draft); }
  async function selectInner(args) {
    const draft = locate(args);
    if (!['needs_input', 'ready'].includes(draft.status)) fail('service_invalid_choice');
    if (!live(draft)) return stale(draft);
    const selected = draft.choices.find(row => row.id === args.choiceId); if (!selected) fail('service_invalid_choice');
    draft.revision++; draft.updatedAt = clock(); return enrich(draft, '', selected);
  }
  for (const draft of state.drafts.filter(row => row.status === 'applying')) {
    // An interrupted wrapper may have saved only part of a multi-component setup.
    // Preserve its durable intent and require a readback; never assign again here.
    stale(draft, 'service_assignment_uncertain');
  }
  persist();
  return Object.freeze({
    canResumeOwnerRead({ actorId, requestId, text } = {}) {
      owner(actorId);
      if (!bounded(text, 6000) || !materialReadIntent(text) || isServiceSetupCandidate(text) || !/只回复我/u.test(text) || !/不要修改订阅/u.test(text)) return false;
      const previous = state.requests.find(row => row.key === `${actorId}\0wechat\0default\0${requestId}`);
      if (!previous || previous.fingerprint !== hash({ type: 'handle', actorId, text, requestId, origin: 'wechat', contextId: 'default' })) return false;
      const draft = state.drafts.find(row => row.id === previous.result?.draft?.id);
      const summary = `${owner(actorId).person.label}还没有开通AI 日报，无需停用。`;
      return Boolean(draft && draft.ownerId === actorId && draft.personId === actorId && draft.origin === 'wechat' && draft.contextId === 'default' && draft.status === 'cancelled' && draft.operation === 'disable' && draft.toolId === 'ai_digest' && draft.intentEvidence === text.trim().normalize('NFKC') && draft.baselineGrant === null && draft.expectedGrantRevision === 0 && draft.requestedSchedule === false && draft.disableInvoke === false && draft.resource === undefined && draft.schedule === undefined && draft.summary === summary && previous.result?.reply === summary && previous.result?.draft?.status === 'cancelled' && !previous.result.deliveryProposal && !grants(actorId).some(row => row.personId === actorId && row.toolId === 'ai_digest') && !state.drafts.some(row => row.personId === actorId && row.toolId === 'ai_digest' && ['applying', 'applied'].includes(row.status)));
    },
    snapshotForOwner(args = {}) { owner(args.actorId); return state.drafts.filter(row => row.ownerId === args.actorId && (args.origin === undefined || row.origin === args.origin) && (args.contextId === undefined || row.contextId === args.contextId)).map(publicDraft); },
    handle(args = {}) { return serial(() => request(args, 'handle', async () => {
      if (!bounded(args.text, 6000)) fail('service_invalid_argument');
      if (args.selection) { if (!plain(args.selection, ['draftId', 'revision', 'choiceId'])) fail('service_invalid_argument'); return selectInner({ ...args, ...args.selection }); }
      const value = args.text.trim().normalize('NFKC'), active = current(args);
      const intent = setupIntentText(value);
      if (materialReadIntent(value) || toolIn(value) && !toolIn(intent)) return null;
      if (toolIn(intent) && nonActionSetup(intent)) return { reply: '暂不变更这项服务配置。等你明确要求时再安排。' };
      const explicitConfirm = value.match(/^确认\s+([A-Za-z0-9_-]+)\s+(?:v)?(\d+)$/u);
      if (explicitConfirm) return confirmInner({ ...args, draftId: explicitConfirm[1], revision: Number(explicitConfirm[2]) });
      if (active && naturalConfirm.test(value)) return confirmInner({ ...args, draftId: active.id, revision: active.revision });
      if (active && naturalCancel.test(value)) return cancelInner({ ...args, draftId: active.id, revision: active.revision });
      const ordinal = active && value.match(/^(?:选(?:择)?(?:第)?\s*)?([0-9一二三四五六七八九十]+)(?:个|项)?[。！!\s]*$/u);
      if (ordinal) { const index = chineseNumber(ordinal[1]) - 1, selected = active.choices[index]; if (!selected) return { reply: '请选择上面列出的一项。', draft: publicDraft(active) }; return selectInner({ ...args, draftId: active.id, revision: active.revision, choiceId: selected.id }); }
      const exactChoice = active?.choices.filter(row => row.label === value);
      if (exactChoice?.length === 1) return selectInner({ ...args, draftId: active.id, revision: active.revision, choiceId: exactChoice[0].id });
      const candidate = isServiceSetupCandidate(value), foundTool = toolIn(intent);
      const roster = owner(args.actorId).snapshot.people;
      if (active?.toolId === 'ai_digest' && sendDigestNow(value) && (!foundTool || foundTool === 'ai_digest') && !sameDigestDestination(value, active, roster)) return { reply: '这次接收人或发送位置与当前日报安排不同，请先明确一位已登记家人。', draft: publicDraft(active) };
      const digestContent = active?.toolId === 'ai_digest' && (!foundTool || foundTool === 'ai_digest') && !/这段话|这条消息|这句话|消息(?:是|为|内容)|内容[：:]|[：:]/u.test(value) && (!sendDigestNow(value) || currentDigestPayload(value, active, roster));
      const digestContinuation = active?.toolId === 'ai_digest' && active.operation === 'configure' && digestContent && (searchDigest(value) || sendDigestNow(value));
      const continuation = active && (digestContinuation || /^(?:改|换|不是|对象|接收人|城市|地点|重试|再试|只开通|只启用|不定时|按需)/u.test(value) || clockIn(value) || zoneIn(value, null) || sourceNameIn(value) || active.missing.includes('person') && personMatches(value, owner(args.actorId).snapshot.people).mentioned || active.missing.includes('location') && value.length < 60 && !/什么|怎么|为什么|吗|呢|？|\?/u.test(value));
      if (!candidate && !continuation) return null;
      let draft = active;
      const stopping = stopIntent(intent);
      if (!draft || candidate && (draft.toolId !== foundTool || (draft.operation === 'disable') !== stopping)) {
        if (draft) { draft.status = 'cancelled'; draft.choices = []; }
        draft = { id: randomUUID(), revision: 1, ownerId: args.actorId, ownerScope: scope(args.actorId), origin: args.origin ?? 'console', contextId: args.contextId ?? 'default', status: 'needs_input', intentEvidence: value, toolId: foundTool, operation: stopping ? 'disable' : 'configure', disableInvoke: stopping && /停用|关闭(?![^。！？]*(?:推送|定时))|撤销|权限|不能再用/u.test(value), missing: [], choices: [], requestedSchedule: false, createdAt: clock(), updatedAt: clock() };
        if (!titles[draft.toolId]) return null;
        state.drafts.push(draft); if (state.drafts.length > 1000) { const expired = state.drafts.findIndex(row => ['applied', 'cancelled', 'stale'].includes(row.status)); if (expired < 0) fail('service_capacity'); state.drafts.splice(expired, 1); }
      } else { if (!live(draft)) return stale(draft); draft.revision++; draft.updatedAt = clock(); }
      const route = personId => { const binding = store.snapshot().bindings?.find(row => row.personId === personId); const result = binding && { personId, accountId: binding.accountId, peerId: binding.peerId, generation: binding.generation }; return binding?.status === 'connected' && validRoute(result) ? result : null; };
      const expectedRoute = route(draft.personId), ownerRoute = route(draft.ownerId);
      const result = await enrich(draft, value);
      if (digestContinuation && sendDigestNow(value) && draft.personId && draft.resource && draft.digestFound && expectedRoute && !draft.missing.some(key => !['time', 'timeZone', 'repeat'].includes(key))) {
        if (!live(draft) || !same(route(draft.personId), expectedRoute) || ownerRoute && !same(route(draft.ownerId), ownerRoute)) return stale(draft);
        const proposal = { kind: 'ai_digest_once', draftId: draft.id, revision: draft.revision, personId: draft.personId, resource: {workspaceId:draft.resource.workspaceId,relativePath:draft.resource.relativePath}, source: { bytes: draft.sourceSelection.bytes, updatedAt: draft.sourceSelection.updatedAt }, authorization: 'explicit_now', expectedRoute, ...(ownerRoute ? { ownerRoute } : {}) };
        return { ...result, reply: `已找到对应日报，将为${draft.personLabel}尝试发送一次。${draft.requestedSchedule ? '每天推送的时间仍待确认。' : ''}`, deliveryProposal: proposal };
      }
      return result;
    })); },
    select(args = {}) { return serial(() => request(args, 'select', () => selectInner(args))); },
    confirm(args = {}) { return serial(() => request(args, 'confirm', () => confirmInner(args))); },
    cancel(args = {}) { return serial(() => request(args, 'cancel', () => cancelInner(args))); },
  });
}

/** Finite product copy; never expose arbitrary dependency errors or credentials. */
export function serviceSetupErrorText(error) {
  const messages = {
    service_forbidden: '只有 Owner 可以配置家人服务。',
    service_invalid_argument: '这次配置参数不完整，请在当前对话重新选择或说明。',
    service_unknown_draft: '没有找到这项配置草稿，请重新说出要安排的服务。',
    service_draft_changed: '这项配置已经更新，请核对当前版本后再确认。',
    service_invalid_revision: '这项配置版本已经变化，请核对当前版本后再确认。',
    service_draft_context: '请回到这项配置所在的对话继续操作。',
    service_invalid_choice: '这个选项已经过期，请从当前列出的选项中重新选择。',
    service_invalid_state: '服务配置记录暂时无法读取，请保留现有数据后检查，勿重新覆盖。',
    service_request_conflict: '这次操作编号已用于另一条内容，请重新发送本次要求。',
    service_discovery_unavailable: '暂时无法读取可用资料，请稍后重试。',
    service_capacity: '服务配置记录已达到容量上限，请先归档已有记录。',
    service_unsafe_path: '服务配置存储位置无法安全读取，请保留现有数据后检查。',
    service_authorization_changed: '对象、授权或资料已有变化，请重新说出要安排的服务。',
    service_presentation_unavailable: 'PPT 制作服务尚未接通，这次配置没有保存。',
    service_presentation_member_required: 'PPT 制作服务请为一位已登记家人开通，这次配置没有保存。',
    service_assignment_failed: '服务配置尚未保存，请核对当前工具配置后重试。',
    service_assignment_uncertain: '服务配置的保存结果待核对，请先查看当前工具配置。',
  };
  return messages[error?.code ?? error] ?? '这次服务配置未完成，请核对当前配置后重试。';
}
