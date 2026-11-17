<!-- AUTO-GENERATED from governor.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
# Governor review accounting

Read this before the upstream review sections. Apply each instruction at its named step; reading this file does not launch a later step.
Every general-purpose Agent call in the review, including the batched specialist, Red Team, targeted reader and native adversarial reader, sets `subagent_type: "general-purpose"` and `model: "sonnet"`. The upstream effort= mapping still applies. The compact program receives an explicit Sonnet or Haiku model ID in input.models for every general-purpose reader; an absent or different model stops before launch.

### Governor manifest, plan, packet

Reuse RUN_ID from the governed audit accounting. After Steps 7–8 finish their writes, refresh
that run's manifest and plan, preserving its audit verdicts and attempt counts.
Then build the shared packet from the final reviewed content:

```bash
~/.claude/skills/gstack/bin/gstack-diff-manifest <base> "$RUN_ID"
~/.claude/skills/gstack/bin/gstack-review-budget plan "$MANIFEST_PATH" --cycle 0
~/.claude/skills/gstack/bin/gstack-review-budget resume "$RUN_ID"
# All later gstack-review-plan/review-dispatch pass calls carry --run-id "$RUN_ID" --cycle "$CYCLE".
```

Carry these printed values as literals for the rest of the invocation:
`RUN_ID`, `CYCLE`, `TIER`, `SLICE_KIND`, `REVIEWERS`, `PASSES`, `REPAIR_CYCLES_MAX`,
`COVERAGE_AUDIT`, `PLAN_COMPLETION`, `DOC_RELEASE`,
`CODEX_DOC_VOICE`, `UPSTREAM_SPECIALISTS`, `UPSTREAM_STRUCTURED`, `ADVERSARIAL_CLAUDE`,
`CODEX_CHALLENGE`, `RED_TEAM_LOC_TRIGGER`, `GREPTILE`, `COVERAGE_RATING`,
`AUDIT_REUSE`, `NON_CODE_DELTA`, `QA_SMOKE`, `DETERMINISTIC_GATES`, `FULL_LANES_REQUIRED`, `BUILD_GATE`, `CI_BACKSTOP`, `PACKET_PATH`, `PACKET_PATHS`, `CI_GREEN`, `REUSED` and `RERUN`.

`PASSES` is the whole-workflow accounting for this run: every AI pass it may
dispatch (reviewer slots, coverage audit, plan completion, doc release, doc
voice) with its model and effort; Upstream-required passes join its accounting through register-upstream; a pass absent from either record never runs. `resume`
carries forward the terminal verdicts of a PRIOR run whose content
fingerprint, base, policy, tier, reviewer list and slice kind all equal this
plan's (a matching commit with a dirty tree never qualifies): print
`Reused from {RESUME_SOURCE}: {REUSED}` when non-empty, do not dispatch a gate
listed in `REUSED` (its dispatch would be refused as duplicate-slot), and
dispatch only `RERUN`. Only clean and issues_found verdicts are reusable;
error, timeout and missing verdicts are never carried.
Also retain `MANIFEST_WTREE`, `DOC_FP`, `OUTCOME_ID`,
`OUTCOME_MISSING`, `MAX_ADVISORIES`, `AUTOFIX_INFORMATIONAL`,
`BLOCKING_SEVERITIES`, and `BLOCKING_CATEGORIES`.

If `OUTCOME_MISSING=true`, print exactly:

`Outcome metadata missing — treating this slice as FINAL (full release review at tier {TIER}). Set it with: ~/.claude/skills/gstack/bin/gstack-outcome set --id <id> --slice <n> [--final] [--flag-flip]`.



## Specialist dispatch (Step 9.1)
Use the upstream plan, with governor floors and D3 filters applied before building the dispatch manifest. On /ship, every gstack-review-dispatch pass carries `-- --run-id "$RUN_ID" --cycle "$CYCLE"` plus the saved plan flags. One batched specialist reads the union of upstream and governor-tier checklists; its governor_gates lists every floor it must account. The compact sent/collect callbacks automatically reserve and settle every metadata-linked gate. Do not duplicate their successful verdicts. The following manual commands apply to readers launched outside that program and to terminal errors without collection. Before launching any logical reader, register each upstream-only governor_gate, then run `gstack-review-budget dispatch "$RUN_ID" <governor_gate> --cycle "$CYCLE"` and dispatch each governor_gates entry. Every allowed Agent is accounted before launch. After collect, record every gate's verdict and gate-log row. Missing or invalid output remains incomplete. Retain state-machines validation and pregate accounting.
Union upstream-selected specialists with planned `specialist:*` slots, retaining
source labels. The small-diff bypass skips upstream specialists only; execute any
governor-planned checklists through the upstream batch on /ship, then the parent Exploratory QA handoff.
Never dispatch the same specialist twice: one result may satisfy both sources
only when both dispatch records name the same frozen tree/SHA.
Register upstream-only selected specialists with
`gstack-review-budget register-upstream "$RUN_ID" upstream-specialist:<name> --cycle <n>`;
then run `gstack-review-budget dispatch "$RUN_ID" <gate> --cycle <n>`
before each Agent call. Every allowed Agent is accounted before launch. Every specialist
Agent sets `model: "sonnet"`. Each prompt uses its rendered upstream brief and supplied diff file, with governor context. On /review, PACKET_PATHS names the rendered strict brief. CI_GREEN=true
means do not repeat builds/tests. Record each terminal verdict with `gstack-review-budget verdict "$RUN_ID" <gate> <clean|issues_found|error|timeout> --cycle <n>` and a best-effort
`gstack-gate-log` row with model sonnet, effort agent-default, effort_source routed,
fix_cycle, rerun_cause and manifest_wtree. Errors/timeouts retain upstream
settlement and missing-coverage rules; the budget allows one corrected attempt.
Routed codex-structured remains an additional Step 11 slot.




## Red Team dispatch
The planner's DISPATCH: red-team runs at tier D even without upstream activation. Upstream selection and ordering win; the Red Team waits for the batched specialist's collected findings. A planned red-team runs even without upstream activation and does not consume the single routed escalation.
Register upstream activation as `upstream-specialist:red-team` unless red-team
already occupies a planned slot. Dispatch the chosen gate through review-budget
before the Sonnet Agent call; record its verdict and gate row afterward. A planned
red-team runs even without upstream activation. Upstream-required activation is
accounted separately and does not consume the single routed escalation.



## Native adversarial dispatch
Register and dispatch the required native attempt before its Agent call:
`gstack-review-budget register-upstream "$RUN_ID" native-adversarial --cycle <n>`,
then `gstack-review-budget dispatch "$RUN_ID" native-adversarial --cycle <n>`.
Registration records this upstream-required reviewer independently of routed slots.
Every native call sets `subagent_type: "general-purpose"` and `model: "sonnet"`.


Record `gstack-review-budget verdict "$RUN_ID" native-adversarial <clean|issues_found|error|timeout> --cycle <n>`
and a best-effort `gstack-gate-log` row with gate native-adversarial, model sonnet,
effort agent-default, effort_source routed, fix_cycle, rerun_cause and manifest_wtree.
Keep its original PASS_START review-log record; Step 11.5 binds that native receipt.
The upstream one-corrected-attempt recovery applies; terminal failure never certifies completion.


**Persist per-gate telemetry:** one gate record per pass that ran,
substituting carried literals (RUN_ID/MANIFEST_WTREE from the Step 9.1
manifest; if none this run, run `gstack-diff-manifest <base>` now).
`tokens.total` for a codex pass comes from the `tokens used` line in its
stderr (read before cleanup); omit `tokens` when unavailable.

```bash
~/.claude/skills/gstack/bin/gstack-gate-log '{"record_type":"gate","run_id":"{RUN_ID}","skill":"{ship|review}","gate":"adversarial-claude","trigger":"always-on","started_at":"{dispatch ts}","ended_at":"{completion ts}","model":"claude-subagent","effort":null,"verdict":"{clean|issues_found|error}","fix_cycle":{N},"rerun_cause":{null|"fix-loop"},"manifest_wtree":"{MANIFEST_WTREE}"}' 2>/dev/null || true
~/.claude/skills/gstack/bin/gstack-gate-log '{"record_type":"gate","run_id":"{RUN_ID}","skill":"{ship|review}","gate":"codex-adversarial","trigger":"CODEX_MODE=ready","started_at":"{dispatch ts}","ended_at":"{completion ts}","model":"codex","effort":"{EFFECTIVE_EFFORT}","effort_source":"{EFFECTIVE_EFFORT_SOURCE}","effort_reason":"{EFFECTIVE_EFFORT_REASON}","tokens":{"total":{N},"source":"codex-stderr"},"verdict":"{clean|issues_found|timeout|error}","fix_cycle":{N},"rerun_cause":{null|"fix-loop"},"manifest_wtree":"{MANIFEST_WTREE}"}' 2>/dev/null || true
~/.claude/skills/gstack/bin/gstack-gate-log '{"record_type":"gate","run_id":"{RUN_ID}","skill":"{ship|review}","gate":"codex-structured","trigger":"DIFF_TOTAL={N}>=200","started_at":"{dispatch ts}","ended_at":"{completion ts}","model":"codex","effort":"{EFFECTIVE_EFFORT}","effort_source":"{EFFECTIVE_EFFORT_SOURCE}","effort_reason":"{EFFECTIVE_EFFORT_REASON}","tokens":{"total":{N},"source":"codex-stderr"},"verdict":"{clean|issues_found|timeout|error}","findings":{"p1":{N}},"fix_cycle":{N},"rerun_cause":{null|"fix-loop"|"p1-gate"},"manifest_wtree":"{MANIFEST_WTREE}"}' 2>/dev/null || true
```

Emit records only for passes that dispatched — absence is the skip signal.
Telemetry is best-effort: failures never block.



## D3 gates at upstream headings
Absent policy keys retain upstream behavior. At Select specialists, `UPSTREAM_SPECIALISTS=false` disables only upstream additions: dispatch only governor-planned checklists, never drop governor floors. At Red Team dispatch, `RED_TEAM_LOC_TRIGGER=false` disables LOC-only activation. At the native adversarial heading, `ADVERSARIAL_CLAUDE=false` disables only the upstream slot; at the outside challenge heading, `CODEX_CHALLENGE=false` disables only the optional challenge; at structured review, `UPSTREAM_STRUCTURED=false` disables only that upstream pass. Required governor structured review remains. At Exploratory QA, `QA_SMOKE=false` skips exploratory smoke/setup/guard only; required plan probes and their preflight still run and missing coverage blocks. When `AUTOFIX_INFORMATIONAL=false`, ADVISORY findings are NEVER fixed. Advisory test stubs are listed without ASK or AUTO-FIX. List at most `MAX_ADVISORIES` under ## Advisories (not fixed). The policy's BLOCKING/ADVISORY metadata never overrides upstream AUTO-FIX/ASK except the explicit advisory policy.
A fix touching auth/RLS/billing/migrations/secrets requires full whole-branch re-review; preserve the upstream pass cap and stop if exhausted. Reuse obeys recorded tree/base/policy/cycle and never credits failed or missing coverage.

## Fix and resolution accounting
Track the fix-cycle index: cycles are 0-based; a later cycle carries `"fix_cycle":{cycle}` and `"rerun_cause":"fix-loop"`. Telemetry only: it never alters the loop.
Add `"run_id":"{RUN_ID}","cycle":{N}` after the upstream review-log record's pinned skill,timestamp prefix.
For each fixing cycle run `gstack-review-budget rerun-check "$RUN_ID" --cycle <n>`. Governor REPAIR_CYCLES_MAX may stop earlier; only the risky-surface floor below overrides upstream selection. On exit 3 persist converged:false and recurring findings before stopping.
When NON_CODE_DELTA=true after fixes, only TEST_ONLY=true or DOC_ONLY=true with FULL_RERUN=false permits `gstack-review-budget carry-forward "$RUN_ID" --cycle <n>` and `gstack-review-log --carry-forward "$RUN_ID"`. Require success, verify the delta and refresh Local lanes only; retain stale Full receipts and original results. Save its tree/audit id, finish the original REVIEW_START only with required checks passing, and reuse carried verdicts at the pending steps. Other edits follow upstream repeat selection.
Apply each fix at every listed instance (`also at` / `instances`) and at any other instance of the same pattern in the diff. Output one line per fix:
Record the finding's bug_class and `resolve`; an accepted or skipped `resolve` takes `--reason "<wrong|intentional|minor|deferred>: <why>"`.
A Fix answer covers every instance, as in item 2. Governor classification is telemetry; upstream AUTO-FIX/ASK governs.

## Structured slot
### Governor codex-structured slot


Run this additional slot only when codex-structured is planned and not in REUSED. A successful NON_CODE_DELTA carry-forward also satisfies it; preserve its audit record and do not dispatch again.
When (and only when) this slot is required under the conditions above:

> **STOP.** Before running the codex-structured slot, only when it is planned, not in REUSED and not satisfied by a NON_CODE_DELTA carry-forward, Read `~/.claude/skills/gstack/ship/sections/governor-structured-slot.md` and execute it
> in full. Do not work from memory — that section is the source of truth for this step.

## Final completeness
Run `gstack-review-budget complete "$RUN_ID" --cycle <n> --require-native` with the required audit/final flags. INCOMPLETE= means STOP with a blocker report. The strict slot does not substitute for native completion.

## Specialist telemetry
**Persist per-gate telemetry:** for EACH dispatched specialist (and
Red Team, either path), append one gate record, substituting {placeholder}s
with carried literals:

```bash
~/.claude/skills/gstack/bin/gstack-gate-log '{"record_type":"gate","run_id":"{RUN_ID}","skill":"ship","gate":"specialist:{name}","trigger":"{always-on|SCOPE_AUTH=true|DIFF_LINES={N}>200|user-flag:--{name}}","started_at":"{batch launch ts}","ended_at":"{completion or merge ts}","model":"claude-subagent","effort":null,"tokens":{"total":{N|null},"source":{"task-notification"|null}},"verdict":"{clean|issues_found|error}","findings":{"critical":{N},"informational":{N}},"fix_cycle":{N 0-based},"rerun_cause":{null|"fix-loop"},"manifest_wtree":"{MANIFEST_WTREE}"}' 2>/dev/null || true
```

Telemetry is best-effort: a failed gate-log call never blocks or changes the
review, and the aggregate `specialists` object still goes into reviews.jsonl
unchanged.

