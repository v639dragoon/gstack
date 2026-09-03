import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
const bin = join(import.meta.dir, '..', 'bin', 'gstack-review-budget'),
  dirs: string[] = [];
function setup(
  policy: any = { version: 1, auth_surfaces: ['lib/auth/**'], d_surfaces: ['danger/**'] },
) {
  const d = mkdtempSync(join(tmpdir(), 'budget-repo-')),
    s = mkdtempSync(join(tmpdir(), 'budget-state-'));
  dirs.push(d, s);
  for (const a of [
    ['init', '-b', 'main'],
    ['config', 'user.email', 't@t'],
    ['config', 'user.name', 'T'],
  ])
    spawnSync('git', a, { cwd: d });
  writeFileSync(join(d, '.gstack-policy.json'), JSON.stringify(policy));
  writeFileSync(join(d, 'x.ts'), 'x\n');
  spawnSync('git', ['add', '.'], { cwd: d });
  spawnSync('git', ['commit', '-m', 'base'], { cwd: d });
  return { d, s };
}
function manifest(
  d: string,
  tier: string,
  id: string,
  scope: any = {},
  routing: any = {},
  files: any[] = [{ path: 'x.ts' }],
) {
  const p = join(d, `${id}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      run_id: id,
      files,
      scope: { ...scope },
      policy: { path: '.gstack-policy.json' },
      routing: {
        risk_tier: tier,
        tier_source: 'policy',
        auth_surface_matches: [],
        doc_impact_would_dispatch: false,
        outcome: {
          present: true,
          is_final_slice: false,
          is_flag_flip: false,
          outcome_id: 'o',
          slice_number: 1,
        },
        ...routing,
      },
    }),
  );
  return p;
}
function run(d: string, s: string, a: string[]) {
  return spawnSync(bin, a, {
    cwd: d,
    encoding: 'utf8',
    env: { ...process.env, GSTACK_STATE_DIR: s, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}
afterAll(() => dirs.forEach((x) => rmSync(x, { recursive: true, force: true })));
describe('review budgets', () => {
  test('exact routes, including every C specialist pick', () => {
    const { d, s } = setup();
    const cases: any[] = [
      ['A', 'codex-structured@medium', {}, {}],
      ['B', 'codex-structured@medium', {}, {}],
      ['C', 'codex-structured@medium,specialist:data-migration@sonnet', { migrations: true }, {}],
      [
        'C',
        'codex-structured@medium,specialist:security@sonnet',
        {},
        { auth_surface_matches: ['lib/auth/x.ts'] },
      ],
      ['C', 'codex-structured@medium,specialist:api-contract@sonnet', { api: true }, {}],
      ['C', 'codex-structured@medium,specialist:testing@sonnet', {}, {}],
      ['D', 'codex-structured@high,specialist:security@sonnet,red-team@sonnet', {}, {}],
      [
        'D',
        'codex-structured@high,specialist:security@sonnet,specialist:data-migration@sonnet',
        { migrations: true },
        {},
      ],
    ];
    for (let i = 0; i < cases.length; i++) {
      const [t, w, sc, rt] = cases[i],
        r = run(d, s, ['plan', manifest(d, t, `r${i}`, sc, rt)]);
      expect(r.stdout).toContain(`REVIEWERS=${w}`);
      expect(r.stdout).toContain(
        'DETERMINISTIC_GATES=tests,typecheck,build,gitleaks,redaction,verification,claim-check' +
          (t === 'D' ? ',migration-runbook' : ''),
      );
    }
  });
  test('distinct slots, retry verdicts, completion, escalation cap, and verified findings', () => {
    const { d, s } = setup();
    run(d, s, ['plan', manifest(d, 'B', 'b')]);
    expect(run(d, s, ['dispatch', 'b', 'red-team']).status).toBe(2);
    expect(run(d, s, ['dispatch', 'b', 'coverage-audit']).stdout).toContain('intermediate-slice');
    expect(run(d, s, ['dispatch', 'b', 'codex-structured']).status).toBe(0);
    expect(run(d, s, ['dispatch', 'b', 'codex-structured']).stdout).toContain('duplicate-slot');
    expect(run(d, s, ['complete', 'b']).stdout).toContain('INCOMPLETE=codex-structured');
    expect(run(d, s, ['verdict', 'b', 'codex-structured', 'error']).status).toBe(0);
    expect(run(d, s, ['dispatch', 'b', 'codex-structured']).status).toBe(0);
    expect(run(d, s, ['dispatch', 'b', 'codex-structured']).stdout).toContain('duplicate-slot');
    expect(run(d, s, ['verdict', 'b', 'codex-structured', 'clean']).status).toBe(0);
    expect(run(d, s, ['complete', 'b']).stdout).toContain('COMPLETE=true');
    expect(run(d, s, ['dispatch', 'b', 'codex-structured', '--verify-of', 'fp']).stdout).toContain(
      'unknown-finding',
    );
    expect(
      run(d, s, [
        'finding',
        'b',
        JSON.stringify({
          severity: 'P1',
          fingerprint: 'fp',
          gate: 'codex-structured',
          summary: 'bug',
        }),
      ]).status,
    ).toBe(0);
    expect(run(d, s, ['dispatch', 'b', 'codex-structured', '--verify-of', 'fp']).status).toBe(0);
    expect(run(d, s, ['dispatch', 'b', 'codex-structured', '--verify-of', 'fp']).stdout).toContain(
      'unknown-finding',
    );
    expect(
      run(d, s, ['dispatch', 'b', 'red-team', '--escalation', 'user-request:please']).status,
    ).toBe(0);
    expect(
      run(d, s, ['dispatch', 'b', 'adversarial-claude', '--escalation', 'user-request:again'])
        .stdout,
    ).toContain('escalation-cap');
    const final = {
      outcome: {
        present: true,
        outcome_id: 'o',
        slice_number: 2,
        is_final_slice: true,
        is_flag_flip: false,
      },
    };
    run(d, s, ['plan', manifest(d, 'A', 'final', {}, final)]);
    expect(run(d, s, ['dispatch', 'final', 'coverage-audit']).status).toBe(0);
    run(d, s, ['plan', manifest(d, 'C', 'c')]);
    expect(run(d, s, ['complete', 'c']).stdout).toContain(
      'INCOMPLETE=codex-structured,specialist:testing',
    );
    expect(run(d, s, ['dispatch', 'c', 'codex-structured']).status).toBe(0);
    expect(run(d, s, ['dispatch', 'c', 'specialist:testing']).status).toBe(0);
    expect(run(d, s, ['verdict', 'c', 'codex-structured', 'clean']).status).toBe(0);
    expect(run(d, s, ['verdict', 'c', 'specialist:testing', 'issues_found']).status).toBe(0);
    expect(run(d, s, ['complete', 'c']).status).toBe(0);
    run(d, s, ['plan', manifest(d, 'D', 'dd')]);
    for (const g of ['codex-structured', 'specialist:security', 'red-team'])
      expect(run(d, s, ['dispatch', 'dd', g]).status).toBe(0);
    expect(run(d, s, ['dispatch', 'dd', 'red-team']).status).toBe(2);
  });
  test('policy can only lower safe knobs and cannot alter deterministic gates', () => {
    const policy = {
      version: 1,
      auth_surfaces: [],
      d_surfaces: [],
      routing: {
        budgets: { A: 9, C: 1, D: 0 },
        repair_cycles: { AB: 9, CD: 1 },
        deterministic_gates: 'none',
        mystery: true,
      },
    };
    const { d, s } = setup(policy);
    const c = run(d, s, ['plan', manifest(d, 'C', 'pc')]).stdout;
    expect(c).toContain('REVIEWER_BUDGET=1');
    expect(c).toContain('REPAIR_CYCLES_MAX=1');
    expect(c).toContain('POLICY_ROUTING_IGNORED=deterministic_gates,mystery');
    expect(c).toContain(
      'DETERMINISTIC_GATES=tests,typecheck,build,gitleaks,redaction,verification,claim-check',
    );
    const dd = run(d, s, ['plan', manifest(d, 'D', 'pd')]).stdout;
    expect(dd).toContain('REVIEWER_BUDGET=3');
  });
  test('rerun checks none, sensitive/new/large triggers, and cycle exhaustion', () => {
    const { d, s } = setup();
    const mp = manifest(d, 'C', 'rr');
    run(d, s, ['plan', mp]);
    rmSync(mp);
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8' }).stdout.trim();
    expect(run(d, s, ['rerun-check', 'rr', '--since', sha]).stdout).toContain(
      'RERUN_TRIGGERS=none',
    );
    mkdirSync(join(d, 'lib', 'auth'), { recursive: true });
    writeFileSync(join(d, 'lib', 'auth', 'new.ts'), Array(60).fill('x').join('\n') + '\n');
    const hit = run(d, s, ['rerun-check', 'rr']);
    expect(hit.status).toBe(0);
    expect(hit.stdout).toContain('FULL_RERUN=true');
    expect(hit.stdout).toContain('new-file:lib/auth/new.ts');
    expect(hit.stdout).toContain('auth-surface:lib/auth/new.ts');
    expect(hit.stdout).toContain('delta-lines>50');
    expect(hit.stdout).toContain('git-failure');
    expect(run(d, s, ['rerun-check', 'rr', '--since', 'deadbeef']).stdout).toContain(
      'reason=unrecorded-since',
    );
  });
  test('cycle plans record HEAD, preserve the cycle-zero tier floor, and isolate slots', () => {
    const { d, s } = setup();
    const p0 = manifest(d, 'C', 'cycles');
    const first = run(d, s, ['plan', p0, '--cycle', '0']);
    rmSync(p0);
    expect(first.stdout).toMatch(/CYCLE=0\nHEAD_SHA=[0-9a-f]{40}/);
    writeFileSync(join(d, 'x.ts'), 'cycle one\n');
    spawnSync('git', ['add', 'x.ts'], { cwd: d });
    spawnSync('git', ['commit', '-m', 'cycle one'], { cwd: d });
    const p1 = manifest(d, 'A', 'cycles');
    const second = run(d, s, ['plan', p1, '--cycle', '1']);
    rmSync(p1);
    expect(second.stdout).toContain('TIER=A');
    expect(second.stdout).toContain('EFFECTIVE_TIER=C');
    expect(run(d, s, ['dispatch', 'cycles', 'codex-structured', '--cycle', '0']).status).toBe(0);
    expect(run(d, s, ['dispatch', 'cycles', 'codex-structured', '--cycle', '1']).status).toBe(0);
    for (const cycle of [2, 3]) {
      const mp = manifest(d, 'A', 'cycles');
      expect(run(d, s, ['plan', mp, '--cycle', String(cycle)]).status).toBe(0);
      rmSync(mp);
    }
    const exhausted = run(d, s, ['rerun-check', 'cycles', '--cycle', '3']);
    expect(exhausted.status).toBe(3);
    expect(exhausted.stdout).toContain('REPAIR_CYCLES_EXHAUSTED=true');
  });
  test('blocking categories promote informational findings', () => {
    const { d, s } = setup();
    const planned = run(d, s, ['plan', manifest(d, 'B', 'blocking')]);
    expect(planned.stdout).toContain(
      'BLOCKING_CATEGORIES=security,reliability,data-safety,data-migration,sql-data-safety,llm-trust-boundary,auth',
    );
    expect(
      run(d, s, [
        'finding',
        'blocking',
        JSON.stringify({
          severity: 'INFORMATIONAL',
          category: 'auth',
          fingerprint: 'auth-info',
          gate: 'codex-structured',
          summary: 'auth issue',
        }),
      ]).status,
    ).toBe(0);
    const project = join(s, 'projects', d.split('/').at(-1)!, 'budgets');
    const ledger = readFileSync(join(project, 'blocking.ledger.jsonl'), 'utf8');
    expect(JSON.parse(ledger.trim()).blocking).toBe(true);
    expect(run(d, s, ['report', 'blocking']).stdout).toContain('BLOCKING_FINDINGS=1');
  });
});
