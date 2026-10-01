/** Founder D3: exercise policy and accounting through the actual public CLIs. */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
const ROOT = join(import.meta.dir, '..');
const budget = join(ROOT, 'bin/gstack-review-budget');
const manifest = join(ROOT, 'bin/gstack-diff-manifest');
const roots: string[] = [];
const OFF = { upstream_specialists: false, upstream_structured: false, codex_challenge: false,
  native_adversarial: false, red_team_loc_trigger: false, greptile: false, coverage_rating: false, doc_voice: false,
  audit_reuse: true, doc_release_by_impact: true, autofix_informational: false };
function fixture(policy: any = {}) {
  const d = mkdtempSync(join(tmpdir(), 'd3-')), s = mkdtempSync(join(tmpdir(), 'd3s-'));
  roots.push(d, s);
  const env = { ...process.env, GSTACK_HOME: s, GSTACK_STATE_DIR: s, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const cmd = (bin: string, args: string[]) => spawnSync(bin, args, { cwd: d, env, encoding: 'utf8', timeout: 30_000 });
  const git = (...args: string[]) => { const r = cmd('git', args); expect(r.status, r.stderr).toBe(0); return r.stdout.trim(); };
  const write = (p: string, data = 'x\n') => { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), data); };
  git('init', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'T');
  write('.gstack-policy.json', JSON.stringify({ version: 1, ...policy }));
  write('x.ts'); write('README.md'); write('test/old.test.ts'); write('VERSION', '1.0.0\n'); write('package.json', '{"version":"1.0.0","scripts":{"test":"x"}}');
  git('add', '.'); git('commit', '-m', 'seed');
  const ledger = (id = 'run') => {
    try { return readFileSync(join(s, 'projects', basename(d), 'budgets', `${id}.ledger.jsonl`), 'utf8').trim().split('\n').map(JSON.parse); }
    catch { return []; }
  };
  const run = (...args: string[]) => cmd(budget, args);
  const plan = (tier = 'C', cycle = 0, opts: any = {}, id = 'run', json = true) => {
    const wtree = cmd(join(ROOT, 'bin/gstack-wtree'), []).stdout.trim();
    const mp = join(s, `${id}-${cycle}.manifest.json`);
    writeFileSync(mp, JSON.stringify({ run_id: id, wtree, base: 'main', merge_base: git('rev-parse', 'HEAD'),
      policy: { path: '.gstack-policy.json', sha256: 'p1' }, files: [{ path: 'x.ts' }], scope: {},
      routing: { risk_tier: tier, tier_source: 'policy', doc_impact_would_dispatch: false,
        outcome: { present: true, is_final_slice: true } }, ...opts }));
    const r = run('plan', mp, '--cycle', String(cycle), ...(json ? ['--json'] : []));
    expect(r.status, r.stderr).toBe(0);
    return json ? JSON.parse(r.stdout) : r.stdout;
  };
  const verdict = (gate: string, result = 'clean', cycle = 0) => {
    expect(run('dispatch', 'run', gate, '--cycle', String(cycle)).status).toBe(0);
    expect(run('verdict', 'run', gate, result, '--cycle', String(cycle)).status).toBe(0);
  };
  return { d, s, env, run, cmd, git, write, ledger, plan, verdict };
}
afterAll(() => roots.forEach(d => rmSync(d, { recursive: true, force: true })));

for (const [key, literal, field, gate] of [
  ['upstream_specialists', 'UPSTREAM_SPECIALISTS', 'upstreamSpecialists', 'upstream-specialist:testing'],
  ['upstream_structured', 'UPSTREAM_STRUCTURED', 'upstreamStructured', 'upstream-outside:structured'],
  ['codex_challenge', 'CODEX_CHALLENGE', 'codexChallenge', 'upstream-outside:challenge'],
  ['native_adversarial', 'ADVERSARIAL_CLAUDE', 'adversarialClaude', 'native-adversarial'],
  ['greptile', 'GREPTILE', 'greptile', ''], ['coverage_rating', 'COVERAGE_RATING', 'coverageRating', ''],
  ['doc_voice', 'CODEX_DOC_VOICE', 'codexDocVoice', ''], ['red_team_loc_trigger', 'RED_TEAM_LOC_TRIGGER', 'redTeamLocTrigger', ''],
] as const) {
  test(`D3 passes.${key}: absent preserves enabled; false is carried and honoured`, () => {
    for (const enabled of [true, false]) {
      const f = fixture(enabled ? {} : { routing: { passes: { [key]: false } } });
      const flags = f.run('policy-flags'); expect(flags.status).toBe(0); expect(flags.stdout).toContain(`${literal}=${enabled}`);
      const p = f.plan(); expect(p[field]).toBe(enabled);
      expect(f.plan('C', 0, {}, 'text', false)).toContain(`${literal}=${enabled}`);
      expect(p.policyRoutingIgnored).not.toContain('passes');
      if (gate) {
        const r = f.run('register-upstream', 'run', gate);
        expect(r.status).toBe(enabled ? 0 : 2);
        if (!enabled) {
          expect(r.stdout).toContain('reason=policy-disabled');
          expect(f.run('dispatch', 'run', gate, '--escalation', 'user-request:force').status).toBe(2);
        }
      }
    }
  });
}
test('D3 native OFF completes governor slots; absent still owes --require-native; FLOOR never trims', () => {
  for (const enabled of [true, false]) {
    const f = fixture(enabled ? {} : { routing: { passes: OFF } });
    const p = f.plan('D');
    expect(p.reviewerSpecs).toEqual(['codex-structured@high', 'specialist:security@sonnet', 'red-team@sonnet']);
    expect(p.deterministicGates).toBe('tests,typecheck,build,gitleaks,redaction,verification,claim-check,migration-runbook');
    for (const gate of p.reviewers.map((x: any) => x.gate)) f.verdict(gate);
    const r = f.run('complete', 'run', '--require-native');
    expect(r.status).toBe(enabled ? 2 : 0);
    expect(r.stdout).toContain(enabled ? 'INCOMPLETE=native-adversarial' : 'COMPLETE=true');
  }
});
test('D3 advisory policy: absent keeps upstream actions; opted-in classification never fixes advice', () => {
  for (const enabled of [true, false]) {
    const f = fixture(enabled ? {} : { routing: { passes: OFF } });
    expect(f.plan().autofixInformational).toBe(enabled);
  }
});
test('D3 doc-release tier/impact opt-in, absent every ship, skip is explicit', () => {
  for (const opted of [false, true]) {
    const f = fixture(opted ? { routing: { passes: OFF } } : {});
    for (const tier of ['A', 'B', 'C', 'D']) {
      const p = f.plan(tier);
      expect(p.docRelease).toBe(!opted || ['C', 'D'].includes(tier));
      const text = f.plan(tier, 0, {}, 'text', false);
      if (opted && ['A', 'B'].includes(tier)) expect(text).toContain('Documentation: skipped (tier A/B, no doc-impact)');
    }
    expect(f.plan('A', 0, { routing: { risk_tier: 'A', doc_impact_would_dispatch: true, outcome: {} } }).docRelease).toBe(true);
  }
});
test('D3 smoke surfaces and Full lanes are opt-in; local lanes and build gate stay honest', () => {
  const legacy = fixture(); expect(legacy.plan('A').qaSmoke).toBe(true); expect(legacy.plan('A').fullLanesRequired).toBe(true);
  const f = fixture({ qa_smoke_surfaces: ['app/**'], lanes: { full_paths: ['compiler/**'], ci_backstop: 'Full CI' } });
  const p = f.plan('C'); expect(p.qaSmoke).toBe(false); expect(p.fullLanesRequired).toBe(false);
  expect(f.run('policy-flags', 'main').stdout).toContain('QA_SMOKE=false');
  f.write('app/page.tsx'); expect(f.run('policy-flags', 'main').stdout).toContain('QA_SMOKE=true');
  rmSync(join(f.d, 'app'), { recursive: true });
  expect(p.buildGate).toBe('DEFERRED'); expect(p.ciBackstop).toBe('Full CI'); expect(p.deterministicGates).toContain('build');
  expect(f.plan('D').fullLanesRequired).toBe(true);
  expect(f.plan('B', 0, { scope: { config: true } }).fullLanesRequired).toBe(true);
  expect(f.plan('B', 0, { files: [{ path: 'compiler/run.ts' }] }).fullLanesRequired).toBe(true);
  expect(f.plan('B', 0, { files: [{ path: 'app/page.tsx' }] }).qaSmoke).toBe(true);
  expect(f.run('policy-flags', '--json').status).toBe(0);
  const bad = fixture({ lanes: { full_paths: [] } }); expect(bad.plan('B').buildGate).toBe('REQUIRED');
});
test('D3 env example: exact D exceptions + C floor; ordinary auth/migration/env stay fail-upward', () => {
  for (const opt of [false, true]) {
    const f = fixture({ d_surfaces: ['.env*', 'danger/**'], auth_surfaces: ['lib/auth/**'],
      ...(opt ? { d_surface_exceptions: ['.env.example'], c_surfaces: ['.env.example'], env_surfaces: ['lib/env/**'] } : {}) });
    f.write('.env.example', 'PUBLIC_X=1\n');
    const r = f.cmd(manifest, ['main', 'env']); expect(r.status, r.stderr).toBe(0);
    const vars = Object.fromEntries(r.stdout.trim().split('\n').map(l => l.split('=')));
    const m = JSON.parse(readFileSync(vars.MANIFEST_PATH, 'utf8'));
    expect(m.scope.config).toBe(true); expect(m.scope.error).toBeNull();
    expect(m.routing.risk_tier).toBe(opt ? 'C' : 'D');
    f.plan('C', 0, { files: [{ path: '.env.example' }] });
    const rr = f.run('rerun-check', 'run');
    expect(rr.stdout.includes('env:.env.example')).toBe(!opt);
    expect(rr.stdout.includes('d-surface:.env.example')).toBe(!opt);
    f.write('lib/auth/a.ts'); const ar = f.cmd(manifest, ['main', 'auth']);
    const ap = ar.stdout.match(/^MANIFEST_PATH=(.+)$/m)![1];
    expect(JSON.parse(readFileSync(ap, 'utf8')).routing.risk_tier).toBe('D');
  }
});
for (const gate of ['coverage-audit', 'plan-completion', 'doc-release']) {
  test(`D3 audit ${gate}: opt-in copies dispatch/verdict forward; absent still dispatches`, () => {
    for (const opted of [false, true]) {
      const f = fixture(opted ? { routing: { passes: { audit_reuse: true } } } : {});
      f.plan(); f.verdict(gate);
      f.write('VERSION', '1.0.1\n'); f.plan('C', 1);
      const r = f.run('dispatch', 'run', gate, '--cycle', '1');
      expect(r.status).toBe(opted ? 2 : 0);
      if (opted) {
        expect(r.stdout).toContain('DISPATCH=blocked reason=reused');
        const copies = f.ledger().filter(r => r.cycle === 1 && r.reused_from);
        expect(copies.map(r => r.record_type)).toEqual(['dispatch', 'verdict']);
        expect(copies.every(r => r.wtree === f.plan('C', 1).wtree)).toBe(true);
      }
    }
  });
}
test('D3 audit input sets: plan test edits reusable; coverage additions only after CLEAN; source always reruns', () => {
  for (const [gate, verdict, file, expected] of [
    ['plan-completion', 'issues_found', 'test/old.test.ts', true],
    ['coverage-audit', 'clean', 'test/new.test.ts', true],
    ['coverage-audit', 'issues_found', 'test/new.test.ts', false],
    ['coverage-audit', 'clean', 'test/old.test.ts', false],
    ['doc-release', 'clean', 'README.md', false],
    ['plan-completion', 'clean', 'x.ts', false],
    ['coverage-audit', 'clean', 'README.md', true],
  ]) {
    const f = fixture({ routing: { passes: { audit_reuse: true } } });
    f.plan(); f.verdict(gate, verdict); f.write(file, 'changed\n'); f.plan('C', 1);
    expect(f.run('dispatch', 'run', gate, '--cycle', '1').stdout.includes('reason=reused')).toBe(expected);
  }
}, 30_000); // Seven isolated audit scenarios; each child retains its 30-second bound.
test('D3 audit no duplicate work at same tree; error/timeout and changed external inputs never reuse', () => {
  for (const result of ['clean', 'error', 'timeout']) {
    const f = fixture({ routing: { passes: { audit_reuse: true } } }); f.plan(); f.verdict('coverage-audit', result);
    const r = f.run('dispatch', 'run', 'coverage-audit'); expect(r.stdout.includes('reason=reused')).toBe(result === 'clean');
  }
  const f = fixture({ routing: { passes: { audit_reuse: true } } }); f.plan();
  expect(f.run('dispatch', 'run', 'plan-completion', '--inputs-hash', 'old-plan').status).toBe(0);
  expect(f.run('verdict', 'run', 'plan-completion', 'clean').status).toBe(0);
  expect(f.run('dispatch', 'run', 'plan-completion', '--inputs-hash', 'new-plan').stdout.includes('reason=reused')).toBe(false);
});

test('D3 red-team LOC registration cannot override the policy; planned D red-team still runs', () => {
  for (const off of [false, true]) {
    const f = fixture(off ? { routing: { passes: { red_team_loc_trigger: false } } } : {});
    f.plan('D');
    expect(f.run('register-upstream', 'run', 'upstream-specialist:red-team', '--trigger', 'loc').status).toBe(off ? 2 : 0);
    expect(f.run('dispatch', 'run', 'red-team').status).toBe(0);
  }
});
