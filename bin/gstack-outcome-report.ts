import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
const args = process.argv.slice(2),
  id = args[0],
  project = process.env.GSTACK_REPORT_PROJECT_DIR!,
  repo = process.env.GSTACK_REPORT_REPO_ROOT!;
if (!id) {
  console.error('gstack-outcome-report: outcome id required');
  process.exit(1);
}
let outcome: any;
try {
  outcome = JSON.parse(fs.readFileSync(path.join(project, 'outcomes', `${id}.json`), 'utf8'));
} catch {
  console.error('gstack-outcome-report: outcome not found');
  process.exit(1);
}
const jsonl = (p: string) => {
  try {
    return fs
      .readFileSync(p, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((x) => JSON.parse(x));
  } catch {
    return [];
  }
};
const allFiles = fs.existsSync(project) ? fs.readdirSync(project) : [];
const gateRows = allFiles
  .filter((x) => x.endsWith('-gates.jsonl'))
  .flatMap((x) => jsonl(path.join(project, x)))
  .filter((r) => r.outcome_id === id);
const reviewRows = allFiles
  .filter((x) => x.endsWith('-reviews.jsonl'))
  .flatMap((x) => jsonl(path.join(project, x)))
  .filter((r) => r.outcome_id === id);
const budgetDir = path.join(project, 'budgets');
const plans: any[] = [];
if (fs.existsSync(budgetDir))
  for (const f of fs
    .readdirSync(budgetDir)
    .filter((x) => x.endsWith('.json') && !x.endsWith('.ledger.json'))) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(budgetDir, f), 'utf8'));
      if (p.outcome_id === id) plans.push(p);
    } catch {}
  }
const ledgers = new Map<string, any[]>();
for (const p of plans) ledgers.set(p.runId, jsonl(path.join(budgetDir, `${p.runId}.ledger.jsonl`)));
let turns = 0,
  lastUsage: any = null,
  lastModel: any = null,
  lastEffort: any = null,
  transcriptReadable = true,
  interruptions = 0;
const escaped = repo.replace(/[^a-zA-Z0-9_-]/g, '-');
for (const session of outcome.sessions || []) {
  const sid = typeof session === 'string' ? session : session.session_id;
  const candidates = [
    path.join(process.env.GSTACK_CLAUDE_PROJECTS_DIR!, escaped, `${sid}.jsonl`),
    path.join(process.env.GSTACK_CLAUDE_PROJECTS_DIR!, `${sid}.jsonl`),
  ];
  const tp = candidates.find(fs.existsSync);
  if (!tp) {
    transcriptReadable = false;
    continue;
  }
  for (const r of jsonl(tp)) {
    if (r.type === 'assistant' || r.message?.role === 'assistant') {
      turns++;
      if (r.message?.usage) {
        lastUsage = r.message.usage;
        lastModel = r.message.model || r.model || lastModel;
        lastEffort = r.effort || r.message?.effort || lastEffort;
      }
      const content = r.message?.content;
      if (Array.isArray(content))
        interruptions += content.filter(
          (x: any) =>
            x?.type === 'tool_use' &&
            (x.name === 'AskUserQuestion' || x.name === 'ask_user_question'),
        ).length;
    } else if (r.tool_name === 'AskUserQuestion' || r.name === 'AskUserQuestion') interruptions++;
  }
}
const lead = {
  model: lastModel,
  effort: lastEffort,
  turns: transcriptReadable ? turns : null,
  ending_context_tokens: lastUsage
    ? Number(lastUsage.input_tokens || 0) +
      Number(lastUsage.cache_creation_input_tokens || 0) +
      Number(lastUsage.cache_read_input_tokens || 0)
    : null,
};
const runsBy: Record<string, number> = {};
for (const r of gateRows) {
  const k = `${r.model || 'unknown'}@${r.effort || 'unknown'}`;
  runsBy[k] = (runsBy[k] || 0) + 1;
}
let accepted = 0;
const yields: Record<string, { reviewer_runs: number; accepted_blocking: number; yield: number }> =
  {};
const tierByRun = new Map(plans.map((p) => [p.runId, p.tier]));
for (const r of gateRows) {
  const tier = r.risk_tier || tierByRun.get(r.run_id);
  if (!tier) continue;
  const k = `${r.gate}|${tier}`;
  yields[k] ||= { reviewer_runs: 0, accepted_blocking: 0, yield: 0 };
  yields[k].reviewer_runs++;
}
for (const p of plans) {
  const rs = ledgers.get(p.runId) || [],
    resolved = new Map(
      rs.filter((r) => r.record_type === 'resolved').map((r) => [r.fingerprint, r.action]),
    );
  for (const f of rs.filter(
    (r) =>
      r.record_type === 'finding' &&
      (r.blocking === true || p.blockingSeverities.includes(r.severity)) &&
      ['fixed', 'accepted'].includes(resolved.get(r.fingerprint)),
  )) {
    accepted++;
    const k = `${f.gate}|${p.tier}`;
    yields[k] ||= { reviewer_runs: 0, accepted_blocking: 0, yield: 0 };
    yields[k].accepted_blocking++;
  }
}
for (const y of Object.values(yields))
  y.yield = y.reviewer_runs ? y.accepted_blocking / y.reviewer_runs : 0;
const informationalFindings = gateRows.reduce(
  (s, r) => s + Number(r.findings?.informational || 0),
  0,
);
const informationalFixed = reviewRows.reduce(
  (sum, r) =>
    sum +
    (Array.isArray(r.findings)
      ? r.findings.filter(
          (f: any) =>
            String(f.severity).toUpperCase() === 'INFORMATIONAL' &&
            ['fixed', 'auto-fixed'].includes(f.action),
        ).length
      : String(r.severity || r.finding?.severity).toUpperCase() === 'INFORMATIONAL' &&
          ['fixed', 'auto-fixed'].includes(r.action || r.finding?.action)
        ? 1
        : 0),
  0,
);
let repairCycles = 0;
for (const run of new Set(gateRows.map((r) => r.run_id))) {
  const xs = gateRows
    .filter((r) => r.run_id === run)
    .map((r) => Number(r.fix_cycle))
    .filter(Number.isFinite);
  if (xs.length) repairCycles += Math.max(...xs) + 1;
}
const fullReruns = plans.flatMap((p) =>
  (ledgers.get(p.runId) || [])
    .filter((r) => r.record_type === 'rerun-check' && r.full_rerun)
    .map((r) => ({ run_id: p.runId, triggers: r.triggers || [] })),
);
let planSeconds: null | number = null;
const lastSlice = [...(outcome.slices || [])].sort(
  (a: any, b: any) => b.slice_number - a.slice_number,
)[0];
if (
  outcome.approved_at &&
  lastSlice &&
  spawnSync('sh', ['-c', 'command -v gh >/dev/null 2>&1']).status === 0
) {
  const gr = spawnSync('gh', ['pr', 'view', lastSlice.branch, '--json', 'mergedAt'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 10000,
  });
  if (gr.status === 0)
    try {
      const merged = JSON.parse(gr.stdout).mergedAt;
      if (merged)
        planSeconds = Math.max(0, (Date.parse(merged) - Date.parse(outcome.approved_at)) / 1000);
    } catch {}
}
const report = {
  outcome_id: id,
  lead,
  runs_by_model_effort: runsBy,
  blocking_findings_accepted: accepted,
  informational_findings: informationalFindings,
  informational_fixed: informationalFixed,
  repair_cycles: repairCycles,
  full_reruns: fullReruns,
  founder_interruptions: transcriptReadable ? interruptions : null,
  plan_to_complete_seconds: planSeconds,
  post_merge_escapes: Array.isArray(outcome.escapes) ? outcome.escapes.length : 0,
  reviewer_yield: yields,
};
if (args.includes('--json')) console.log(JSON.stringify(report));
else
  for (const [k, v] of Object.entries(report))
    console.log(`${k.toUpperCase()}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
if (args.includes('--recommend')) {
  const stats: Record<string, { n: number; a: number; tier: string; gate: string }> = {};
  if (fs.existsSync(budgetDir))
    for (const f of fs
      .readdirSync(budgetDir)
      .filter((x) => x.endsWith('.json') && !x.endsWith('.ledger.json'))) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(budgetDir, f), 'utf8')),
          rs = jsonl(path.join(budgetDir, `${p.runId}.ledger.jsonl`)),
          resolved = new Map(
            rs.filter((r) => r.record_type === 'resolved').map((r) => [r.fingerprint, r.action]),
          );
        for (const d of rs.filter(
          (r) => r.record_type === 'dispatch' && r.allowed && r.semantic && !r.verify_of,
        )) {
          const k = `${d.gate}|${p.tier}`;
          stats[k] ||= { n: 0, a: 0, tier: p.tier, gate: d.gate };
          stats[k].n++;
        }
        for (const finding of rs.filter(
          (r) =>
            r.record_type === 'finding' &&
            (r.blocking === true || p.blockingSeverities?.includes(r.severity)) &&
            ['fixed', 'accepted'].includes(resolved.get(r.fingerprint)),
        )) {
          const k = `${finding.gate}|${p.tier}`;
          stats[k] ||= { n: 0, a: 0, tier: p.tier, gate: finding.gate };
          stats[k].a++;
        }
      } catch {}
    }
  for (const s of Object.values(stats))
    if (s.tier !== 'D' && s.n >= 8 && s.a === 0)
      console.log(
        `PROPOSE: ${s.gate} on tier ${s.tier} produced 0 accepted blockers in ${s.n} runs — consider a config PR lowering it`,
      );
}
