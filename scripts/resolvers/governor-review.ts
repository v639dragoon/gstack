import type { TemplateContext } from './types';
import { generateGovernorPlanBody, governorDispatchAccounting, governorRedTeamAccounting, governorSpecialistTelemetry, governorNativeRegistration, governorNativeVerdict, governorAdversarialTelemetry } from './governor-accounting';
import { generateGovernorStructuredBody } from './governor-structured';

export function generateGovernorReview(ctx: TemplateContext): string {
  return `# Governor review accounting

Read this before the upstream review sections. Apply each instruction at its named step; reading this file does not launch a later step.
Every general-purpose Agent call in the review, including the batched specialist, Red Team, targeted reader and native adversarial reader, sets \`subagent_type: "general-purpose"\` and \`model: "sonnet"\`. The upstream effort= mapping still applies.

${generateGovernorPlanBody(ctx)}

## Specialist dispatch (Step ${ctx.skillName === 'ship' ? '9.1' : '4.5'})
Use the upstream plan, with governor floors and D3 filters applied before building the dispatch manifest. On /ship, every gstack-review-dispatch pass carries \`-- --run-id "$RUN_ID" --cycle "$CYCLE"\` plus the saved plan flags. One batched specialist reads the union of upstream and governor-tier checklists; its governor_gates lists every floor it must account. Before launching any logical reader, register each upstream-only governor_gate, then run \`gstack-review-budget dispatch "$RUN_ID" <governor_gate> --cycle "$CYCLE"\` and dispatch each governor_gates entry. Every allowed Agent is accounted before launch. After collect, record every gate's verdict and gate-log row. Missing or invalid output remains incomplete. Retain state-machines validation and pregate accounting.
${governorDispatchAccounting(ctx)}

## Red Team dispatch
The planner's DISPATCH: red-team runs at tier D even without upstream activation. Upstream selection and ordering win; the Red Team waits for the batched specialist's collected findings. A planned red-team runs even without upstream activation and does not consume the single routed escalation.
${governorRedTeamAccounting(ctx)}

## Native adversarial dispatch
${governorNativeRegistration(ctx)}
${governorNativeVerdict(ctx)}
${governorAdversarialTelemetry(ctx)}

## D3 gates at upstream headings
Absent policy keys retain upstream behavior. At Select specialists, \`UPSTREAM_SPECIALISTS=false\` disables only upstream additions: dispatch only governor-planned checklists, never drop governor floors. At Red Team dispatch, \`RED_TEAM_LOC_TRIGGER=false\` disables LOC-only activation. At the native adversarial heading, \`ADVERSARIAL_CLAUDE=false\` disables only the upstream slot; at the outside challenge heading, \`CODEX_CHALLENGE=false\` disables only the optional challenge; at structured review, \`UPSTREAM_STRUCTURED=false\` disables only that upstream pass. Required governor structured review remains. At Exploratory QA, \`QA_SMOKE=false\` skips exploratory smoke/setup/guard only; required plan probes and their preflight still run and missing coverage blocks. When \`AUTOFIX_INFORMATIONAL=false\`, ADVISORY findings are NEVER fixed. Advisory test stubs are listed without ASK or AUTO-FIX. List at most \`MAX_ADVISORIES\` under ## Advisories (not fixed). The policy's BLOCKING/ADVISORY metadata never overrides upstream AUTO-FIX/ASK except the explicit advisory policy.
A fix touching auth/RLS/billing/migrations/secrets requires full whole-branch re-review; preserve the upstream pass cap and stop if exhausted. Reuse obeys recorded tree/base/policy/cycle and never credits failed or missing coverage.

## Fix and resolution accounting
Apply each fix at every listed instance (\`also at\` / \`instances\`) and at any other instance of the same pattern in the diff. Output one line per fix:
Record the finding's bug_class and \`resolve\`; an accepted or skipped \`resolve\` takes \`--reason "<wrong|intentional|minor|deferred>: <why>"\`.
A Fix answer covers every instance, as in item 2. Governor classification is telemetry; upstream AUTO-FIX/ASK governs.

## Structured slot
${generateGovernorStructuredBody(ctx)}

## Final completeness
Run \`gstack-review-budget complete "$RUN_ID" --cycle <n> --require-native\` with the required audit/final flags. INCOMPLETE= means STOP with a blocker report. The strict slot does not substitute for native completion.

## Specialist telemetry
${governorSpecialistTelemetry(ctx)}
`;
}
