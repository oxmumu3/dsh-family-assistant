import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 内置高信噪比多源公开采集脚本生成器（存放于成员独立沙箱 `scripts/` 下）。
 * - `crossborder_ma`：全球与中国跨境并购日报多源采集器（英文并购大单 + 跨境架构 + 反垄断/CFIUS/SAMR 监管 + 中文要约/出海公告，自动时效过滤与去重）。
 * - `topic_radar`：通用多关键词中英双语行业雷达采集器。
 */
export function buildCrossBorderMaCollectorSource() {
  return `#!/usr/bin/env node
// 跨境并购日报 · 多源公开实盘采集器（自动去重 + 近72小时时效过滤 + 原始媒体归属）
const FEEDS = [
  {
    bucket: '全球跨境与大型并购交易',
    url: 'https://news.google.com/rss/search?q=' + encodeURIComponent('("acquires" OR "to acquire" OR "acquisition of" OR "takeover" OR "buyout" OR "stake in") ("billion" OR "million") ("cross-border" OR "Japanese" OR "European" OR "British" OR "German" OR "Chinese" OR "Canadian" OR "Australian" OR "Singapore" OR "Middle East" OR "French" OR "Swiss" OR "Korean" OR "Indian" OR "global") when:3d') + '&hl=en-US&gl=US&ceid=US:en',
    limit: 24,
  },
  {
    bucket: '全球重要并购签约与交割动态',
    url: 'https://news.google.com/rss/search?q=' + encodeURIComponent('("announces acquisition" OR "agrees to acquire" OR "completes acquisition" OR "definitive agreement" OR "tender offer") ("billion" OR "million") when:2d') + '&hl=en-US&gl=US&ceid=US:en',
    limit: 20,
  },
  {
    bucket: '反垄断与外国投资监管审批（CFIUS / 欧盟 / SAMR / CMA / FTC）',
    url: 'https://news.google.com/rss/search?q=' + encodeURIComponent('("CFIUS" OR "European Commission" OR "antitrust" OR "CMA" OR "FTC" OR "DOJ" OR "foreign investment" OR "regulatory approval") ("acquisition" OR "merger" OR "takeover" OR "deal") when:4d') + '&hl=en-US&gl=US&ceid=US:en',
    limit: 16,
  },
  {
    bucket: '中资出海与涉华跨境并购（英文源）',
    url: 'https://news.google.com/rss/search?q=' + encodeURIComponent('("China" OR "Chinese" OR "Hong Kong") ("acquires" OR "to acquire" OR "buyout" OR "takeover" OR "merger" OR "stake in" OR "overseas") when:4d') + '&hl=en-US&gl=US&ceid=US:en',
    limit: 16,
  },
  {
    bucket: '中国跨境并购与上市公司境外收购公告（中文源）',
    url: 'https://news.google.com/rss/search?q=' + encodeURIComponent('(跨境并购 OR 境外收购 OR 出海并购 OR 收购境外 OR 海外并购 OR 外资收购 OR 港股要约收购) when:4d') + '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
    limit: 18,
  },
  {
    bucket: '中国反垄断经营者集中与并购融资动态（中文源）',
    url: 'https://news.google.com/rss/search?q=' + encodeURIComponent('((市场监管总局 OR 经营者集中 OR 反垄断 OR 并购贷款 OR 银团贷款) (收购 OR 并购)) when:5d') + '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
    limit: 12,
  },
];

function decodeXml(str = '') {
  return String(str)
    .replace(/<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\\s+/g, ' ')
    .trim();
}

function extractTag(block, tag) {
  const m = new RegExp('<' + tag + '\\\\b[^>]*>([\\\\s\\\\S]*?)<\\\\/' + tag + '>', 'i').exec(block);
  return m ? decodeXml(m[1]) : '';
}

function normalizeKey(title) {
  return title
    .toLowerCase()
    .replace(/\\s+-\\s+[^-]+$/, '')
    .replace(/[^\\p{L}\\p{N}]+/gu, '')
    .slice(0, 48);
}

async function fetchFeed(feed) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    });
    if (!res.ok) return { bucket: feed.bucket, error: 'HTTP ' + res.status, items: [] };
    const xml = await res.text();
    const items = [];
    for (const match of xml.matchAll(/<item\\b[^>]*>([\\s\\S]*?)<\\/item>/gi)) {
      const raw = match[1];
      const title = extractTag(raw, 'title');
      const link = extractTag(raw, 'link');
      const pubDate = extractTag(raw, 'pubDate');
      const source = extractTag(raw, 'source') || (title.includes(' - ') ? title.split(' - ').at(-1) : '');
      const desc = extractTag(raw, 'description').slice(0, 360);
      if (!title || !link) continue;
      const pubMs = Date.parse(pubDate);
      if (Number.isFinite(pubMs) && Date.now() - pubMs > 6 * 86400_000) continue;
      items.push({
        bucket: feed.bucket,
        title: title.replace(/\\s+-\\s+[^-]+$/, '').trim(),
        source: source.trim(),
        pubDate,
        pubIso: Number.isFinite(pubMs) ? new Date(pubMs).toISOString() : null,
        url: link,
        summary: desc,
      });
      if (items.length >= feed.limit) break;
    }
    return { bucket: feed.bucket, items };
  } catch (err) {
    return { bucket: feed.bucket, error: String(err?.message || err), items: [] };
  } finally {
    clearTimeout(timer);
  }
}

const results = await Promise.all(FEEDS.map(fetchFeed));
const seen = new Set();
const deduped = [];
for (const group of results) {
  for (const item of group.items) {
    const key = normalizeKey(item.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
}
deduped.sort((a, b) => (Date.parse(b.pubIso || '') || 0) - (Date.parse(a.pubIso || '') || 0));

const payload = {
  collectedAt: new Date().toISOString(),
  today: process.env.TODAY || new Date().toISOString().slice(0, 10),
  totalCandidates: deduped.length,
  feedStats: results.map(r => ({ bucket: r.bucket, count: r.items.length, ...(r.error ? { error: r.error } : {}) })),
  items: deduped.slice(0, 65),
};
process.stdout.write(JSON.stringify(payload, null, 2));
`;
}

export function buildTopicRadarCollectorSource(keywords = []) {
  const safeKeywords = keywords.map(k => String(k || '').trim()).filter(Boolean).slice(0, 8);
  const zhQuery = safeKeywords.length ? `(${safeKeywords.join(' OR ')}) when:3d` : 'AI 科技 产业 when:2d';
  const enQuery = safeKeywords.length ? `(${safeKeywords.join(' OR ')}) when:3d` : 'technology business when:2d';
  return `#!/usr/bin/env node
const FEEDS = [
  { bucket: '中文公开资讯', url: 'https://news.google.com/rss/search?q=' + encodeURIComponent(${JSON.stringify(zhQuery)}) + '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', limit: 25 },
  { bucket: '国际公开资讯', url: 'https://news.google.com/rss/search?q=' + encodeURIComponent(${JSON.stringify(enQuery)}) + '&hl=en-US&gl=US&ceid=US:en', limit: 25 },
];
function decodeXml(s=''){return String(s).replace(/<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>/g,'$1').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/\\s+/g,' ').trim();}
function tag(b,t){const m=new RegExp('<'+t+'\\\\b[^>]*>([\\\\s\\\\S]*?)<\\\\/'+t+'>','i').exec(b);return m?decodeXml(m[1]):'';}
const seen = new Set(), items = [];
for (const f of FEEDS) {
  try {
    const r = await fetch(f.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) continue;
    const xml = await r.text();
    let c = 0;
    for (const m of xml.matchAll(/<item\\b[^>]*>([\\s\\S]*?)<\\/item>/gi)) {
      const title = tag(m[1], 'title'), link = tag(m[1], 'link'), pubDate = tag(m[1], 'pubDate'), source = tag(m[1], 'source');
      const key = title.toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, '').slice(0, 44);
      if (!title || !link || seen.has(key)) continue;
      seen.add(key);
      items.push({ bucket: f.bucket, title, source, pubDate, url: link, summary: tag(m[1], 'description').slice(0, 300) });
      if (++c >= f.limit) break;
    }
  } catch {}
}
process.stdout.write(JSON.stringify({ collectedAt: new Date().toISOString(), totalCandidates: items.length, items }, null, 2));
`;
}

export function installCollectorTemplate({ workspacePath, template, slug = 'custom-digest', keywords = [] } = {}) {
  const scriptsDir = join(workspacePath, 'scripts');
  mkdirSync(scriptsDir, { recursive: true, mode: 0o700 });
  const fileName = template === 'crossborder_ma'
    ? 'collect-crossborder-ma.mjs'
    : `collect-${String(slug).replace(/[^a-z0-9_-]/gi, '-')}.mjs`;
  const absPath = join(scriptsDir, fileName);
  const source = template === 'crossborder_ma'
    ? buildCrossBorderMaCollectorSource()
    : buildTopicRadarCollectorSource(keywords);
  writeFileSync(absPath, source, { mode: 0o700 });
  chmodSync(absPath, 0o700);
  return { relativePath: `scripts/${fileName}`, absolutePath: absPath };
}
