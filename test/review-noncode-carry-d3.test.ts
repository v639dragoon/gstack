/** C3 is intentionally independent of the earlier pass trims. */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = join(import.meta.dir, '..'), dirs: string[] = [];
function fixture(enabled = true, extra: any = {}) {
  const d = mkdtempSync(join(tmpdir(), 'carry-')), s = mkdtempSync(join(tmpdir(), 'carrys-')); dirs.push(d, s);
  const env = { ...process.env, GSTACK_HOME: s, GSTACK_STATE_DIR: s, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const cmd = (bin: string, args: string[]) => spawnSync(bin, args, { cwd: d, env, encoding: 'utf8', timeout: 30_000 });
  const cli = (name: string, ...args: string[]) => cmd(join(root, 'bin', name), args);
  const git = (...args: string[]) => { const r = cmd('git', args); expect(r.status, r.stderr).toBe(0); return r.stdout.trim(); };
  const write = (p: string, text = 'x\n') => { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), text); };
  const policy = { version: 1, auth_surfaces: ['lib/auth/**'], d_surfaces: ['danger/**'],
    routing: { passes: { ...(enabled ? { non_code_delta: true } : {}), native_adversarial: false } }, ...extra };
  git('init', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'T');
  write('.gstack-policy.json', JSON.stringify(policy)); write('x.ts'); write('README.md'); write('test/old.test.ts');
  write('VERSION', '1.0.0\n'); write('package.json', '{"version":"1.0.0","scripts":{"test":"x"}}'); git('add', '.'); git('commit', '-m', 'seed');
  const wtree = () => cli('gstack-wtree').stdout.trim();
  const makePlan = () => {
    const mp = join(s, 'manifest.json'); writeFileSync(mp, JSON.stringify({ run_id: 'run', wtree: wtree(), base: 'main',
      files: [{ path: 'x.ts' }], scope: {}, policy: { path: '.gstack-policy.json', sha256: createHash('sha256').update(JSON.stringify(policy)).digest('hex') },
      routing: { risk_tier: 'C', tier_source: 'policy', auth_surface_matches: [], outcome: { present: true, is_final_slice: false } } }));
    const r = cli('gstack-review-budget', 'plan', mp, '--json'); expect(r.status, r.stderr).toBe(0); return JSON.parse(r.stdout);
  };
  const plan = makePlan();
  const verdict = (gate: string, v = 'clean') => {
    expect(cli('gstack-review-budget', 'dispatch', 'run', gate).status).toBe(0);
    expect(cli('gstack-review-budget', 'verdict', 'run', gate, v).status).toBe(0);
  };
  const reviewers = (v = 'clean') => { for (const r of plan.reviewers) verdict(r.gate, v); };
  const log = (skill = 'review') => {
    const token = cli('gstack-review-log', '--start', skill).stdout.trim();
    const rec = { skill, run_id: 'run', cycle: 0, status: 'clean', completed: true, converged: true, issues_found: 0, critical: 0 };
    return { token, rec, finish: () => cli('gstack-review-log', JSON.stringify(rec), '--finish', token) };
  };
  const ledger = () => readFileSync(join(s, 'projects', basename(d), 'budgets/run.ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const rows = () => readFileSync(join(s, 'projects', basename(d), 'main-reviews.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { d, s, cli, git, write, plan, verdict, reviewers, log, ledger, rows, wtree, makePlan };
}
afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));
const long = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n') + '\n';
for (const [name, enabled, p, full, testOnly, docOnly] of [
  ['absent: upstream large new-test rerun unchanged', false, 'test/new.test.ts', true, false, false],
  ['added >50-line test: delta verification', true, 'test/new.test.ts', false, true, false],
  ['added auth test: FULL', true, 'lib/auth/new.test.ts', true, false, false],
  ['added D-surface test: FULL', true, 'danger/new.test.ts', true, false, false],
  ['modified test: FULL', true, 'test/old.test.ts', true, false, false],
  ['source edit: FULL', true, 'x.ts', true, false, false],
  ['doc edit: carry and Local lanes', true, 'README.md', false, false, true],
] as const) {
  test(`D3 C3 ${name}`, () => {
    const f = fixture(enabled); f.write(p, p === 'x.ts' ? 'small repair\n' : long);
    const r = f.cli('gstack-review-budget', 'rerun-check', 'run'); expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`FULL_RERUN=${full}`);
    expect(r.stdout).toContain(`TEST_ONLY=${testOnly}`); expect(r.stdout).toContain(`DOC_ONLY=${docOnly}`);
    if (!full && enabled) expect(r.stdout).toContain('LOCAL_LANES_ONLY=true');
  });
}
test('D3 C3 immutable dirty snapshot: only delta since review counts; custom test globs and committed additions', () => {
  const f = fixture(true, { test_globs: ['checks/**'] });
  f.write('README.md', 'dirty before review\n'); f.makePlan();
  f.write('checks/new.json', long); f.git('add', 'checks/new.json'); f.git('commit', '-m', 'only new check');
  const r = f.cli('gstack-review-budget', 'rerun-check', 'run'); expect(r.stdout).toContain('TEST_ONLY=true'); expect(r.stdout).toContain('FULL_RERUN=false');
});
test('D3 C3 carry copies verdicts with audit proof, completes against new snapshot, and binds original core token', () => {
  const f = fixture(); f.reviewers(); const core = f.log(); const old = f.plan.wtree;
  f.write('test/new.test.ts', long);
  const carry = f.cli('gstack-review-budget', 'carry-forward', 'run'); expect(carry.status, carry.stderr).toBe(0);
  expect(carry.stdout).toContain('CARRY_FORWARD=true'); expect(carry.stdout).toContain('LOCAL_LANES_ONLY=true');
  expect(f.cli('gstack-review-budget', 'complete', 'run', '--require-native').status).toBe(0);
  const records = f.ledger(), audit = records.find(r => r.record_type === 'carry-forward');
  expect(audit.old_wtree).toBe(old); expect(audit.new_wtree).toBe(f.wtree()); expect(audit.files).toEqual([{ path: 'test/new.test.ts', status: 'A' }]);
  expect(audit.reason).toBe('added-tests');
  const reused = records.filter(r => r.record_type === 'verdict' && r.reused_from);
  expect(reused).toHaveLength(2); expect(reused.every(r => r.wtree === f.wtree())).toBe(true);
  expect(core.finish().status).toBe(0);
  const row = f.rows().at(-1); expect(row.review_binding.state).toBe('verified'); expect(row.carry_forward.old_wtree).toBe(old);
  expect(row.wtree).toBe(f.wtree()); expect(f.cli('gstack-review-read').stdout).toContain('"status":"CURRENT"');
});
test('D3 C3 docs carry existing native/core receipts; test receipts STALE until Local rerun, Full stays STALE', () => {
  const f = fixture(true, { routing: { passes: { non_code_delta: true } } }); f.reviewers();
  expect(f.cli('gstack-review-budget', 'register-upstream', 'run', 'native-adversarial').status).toBe(0); f.verdict('native-adversarial');
  for (const skill of ['review', 'adversarial-review']) expect(f.log(skill).finish().status).toBe(0);
  const local = 'test -s README.md', full = 'test -f x.ts';
  for (const [label, command] of [['local', local], ['full', full]]) expect(f.cli('gstack-evidence', 'run', '--label', label, '--', command).status).toBe(0);
  f.write('README.md', 'updated documentation\n');
  expect(f.cli('gstack-evidence', 'check', '--label', 'local', '--expect-cmd', local).status).not.toBe(0);
  const r = f.cli('gstack-review-budget', 'carry-forward', 'run'); expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toContain('DOC_ONLY=true');
  const logs = f.cli('gstack-review-log', '--carry-forward', 'run'); expect(logs.status, logs.stderr).toBe(0); expect(logs.stdout).toContain('CARRIED_REVIEWS=2');
  expect(f.cli('gstack-review-budget', 'complete', 'run', '--require-native').status).toBe(0);
  expect(f.rows().slice(-2).every(r => r.review_binding.state === 'verified' && r.carry_forward.reason === 'docs-release-metadata')).toBe(true);
  expect(f.cli('gstack-review-read').stdout.match(/"status":"CURRENT"/g)).toHaveLength(2);
  expect(f.cli('gstack-evidence', 'run', '--label', 'local', '--', local).status).toBe(0);
  expect(f.cli('gstack-evidence', 'check', '--label', 'local', '--expect-cmd', local).status).toBe(0);
  expect(f.cli('gstack-evidence', 'check', '--label', 'full', '--expect-cmd', full).status).not.toBe(0);
}, 30_000); // Actual accounting, logger and evidence CLIs; every child remains bounded.
test('D3 C3 rejects disabled, failed/unresolved reviewers, source deltas and forged caller carry proof', () => {
  for (const mode of ['disabled', 'failed', 'unresolved', 'source']) {
    const f = fixture(mode !== 'disabled'); f.reviewers(mode === 'failed' ? 'error' : 'clean');
    if (mode === 'unresolved') expect(f.cli('gstack-review-budget', 'finding', 'run', JSON.stringify({ severity: 'P1', gate: 'codex-structured', fingerprint: 'fp', summary: 'bug' })).status).toBe(0);
    f.write(mode === 'source' ? 'x.ts' : 'README.md', 'changed\n');
    expect(f.cli('gstack-review-budget', 'carry-forward', 'run').status).toBe(2);
  }
  const f = fixture(); const core = f.log(); f.write('README.md', 'changed\n');
  const forged = { ...core.rec, carry_forward: { old_wtree: f.plan.wtree, new_wtree: f.wtree() } };
  expect(f.cli('gstack-review-log', JSON.stringify(forged), '--finish', core.token).status).toBe(0);
  expect(f.rows().at(-1).review_binding.state).toBe('changed'); expect(f.rows().at(-1).carry_forward).toBeUndefined();
}, 30_000);
test('D3 C3 release version only qualifies; dependencies, env, migration, API, mixed delta and symlink fail upward', () => {
  for (const [p, contents, docOnly] of [
    ['package.json', '{"version":"1.0.1","scripts":{"test":"x"}}', true],
    ['package.json', '{"version":"1.0.1","scripts":{"test":"changed"}}', false],
    ['lib/env/config.md', long, false], ['supabase/migrations/new.test.ts', long, false], ['app/api/new.test.ts', long, false],
  ] as const) {
    const f = fixture(); f.write(p, contents); const r = f.cli('gstack-review-budget', 'rerun-check', 'run');
    expect(r.stdout).toContain(`DOC_ONLY=${docOnly}`); expect(r.stdout).toContain(`FULL_RERUN=${!docOnly}`);
  }
  const f = fixture(); f.write('test/new.test.ts', long); f.write('README.md', 'changed\n');
  expect(f.cli('gstack-review-budget', 'rerun-check', 'run').stdout).toContain('FULL_RERUN=true');
  const linked = fixture(); symlinkSync('../x.ts', join(linked.d, 'test/new.test.ts'));
  expect(linked.cli('gstack-review-budget', 'rerun-check', 'run').stdout).toContain('FULL_RERUN=true');
}, 30_000);

test('D3 C3 further source changes invalidate carried binding and completion; missing snapshot fails upward', () => {
  const f = fixture(); f.reviewers(); expect(f.log().finish().status).toBe(0);
  f.write('README.md', 'updated\n'); expect(f.cli('gstack-review-budget', 'carry-forward', 'run').status).toBe(0);
  expect(f.cli('gstack-review-log', '--carry-forward', 'run').status).toBe(0);
  f.write('x.ts', 'unexpected code change\n');
  expect(f.cli('gstack-review-budget', 'complete', 'run').stdout).toContain('INCOMPLETE=working-tree-changed');
  expect(f.cli('gstack-review-read').stdout).not.toContain('"status":"CURRENT"');
  const other = fixture();
  const file = join(other.s, 'projects', basename(other.d), 'budgets/run.json');
  const plan = JSON.parse(readFileSync(file, 'utf8')); plan.wtree = plan.cyclePlans['0'].wtree = 'missing'; writeFileSync(file, JSON.stringify(plan));
  const r = other.cli('gstack-review-budget', 'rerun-check', 'run');
  expect(r.stdout).toContain('FULL_RERUN=true'); expect(r.stdout).toContain('git-failure');
});
test('D3 C3 carry does not double-count paid dispatches or unresolved critical findings', () => {
  const f = fixture();
  expect(f.cli('gstack-review-budget', 'dispatch', 'run', 'codex-structured').status).toBe(0);
  expect(f.cli('gstack-review-budget', 'verdict', 'run', 'codex-structured', 'issues_found', '--critical', '1').status).toBe(0);
  expect(f.cli('gstack-review-budget', 'finding', 'run', JSON.stringify({ severity: 'P1', gate: 'codex-structured', fingerprint: 'fp', summary: 'test coverage' })).status).toBe(0);
  expect(f.cli('gstack-review-budget', 'resolve', 'run', 'fp', '--action', 'fixed').status).toBe(0);
  f.verdict('specialist:testing'); f.write('test/new.test.ts', long);
  expect(f.cli('gstack-review-budget', 'carry-forward', 'run').status).toBe(0);
  expect(f.cli('gstack-review-budget', 'complete', 'run').status).toBe(0);
  expect(f.cli('gstack-review-budget', 'report', 'run').stdout).toContain('SEMANTIC_DISPATCHES=2');
  expect(f.cli('gstack-review-budget', 'report', 'run').stdout).toContain('CARRY_FORWARDS=1');
}, 30_000);

test('D3 C3 carried advice never credits changed supporting docs as unchanged skip evidence', () => {
  const f = fixture(); f.reviewers(); const core = f.log();
  (core.rec as any).findings = [{ severity: 'INFORMATIONAL', advisory: true, action: 'skipped',
    evidence_paths: ['README.md', 'x.ts'], helper_target: { path: 'x.ts', symbol: 'helper' } }];
  expect(core.finish().status).toBe(0); expect(f.rows().at(-1).findings[0].snapshot_covered_paths).toEqual(['README.md', 'x.ts']);
  f.write('README.md', 'changed supporting docs\n');
  expect(f.cli('gstack-review-budget', 'carry-forward', 'run').status).toBe(0);
  expect(f.cli('gstack-review-log', '--carry-forward', 'run').status).toBe(0);
  expect(f.rows().at(-1).findings[0].snapshot_covered_paths).toEqual(['x.ts']);
}, 30_000);

test('D3 C3 caller carve-out keeps full triggers, original tokens, local-only receipts and accounting', () => {
  const review = readFileSync(join(root, 'review/SKILL.md.tmpl'), 'utf8');
  const ship = readFileSync(join(root, 'ship/SKILL.md.tmpl'), 'utf8');
  const army = readFileSync(join(root, 'ship/sections/review-army.md.tmpl'), 'utf8');
  expect(review).toContain('### Step 5e: Bounded repair verification');
  for (const text of [review, ship, army]) { expect(text).toContain('carry-forward'); expect(text).toContain('Local'); }
  expect(review).toContain('When `NON_CODE_DELTA=false`, skip this carve-out');
  expect(review).toContain('Auth/d-surface/env/migration/api/git failure, modified tests and every source edit stay FULL');
  expect(army).toContain('except the policy-enabled NON_CODE_DELTA carry-forward');
  expect(ship).toContain('`FULL_RERUN=true` requires route 1 even for paths shaped as docs');
  expect(ship).toContain('Full receipts remain STALE');
  expect(army).toContain('"run_id":"{RUN_ID}","cycle":{N}');
  expect(review).toContain('original REVIEW_START');
});
