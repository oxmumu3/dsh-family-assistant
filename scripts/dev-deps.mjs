#!/usr/bin/env node
/**
 * 本地开发依赖链接。
 *
 * 工作副本只放源码，不提交 node_modules。这个脚本把两份依赖拼成一份视图：
 * 先链 profile 里提升到顶层的公共依赖，再用插件自己 node_modules 里的包覆盖
 * （pptxgenjs / silk-wasm 这类只装在插件目录下的包）。这样 `node --test`
 * 在任何一次 `rm -rf node_modules` 之后都能原样重建。
 *
 * 用法：node scripts/dev-deps.mjs [profileNodeModules] [pluginNodeModules]
 * 只在本机开发副本里使用，不进入发布包。
 */
import {mkdirSync, readdirSync, symlinkSync, lstatSync, existsSync, unlinkSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const profile = process.argv[2] ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules');
const plugin = process.argv[3] ?? join(profile, 'dsh-family-assistant', 'node_modules');
const target = join(root, 'node_modules');

mkdirSync(target, {recursive: true});

function linkAll(source) {
  if (!existsSync(source)) return 0;
  let linked = 0;
  for (const name of readdirSync(source)) {
    if (name.startsWith('.')) continue;
    const from = join(source, name);
    const to = join(target, name);
    try {
      if (lstatSync(to)) unlinkSync(to);
    } catch { /* not there yet */ }
    try {
      symlinkSync(from, to, 'dir');
      linked += 1;
    } catch { /* keep the first source that provided this name */ }
  }
  return linked;
}

const first = linkAll(profile);
const second = linkAll(plugin);
const checks = ['fflate', 'qrcode', 'pptxgenjs', 'silk-wasm'];
console.log(`linked ${first} from profile, ${second} from plugin`);
for (const name of checks) console.log(`${existsSync(join(target, name)) ? 'ok  ' : 'MISS'} ${name}`);
