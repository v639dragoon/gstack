import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

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
      .map(JSON.parse);
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
  let previous: any = null;
  try {
    previous = JSON.parse(fs.readFileSync(planPath(m.run_id), 'utf8'));
  } catch {}
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
      (k) => !['budgets', 'repair_cycles', 'escalation_kinds'].includes(k),
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
  const out = m.routing.outcome || {};
  const final = out.is_final_slice || out.is_flag_flip || !out.present;
  const deterministicGates =
    'tests,typecheck,build,gitleaks,redaction,verification,claim-check' +
    (tier === 'D' ? ',migration-runbook' : '');
  const reviewers = reviewerSpecs.map((s, i) => {
    const at = s.lastIndexOf('@');
    return { gate: s.slice(0, at), model_or_effort: s.slice(at + 1), slot: i + 1 };
  });
  const plan: any = {
    runId: m.run_id,
    cycle,
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
    adversarialClaude: false,
    codexChallenge: false,
    redTeamLocTrigger: false,
    coverageAudit: final,
    planCompletion: final,
    docRelease: !!m.routing.doc_impact_would_dispatch || final,
    codexDocVoice: tier === 'D' && final,
    repairCyclesMax: cycles,
    autofixInformational: false,
    maxAdvisories: 5,
    blockingSeverities: blocking,
    blockingCategories,
    deterministicGates,
    subagentModel: 'sonnet',
    forbiddenSubagentModels: ['fable', 'opus'],
    escalationKinds,
    manifestPath: path.resolve(manifestFile),
    files: m.files || [],
    scope: m.scope || {},
    authSurfaces: policyRaw?.auth_surfaces || [],
    dSurfaces: policyRaw?.d_surfaces || [],
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
      ['ADVERSARIAL_CLAUDE', false],
      ['CODEX_CHALLENGE', false],
      ['RED_TEAM_LOC_TRIGGER', false],
      ['COVERAGE_AUDIT', plan.coverageAudit],
      ['PLAN_COMPLETION', plan.planCompletion],
      ['DOC_RELEASE', plan.docRelease],
      ['CODEX_DOC_VOICE', plan.codexDocVoice],
      ['REPAIR_CYCLES_MAX', cycles],
      ['AUTOFIX_INFORMATIONAL', false],
      ['MAX_ADVISORIES', 5],
      ['BLOCKING_SEVERITIES', blocking.join(',')],
      ['BLOCKING_CATEGORIES', blockingCategories.join(',')],
      ['DETERMINISTIC_GATES', deterministicGates],
      ['SUBAGENT_MODEL', 'sonnet'],
      ['FORBIDDEN_SUBAGENT_MODELS', 'fable,opus'],
      ['POLICY_ROUTING_IGNORED', ignored.join(',')],
    ];
    for (const [k, v] of kv) console.log(`${k}=${v}`);
  }
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
  const semantic =
    ['codex-structured', 'red-team', 'adversarial-claude', 'codex-challenge'].includes(gate) ||
    gate.startsWith('specialist:');
  const planned = p.reviewers.some((r: any) => r.gate === gate);
  const verifyOf = opt('--verify-of');
  const escRaw = opt('--escalation');
  const inCycle = (r: any) => Number(r.cycle ?? 0) === cycle;
  const priorAllowedSemantic = old.filter(
    (r) =>
      r.record_type === 'dispatch' &&
      r.allowed &&
      r.semantic &&
      !r.verify_of &&
      !r.retry &&
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
    if (gateDispatches.length === 0 && priorAllowedSemantic < p.reviewerBudget) {
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
    gate,
    allowed,
    reason,
    escalation,
    semantic,
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
  if (!p.reviewers.some((r: any) => r.gate === gate)) {
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
    critical: count('--critical'),
    informational: count('--informational'),
    ts: now(),
  });
  console.log(`VERDICT=recorded gate=${gate} result=${verdict}`);
  process.exit(0);
}

if (command === 'complete') {
  const id = argv[0];
  if (!id) fail('run id required');
  const cycle = requestedCycle();
  const p = cyclePlan(loadPlan(id), cycle);
  const rs = records(id).filter(
    (r) => r.record_type === 'verdict' && Number(r.cycle ?? 0) === cycle,
  );
  const incomplete = p.reviewers
    .map((r: any) => r.gate)
    .filter((gate: string) => {
      const verdict = rs.filter((r) => r.gate === gate).at(-1)?.verdict;
      return !['clean', 'issues_found'].includes(verdict);
    });
  if (incomplete.length) {
    console.log(`INCOMPLETE=${incomplete.join(',')}`);
    process.exit(2);
  }
  console.log('COMPLETE=true');
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
    if (matchAny(x.p, p.dSurfaces)) triggers.push(`d-surface:${x.p}`);
    if (matchAny(x.p, ['lib/env/**', '.env.example'])) triggers.push(`env:${x.p}`);
    if (matchAny(x.p, ['supabase/migrations/**'])) triggers.push(`migration:${x.p}`);
    if (matchAny(x.p, ['app/api/**'])) triggers.push(`api:${x.p}`);
  }
  const lines = rows.reduce((s, x) => s + x.n, 0);
  if (lines > 50) triggers.push('delta-lines>50');
  const unique = [...new Set(triggers)];
  const full = unique.length > 0;
  append(id, {
    record_type: 'rerun-check',
    run_id: id,
    full_rerun: full,
    triggers: unique,
    fix_delta_lines: lines,
    since,
    cycle,
    ts: now(),
  });
  console.log(`FULL_RERUN=${full}`);
  console.log(`RERUN_TRIGGERS=${unique.length ? unique.join(',') : 'none'}`);
  console.log(`FIX_DELTA_LINES=${lines}`);
  if (cycle > p.repairCyclesMax) {
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
    (f.severity.toUpperCase() === 'INFORMATIONAL' &&
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
  const semantic = rs.filter((r) => r.record_type === 'dispatch' && r.allowed && r.semantic).length,
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
fail('usage: plan|dispatch|verdict|complete|rerun-check|finding|resolve|report');
