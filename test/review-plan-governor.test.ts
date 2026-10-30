/** Integration: governor additions and opt-in D3 selection reach the real builder and collector. No model calls. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readManifest } from '../lib/review-pass';
import { readLedger } from '../lib/review-ledger';
const root = path.resolve(import.meta.dir, '..');

function fixture(tier: string, passes: Record<string, boolean>, migrations = false) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-gov-')));
  const repo = path.join(temp, 'repo'), state = path.join(temp, 'state'), out = path.join(temp, 'packets');
  fs.mkdirSync(repo); fs.mkdirSync(state);
  const env = { ...process.env, GSTACK_STATE_ROOT: state, GSTACK_PROJECT_SLUG: 'fixture', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8', timeout: 10_000 });
    expect(r.status, r.stderr).toBe(0);
  };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, '.gstack-policy.json'), JSON.stringify({ routing: { passes } }));
  fs.writeFileSync(path.join(repo, 'main.ts'), 'export const x = 1;\n');
  git('add', '.'); git('commit', '-qm', 'base'); git('checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(repo, 'main.ts'), Array.from({ length: 80 }, (_, i) => `export const x${i} = ${i};`).join('\n') + '\n');
  git('add', '.'); git('commit', '-qm', 'feature');
  const manifest = path.join(temp, 'governor.json');
  fs.writeFileSync(manifest, JSON.stringify({ run_id: 'integration', base: 'main', files: [{ path: 'main.ts', additions: 80, deletions: 1 }], scope: { migrations }, policy: { path: '.gstack-policy.json' }, routing: {
    risk_tier: tier, tier_rule: 'fixture', tier_source: 'policy', auth_surface_matches: [], d_surface_matches: [], load_bearing_doc_matches: [], doc_impact_matches: [], outcome: { present: false },
  } }));
  const run = (bin: string, args: string[]) => spawnSync(path.join(root, 'bin', bin), args, { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
  const planned = run('gstack-review-budget', ['plan', manifest, '--host', 'codex']);
  expect(planned.status, planned.stderr).toBe(0);
  const flags = ['--base', 'main', '--gate-tagged', '0', '--run-id', 'integration', '--cycle', '0'];
  const plan = run('gstack-review-plan', [...flags, '--json']);
  expect(plan.status, plan.stderr).toBe(0);
  return { temp, out, run, flags, plan: JSON.parse(plan.stdout), cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

// The upstream carrier moved to review-dispatch's pass manifest; governor tier checklists share its one batched reader.
test('tier D migration plan keeps red-team, strict structured and every specialist floor in the single batch', () => {
  const f = fixture('D', {}, true);
  try {
    expect(f.plan.dispatches.map((d: { name: string }) => d.name)).toEqual(expect.arrayContaining(['red-team', 'codex-structured', 'batched']));
    const batch = f.plan.dispatches.find((d: { name: string }) => d.name === 'batched');
    expect(batch.checklists).toEqual(expect.arrayContaining(['security', 'data-migration']));
    expect(batch.governor_gates).toEqual(expect.arrayContaining(['specialist:security', 'specialist:data-migration']));
    expect(f.plan.dispatches.filter((d: { role: string }) => d.role === 'specialist')).toHaveLength(1);
    expect(f.plan.depth).toBe('standard');
    expect(f.plan.dispatches.find((d: { name: string }) => d.name === 'codex-structured')).toMatchObject({ governor_floor: true, governor: { routed_effort: 'high' } });
    const built = f.run('gstack-review-dispatch', ['pass', '--base', 'main', '--pass', 'p1', '--out', f.out, '--', ...f.flags]);
    expect(built.status, built.stderr).toBe(0);
    const file = path.join(f.out, 'pass-manifest.json');
    const stage = f.run('gstack-review-dispatch', ['stage', '--manifest', file, '--stage', 'voices']);
    expect(stage.status, stage.stderr).toBe(0);
    const manifest = readManifest(file);
    const strict = manifest.readers.find(p => p.role === 'codex-structured')!;
    expect(strict.governor_floor).toBe(true);
    expect(fs.readFileSync(strict.file!, 'utf8')).toContain('do NOT run the build, the test suite, typecheck or any install');
    expect(fs.readFileSync(strict.file!, 'utf8')).toContain('## Governor context');
  } finally { f.cleanup(); }
});

test('D3-off reviewer is absent from the plan and dispatch ledger expectations; strict collect completes', () => {
  const f = fixture('B', { native_adversarial: false, upstream_specialists: false, codex_challenge: false, red_team_loc_trigger: false });
  try {
    expect(f.plan.dispatches.map((d: { name: string }) => d.name)).toEqual(['codex-structured']);
    const built = f.run('gstack-review-dispatch', ['pass', '--base', 'main', '--pass', 'p1', '--out', f.out, '--', ...f.flags]);
    expect(built.status, built.stderr).toBe(0);
    const file = path.join(f.out, 'pass-manifest.json');
    expect(f.run('gstack-review-dispatch', ['stage', '--manifest', file, '--stage', 'voices']).status).toBe(0);
    const manifest = readManifest(file);
    expect(manifest.readers.map(p => p.role)).toEqual(['codex-structured']);
    const strict = manifest.readers[0]!;
    const tree = strict.tree!;
    const output = path.join(f.out, 'strict.out');
    fs.writeFileSync(output, `REVIEWED_TREE: ${tree}\nNO FINDINGS\nRecommendation: proceed because no exploitable finding.\n`);
    expect(f.run('gstack-review-dispatch', ['sent', '--ledger', manifest.ledger, '--role', strict.role!, '--sent', strict.file!]).status).toBe(0);
    const result = f.run('gstack-review-dispatch', ['collect', '--ledger', manifest.ledger, '--role', strict.role!, '--output', output, '--merged', manifest.merged]);
    expect([result.status, result.stdout]).toEqual([0, expect.stringContaining('findings=0')]);
    expect(readLedger(manifest.ledger).filter(e => e.event === 'rendered').map(e => e.role)).toEqual(['codex-structured']);
  } finally { f.cleanup(); }
});

test('D3 switches cannot drop floor checklists, red-team or structured', () => {
  const f = fixture('D', { upstream_specialists: false, red_team_loc_trigger: false, upstream_structured: false, codex_challenge: false });
  try {
    for (const gate of ['codex-structured', 'red-team'])
      expect(f.plan.dispatches.find((d: { governor_gate: string }) => d.governor_gate === gate)).toMatchObject({ governor_floor: true });
    expect(f.plan.dispatches.find((d: { name: string }) => d.name === 'batched').governor_gates).toContain('specialist:security');
    expect(f.plan.dispatches.some((d: { governor_gate: string }) => d.governor_gate === 'upstream-outside:challenge')).toBe(false);
  } finally { f.cleanup(); }
});
