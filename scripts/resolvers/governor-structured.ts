/** Governor supplemental structured reviewer. */
import { STRUCTURED_INSTRUCTIONS, STRUCTURED_CONTRACT } from '../../lib/review-governor-packet';
import type { TemplateContext } from './types';
import { generateGovernorPlanBody, governorDispatchAccounting, governorRedTeamAccounting, governorSpecialistTelemetry, governorAdversarialTelemetry, governorNativeRegistration, governorNativeVerdict } from './governor-accounting';
import { outsideVoicePreflight, outsideVoiceGuard } from './outside-voice';
import { CODEX_WEB_SEARCH_FLAG, CODEX_SANDBOX_REF, CODEX_MODEL_CONFIG_FLAG, codexSelect } from './constants';
import { freeTextFileBash, freeTextFileUse, FREE_TEXT_WRITE_RULE } from './free-text-file';

export function generateGovernorStructured(ctx: TemplateContext): string {
  // D4: external /review keeps upstream's inline section policy. Only the
  // fork's extra slot lives in a reference asset, under the same skill root.
  if (ctx.skillName === 'review' && ctx.host !== 'claude') {
    return `### Governor codex-structured slot

Run this additional slot only when codex-structured is planned and not in REUSED. In /ship, use every codex-structured PACKET emitted by the saved plan build, carrying its file, out and read fields. Reserve each packet through ship-budget before invoking it; dispatch the governor gate once for the logical reviewer, then record its aggregate verdict after every shard and collect settle. A successful NON_CODE_DELTA carry-forward also satisfies it; preserve its audit record and do not dispatch again.
**STOP.** Before dispatch, Read \`governor-structured.md\` beside this SKILL.md. Apply its model/effort, preflight, verdict and telemetry steps. Missing or unreadable asset means INCOMPLETE: stop with a blocker; never credit clean coverage.`;
  }
  return generateGovernorStructuredBody(ctx);
}

export function generateGovernorStructuredBody(ctx: TemplateContext): string {
  const body = governorStructuredBody(ctx);
  if (ctx.skillName !== 'review' || ctx.host === 'claude' || ctx.host === 'codex') return body;
  return `# Governor accounting and structured slot

Follow each section only at its named parent step. Reading this file at Step 4.5 does not dispatch Step 4.8.

## Manifest (Step 4.5)
${generateGovernorPlanBody(ctx)}
## Dispatch accounting (Step 4.5)
${governorDispatchAccounting(ctx)}
## Red Team accounting (Review Army)
${governorRedTeamAccounting(ctx)}
## Specialist telemetry (Step 4.6)
${governorSpecialistTelemetry(ctx)}
## Native accounting (Step 4.8)
${governorNativeRegistration(ctx)}
${governorNativeVerdict(ctx)}
## Adversarial telemetry (Step 4.8)
${governorAdversarialTelemetry(ctx)}
## Structured slot (Step 4.8)
${body}`;
}

function governorStructuredBody(ctx: TemplateContext): string {
  const codexProvider = { ...ctx, host: 'claude' as const }; // Provider selection only; guard reads the actual harness from env.

  // dohma fork: the governor routes adversarial review only where the outside
  // voice is Codex; the codex host keeps upstream's step (Claude Code voice).

  return `### Governor codex-structured slot


Run this additional slot only when codex-structured is planned and not in REUSED. In /ship, use every codex-structured PACKET emitted by the saved plan build, carrying its file, out and read fields. Reserve each packet through ship-budget before invoking it; dispatch the governor gate once for the logical reviewer, then record its aggregate verdict after every shard and collect settle. A successful NON_CODE_DELTA carry-forward also satisfies it; preserve its audit record and do not dispatch again.
It does not replace the required native pass, upstream outside challenge, or
structured P1 decision. Record all of them separately.

Before the structured review, run the shared Codex preflight. Nested Codex
sessions must refuse another Codex spawn and retain missing coverage:

${outsideVoicePreflight(codexProvider, { disabledBehavior: 'codex-only' })}

Carry the plan's non-negative integer \`CYCLE\` into each later block; the budget bin validates it.

Only when \`CODEX_MODE: ready\` (or \`unverified\`), run the budget dispatch:

\`\`\`bash
~/.claude/skills/gstack/bin/gstack-review-budget dispatch "$RUN_ID" codex-structured --cycle "\${CYCLE:?carry the plan cycle}"
\`\`\`

On exit 2, print the blocker and do not run Codex. Otherwise bind the plan's
model/source without sending content. Empty selects the configured native default.
Role-ready checks it within 540s; unavailable is incomplete.
Routing preserves budgets, retries and completion. A timeout stays incomplete:
it never triggers an automatic second-model review.

\`\`\`bash
~/.claude/skills/gstack/bin/gstack-codex-model resolve --model "{CODEX_MODEL}" --effort "{medium|high from REVIEWERS suffix}" --source "{CODEX_MODEL_SOURCE}" --selection-only
\`\`\`

Carry its printed model, requested model, source, substitution flag and reason
as literals into later blocks and logs; shell state does not cross Bash calls. Print
\`Codex model: {CODEX_MODEL} ({CODEX_MODEL_SOURCE}; requested {CODEX_MODEL_REQUESTED})\`
and any substitution reason. Run one structured review at the plan's suffix. Always
run the read-only packet reviewer: \`codex review\` accepts no prompt with
\`--base\`, so its answer format cannot be required. The prompt states the CI
status instead of branching on it.


Create a private prompt before invoking the packet reviewer:

\`\`\`bash
${freeTextFileBash([{ variable: 'STRUCTURED_PROMPT_FILE', stem: 'structured-review' }])}
\`\`\`

The rendered stdin brief requires: ${STRUCTURED_INSTRUCTIONS} ${STRUCTURED_CONTRACT}

Copy the rendered {PACKET_PATH} byte-for-byte into the private STRUCTURED_PROMPT_FILE, including its inline diff, governor context and REVIEWED_TREE contract. Do not add a wrapper. The packet carries CI evidence, the exact head SHA and resolved findings. Record that exact stdin prompt with \`gstack-review-dispatch sent --ledger "{BRIEF_LEDGER}" --role codex-structured --sent "<prompt-file-name>"\` before invoking Codex. Save the completed response verbatim to {PACKET_OUT}, collect it through the same ledger, then mark the manifest reader collected before resuming the pass program. Do not mark a failure complete.

\`\`\`bash
umask 077
TMPERR=$(mktemp "\${TMPDIR:-/tmp}/codex-review-XXXXXXXX") || exit 1
TMPANSWER="$TMPERR.text"; TMPEVENTS="$TMPERR.events"
${outsideVoiceGuard(codexProvider)}
_REPO_ROOT=$(git rev-parse --show-toplevel) || { echo "ERROR: not in a git repo" >&2; exit 1; }
cd "$_REPO_ROOT"
_CODEX_T0=$(date +%s)
${codexSelect('exec', undefined, { budgetSecs: 540, modelArg: '"{CODEX_MODEL}"' })}
export GSTACK_CODEX_GATE_DEFAULT="{PLAN_EFFORT}" GSTACK_CODEX_EFFORT_RECEIPT="$TMPERR.effort"
"$_CODEX_PROBE" show-first-use-notice
_CODEX_RC=0
${freeTextFileUse([{ variable: 'STRUCTURED_PROMPT_FILE', placeholder: '<prompt-file-name>' }], 'codex exec - < saved-prompt-file')}
"$_CODEX_PROBE" run-with-timeout --effort high 540 codex exec - ${CODEX_MODEL_CONFIG_FLAG} -C "$_REPO_ROOT" -s "${CODEX_SANDBOX_REF}" --add-dir "$(dirname "{PACKET_PATH}")" ${CODEX_WEB_SEARCH_FLAG} -c 'skills.include_instructions=false' --json -o "$TMPANSWER" <"$STRUCTURED_PROMPT_FILE" >"$TMPEVENTS" 2>"$TMPERR" || _CODEX_RC=$?
cat "$TMPERR.effort" 2>/dev/null || true
echo "CODEX_RC=$_CODEX_RC CODEX_ELAPSED_S=$(( $(date +%s) - _CODEX_T0 ))"
cat "$TMPANSWER"; cat "$TMPERR" >&2
_CODEX_GATE_RC=0
bun --no-env-file --config=/dev/null ~/.claude/skills/gstack/lib/outside-review-result.ts --label 'Governor codex-structured' --exit "$_CODEX_RC" --stderr "$TMPERR" --events "$TMPEVENTS" structured "$TMPANSWER" || _CODEX_GATE_RC=$?
if [ "$_CODEX_GATE_RC" -eq 0 ] || [ "$_CODEX_GATE_RC" -eq 3 ]; then cp "$TMPANSWER" "{PACKET_OUT}" || exit 1; fi
\`\`\`

The cap stays 540s, including readiness. The gate default is
\`medium\` for tiers A/B/C and \`high\` for tier D, carried through
\`GSTACK_CODEX_GATE_DEFAULT\`; upstream env/config remain first. Binding-only
routing preserves the configured native default on an unrouted tier, so it
never inherits the catalog's premium default. Role-ready receives
that resolved model as its explicit request. The read-only form reads its
private prompt on stdin through \`codex exec -\`; never put free text in a shell
command. Read stderr before cleanup; keep the printed
\`CODEX_ELAPSED_S\` for the gate row. Check for
execution success and valid severity tags or an explicit NO FINDINGS conclusion
first. The shared classifier's exit 0 is completed clean; 3 is completed
findings; 4 is unverified; other nonzero is unavailable. Only completed 0/3
may satisfy the slot. P0/P1 findings block. Failure, refusal, empty output or missing markers → missing coverage and
error/timeout, never clean/PASS. For a completed response, \`[P0]\`/\`[P1]\` markers:
found → \`GATE: FAIL\`, absent → \`GATE: PASS\`. FAIL →
AskUserQuestion with A) investigate and fix now (recommended), B) continue.

After Codex returns, record its terminal result immediately:

\`\`\`bash
~/.claude/skills/gstack/bin/gstack-review-budget verdict "$RUN_ID" codex-structured <clean|issues_found|error|timeout> --cycle "\${CYCLE:?carry the plan cycle}" [--critical N --informational N]
\`\`\`

After an \`error\` or \`timeout\`, the same cycle-scoped dispatch may retry this
planned slot ONCE; record the retry verdict too. A second failure stays
incomplete and can never be logged as clean.

A user request for "full review" permits ONE extra dispatch only:
\`gstack-review-budget dispatch "$RUN_ID" codex-structured --escalation user-request:full-review --cycle "\${CYCLE:?carry the plan cycle}"\`.
This consumes the run's single escalation; no other escalation may dispatch
afterward. It does not change upstream outside-review requirements.

${governorTelemetry(ctx)}`;

}

function governorTelemetry(ctx: TemplateContext): string {
  return `Persist both logs. Read \`$TMPERR.effort\` and carry its effective effort, source and reason into both rows; the gate row also carries the resolved
model, the requested model, whether it was substituted and why, and the wall time.
Gate telemetry retains tokens (from the \`tokens used\` line in
stderr when present), \`fix_cycle\`, \`rerun_cause\`, and \`manifest_wtree\`:

\`\`\`bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"adversarial-review","timestamp":"TIMESTAMP","run_id":"{RUN_ID}","cycle":{N},"status":"STATUS","source":"codex-structured","tier":"{TIER}","gate":"GATE","model":"{CODEX_MODEL}","effort":"{EFFECTIVE_EFFORT}","effort_source":"{EFFECTIVE_EFFORT_SOURCE}","effort_reason":"{EFFECTIVE_EFFORT_REASON}","commit":"COMMIT"}'
~/.claude/skills/gstack/bin/gstack-gate-log '{"record_type":"gate","run_id":"{RUN_ID}","skill":"${ctx.skillName}","gate":"codex-structured","trigger":"review-plan","model":"{CODEX_MODEL}","model_requested":"{CODEX_MODEL_REQUESTED}","model_source":"{CODEX_MODEL_SOURCE}","model_routed":true,"model_substituted":{true|false},"model_substitution_reason":"{CODEX_MODEL_SUBSTITUTION_REASON}","effort":"{EFFECTIVE_EFFORT}","effort_source":"{EFFECTIVE_EFFORT_SOURCE}","effort_reason":"{EFFECTIVE_EFFORT_REASON}","elapsed_s":{CODEX_ELAPSED_S},"tokens":{"total":{N},"source":"codex-stderr"},"verdict":"{clean=pass|fail|timeout|error}","findings":{"p1":{N}},"fix_cycle":{N},"rerun_cause":{null|"delta-verification"|"scope-expansion:{triggers}"},"manifest_wtree":"{MANIFEST_WTREE}"}' 2>/dev/null || true
\`\`\`

Failures and timeouts are missing coverage, never a clean result. Remove
\`$TMPERR\`, \`$TMPANSWER\`, \`$TMPEVENTS\`, \`$TMPERR.effort\` and your private prompt after recording both logs, then continue the upstream adversarial phase; the final
governor completion gate at Step ${ctx.skillName === 'ship' ? '11.5' : '5.8'} uses \`INCOMPLETE=\` means STOP with a blocker report.`;
}
