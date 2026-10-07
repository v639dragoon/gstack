import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'child_process';
import { policyFlags, FLAG_NAMES, surfaceFlags, readPolicy, globs, DEFAULT_ENV_SURFACES, DEFAULT_TEST_GLOBS, auditReusable, gitRead, nonCodeReviewDelta } from '../lib/review-policy';

const argv = process.argv.slice(2);
const command = argv.shift() || '';
const projectDir = process.env.GSTACK_BUDGET_PROJECT_DIR!;
const repoRoot = process.env.GSTACK_BUDGET_REPO_ROOT!;
const budgetDir = path.join(projectDir, 'budgets');
const now = () => new Date().toISOString();
const opt = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const has = (n: string) => argv.includes(n);
const fail = (m: string, code = 1) => {
  console.error(`gstack-review-budget: ${m}`);
  process.exit(code);
};
const planPath = (id: string) => path.join(budgetDir, `${id}.json`);
const ledgerPath = (id: string) => path.join(budgetDir, `${id}.ledger.jsonl`);
const loadPlan = (id: string) => {
  try {
    return JSON.parse(fs.readFileSync(planPath(id), 'utf8'));
  } catch {
    fail('plan not found');
  }
};
const records = (id: string): any[] => {
  try {
    return fs
      .readFileSync(ledgerPath(id), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(text => JSON.parse(text));
  } catch {
    return [];
  }
};
const append = (id: string, r: any) => {
  fs.mkdirSync(budgetDir, { recursive: true });
  fs.appendFileSync(ledgerPath(id), JSON.stringify(r) + '\n');
};
const globToRe = (g: string) =>
  new RegExp(
    '^' +
      g
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '\u0001')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\u0001/g, '(.*/)?')
        .replace(/\u0000/g, '.*') +
      '$',
  );
const matchAny = (p: string, gs: string[]) => gs.some((g) => globToRe(g).test(p));
const blocking = ['CRITICAL', 'P1', 'P2', 'SECURITY', 'RELIABILITY', 'ACCEPTANCE'];
const blockingCategories = [
  'security',
  'reliability',
  'data-safety',
  'data-migration',
  'sql-data-safety',
  'llm-trust-boundary',
  'auth',
];
const tierRank: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
const requestedCycle = () => {
  const raw = opt('--cycle') ?? '0';
  if (!/^\d+$/.test(raw)) fail('cycle must be a non-negative integer');
  return Number(raw);
};
const cyclePlan = (plan: any, cycle: number) => {
  const selected = plan.cyclePlans?.[String(cycle)] ?? (plan.cycle === cycle ? plan : null);
  if (!selected) fail(`cycle ${cycle} not planned`);
  return selected;
};
const priorRunFinished = (ledger: any[], plan: any): boolean => {
  const lastRerunIndex = ledger.findLastIndex((r) => r.record_type === 'rerun-check');
  const lastRerun = ledger[lastRerunIndex];
  if (lastRerun) {
    const rerunPlan = plan.cyclePlans?.[String(lastRerun.cycle)] ?? plan;
    if ((lastRerun.effective_cycle ?? lastRerun.cycle) > rerunPlan.repairCyclesMax) return false;
  }
  const after = ledger.slice(lastRerunIndex + 1);
  const completion = after.filter((r) => r.record_type === 'complete').at(-1);
  if (!completion && lastRerun?.full_rerun !== false) return false;
  const cycle = completion ? completion.cycle : lastRerun.cycle;
  const blockingFindings = ledger.filter((r) =>
    r.record_type === 'finding' && r.blocking === true && r.cycle <= cycle,
  );
  const resolutionFor = (fingerprint: string) => ledger.filter((r) =>
    r.record_type === 'resolved' && r.fingerprint === fingerprint,
  ).at(-1);
  if (blockingFindings.some((f) =>
    f.cycle < cycle && !['fixed', 'skipped', 'accepted'].includes(resolutionFor(f.fingerprint)?.action),
  )) return false;
  const findings = blockingFindings.filter((f) => f.cycle === cycle);
  const criticalByGateCycle = new Map<string, number>();
  for (const verdict of ledger.filter((r) => r.record_type === 'verdict' && r.cycle <= cycle && !r.carry_forward)) {
    const key = JSON.stringify([verdict.cycle, verdict.gate]);
    criticalByGateCycle.set(key, (criticalByGateCycle.get(key) ?? 0) + (verdict.critical ?? 0));
  }
  for (const [key, critical] of criticalByGateCycle) {
    const [findingCycle, gate] = JSON.parse(key);
    const count = new Set(blockingFindings.filter((f) =>
      f.cycle === findingCycle && f.gate === gate,
    ).map((f) => f.fingerprint)).size;
    if (critical > count) return false;
  }
  const pending = new Map<string, any[]>();
  const verified = new Set<string>();
  for (const record of after) {
    const key = JSON.stringify([record.gate, record.cycle]);
    if (record.record_type === 'dispatch' && record.allowed) {
      const queue = pending.get(key) ?? [];
      queue.push(record);
      pending.set(key, queue);
    } else if (record.record_type === 'verdict') {
      const dispatch = pending.get(key)?.shift();
      if (dispatch?.verify_of && record.verdict === 'clean')
        verified.add(JSON.stringify([dispatch.gate, dispatch.cycle, dispatch.verify_of]));
    }
  }
  let cleanVerifications = 0;
  for (const finding of new Map(findings.map((f) => [f.fingerprint, f])).values()) {
    const resolution = resolutionFor(finding.fingerprint);
    if (resolution?.action === 'skipped' || resolution?.action === 'accepted') continue;
    if (resolution?.action !== 'fixed') return false;
    if (!verified.has(JSON.stringify([finding.gate, cycle, finding.fingerprint]))) return false;
    cleanVerifications++;
  }
  return !!completion || cleanVerifications > 0;
};

if (command === 'policy-flags') {
  const policy = readPolicy(repoRoot);
  const flags = policyFlags(policy);
  let qaSmoke = true;
  if (argv[0] && !argv[0].startsWith('--')) {
    try {
      let base: string;
      try { base = gitRead(repoRoot, ['merge-base', `origin/${argv[0]}`, 'HEAD']).trim(); }
      catch { base = gitRead(repoRoot, ['merge-base', argv[0], 'HEAD']).trim(); }
      const files = [...gitRead(repoRoot, ['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', base]).split('\0'),
        ...gitRead(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter(Boolean);
      qaSmoke = surfaceFlags(policy, files, 'D', {}).qaSmoke;
    } catch { /* Unknown scope keeps smoke required. */ }
  }
  if (has('--json')) console.log(JSON.stringify({ ...flags, qaSmoke }));
  else {
    for (const [key, value] of Object.entries(flags)) console.log(`${FLAG_NAMES[key]}=${value}`);
    console.log(`QA_SMOKE=${qaSmoke}`);
  }
  process.exit(0);
}
const currentWtree = () => {
  const result = spawnSync(path.join(import.meta.dir, 'gstack-wtree'), [], {
    cwd: repoRoot, encoding: 'utf8', timeout: 30_000,
  });
  return result.status === 0 && !result.error ? result.stdout.trim() : null;
};

if (command === 'plan') {
  const manifestFile = argv[0];
  if (!manifestFile) fail('manifest path required');
  let m: any;
  try {
    m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch {
    fail('invalid manifest');
  }
  const manifestTier = m.routing?.risk_tier;
  if (!/^[ABCD]$/.test(manifestTier)) fail('manifest missing routing tier');
  const cycle = requestedCycle();
  const resetRequested = cycle === 0 && has('--reset-repair-budget');
  const resetReason = opt('--reset-repair-budget');
  if (resetRequested && !resetReason?.trim()) fail('reset-repair-budget requires a reason');
  let previous: any = null;
  try {
    previous = JSON.parse(fs.readFileSync(planPath(m.run_id), 'utf8'));
  } catch {}
  const oldCycleZero = previous?.cyclePlans?.['0'] ?? (previous?.cycle === 0 ? previous : null);
  const branchResult = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const branch = branchResult.status === 0 && !branchResult.error
    ? branchResult.stdout.trim()
    : null;
  const currentBranch = branch && branch !== 'HEAD' ? branch : null;
  let carriedCycles = oldCycleZero?.carriedCycles ?? 0;
  let carriedFrom = carriedCycles > 0 ? oldCycleZero?.carriedFrom ?? null : null;
  let repairBudgetReset = oldCycleZero?.repairBudgetReset;
  if (cycle === 0 && (!oldCycleZero || resetRequested)) {
    let prior: any = null;
    if (currentBranch && fs.existsSync(budgetDir)) {
      const candidates = fs.readdirSync(budgetDir)
        .filter((f) => f.endsWith('.json') && f !== `${m.run_id}.json`)
        .map((f) => {
          try {
            return JSON.parse(fs.readFileSync(path.join(budgetDir, f), 'utf8'));
          } catch {
            return null;
          }
        })
        .filter((c: any) => {
          const zero = c?.cyclePlans?.['0'] ?? (c?.cycle === 0 ? c : null);
          return zero?.branch === currentBranch && zero?.base === (m.base ?? null);
        })
        .sort((a: any, b: any) => {
          const aZero = a.cyclePlans?.['0'] ?? a;
          const bZero = b.cyclePlans?.['0'] ?? b;
          return String(bZero.createdAt).localeCompare(String(aZero.createdAt));
        });
      prior = candidates[0] ?? null;
    }
    let wouldCarry = 0;
    if (prior) {
      const old = records(prior.runId);
      if (!priorRunFinished(old, prior)) {
        const zero = prior.cyclePlans?.['0'] ?? prior;
        const fixCycles = new Set(old.filter((r) => r.record_type === 'rerun-check').map((r) => r.cycle)).size;
        wouldCarry = (zero.carriedCycles ?? 0) + fixCycles;
      }
    }
    carriedCycles = resetRequested ? 0 : wouldCarry;
    carriedFrom = carriedCycles > 0 ? prior.runId : null;
    if (resetRequested)
      repairBudgetReset = { reason: resetReason, from: wouldCarry > 0 ? prior.runId : null, ts: now() };
  }
  const cycleZeroTier =
    previous?.cyclePlans?.['0']?.effectiveTier ??
    (previous?.cycle === 0 ? previous.effectiveTier : null);
  if (cycle > 0 && !cycleZeroTier) fail('cycle 0 must be planned first');
  let tier = manifestTier;
  if (cycleZeroTier && tierRank[tier] < tierRank[cycleZeroTier]) tier = cycleZeroTier;
  const defaults: any = { A: 1, B: 1, C: 2, D: 3 };
  let reviewerBudget = defaults[tier];
  let cycles = ['A', 'B'].includes(tier) ? 1 : 2;
  let escalationKinds = ['specialist-critical', 'p1-gate-fail', 'scope-expansion', 'user-request'];
  let ignored: string[] = [];
  let policyRaw: any = null;
  if (m.policy?.path)
    try {
      policyRaw = JSON.parse(fs.readFileSync(path.resolve(repoRoot, m.policy.path), 'utf8'));
    } catch {}
  const routing = policyRaw?.routing;
  if (routing && typeof routing === 'object') {
    ignored = Object.keys(routing).filter(
      (k) => !['budgets', 'repair_cycles', 'escalation_kinds', 'models', 'passes'].includes(k),
    );
    const proposed = routing.budgets?.[tier];
    if (tier !== 'D' && Number.isInteger(proposed) && proposed >= 1)
      reviewerBudget = Math.min(reviewerBudget, proposed);
    const cycleKey = ['A', 'B'].includes(tier) ? 'AB' : 'CD';
    const proposedCycles = routing.repair_cycles?.[cycleKey];
    if (Number.isInteger(proposedCycles) && proposedCycles >= 0)
      cycles = Math.min(cycles, proposedCycles);
    if (Array.isArray(routing.escalation_kinds))
      escalationKinds = [
        ...new Set([
          ...escalationKinds,
          ...routing.escalation_kinds.filter((x: any) => typeof x === 'string' && x),
        ]),
      ];
  }
  let reviewerSpecs: string[];
  if (tier === 'A' || tier === 'B') reviewerSpecs = ['codex-structured@medium'];
  else if (tier === 'C') {
    const pick = m.scope?.migrations
      ? 'data-migration'
      : m.routing.auth_surface_matches?.length
        ? 'security'
        : m.scope?.api
          ? 'api-contract'
          : 'testing';
    reviewerSpecs = ['codex-structured@medium', `specialist:${pick}@sonnet`];
  } else
    reviewerSpecs = [
      'codex-structured@high',
      'specialist:security@sonnet',
      m.scope?.migrations ? 'specialist:data-migration@sonnet' : 'red-team@sonnet',
    ];
  if (opt('--host') === 'codex') { reviewerSpecs = []; reviewerBudget = 0; }
  const out = m.routing.outcome || {};
  const final = out.is_final_slice || out.is_flag_flip || !out.present;
  const deterministicGates =
    'tests,typecheck,build,gitleaks,redaction,verification,claim-check' +
    (tier === 'D' ? ',migration-runbook' : '');
  const reviewers: any[] = reviewerSpecs.map((s, i) => {
    const at = s.lastIndexOf('@');
    return { gate: s.slice(0, at), model_or_effort: s.slice(at + 1), slot: i + 1 };
  });
  // Model substitution (policy `routing.models`, dohma ruling 2026-09-04).
  // A Codex slot ALREADY on the plan may run on a named model
  // (`--model <slug>`) instead of the client default. It is budget-neutral by
  // construction: it never adds a slot, never touches the reviewer budget or
  // the repair cycles, and never changes the effort the tier routes (a policy
  // effort that differs from the routed one is ignored and recorded, so
  // xhigh/max/ultra cannot arrive through this key). Only the Codex gate takes
  // a model: specialists are Sonnet subagents pinned elsewhere. Whether the
  // named model can actually run is decided at dispatch time by
  // gstack-codex-model, which falls back to the default route and logs the
  // substitution; nothing here consults the network.
  const modelIgnored: string[] = [];
  const modelsRaw = routing && typeof routing === 'object' ? routing.models : null;
  if (modelsRaw && typeof modelsRaw === 'object' && !Array.isArray(modelsRaw)) {
    for (const [gate, byTier] of Object.entries<any>(modelsRaw)) {
      const slot = reviewers.find((r) => r.gate === gate);
      // `outside-voice` is consumed by gstack-codex-model resolve --voice at
      // each voice's own dispatch; it is not a review slot and not an error.
      if (gate === 'outside-voice') continue;
      if (gate !== 'codex-structured') {
        modelIgnored.push(`${gate}:not-codex`);
        continue;
      }
      if (!slot) {
        modelIgnored.push(`${gate}:off-plan`);
        continue;
      }
      const entry = byTier && typeof byTier === 'object' ? byTier[tier] : undefined;
      if (entry === undefined || entry === null) continue;
      const model = typeof entry === 'string' ? entry : entry?.model;
      const effort = typeof entry === 'string' ? undefined : entry?.effort;
      if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(model)) {
        modelIgnored.push(`${gate}:${tier}:bad-model`);
        continue;
      }
      if (effort !== undefined && effort !== slot.model_or_effort)
        modelIgnored.push(`${gate}:${tier}:effort-${String(effort)}-ignored`);
      slot.model = model;
      slot.model_source = 'policy';
    }
  }
  const codexSlot = reviewers.find((r) => r.gate === 'codex-structured');
  const codexModel: string | null = codexSlot?.model ?? null;
  const codexModelSource = codexModel ? 'policy' : 'default';
  const codexEffort: string | null = codexSlot?.model_or_effort ?? null;
  const flags = policyFlags(policyRaw);
  const surfaces = surfaceFlags(policyRaw, (m.files || []).map((f: any) => f.path), tier, m.scope);
  const docRelease = !flags.docReleaseByImpact || ['C', 'D'].includes(tier) || m.routing.doc_impact_would_dispatch === true;
  const docVoice = flags.codexDocVoice && docRelease;
  // Whole-workflow accounting (dohma harness pass 2026-09-15): every AI pass
  // this run may dispatch is declared ONCE here with its purpose, model,
  // effort, budget and retry policy. The reviewer slots are the same objects
  // as `reviewers`; the audits and the doc passes join them so nothing runs
  // untracked. `planned:false` entries are on the plan as "not this slice".
  const passes: any[] = [
    ...reviewers.map((r) => ({
      gate: r.gate,
      purpose: r.gate === 'codex-structured' ? 'semantic code review' : r.gate === 'red-team' ? 'adversarial red team' : `${r.gate.slice('specialist:'.length)} specialist review`,
      model: r.gate === 'codex-structured' ? (r.model ?? 'project-default') : 'sonnet',
      effort: r.gate === 'codex-structured' ? r.model_or_effort : 'agent-default',
      budget: 1,
      retry: 'once-on-error-or-timeout',
      planned: true,
    })),
    { gate: 'coverage-audit', purpose: 'test coverage audit', model: 'sonnet', effort: 'agent-default', budget: 1, retry: 'inline-fallback', planned: final },
    { gate: 'plan-completion', purpose: 'plan completion audit', model: 'sonnet', effort: 'agent-default', budget: 1, retry: 'inline-fallback', planned: final },
    { gate: 'doc-release', purpose: 'documentation audit', model: 'sonnet', effort: 'agent-default', budget: 1, retry: 'one-repair-or-re-audit', planned: docRelease },
    { gate: 'outside-voice:doc-release', purpose: 'documentation review voice', model: 'routed:outside-voice', effort: 'medium', budget: 1, retry: 'none', planned: docVoice },
  ];
  const plan: any = {
    runId: m.run_id,
    cycle,
    branch: currentBranch,
    carriedCycles,
    carriedFrom,
    ...(repairBudgetReset ? { repairBudgetReset } : {}),
    head_sha:
      spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim() ||
      null,
    manifestTier,
    tier,
    effectiveTier: tier,
    tierSource: m.routing.tier_source,
    sliceKind: final ? 'final' : 'intermediate',
    outcomeMissing: !out.present,
    outcome_id: out.outcome_id ?? null,
    outcome: out,
    reviewerBudget,
    reviewerSpecs,
    reviewers,
    ...flags,
    ...surfaces,
    coverageAudit: final,
    planCompletion: final,
    docRelease,
    codexDocVoice: docVoice,
    passes,
    wtree: m.wtree ?? null,
    base: m.base ?? null,
    merge_base: m.merge_base ?? null,
    policy_sha256: m.policy?.sha256 ?? null,
    repairCyclesMax: cycles,
    autofixInformational: flags.autofixInformational,
    maxAdvisories: 5,
    blockingSeverities: blocking,
    blockingCategories,
    deterministicGates,
    subagentModel: 'sonnet',
    forbiddenSubagentModels: ['fable', 'opus'],
    escalationKinds,
    codexModel,
    codexModelSource,
    codexEffort,
    policyModelIgnored: modelIgnored,
    manifestPath: path.resolve(manifestFile),
    files: m.files || [],
    scope: m.scope || {},
    authSurfaces: policyRaw?.auth_surfaces || [],
    dSurfaces: globs(policyRaw?.d_surfaces),
    dSurfaceExceptions: globs(policyRaw?.d_surface_exceptions),
    envSurfaces: globs(policyRaw?.env_surfaces, DEFAULT_ENV_SURFACES),
    testGlobs: globs(policyRaw?.test_globs, DEFAULT_TEST_GLOBS),
    policy: policyRaw || {},
    createdAt: now(),
    policyRoutingIgnored: ignored,
  };
  fs.mkdirSync(budgetDir, { recursive: true });
  const stored = {
    ...plan,
    cyclePlans: { ...(previous?.cyclePlans ?? {}), [String(cycle)]: plan },
  };
  fs.writeFileSync(planPath(m.run_id), JSON.stringify(stored, null, 2) + '\n');
  if (has('--json')) console.log(JSON.stringify(stored));
  else {
    const kv: [string, any][] = [
      ['RUN_ID', plan.runId],
      ['CYCLE', cycle],
      ['HEAD_SHA', plan.head_sha ?? ''],
      ['TIER', manifestTier],
      ['EFFECTIVE_TIER', tier],
      ['TIER_SOURCE', plan.tierSource],
      ['SLICE_KIND', plan.sliceKind],
      ['OUTCOME_MISSING', plan.outcomeMissing],
      ['REVIEWER_BUDGET', reviewerBudget],
      ['REVIEWERS', reviewerSpecs.join(',')],
      ...Object.entries(FLAG_NAMES).map(([key, name]) => [name, plan[key]] as [string, any]),
      ['QA_SMOKE', plan.qaSmoke],
      ['FULL_LANES_REQUIRED', plan.fullLanesRequired],
      ['BUILD_GATE', plan.buildGate],
      ['CI_BACKSTOP', plan.ciBackstop],
      ['COVERAGE_AUDIT', plan.coverageAudit],
      ['PLAN_COMPLETION', plan.planCompletion],
      ['DOC_RELEASE', plan.docRelease],
      ['CODEX_DOC_VOICE', plan.codexDocVoice],
      ['PASSES', passes.filter((x) => x.planned).map((x) => `${x.gate}@${x.model}:${x.effort}`).join(',')],
      ['REPAIR_CYCLES_MAX', cycles],
      ['CARRIED_REPAIR_CYCLES', carriedCycles],
      ['CARRIED_FROM', carriedFrom ?? ''],
      ...(resetRequested ? [['REPAIR_BUDGET_RESET', resetReason]] as [string, any][] : []),
      ['MAX_ADVISORIES', 5],
      ['BLOCKING_SEVERITIES', blocking.join(',')],
      ['BLOCKING_CATEGORIES', blockingCategories.join(',')],
      ['DETERMINISTIC_GATES', deterministicGates],
      ['SUBAGENT_MODEL', 'sonnet'],
      ['FORBIDDEN_SUBAGENT_MODELS', 'fable,opus'],
      ['POLICY_ROUTING_IGNORED', ignored.join(',')],
      ['CODEX_MODEL', codexModel ?? ''],
      ['CODEX_MODEL_SOURCE', codexModelSource],
      ['CODEX_EFFORT', codexEffort ?? ''],
      ['POLICY_MODEL_IGNORED', modelIgnored.join(',')],
    ];
    for (const [k, v] of kv) console.log(`${k}=${v}`);
    if (!plan.docRelease) console.log('Documentation: skipped (tier A/B, no doc-impact)');
  }
  process.exit(0);
}

// D4: upstream-required attempts are accounted in their own bounded slots.
// They neither consume nor substitute for the unchanged routed reviewer budget.
const upstreamGates = (id: string, cycle: number): string[] => [...new Set(records(id)
  .filter(r => r.record_type === 'upstream-reviewer' && r.cycle === cycle)
  .map(r => r.gate))];
function gateDisabled(p: any, gate: string): boolean {
  return gate === 'native-adversarial' && p.adversarialClaude === false ||
    gate === 'upstream-outside:challenge' && p.codexChallenge === false ||
    gate === 'upstream-outside:structured' && p.upstreamStructured === false ||
    gate.startsWith('upstream-specialist:') && p.upstreamSpecialists === false ||
    gate === 'outside-voice:doc-release' && p.codexDocVoice === false;
}
if (command === 'register-upstream') {
  const [id, gate] = argv;
  if (!id || !gate || !/^(native-adversarial|upstream-outside:(challenge|structured)|upstream-specialist:(testing|maintainability|security|performance|data-migration|api-contract|design|simplification|red-team))$/.test(gate))
    fail('known upstream-required reviewer gate required');
  const cycle = requestedCycle(), p = cyclePlan(loadPlan(id), cycle);
  if (gateDisabled(p, gate) || gate === 'upstream-specialist:red-team' && opt('--trigger') === 'loc' && p.redTeamLocTrigger === false) {
    console.log('REGISTER=blocked reason=policy-disabled');
    process.exit(2);
  }
  if (!upstreamGates(id, cycle).includes(gate)) append(id, {
    record_type: 'upstream-reviewer', run_id: id, cycle, gate,
    required: !has('--optional'),
    model: opt('--model') ?? 'sonnet', effort: opt('--effort') ?? 'agent-default',
    budget: 1, retry: 'once-on-error-or-timeout',
    wtree: p.wtree, reviewed_sha: p.head_sha, ts: now(),
  });
  console.log(`UPSTREAM_REVIEWER=${gate}`);
  process.exit(0);
}

if (command === 'dispatch') {
  const id = argv[0],
    gate = argv[1];
  if (!id || !gate) fail('run id and gate required');
  const rootPlan = loadPlan(id);
  const cycle = requestedCycle();
  const p = cyclePlan(rootPlan, cycle);
  const old = records(id);
  if (gateDisabled(p, gate)) {
    console.log('DISPATCH=blocked reason=policy-disabled');
    process.exit(2);
  }
  const upstream = upstreamGates(id, cycle).includes(gate);
  const semantic = upstream ||
    ['codex-structured', 'red-team', 'adversarial-claude', 'codex-challenge'].includes(gate) ||
    gate.startsWith('specialist:');
  const planned = upstream || p.reviewers.some((r: any) => r.gate === gate);
  const verifyOf = opt('--verify-of');
  const escRaw = opt('--escalation');
  const inCycle = (r: any) => Number(r.cycle ?? 0) === cycle;
  const priorAllowedSemantic = old.filter(
    (r) =>
      r.record_type === 'dispatch' &&
      r.allowed &&
      r.semantic &&
      !upstreamGates(id, cycle).includes(r.gate) &&
      !r.verify_of &&
      !r.retry &&
      !r.carry_forward &&
      inCycle(r),
  ).length;
  const gateDispatches = old.filter(
    (r) =>
      r.record_type === 'dispatch' && r.allowed && !r.verify_of && r.gate === gate && inCycle(r),
  );
  const gateVerdicts = old.filter(
    (r) => r.record_type === 'verdict' && r.gate === gate && inCycle(r),
  );
  let allowed = false,
    reason = 'off-plan',
    escalation: any = undefined,
    retry = false;
  if (verifyOf) {
    const knownFinding = old.some(
      (r) => r.record_type === 'finding' && r.fingerprint === verifyOf && r.gate === gate,
    );
    const gateWasDispatched = old.some(
      (r) => r.record_type === 'dispatch' && r.allowed && !r.verify_of && r.gate === gate,
    );
    const alreadyVerified = old.some(
      (r) =>
        r.record_type === 'dispatch' &&
        r.allowed &&
        r.verify_of === verifyOf &&
        r.gate === gate &&
        inCycle(r),
    );
    allowed = semantic && planned && knownFinding && gateWasDispatched && !alreadyVerified;
    reason = allowed ? 're-verification' : 'unknown-finding';
  } else if (semantic && planned) {
    const lastVerdict = gateVerdicts.at(-1)?.verdict;
    if (gateDispatches.length === 0 && (upstream || priorAllowedSemantic < p.reviewerBudget)) {
      allowed = true;
      reason = 'on-plan';
    } else if (
      gateDispatches.length === 1 &&
      ['error', 'timeout'].includes(lastVerdict) &&
      !gateDispatches.some((r) => r.retry)
    ) {
      allowed = true;
      retry = true;
      reason = 'retry';
    } else if (gateDispatches.length > 0) {
      reason = 'duplicate-slot';
    } else {
      reason = 'budget-exceeded';
    }
  } else if (['coverage-audit', 'plan-completion', 'doc-release'].includes(gate)) {
    const flag: any = {
      'coverage-audit': p.coverageAudit,
      'plan-completion': p.planCompletion,
      'doc-release': p.docRelease,
    };
    // Within one invocation only. Copy the accepted inputs/results into this
    // cycle before returning a satisfied blocked line; never reuse failed work.
    if (flag[gate] && p.auditReuse) {
      const current = currentWtree();
      const prior = old.filter(r => r.record_type === 'verdict' && r.gate === gate &&
        Number(r.cycle ?? 0) <= cycle).at(-1);
      const dispatch = prior && old.filter(r => r.record_type === 'dispatch' && r.allowed &&
        r.gate === gate && Number(r.cycle ?? 0) === Number(prior.cycle ?? 0)).at(-1);
      if (current && prior && dispatch && ['clean', 'issues_found'].includes(prior.verdict) &&
        prior.policy_sha256 === p.policy_sha256 && prior.base === p.base &&
        (dispatch.inputs_hash ?? null) === opt('--inputs-hash') &&
        auditReusable(repoRoot, gate, prior.verdict, prior.wtree, current, p.policy)) {
        const reuse = { run_id: id, cycle, reused_from: `${id}:${prior.cycle}`, reused_ts: now(),
          wtree: current, reviewed_sha: p.head_sha, prior_wtree: prior.wtree };
        // Already copied/accepted in this cycle: preserve its original record.
        if (Number(prior.cycle ?? 0) !== cycle || prior.wtree !== current) {
          append(id, { ...dispatch, ...reuse, reason: 'reused' });
          append(id, { ...prior, ...reuse });
        }
        console.log('DISPATCH=blocked reason=reused');
        process.exit(2);
      }
    }
    allowed = !!flag[gate];
    reason = allowed
      ? 'on-plan'
      : p.sliceKind === 'intermediate'
        ? 'intermediate-slice'
        : 'off-plan';
  }
  if (!allowed && escRaw) {
    const colon = escRaw.indexOf(':');
    const kind = colon < 0 ? escRaw : escRaw.slice(0, colon);
    const why = colon < 0 ? '' : escRaw.slice(colon + 1);
    const escalationUsed = old.some(
      (r) => r.record_type === 'dispatch' && r.allowed && r.escalation,
    );
    if (escalationUsed) {
      reason = 'escalation-cap';
    } else if (
      p.escalationKinds.includes(kind) &&
      why.trim() &&
      !['duplicate-slot', 'unknown-finding'].includes(reason)
    ) {
      if (semantic && priorAllowedSemantic >= p.reviewerBudget + 1) reason = 'hard-cap';
      else {
        allowed = true;
        escalation = { kind, reason: why };
        reason = 'escalation';
      }
    }
  }
  append(id, {
    record_type: 'dispatch',
    run_id: id,
    wtree: p.wtree ?? null,
    reviewed_sha: p.head_sha ?? null,
    gate,
    allowed,
    reason,
    escalation,
    semantic,
    inputs_hash: opt('--inputs-hash'),
    policy_sha256: p.policy_sha256,
    base: p.base,
    verify_of: verifyOf || undefined,
    retry: retry || undefined,
    cycle,
    ts: now(),
  });
  if (allowed) console.log(`DISPATCH=allowed${escalation ? ` escalation=${escalation.kind}` : ''}`);
  else {
    console.log(`DISPATCH=blocked reason=${reason}`);
    process.exit(2);
  }
  process.exit(0);
}

if (command === 'verdict') {
  const id = argv[0],
    gate = argv[1],
    verdict = argv[2];
  if (!id || !gate || !['clean', 'issues_found', 'error', 'timeout'].includes(verdict || ''))
    fail('run id, gate, and valid verdict required');
  const cycle = requestedCycle();
  const p = cyclePlan(loadPlan(id), cycle);
  if (!p.reviewers.some((r: any) => r.gate === gate) && !upstreamGates(id, cycle).includes(gate) && !auditPlanned(p, gate)) {
    console.log('VERDICT=blocked reason=off-plan');
    process.exit(2);
  }
  const current = records(id);
  const dispatchCount = current.filter(
    (r) =>
      r.record_type === 'dispatch' &&
      r.allowed &&
      r.gate === gate &&
      Number(r.cycle ?? 0) === cycle,
  ).length;
  const verdictCount = current.filter(
    (r) => r.record_type === 'verdict' && r.gate === gate && Number(r.cycle ?? 0) === cycle,
  ).length;
  if (dispatchCount === 0) {
    console.log('VERDICT=blocked reason=not-dispatched');
    process.exit(2);
  }
  if (verdictCount >= dispatchCount) {
    console.log('VERDICT=blocked reason=no-pending-dispatch');
    process.exit(2);
  }
  const count = (name: string) => {
    const raw = opt(name) ?? '0';
    if (!/^\d+$/.test(raw)) fail(`${name} must be a non-negative integer`);
    return Number(raw);
  };
  append(id, {
    record_type: 'verdict',
    run_id: id,
    cycle,
    gate,
    verdict,
    // Bind the result to its actual dispatch, never a subsequently refreshed plan.
    wtree: p.auditReuse && auditPlanned(p, gate) ? currentWtree() : current.filter(r => r.record_type === 'dispatch' && r.allowed && r.gate === gate && Number(r.cycle ?? 0) === cycle).at(-1)?.wtree ?? null,
    reviewed_sha: current.filter(r => r.record_type === 'dispatch' && r.allowed && r.gate === gate && Number(r.cycle ?? 0) === cycle).at(-1)?.reviewed_sha ?? null,
    policy_sha256: p.policy_sha256,
    base: p.base,
    critical: count('--critical'),
    informational: count('--informational'),
    ts: now(),
  });
  console.log(`VERDICT=recorded gate=${gate} result=${verdict}`);
  process.exit(0);
}

/** The three ship audits are on the plan when their slice flag is true. */
function auditPlanned(p: any, gate: string): boolean {
  const flag: any = {
    'coverage-audit': p.coverageAudit,
    'plan-completion': p.planCompletion,
    'doc-release': p.docRelease,
  };
  return !!flag[gate];
}

if (command === 'complete') {
  const id = argv[0];
  if (!id) fail('run id required');
  const cycle = requestedCycle();
  const p = cyclePlan(loadPlan(id), cycle);
  if (p.nonCodeDelta && currentWtree() !== p.wtree) {
    console.log('INCOMPLETE=working-tree-changed');
    process.exit(2);
  }
  const rs = records(id).filter(
    (r) => r.record_type === 'verdict' && Number(r.cycle ?? 0) === cycle,
  );
  // --require-audits: the ship path also owes a terminal verdict for every
  // planned pre-review audit (coverage, plan completion); --final adds the
  // doc-release pass. A dispatched-but-unfinished audit is incomplete on
  // every path. /review dispatches none, so it passes neither flag.
  const requireAudits = has('--require-audits') || has('--final');
  const audits = ['coverage-audit', 'plan-completion', ...(has('--final') ? ['doc-release'] : [])];
  const dispatched = new Set(
    records(id)
      .filter((r) => r.record_type === 'dispatch' && r.allowed && Number(r.cycle ?? 0) === cycle)
      .map((r) => r.gate),
  );
  const owed = [...new Set([
    ...p.reviewers.map((r: any) => r.gate),
    ...records(id).filter(r => r.record_type === 'upstream-reviewer' && r.cycle === cycle && r.required !== false).map(r => r.gate),
    ...(has('--require-native') && p.adversarialClaude !== false ? ['native-adversarial'] : []),
    ...audits.filter((g) => (requireAudits && auditPlanned(p, g)) || dispatched.has(g)),
  ])];
  const incomplete = owed
    .filter((gate: string) => {
      const result = rs.filter((r) => r.gate === gate).at(-1);
      const semantic = upstreamGates(id, cycle).includes(gate) || p.reviewers.some((r: any) => r.gate === gate);
      return !['clean', 'issues_found'].includes(result?.verdict) ||
        (semantic && p.wtree && (result?.wtree !== p.wtree || result?.reviewed_sha !== p.head_sha));
    });
  if (incomplete.length) {
    console.log(`INCOMPLETE=${incomplete.join(',')}`);
    process.exit(2);
  }
  console.log('COMPLETE=true');
  append(id, { record_type: 'complete', run_id: id, cycle, ts: now() });
  process.exit(0);
}

/**
 * resume <run_id> [--json]: reuse terminal verdicts from a PRIOR run of the
 * SAME inputs. A prior cycle-0 plan qualifies only when its content
 * fingerprint (wtree), base, merge-base, policy sha256, tier, reviewer
 * specs and slice kind all equal this plan's; a matching commit with a
 * differing working tree never qualifies because wtree is the fingerprint.
 * For each planned gate whose prior verdict is terminal and successful
 * (clean or issues_found) the dispatch, verdict and finding records are
 * copied into this run's ledger marked reused_from, so `dispatch` refuses a
 * second run (duplicate-slot) and `complete` counts it. error/timeout and
 * missing verdicts are never reused. Prints REUSED=... and RERUN=...
 */
if (command === 'resume') {
  const id = argv[0];
  if (!id) fail('run id required');
  const rootPlan = loadPlan(id);
  const p = cyclePlan(rootPlan, 0);
  const key = (x: any) =>
    JSON.stringify([x.wtree, x.head_sha, x.base, x.merge_base, x.policy_sha256, x.effectiveTier, x.reviewerSpecs, x.sliceKind, x.coverageAudit, x.planCompletion, x.docRelease, x.adversarialClaude, x.codexChallenge, x.upstreamSpecialists, x.upstreamStructured, x.codexDocVoice]);
  const reusable = ['clean', 'issues_found'];
  let source: any = null;
  if (p.wtree && fs.existsSync(budgetDir)) {
    const candidates = fs
      .readdirSync(budgetDir)
      .filter((f) => f.endsWith('.json') && f !== `${id}.json`)
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(budgetDir, f), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter((c: any) => c && c.runId !== id && key(cyclePlan(c, 0)) === key(p))
      .sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt)));
    source = candidates[0] ?? null;
  }
  const gates = [
    ...p.reviewers.map((r: any) => r.gate),
    ...['coverage-audit', 'plan-completion'].filter((g) => auditPlanned(p, g)),
    // Documentation audits can only be reused within this ship invocation (D1).
  ];
  const already = new Set(records(id).filter((r) => r.record_type === 'verdict').map((r) => r.gate));
  const reused: string[] = [];
  if (source) {
    const old = records(source.runId).filter((r) => Number(r.cycle ?? 0) === 0);
    for (const gate of gates) {
      if (already.has(gate)) continue;
      const verdict = old.filter((r) => r.record_type === 'verdict' && r.gate === gate).at(-1);
      const dispatch = old.find((r) => r.record_type === 'dispatch' && r.allowed && r.gate === gate && !r.verify_of);
      if (!verdict || !dispatch || !reusable.includes(verdict.verdict)) continue;
      if (p.reviewers.some((r: any) => r.gate === gate) &&
          (verdict.wtree !== p.wtree || dispatch.wtree !== p.wtree ||
           verdict.reviewed_sha !== p.head_sha || dispatch.reviewed_sha !== p.head_sha)) continue;
      const copy = (r: any) => append(id, { ...r, run_id: id, reused_from: source.runId, reused_ts: now() });
      copy(dispatch);
      for (const f of old.filter((r) => r.record_type === 'finding' && r.gate === gate)) copy(f);
      copy(verdict);
      reused.push(gate);
    }
  }
  const rerun = gates.filter((g) => !reused.includes(g) && !already.has(g));
  if (has('--json')) console.log(JSON.stringify({ runId: id, source: source?.runId ?? null, reused, rerun }));
  else {
    console.log(`RESUME_SOURCE=${source?.runId ?? ''}`);
    console.log(`REUSED=${reused.join(',')}`);
    console.log(`RERUN=${rerun.join(',')}`);
  }
  process.exit(0);
}

if (command === 'carry-forward') {
  const id = argv[0];
  if (!id) fail('run id required');
  const root = loadPlan(id), cycle = requestedCycle(), p = cyclePlan(root, cycle);
  const block = (reason: string) => { console.log(`CARRY_FORWARD=blocked reason=${reason}`); process.exit(2); };
  if (p.nonCodeDelta !== true) block('policy-disabled');
  if (cycle + (root.cyclePlans?.['0'] ?? root).carriedCycles > p.repairCyclesMax) block('repair-cycles-exhausted');
  if (JSON.stringify(readPolicy(repoRoot)) !== JSON.stringify(p.policy)) block('policy-changed');
  const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', timeout: 10_000 });
  if (branch.status !== 0 || branch.error || branch.stdout.trim() !== p.branch) block('branch-changed');
  const current = currentWtree();
  const delta = nonCodeReviewDelta(repoRoot, p.wtree, current!, p.policy);
  if (!delta.allowed) block(delta.error || delta.triggers.join(',') || delta.reason);
  const old = records(id), inCycle = (r: any) => Number(r.cycle ?? 0) === cycle;
  const registrations = old.filter(r => r.record_type === 'upstream-reviewer' && inCycle(r) && !gateDisabled(p, r.gate));
  const required = new Set([...p.reviewers.map((r: any) => r.gate),
    ...registrations.filter(r => r.required !== false).map(r => r.gate)]);
  // The absent native switch retains the full native requirement.
  if (p.adversarialClaude !== false) required.add('native-adversarial');
  const candidates = [...new Set([...required, ...registrations.map(r => r.gate)])];
  const copies: { dispatch: any; verdict: any }[] = [];
  for (const gate of candidates) {
    const ds = old.filter(r => r.record_type === 'dispatch' && r.allowed && r.gate === gate && inCycle(r));
    const vs = old.filter(r => r.record_type === 'verdict' && r.gate === gate && inCycle(r));
    const dispatch = ds.at(-1), verdict = vs.at(-1);
    const valid = dispatch && verdict && ds.length === vs.length &&
      ['clean', 'issues_found'].includes(verdict.verdict) &&
      [dispatch, verdict].every(r => r.wtree === p.wtree && r.reviewed_sha === p.head_sha);
    if (!valid) { if (required.has(gate)) block(`incomplete:${gate}`); continue; }
    if (verdict.critical > new Set(old.filter(r => r.record_type === 'finding' && r.blocking && r.gate === gate && inCycle(r)).map(r => r.fingerprint)).size)
      block(`untracked-critical:${gate}`);
    copies.push({ dispatch, verdict });
  }
  for (const f of old.filter(r => r.record_type === 'finding' && r.blocking)) {
    const resolution = old.filter(r => r.record_type === 'resolved' && r.fingerprint === f.fingerprint).at(-1);
    if (!['fixed', 'accepted', 'skipped'].includes(resolution?.action)) block(`unresolved:${f.fingerprint}`);
  }
  const sha = gitRead(repoRoot, ['rev-parse', 'HEAD']).trim();
  const audit = { record_type: 'carry-forward', audit_id: randomUUID(), run_id: id, cycle,
    old_wtree: p.wtree, new_wtree: current, old_sha: p.head_sha, new_sha: sha,
    files: delta.files, reason: delta.reason, branch: p.branch,
    branch_id: createHash('sha256').update(p.branch).digest('hex'),
    policy_sha256: p.policy_sha256, base: p.base, local_lanes_only: true, ts: now() };
  append(id, audit);
  for (const { dispatch, verdict } of copies) {
    const reuse = { run_id: id, cycle, wtree: current, reviewed_sha: sha,
      reused_from: `${id}:${cycle}`, reused_ts: now(), carry_forward: audit };
    append(id, { ...dispatch, ...reuse, reason: 'non-code-carry' });
    append(id, { ...verdict, ...reuse });
  }
  // Same plan/slots/tiers: this is explicit proof of a permitted delta, never re-routing.
  const next = { ...p, wtree: current, head_sha: sha, carryForward: audit, localLanesOnly: true };
  root.cyclePlans = { ...(root.cyclePlans ?? {}), [String(cycle)]: next };
  if (root.cycle === cycle) Object.assign(root, next);
  fs.writeFileSync(planPath(id), JSON.stringify(root, null, 2) + '\n');
  console.log('CARRY_FORWARD=true');
  console.log(`TEST_ONLY=${delta.testOnly}`); console.log(`DOC_ONLY=${delta.docOnly}`);
  console.log('LOCAL_LANES_ONLY=true');
  console.log(`CARRY_AUDIT_ID=${audit.audit_id}`);
  process.exit(0);
}

if (command === 'rerun-check') {
  const id = argv[0],
    explicitSince = opt('--since');
  if (!id) fail('run id required');
  const rootPlan = loadPlan(id);
  const cycle = requestedCycle();
  const p = cyclePlan(rootPlan, cycle);
  const recordedHeads = Object.values(rootPlan.cyclePlans ?? { [String(p.cycle)]: p })
    .map((candidate: any) => candidate.head_sha)
    .filter(Boolean);
  if (explicitSince && !recordedHeads.includes(explicitSince)) {
    console.log('RERUN_CHECK=blocked reason=unrecorded-since');
    process.exit(2);
  }
  const since = explicitSince ?? p.head_sha;
  if (!since) {
    console.log('RERUN_CHECK=blocked reason=unrecorded-since');
    process.exit(2);
  }
  if (p.nonCodeDelta === true) {
    const current = currentWtree();
    const delta = nonCodeReviewDelta(repoRoot, p.wtree, current!, p.policy);
    const triggers = [...delta.triggers];
    if (!delta.allowed && !delta.error) {
      for (const f of delta.files) {
        if (f.status !== 'A' && matchAny(f.path, p.testGlobs)) triggers.push(`modified-test:${f.path}`);
        else if (f.status === 'A') triggers.push(`new-file:${f.path}`);
        else triggers.push(`code-delta:${f.path}`);
      }
      if (delta.lines > 50) triggers.push('delta-lines>50');
    }
    if (JSON.stringify(readPolicy(repoRoot)) !== JSON.stringify(p.policy)) triggers.push('policy-changed');
    const unique = [...new Set(triggers)], full = unique.length > 0;
    const carried = (rootPlan.cyclePlans?.['0'] ?? rootPlan)?.carriedCycles ?? 0;
    const effective = cycle + carried;
    append(id, { record_type: 'rerun-check', run_id: id, full_rerun: full, triggers: unique,
      fix_delta_lines: Number.isFinite(delta.lines) ? delta.lines : null, since, old_wtree: p.wtree, new_wtree: current,
      test_only: delta.testOnly && !full, doc_only: delta.docOnly && !full,
      local_lanes_only: delta.allowed && !full, cycle, carried_cycles: carried, effective_cycle: effective, ts: now() });
    console.log(`FULL_RERUN=${full}`); console.log(`RERUN_TRIGGERS=${unique.length ? unique.join(',') : 'none'}`);
    console.log(`TEST_ONLY=${delta.testOnly && !full}`); console.log(`DOC_ONLY=${delta.docOnly && !full}`);
    console.log(`LOCAL_LANES_ONLY=${delta.allowed && !full}`);
    console.log(`FIX_DELTA_LINES=${Number.isFinite(delta.lines) ? delta.lines : 'binary'}`);
    console.log(`EFFECTIVE_REPAIR_CYCLE=${effective}`);
    if (effective > p.repairCyclesMax) { console.log('REPAIR_CYCLES_EXHAUSTED=true'); process.exit(3); }
    process.exit(0);
  }
  const r = spawnSync('git', ['diff', '--no-renames', '--numstat', since], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const rows: { p: string; n: number }[] = [];
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (m) rows.push({ p: m[3], n: (m[1] === '-' ? 0 : +m[1]) + (m[2] === '-' ? 0 : +m[2]) });
  }
  const tracked = new Set(rows.map((x) => x.p));
  const untrackedResult = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const u = untrackedResult.stdout || '';
  for (const f of u.trim().split('\n').filter(Boolean))
    if (!tracked.has(f)) {
      let n = 0;
      try {
        n = fs.readFileSync(path.join(repoRoot, f), 'utf8').split('\n').length - 1;
      } catch {}
      rows.push({ p: f, n });
    }
  const original = new Set(p.files.map((f: any) => f.path));
  const triggers: string[] = [];
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
  const gitFailure =
    r.status !== 0 ||
    !!r.error ||
    untrackedResult.status !== 0 ||
    !!untrackedResult.error ||
    status.status !== 0 ||
    !!status.error ||
    (!(r.stdout || '').trim() && !!(status.stdout || '').trim());
  if (gitFailure) triggers.push('git-failure');
  for (const x of rows) {
    if (!original.has(x.p)) triggers.push(`new-file:${x.p}`);
    if (matchAny(x.p, p.authSurfaces)) triggers.push(`auth-surface:${x.p}`);
    if (matchAny(x.p, p.dSurfaces) && !(p.dSurfaceExceptions ?? []).includes(x.p)) triggers.push(`d-surface:${x.p}`);
    if (matchAny(x.p, p.envSurfaces ?? DEFAULT_ENV_SURFACES)) triggers.push(`env:${x.p}`);
    if (matchAny(x.p, ['supabase/migrations/**'])) triggers.push(`migration:${x.p}`);
    if (matchAny(x.p, ['app/api/**'])) triggers.push(`api:${x.p}`);
  }
  const lines = rows.reduce((s, x) => s + x.n, 0);
  if (lines > 50) triggers.push('delta-lines>50');
  const unique = [...new Set(triggers)];
  const full = unique.length > 0;
  const carriedCycles = (rootPlan.cyclePlans?.['0'] ?? (rootPlan.cycle === 0 ? rootPlan : null))?.carriedCycles ?? 0;
  const effective = cycle + carriedCycles;
  append(id, {
    record_type: 'rerun-check',
    run_id: id,
    full_rerun: full,
    triggers: unique,
    fix_delta_lines: lines,
    since,
    cycle,
    carried_cycles: carriedCycles,
    effective_cycle: effective,
    ts: now(),
  });
  console.log('TEST_ONLY=false');
  console.log('DOC_ONLY=false');
  console.log('LOCAL_LANES_ONLY=false');
  console.log(`FULL_RERUN=${full}`);
  console.log(`RERUN_TRIGGERS=${unique.length ? unique.join(',') : 'none'}`);
  console.log(`FIX_DELTA_LINES=${lines}`);
  console.log(`EFFECTIVE_REPAIR_CYCLE=${effective}`);
  if (effective > p.repairCyclesMax) {
    console.log('REPAIR_CYCLES_EXHAUSTED=true');
    process.exit(3);
  }
  process.exit(0);
}

if (command === 'finding') {
  const id = argv[0],
    raw = argv[1];
  if (!id || !raw) fail('run id and finding json required');
  const cycle = requestedCycle();
  const p = cyclePlan(loadPlan(id), cycle);
  let f: any;
  try {
    f = JSON.parse(raw);
  } catch {
    fail('invalid finding json');
  }
  for (const k of ['severity', 'fingerprint', 'gate', 'summary'])
    if (typeof f[k] !== 'string' || !f[k]) fail(`finding missing ${k}`);
  const category = typeof f.category === 'string' ? f.category.toLowerCase() : null;
  const isBlocking =
    p.blockingSeverities.includes(f.severity.toUpperCase()) ||
    ((f.severity.toUpperCase() === 'INFORMATIONAL' || p.autofixInformational === false) &&
      !!category &&
      p.blockingCategories.includes(category));
  append(id, {
    record_type: 'finding',
    run_id: id,
    ...f,
    category,
    blocking: isBlocking,
    cycle,
    ts: now(),
  });
  process.exit(0);
}
if (command === 'resolve') {
  const id = argv[0],
    fingerprint = argv[1],
    action = opt('--action');
  if (!id || !fingerprint || !['fixed', 'accepted', 'skipped'].includes(action || ''))
    fail('invalid resolve');
  loadPlan(id);
  append(id, { record_type: 'resolved', run_id: id, fingerprint, action, ts: now() });
  process.exit(0);
}
if (command === 'report') {
  const id = argv[0];
  if (!id) fail('run id required');
  loadPlan(id);
  const rs = records(id);
  const semantic = rs.filter((r) => r.record_type === 'dispatch' && r.allowed && r.semantic && !r.carry_forward).length,
    blocked = rs.filter((r) => r.record_type === 'dispatch' && !r.allowed).length,
    escalations = rs.filter((r) => r.record_type === 'dispatch' && r.escalation).length,
    fulls = rs.filter((r) => r.record_type === 'rerun-check' && r.full_rerun),
    blockingFindings = rs.filter((r) => r.record_type === 'finding' && r.blocking),
    resolutions = new Map(
      rs.filter((r) => r.record_type === 'resolved').map((r) => [r.fingerprint, r.action]),
    ),
    acceptedBlocking = blockingFindings.filter((r) =>
      ['fixed', 'accepted'].includes(resolutions.get(r.fingerprint)),
    ).length;
  console.log(
    `Review run ${id} dispatched ${semantic} semantic reviewer(s), blocked ${blocked}, used ${escalations} escalation(s), and required ${fulls.length} full rerun(s).`,
  );
  console.log(`SEMANTIC_DISPATCHES=${semantic}`);
  console.log(`CARRY_FORWARDS=${rs.filter(r => r.record_type === 'carry-forward').length}`);
  console.log(`BLOCKED_DISPATCHES=${blocked}`);
  console.log(`ESCALATIONS=${escalations}`);
  console.log(`FULL_RERUNS=${fulls.length}`);
  console.log(`BLOCKING_FINDINGS=${blockingFindings.length}`);
  console.log(`BLOCKING_FINDINGS_ACCEPTED=${acceptedBlocking}`);
  console.log(
    `RERUN_TRIGGERS=${[...new Set(fulls.flatMap((r) => r.triggers || []))].join(',') || 'none'}`,
  );
  process.exit(0);
}
fail('usage: plan|dispatch|verdict|complete|resume|rerun-check|finding|resolve|report');
