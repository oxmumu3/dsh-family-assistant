import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverDigestSources } from '../src/digest-discovery.mjs';
import * as discovery from '../src/digest-discovery.mjs';

const now = () => '2026-10-25T12:00:00.000Z';
const source = (relativePath, updatedAt = now()) => ({ relativePath, bytes: 100, updatedAt, content: 'PRIVATE CONTENT', path: '/private/hidden' });
const projects = [{ workspaceId: 'notes', title: '日常资料', path: '/private/workspace' }, { workspaceId: 'work', title: '工作' }];

test('bounded metadata discovery finds current AI digest and prefers the prepared WeChat form', async () => {
  const calls = [];
  const result = await discoverDigestSources({ projects, now, timeZone: 'Asia/Shanghai', digestSources: async args => {
    calls.push(args);
    return args.workspaceId === 'notes' ? [source('output/ai-digest/2026-10-25.md'), source('output/ai-digest/2026-10-25-wechat.txt'), source('output/ai-digest/2026-10-24-wechat.txt')] : [source('unrelated/notes.md')];
  } });
  assert.equal(result.selected.source.relativePath, 'output/ai-digest/2026-10-25-wechat.txt');
  assert.equal(result.selected.workspaceId, 'notes');
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(new Set(calls.map(row => row.query)), new Set(['digest', '日报']));
  assert.equal(calls.length, 4);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE CONTENT|\/private/);
});

test('unrelated, stale, future, empty and sensitive files never become candidates', async () => {
  const result = await discoverDigestSources({ projects, now, digestSources: async () => [source('notes.md'), source('sports-digest/latest.md'), source('天气日报/latest.md'), source('ai-digest/2026-10-24.md'), source('ai-digest/2026-10-26.md'), source('ai-digest/passwords.txt'), { ...source('ai-digest/latest.md'), bytes: 0 }] });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.selected, null);
});

test('distinct source families remain choices even when one has a prepared WeChat form', async () => {
  const result = await discoverDigestSources({ projects, now, digestSources: async ({ workspaceId }) => workspaceId === 'notes' ? [source('output/ai-digest/2026-10-25-wechat.txt'), source('another/ai-digest/2026-10-25.md')] : [] });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.selected, null);
});

test('partial or truncated project discovery never silently chooses a source', async () => {
  const calls = [];
  const result = await discoverDigestSources({ projects, now, maxProjects: 1, digestSources: async args => { calls.push(args); return [source('ai-digest/latest.md')]; } });
  assert.equal(calls.length, 2);
  assert.equal(result.partial, true);
  assert.equal(result.selected, null);
  const failed = await discoverDigestSources({ projects, now, digestSources: async ({ workspaceId }) => { if (workspaceId === 'work') throw Error('private failure'); return [source('ai-digest/latest.md')]; } });
  assert.equal(failed.partial, true); assert.equal(failed.selected, null);
  assert.doesNotMatch(JSON.stringify(failed), /private failure/);
});

test('latest selection stays in the confirmed directory and exact report form on the source day', () => {
  assert.equal(typeof discovery.selectLatestDigestSource, 'function');
  const resource = { workspaceId: 'notes', relativePath: 'output/ai-digest/2026-10-24-wechat.txt', selection: 'latest', sourceTimeZone: 'America/Mexico_City' };
  const sources = [source('output/ai-digest/2026-10-24-wechat.txt'), source('output/ai-digest/2026-10-25.md'), source('output/ai-digest/2026-10-25-wechat.txt'), source('another/ai-digest/2026-10-25-wechat.txt'), source('output/ai-digest/2026-10-26-wechat.txt')];
  assert.equal(discovery.selectLatestDigestSource({ resource, sources, now }).relativePath, 'output/ai-digest/2026-10-25-wechat.txt');
  // China is already on the next calendar day; the source is still October 25.
  assert.equal(discovery.selectLatestDigestSource({ resource, sources, now: () => '2026-10-26T01:00:00.000Z' }).relativePath, 'output/ai-digest/2026-10-25-wechat.txt');
  assert.throws(() => discovery.selectLatestDigestSource({ resource, sources: [sources[0], sources[1]], now }), { code: 'digest_no_current_report' });
  assert.throws(() => discovery.selectLatestDigestSource({ resource, sources: [sources[2], source('output/ai-digest/latest-wechat.txt')], now }), { code: 'digest_ambiguous_source' });
});

test('latest resource schema requires an explicit valid source zone and a bounded recognisable family', () => {
  assert.equal(typeof discovery.normalizeDigestResource, 'function');
  const resource = { workspaceId: 'notes', relativePath: 'output/ai-digest/2026-10-24-wechat.txt', selection: 'latest', sourceTimeZone: 'America/Mexico_City' };
  assert.deepEqual(discovery.normalizeDigestResource(resource), resource);
  for (const value of [{ ...resource, sourceTimeZone: undefined }, { ...resource, sourceTimeZone: 'Fake/Zone' }, { ...resource, selection: 'all' }, { ...resource, relativePath: 'reports/notes.md' }, { ...resource, relativePath: 'reports/2026-99-99.md' }, { ...resource, relativePath: 'reports/2026-02-30.md' }, { ...resource, relativePath: 'reports/2026-10-24-2026-10-25.md' }, { ...resource, relativePath: '../ai-digest/latest.md' }]) assert.equal(discovery.normalizeDigestResource(value), null);
  assert.deepEqual(discovery.normalizeDigestResource({ workspaceId: 'notes', relativePath: 'reports/notes.md' }), { workspaceId: 'notes', relativePath: 'reports/notes.md' });
});
