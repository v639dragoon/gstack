import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { commandSet, recordTrust } from '../lib/checks';
import { lanesCheck, planRuns } from '../lib/pregate/checks/lanes';
import { parseConfig, validateConfig } from '../lib/pregate/config';
import { buildContext, sha256 } from '../lib/pregate/context';
import { cleanup, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const runner = 'node root.cjs {files}';
const detected_runners = { vitest: runner, jest: runner };
const fixture = (overlap_runners?: string[], baseFiles: Record<string, string> = {}) => {
  const repo = makeFixtureRepo({
    pregate: { runner: null, detected_runners, ...(overlap_runners === undefined ? {} : { overlap_runners }), serial_patterns: ['**/*.serial.test.*'] },
    baseFiles: {
      'package.json': JSON.stringify({ devDependencies: { vitest: '1' } }),
      'unit.test.ts': 'export {};\n',
      'last.serial.test.ts': 'export {};\n',
      'nested/package.json': JSON.stringify({ devDependencies: { jest: '1' } }),
      'nested/other.test.ts': 'export {};\n',
      ...baseFiles,
    },
  });
  repos.push(repo);
  return repo;
};

test.each([
  [null, 'array'], ['vitest', 'array'], [['mocha'], 'unknown'], [[1], 'unknown'],
  [['vitest', 'vitest'], 'duplicate'], [['bun'], 'detected_runners'],
] as const)('overlap_runners rejects invalid shape %# at its own path', (overlap_runners, problem) => {
  expect(validateConfig({ detected_runners, overlap_runners })).toEqual([
    { code: 'PREGATE_CONFIG_INVALID', path: 'overlap_runners', message: expect.stringContaining(problem) },
  ]);
});

test('overlap_runners parses declared tools; empty and missing arrays stay absent', () => {
  const loaded = parseConfig(JSON.stringify({ detected_runners, overlap_runners: ['vitest', 'jest'] }));
  expect(loaded.errors).toEqual([]);
  expect(loaded.config.overlap_runners).toEqual(['vitest', 'jest']);
  expect(parseConfig('{"overlap_runners":[]}').config).not.toHaveProperty('overlap_runners');
  expect(parseConfig('{}').config).not.toHaveProperty('overlap_runners');
  expect(validateConfig({ overlap_runners: ['vitest'] })[0]?.path).toBe('overlap_runners');
});

test.each([[undefined], [['jest']], [['vitest']]])('head policy refuses adding, changing or dropping overlap_runners %#', base => {
  const repo = fixture(base);
  write(repo.work, '.gstack/pregate.json', JSON.stringify({ runner: null, detected_runners, ...(base?.[0] === 'vitest' ? {} : { overlap_runners: ['vitest'] }), serial_patterns: ['**/*.serial.test.*'] }));
  const r = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'preflight', '--policy-from', 'head']);
  expect(r.status).toBe(3);
  expect(r.err).toContain('PREGATE_HEAD_POLICY_LOOSENS');
  expect(r.err).toContain('overlap_runners differs from the trusted policy');
});

test('command trust hashes overlap membership canonically and records it', () => {
  const repo = fixture();
  const config = { runner: null, detected_runners, selection: {} };
  const original = commandSet(repo.work, [], config);
  expect(commandSet(repo.work, [], { ...config, overlap_runners: [] })).toBe(original);
  const set = commandSet(repo.work, [], { ...config, overlap_runners: ['vitest'] });
  expect(set).not.toBe(original);
  expect(commandSet(repo.work, [], { ...config, overlap_runners: ['jest'] })).not.toBe(set);
  expect(commandSet(repo.work, [], { ...config, overlap_runners: ['jest', 'vitest'] }))
    .toBe(commandSet(repo.work, [], { ...config, overlap_runners: ['vitest', 'jest'] }));
  recordTrust(repo.work, set, [], { ...config, overlap_runners: ['vitest'] }, repo.env);
  const grant = JSON.parse(fs.readFileSync(path.join(repo.home, 'security/checks-trust-grants.jsonl'), 'utf8'));
  expect(grant.overlap_runners).toEqual(['vitest']);
});

// Drive the real selector, planner and supervisor; the npx shim is owned by this
// fixture and replaces only the nested package's runner, with no browser needed.
function context(repo: FixtureRepo, files = ['unit.test.ts', 'nested/other.test.ts']) {
  write(repo.root, 'shim/npx', '#!/bin/sh\nexec node "$FIXTURE_ROOT/other.cjs" "$@"\n');
  fs.chmodSync(path.join(repo.root, 'shim/npx'), 0o755);
  const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: true,
    env: { ...process.env, ...repo.env, PATH: `${repo.root}/shim:${process.env.PATH}`, FIXTURE_ROOT: repo.work },
    cores: 16, testBackend: 'local', progress: () => {} });
  if (!('ctx' in loaded)) throw new Error(JSON.stringify(loaded));
  // These local-run tests have no CI/platform obligations.
  loaded.ctx.lanes = [];
  loaded.ctx.touched = files.map(p => ({ path: p, status: 'M' as const, uncommitted: true }));
  loaded.ctx.timeoutMs = 10_000;
  loaded.ctx.stallTimeoutMs = 0;
  return loaded.ctx;
}
const normalRoot = "console.log('ROOT env=' + (process.env.GSTACK_PREGATE_OVERLAP || 'absent')); console.log('1 pass');\n";
const normalOther = "const fs = require('fs'); fs.writeFileSync(process.env.FIXTURE_ROOT + '/marker', 'done'); console.log('OTHER env=' + (process.env.GSTACK_PREGATE_OVERLAP || 'absent')); console.log('1 pass');\n";
async function lane(repo: FixtureRepo, files?: string[]) {
  const ctx = context(repo, files);
  const result = await lanesCheck.run(ctx);
  const logPath = path.join(ctx.scratch, 'lanes/lanes.log');
  return { result, log: fs.readFileSync(logPath, 'utf8'), dir: path.dirname(logPath), ctx };
}

test('plan marks matching root groups only, preserving nested and Playwright routing', () => {
  const repo = fixture(['vitest'], { 'home.spec.ts': "import { test } from '@playwright/test';\n" });
  const ctx = context(repo);
  expect(planRuns(ctx, ['unit.test.ts', 'nested/other.test.ts', 'home.spec.ts']).groups).toEqual([
    { runner, cwd: '', files: ['unit.test.ts'], overlap: true },
    { runner: 'npx jest {files}', cwd: 'nested', files: ['other.test.ts'] },
    { runner: 'npx playwright test --reporter=list {files}', cwd: '', files: ['home.spec.ts'] },
  ]);
});

test('overlap starts before the other track and sees its marker; log and command retain plan order', async () => {
  // Each side waits for the other's file, so both run at once: overlap-first-then-serial and serial-first-then-overlap both fail.
  const repo = fixture(['vitest'], {
    'root.cjs': "const fs = require('fs'); fs.writeFileSync('root-started', 'yes'); (async () => { const end = Date.now()+3000; while (!fs.existsSync('marker') && Date.now()<end) await new Promise(r=>setTimeout(r,20)); console.log('SAW=' + fs.existsSync('marker')); " + normalRoot + "})();\n",
    'other.cjs': "const nodeFs = require('fs'); (async () => { const started = process.env.FIXTURE_ROOT + '/root-started'; const end = Date.now()+3000; while (!nodeFs.existsSync(started) && Date.now()<end) await new Promise(r=>setTimeout(r,20)); console.log('OTHER_SAW_ROOT=' + nodeFs.existsSync(started)); " + normalOther + "})();\n",
  });
  const { result, log, dir } = await lane(repo);
  expect(result.status).toBe('pass');
  expect(log).toContain('SAW=true');
  expect(log).toContain('OTHER_SAW_ROOT=true');
  expect(log).toContain('ROOT env=1');
  expect(log).toContain('OTHER env=absent');
  expect(log.indexOf('$ node root.cjs')).toBeLessThan(log.indexOf('$ npx jest'));
  expect(result.inputs.command).toBe(sha256("node root.cjs 'unit.test.ts' && (cd 'nested' && npx jest 'other.test.ts')"));
  expect(result.lines).toContain(`overlap: ${runner} ran beside the other groups`);
  expect(fs.readFileSync(path.join(dir, 'lanes-overlap-1.log'), 'utf8')).toContain('SAW=true');
}, 20_000);

test('exit 75 retries after the other group without env and replaces the zero-run verdict', async () => {
  const repo = fixture(['vitest'], {
    'root.cjs': "const fs = require('fs'); if(process.env.GSTACK_PREGATE_OVERLAP) { console.log('no tests ran'); process.exit(75); } if(!fs.existsSync('marker')) process.exit(9); " + normalRoot,
    'other.cjs': normalOther,
  });
  const { result, log } = await lane(repo);
  expect(result.status).toBe('pass');
  expect(result.detail).toContain('2 tests ran');
  expect(result.lines).toContain(`overlap: ${runner} exited 75 (nothing ran) and re-ran after the other groups`);
  expect(log).toBe("$ node root.cjs 'unit.test.ts'\nno tests ran\n$ node root.cjs 'unit.test.ts'\nROOT env=absent\n1 pass\n$ npx jest 'other.test.ts'\nOTHER env=absent\n1 pass\n");
  expect(result.inputs.command).toBe(sha256("node root.cjs 'unit.test.ts' && (cd 'nested' && npx jest 'other.test.ts')"));
}, 20_000);

test('without the key log bytes and command match the original sequential contract', async () => {
  const repo = fixture(undefined, { 'root.cjs': normalRoot, 'other.cjs': normalOther });
  const { result, log, dir } = await lane(repo);
  expect(result.status).toBe('pass');
  expect(log).toBe("$ node root.cjs 'unit.test.ts'\nROOT env=absent\n1 pass\n$ npx jest 'other.test.ts'\nOTHER env=absent\n1 pass\n");
  expect(result.inputs.command).toBe(sha256("node root.cjs 'unit.test.ts' && (cd 'nested' && npx jest 'other.test.ts')"));
  expect(result.lines?.some(l => l.startsWith('overlap:'))).toBe(false);
  expect(fs.readdirSync(dir)).toEqual(['lanes.log']);
}, 20_000);

test('only overlap groups keep normal env and original log bytes, including serial files', async () => {
  const repo = fixture(['vitest'], { 'root.cjs': normalRoot });
  const { result, log, dir } = await lane(repo, ['unit.test.ts', 'last.serial.test.ts']);
  expect(result.status).toBe('pass');
  expect(log).toBe("$ node root.cjs 'unit.test.ts'\nROOT env=absent\n1 pass\n$ node root.cjs 'last.serial.test.ts'\nROOT env=absent\n1 pass\n");
  expect(fs.readdirSync(dir)).toEqual(['lanes.log']);
  expect(result.lines?.some(l => l.startsWith('overlap:'))).toBe(false);
}, 20_000);

test.each(['root', 'other'])('a %s track failure waits for the other track and keeps non-75 exits final', async failing => {
  const repo = fixture(['vitest'], {
    'root.cjs': "setTimeout(() => { " + normalRoot + `process.exit(${failing === 'root' ? 9 : 0}); }, 100);\n`,
    'other.cjs': "setTimeout(() => { " + normalOther + `process.exit(${failing === 'other' ? 8 : 0}); }, 100);\n`,
  });
  const { result, log } = await lane(repo);
  expect(result.status).toBe('fail');
  expect(log).toContain('ROOT env=1');
  expect(log).toContain('OTHER env=absent');
  expect(log.match(/^\$ /gm)).toHaveLength(2);
}, 20_000);

test('overlap unit and serial invocations stay sequential and have separate retained logs', async () => {
  const repo = fixture(['vitest'], {
    'root.cjs': "const fs=require('fs'); const file=process.argv[2]; if(file.includes('serial') && !fs.existsSync('unit-done')) process.exit(8); fs.writeFileSync('unit-done','yes'); " + normalRoot,
    'other.cjs': normalOther,
  });
  const { result, log, dir } = await lane(repo, ['unit.test.ts', 'last.serial.test.ts', 'nested/other.test.ts']);
  expect(result.status).toBe('pass');
  expect(log.match(/^\$ /gm)).toHaveLength(3);
  expect(fs.readdirSync(dir).sort()).toEqual(['lanes-overlap-1.log', 'lanes-overlap-2.log', 'lanes.log']);
  expect(log.indexOf("$ node root.cjs 'last.serial.test.ts'")).toBeLessThan(log.indexOf('$ npx jest'));
}, 20_000);

test('detect and untrusted command output show overlap policy', () => {
  const repo = fixture(['vitest']);
  const detect = runBin(repo, 'gstack-checks', ['detect', '--base', 'main']);
  expect(detect.status).toBe(0);
  expect(detect.out).toContain('; overlap_runners: vitest');
  const refused = runBin(repo, 'gstack-checks', ['run', '--base', 'main']);
  expect(refused.status).toBe(3);
  expect(refused.err).toContain('; overlap_runners: vitest');
});
