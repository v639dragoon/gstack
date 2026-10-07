/** Fork accounting guidance kept outside external /review's upstream inline body. */
import type { TemplateContext } from './types';

export function generateGovernorPlanBody(ctx: TemplateContext): string {
  const ship = ctx.skillName === 'ship';
  const selectStep = ship ? '9.1' : '4.5';
  const mergeStep = ship ? '9.2' : '4.6';
  return `### Governor manifest, plan, packet

${ship ? `Reuse RUN_ID from the governed audit accounting. After Steps 7–8 finish their writes, refresh
that run's manifest and plan, preserving its audit verdicts and attempt counts.
Then build the shared packet from the final reviewed content:` : 'Create one manifest, deterministic reviewer plan, and shared packet:'}

\`\`\`bash
${ctx.paths.binDir}/gstack-diff-manifest <base>${ship ? ' "$RUN_ID"' : ''}
${ctx.paths.binDir}/gstack-review-budget plan "$MANIFEST_PATH" --cycle 0 --host ${ctx.host}
${ctx.paths.binDir}/gstack-review-budget resume "$RUN_ID"
${ctx.paths.binDir}/gstack-review-packet "$RUN_ID" <base>
\`\`\`

Carry these printed values as literals for the rest of the invocation:
\`RUN_ID\`, \`CYCLE\`, \`TIER\`, \`SLICE_KIND\`, \`REVIEWERS\`, \`PASSES\`, \`REPAIR_CYCLES_MAX\`,
\`COVERAGE_AUDIT\`, \`PLAN_COMPLETION\`, \`DOC_RELEASE\`,
\`CODEX_DOC_VOICE\`, \`UPSTREAM_SPECIALISTS\`, \`UPSTREAM_STRUCTURED\`, \`ADVERSARIAL_CLAUDE\`,
\`CODEX_CHALLENGE\`, \`RED_TEAM_LOC_TRIGGER\`, \`GREPTILE\`, \`COVERAGE_RATING\`,
\`AUDIT_REUSE\`, \`NON_CODE_DELTA\`, \`QA_SMOKE\`, \`FULL_LANES_REQUIRED\`, \`BUILD_GATE\`, \`CI_BACKSTOP\`, \`PACKET_PATH\`, \`DIFF_PATH\`, \`CI_GREEN\`, \`REUSED\` and \`RERUN\`.

\`PASSES\` is the whole-workflow accounting for this run: every AI pass it may
dispatch (reviewer slots, coverage audit, plan completion, doc release, doc
voice) with its model and effort; Upstream-required passes join its accounting through register-upstream; a pass absent from either record never runs. \`resume\`
carries forward the terminal verdicts of a PRIOR run whose content
fingerprint, base, policy, tier, reviewer list and slice kind all equal this
plan's (a matching commit with a dirty tree never qualifies): print
\`Reused from {RESUME_SOURCE}: {REUSED}\` when non-empty, do not dispatch a gate
listed in \`REUSED\` (its dispatch would be refused as duplicate-slot), and
dispatch only \`RERUN\`. Only clean and issues_found verdicts are reusable;
error, timeout and missing verdicts are never carried.
Also retain \`MANIFEST_WTREE\`, \`DOC_FP\`, \`OUTCOME_ID\`,
\`OUTCOME_MISSING\`, \`MAX_ADVISORIES\`, \`AUTOFIX_INFORMATIONAL\`,
\`BLOCKING_SEVERITIES\`, and \`BLOCKING_CATEGORIES\`.

If \`OUTCOME_MISSING=true\`, print exactly:

\`Outcome metadata missing — treating this slice as FINAL (full release review at tier {TIER}). Set it with: ~/.claude/skills/gstack/bin/gstack-outcome set --id <id> --slice <n> [--final] [--flag-flip]\`.

`;
}

export function governorDispatchAccounting(ctx: TemplateContext): string {
  return `Union upstream-selected specialists with planned \`specialist:*\` slots, retaining
source labels. The small-diff bypass skips upstream specialists only; execute any
governor-planned slots separately, then the parent Exploratory QA handoff.
Never dispatch the same specialist twice: one result may satisfy both sources
only when both dispatch records name the same frozen tree/SHA.
Register upstream-only selected specialists with
\`gstack-review-budget register-upstream "$RUN_ID" upstream-specialist:<name> --cycle <n>\`;
then run \`gstack-review-budget dispatch "$RUN_ID" <gate> --cycle <n>\`
before each Agent call. Every allowed Agent is accounted before launch. Every specialist
Agent sets \`model: "sonnet"\`. Each prompt starts: "Read the review packet at {PACKET_PATH} and the diff at {DIFF_PATH} first." CI_GREEN=true
means do not repeat builds/tests. Record each terminal verdict with \`gstack-review-budget verdict "$RUN_ID" <gate> <clean|issues_found|error|timeout> --cycle <n>\` and a best-effort
\`gstack-gate-log\` row with model sonnet, effort agent-default, effort_source routed,
fix_cycle, rerun_cause and manifest_wtree. Errors/timeouts retain upstream
settlement and missing-coverage rules; the budget allows one corrected attempt.
Routed codex-structured remains an additional Step ${ctx.skillName === 'ship' ? '11' : '4.8'} slot.


`;
}

export function governorRedTeamAccounting(ctx: TemplateContext): string {
  return `Register upstream activation as \`upstream-specialist:red-team\` unless red-team
already occupies a planned slot. Dispatch the chosen gate through review-budget
before the Sonnet Agent call; record its verdict and gate row afterward. A planned
red-team runs even without upstream activation. Upstream-required activation is
accounted separately and does not consume the single routed escalation.

`;
}

export function governorSpecialistTelemetry(ctx: TemplateContext): string {
  return `**Persist per-gate telemetry (Phase 0):** for EACH dispatched specialist (and
Red Team, either path), append one gate record, substituting {placeholder}s
with carried literals:

\`\`\`bash
${ctx.paths.binDir}/gstack-gate-log '{"record_type":"gate","run_id":"{RUN_ID}","skill":"${ctx.skillName}","gate":"specialist:{name}","trigger":"{always-on|SCOPE_AUTH=true|DIFF_LINES={N}>200|user-flag:--{name}}","started_at":"{batch launch ts}","ended_at":"{completion or merge ts}","model":"claude-subagent","effort":null,"tokens":{"total":{N|null},"source":{"task-notification"|null}},"verdict":"{clean|issues_found|error}","findings":{"critical":{N},"informational":{N}},"fix_cycle":{N 0-based},"rerun_cause":{null|"fix-loop"},"manifest_wtree":"{MANIFEST_WTREE}"}' 2>/dev/null || true
\`\`\`

Telemetry is best-effort: a failed gate-log call never blocks or changes the
review, and the aggregate \`specialists\` object still goes into reviews.jsonl
unchanged.`;
}

export function governorAdversarialTelemetry(ctx: TemplateContext): string {
  return `**Persist per-gate telemetry (Phase 0):** one gate record per pass that ran,
substituting carried literals (RUN_ID/MANIFEST_WTREE from the Step 9.1
manifest; if none this run, run \`gstack-diff-manifest <base>\` now).
\`tokens.total\` for a codex pass comes from the \`tokens used\` line in its
stderr (read BEFORE \`rm -f\`); omit \`tokens\` when unavailable.

\`\`\`bash
~/.claude/skills/gstack/bin/gstack-gate-log '{"record_type":"gate","run_id":"{RUN_ID}","skill":"{ship|review}","gate":"adversarial-claude","trigger":"always-on","started_at":"{dispatch ts}","ended_at":"{completion ts}","model":"claude-subagent","effort":null,"verdict":"{clean|issues_found|error}","fix_cycle":{N},"rerun_cause":{null|"fix-loop"},"manifest_wtree":"{MANIFEST_WTREE}"}' 2>/dev/null || true
~/.claude/skills/gstack/bin/gstack-gate-log '{"record_type":"gate","run_id":"{RUN_ID}","skill":"{ship|review}","gate":"codex-adversarial","trigger":"CODEX_MODE=ready","started_at":"{dispatch ts}","ended_at":"{completion ts}","model":"codex","effort":"high","effort_source":"default","tokens":{"total":{N},"source":"codex-stderr"},"verdict":"{clean|issues_found|timeout|error}","fix_cycle":{N},"rerun_cause":{null|"fix-loop"},"manifest_wtree":"{MANIFEST_WTREE}"}' 2>/dev/null || true
~/.claude/skills/gstack/bin/gstack-gate-log '{"record_type":"gate","run_id":"{RUN_ID}","skill":"{ship|review}","gate":"codex-structured","trigger":"DIFF_TOTAL={N}>=200","started_at":"{dispatch ts}","ended_at":"{completion ts}","model":"codex","effort":"high","effort_source":"default","tokens":{"total":{N},"source":"codex-stderr"},"verdict":"{clean=pass|fail|timeout|error}","findings":{"p1":{N}},"fix_cycle":{N},"rerun_cause":{null|"fix-loop"|"p1-gate"},"manifest_wtree":"{MANIFEST_WTREE}"}' 2>/dev/null || true
\`\`\`

Emit records only for passes that dispatched — absence is the skip signal.
Telemetry is best-effort: failures never block.

`;
}

export function governorNativeRegistration(ctx: TemplateContext): string {
  const isShip = ctx.skillName === 'ship';
  return `Register and dispatch the required native attempt before its Agent call:
\`gstack-review-budget register-upstream "$RUN_ID" native-adversarial --cycle <n>\`,
then \`gstack-review-budget dispatch "$RUN_ID" native-adversarial --cycle <n>\`.
Registration records this upstream-required reviewer independently of routed slots.
Every native call sets \`subagent_type: "general-purpose"\` and \`model: "sonnet"\`.

`;
}

export function governorNativeVerdict(ctx: TemplateContext): string {
  const isShip = ctx.skillName === 'ship';
  return `Record \`gstack-review-budget verdict "$RUN_ID" native-adversarial <clean|issues_found|error|timeout> --cycle <n>\`
and a best-effort \`gstack-gate-log\` row with gate native-adversarial, model sonnet,
effort agent-default, effort_source routed, fix_cycle, rerun_cause and manifest_wtree.
Keep its original PASS_START review-log record; Step ${isShip ? '11.5' : '5.8'} binds that native receipt.
The upstream one-corrected-attempt recovery applies; terminal failure never certifies completion.

`;
}
