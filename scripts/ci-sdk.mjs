import { readFile, writeFile, mkdtemp, mkdir, cp, symlink, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve, relative, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateCompatibility } from './compatibility.mjs';
import { runInSandbox, verifySandbox } from './ci-sandbox.mjs';
const exec = promisify(execFile);
const source = fileURLToPath(new URL('../', import.meta.url));
export async function planSdk(args) {
  if (args.length < 2 || args.length > 3 || args[0] !== '--sdk' || args.length === 3 && args[2] !== '--plan') throw Error('Usage: node scripts/ci-sdk.mjs --sdk EXACT_VERSION [--plan]');
  const metadata = JSON.parse(await readFile(join(source, 'package.json')));
  const sdk = validateCompatibility(metadata, args[1]);
  const dependencies = { ...metadata.dependencies, ...metadata.devDependencies };
  const rc1=sdk==='0.2.2-rc.1';
  dependencies['@deepseek-ai/cordis'] = rc1 ? '4.1.0' : sdk === '0.2.0-rc.2' ? '4.0.4' : '4.0.5';
  if(!rc1)for(const name of ['dsh-agent','dsh-session-projection','dsh-system-prompt','dsh-scope','dsh-tool-executor-native','dsh-tool-executor-ptc'])delete dependencies['@deepseek-ai/'+name];
  for (const name of Object.keys(dependencies)) if (name.startsWith('@deepseek-ai/dsh-')) dependencies[name] = sdk;
  for (const name of Object.keys(metadata.peerDependencies ?? {})) if (name.startsWith('@deepseek-ai/dsh-')) dependencies[name] = sdk;
  for (const name of ['dsh-storage', 'dsh-storage-domain', 'dsh-storage-json', 'dsh-client-connection']) dependencies['@deepseek-ai/' + name] = sdk;
  return { sdk, dependencies, compatibilityOverride: false, hooks: false };
}
async function main() {
  const plan = await planSdk(process.argv.slice(2));
  if (process.argv[4] === '--plan') { console.log(JSON.stringify(plan)); return; }
  process.umask(0o077);
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-ci-'));
  const home = join(root, 'home'), carrier = join(root, 'carrier'), stage = join(root, 'source');
  const output = process.env.DSH_CI_OUTPUT ? resolve(process.env.DSH_CI_OUTPUT) : join(root, 'results');
  const inside = relative(source, output);
  if (!inside || inside !== '..' && !inside.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !inside.startsWith('..\\') && !inside.startsWith('../')) throw Error('CI results must be outside the source tree');
  for (const directory of [home, carrier, output]) await mkdir(directory, { recursive: true });
  const env = { PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? ''), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), DSH_HOME: join(home, 'dsh'), DSH_AGENTS_HOME: join(home, 'agents'), TMPDIR: root, TMP: root, TEMP: root, LANG: 'en_US.UTF-8', TZ: 'UTC', CI: 'true', NPM_CONFIG_USERCONFIG: join(home, 'npmrc-user'), NPM_CONFIG_GLOBALCONFIG: join(home, 'npmrc-global'), NPM_CONFIG_CACHE: join(root, 'npm-cache'), NPM_CONFIG_IGNORE_SCRIPTS: 'true', DSH_TELEMETRY_DISABLED: '1', DSH_TEST_SDK_VERSION: plan.sdk, NODE_OPTIONS: '--max-old-space-size=128' };
  await writeFile(env.NPM_CONFIG_USERCONFIG, ''); await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '');
  await writeFile(join(carrier, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: plan.dependencies }, null, 2) + '\n');
  const run = async (command, args, cwd, runtime, log, timeout) => {
    try {
      const result = runtime === env ? await exec(command, args, { cwd, env: runtime, timeout, maxBuffer: 4 * 1024 * 1024 }) : await runInSandbox(command, args, { cwd, env: runtime, timeout, maxBuffer: 4 * 1024 * 1024 });
      await writeFile(join(output, log), result.stdout + result.stderr); return result;
    } catch (error) {
      await writeFile(join(output, log), String(error.stdout ?? '') + String(error.stderr ?? ''));
      throw Error(`${log} failed (${error.code ?? error.signal ?? 'unknown'}); see the bounded CI artifact`);
    }
  };
  // Exact public dependencies only; no repository/user npm config or lifecycle hooks.
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--registry=https://registry.npmjs.org/'], carrier, env, 'dependency-install.log', 180000);
  for (const [name, version] of Object.entries(plan.dependencies)) if (name.startsWith('@deepseek-ai/dsh-')) {
    const actual = JSON.parse(await readFile(join(carrier, 'node_modules', name, 'package.json'))).version;
    if (actual !== version) throw Error('Resolved SDK drift: ' + name);
  }
  await cp(source, stage, { recursive: true, filter: filename => !['.git', 'node_modules', 'ci-results'].includes(relative(source, filename).split(/[\\/]/)[0]) });
  await symlink(join(carrier, 'node_modules'), join(stage, 'node_modules'), 'junction');
  const runtime = { ...env, NODE_OPTIONS: '--max-old-space-size=128 --import=' + pathToFileURL(join(stage, 'scripts/ci-network.mjs')).href };
  const network = await verifySandbox({ cwd: stage, env: runtime });
  await writeFile(join(output, 'network-selftest.json'), JSON.stringify(network, null, 2) + '\n');
  const tests = ["test/plugin.test.mjs", "test/owner-bridge.test.mjs", "test/owner-agent-host.test.mjs", "test/voice-host.test.mjs", "test/http.test.mjs", "test/owner-tool-authority.test.mjs", "test/channels.test.mjs", "test/weixin.test.mjs", "test/weixin-media.test.mjs", "test/owner-send-authority-race.test.mjs", "test/upgrade-persistence.test.mjs", "test/compatibility-contract.test.mjs", "test/compatibility-official.test.mjs", "test/ci-sandbox.test.mjs"];
  if(plan.sdk==='0.2.2-rc.1')tests.push('test/rc1-owner-scope.test.mjs');
  const suite = await run(process.execPath, ['--max-old-space-size=128', '--test', '--test-reporter=tap', '--test-concurrency=1', ...tests], stage, runtime, 'suite.tap', 240000);
  const counts = Object.fromEntries([...suite.stdout.matchAll(/^# (tests|pass|fail|skipped|cancelled) (\d+)$/gm)].map(([,key,value]) => [key, Number(value)]));
  await writeFile(join(output, 'suite-counts.json'), JSON.stringify(counts, null, 2) + '\n');
  if (!Number.isSafeInteger(counts.tests) || counts.tests < (plan.sdk==='0.2.2-rc.1'?144:139) || counts.pass !== counts.tests || counts.fail !== 0 || counts.skipped !== 0 || counts.cancelled !== 0) throw Error('SDK contracts incomplete, skipped or failed: ' + JSON.stringify(counts));
  await run(process.execPath, ['--max-old-space-size=128', 'scripts/ci-host-contract.mjs'], stage, runtime, 'host-contract.log', 45000);
  const summary = { sdk: plan.sdk, passed: true, counts, network, exactSdkDependencies: true, testFiles: tests.length, hooks: false, compatibilityOverride: false, syntheticHome: true, productionProfileUsed: false, realModelCalls: 0, realMessagesSent: 0, runtimeNonLoopbackAllowed: false, maxOldSpaceMb: 128, suiteTimeoutMs: 240000, dependencyAcquisition: 'public npm registry, without hooks', output };
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n'); console.log(JSON.stringify(summary));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
