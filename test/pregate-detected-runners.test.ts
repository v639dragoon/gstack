import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { commandSet, recordTrust } from '../lib/checks';
import { detectRunner, planRuns } from '../lib/pregate/checks/lanes';
import { DEFAULT_CONFIG, parseConfig, validateConfig } from '../lib/pregate/config';
import type { PregateContext } from '../lib/pregate/types';
import { cleanup, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const dirs: string[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => {
  while (repos.length) cleanup(repos.pop()!);
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = () => {
  fs.mkdirSync('/tmp/pdr', { recursive: true });
  const dir = fs.mkdtempSync('/tmp/pdr/detected-runners-');
  dirs.push(dir);
  return dir;
};
const override = 'node --import tsx scripts/gate-tests.ts {files}';
const context = (repoRoot: string, detected_runners?: PregateContext['config']['detected_runners']) =>
  ({ repoRoot, config: { ...DEFAULT_CONFIG, ...(detected_runners === undefined ? {} : { detected_runners }) }, env: process.env } as PregateContext);

// A: both Bun detection paths, each dependency runner, and tool-mismatch controls.
test.each([
  ['vitest', 'vitest', 'npx vitest run {files}'],
  ['jest', 'jest', 'npx jest {files}'],
  ['bun marker', 'bun', 'bun test {files}'],
  ['bun fallback', 'bun', 'bun test {files}'],
] as const)('detected_runners replaces only the detected %s command', (mode, tool, detected) => {
  const root = scratch();
  if (mode === 'bun marker') write(root, 'bun.lock', '');
  else if (tool !== 'bun') write(root, 'package.json', JSON.stringify({ devDependencies: { [tool]: '1' } }));
  expect(detectRunner(context(root), ['unit.test.ts'])).toBe(detected);
  expect(detectRunner(context(root, { [tool]: override }), ['unit.test.ts'])).toBe(override);
  expect(detectRunner(context(root, { [tool === 'vitest' ? 'jest' : 'vitest']: override }), ['unit.test.ts'])).toBe(detected);
});

test('detected_runners leaves node and Python detection untouched', () => {
  const ctx = context(scratch(), { bun: override, vitest: override, jest: override });
  expect(detectRunner(ctx, ['unit.test.mjs'])).toBe('node --test {files}');
  expect(detectRunner(ctx, ['test_unit.py'])).toBe('python3 -m pytest {files}');
});

// B: use real import-based Playwright routing, without collection or a browser.
test('detected_runners preserves Playwright and nested-package plan groups', () => {
  const root = scratch();
  write(root, 'package.json', JSON.stringify({ devDependencies: { vitest: '1', '@playwright/test': '1' } }));
  write(root, 'unit.test.ts', 'export {};\n');
  write(root, 'e2e/home.spec.ts', "import { test } from '@playwright/test';\ntest('home', () => {});\n");
  write(root, 'nested/package.json', JSON.stringify({ devDependencies: { vitest: '1' } }));
  write(root, 'nested/unit.test.ts', 'export {};\n');
  const files = ['unit.test.ts', 'e2e/home.spec.ts', 'nested/unit.test.ts'];
  const before = planRuns(context(root), files);
  expect(before.groups).toEqual([
    { runner: 'npx vitest run {files}', cwd: '', files: ['unit.test.ts'] },
    { runner: 'npx vitest run {files}', cwd: 'nested', files: ['unit.test.ts'] },
    { runner: 'npx playwright test --reporter=list {files}', cwd: '', files: ['e2e/home.spec.ts'] },
  ]);
  expect(planRuns(context(root, { vitest: override }), files)).toEqual({
    ...before, groups: [{ ...before.groups[0]!, runner: override }, ...before.groups.slice(1)],
  });
});

// C: invalid shapes retain the same command constraints and error namespace.
test.each([
  [null, 'detected_runners'], [[], 'detected_runners'], ['vitest', 'detected_runners'], [1, 'detected_runners'],
  [{ mocha: override }, 'detected_runners.mocha'],
  [{ vitest: 1 }, 'detected_runners.vitest'], [{ jest: null }, 'detected_runners.jest'],
  [{ bun: 'bun test' }, 'detected_runners.bun'], [{ vitest: '' }, 'detected_runners.vitest'],
  [{ vitest: 'run\n{files}' }, 'detected_runners.vitest'],
  [{ jest: 'x'.repeat(8193) + '{files}' }, 'detected_runners.jest'],
] as const)('detected_runners invalid shape %# reports its policy path', (value, at) => {
  expect(validateConfig({ detected_runners: value })).toEqual([
    { code: 'PREGATE_CONFIG_INVALID', path: at, message: expect.any(String) },
  ]);
});

test('detected_runners loads valid commands and rejects a non-null runner', () => {
  const detected_runners = { bun: override, vitest: override, jest: override };
  const loaded = parseConfig(JSON.stringify({ runner: null, detected_runners }));
  expect(loaded.errors).toEqual([]);
  expect(loaded.config.detected_runners).toEqual(detected_runners);
  expect(validateConfig({ runner: 'node --test {files}', detected_runners })).toEqual([
    { code: 'PREGATE_CONFIG_INVALID', path: 'detected_runners', message: 'cannot be combined with runner' },
  ]);
  expect(parseConfig('{}').config).not.toHaveProperty('detected_runners');
  expect(validateConfig({ detected_runners: {} })).toEqual([]);
});

// D: exercise the CLI's actual head-policy refusal code, as for runner.
test.each([undefined, { vitest: 'npx vitest run {files}' }])('head policy refuses added or changed detected_runners %#', (base) => {
  const repo = makeFixtureRepo({ pregate: { runner: null, ...(base ? { detected_runners: base } : {}) } });
  repos.push(repo);
  write(repo.work, '.gstack/pregate.json', JSON.stringify({ runner: null, detected_runners: { vitest: override } }));
  const r = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'preflight', '--policy-from', 'head']);
  expect(r.status).toBe(3);
  expect(r.err).toContain('PREGATE_HEAD_POLICY_LOOSENS');
  expect(r.err).toContain('detected_runners differs from the trusted policy');
});

// E: captured on original b483666ed before changing lib/checks.ts (empty root).
test('commandSet preserves the original absent-key hash and binds every override', () => {
  const root = scratch();
  const checks = [{ name: 'lint', command: 'echo lint', source: 'fixed' }];
  const config = { runner: null, selection: { 'ci/tests': 'node list.js' } };
  const original = '0589f03391530c14316af142897d1208f872fdf56ee79c1216780928af139dcc';
  expect(commandSet(root, checks, config)).toBe(original);
  const set = commandSet(root, checks, { ...config, detected_runners: { vitest: override } });
  expect(set).not.toBe(original);
  expect(commandSet(root, checks, { ...config, detected_runners: { vitest: override + ' --changed' } })).not.toBe(set);
  expect(commandSet(root, checks, { ...config, detected_runners: { jest: override } })).not.toBe(set);
  expect(commandSet(root, checks, { ...config, detected_runners: { vitest: override, jest: override } }))
    .toBe(commandSet(root, checks, { ...config, detected_runners: { jest: override, vitest: override } }));
  const state = path.join(root, 'state');
  recordTrust(root, set, checks, { ...config, detected_runners: { vitest: override } }, { GSTACK_STATE_ROOT: state });
  const grant = JSON.parse(fs.readFileSync(path.join(state, 'security/checks-trust-grants.jsonl'), 'utf8'));
  expect(grant.detected_runners).toEqual({ vitest: override });
});

// F: complete stdout captured before edits; only the fixture commit ID varies.
const originalDetect = 'CHECKS: tests only (no gstack:verify: line, Health Stack section or manifest check)\n'
  + 'TESTS pregate selection against origin/main (policy origin/main@REV:.gstack/pregate.json; runner detected per file)\n'
  + 'TRUST untrusted (run gstack-checks trust after the user agrees, or pass --allow-repo-commands)\n';
test('gstack-checks detect preserves absent-key output and shows all overrides before trust', () => {
  for (const detected_runners of [undefined, { vitest: override, bun: 'bun test --timeout=30000 {files}' }]) {
    const repo = makeFixtureRepo({ pregate: { runner: null, ...(detected_runners ? { detected_runners } : {}) } });
    repos.push(repo);
    const r = runBin(repo, 'gstack-checks', ['detect', '--base', 'main']);
    expect(r.status).toBe(0);
    expect(r.err).toBe('');
    const suffix = detected_runners ? `; bun via ${detected_runners.bun}; vitest via ${override}` : '';
    expect(r.out.replace(/origin\/main@[a-f0-9]{12}/g, 'origin/main@REV'))
      .toBe(originalDetect.replace('runner detected per file', 'runner detected per file' + suffix));
    if (detected_runners) {
      const refused = runBin(repo, 'gstack-checks', ['run', '--base', 'main']);
      expect(refused.status).toBe(3);
      expect(refused.err).toContain(`the runner pregate detects${suffix} on the files pregate selects`);
    }
  }
});
