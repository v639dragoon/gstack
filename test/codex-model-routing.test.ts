/**
 * Model routing for the codex-structured slot (dohma ruling 2026-09-04).
 *
 * Contract pinned here:
 *  - policy `routing.models` may name a MODEL for a Codex slot that is ALREADY
 *    on the plan (today: gpt-6-astra on tiers C and D). It is budget-neutral
 *    and effort-neutral by construction: the reviewer list, budget, repair
 *    cycles and effort suffix are byte-identical with and without the key; an
 *    effort in the policy that differs from the routed one is ignored and
 *    recorded; specialists and off-plan gates never take a model.
 *  - gstack-codex-model resolves the model ONCE per dispatch with one minimal
 *    access check (client catalog, then a round trip) and falls back to the
 *    default route with the substitution LOGGED; inconclusive is never cached
 *    and never routes; xhigh/max/ultra are refused.
 *  - gstack-gate-log refuses `max` without a user override and refuses an
 *    Astra record outside the routed codex-structured slot (gate codex-structured
 *    AND effort_source routed) without model_reason.
 *  - gstack-outcome-report reads model/effort/elapsed/tokens/substitutions
 *    from the gate rows it already aggregates (no new telemetry stream).
 *  - The rendered routed step carries the model flags on BOTH codex calls and
 *    the model fields on the gate row; the effort pin is untouched.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const ROOT = join(import.meta.dir, '..');
const BUDGET = join(ROOT, 'bin', 'gstack-review-budget');
const RESOLVE = join(ROOT, 'bin', 'gstack-codex-model');
const GATE_LOG = join(ROOT, 'bin', 'gstack-gate-log');
const REPORT = join(ROOT, 'bin', 'gstack-outcome-report');
const dirs: string[] = [];
afterAll(() => dirs.forEach((x) => rmSync(x, { recursive: true, force: true })));

const MODELS_POLICY = {
  version: 1,
  auth_surfaces: ['lib/auth/**'],
  d_surfaces: ['danger/**'],
  routing: {
    budgets: { A: 1, B: 1, C: 2, D: 3 },
    repair_cycles: { AB: 1, CD: 2 },
    models: {
      'codex-structured': {
        C: { model: 'gpt-6-astra', effort: 'medium' },
        D: { model: 'gpt-6-astra', effort: 'high' },
      },
    },
  },
};

function repo(policy: any) {
  const d = mkdtempSync(join(tmpdir(), 'model-route-repo-')),
    s = mkdtempSync(join(tmpdir(), 'model-route-state-'));
  dirs.push(d, s);
  for (const a of [['init', '-b', 'main'], ['config', 'user.email', 't@t'], ['config', 'user.name', 'T']])
    spawnSync('git', a, { cwd: d, timeout: 30_000 });
  writeFileSync(join(d, '.gstack-policy.json'), JSON.stringify(policy));
  writeFileSync(join(d, 'x.ts'), 'x\n');
  spawnSync('git', ['add', '.'], { cwd: d, timeout: 30_000 });
  spawnSync('git', ['commit', '-m', 'base'], { cwd: d, timeout: 30_000 });
  return { d, s };
}
function manifest(d: string, tier: string, id: string) {
  const p = join(d, `${id}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      run_id: id,
      files: [{ path: 'x.ts' }],
      scope: {},
      policy: { path: '.gstack-policy.json' },
      routing: {
        risk_tier: tier,
        tier_source: 'policy',
        auth_surface_matches: [],
        doc_impact_would_dispatch: false,
        outcome: { present: true, is_final_slice: false, is_flag_flip: false, outcome_id: 'o', slice_number: 1 },
      },
    }),
  );
  return p;
}
function budget(d: string, s: string, args: string[]) {
  return spawnSync(BUDGET, args, {
    cwd: d,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, GSTACK_STATE_DIR: s, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}
const kv = (out: string) =>
  Object.fromEntries(out.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

describe('policy routing.models on the review plan', () => {
  test('names gpt-6-astra on C (medium) and D (high) only; A/B stay on the default route', () => {
    const { d, s } = repo(MODELS_POLICY);
    const expectPlan = (tier: string, model: string | null, effort: string) => {
      const p = JSON.parse(budget(d, s, ['plan', manifest(d, tier, `p${tier}`), '--json']).stdout);
      const codex = p.reviewers.find((r: any) => r.gate === 'codex-structured');
      expect(codex.model_or_effort).toBe(effort);
      expect(codex.model ?? null).toBe(model);
      expect(p.codexModel).toBe(model);
      expect(p.codexModelSource).toBe(model ? 'policy' : 'default');
      expect(p.codexEffort).toBe(effort);
      expect(p.policyRoutingIgnored).toEqual([]);
      const text = budget(d, s, ['plan', manifest(d, tier, `t${tier}`)]).stdout;
      const k = kv(text);
      expect(k.CODEX_MODEL).toBe(model ?? '');
      expect(k.CODEX_MODEL_SOURCE).toBe(model ? 'policy' : 'default');
      expect(k.CODEX_EFFORT).toBe(effort);
      expect(k.POLICY_ROUTING_IGNORED).toBe('');
    };
    expectPlan('A', null, 'medium');
    expectPlan('B', null, 'medium');
    expectPlan('C', 'gpt-6-astra', 'medium');
    expectPlan('D', 'gpt-6-astra', 'high');
  });

  test('is budget-neutral: reviewer list, budget, cycles and gates are identical with and without the key', () => {
    const { models, ...routingWithout } = MODELS_POLICY.routing as any;
    const without = repo({ ...MODELS_POLICY, routing: routingWithout });
    const withModels = repo(MODELS_POLICY);
    for (const tier of ['A', 'B', 'C', 'D']) {
      const a = kv(budget(without.d, without.s, ['plan', manifest(without.d, tier, `w${tier}`)]).stdout);
      const b = kv(budget(withModels.d, withModels.s, ['plan', manifest(withModels.d, tier, `m${tier}`)]).stdout);
      for (const key of ['REVIEWERS', 'REVIEWER_BUDGET', 'REPAIR_CYCLES_MAX', 'DETERMINISTIC_GATES', 'EFFECTIVE_TIER'])
        expect(b[key], `${tier}:${key}`).toBe(a[key]);
      expect(b.REVIEWERS).toContain(tier === 'D' ? 'codex-structured@high' : 'codex-structured@medium');
    }
  });

  test('counts against the existing budget: the routed model adds no dispatch on C', () => {
    const { d, s } = repo(MODELS_POLICY);
    budget(d, s, ['plan', manifest(d, 'C', 'c1')]);
    expect(budget(d, s, ['dispatch', 'c1', 'codex-structured']).status).toBe(0);
    expect(budget(d, s, ['dispatch', 'c1', 'specialist:testing']).status).toBe(0);
    const third = budget(d, s, ['dispatch', 'c1', 'codex-structured']);
    expect(third.status).toBe(2);
    expect(third.stdout).toContain('DISPATCH=blocked');
    // A model is not a new reviewer: an unplanned gate is still off-plan.
    expect(budget(d, s, ['dispatch', 'c1', 'red-team']).status).toBe(2);
  });

  test('never changes effort: a differing or above-high policy effort is ignored and recorded', () => {
    const policy = JSON.parse(JSON.stringify(MODELS_POLICY));
    policy.routing.models['codex-structured'].C = { model: 'gpt-6-astra', effort: 'xhigh' };
    policy.routing.models['codex-structured'].D = { model: 'gpt-6-astra', effort: 'medium' };
    const { d, s } = repo(policy);
    const c = kv(budget(d, s, ['plan', manifest(d, 'C', 'ec')]).stdout);
    expect(c.REVIEWERS).toContain('codex-structured@medium');
    expect(c.CODEX_EFFORT).toBe('medium');
    expect(c.CODEX_MODEL).toBe('gpt-6-astra');
    expect(c.POLICY_MODEL_IGNORED).toContain('codex-structured:C:effort-xhigh-ignored');
    const dd = kv(budget(d, s, ['plan', manifest(d, 'D', 'ed')]).stdout);
    expect(dd.REVIEWERS).toContain('codex-structured@high');
    expect(dd.CODEX_EFFORT).toBe('high');
    expect(dd.POLICY_MODEL_IGNORED).toContain('codex-structured:D:effort-medium-ignored');
  });

  test('only the Codex slot takes a model; specialists, off-plan gates and malformed slugs are ignored and recorded', () => {
    const policy = JSON.parse(JSON.stringify(MODELS_POLICY));
    policy.routing.models['red-team'] = { D: { model: 'gpt-6-astra' } };
    policy.routing.models['specialist:security'] = { D: 'gpt-6-astra' };
    policy.routing.models['codex-structured'].B = { model: 'bad slug; rm -rf' };
    const { d, s } = repo(policy);
    const dd = kv(budget(d, s, ['plan', manifest(d, 'D', 'sd')]).stdout);
    expect(dd.POLICY_MODEL_IGNORED).toContain('red-team:not-codex');
    expect(dd.POLICY_MODEL_IGNORED).toContain('specialist:security:not-codex');
    expect(dd.CODEX_MODEL).toBe('gpt-6-astra');
    expect(dd.REVIEWERS).toBe('codex-structured@high,specialist:security@sonnet,red-team@sonnet');
    const b = kv(budget(d, s, ['plan', manifest(d, 'B', 'sb')]).stdout);
    expect(b.CODEX_MODEL).toBe('');
    expect(b.POLICY_MODEL_IGNORED).toContain('codex-structured:B:bad-model');
  });
});

// ─── gstack-codex-model: resolution with a STUBBED codex binary ─────────────

const STUB = `#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$1" in
  --version) echo "codex-cli 0.149.0"; exit 0 ;;
  debug)
    case "\${STUB_CATALOG:-with}" in
      with) echo '{"models":[{"slug":"gpt-5.6-sol"},{"slug":"gpt-6-astra"}]}'; exit 0 ;;
      without) echo '{"models":[{"slug":"gpt-5.6-sol"}]}'; exit 0 ;;
      fail) echo "debug unavailable" >&2; exit 1 ;;
    esac ;;
  exec)
    case "\${STUB_MODE:-ok}" in
      ok) echo "OK"; exit 0 ;;
      newer)
        echo 'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The '"'"'gpt-6-astra'"'"' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}' >&2
        exit 1 ;;
      unsupported)
        echo 'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The '"'"'gpt-6-astra'"'"' model is not supported when using Codex with a ChatGPT account."}}' >&2
        exit 1 ;;
      transient) echo "stream error: network unreachable" >&2; exit 7 ;;
    esac ;;
esac
exit 0
`;

function resolverEnv(extra: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'model-route-home-'));
  const codexHome = join(home, 'codex');
  const stubDir = join(home, 'stub');
  const cwd = join(home, 'work');
  dirs.push(home);
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(stubDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(codexHome, 'auth.json'), '{"auth_mode":"chatgpt"}');
  writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n');
  writeFileSync(join(stubDir, 'codex'), STUB);
  chmodSync(join(stubDir, 'codex'), 0o755);
  const log = join(home, 'stub.log');
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: codexHome,
    GSTACK_HOME: join(home, 'gstack'),
    STUB_LOG: log,
    PATH: `${stubDir}:${process.env.PATH}`,
    ...extra,
  };
  return { env, cwd, log };
}
function resolve(env: NodeJS.ProcessEnv, cwd: string, args: string[]) {
  return spawnSync(RESOLVE, ['resolve', ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 });
}
const parseQuoted = (out: string) =>
  Object.fromEntries(
    out
      .trim()
      .split('\n')
      .filter((l) => /^[A-Z_]+='/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 2, -1)]),
  );
const invocations = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);

describe('gstack-codex-model resolve', () => {
  test('available model: catalog lists it, one round trip confirms it, flags pin it, result cached', () => {
    const { env, cwd, log } = resolverEnv();
    const r = resolve(env, cwd, ['--model', 'gpt-6-astra', '--effort', 'medium', '--source', 'policy']);
    expect(r.status).toBe(0);
    const k = parseQuoted(r.stdout);
    expect(k).toMatchObject({
      CODEX_MODEL_REQUESTED: 'gpt-6-astra',
      CODEX_MODEL: 'gpt-6-astra',
      CODEX_MODEL_SOURCE: 'policy',
      CODEX_MODEL_SUBSTITUTED: 'false',
      CODEX_MODEL_SUBSTITUTION_REASON: 'none',
      CODEX_MODEL_EXEC_FLAGS: '--model gpt-6-astra',
      CODEX_MODEL_REVIEW_FLAGS: '-c model="gpt-6-astra"',
      CODEX_EFFORT: 'medium',
    });
    const execCalls = invocations(log).filter((l) => l.startsWith('exec '));
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toContain('--model gpt-6-astra');
    expect(execCalls[0]).toContain('-s read-only');
    // The reachability round trip pins its own effort LOW so it can never
    // inherit an ambient user-level xhigh/max/ultra (ship red-team 2026-09-04).
    expect(execCalls[0]).toContain('model_reasoning_effort="low"');
    // Cached: the second resolution makes NO further round trip.
    const again = resolve(env, cwd, ['--model', 'gpt-6-astra', '--effort', 'high', '--source', 'policy']);
    expect(parseQuoted(again.stdout).CODEX_MODEL).toBe('gpt-6-astra');
    expect(parseQuoted(again.stdout).CODEX_EFFORT).toBe('high');
    expect(invocations(log).filter((l) => l.startsWith('exec '))).toHaveLength(1);
  });

  test('a slug the client catalog does not know falls back to the default route WITHOUT a round trip, logged', () => {
    const { env, cwd, log } = resolverEnv({ STUB_CATALOG: 'without' });
    const r = resolve(env, cwd, ['--model', 'gpt-6-astra', '--effort', 'medium', '--source', 'policy']);
    expect(r.status).toBe(0);
    const k = parseQuoted(r.stdout);
    expect(k.CODEX_MODEL_REQUESTED).toBe('gpt-6-astra');
    expect(k.CODEX_MODEL).toBe('gpt-5.6-sol');
    expect(k.CODEX_MODEL_SOURCE).toBe('fallback');
    expect(k.CODEX_MODEL_SUBSTITUTED).toBe('true');
    expect(k.CODEX_MODEL_SUBSTITUTION_REASON).toMatch(/^model-unavailable:.*catalog/);
    expect(k.CODEX_MODEL_EXEC_FLAGS).toBe('');
    expect(k.CODEX_MODEL_REVIEW_FLAGS).toBe('');
    expect(r.stderr).toContain('keeping the default route (gpt-5.6-sol)');
    expect(invocations(log).filter((l) => l.startsWith('exec '))).toHaveLength(0);
  });

  test('a 400 "requires a newer version of Codex" falls back with the upgrade hint recorded', () => {
    const { env, cwd } = resolverEnv({ STUB_MODE: 'newer' });
    const k = parseQuoted(resolve(env, cwd, ['--model', 'gpt-6-astra', '--effort', 'high', '--source', 'policy']).stdout);
    expect(k.CODEX_MODEL).toBe('gpt-5.6-sol');
    expect(k.CODEX_MODEL_SUBSTITUTED).toBe('true');
    expect(k.CODEX_MODEL_SUBSTITUTION_REASON).toContain('requires a newer version of Codex');
    expect(k.CODEX_EFFORT).toBe('high');
  });

  test('an account that cannot use the model falls back too', () => {
    const { env, cwd } = resolverEnv({ STUB_MODE: 'unsupported' });
    const k = parseQuoted(resolve(env, cwd, ['--model', 'gpt-6-astra', '--effort', 'medium']).stdout);
    expect(k.CODEX_MODEL_SUBSTITUTED).toBe('true');
    expect(k.CODEX_MODEL_SUBSTITUTION_REASON).toContain('not supported');
  });

  test('inconclusive (transient) keeps the default route for THIS run and is never cached', () => {
    const { env, cwd, log } = resolverEnv({ STUB_MODE: 'transient' });
    const k = parseQuoted(resolve(env, cwd, ['--model', 'gpt-6-astra', '--effort', 'medium']).stdout);
    expect(k.CODEX_MODEL).toBe('gpt-5.6-sol');
    expect(k.CODEX_MODEL_SUBSTITUTED).toBe('true');
    expect(k.CODEX_MODEL_SUBSTITUTION_REASON).toMatch(/^probe-inconclusive:/);
    resolve(env, cwd, ['--model', 'gpt-6-astra', '--effort', 'medium']);
    expect(invocations(log).filter((l) => l.startsWith('exec '))).toHaveLength(2);
  });

  test('the default route makes no codex call and names the layered default for the record', () => {
    const { env, cwd, log } = resolverEnv();
    const k = parseQuoted(resolve(env, cwd, ['--model', '', '--effort', 'medium']).stdout);
    expect(k).toMatchObject({
      CODEX_MODEL_REQUESTED: 'default',
      CODEX_MODEL: 'gpt-5.6-sol',
      CODEX_MODEL_SOURCE: 'default',
      CODEX_MODEL_SUBSTITUTED: 'false',
      CODEX_MODEL_EXEC_FLAGS: '',
      CODEX_MODEL_REVIEW_FLAGS: '',
    });
    expect(invocations(log)).toHaveLength(0);
  });

  test('effort above high is refused, never resolved automatically', () => {
    const { env, cwd } = resolverEnv();
    for (const effort of ['xhigh', 'max', 'ultra']) {
      const r = resolve(env, cwd, ['--model', 'gpt-6-astra', '--effort', effort]);
      expect(r.status, effort).toBe(1);
      expect(r.stderr).toContain('never selected automatically');
    }
    expect(resolve(env, cwd, ['--model', 'gpt-6;astra', '--effort', 'medium']).status).toBe(1);
    // A leading dash is argument injection into `codex --model`, not a slug
    // (ship security review 2026-09-04): refused here even though the planner
    // already anchors, because this bin is callable directly.
    for (const bad of ['-c', '--dangerously-bypass-approvals-and-sandbox', '.hidden', 'a'.repeat(65)]) {
      const r = resolve(env, cwd, ['--model', bad, '--effort', 'medium']);
      expect(r.status, bad).toBe(1);
      expect(r.stdout, bad).not.toContain('CODEX_MODEL_EXEC_FLAGS=\'--model');
    }
  });

  test('output is eval-safe shell, including the quoted review flag', () => {
    const { env, cwd } = resolverEnv();
    const r = spawnSync(
      'bash',
      ['-c', `eval "$(${RESOLVE} resolve --model gpt-6-astra --effort medium --source policy)"; printf '%s|%s|%s' "$CODEX_MODEL" "$CODEX_MODEL_EXEC_FLAGS" "$CODEX_MODEL_REVIEW_FLAGS"`],
      { cwd, env, encoding: 'utf8', timeout: 60_000 },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('gpt-6-astra|--model gpt-6-astra|-c model="gpt-6-astra"');
  });
});

// ─── gstack-gate-log: Astra records and the max ceiling ─────────────────────

describe('gstack-gate-log model rules', () => {
  function gateLog(input: string) {
    const state = mkdtempSync(join(tmpdir(), 'model-route-gates-'));
    dirs.push(state);
    return spawnSync(GATE_LOG, [input], {
      cwd: ROOT,
      env: { ...process.env, GSTACK_HOME: state },
      encoding: 'utf8',
      timeout: 30_000,
    });
  }
  const base = { record_type: 'gate', gate: 'codex-structured', run_id: 'r-1', trigger: 'review-plan' };

  test('effort max is refused without a reasoned user override (same rule as xhigh/ultra)', () => {
    const r = gateLog(JSON.stringify({ ...base, effort: 'max', effort_source: 'routed' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('requires effort_source "user-override"');
    const ok = gateLog(JSON.stringify({ ...base, effort: 'max', effort_source: 'user-override', effort_reason: 'founder override' }));
    expect(ok.status).toBe(0);
  });

  test('a routed C/D Astra review needs no model_reason (the tier is the reason)', () => {
    const r = gateLog(
      JSON.stringify({ ...base, model: 'gpt-6-astra', model_requested: 'gpt-6-astra', model_source: 'policy', model_substituted: false, effort: 'medium', effort_source: 'routed', elapsed_s: 41 }),
    );
    expect(r.status).toBe(0);
  });

  test('a Lead-assigned Astra worker or reviewer is refused without model_reason and accepted with one', () => {
    const worker = { ...base, gate: 'worker:implement', model: 'gpt-6-astra', effort: 'medium', effort_source: 'lead-assigned' };
    const refused = gateLog(JSON.stringify(worker));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('requires a non-empty model_reason');
    expect(gateLog(JSON.stringify({ ...worker, model_reason: '   ' })).status).toBe(1);
    const accepted = gateLog(
      JSON.stringify({ ...worker, effort: 'high', model_reason: 'interacting lock + paint-plan contracts; Sol medium failed the state-transition proof twice' }),
    );
    expect(accepted.status).toBe(0);
  });

  test('the exemption is the routed codex-structured slot, not the effort_source label (red-team 2026-09-04)', () => {
    // A worker gate that merely says effort_source "routed" still owes its reason.
    const mislabelled = { ...base, gate: 'worker:implement', model: 'gpt-6-astra', effort: 'medium', effort_source: 'routed' };
    const refused = gateLog(JSON.stringify(mislabelled));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('requires a non-empty model_reason');
    expect(gateLog(JSON.stringify({ ...mislabelled, model_reason: 'interacting contracts' })).status).toBe(0);
    // And a codex-structured gate that is NOT routed (a Lead-commissioned review) owes it too.
    expect(gateLog(JSON.stringify({ ...base, model: 'gpt-6-astra', effort: 'medium', effort_source: 'lead-assigned' })).status).toBe(1);
  });

  test('a substituted record (Astra requested, default used) is an ordinary routed record', () => {
    const r = gateLog(
      JSON.stringify({ ...base, model: 'gpt-5.6-sol', model_requested: 'gpt-6-astra', model_source: 'fallback', model_substituted: true, effort: 'high', effort_source: 'routed' }),
    );
    expect(r.status).toBe(0);
  });
});

// ─── gstack-outcome-report: model detail from existing gate rows ────────────

describe('gstack-outcome-report model detail', () => {
  test('sums elapsed, tokens and substitutions per model@effort without a new telemetry stream', () => {
    const repo = mkdtempSync(join(tmpdir(), 'model-route-report-repo-')),
      state = mkdtempSync(join(tmpdir(), 'model-route-report-state-')),
      transcripts = mkdtempSync(join(tmpdir(), 'model-route-report-tr-'));
    dirs.push(repo, state, transcripts);
    spawnSync('git', ['init', '-b', 'main'], { cwd: repo, timeout: 30_000 });
    const project = join(state, 'projects', 'model-report');
    mkdirSync(join(project, 'outcomes'), { recursive: true });
    writeFileSync(
      join(project, 'outcomes', 'astra-1.json'),
      JSON.stringify({ outcome_id: 'astra-1', created_at: new Date().toISOString(), slices: [], sessions: [] }),
    );
    const row = (extra: any) => ({ outcome_id: 'astra-1', run_id: 'r1', gate: 'codex-structured', risk_tier: 'C', ...extra });
    writeFileSync(
      join(project, 'main-gates.jsonl'),
      [
        row({ model: 'gpt-6-astra', model_requested: 'gpt-6-astra', model_substituted: false, effort: 'medium', elapsed_s: 120, tokens: { total: 5000 }, fix_cycle: 0 }),
        row({ model: 'gpt-6-astra', model_requested: 'gpt-6-astra', model_substituted: false, effort: 'medium', elapsed_s: 80, fix_cycle: 1 }),
        row({ model: 'gpt-5.6-sol', model_requested: 'gpt-6-astra', model_substituted: true, effort: 'high', elapsed_s: 300, tokens: { total: 900 }, fix_cycle: 0 }),
      ]
        .map((x) => JSON.stringify(x))
        .join('\n') + '\n',
    );
    const r = spawnSync(REPORT, ['astra-1', '--json'], {
      cwd: repo,
      env: { ...process.env, GSTACK_STATE_DIR: state, GSTACK_PROJECT_SLUG: 'model-report', GSTACK_CLAUDE_PROJECTS_DIR: transcripts, GIT_CONFIG_GLOBAL: '/dev/null' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.runs_by_model_effort).toEqual({ 'gpt-6-astra@medium': 2, 'gpt-5.6-sol@high': 1 });
    expect(out.runs_detail_by_model_effort['gpt-6-astra@medium']).toEqual({
      runs: 2,
      elapsed_s: 200,
      tokens: 5000,
      substituted: 0,
      requested: { 'gpt-6-astra': 2 },
    });
    expect(out.runs_detail_by_model_effort['gpt-5.6-sol@high']).toEqual({
      runs: 1,
      elapsed_s: 300,
      tokens: 900,
      substituted: 1,
      requested: { 'gpt-6-astra': 1 },
    });
    expect(out.repair_cycles).toBe(2);
  });
});

// ─── Rendered prose: both codex calls carry the model, the gate row records it

describe('rendered routed step carries the model', () => {
  const SITES = ['ship/sections/adversarial.md', 'review/sections/adversarial.md', 'test/fixtures/golden/factory-ship-SKILL.md'];
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  for (const site of SITES) {
    test(`${site}: resolves the model once, pins it on both calls, records it, never re-runs on another model`, () => {
      const text = read(site);
      expect(text).toContain('gstack-codex-model resolve --model "{CODEX_MODEL}" --effort "{medium|high from REVIEWERS suffix}" --source "{CODEX_MODEL_SOURCE}"');
      const exec = text.split('\n').filter((l) => /_gstack_codex_timeout_wrapper 540 codex exec\b/.test(l));
      const review = text.split('\n').filter((l) => /_gstack_codex_timeout_wrapper 540 codex review --base\b/.test(l));
      expect(exec).toHaveLength(1);
      expect(review).toHaveLength(1);
      expect(exec[0]).toContain('codex exec {CODEX_MODEL_EXEC_FLAGS}');
      expect(exec[0]).toContain('model_reasoning_effort="{medium|high from REVIEWERS suffix}"');
      expect(review[0]).toContain('codex review --base <base> {CODEX_MODEL_REVIEW_FLAGS}');
      expect(review[0]).toContain('model_reasoning_effort="{medium|high from REVIEWERS suffix}"');
      expect(text).toContain('CODEX_ELAPSED_S=$(( $(date +%s) - _CODEX_T0 ))');
      const gateRow = text.split('\n').find((l) => l.includes('gstack-gate-log') && l.includes('"gate":"codex-structured"') && l.includes('"trigger":"review-plan"'));
      expect(gateRow).toBeDefined();
      expect(gateRow).toContain('"model":"{CODEX_MODEL}"');
      expect(gateRow).toContain('"model_requested":"{CODEX_MODEL_REQUESTED}"');
      expect(gateRow).toContain('"model_substituted":{true|false}');
      expect(gateRow).toContain('"model_substitution_reason":"{CODEX_MODEL_SUBSTITUTION_REASON}"');
      expect(gateRow).toContain('"effort":"{PLAN_EFFORT}","effort_source":"routed"');
      expect(gateRow).toContain('"elapsed_s":{CODEX_ELAPSED_S}');
      expect(text.replace(/\n/g, ' ')).toContain('never triggers an automatic second-model review');
      expect(text).not.toContain('model_reasoning_effort="xhigh"');
      expect(text).not.toContain('model_reasoning_effort="max"');
    });
  }
});
