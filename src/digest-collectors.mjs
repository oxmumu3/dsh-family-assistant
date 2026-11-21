import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 内置高信噪比多源公开采集脚本生成器（存放于成员独立沙箱 `scripts/` 下）。
 * - `crossborder_ma`：全球与中国跨境并购日报多源采集器（英文并购大单 + 跨境架构 + 反垄断/CFIUS/SAMR 监管 + 中文要约/出海公告，自动时效过滤与去重）。
 * - `topic_radar`：通用多关键词中英双语行业雷达采集器。
 */
export function buildCrossBorderMaCollectorSource() {
  return `#!/usr/bin/env node
// 跨境并购项目与并购贷商机 · 多源公开实盘采集器（中英双源 + 近5日时效过滤 + 媒体归属）
const FEEDS = [
  {
    bucket: '中资出海与A股港股境外收购公告（中文一手线索）',
    url: 'https://news.google.com/rss/search?q=' + encodeURIComponent('(收购境外 OR 海外并购 OR 跨境并购 OR 境外子公司 OR 收购股权 OR 要约收购 OR 私有化) (公告 OR 拟收购 OR 签署 OR 交割 OR 港元 OR 美元 OR 欧元) when:5d') + '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
    limit: 20,
  },
  {
    bucket: '港股要约收购与红筹跨境并购动态（中文源）',
    url: 'https://news.google.com/rss/search?q=' + encodeURIComponent('(港股 OR 港交所 OR 香港) (要约收购 OR 私有化 OR 控股权收购 OR 收购资产 OR 并购贷款 OR 银团贷款) when:5d') + '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
    limit: 15,
  },
  {
    bucket: '涉华及亚太跨境并购交易（英文权威财经源）',
    url: 'https://news.google.com/rss/search?q=' + encodeURIComponent('("China" OR "Chinese" OR "Hong Kong" OR "Singapore" OR "Asian" OR "Middle East" OR "Japanese") ("acquires" OR "to acquire" OR "acquisition of" OR "takeover" OR "buyout" OR "stake in") ("billion" OR "million") when:4d') + '&hl=en-US&gl=US&ceid=US:en',
    limit: 20,
  },
  {
    bucket: '全球大型跨境并购与并购融资/过桥银团线索（英文源）',
    url: 'https://news.google.com/rss/search?q=' + encodeURIComponent('("acquires" OR "to acquire" OR "acquisition of" OR "takeover" OR "buyout") ("billion" OR "million") when:3d') + '&hl=en-US&gl=US&ceid=US:en',
    limit: 20,
  },
  {
    bucket: '跨境反垄断与外国投资审查（SAMR / 商务部 / CFIUS / 欧盟 / CMA）',
    url: 'https://news.google.com/rss/search?q=' + encodeURIComponent('("CFIUS" OR "European Commission" OR "CMA" OR "foreign investment" OR "antitrust") ("acquisition" OR "merger" OR "takeover") when:4d') + '&hl=en-US&gl=US&ceid=US:en',
    limit: 12,
  },
  {
    bucket: '中国市场监管总局经营者集中与跨境审批（中文源）',
    url: 'https://news.google.com/rss/search?q=' + encodeURIComponent('((市场监管总局 OR 经营者集中 OR 发改委备案 OR 商务部) (收购 OR 并购 OR 股权)) when:6d') + '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
    limit: 10,
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
  try {
    const res = await fetch(feed.url, {
      signal: AbortSignal.timeout(10000),
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
      const desc = extractTag(raw, 'description').slice(0, 320);
      if (!title || !link) continue;
      const pubMs = Date.parse(pubDate);
      if (Number.isFinite(pubMs) && Date.now() - pubMs > 7 * 86400_000) continue;
      items.push({
        bucket: feed.bucket,
        title: title.replace(/\\s+-\\s+[^-]+$/, '').trim(),
        source: source.trim(),
        pubDate: pubDate.slice(0, 22),
        pubIso: Number.isFinite(pubMs) ? new Date(pubMs).toISOString() : null,
        summary: desc,
      });
      if (items.length >= feed.limit) break;
    }
    return { bucket: feed.bucket, items };
  } catch (err) {
    return { bucket: feed.bucket, error: String(err?.message || err), items: [] };
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

const payload = {
  collectedAt: new Date().toISOString(),
  today: process.env.TODAY || new Date().toISOString().slice(0, 10),
  totalCandidates: deduped.length,
  feedStats: results.map(r => ({ bucket: r.bucket, count: r.items.length, ...(r.error ? { error: r.error } : {}) })),
  items: deduped.slice(0, 58),
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
