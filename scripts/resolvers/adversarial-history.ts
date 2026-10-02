/** Persist upstream attempt receipts and fork per-gate telemetry. */
import type { TemplateContext } from './types';
import { outsideVoiceFor } from './outside-voice';

export function adversarialPersistResult(ctx: TemplateContext, isShip: boolean): string {
  return `### Persist the review result

Wait until every started task has finished or is confirmed stopped. Then save one
record per source, phase and attempt, before the parent applies queued fixes.
A stopped task without a completed response still has incomplete coverage.

Use the template once per attempt. If it started, \`--finish PASS_START\` consumes
its original token. If it never started because it was unavailable, disabled or
size-gated, omit \`--finish PASS_START\` and set completed/converged false.
Do not create or borrow a token just to save a result.
\`\`\`bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"adversarial-review","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","run_id":"{RUN_ID}","cycle":{N},"status":"STATUS","source":"SOURCE","host":"${ctx.host}","outside_provider":"${outsideVoiceFor(ctx).id}","outside_status":"OUTSIDE_STATUS","phase":"PHASE","tier":"always","gate":"GATE","effort":"high","effort_source":"default","commit":"'"$(git rev-parse --short HEAD)"'","completed":COMPLETED,"converged":CONVERGED}' --finish PASS_START
\`\`\`
PASS_START belongs to that attempt, not the parent's REVIEW_START. Each token is consumed once.
Fill fields from this attempt, not the parent's ${isShip ? 'Step 9.4' : 'Step 5.8'} result:
- COMPLETED is true only with a completed response. Timeout, failure, refusal or
  missing coverage means false. CONVERGED also requires that the attempt made no edits.
  A fixing pass cannot certify the fixed tree without a fresh full pass.
- PHASE is "adversarial" or "structured". SOURCE is the actual outside provider or
  native in-host source. Preserve its actual OUTSIDE_STATUS; native completion
  never credits outside coverage.
- STATUS is "clean" for a completed pass without findings, "issues_found" for
  a completed pass with findings, or "unavailable" for an incomplete pass.
- GATE is "informational" for adversarial passes. For structured review, use
  "pass" or "fail" from its completed result, "skipped" when size-gated, or
  "informational" with completed:false when coverage is missing.
The \`effort\` fields describe the CODEX passes — both stay at high; only plan and doc voices route to medium.

**Persist per-gate telemetry (Phase 0):** one gate record per pass that ran,
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

---`;
}

