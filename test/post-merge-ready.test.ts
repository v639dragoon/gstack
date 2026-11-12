/** Post-merge mode owns VERSION after merge; a train-free READY cannot allocate or stamp it. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CHECK_IDS } from '../lib/pregate/index';
import { classifyTrainHead } from '../crew/lib/version-gate-train';
import { BASE_POLICY, cleanup, makeFixtureRepo, makePr, restamp, runBin } from './helpers/restamp-fixture';
import { ghQueueShim } from './helpers/ship-queue-fixture';
import { shippedBody } from './helpers/ship-queue-train-fixture';
const root = path.resolve(import.meta.dir, '..');

test('without train, post-merge READY, queue stamp, restamp and version-gate leave VERSION untouched', () => {
  const repo = makeFixtureRepo();
  try {
    expect('train' in BASE_POLICY).toBe(false);
    fs.mkdirSync(path.join(repo.work, 'changelog.d'));
    fs.writeFileSync(path.join(repo.work, 'changelog.d/README.md'), 'post-merge mode\n');
    repo.git('add', '.'); repo.git('commit', '-qm', 'post-merge mode'); repo.git('push', '-q', 'origin', 'main');
    const head = makePr(repo, 'fragment', { changelog: false });
    const version = fs.readFileSync(path.join(repo.work, 'VERSION'), 'utf8');
    const mode = runBin(repo, 'gstack-version-mode', []);
    expect(mode.out.trim()).toBe('post-merge');
    expect(classifyTrainHead({ repoRoot: repo.work, baseRef: 'main', head })).toEqual({ kind: 'off' });
    const pregate = path.join(repo.root, 'pregate.json');
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree: runBin(repo, 'gstack-wtree', []).out.trim(), head, verdict: 'pass', checks: CHECK_IDS.map(id => ({ id, status: 'pass' })) }));
    const gh = ghQueueShim(repo, { prs: { '1': { headRefOid: head, body: shippedBody('1', head), headRefName: 'fragment' } }, checks: { [head]: { check_runs: [{ status: 'completed', conclusion: 'success' }] } } });
    const ready = runBin(repo, 'gstack-ship-queue', ['ready', '--pr', '1', '--base', 'main', '--pregate', pregate], gh);
    expect([ready.status, ready.err]).toEqual([0, '']);
    expect(ready.out).toStartWith(`READY #1 ${head} STAMP_VERSION=unstamped`);
    expect(repo.git('rev-parse', 'HEAD')).toBe(head);
    const next = path.join(repo.root, 'next.json');
    fs.writeFileSync(next, JSON.stringify({ version: '1.2.4.0', base_version: version.trim(), claimed: [{ pr: 2, branch: 'other-fragment', version: version.trim() }] }));
    const gate = spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', path.join(root, 'scripts/compare-pr-version.ts'), next, '1'], {
      cwd: repo.work, env: { ...process.env, ...repo.env, BASE_REF: 'main', HEAD_SHA: head, PR_VERSION: version.trim() }, encoding: 'utf8', timeout: 30_000,
    });
    const stamped = restamp(repo, ['--next']);
    const queued = runBin(repo, 'gstack-ship-queue', ['stamp', '--pr', '1', '--version', '1.2.4.0', '--base', 'main', '--expect-gated', head, '--expect-base', repo.git('rev-parse', 'origin/main'), '--allow-repo-commands']);
    expect(gate.status, gate.stdout + gate.stderr).toBe(0);
    expect(gate.stdout).toContain('post-merge');
    expect(stamped.status).not.toBe(0); expect(stamped.err).toContain('post-merge');
    expect(queued.status).not.toBe(0); expect(queued.err).toContain('post-merge');
    expect(fs.readFileSync(path.join(repo.work, 'VERSION'), 'utf8')).toBe(version);
    expect(repo.git('rev-parse', 'HEAD')).toBe(head);
    expect(repo.git('diff', '--name-only', 'HEAD')).toBe('');
  } finally { cleanup(repo); }
});
