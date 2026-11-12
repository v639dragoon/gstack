/** Cross-tree reuse is exercised through real Git trees and a runner that records every file it receives. */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_SCHEMAS, checkSchema, type PregateFile, type ValidationError } from '../lib/headless-artifacts';
import { buildContext } from '../lib/pregate/context';
import { readPregateFile, runPregate, writePregateFile } from '../lib/pregate/index';
import { priorReuse, isPriorIdentityInput, matchPriorRunners, runnerKey, samePolicy } from '../lib/pregate/prior-reuse';
import type { PregateContext } from '../lib/pregate/types';
import type { ApiRun, RunProfile, RunSource } from '../lib/run-evidence';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const savedRoot = process.env.GSTACK_STATE_ROOT;
const KEY = '\tnode scripts/record-run.cjs {files}';
const byRunner = (files: string[]) => ({ [KEY]: files });
const ALL = ['test/nightly/retry-heavy.test.js', 'test/retry.test.js', 'test/util.test.js'];
afterEach(() => {
  while (repos.length) cleanup(repos.pop()!);
  if (savedRoot === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = savedRoot;
});

function fixture(always = false): FixtureRepo {
  const repo = makeFixtureRepo({
    pregate: { ...BASE_PREGATE, dependencies: { ...BASE_PREGATE.dependencies, 'bunfig.toml': [] }, runner: 'node scripts/record-run.cjs {files}', local: ['free-tests.yml/unit'] },
    baseFiles: {
      'scripts/record-run.cjs': `const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const files = process.argv.slice(2);
fs.appendFileSync('../calls.jsonl', JSON.stringify(files) + '\\n');
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', timeout: 10000 });
process.exit(process.env.PRIOR_RUN_MODE === 'fail' ? 1 : r.status ?? 1);
`,
      ...(always ? { '.gstack/always-run.json': JSON.stringify({ tests: ['test/tool-cli.test.js'] }) } : {}),
    },
  });
  repos.push(repo);
  process.env.GSTACK_STATE_ROOT = repo.home;
  commit(repo, {
    'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n',
    'lib/retry.js': 'exports.MAX_RETRIES = 3;\nexports.TIMEOUT_MS = 5000;\nexports.retry = (fn) => fn();\nexports.touched = true;\n',
  });
  return repo;
}
const output = (repo: FixtureRepo) => path.join(repo.work, '.gstack/tmp/pregate.json');
const calls = (repo: FixtureRepo): string[][] => fs.existsSync(path.join(repo.root, 'calls.jsonl')) ? fs.readFileSync(path.join(repo.root, 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
const lanes = (file: PregateFile) => file.checks.find(c => c.id === 'lanes')!;
function context(repo: FixtureRepo, env: NodeJS.ProcessEnv = {}): PregateContext {
  const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: true, env: { ...process.env, ...repo.env, ...env }, progress: () => {}, cores: 16, testBackend: 'local' });
  if (!('ctx' in loaded)) throw new Error('fixture context refused');
  loaded.ctx.ciCarry = false;
  return loaded.ctx;
}
async function run(repo: FixtureRepo, modify: (ctx: PregateContext) => void = () => {}, out = output(repo)) {
  const ctx = context(repo, fs.existsSync(path.join(repo.root, 'private-objects')) ? { GSTACK_WTREE_OBJECT_DIR: path.join(repo.root, 'private-objects') } : {});
  const progress: string[] = [];
  ctx.progress = l => progress.push(l);
  modify(ctx);
  const file = await runPregate(ctx, { stage: 'tests', out });
  writePregateFile(repo.work, out, file);
  return { file, check: lanes(file), progress };
}
function save(repo: FixtureRepo, file: PregateFile) { writePregateFile(repo.work, output(repo), file); }
function reason(check: PregateFile['checks'][number], value: string) {
  expect(check.lines).toContainEqual(expect.stringMatching(new RegExp(`^REUSE: refused reason=${value} — .*; every selected test runs here$`)));
}
function schema(file: unknown) {
  const errors: ValidationError[] = [];
  checkSchema(JSON.parse(JSON.stringify(file)), ARTIFACT_SCHEMAS.pregate, '', errors, 'pregate.json');
  return errors;
}

// Windows has only minimal platform support; these process/Git fixtures match pregate-from-run's supported platforms.
describe.skipIf(process.platform === 'win32')('the previous local pass', () => {
  test('a docs-only commit reuses every file without invoking the runner, then an import delta reruns exactly its test', async () => {
    const repo = fixture();
    const first = await run(repo);
    expect(first.check.status).toBe('pass');
    expect(first.check.passed_by_runner).toEqual(byRunner(ALL));
    expect(calls(repo)).toEqual([ALL]);
    commit(repo, { 'docs/README.md': '# new docs\n' });
    const docs = await run(repo);
    expect(docs.check.status).toBe('pass');
    expect(docs.check.detail).toContain(`3 local test file(s) reused from prior tree ${first.file.tree.slice(0, 12)}`);
    expect(docs.check.from_prior).toEqual({ tree: first.file.tree, files: ALL, delta: ['docs/README.md'] });
    expect(docs.progress).toContain(`REUSE: accepted 3 of 3 selected local test file(s) from the prior pass at tree ${first.file.tree.slice(0, 12)}; 0 still run (delta 1 path(s), 0 selected)`);
    expect(docs.check.lines?.some(l => l.startsWith('ran: '))).toBe(false);
    expect(calls(repo)).toEqual([ALL]);
    commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0 + 0;\n' });
    const third = await run(repo);
    expect(third.check.from_prior).toEqual({ tree: docs.file.tree, files: ALL.slice(0, 2), delta: ['lib/util.js'] });
    expect(third.check.passed_by_runner).toEqual(byRunner(ALL));
    expect(calls(repo)).toEqual([ALL, ['test/util.test.js']]);
    expect(third.check.status).toBe('pass');
    expect(schema(third.file)).toEqual([]);
  }, 120_000);

  test('an empty delta reuses always-run tests, while a docs delta reruns the base-unioned always-run tests', async () => {
    const repo = fixture(true);
    const all = [...ALL, 'test/tool-cli.test.js'].sort();
    const first = await run(repo);
    expect(first.check.passed_by_runner).toEqual(byRunner(all));
    const same = await run(repo);
    expect(same.check.from_prior?.files).toEqual(all);
    expect(same.check.passed_by_runner).toEqual(first.check.passed_by_runner);
    expect(calls(repo)).toEqual([all]);
    commit(repo, { 'docs/README.md': '# docs changed\n' });
    const next = await run(repo);
    expect(next.check.from_prior?.files).toEqual(ALL);
    expect(next.check.passed_by_runner).toEqual(byRunner(all));
    expect(calls(repo)).toEqual([all, ['test/tool-cli.test.js']]);
  }, 120_000);

  const refusals: Array<[string, (repo: FixtureRepo, prior: PregateFile) => void]> = [
    ['no_prior', (_repo, prior) => { delete lanes(prior).passed_by_runner; }],
    ['policy_changed', (_repo, prior) => { prior.policy += ' changed'; }],
    ['policy_changed', (_repo, prior) => { prior.policy_digest = 'changed'; }],
    ['policy_changed', (_repo, prior) => { prior.base = 'origin/other@abcdef123456'; }],
    ['runtime_changed', (_repo, prior) => { lanes(prior).inputs!.runtime = 'another runtime'; }],
    ['runtime_changed', (_repo, prior) => { delete lanes(prior).inputs!.runtime; }],
    ['tree_unavailable', (_repo, prior) => { prior.tree = 'f'.repeat(40); }],
    ['delta_deletes', repo => { commit(repo, { 'docs/README.md': null }); }],
    ['identity_input', repo => { commit(repo, { 'bunfig.toml': '# changed\n' }); }],
    ['delta_no_lane', repo => { commit(repo, { 'lib/unknown.js': 'exports.noLane = true;\n' }); }],
  ];
  for (const [index, [expected, change]] of refusals.entries()) {
    test(`refusal ${index + 1}: ${expected} runs the full selection`, async () => {
      const repo = fixture();
      const first = await run(repo);
      change(repo, first.file);
      save(repo, first.file);
      // Keep the unknown delta a warning so the original selected files still run and the refusal can be observed.
      const next = await run(repo, ctx => { if (expected === 'delta_no_lane') ctx.config.warn.push('lanes'); });
      reason(next.check, expected);
      expect(next.check.from_prior).toBeUndefined();
      expect(calls(repo)).toEqual([ALL, ALL]);
    }, 120_000);
  }

  // Value: protects=a base that moved (another session fetched origin) without touching the policy file keeps reuse;
  //   fails_when=the policy check compares the label's base commit instead of the policy blob; why_new=every dohma
  //   worktree shares origin/main, which a launchd job refreshes every 15 minutes; seam=the recorded label; no_claim=a real fetch
  test('a prior label naming another base commit with the same policy blob still reuses', async () => {
    const repo = fixture();
    const first = await run(repo);
    expect(first.file.policy).toMatch(/@[0-9a-f]{7,40}:/);
    const other = repo.git('rev-parse', 'HEAD').trim().slice(0, 12);
    first.file.policy = first.file.policy!.replace(/@[0-9a-f]{7,40}:/, `@${other}:`);
    save(repo, first.file);
    commit(repo, { 'docs/README.md': '# moved base\n' });
    const next = await run(repo);
    expect(next.check.from_prior).toEqual({ tree: first.file.tree, files: ALL, delta: ['docs/README.md'] });
    expect(calls(repo)).toEqual([ALL]);
  }, 120_000);

  test('missing, invalid JSON, schema-invalid and unreadable output paths are no_prior', async () => {
    const repo = fixture();
    for (const text of [null, '{', JSON.stringify({ schema_version: 1, tree: 'bad', checks: [{ id: 'lanes', status: 'pass', passed_by_runner: [12] }] })]) {
      fs.mkdirSync(path.dirname(output(repo)), { recursive: true });
      if (text === null) fs.rmSync(output(repo), { force: true }); else fs.writeFileSync(output(repo), text);
      const next = await run(repo);
      reason(next.check, 'no_prior');
    }
    fs.rmSync(output(repo));
    fs.mkdirSync(output(repo)); // readFileSync cannot read a directory, including when the test runs as root.
    const file = await runPregate(context(repo), { stage: 'tests' });
    reason(lanes(file), 'no_prior');
    expect(calls(repo)).toEqual([ALL, ALL, ALL, ALL]);
  }, 120_000);

  test('a current uncommitted fingerprint is unavailable in the real object store', async () => {
    const repo = fixture();
    await run(repo);
    fs.writeFileSync(path.join(repo.work, 'docs/README.md'), '# uncommitted\n');
    const objects = path.join(repo.root, 'private-objects');
    fs.mkdirSync(objects);
    const next = await run(repo, ctx => { ctx.env.GSTACK_WTREE_OBJECT_DIR = objects; });
    reason(next.check, 'tree_unavailable');
    expect(calls(repo)).toEqual([ALL, ALL]);
  }, 120_000);

  test('failed and incomplete runs record no passed_by_runner and cannot seed reuse', async () => {
    const repo = fixture();
    await run(repo);
    const failed = await run(repo, ctx => { ctx.priorReuse = false; ctx.env.PRIOR_RUN_MODE = 'fail'; });
    expect(failed.check.status).toBe('fail');
    expect(failed.check.passed_by_runner).toBeUndefined();
    const afterFail = await run(repo);
    reason(afterFail.check, 'no_prior');
    const incomplete = await run(repo, ctx => { ctx.priorReuse = false; ctx.allowRepoCommands = false; });
    expect(incomplete.check.status).toBe('incomplete');
    expect(incomplete.check.passed_by_runner).toBeUndefined();
    const afterIncomplete = await run(repo);
    reason(afterIncomplete.check, 'no_prior');
    expect(calls(repo)).toEqual([ALL, ALL, ALL, ALL]);
  }, 120_000);

  test('custom --out reads its own prior and --no-prior-reuse reruns the entire selection', async () => {
    const repo = fixture();
    const out = path.join(repo.work, '.gstack/tmp/custom.json');
    const first = runBin(repo, 'gstack-pregate', ['--base', 'main', '--stage', 'tests', '--out', out, '--no-ci-carry', '--allow-repo-commands']);
    expect(first.status).toBe(0);
    expect(readPregateFile(out).file?.checks[0]?.passed_by_runner).toEqual(byRunner(ALL));
    commit(repo, { 'docs/README.md': '# custom output\n' });
    const reused = runBin(repo, 'gstack-pregate', ['--base', 'main', '--stage', 'tests', '--out', out, '--no-ci-carry', '--allow-repo-commands']);
    expect(reused.status).toBe(0);
    expect(readPregateFile(out).file?.checks[0]?.from_prior?.files).toEqual(ALL);
    expect(calls(repo)).toEqual([ALL]);
    const opted = runBin(repo, 'gstack-pregate', ['--base', 'main', '--stage', 'tests', '--out', out, '--no-ci-carry', '--no-prior-reuse', '--allow-repo-commands']);
    expect(opted.status).toBe(0);
    reason(lanes(readPregateFile(out).file!), 'opted_out');
    expect(calls(repo)).toEqual([ALL, ALL]);
    expect(fs.existsSync(output(repo))).toBe(false);
  }, 120_000);

  test('--from-run goes first and combines with prior evidence without invoking a runner', async () => {
    const repo = fixture();
    const first = await run(repo);
    // Only retry files have local evidence; the CI run covers util at the current tree.
    lanes(first.file).passed_by_runner = byRunner(ALL.slice(0, 2));
    save(repo, first.file);
    commit(repo, { 'docs/README.md': '# from run plus prior\n' });
    const head = repo.git('rev-parse', 'HEAD');
    const profile: RunProfile = { workflow: 'free-tests.yml', events: ['workflow_dispatch'], jobs: ['unit'], artifact: 'tested-tree', os: process.platform === 'darwin' ? 'macOS' : 'Linux' };
    const api: ApiRun = { id: 100, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: head, path: '.github/workflows/free-tests.yml', created_at: '2026-10-30T10:00:00Z', updated_at: '2026-10-30T10:30:00Z', repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' } };
    const source: RunSource = { repo: 'fx/fx', profiles: { local: profile }, now: new Date('2026-10-30T12:00:00Z'), deps: {
      run: () => api, runsForHead: () => [api], jobs: () => [{ name: 'unit', conclusion: 'success' }],
      artifact: () => ({ run_id: 100, run_attempt: 1, event: 'workflow_dispatch', sha: head, head_sha: head, tree: repo.git('rev-parse', 'HEAD^{tree}'), os: [profile.os!], files: ['test/util.test.js'], tests: 1 }),
      commitTree: sha => repo.git('rev-parse', `${sha}^{tree}`),
    } };
    // Match the existing fromRunProfiles contract: this fixture's unit lane is platform-classed on macOS.
    const next = await run(repo, ctx => { ctx.lanes = ctx.lanes.map(l => l.id === 'free-tests.yml/unit' ? { ...l, tier: 'unit' } : l); ctx.fromRun = { ref: '100', check: source }; });
    expect(next.check.status).toBe('pass');
    expect(next.check.from_run?.files).toEqual(['test/util.test.js']);
    expect(next.check.from_prior?.files).toEqual(ALL.slice(0, 2));
    expect(next.check.passed_by_runner).toEqual(byRunner(ALL.slice(0, 2)));
    expect(calls(repo)).toEqual([ALL]);
    commit(repo, { 'docs/README.md': '# CI files have no local runner key\n' });
    const later = await run(repo);
    expect(later.check.from_prior?.files).toEqual(ALL.slice(0, 2));
    expect(later.check.passed_by_runner).toEqual(byRunner(ALL));
    expect(calls(repo)).toEqual([ALL, ['test/util.test.js']]);
  }, 120_000);

  test('a record holding only legacy passed_files refuses no_prior', async () => {
    const repo = fixture();
    const first = await run(repo);
    delete first.check.passed_by_runner;
    Object.assign(first.check, { passed_files: ALL });
    save(repo, first.file);
    const next = await run(repo);
    reason(next.check, 'no_prior');
    expect(calls(repo)).toEqual([ALL, ALL]);
    expect(next.check.passed_by_runner).toEqual(byRunner(ALL));
  }, 120_000);

  test('FVM appearing reruns only its package; a later missing-tool gap reuses nothing', async () => {
    const repo = makeFixtureRepo({ pregate: { dependencies: { 'docs/**': [] }, selection: BASE_PREGATE.selection, local: ['free-tests.yml/unit'] }, baseFiles: {
      'packages/a/pubspec.yaml': 'name: a\n',
      'packages/a/.fvmrc': '{"flutter":"3.24.0"}\n',
      'packages/a/lib/a.dart': 'int a() => 1;\n',
      'packages/a/test/a_test.dart': "import '../lib/a.dart';\nvoid main() {}\n",
      'packages/b/pubspec.yaml': 'name: b\ndependencies:\n  flutter:\n    sdk: flutter\n',
      'packages/b/lib/b.dart': 'int b() => 1;\n',
      'packages/b/test/b_test.dart': "import '../lib/b.dart';\nvoid main() {}\n",
    } });
    repos.push(repo);
    process.env.GSTACK_STATE_ROOT = repo.home;
    commit(repo, { 'packages/a/lib/a.dart': 'int a() => 2;\n', 'packages/b/lib/b.dart': 'int b() => 2;\n' });
    const bin = path.join(repo.root, 'shim');
    fs.mkdirSync(bin);
    // Exclude ambient SDKs and FVM while keeping the actual launcher and Git tools available.
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) if (!['fvm', 'dart', 'flutter'].includes(name) && !fs.lstatSync(path.join(bin, name), { throwIfNoEntry: false })) fs.symlinkSync(path.join(dir, name), path.join(bin, name));
    }
    const log = path.join(repo.root, 'package-calls.jsonl');
    const script = path.join(repo.root, 'sdk.cjs');
    fs.writeFileSync(script, `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.argv[2], args: process.argv.slice(3) }) + '\\n');
console.log('00:01 +1: All tests passed!');
`);
    for (const tool of ['dart', 'flutter']) fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\nexec '${Bun.which('node')!}' '${script}' "$PWD" "$@"\n`, { mode: 0o755 });
    const bashEnv = path.join(repo.root, 'path.sh');
    fs.writeFileSync(bashEnv, `PATH='${bin}'\n`);
    const env = (ctx: PregateContext) => { ctx.env.PATH = bin; ctx.env.BASH_ENV = bashEnv; };
    const first = await run(repo, env);
    expect(first.check.status).toBe('pass');
    const a = 'packages/a/test/a_test.dart', b = 'packages/b/test/b_test.dart';
    expect(first.check.passed_by_runner).toEqual({ 'packages/a\tdart test {files}': [a], 'packages/b\tflutter test {files}': [b] });
    fs.writeFileSync(path.join(bin, 'fvm'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
    const next = await run(repo, env);
    expect(next.check.status).toBe('pass');
    expect(next.file.tree).toBe(first.file.tree);
    expect(next.check.from_prior?.files).toEqual([b]);
    expect(next.check.lines?.join('\n')).toContain('; 1 candidate(s) rerun because their runner changed');
    expect(next.check.passed_by_runner).toEqual({ 'packages/a\tfvm dart test {files}': [a], 'packages/b\tflutter test {files}': [b] });
    const recorded = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(recorded().map(c => path.basename(c.cwd))).toEqual(['a', 'b', 'a']);
    fs.rmSync(path.join(bin, 'flutter'));
    const gap = await run(repo, env);
    expect(gap.check.status).toBe('incomplete');
    expect(gap.check.cause).toBe('environment');
    expect(gap.check.from_prior).toBeUndefined();
    expect(gap.check.passed_by_runner).toBeUndefined();
    expect(recorded().map(c => path.basename(c.cwd))).toEqual(['a', 'b', 'a', 'a']);
  }, 120_000);

  test('schema accepts optional evidence and old records; bad evidence is rejected', async () => {
    const repo = fixture();
    const { file } = await run(repo);
    lanes(file).from_prior = { tree: file.tree, files: ALL, delta: [] };
    expect(schema(file)).toEqual([]);
    delete lanes(file).passed_by_runner;
    delete lanes(file).from_prior;
    expect(schema(file)).toEqual([]);
    lanes(file).from_prior = { tree: file.tree, files: ALL } as any;
    expect(schema(file).length).toBeGreaterThan(0);
  }, 120_000);
});

test('samePolicy: exact labels, or one policy blob across two base commits; anything else differs', () => {
  const label = (sha: string, file = '.gstack/pregate.json', ref = 'origin/main') => `${ref}@${sha}:${file}`;
  const blobs: Record<string, string> = { 'aaaaaaaaaaaa:.gstack/pregate.json': 'blob1\n', 'bbbbbbbbbbbb:.gstack/pregate.json': 'blob1\n', 'cccccccccccc:.gstack/pregate.json': 'blob2\n' };
  const seen: string[][] = [];
  const git = (args: string[]) => { seen.push(args); return blobs[args.at(-1)!] ?? null; };
  const unexpected = () => { throw new Error('git must not be called'); };
  expect(samePolicy(label('aaaaaaaaaaaa'), label('aaaaaaaaaaaa'), unexpected)).toBe(true);
  expect(samePolicy(label('aaaaaaaaaaaa'), label('bbbbbbbbbbbb'), git)).toBe(true);
  expect(samePolicy(label('aaaaaaaaaaaa'), label('cccccccccccc'), git)).toBe(false);
  expect(samePolicy(label('dddddddddddd'), label('aaaaaaaaaaaa'), git)).toBe(false);
  expect(seen.every(a => a[0] === 'rev-parse' && a.includes('--verify'))).toBe(true);
  expect(samePolicy(label('aaaaaaaaaaaa'), label('bbbbbbbbbbbb', 'other.json'), unexpected)).toBe(false);
  expect(samePolicy(label('aaaaaaaaaaaa'), label('bbbbbbbbbbbb', undefined, 'origin/dev'), unexpected)).toBe(false);
  expect(samePolicy('user /a/pregate.json', 'user /b/pregate.json', unexpected)).toBe(false);
  expect(samePolicy(undefined, label('aaaaaaaaaaaa'), unexpected)).toBe(false);
});

test('opt-out does no git, selection or always-run reads', () => {
  const unexpected = () => { throw new Error('reader must not be called'); };
  expect(priorReuse({ enabled: false, policy: '', base: '', tree: '', runtime: '', localTests: ALL }, { git: unexpected, select: unexpected, always: unexpected })).toMatchObject({ ok: false, reason: 'opted_out' });
});

test('identity guard includes evidence-bundle inputs and nested runner/package configuration', () => {
  for (const name of ['bun.lock', 'Pipfile.lock', 'pubspec.lock', 'packages.lock.json', 'Cargo.lock', 'uv.lock', 'Gemfile.lock', 'go.sum', '.node-version', '.tool-versions', 'package.json', 'packages/a/package.json', 'packages/a/pnpm-lock.yaml', 'nested/bunfig.toml', 'nested/tsconfig.build.json', 'vitest.config.ts', 'jest.config.cjs', 'playwright.config.mts', 'playwright.job-workspace.config.mts', '.gstack/always-run.json', '.github/workflows/free-tests.yml']) expect([name, isPriorIdentityInput(name)]).toEqual([name, true]);
  expect(isPriorIdentityInput('docs/README.md')).toBe(false);
});

test('Playwright config changes are compared in the post-planning helper, per file', () => {
  const old = { cwd: 'web', runner: "npx playwright test -c 'playwright.a.config.ts' --reporter=list {files}", files: ['e2e/a.spec.ts'] };
  const current = { ...old, runner: "npx playwright test -c 'playwright.b.config.ts' --reporter=list {files}" };
  const other = { cwd: 'api', runner: 'bun test {files}', files: ['test/api.test.ts'] };
  const prior: PregateFile = { schema_version: 1, tree: 'a'.repeat(40), checks: [{ id: 'lanes', status: 'pass', passed_by_runner: {
    [runnerKey(old)]: ['web/e2e/a.spec.ts'], [runnerKey(other)]: ['api/test/api.test.ts'],
  } }] };
  const candidates = { ok: true as const, candidates: ['web/e2e/a.spec.ts', 'api/test/api.test.ts'], deltaSelected: [], delta: [] };
  const match = matchPriorRunners(prior, candidates, [current, other], 2);
  expect(match.groups).toEqual([current]);
  expect(match.reused).toEqual(['api/test/api.test.ts']);
  expect(match.line).toContain('; 1 candidate(s) rerun because their runner changed');
  expect(match.passedByRunner).toEqual({ [runnerKey(current)]: ['web/e2e/a.spec.ts'], [runnerKey(other)]: ['api/test/api.test.ts'] });
});
