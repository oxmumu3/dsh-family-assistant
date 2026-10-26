const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const sensitive = /(?:^|[._\-\s/])(?:credentials?|secrets?|tokens?|passwords?|passwd|api[_\- ]?keys?|private[_\- ]?keys?|id[_\- ]?(?:rsa|dsa|ecdsa|ed25519)|keychain)(?:$|[._\-\s/])|凭据|密钥|私钥|令牌|密码/iu;
const digestClue = value => /(?:^|[^a-z])ai[-_ ]?digest(?:[^a-z]|$)|(?:AI|人工智能)[-_\s]*(?:日报|简报|资讯)/iu.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validZone = value => { try { return bounded(value, 100) && Boolean(new Intl.DateTimeFormat('en', { timeZone: value })); } catch { return false; } };
const safePath = value => bounded(value, 1024) && value.trim()===value && !/^[\/]|[\\:]|\/{2}/u.test(value) && !value.split('/').some(part => !part || part.startsWith('.')) && !sensitive.test(value) && /\.(?:md|txt)$/iu.test(value);
const selectionFail = code => { throw Object.assign(new Error(code), { code }); };
/** A dated filename or latest/current alias defines one directory and format.
 * The token is the only changing component; prefixes, suffixes and extension stay fixed. */
export function digestSourceFamily(relativePath) {
  if (!safePath(relativePath)) return null;
  const slash = relativePath.lastIndexOf('/'), directory = relativePath.slice(0, slash + 1), name = relativePath.slice(slash + 1);
  const tokens = [...name.matchAll(/\d{4}-\d{2}-\d{2}|(?<=^|[-_.])(?:latest|current)(?=[-_.]|$)/giu)];
  if (tokens.length !== 1) return null;
  const token = tokens[0], dated = /^\d/u.test(token[0]);
  if (dated) { const instant=new Date(token[0]+'T00:00:00Z'); if(!Number.isFinite(+instant)||instant.toISOString().slice(0,10)!==token[0])return null; }
  return { directory, template: name.slice(0, token.index) + '{day}' + name.slice(token.index + token[0].length), date: dated ? token[0] : null };
}
export function normalizeDigestResource(value) {
  if (!plain(value) || !Object.hasOwn(value, 'workspaceId') || !Object.hasOwn(value, 'relativePath') || !bounded(value.workspaceId, 1024) || value.workspaceId.trim() !== value.workspaceId || !safePath(value.relativePath)) return null;
  const keys = Object.keys(value);
  if (keys.length === 2 && keys.every(key => ['workspaceId', 'relativePath'].includes(key))) return { workspaceId: value.workspaceId, relativePath: value.relativePath };
  if (keys.length !== 4 || !keys.every(key => ['workspaceId', 'relativePath', 'selection', 'sourceTimeZone'].includes(key)) || value.selection !== 'latest' || !validZone(value.sourceTimeZone) || !digestSourceFamily(value.relativePath)) return null;
  return { workspaceId: value.workspaceId, relativePath: value.relativePath, selection: 'latest', sourceTimeZone: value.sourceTimeZone };
}
function dateInZone(value, timeZone) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)); } catch { return null; }
}
function cleanSource(row) {
  if (!row || !safePath(row.relativePath) || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > 24000 || !bounded(row.updatedAt, 60) || !Number.isFinite(Date.parse(row.updatedAt))) return null;
  return { relativePath: row.relativePath, name: row.relativePath.split('/').at(-1), bytes: row.bytes, updatedAt: row.updatedAt };
}
/** A recurring read never falls back to yesterday or switches to a different form. */
export function selectLatestDigestSource({ resource, sources, now = () => new Date().toISOString() } = {}) {
  const selected = normalizeDigestResource(resource);
  if (selected?.selection !== 'latest' || !Array.isArray(sources) || sources.length > 2000) selectionFail('digest_invalid_argument');
  const instant = now(), today = dateInZone(instant, selected.sourceTimeZone), anchor = digestSourceFamily(selected.relativePath), found = new Map();
  if (!today) selectionFail('digest_invalid_argument');
  for (const row of sources) {
    const source = cleanSource(row), family = source && digestSourceFamily(source.relativePath);
    if (!family || family.directory !== anchor.directory || family.template !== anchor.template || (family.date ?? dateInZone(source.updatedAt, selected.sourceTimeZone)) !== today || Date.parse(source.updatedAt) > Date.parse(instant)) continue;
    if (found.has(source.relativePath) && JSON.stringify(found.get(source.relativePath)) !== JSON.stringify(source)) selectionFail('digest_source_changed');
    found.set(source.relativePath, source);
  }
  if (!found.size) selectionFail('digest_no_current_report');
  if (found.size !== 1) selectionFail('digest_ambiguous_source');
  return [...found.values()][0];
}
/** Rank metadata only. A report date is authoritative over a copied file's mtime. */
export function rankDigestCandidates(rows, { now = () => new Date().toISOString(), timeZone = 'America/Mexico_City' } = {}) {
  const instant = now(), today = dateInZone(instant, timeZone), result = [];
  if (!today) return result;
  for (const row of rows) {
    const source = cleanSource(row.source);
    if (!source || !bounded(row.workspaceId, 240) || !bounded(row.workspaceTitle, 160) || !digestClue(`${row.workspaceTitle}/${source.relativePath}`)) continue;
    const dates = [...source.relativePath.matchAll(/(?:^|[^\d])(\d{4}-\d{2}-\d{2})(?!\d)/gu)].map(match => match[1]);
    if (dates.length ? dates.some(date => date !== today) : dateInZone(source.updatedAt, timeZone) !== today) continue;
    if (Date.parse(source.updatedAt) > Date.parse(instant) + 5 * 60 * 1000) continue;
    const prepared = /wechat|微信|推送版|发送版/iu.test(source.relativePath);
    const raw = /(?:^|[/_.-])(?:raw|source|sources)(?:[/_.-]|$)|原文|源文/iu.test(source.relativePath);
    const family = `${row.workspaceId}/${source.relativePath.slice(0, source.relativePath.lastIndexOf('/') + 1)}${source.name.replace(/\d{4}-\d{2}-\d{2}|latest|current|wechat|微信|推送版|发送版|raw|sources?|原文|源文/giu, '').replace(/\.(?:md|txt)$/iu, '').replace(/[-_.\s]/gu, '') || 'report'}`;
    result.push({ workspaceId: row.workspaceId, workspaceTitle: row.workspaceTitle, source, family, score: (prepared ? 100 : 40) + (/ai[-_ ]?digest|(?:AI|人工智能)[-_\s]*(?:日报|简报)/iu.test(source.relativePath) ? 20 : 0) - (raw ? 20 : 0) });
  }
  return result.sort((a, b) => b.score - a.score || Date.parse(b.source.updatedAt) - Date.parse(a.source.updatedAt) || a.source.relativePath.localeCompare(b.source.relativePath));
}
/** At most 24 registered projects, two filtered metadata scans each, no contents. */
export async function discoverDigestSources({ projects, digestSources, now, timeZone, maxProjects = 24 } = {}) {
  if (!Array.isArray(projects) || projects.length > 1000 || typeof digestSources !== 'function' || !Number.isSafeInteger(maxProjects) || maxProjects < 1 || maxProjects > 24) throw Object.assign(new Error('service_discovery_unavailable'), { code: 'service_discovery_unavailable' });
  const registered = projects.filter(row => bounded(row?.workspaceId, 240) && bounded(row.title, 160));
  const found = new Map(); let partial = registered.length > maxProjects;
  for (const project of registered.slice(0, maxProjects)) {
    for (const query of ['digest', '日报']) {
      try {
        const rows = await digestSources({ workspaceId: project.workspaceId, query });
        if (!Array.isArray(rows) || rows.length > 200) { partial = true; continue; }
        if (rows.length === 200) partial = true;
        for (const source of rows) {
          const clean = cleanSource(source); if (!clean) continue;
          found.set(`${project.workspaceId}\0${clean.relativePath}`, { workspaceId: project.workspaceId, workspaceTitle: project.title, source: clean });
        }
      } catch { partial = true; }
    }
  }
  const candidates = rankDigestCandidates([...found.values()], { now, timeZone });
  const first = candidates[0], sameFamily = first && candidates.every(row => row.family === first.family);
  const uniqueForm = first && !candidates.some(row => row !== first && row.score === first.score && row.source.updatedAt === first.source.updatedAt);
  return { candidates, selected: !partial && sameFamily && uniqueForm ? first : null, partial };
}
