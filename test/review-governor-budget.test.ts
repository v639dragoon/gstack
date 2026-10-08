import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
const bin = join(import.meta.dir, '..', 'bin/gstack-review-budget'),
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
    spawnSync('git', a, { cwd: d, timeout: 30_000 });
  writeFileSync(join(d, '.gstack-policy.json'), JSON.stringify(policy));
  writeFileSync(join(d, 'x.ts'), 'x\n');
  spawnSync('git', ['add', '.'], { cwd: d, timeout: 30_000 });
  spawnSync('git', ['commit', '-m', 'base'], { cwd: d, timeout: 30_000 });
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
    timeout: 30_000,
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
  }, 30_000); // ~30 bin spawns at ~100-170ms each sit at the 5s default; bounded per upstream idiom
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
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8', timeout: 30_000 }).stdout.trim();
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
    spawnSync('git', ['add', 'x.ts'], { cwd: d, timeout: 30_000 });
    spawnSync('git', ['commit', '-m', 'cycle one'], { cwd: d, timeout: 30_000 });
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
  test('unfinished repair cycles carry into a new run and exhaust the shared budget', () => {
    const { d, s } = setup();
    expect(spawnSync('git', ['checkout', '-b', 'feat/x'], { cwd: d, timeout: 30_000 }).status).toBe(0);
    expect(run(d, s, ['plan', manifest(d, 'C', 'A'), '--cycle', '0']).status).toBe(0);
    expect(run(d, s, ['rerun-check', 'A', '--cycle', '0']).status).toBe(0);
    expect(run(d, s, ['plan', manifest(d, 'C', 'A'), '--cycle', '1']).status).toBe(0);
    expect(run(d, s, ['rerun-check', 'A', '--cycle', '1']).status).toBe(0);
    const b = run(d, s, ['plan', manifest(d, 'C', 'B'), '--cycle', '0']);
    expect(b.stdout).toContain('CARRIED_REPAIR_CYCLES=2');
    expect(b.stdout).toContain('CARRIED_FROM=A');
    const project = join(s, 'projects', d.split('/').at(-1)!, 'budgets');
    const bPlan = JSON.parse(readFileSync(join(project, 'B.json'), 'utf8'));
    expect(bPlan.cyclePlans['0'].branch).toBe('feat/x');
    expect(bPlan.cyclePlans['0'].carriedCycles).toBe(2);
    const first = run(d, s, ['rerun-check', 'B', '--cycle', '0']);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('EFFECTIVE_REPAIR_CYCLE=2');
    const ledger = readFileSync(join(project, 'B.ledger.jsonl'), 'utf8').trim().split('\n').map(text => JSON.parse(text));
    expect(ledger[0].carried_cycles).toBe(2);
    expect(ledger[0].effective_cycle).toBe(2);
    run(d, s, ['plan', manifest(d, 'C', 'B'), '--cycle', '1']);
    const inherited = JSON.parse(readFileSync(join(project, 'B.json'), 'utf8'));
    expect(inherited.cyclePlans['1'].carriedCycles).toBe(2);
    expect(inherited.cyclePlans['1'].carriedFrom).toBe('A');
    const exhausted = run(d, s, ['rerun-check', 'B', '--cycle', '1']);
    expect(exhausted.status).toBe(3);
    expect(exhausted.stdout).toContain('REPAIR_CYCLES_EXHAUSTED=true');
  });
  test('a successful completion after the last rerun finishes the prior run', () => {
    const { d, s } = setup();
    expect(spawnSync('git', ['checkout', '-b', 'feat/x'], { cwd: d, timeout: 30_000 }).status).toBe(0);
    run(d, s, ['plan', manifest(d, 'B', 'A')]);
    run(d, s, ['rerun-check', 'A']);
    expect(run(d, s, ['complete', 'A']).status).toBe(2);
    for (const gate of ['codex-structured']) {
      expect(run(d, s, ['dispatch', 'A', gate]).status).toBe(0);
      expect(run(d, s, ['verdict', 'A', gate, 'clean']).status).toBe(0);
    }
    expect(run(d, s, ['complete', 'A']).stdout).toContain('COMPLETE=true');
    const b = run(d, s, ['plan', manifest(d, 'B', 'B')]);
    expect(b.stdout).toContain('CARRIED_REPAIR_CYCLES=0');
    expect(b.stdout).toMatch(/^CARRIED_FROM=$/m);
    const project = join(s, 'projects', d.split('/').at(-1)!, 'budgets');
    const events = readFileSync(join(project, 'A.ledger.jsonl'), 'utf8').trim().split('\n').map(text => JSON.parse(text));
    expect(events.filter((r: any) => r.record_type === 'complete')).toHaveLength(1);
  });
  test('a rerun after successful completion leaves the prior run unfinished', () => {
    const { d, s } = setup();
    expect(spawnSync('git', ['checkout', '-b', 'feat/x'], { cwd: d, timeout: 30_000 }).status).toBe(0);
    run(d, s, ['plan', manifest(d, 'B', 'A')]);
    expect(run(d, s, ['dispatch', 'A', 'codex-structured']).status).toBe(0);
    expect(run(d, s, ['verdict', 'A', 'codex-structured', 'clean']).status).toBe(0);
    expect(run(d, s, ['complete', 'A']).status).toBe(0);
    run(d, s, ['rerun-check', 'A']);
    const b = run(d, s, ['plan', manifest(d, 'B', 'B')]);
    expect(b.stdout).toContain('CARRIED_REPAIR_CYCLES=1');
  });
  test('different branches and legacy plans cannot carry cycles', () => {
    const { d, s } = setup();
    expect(spawnSync('git', ['checkout', '-b', 'feat/x'], { cwd: d, timeout: 30_000 }).status).toBe(0);
    run(d, s, ['plan', manifest(d, 'B', 'A')]);
    run(d, s, ['rerun-check', 'A']);
    expect(spawnSync('git', ['checkout', '-b', 'feat/y'], { cwd: d, timeout: 30_000 }).status).toBe(0);
    expect(run(d, s, ['plan', manifest(d, 'B', 'B')]).stdout).toContain('CARRIED_REPAIR_CYCLES=0');
    const project = join(s, 'projects', d.split('/').at(-1)!, 'budgets');
    const bPath = join(project, 'B.json');
    const legacy = JSON.parse(readFileSync(bPath, 'utf8'));
    delete legacy.branch;
    delete legacy.cyclePlans['0'].branch;
    writeFileSync(bPath, JSON.stringify(legacy));
    run(d, s, ['rerun-check', 'B']);
    const c = run(d, s, ['plan', manifest(d, 'B', 'C')]);
    expect(c.stdout).toContain('CARRIED_REPAIR_CYCLES=0');
    expect(c.stdout).toContain('CARRIED_FROM=');
  });
  test('carry chains through abandoned runs and a recorded override resets it', () => {
    const { d, s } = setup();
    expect(spawnSync('git', ['checkout', '-b', 'feat/x'], { cwd: d, timeout: 30_000 }).status).toBe(0);
    run(d, s, ['plan', manifest(d, 'C', 'A')]);
    run(d, s, ['rerun-check', 'A']);
    expect(run(d, s, ['plan', manifest(d, 'C', 'B')]).stdout).toContain('CARRIED_REPAIR_CYCLES=1');
    run(d, s, ['rerun-check', 'B']);
    const c = run(d, s, ['plan', manifest(d, 'C', 'C')]);
    expect(c.stdout).toContain('CARRIED_REPAIR_CYCLES=2');
    expect(c.stdout).toContain('CARRIED_FROM=B');
    const reset = run(d, s, ['plan', manifest(d, 'C', 'D'), '--reset-repair-budget', 'founder: new scope']);
    expect(reset.status).toBe(0);
    expect(reset.stdout).toContain('REPAIR_BUDGET_RESET=founder: new scope');
    expect(reset.stdout).toContain('CARRIED_REPAIR_CYCLES=0');
    const project = join(s, 'projects', d.split('/').at(-1)!, 'budgets');
    const plan = JSON.parse(readFileSync(join(project, 'D.json'), 'utf8'));
    expect(plan.cyclePlans['0'].repairBudgetReset.reason).toBe('founder: new scope');
    expect(plan.cyclePlans['0'].repairBudgetReset.from).toBe('C');
    expect(run(d, s, ['plan', manifest(d, 'C', 'E'), '--reset-repair-budget', '  ']).status).not.toBe(0);
  });
  test('a clean narrow verification finishes the prior run', () => {
    const { d, s } = setup();
    expect(spawnSync('git', ['checkout', '-b', 'feat/x'], { cwd: d, timeout: 30_000 }).status).toBe(0);
    const mp = manifest(d, 'B', 'A');
    expect(run(d, s, ['plan', mp]).status).toBe(0);
    rmSync(mp);
    expect(run(d, s, ['dispatch', 'A', 'codex-structured']).status).toBe(0);
    expect(run(d, s, ['verdict', 'A', 'codex-structured', 'issues_found']).status).toBe(0);
    expect(run(d, s, ['finding', 'A', JSON.stringify({
      severity: 'P1', fingerprint: 'fp', gate: 'codex-structured', summary: 'fix',
    })]).status).toBe(0);
    expect(run(d, s, ['resolve', 'A', 'fp', '--action', 'fixed']).status).toBe(0);
    writeFileSync(join(d, 'x.ts'), 'fixed\n');
    const rerun = run(d, s, ['rerun-check', 'A']);
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain('FULL_RERUN=false');
    expect(run(d, s, ['dispatch', 'A', 'codex-structured', '--verify-of', 'fp']).status).toBe(0);
    expect(run(d, s, ['verdict', 'A', 'codex-structured', 'clean']).status).toBe(0);
    const b = run(d, s, ['plan', manifest(d, 'B', 'B')]);
    expect(b.stdout).toContain('CARRIED_REPAIR_CYCLES=0');
    expect(b.stdout).toMatch(/^CARRIED_FROM=$/m);
  });
  test('a narrow verification that finds issues leaves the prior run unfinished', () => {
    const { d, s } = setup();
    expect(spawnSync('git', ['checkout', '-b', 'feat/x'], { cwd: d, timeout: 30_000 }).status).toBe(0);
    const mp = manifest(d, 'B', 'A');
    run(d, s, ['plan', mp]);
    rmSync(mp);
    expect(run(d, s, ['dispatch', 'A', 'codex-structured']).status).toBe(0);
    expect(run(d, s, ['verdict', 'A', 'codex-structured', 'issues_found']).status).toBe(0);
    expect(run(d, s, ['finding', 'A', JSON.stringify({
      severity: 'P1', fingerprint: 'fp', gate: 'codex-structured', summary: 'fix',
    })]).status).toBe(0);
    expect(run(d, s, ['resolve', 'A', 'fp', '--action', 'fixed']).status).toBe(0);
    writeFileSync(join(d, 'x.ts'), 'fixed\n');
    expect(run(d, s, ['rerun-check', 'A']).stdout).toContain('FULL_RERUN=false');
    expect(run(d, s, ['dispatch', 'A', 'codex-structured', '--verify-of', 'fp']).status).toBe(0);
    expect(run(d, s, ['verdict', 'A', 'codex-structured', 'issues_found']).status).toBe(0);
    const b = run(d, s, ['plan', manifest(d, 'B', 'B')]);
    expect(b.stdout).toContain('CARRIED_REPAIR_CYCLES=1');
    expect(b.stdout).toMatch(/^CARRIED_FROM=A$/m);
  });
  test('an exhausted rerun stays unfinished even if a completion follows', () => {
    const { d, s } = setup();
    expect(spawnSync('git', ['checkout', '-b', 'feat/x'], { cwd: d, timeout: 30_000 }).status).toBe(0);
    run(d, s, ['plan', manifest(d, 'B', 'A'), '--cycle', '0']);
    run(d, s, ['plan', manifest(d, 'B', 'A'), '--cycle', '2']);
    expect(run(d, s, ['rerun-check', 'A', '--cycle', '2']).status).toBe(3);
    const project = join(s, 'projects', d.split('/').at(-1)!, 'budgets');
    const ledgerPath = join(project, 'A.ledger.jsonl');
    writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8') + JSON.stringify({
      record_type: 'complete', run_id: 'A', cycle: 2, ts: new Date().toISOString(),
    }) + '\n');
    const b = run(d, s, ['plan', manifest(d, 'B', 'B')]);
    expect(b.stdout).toContain('CARRIED_REPAIR_CYCLES=1');
    expect(b.stdout).toMatch(/^CARRIED_FROM=A$/m);
  });
  test('completion with an unresolved blocking finding does not finish a later cycle', () => {
    const { d, s } = setup();
    expect(spawnSync('git', ['checkout', '-b', 'feat/x'], { cwd: d, timeout: 30_000 }).status).toBe(0);
    run(d, s, ['plan', manifest(d, 'B', 'A'), '--cycle', '0']);
    expect(run(d, s, ['rerun-check', 'A', '--cycle', '0']).stdout).toContain('FULL_RERUN=true');
    run(d, s, ['plan', manifest(d, 'B', 'A'), '--cycle', '1']);
    expect(run(d, s, ['dispatch', 'A', 'codex-structured', '--cycle', '1']).status).toBe(0);
    expect(run(d, s, ['verdict', 'A', 'codex-structured', 'issues_found', '--cycle', '1']).status).toBe(0);
    expect(run(d, s, ['finding', 'A', JSON.stringify({
      severity: 'P1', fingerprint: 'fp', gate: 'codex-structured', summary: 'still open',
    }), '--cycle', '1']).status).toBe(0);
    expect(run(d, s, ['complete', 'A', '--cycle', '1']).stdout).toContain('COMPLETE=true');
    const b = run(d, s, ['plan', manifest(d, 'B', 'B')]);
    expect(b.stdout).toContain('CARRIED_REPAIR_CYCLES=1');
    expect(b.stdout).toMatch(/^CARRIED_FROM=A$/m);
  });
  test('completion cannot hide a critical verdict without recorded findings', () => {
    const { d, s } = setup();
    expect(spawnSync('git', ['checkout', '-b', 'feat/x'], { cwd: d, timeout: 30_000 }).status).toBe(0);
    run(d, s, ['plan', manifest(d, 'B', 'A'), '--cycle', '0']);
    run(d, s, ['rerun-check', 'A', '--cycle', '0']);
    run(d, s, ['plan', manifest(d, 'B', 'A'), '--cycle', '1']);
    expect(run(d, s, ['dispatch', 'A', 'codex-structured', '--cycle', '1']).status).toBe(0);
    expect(run(d, s, ['verdict', 'A', 'codex-structured', 'issues_found', '--critical', '1', '--cycle', '1']).status).toBe(0);
    expect(run(d, s, ['complete', 'A', '--cycle', '1']).status).toBe(0);
    expect(run(d, s, ['plan', manifest(d, 'B', 'B')]).stdout).toContain('CARRIED_REPAIR_CYCLES=1');
  });
  test('a narrow rerun needs clean verification for every fixed blocking finding', () => {
    const { d, s } = setup();
    expect(spawnSync('git', ['checkout', '-b', 'feat/x'], { cwd: d, timeout: 30_000 }).status).toBe(0);
    const mp = manifest(d, 'B', 'A');
    run(d, s, ['plan', mp]);
    rmSync(mp);
    expect(run(d, s, ['dispatch', 'A', 'codex-structured']).status).toBe(0);
    expect(run(d, s, ['verdict', 'A', 'codex-structured', 'issues_found', '--critical', '2']).status).toBe(0);
    for (const fp of ['first', 'second']) {
      expect(run(d, s, ['finding', 'A', JSON.stringify({
        severity: 'P1', fingerprint: fp, gate: 'codex-structured', summary: fp,
      })]).status).toBe(0);
      expect(run(d, s, ['resolve', 'A', fp, '--action', 'fixed']).status).toBe(0);
    }
    writeFileSync(join(d, 'x.ts'), 'fixed\n');
    expect(run(d, s, ['rerun-check', 'A']).stdout).toContain('FULL_RERUN=false');
    expect(run(d, s, ['dispatch', 'A', 'codex-structured', '--verify-of', 'first']).status).toBe(0);
    expect(run(d, s, ['verdict', 'A', 'codex-structured', 'clean']).status).toBe(0);
    const b = run(d, s, ['plan', manifest(d, 'B', 'B')]);
    expect(b.stdout).toContain('CARRIED_REPAIR_CYCLES=1');
    expect(b.stdout).toMatch(/^CARRIED_FROM=A$/m);
  });
  test('a narrow rerun converges with one verified fix and one skipped finding', () => {
    const { d, s } = setup();
    expect(spawnSync('git', ['checkout', '-b', 'feat/x'], { cwd: d, timeout: 30_000 }).status).toBe(0);
    const mp = manifest(d, 'B', 'A');
    run(d, s, ['plan', mp]);
    rmSync(mp);
    expect(run(d, s, ['dispatch', 'A', 'codex-structured']).status).toBe(0);
    expect(run(d, s, ['verdict', 'A', 'codex-structured', 'issues_found', '--critical', '2']).status).toBe(0);
    for (const fp of ['fixed', 'skipped'])
      expect(run(d, s, ['finding', 'A', JSON.stringify({
        severity: 'P1', fingerprint: fp, gate: 'codex-structured', summary: fp,
      })]).status).toBe(0);
    expect(run(d, s, ['resolve', 'A', 'fixed', '--action', 'fixed']).status).toBe(0);
    expect(run(d, s, ['resolve', 'A', 'skipped', '--action', 'skipped']).status).toBe(0);
    writeFileSync(join(d, 'x.ts'), 'fixed\n');
    expect(run(d, s, ['rerun-check', 'A']).stdout).toContain('FULL_RERUN=false');
    expect(run(d, s, ['dispatch', 'A', 'codex-structured', '--verify-of', 'fixed']).status).toBe(0);
    expect(run(d, s, ['verdict', 'A', 'codex-structured', 'clean']).status).toBe(0);
    const b = run(d, s, ['plan', manifest(d, 'B', 'B')]);
    expect(b.stdout).toContain('CARRIED_REPAIR_CYCLES=0');
    expect(b.stdout).toMatch(/^CARRIED_FROM=$/m);
  });
  test('a clean completed run without findings carries no cycles', () => {
    const { d, s } = setup();
    expect(spawnSync('git', ['checkout', '-b', 'feat/x'], { cwd: d, timeout: 30_000 }).status).toBe(0);
    run(d, s, ['plan', manifest(d, 'B', 'A')]);
    expect(run(d, s, ['dispatch', 'A', 'codex-structured']).status).toBe(0);
    expect(run(d, s, ['verdict', 'A', 'codex-structured', 'clean']).status).toBe(0);
    expect(run(d, s, ['complete', 'A']).status).toBe(0);
    const b = run(d, s, ['plan', manifest(d, 'B', 'B')]);
    expect(b.stdout).toContain('CARRIED_REPAIR_CYCLES=0');
    expect(b.stdout).toMatch(/^CARRIED_FROM=$/m);
  });
  test('a clean later cycle cannot hide an unresolved earlier blocking finding', () => {
    const { d, s } = setup();
    expect(spawnSync('git', ['checkout', '-b', 'feat/x'], { cwd: d, timeout: 30_000 }).status).toBe(0);
    run(d, s, ['plan', manifest(d, 'B', 'A'), '--cycle', '0']);
    expect(run(d, s, ['dispatch', 'A', 'codex-structured', '--cycle', '0']).status).toBe(0);
    expect(run(d, s, ['verdict', 'A', 'codex-structured', 'issues_found', '--critical', '1', '--cycle', '0']).status).toBe(0);
    expect(run(d, s, ['finding', 'A', JSON.stringify({
      severity: 'P1', fingerprint: 'fp', gate: 'codex-structured', summary: 'earlier issue',
    }), '--cycle', '0']).status).toBe(0);
    expect(run(d, s, ['rerun-check', 'A', '--cycle', '0']).stdout).toContain('FULL_RERUN=true');
    run(d, s, ['plan', manifest(d, 'B', 'A'), '--cycle', '1']);
    expect(run(d, s, ['dispatch', 'A', 'codex-structured', '--cycle', '1']).status).toBe(0);
    expect(run(d, s, ['verdict', 'A', 'codex-structured', 'clean', '--cycle', '1']).status).toBe(0);
    expect(run(d, s, ['complete', 'A', '--cycle', '1']).status).toBe(0);
    const b = run(d, s, ['plan', manifest(d, 'B', 'B')]);
    expect(b.stdout).toContain('CARRIED_REPAIR_CYCLES=1');
    expect(b.stdout).toMatch(/^CARRIED_FROM=A$/m);
  });
  test('an earlier fixed finding is closed by a later clean full rerun', () => {
    const { d, s } = setup();
    expect(spawnSync('git', ['checkout', '-b', 'feat/x'], { cwd: d, timeout: 30_000 }).status).toBe(0);
    run(d, s, ['plan', manifest(d, 'B', 'A'), '--cycle', '0']);
    expect(run(d, s, ['dispatch', 'A', 'codex-structured', '--cycle', '0']).status).toBe(0);
    expect(run(d, s, ['verdict', 'A', 'codex-structured', 'issues_found', '--critical', '1', '--cycle', '0']).status).toBe(0);
    expect(run(d, s, ['finding', 'A', JSON.stringify({
      severity: 'P1', fingerprint: 'fp', gate: 'codex-structured', summary: 'earlier issue',
    }), '--cycle', '0']).status).toBe(0);
    expect(run(d, s, ['resolve', 'A', 'fp', '--action', 'fixed']).status).toBe(0);
    expect(run(d, s, ['rerun-check', 'A', '--cycle', '0']).stdout).toContain('FULL_RERUN=true');
    run(d, s, ['plan', manifest(d, 'B', 'A'), '--cycle', '1']);
    expect(run(d, s, ['dispatch', 'A', 'codex-structured', '--cycle', '1']).status).toBe(0);
    expect(run(d, s, ['verdict', 'A', 'codex-structured', 'clean', '--cycle', '1']).status).toBe(0);
    expect(run(d, s, ['complete', 'A', '--cycle', '1']).status).toBe(0);
    const b = run(d, s, ['plan', manifest(d, 'B', 'B')]);
    expect(b.stdout).toContain('CARRIED_REPAIR_CYCLES=0');
    expect(b.stdout).toMatch(/^CARRIED_FROM=$/m);
  });
  test('critical counts sum across retry verdicts for the same gate and cycle', () => {
    const { d, s } = setup();
    expect(spawnSync('git', ['checkout', '-b', 'feat/x'], { cwd: d, timeout: 30_000 }).status).toBe(0);
    run(d, s, ['plan', manifest(d, 'B', 'A'), '--cycle', '0']);
    run(d, s, ['rerun-check', 'A', '--cycle', '0']);
    run(d, s, ['plan', manifest(d, 'B', 'A'), '--cycle', '1']);
    expect(run(d, s, ['dispatch', 'A', 'codex-structured', '--cycle', '1']).status).toBe(0);
    expect(run(d, s, ['verdict', 'A', 'codex-structured', 'error', '--critical', '1', '--cycle', '1']).status).toBe(0);
    expect(run(d, s, ['dispatch', 'A', 'codex-structured', '--cycle', '1']).status).toBe(0);
    expect(run(d, s, ['verdict', 'A', 'codex-structured', 'issues_found', '--critical', '1', '--cycle', '1']).status).toBe(0);
    expect(run(d, s, ['finding', 'A', JSON.stringify({
      severity: 'P1', fingerprint: 'fp', gate: 'codex-structured', summary: 'one recorded issue',
    }), '--cycle', '1']).status).toBe(0);
    expect(run(d, s, ['resolve', 'A', 'fp', '--action', 'accepted']).status).toBe(0);
    expect(run(d, s, ['complete', 'A', '--cycle', '1']).status).toBe(0);
    const b = run(d, s, ['plan', manifest(d, 'B', 'B')]);
    expect(b.stdout).toContain('CARRIED_REPAIR_CYCLES=1');
    expect(b.stdout).toMatch(/^CARRIED_FROM=A$/m);
  });
});


test('D4 native and upstream reviewer accounting cannot substitute for routed slots', () => {
  const { d, s } = setup();
  const file = manifest(d, 'D', 'd4');
  expect(run(d, s, ['plan', file]).status).toBe(0);
  const plan = JSON.parse(run(d, s, ['plan', file, '--json']).stdout);
  for (const reviewer of plan.reviewers) {
    expect(run(d, s, ['dispatch', 'd4', reviewer.gate]).status).toBe(0);
    expect(run(d, s, ['verdict', 'd4', reviewer.gate, 'clean']).status).toBe(0);
  }
  expect(run(d, s, ['complete', 'd4', '--require-native']).stdout).toContain('INCOMPLETE=native-adversarial');
  expect(run(d, s, ['register-upstream', 'd4', 'made-up-reviewer']).status).not.toBe(0);
  for (const gate of ['native-adversarial', 'upstream-specialist:maintainability']) {
    expect(run(d, s, ['register-upstream', 'd4', gate]).status).toBe(0);
    expect(run(d, s, ['dispatch', 'd4', gate]).status).toBe(0);
    expect(run(d, s, ['complete', 'd4', '--require-native']).status).toBe(2);
    expect(run(d, s, ['verdict', 'd4', gate, 'error']).status).toBe(0);
    expect(run(d, s, ['complete', 'd4', '--require-native']).status).toBe(2);
    expect(run(d, s, ['dispatch', 'd4', gate]).status).toBe(0);
    expect(run(d, s, ['verdict', 'd4', gate, 'clean']).status).toBe(0);
    expect(run(d, s, ['dispatch', 'd4', gate]).stdout).toContain('duplicate-slot');
  }
  expect(run(d, s, ['register-upstream', 'd4', 'upstream-outside:challenge', '--optional', '--model', 'gpt-6.1-sol', '--effort', 'high']).status).toBe(0);
  expect(run(d, s, ['dispatch', 'd4', 'upstream-outside:challenge']).status).toBe(0);
  expect(run(d, s, ['verdict', 'd4', 'upstream-outside:challenge', 'timeout']).status).toBe(0);
  // D4 keeps upstream's optional challenge failure non-blocking.
  expect(run(d, s, ['complete', 'd4', '--require-native']).status).toBe(0);
  // A refresh cannot relabel the successful upstream verdict to a newer candidate.
  const raw = JSON.parse(readFileSync(file, 'utf8')); raw.wtree = 'new-candidate';
  writeFileSync(file, JSON.stringify(raw));
  expect(run(d, s, ['plan', file]).status).toBe(0);
  expect(run(d, s, ['complete', 'd4', '--require-native']).status).toBe(2);
}, 30_000); // 37 isolated CLI calls; observed >5s sandbox launch time, without changing any per-child or model budget.

const finalSlice = {
  outcome: { present: true, outcome_id: 'o', slice_number: 2, is_final_slice: true, is_flag_flip: false },
};
test('complete owes the same gates through the shared owed-gate function', () => {
  const { d, s } = setup();
  const ok = (...a: string[]) => {
    const r = run(d, s, a);
    expect(r.status, `${a.join(' ')}\n${r.stdout}${r.stderr}`).toBe(0);
    return r;
  };
  const incomplete = (id: string, flags: string[], line: string) => {
    const r = run(d, s, ['complete', id, ...flags]);
    expect(r.stdout).toBe(`${line}\n`);
    expect(r.status).toBe(2);
  };
  ok('plan', manifest(d, 'B', 'cc', {}, finalSlice));
  incomplete('cc', [], 'INCOMPLETE=codex-structured');
  incomplete('cc', ['--require-native'], 'INCOMPLETE=codex-structured,native-adversarial');
  incomplete('cc', ['--require-audits'], 'INCOMPLETE=codex-structured,coverage-audit,plan-completion');
  incomplete('cc', ['--final'], 'INCOMPLETE=codex-structured,coverage-audit,plan-completion,doc-release');
  incomplete('cc', ['--final', '--require-native'],
    'INCOMPLETE=codex-structured,native-adversarial,coverage-audit,plan-completion,doc-release');
  // A dispatched pre-review audit is owed on every path; doc-release only under --final.
  ok('dispatch', 'cc', 'coverage-audit');
  ok('dispatch', 'cc', 'doc-release');
  incomplete('cc', [], 'INCOMPLETE=codex-structured,coverage-audit');
  ok('dispatch', 'cc', 'codex-structured');
  ok('verdict', 'cc', 'codex-structured', 'clean');
  ok('verdict', 'cc', 'coverage-audit', 'error');
  incomplete('cc', [], 'INCOMPLETE=coverage-audit');
  ok('dispatch', 'cc', 'coverage-audit');
  ok('verdict', 'cc', 'coverage-audit', 'clean');
  expect(ok('complete', 'cc').stdout).toBe('COMPLETE=true\n');
  incomplete('cc', ['--final'], 'INCOMPLETE=plan-completion,doc-release');
  ok('verdict', 'cc', 'doc-release', 'issues_found');
  incomplete('cc', ['--final'], 'INCOMPLETE=plan-completion');
  const project = join(s, 'projects', d.split('/').at(-1)!, 'budgets');
  const ledger = readFileSync(join(project, 'cc.ledger.jsonl'), 'utf8').trim().split('\n').map(text => JSON.parse(text));
  expect(ledger.filter((r: any) => r.record_type === 'complete')).toHaveLength(1);
  // An intermediate slice owes no unplanned audit; doc-release stays planned by default.
  ok('plan', manifest(d, 'B', 'ci'));
  ok('dispatch', 'ci', 'codex-structured');
  ok('verdict', 'ci', 'codex-structured', 'clean');
  expect(ok('complete', 'ci', '--require-audits').stdout).toBe('COMPLETE=true\n');
  incomplete('ci', ['--final'], 'INCOMPLETE=doc-release');
  // Semantic verdicts bind to the plan's tree and SHA; audits do not.
  const bound = manifest(d, 'B', 'cw', {}, finalSlice);
  const raw = JSON.parse(readFileSync(bound, 'utf8'));
  writeFileSync(bound, JSON.stringify({ ...raw, wtree: 'w1' }));
  ok('plan', bound);
  for (const gate of ['coverage-audit', 'plan-completion', 'codex-structured']) {
    ok('dispatch', 'cw', gate);
    ok('verdict', 'cw', gate, 'clean');
  }
  expect(ok('complete', 'cw', '--require-audits').stdout).toBe('COMPLETE=true\n');
  writeFileSync(bound, JSON.stringify({ ...raw, wtree: 'w2' }));
  ok('plan', bound);
  incomplete('cw', ['--require-audits'], 'INCOMPLETE=codex-structured');
}, 60_000); // ~40 isolated CLI calls at ~100-170ms each

/**
 * One final-slice tier-B /ship run `ship` (repair cycles max 1). Its manifest
 * lives outside the repo so rerun-check and gstack-wtree see only real edits.
 * `expectReason` checks both output forms and that the budgets directory is
 * byte-identical across every `converged` call.
 */
function shipRun(policy?: any) {
  const { d, s } = setup(policy);
  const budgets = join(s, 'projects', d.split('/').at(-1)!, 'budgets');
  const cli = (...a: string[]) => run(d, s, a);
  const ok = (...a: string[]) => {
    const r = cli(...a);
    expect(r.status, `${a.join(' ')}\n${r.stdout}${r.stderr}`).toBe(0);
    return r;
  };
  const plan = (cycle = 0, withWtree = false) => {
    const mp = manifest(d, 'B', 'ship', {}, finalSlice);
    const raw = JSON.parse(readFileSync(mp, 'utf8'));
    rmSync(mp);
    if (withWtree)
      raw.wtree = spawnSync(join(import.meta.dir, '..', 'bin/gstack-wtree'), [], {
        cwd: d, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
      }).stdout.trim();
    const out = join(s, `manifest-${cycle}.json`);
    writeFileSync(out, JSON.stringify(raw));
    ok('plan', out, '--cycle', String(cycle));
  };
  /** Steps 9-11.5: both audits, the routed reviewer (verdict args `codex`), native, then `complete`. */
  const review = (cycle = 0, codex: string[] = ['clean'], finish = true) => {
    const c = ['--cycle', String(cycle)];
    for (const gate of ['coverage-audit', 'plan-completion']) {
      ok('dispatch', 'ship', gate, ...c);
      ok('verdict', 'ship', gate, 'clean', ...c);
    }
    ok('dispatch', 'ship', 'codex-structured', ...c);
    ok('verdict', 'ship', 'codex-structured', ...codex, ...c);
    ok('register-upstream', 'ship', 'native-adversarial', ...c);
    ok('dispatch', 'ship', 'native-adversarial', ...c);
    ok('verdict', 'ship', 'native-adversarial', 'clean', ...c);
    if (finish)
      expect(ok('complete', 'ship', ...c, '--require-audits', '--require-native').stdout).toBe('COMPLETE=true\n');
  };
  /** Step 14.5, after `complete`: /ship never passes --final. */
  const docRelease = (verdict = 'clean', cycle = 0) => {
    ok('dispatch', 'ship', 'doc-release', '--cycle', String(cycle));
    ok('verdict', 'ship', 'doc-release', verdict, '--cycle', String(cycle));
  };
  const finding = (fp: string) =>
    ok('finding', 'ship', JSON.stringify({ severity: 'P1', fingerprint: fp, gate: 'codex-structured', summary: fp }));
  const snapshot = () => existsSync(budgets)
    ? readdirSync(budgets).sort().map((f) => [f, readFileSync(join(budgets, f), 'utf8')])
    : [];
  const expectReason = (reason: string) => {
    const converged = reason === 'converged';
    const before = snapshot();
    const text = cli('converged', 'ship');
    expect(text.stdout).toBe(`CONVERGED=${converged}\nREASON=${reason}\n`);
    expect(text.status).toBe(converged ? 0 : 2);
    const json = cli('converged', 'ship', '--json');
    expect(JSON.parse(json.stdout)).toEqual({ converged, reason });
    expect(json.status).toBe(converged ? 0 : 2);
    expect(snapshot()).toEqual(before);
  };
  return { d, s, budgets, cli, ok, plan, review, docRelease, finding, expectReason };
}
describe('converged <run_id>', () => {
  test('a clean shipped run converges once its doc-release audit is terminal', () => {
    const f = shipRun();
    f.plan();
    f.review();
    f.expectReason('audit-incomplete:doc-release');
    f.docRelease('clean');
    f.expectReason('converged');
  }, 60_000);
  test('a doc-release error or timeout after complete does not converge: the last verdict decides', () => {
    const f = shipRun();
    f.plan();
    f.review();
    f.docRelease('error');
    f.expectReason('audit-incomplete:doc-release');
    f.docRelease('clean');
    f.expectReason('converged');
    f.docRelease('timeout');
    f.expectReason('audit-incomplete:doc-release');
  }, 60_000);
  test('a /review-path completion still owes native and every planned audit', () => {
    const f = shipRun();
    f.plan();
    f.ok('dispatch', 'ship', 'codex-structured');
    f.ok('verdict', 'ship', 'codex-structured', 'clean');
    expect(f.ok('complete', 'ship').stdout).toBe('COMPLETE=true\n');
    f.expectReason('audit-incomplete:native-adversarial');
  }, 60_000);
  test('an exhausted repair budget does not converge, even with complete', () => {
    const f = shipRun();
    f.plan(0);
    f.plan(2);
    f.review(2);
    f.docRelease('clean', 2);
    f.expectReason('converged');
    const exhausted = f.cli('rerun-check', 'ship', '--cycle', '2');
    expect(exhausted.status).toBe(3);
    expect(exhausted.stdout).toContain('REPAIR_CYCLES_EXHAUSTED=true');
    f.expectReason('repair-budget-exhausted');
    expect(f.ok('complete', 'ship', '--cycle', '2', '--require-audits', '--require-native').stdout)
      .toBe('COMPLETE=true\n');
    f.expectReason('repair-budget-exhausted');
  }, 60_000);
  test('an unrecorded critical count or an unresolved blocking finding is blocking-open', () => {
    const f = shipRun();
    f.plan();
    f.review(0, ['issues_found', '--critical', '1']);
    f.docRelease();
    f.expectReason('blocking-open');
    f.finding('fp');
    f.expectReason('blocking-open');
    f.ok('resolve', 'ship', 'fp', '--action', 'accepted');
    f.expectReason('converged');
  }, 60_000);
  test('a fixed finding converges only after a clean --verify-of re-dispatch', () => {
    const f = shipRun();
    f.plan();
    f.review(0, ['issues_found', '--critical', '1']);
    f.finding('fp');
    f.ok('resolve', 'ship', 'fp', '--action', 'fixed');
    f.docRelease();
    f.expectReason('fix-unverified');
    f.ok('dispatch', 'ship', 'codex-structured', '--verify-of', 'fp');
    f.expectReason('fix-unverified');
    f.ok('verdict', 'ship', 'codex-structured', 'clean');
    f.expectReason('converged');
    const dirty = shipRun();
    dirty.plan();
    dirty.review(0, ['issues_found', '--critical', '1']);
    dirty.finding('fp');
    dirty.ok('resolve', 'ship', 'fp', '--action', 'fixed');
    dirty.docRelease();
    dirty.ok('dispatch', 'ship', 'codex-structured', '--verify-of', 'fp');
    dirty.ok('verdict', 'ship', 'codex-structured', 'issues_found');
    dirty.expectReason('fix-unverified');
  }, 60_000);
  test('a narrow fix verified after the last rerun-check converges on that cycle', () => {
    const f = shipRun();
    f.plan();
    f.review(0, ['issues_found', '--critical', '1']);
    f.finding('fp');
    f.ok('resolve', 'ship', 'fp', '--action', 'fixed');
    f.docRelease();
    writeFileSync(join(f.d, 'x.ts'), 'fixed\n');
    expect(f.ok('rerun-check', 'ship').stdout).toContain('FULL_RERUN=false');
    f.expectReason('fix-unverified');
    f.ok('dispatch', 'ship', 'codex-structured', '--verify-of', 'fp');
    f.ok('verdict', 'ship', 'codex-structured', 'clean');
    f.expectReason('converged');
  }, 60_000);
  test('no complete, or a full rerun after complete, is no-completion', () => {
    const f = shipRun();
    f.plan();
    f.review(0, ['clean'], false);
    f.docRelease();
    f.expectReason('no-completion');
    expect(f.ok('complete', 'ship', '--require-audits', '--require-native').stdout).toBe('COMPLETE=true\n');
    f.expectReason('converged');
    mkdirSync(join(f.d, 'lib', 'auth'), { recursive: true });
    writeFileSync(join(f.d, 'lib', 'auth', 'new.ts'), 'x\n');
    expect(f.ok('rerun-check', 'ship').stdout).toContain('FULL_RERUN=true');
    f.expectReason('no-completion');
  }, 60_000);
  test('a non-code-delta plan stops converging when the working tree changes', () => {
    const f = shipRun({ version: 1, auth_surfaces: [], d_surfaces: [], routing: { passes: { non_code_delta: true } } });
    f.plan(0, true);
    f.review();
    f.docRelease();
    f.expectReason('converged');
    writeFileSync(join(f.d, 'x.ts'), 'edited after review\n');
    f.expectReason('working-tree-changed');
    expect(f.cli('complete', 'ship', '--require-audits', '--require-native').stdout)
      .toBe('INCOMPLETE=working-tree-changed\n');
  }, 60_000);
  test('a missing plan is plan-not-found; a missing run id is a usage error', () => {
    const f = shipRun();
    f.expectReason('plan-not-found');
    expect(f.cli('converged').status).toBe(1);
    expect(f.cli('converged', '--json').status).toBe(1);
  }, 60_000);
  test('converged leaves the ledger and plan byte-identical', () => {
    const f = shipRun();
    f.plan();
    f.review();
    f.docRelease();
    const ledger = join(f.budgets, 'ship.ledger.jsonl'), plan = join(f.budgets, 'ship.json');
    for (const [verdict, status] of [['clean', 0], ['error', 2]] as const) {
      if (verdict === 'error') f.docRelease('error');
      const before = [readFileSync(ledger), readFileSync(plan)];
      for (const args of [[], ['--json']]) expect(f.cli('converged', 'ship', ...args).status).toBe(status);
      expect(readFileSync(ledger).equals(before[0])).toBe(true);
      expect(readFileSync(plan).equals(before[1])).toBe(true);
    }
    expect(readdirSync(f.budgets).sort()).toEqual(['ship.json', 'ship.ledger.jsonl']);
  }, 60_000);
});
