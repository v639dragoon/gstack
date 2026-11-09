import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { planRuns } from '../lib/pregate/checks/lanes';
import { DEFAULT_CONFIG } from '../lib/pregate/config';
import type { PregateContext } from '../lib/pregate/types';
import { cleanup, commit, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const home = 'tests/e2e/home.spec.ts';
const job = 'tests/e2e/job-workspace/a[1].spec.ts';
const defaultConfig = 'playwright.config.ts';
const secondConfig = 'playwright.job-workspace.config.mts';

// The fake package manager records actual argv/cwd, answers collection without
// browsers, and refuses the implicit default run for the job-workspace spec.
function fixture(mode = 'normal', configs = [defaultConfig, secondConfig], files = [home, job]) {
  const repo = makeFixtureRepo({ pregate: null, baseFiles: {
    'package.json': JSON.stringify({ name: 'fixture', devDependencies: { '@playwright/test': '^1.48.0' } }),
    'lib/pw-source.ts': 'export const value = 1;\n',
    ...Object.fromEntries(files.map(f => [f, "import { test } from '@playwright/test';\nimport '../../lib/pw-source';\ntest('works', () => {});\n"])),
    ...Object.fromEntries(configs.map(f => [f, 'export default {};\n'])),
  } });
  repos.push(repo);
  commit(repo, { '.github/workflows/free-tests.yml': null, '.github/workflows/windows.yml': null }, 'no workflows');
  repo.git('push', '-q', 'origin', 'HEAD:main');
  repo.git('fetch', '-q', 'origin');
  commit(repo, Object.fromEntries(files.map(f => [f, fs.readFileSync(path.join(repo.work, f), 'utf8') + '// changed\n'])));
  const dir = path.join(repo.root, 'shim');
  fs.mkdirSync(dir);
  const calls = path.join(dir, 'calls.jsonl');
  write(dir, 'runner.cjs', `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args, cwd: process.cwd()}) + '\\n');
const files = ${JSON.stringify(files)};
const mode = ${JSON.stringify(mode)};
const config = args[args.indexOf('-c') + 1];
if (args.includes('--list')) {
  if (mode === 'error') { console.log('config load failed: ' + 'x'.repeat(240)); process.exit(1); }
  if (mode === 'malformed') { console.log('not a list'); process.exit(0); }
  if (mode === 'timeout') { console.log('waiting for config'); setInterval(() => {}, 1000); }
  else {
    const patterns = ${JSON.stringify({ [home]: '(?:^|/)tests/e2e/home\\.spec\\.ts$', [job]: '(?:^|/)tests/e2e/job-workspace/a\\[1\\]\\.spec\\.ts$' })};
    const selected = files.filter(f => args.includes(patterns[f]));
    const collected = mode === 'none' ? [] : selected.filter(f => config !== ${JSON.stringify(defaultConfig)} || f === ${JSON.stringify(home)});
    console.log(JSON.stringify({ config: { rootDir: process.cwd() + '/tests/e2e' }, suites: collected.map(f => ({ file: f.slice('tests/e2e/'.length), specs: [{ file: f.slice('tests/e2e/'.length), tests: [{}] }], suites: [] })) }));
    process.exit(0);
  }
} else {
  if (!args.includes('-c') && files.includes(${JSON.stringify(job)})) { console.log('Error: No tests found'); process.exit(1); }
  if (mode === 'browsers') { console.log("Error: browserType.launch: Executable doesn't exist at /missing/chrome\\n  1 failed"); process.exit(1); }
  console.log('  1 passed (0.1s)');
}
`);
  write(dir, 'npx', `#!/bin/sh\nexec node '${path.join(dir, 'runner.cjs')}' "$@"\n`);
  fs.chmodSync(path.join(dir, 'npx'), 0o755);
  write(dir, 'path.sh', `PATH='${dir}':"$PATH"\n`);
  const env = { PATH: `${dir}:${process.env.PATH ?? ''}`, BASH_ENV: path.join(dir, 'path.sh') };
  const run = (allow = true, extra: string[] = []) => {
    const result = runBin(repo, 'gstack-pregate', ['--base', 'main', ...(allow ? ['--allow-repo-commands'] : []), '--stage', 'tests', '--only', 'lanes', ...extra], env);
    const record = JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8'));
    return { result, check: record.checks.find((c: any) => c.id === 'lanes') };
  };
  return { repo, env, run, calls: (): { args: string[]; cwd: string }[] => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [] };
}

test('single config (or none) preserves the exact runner command without collection', () => {
  for (const configs of [[defaultConfig], []]) {
    const f = fixture('normal', configs, [home]);
    expect(planRuns({ repoRoot: f.repo.work, config: DEFAULT_CONFIG, env: f.env } as unknown as PregateContext, [home]).groups).toEqual([
      { runner: 'npx playwright test --reporter=list {files}', cwd: '', files: [home] },
    ]);
    const { check } = f.run();
    expect(check.status).toBe('pass');
    expect(f.calls().map(c => c.args)).toEqual([['playwright', 'test', '--reporter=list', '(?:^|/)tests/e2e/home\\.spec\\.ts$']]);
  }
}, 60_000);

test('second config collects the escaped job file; default keeps a file both configs collect; collection batches remaining files', () => {
  const f = fixture();
  const { check } = f.run();
  expect(check.status, JSON.stringify(check)).toBe('pass');
  const calls = f.calls();
  expect(calls.every(c => fs.realpathSync(c.cwd) === fs.realpathSync(f.repo.work))).toBe(true);
  const lists = calls.filter(c => c.args.includes('--list'));
  expect(lists).toHaveLength(2);
  expect(lists[0]!.args).toContain(defaultConfig);
  expect(lists[0]!.args.slice(-2)).toEqual(['(?:^|/)tests/e2e/home\\.spec\\.ts$', '(?:^|/)tests/e2e/job-workspace/a\\[1\\]\\.spec\\.ts$']);
  expect(lists[1]!.args).toContain(secondConfig);
  expect(lists[1]!.args.at(-1)).toBe('(?:^|/)tests/e2e/job-workspace/a\\[1\\]\\.spec\\.ts$');
  expect(lists[1]!.args).not.toContain('(?:^|/)tests/e2e/home\\.spec\\.ts$');
  expect(calls.filter(c => !c.args.includes('--list')).map(c => c.args)).toEqual([
    ['playwright', 'test', '-c', defaultConfig, '--reporter=list', '(?:^|/)tests/e2e/home\\.spec\\.ts$'],
    ['playwright', 'test', '-c', secondConfig, '--reporter=list', '(?:^|/)tests/e2e/job-workspace/a\\[1\\]\\.spec\\.ts$'],
  ]);
}, 60_000);

test('a lone file ignored by default uses the first sorted alternative and skips later configs', () => {
  const first = 'playwright.a.config.cjs';
  const f = fixture('normal', ['playwright.z.config.cts', first, defaultConfig, 'playwright.ignored.config.txt'], [job]);
  const { check } = f.run();
  expect(check.status, JSON.stringify(check)).toBe('pass');
  expect(f.calls().filter(c => c.args.includes('--list')).map(c => c.args[c.args.indexOf('-c') + 1])).toEqual([defaultConfig, first]);
  expect(f.calls().filter(c => !c.args.includes('--list')).map(c => c.args)).toEqual([
    ['playwright', 'test', '-c', first, '--reporter=list', '(?:^|/)tests/e2e/job-workspace/a\\[1\\]\\.spec\\.ts$'],
  ]);
}, 60_000);

test('uncollected files are named incomplete with every config tried, never run', () => {
  const f = fixture('none');
  const { check } = f.run();
  expect([check.status, check.code]).toEqual(['incomplete', 'PREGATE_INCOMPLETE']);
  for (const text of [home, job, defaultConfig, secondConfig, 'no config collected']) expect(check.detail).toContain(text);
  expect(f.calls().filter(c => !c.args.includes('--list'))).toHaveLength(0);
}, 60_000);

for (const mode of ['error', 'malformed']) test(`--list ${mode} is incomplete with an output excerpt, never a diff failure`, () => {
  const f = fixture(mode);
  const { check } = f.run();
  expect([check.status, check.code]).toEqual(['incomplete', 'PREGATE_INCOMPLETE']);
  expect(check.detail).toContain(home);
  expect(check.detail).toContain(defaultConfig);
  expect(check.detail).toContain(mode === 'error' ? ('config load failed: ' + 'x'.repeat(240)).slice(0, 200) : 'not a list');
  expect(check.detail).not.toContain('x'.repeat(201));
  expect(f.calls().filter(c => !c.args.includes('--list'))).toHaveLength(0);
}, 60_000);

test('no repo-command permission preserves the single-group plan and executes no config', () => {
  const f = fixture();
  expect(planRuns({ repoRoot: f.repo.work, config: DEFAULT_CONFIG, env: f.env, allowRepoCommands: false } as unknown as PregateContext, [home, job]).groups).toEqual([
    { runner: 'npx playwright test --reporter=list {files}', cwd: '', files: [home, job] },
  ]);
  expect(f.run(false).check.code).toBe('REPO_COMMANDS_NOT_ALLOWED');
  expect(f.calls()).toEqual([]);
}, 60_000);

test('config collection respects the per-process timeout and stays incomplete', () => {
  const f = fixture('timeout');
  const { check } = f.run(true, ['--timeout', '1']);
  expect([check.status, check.code]).toEqual(['incomplete', 'PREGATE_INCOMPLETE']);
  expect(check.detail).toContain('timeout');
  expect(check.detail).toContain('waiting for config');
  expect(f.calls().filter(c => !c.args.includes('--list'))).toHaveLength(0);
}, 60_000);

test('configured runs still classify missing browsers as environment incomplete', () => {
  const f = fixture('browsers', undefined, [home]);
  const { check } = f.run();
  expect([check.status, check.code], JSON.stringify(check)).toEqual(['incomplete', 'PREGATE_ENVIRONMENT']);
  expect(f.calls().filter(c => !c.args.includes('--list'))[0]!.args).toContain('-c');
}, 60_000);
