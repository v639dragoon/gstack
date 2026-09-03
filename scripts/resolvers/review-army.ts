/** Review-governor prose shared by /ship and /review. */
import type { TemplateContext } from './types';

export function generateReviewArmy(ctx: TemplateContext): string {
  if (ctx.host === 'codex') return '';
  const ship = ctx.skillName === 'ship';
  const selectStep = ship ? '9.1' : '4.5';
  const mergeStep = ship ? '9.2' : '4.6';

  return `## Step ${selectStep}: Review governor — manifest, plan, packet

Create one manifest, deterministic reviewer plan, and shared packet:

\`\`\`bash
${ctx.paths.binDir}/gstack-diff-manifest <base>
${ctx.paths.binDir}/gstack-review-budget plan "$MANIFEST_PATH" --cycle 0
${ctx.paths.binDir}/gstack-review-packet "$RUN_ID" <base>
\`\`\`

Carry these printed values as literals for the rest of the invocation:
\`RUN_ID\`, \`CYCLE\`, \`TIER\`, \`SLICE_KIND\`, \`REVIEWERS\`, \`REPAIR_CYCLES_MAX\`,
\`COVERAGE_AUDIT\`, \`PLAN_COMPLETION\`, \`DOC_RELEASE\`,
\`CODEX_DOC_VOICE\`, \`PACKET_PATH\`, \`DIFF_PATH\`, and \`CI_GREEN\`.
Also retain \`MANIFEST_WTREE\`, \`DOC_FP\`, \`OUTCOME_ID\`,
\`OUTCOME_MISSING\`, \`MAX_ADVISORIES\`, \`AUTOFIX_INFORMATIONAL\`,
\`BLOCKING_SEVERITIES\`, and \`BLOCKING_CATEGORIES\`.

If \`OUTCOME_MISSING=true\`, print exactly:

\`Outcome metadata missing — treating this slice as FINAL (full release review at tier {TIER}). Set it with: ~/.claude/skills/gstack/bin/gstack-outcome set --id <id> --slice <n> [--final] [--flag-flip]\`.

### Plan-owned reviewer selection

The plan REPLACES LOC tables, scope selection, adaptive gating, and force flags.
Dispatch ONLY the \`specialist:*\` and \`red-team\` entries present in
\`REVIEWERS\`, in their listed order. A user \`--<specialist>\` request is not
a routing input: request one extra dispatch with
\`--escalation user-request:<flag>\`. Each planned gate dispatches once per
cycle, except that an \`error\` or \`timeout\` verdict permits exactly one retry.
Only ONE escalation of any kind may be used across the entire run; after it is
consumed, no user-request or specialist-critical escalation remains.

Before EACH specialist or red-team Agent call, run:

\`\`\`bash
${ctx.paths.binDir}/gstack-review-budget dispatch "$RUN_ID" <gate> --cycle <n>
\`\`\`

On exit 2, print the command's line and do NOT dispatch. Every allowed Agent
call has \`subagent_type: "general-purpose"\`, \`model: "sonnet"\` (the
\`@sonnet\` reviewer suffix), and \`run_in_background: false\`.

Each specialist prompt starts exactly with:

> Read the review packet at {PACKET_PATH} and the diff at {DIFF_PATH} first. Do not re-derive the project. CI_GREEN={CI_GREEN}: when true, do not run the build or the full test suite.

Then append the checklist from
\`${ctx.paths.skillRoot}/review/specialists/<name>.md\` (or
\`design-checklist.md\` for design) and require newline-delimited JSON:
\`{"severity":"CRITICAL|P1|P2|INFORMATIONAL","confidence":N,"path":"file","line":N,"category":"security|reliability|data-safety|data-migration|sql-data-safety|llm-trust-boundary|auth|other-category","summary":"description","fix":"recommended fix","fingerprint":"path:line:category","specialist":"name"}\`.
Use the closed \`BLOCKING_CATEGORIES\` vocabulary whenever it applies; other
specific category strings remain advisory unless the plan lists them.
If clean, output \`NO FINDINGS\` only.

After every specialist or red-team reviewer returns, record its terminal
result before doing anything else:

\`\`\`bash
${ctx.paths.binDir}/gstack-review-budget verdict "$RUN_ID" <gate> <clean|issues_found|error|timeout> --cycle <n> [--critical N --informational N]
\`\`\`

For \`error\` or \`timeout\`, retry the same planned gate at most once by running
the cycle-scoped dispatch again, then record the retry verdict. A second
failure remains incomplete; it is never converted to clean.

Red Team runs only when \`red-team\` occupies a plan slot, or as the ONE extra
dispatch requested with
\`--escalation specialist-critical:<fingerprint> --cycle <n>\` after an allowed specialist
reports CRITICAL. Gate it before the Agent call exactly as above and use the
same explicit Agent configuration. It is never triggered by line count.

---

### Step ${mergeStep}: Merge, classify, and record findings

Before finalizing this merge, after every planned reviewer (including the
\`codex-structured\` slot routed in the adversarial step) has returned, run:

\`\`\`bash
${ctx.paths.binDir}/gstack-review-budget complete "$RUN_ID" --cycle <n>
\`\`\`

On exit 2, print its \`INCOMPLETE=\` line and **STOP with a blocker report**.
Do not log the review clean and do not continue shipping: a missing, failed,
or timed-out required reviewer is never a clean pass.

Parse valid JSON lines, fingerprint as \`path:line:category\` when absent,
deduplicate by fingerprint, and keep the highest-confidence copy. Confidence
7+ is shown normally, 5-6 is marked medium confidence, 3-4 goes to an
appendix, and 1-2 is suppressed.

Classify a finding as **BLOCKING** when its severity is in the carried
\`BLOCKING_SEVERITIES\` OR its category is in the carried
\`BLOCKING_CATEGORIES\`. Everything else is **ADVISORY**. ADVISORY findings are NEVER fixed
inside /${ctx.skillName}: no AUTO-FIX and no ASK. Keep at most
\`MAX_ADVISORIES\` (5), ordered by confidence, and render them under
\`## Advisories (not fixed)\` in the review summary${ship ? ' and PR body' : ''}.
\`AUTOFIX_INFORMATIONAL=false\` is invariant.

BLOCKING findings alone enter the existing ASK/fix flow. Record every finding
with \`gstack-review-budget finding\`; resolve approved fixes with
\`gstack-review-budget resolve\`. Per-dispatch telemetry uses
\`gstack-gate-log\`; for plan reviewers record the plan suffix, with
\`effort_source:"routed"\` for Codex and \`model:"sonnet"\` for subagents.

Compute the quality score over blocking findings only. The summary is:

\`SPECIALIST REVIEW: N blocking findings from Z planned reviewers\`

followed by the blocking list, quality score, and the bounded advisories
section. Failed or timed-out reviewers are missing coverage, not clean passes.`;
}
