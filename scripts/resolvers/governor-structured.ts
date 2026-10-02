/** Additional governor slot; upstream outside passes retain their own contracts. */
import type { TemplateContext } from './types';
import { outsideVoicePreflight } from './outside-voice';

export function generateGovernorStructured(ctx: TemplateContext): string {

  // dohma fork: the governor routes adversarial review only where the outside
  // voice is Codex; the codex host keeps upstream's step (Claude Code voice).
  const routedStep = ctx.skillName === 'ship' ? '11' : '4.8';
  return `### Governor codex-structured slot


Run this additional slot only when codex-structured is planned and not in REUSED. A successful NON_CODE_DELTA carry-forward also satisfies it; preserve its audit record and do not dispatch again.
It does not replace the required native pass, upstream outside challenge, or
structured P1 decision. Record all of them separately.

Before the structured review, run the shared Codex preflight. Nested Codex
sessions must refuse another Codex spawn unless the explicit override is set:

${outsideVoicePreflight(ctx, { disabledBehavior: 'codex-only' })}

Only when \`CODEX_MODE: ready\`, run the budget dispatch:

\`\`\`bash
~/.claude/skills/gstack/bin/gstack-review-budget dispatch "$RUN_ID" codex-structured --cycle <n>
\`\`\`

On exit 2, print its line and do not run Codex. Otherwise resolve the slot's
MODEL once, before the review starts. The plan carries \`CODEX_MODEL\` (empty
= the client default; a policy \`routing.models\` entry names another, e.g.
dohma routes \`gpt-6-astra\` on tiers C and D) and \`CODEX_MODEL_SOURCE\`. A
named model runs only when the installed CLI and the signed-in account can
run it (one minimal access check, cached); otherwise the slot keeps the
default route and the substitution is logged. The model never changes the
budget, the effort, the 540s cap, the retry rule or the completion rule, and
a timed-out review stays incomplete: it never triggers an automatic
second-model review.

\`\`\`bash
~/.claude/skills/gstack/bin/gstack-codex-model resolve --model "{CODEX_MODEL}" --effort "{medium|high from REVIEWERS suffix}" --source "{CODEX_MODEL_SOURCE}"
\`\`\`

Carry its printed \`CODEX_MODEL\`, \`CODEX_MODEL_REQUESTED\`,
\`CODEX_MODEL_SOURCE\`, \`CODEX_MODEL_SUBSTITUTED\`,
\`CODEX_MODEL_SUBSTITUTION_REASON\`, \`CODEX_MODEL_EXEC_FLAGS\` and
\`CODEX_MODEL_REVIEW_FLAGS\` as literals. Print
\`Codex model: {CODEX_MODEL} ({CODEX_MODEL_SOURCE}; requested {CODEX_MODEL_REQUESTED})\`
and, when substituted, one more line with the reason. Then run exactly one
structured review at the suffix supplied by the plan. Branch on the packet's
\`CI_GREEN\` (true only when the EXACT reviewed SHA is on a remote branch with
every CI run completed and successful):

**\`CI_GREEN=true\`: the read-only packet reviewer.** \`codex review --base\`
re-runs the project's build and test suite inside its sandbox before it
reviews; on a large tier-D diff that alone consumed the 540s cap (observed
2026-09-03: three timeouts of four, zero findings returned). Fresh exact-SHA
CI evidence makes that execution redundant, so skip it deliberately:

\`\`\`bash
TMPERR=$(mktemp /tmp/codex-review-XXXXXXXX)
_REPO_ROOT=$(git rev-parse --show-toplevel) || { echo "ERROR: not in a git repo" >&2; exit 1; }
cd "$_REPO_ROOT"
source ~/.claude/skills/gstack/bin/gstack-codex-probe 2>/dev/null || true
_CODEX_T0=$(date +%s)
_gstack_codex_timeout_wrapper 540 codex exec {CODEX_MODEL_EXEC_FLAGS} -C "$_REPO_ROOT" -s read-only --add-dir "$(dirname "{PACKET_PATH}")" -c 'model_reasoning_effort="{medium|high from REVIEWERS suffix}"' \${CODEX_WEB_SEARCH_FLAG} "You are the codex-structured reviewer for the gstack review governor, in READ-ONLY mode. CI_GREEN=true for the exact head SHA $(git rev-parse HEAD) (see the packet's CI evidence): do NOT run the build, the test suite, typecheck or any install; this is a SEMANTIC review of the diff only. Read the review packet at {PACKET_PATH} first, then read the diff at {DIFF_PATH} in ONE pass (cat the whole file once; never page it in chunks, paging a large diff is what runs past the cap), then open other worktree files only to answer a specific question, with read-only git. Do not re-derive the project. Findings already fixed and listed in the packet as resolved are not to be re-reported. Review for ways this code fails in production: SQL and data safety, race conditions, LLM trust boundary, enum completeness, security, reliability, data-migration ordering and rollback. Output one line per finding: [P1] or [P2] or [INFO] path:line — problem — fix — evidence: quoted line(s); a finding you cannot anchor to a quoted line is [INFO] at most; if nothing, exactly NO FINDINGS. End with ONE line: Recommendation: <action> because <one-line reason naming the most exploitable finding, or no exploitable finding>." < /dev/null 2>"$TMPERR"
_CODEX_RC=$?; echo "CODEX_RC=$_CODEX_RC CODEX_ELAPSED_S=$(( $(date +%s) - _CODEX_T0 ))"
\`\`\`

**\`CI_GREEN=false\` or \`unknown\`: the CLI diff review.** Nothing has
proven the tree green, so codex may run what it needs:

\`\`\`bash
TMPERR=$(mktemp /tmp/codex-review-XXXXXXXX)
_REPO_ROOT=$(git rev-parse --show-toplevel) || { echo "ERROR: not in a git repo" >&2; exit 1; }
cd "$_REPO_ROOT"
source ~/.claude/skills/gstack/bin/gstack-codex-probe 2>/dev/null || true
_CODEX_T0=$(date +%s)
_gstack_codex_timeout_wrapper 540 codex review --base <base> {CODEX_MODEL_REVIEW_FLAGS} -c 'model_reasoning_effort="{medium|high from REVIEWERS suffix}"' \${CODEX_WEB_SEARCH_FLAG} < /dev/null 2>"$TMPERR"
_CODEX_RC=$?; echo "CODEX_RC=$_CODEX_RC CODEX_ELAPSED_S=$(( $(date +%s) - _CODEX_T0 ))"
\`\`\`

Either way the cap stays 540s. The effort is \`medium\` for tiers A/B/C and
\`high\` for tier D. The model is the one \`gstack-codex-model\` resolved:
\`{CODEX_MODEL_EXEC_FLAGS}\` / \`{CODEX_MODEL_REVIEW_FLAGS}\` are empty on the
default route (the project's own Codex config then decides; no frontier
model is rendered here, so an unrouted tier never inherits a premium model)
and \`--model <slug>\` / \`-c model="<slug>" -c review_model="<slug>"\` on a routed one
(\`codex review\` rejects \`-m\`). No prompt argument is allowed with
\`--base\` (the read-only form takes the prompt because it uses
\`codex exec\`). Read stderr before cleanup; keep the printed
\`CODEX_ELAPSED_S\` for the gate row. Check for
execution success and valid severity tags or an explicit NO FINDINGS conclusion
first. Failure, refusal, empty output or missing markers → missing coverage and
error/timeout, never clean/PASS. For a completed response, \`[P1]\` markers:
found → \`GATE: FAIL\`, absent → \`GATE: PASS\`. FAIL →
AskUserQuestion with A) investigate and fix now (recommended), B) continue.
The [P1] gate semantics are unchanged.

After Codex returns, record its terminal result immediately:

\`\`\`bash
~/.claude/skills/gstack/bin/gstack-review-budget verdict "$RUN_ID" codex-structured <clean|issues_found|error|timeout> --cycle <n> [--critical N --informational N]
\`\`\`

After an \`error\` or \`timeout\`, the same cycle-scoped dispatch may retry this
planned slot ONCE; record the retry verdict too. A second failure stays
incomplete and can never be logged as clean.

A user request for "full review" permits ONE extra dispatch only:
\`gstack-review-budget dispatch "$RUN_ID" codex-structured --escalation user-request:full-review --cycle <n>\`.
This consumes the run's single escalation; no other escalation may dispatch
afterward. It does not change upstream outside-review requirements.

Persist both logs. The review row and gate row must carry the plan's literal
effort and \`effort_source:"routed"\`; the gate row also carries the resolved
model, the requested model, whether it was substituted and why, and the wall time,
so \`gstack-outcome-report\` can read a model change from the rows it already
aggregates; gate telemetry retains tokens (from the \`tokens used\` line in
stderr when present), \`fix_cycle\`, \`rerun_cause\`, and \`manifest_wtree\`:

\`\`\`bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"adversarial-review","run_id":"{RUN_ID}","cycle":{N},"timestamp":"TIMESTAMP","status":"STATUS","source":"codex-structured","tier":"{TIER}","gate":"GATE","model":"{CODEX_MODEL}","effort":"{PLAN_EFFORT}","effort_source":"routed","commit":"COMMIT"}'
~/.claude/skills/gstack/bin/gstack-gate-log '{"record_type":"gate","run_id":"{RUN_ID}","skill":"${ctx.skillName}","gate":"codex-structured","trigger":"review-plan","model":"{CODEX_MODEL}","model_requested":"{CODEX_MODEL_REQUESTED}","model_source":"{CODEX_MODEL_SOURCE}","model_substituted":{true|false},"model_substitution_reason":"{CODEX_MODEL_SUBSTITUTION_REASON}","effort":"{PLAN_EFFORT}","effort_source":"routed","elapsed_s":{CODEX_ELAPSED_S},"tokens":{"total":{N},"source":"codex-stderr"},"verdict":"{clean=pass|fail|timeout|error}","findings":{"p1":{N}},"fix_cycle":{N},"rerun_cause":{null|"delta-verification"|"scope-expansion:{triggers}"},"manifest_wtree":"{MANIFEST_WTREE}"}' 2>/dev/null || true
\`\`\`

Failures and timeouts are missing coverage, never a clean result. Remove
\`$TMPERR\` after reading it, then continue the upstream adversarial phase; the final
governor completion gate at Step ${ctx.skillName === 'ship' ? '11.5' : '5.8'} uses \`INCOMPLETE=\` means STOP with a blocker report.`;

}
