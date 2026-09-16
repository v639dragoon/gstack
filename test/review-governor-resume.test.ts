/** Whole-workflow pass accounting, audit verdicts, completion flags and
 * stage RESUME against an unchanged snapshot (harness pass 2026-09-15). */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
const bin = join(import.meta.dir, '..', 'bin', 'gstack-review-budget'),
  dirs: string[] = [];
function setup() {
  const d = mkdtempSync(join(tmpdir(), 'resume-repo-')), s = mkdtempSync(join(tmpdir(), 'resume-state-'));
  dirs.push(d, s);
  for (const a of [['init', '-b', 'main'], ['config', 'user.email', 't@t'], ['config', 'user.name', 'T']])
    spawnSync('git', a, { cwd: d, timeout: 30_000 });
  writeFileSync(join(d, '.gstack-policy.json'), JSON.stringify({ version: 1, auth_surfaces: [], d_surfaces: [] }));
  writeFileSync(join(d, 'x.ts'), 'x\n');
  spawnSync('git', ['add', '.'], { cwd: d, timeout: 30_000 });
  spawnSync('git', ['commit', '-m', 'base'], { cwd: d, timeout: 30_000 });
  return { d, s };
}
function manifest(d: string, id: string, extra: any = {}, tier = 'C') {
  const p = join(d, `${id}.json`);
  writeFileSync(p, JSON.stringify({
    run_id: id, files: [{ path: 'x.ts' }], scope: { api: true },
    policy: { path: '.gstack-policy.json', sha256: 'p1' },
    wtree: 'w'.repeat(40), base: 'main', merge_base: 'm1',
    routing: { risk_tier: tier, tier_source: 'policy', auth_surface_matches: [], doc_impact_would_dispatch: false,
      outcome: { present: true, is_final_slice: true, is_flag_flip: false, outcome_id: 'o', slice_number: 1 } },
    ...extra,
  }));
  return p;
}
function run(d: string, s: string, a: string[]) {
  return spawnSync(bin, a, { timeout: 30_000, cwd: d, encoding: 'utf8', env: { ...process.env, GSTACK_STATE_DIR: s, GIT_CONFIG_GLOBAL: '/dev/null' } });
}
afterAll(() => dirs.forEach((x) => rmSync(x, { recursive: true, force: true })));
describe('pass accounting', () => {
  test('plan declares every AI pass with purpose, model, effort, budget and retry', () => {
    const { d, s } = setup();
    const r = run(d, s, ['plan', manifest(d, 'r1'), '--cycle', '0', '--json']);
    const p = JSON.parse(r.stdout);
    const gates = p.passes.map((x: any) => x.gate);
    expect(gates).toEqual(['codex-structured', 'specialist:api-contract', 'coverage-audit', 'plan-completion', 'doc-release', 'outside-voice:doc-release']);
    for (const x of p.passes) for (const k of ['purpose', 'model', 'effort', 'budget', 'retry', 'planned']) expect(x, `${x.gate}.${k}`).toHaveProperty(k);
    expect(p.passes.find((x: any) => x.gate === 'coverage-audit').planned).toBe(true);
    expect(p.passes.find((x: any) => x.gate === 'outside-voice:doc-release').planned).toBe(false); // tier C: no doc voice
    expect(p.wtree).toBe('w'.repeat(40));
    expect(p.policy_sha256).toBe('p1');
    const text = run(d, s, ['plan', manifest(d, 'r1b'), '--cycle', '0']).stdout;
    expect(text).toContain('PASSES=codex-structured@project-default:medium,specialist:api-contract@sonnet:agent-default,coverage-audit@sonnet:agent-default,plan-completion@sonnet:agent-default,doc-release@sonnet:agent-default');
  }, 60_000);
  test('audit verdicts are accepted when planned and owed by complete --require-audits; intermediate slices owe none', () => {
    const { d, s } = setup();
    run(d, s, ['plan', manifest(d, 'r2'), '--cycle', '0']);
    for (const g of ['codex-structured', 'specialist:api-contract']) {
      run(d, s, ['dispatch', 'r2', g, '--cycle', '0']);
      expect(run(d, s, ['verdict', 'r2', g, 'clean', '--cycle', '0']).status).toBe(0);
    }
    expect(run(d, s, ['complete', 'r2', '--cycle', '0']).status).toBe(0); // /review path: reviewers only
    const c1 = run(d, s, ['complete', 'r2', '--cycle', '0', '--require-audits']);
    expect(c1.status).toBe(2);
    expect(c1.stdout).toContain('INCOMPLETE=coverage-audit,plan-completion');
    expect(run(d, s, ['dispatch', 'r2', 'coverage-audit', '--cycle', '0']).status).toBe(0);
    expect(run(d, s, ['verdict', 'r2', 'coverage-audit', 'error', '--cycle', '0']).status).toBe(0);
    expect(run(d, s, ['complete', 'r2', '--cycle', '0', '--require-audits']).stdout).toContain('INCOMPLETE=coverage-audit,plan-completion');
    run(d, s, ['dispatch', 'r2', 'coverage-audit', '--cycle', '0']); // the one retry
    run(d, s, ['verdict', 'r2', 'coverage-audit', 'clean', '--cycle', '0']);
    run(d, s, ['dispatch', 'r2', 'plan-completion', '--cycle', '0']);
    run(d, s, ['verdict', 'r2', 'plan-completion', 'issues_found', '--cycle', '0']);
    expect(run(d, s, ['complete', 'r2', '--cycle', '0', '--require-audits']).stdout).toContain('COMPLETE=true');
    const f = run(d, s, ['complete', 'r2', '--cycle', '0', '--final']);
    expect(f.stdout).toContain('INCOMPLETE=doc-release');
    run(d, s, ['dispatch', 'r2', 'doc-release', '--cycle', '0']);
    run(d, s, ['verdict', 'r2', 'doc-release', 'clean', '--cycle', '0']);
    expect(run(d, s, ['complete', 'r2', '--cycle', '0', '--final']).stdout).toContain('COMPLETE=true');
    // Intermediate slice: audits are off-plan, verdict refused, complete owes nothing extra.
    const inter = manifest(d, 'r3', { routing: { risk_tier: 'C', tier_source: 'policy', auth_surface_matches: [], doc_impact_would_dispatch: false, outcome: { present: true, is_final_slice: false, is_flag_flip: false, outcome_id: 'o', slice_number: 1 } } });
    run(d, s, ['plan', inter, '--cycle', '0']);
    expect(run(d, s, ['verdict', 'r3', 'coverage-audit', 'clean', '--cycle', '0']).status).toBe(2);
    for (const g of ['codex-structured', 'specialist:api-contract']) { run(d, s, ['dispatch', 'r3', g, '--cycle', '0']); run(d, s, ['verdict', 'r3', g, 'clean', '--cycle', '0']); }
    expect(run(d, s, ['complete', 'r3', '--cycle', '0', '--require-audits']).stdout).toContain('COMPLETE=true');
  }, 60_000);
});
describe('resume', () => {
  test('reuses terminal verdicts from a prior run of identical inputs and refuses a second dispatch', () => {
    const { d, s } = setup();
    run(d, s, ['plan', manifest(d, 'old'), '--cycle', '0']);
    run(d, s, ['dispatch', 'old', 'codex-structured', '--cycle', '0']);
    run(d, s, ['finding', 'old', 'codex-structured', '--severity', 'INFORMATIONAL', '--fingerprint', 'x.ts:1:other', '--cycle', '0']);
    run(d, s, ['verdict', 'old', 'codex-structured', 'issues_found', '--cycle', '0', '--informational', '1']);
    run(d, s, ['dispatch', 'old', 'specialist:api-contract', '--cycle', '0']);
    run(d, s, ['verdict', 'old', 'specialist:api-contract', 'timeout', '--cycle', '0']);
    run(d, s, ['dispatch', 'old', 'coverage-audit', '--cycle', '0']);
    run(d, s, ['verdict', 'old', 'coverage-audit', 'clean', '--cycle', '0']);
    run(d, s, ['plan', manifest(d, 'new'), '--cycle', '0']);
    const r = run(d, s, ['resume', 'new']);
    expect(r.stdout).toContain('RESUME_SOURCE=old');
    expect(r.stdout).toContain('REUSED=codex-structured,coverage-audit');
    expect(r.stdout).toContain('RERUN=specialist:api-contract,plan-completion,doc-release');
    const dup = run(d, s, ['dispatch', 'new', 'codex-structured', '--cycle', '0']);
    expect(dup.status).toBe(2);
    expect(dup.stdout).toContain('duplicate-slot');
    expect(run(d, s, ['dispatch', 'new', 'specialist:api-contract', '--cycle', '0']).status).toBe(0);
    run(d, s, ['verdict', 'new', 'specialist:api-contract', 'clean', '--cycle', '0']);
    expect(run(d, s, ['complete', 'new', '--cycle', '0']).stdout).toContain('COMPLETE=true');
    // Idempotent: a second resume reuses nothing more.
    expect(run(d, s, ['resume', 'new']).stdout).toContain('REUSED=\n');
  }, 60_000);
  test('any changed input (content, base, policy, tier, slice) reuses nothing', () => {
    const { d, s } = setup();
    run(d, s, ['plan', manifest(d, 'src'), '--cycle', '0']);
    run(d, s, ['dispatch', 'src', 'codex-structured', '--cycle', '0']);
    run(d, s, ['verdict', 'src', 'codex-structured', 'clean', '--cycle', '0']);
    const variants: [string, any][] = [
      ['wtree', { wtree: 'v'.repeat(40) }],
      ['base', { base: 'release' }],
      ['merge_base', { merge_base: 'm2' }],
      ['policy', { policy: { path: '.gstack-policy.json', sha256: 'p2' } }],
    ];
    for (const [name, extra] of variants) {
      run(d, s, ['plan', manifest(d, `v-${name}`, extra), '--cycle', '0']);
      const r = run(d, s, ['resume', `v-${name}`]);
      expect(r.stdout, name).toContain('RESUME_SOURCE=\n');
      expect(r.stdout, name).toContain('REUSED=\n');
    }
    run(d, s, ['plan', manifest(d, 'v-tier', {}, 'D'), '--cycle', '0']);
    expect(run(d, s, ['resume', 'v-tier']).stdout).toContain('REUSED=\n');
  }, 60_000);
});
