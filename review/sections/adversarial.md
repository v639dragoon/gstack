<!-- AUTO-GENERATED from adversarial.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Step 5.7: Adversarial review — governor routed

Print: `Adversarial: routed to codex-structured per tier {TIER}`.
Do not run the Claude adversarial subagent or a free-form `codex exec`
challenge. Semantic adversarial review exists only when
`codex-structured@medium` or `codex-structured@high` is in `REVIEWERS`.

Before the structured review, run the shared Codex preflight. Nested Codex
sessions must refuse another Codex spawn unless the explicit override is set:

```bash
# Codex preflight: one block (functions sourced here don't persist to later blocks).
_TEL=$(~/.claude/skills/gstack/bin/gstack-config get telemetry 2>/dev/null || echo off)
_CODEX_CFG=$(~/.claude/skills/gstack/bin/gstack-config get codex_reviews 2>/dev/null || echo enabled)
source ~/.claude/skills/gstack/bin/gstack-codex-probe 2>/dev/null || true
if [ "$_CODEX_CFG" = "disabled" ]; then
  _CODEX_MODE="disabled"
# Running-under-Codex presence probe (#2519): a live Codex session exports
# CODEX_THREAD_ID / CODEX_SANDBOX into every shell it spawns (verified
# against a live `codex exec 'env | grep -i codex'` capture, codex 0.147.0).
# Nested codex spawns from inside a Codex host multiply token burn
# (observed: one /review = 15M tokens). GSTACK_FORCE_CODEX_REVIEW=1 forces
# the nested passes anyway.
elif [ "${GSTACK_FORCE_CODEX_REVIEW:-0}" != "1" ] && { [ -n "${CODEX_THREAD_ID:-}" ] || [ -n "${CODEX_SANDBOX:-}" ]; }; then
  _CODEX_MODE="under_codex"
elif ! command -v codex >/dev/null 2>&1; then
  _CODEX_MODE="not_installed"; _gstack_codex_log_event "codex_cli_missing" 2>/dev/null || true
elif ! _gstack_codex_auth_probe >/dev/null 2>&1; then
  _CODEX_MODE="not_authed"; _gstack_codex_log_event "codex_auth_failed" 2>/dev/null || true
else
  # Capture the probe's code: 2 means the CLI cannot execute at all, which is a
  # different problem (and a different fix) from a model the account can't use.
  _gstack_codex_model_probe; _CODEX_MP=$?
  if [ "$_CODEX_MP" -eq 2 ]; then
    _CODEX_MODE="broken_install"
  elif [ "$_CODEX_MP" -ne 0 ]; then
    _CODEX_MODE="model_unusable"
  else
    _CODEX_MODE="ready"; _gstack_codex_version_check 2>/dev/null || true
  fi
fi
echo "CODEX_MODE: $_CODEX_MODE"
```

Branch on the echoed `CODEX_MODE`:
- **`disabled`** — the user turned Codex reviews off (`codex_reviews=disabled`). Skip the Codex passes only; the Claude adversarial subagent below STILL runs (it is free and fast). Print: "Codex passes skipped (codex_reviews disabled) — running Claude adversarial only."
- **`not_installed`** — Codex CLI absent. Print: "Codex not installed — falling back to a Claude subagent (fresh context, but the SAME model family — not an outside model). Install Codex for an actual outside-model read: `npm install -g @openai/codex`." Fall back to the Claude subagent path.
- **`under_codex`** — this session is already running INSIDE a Codex host, so spawning codex again is the same model reviewing itself at multiplied token cost (#2519). Print exactly one line: "[running under Codex — nested codex passes skipped; set GSTACK_FORCE_CODEX_REVIEW=1 to force]" and skip the codex invocations below; run the section's free in-host pass instead if it defines one.
- **`not_authed`** — installed but no credentials. Print: "Codex installed but not authenticated — falling back to a Claude subagent (same model family, not an outside model). Run `codex login` or set `$CODEX_API_KEY`." Fall back to the Claude subagent path.
- **`broken_install`** — the CLI is on PATH but cannot execute (spawn ENOENT, non-executable binary, missing vendor payload). Print: "Codex is installed but its binary cannot run — Codex passes skipped. Reinstall: `npm install -g @openai/codex`." Relay the probe's HINT lines and fall back to the Claude subagent path. This state exists because a missing binary used to land in the model probe's fail-open bucket and report `ready`, so every Codex pass was skipped silently (#2742).
- **`model_unusable`** — authed but the account cannot use its configured model (#2477: HTTP 400 on every call, usually a stale `model =` pin in `~/.codex/config.toml`). Relay the probe's HINT lines, tell the user the one-line fix (update the pin; `[notice.model_migrations]` names the replacement), and fall back to the Claude subagent path. The ~10s round trip is cached for 1h; timeouts fail open to `ready`.
- **`ready`** — run the Codex pass below.

Only when `CODEX_MODE: ready`, run the budget dispatch:

```bash
~/.claude/skills/gstack/bin/gstack-review-budget dispatch "$RUN_ID" codex-structured --cycle <n>
```

On exit 2, print its line and do not run Codex. Otherwise resolve the slot's
MODEL once, before the review starts. The plan carries `CODEX_MODEL` (empty
= the client default; a policy `routing.models` entry names another, e.g.
dohma routes `gpt-6-astra` on tiers C and D) and `CODEX_MODEL_SOURCE`. A
named model runs only when the installed CLI and the signed-in account can
run it (one minimal access check, cached); otherwise the slot keeps the
default route and the substitution is logged. The model never changes the
budget, the effort, the 540s cap, the retry rule or the completion rule, and
a timed-out review stays incomplete: it never triggers an automatic
second-model review.

```bash
~/.claude/skills/gstack/bin/gstack-codex-model resolve --model "{CODEX_MODEL}" --effort "{medium|high from REVIEWERS suffix}" --source "{CODEX_MODEL_SOURCE}"
```

Carry its printed `CODEX_MODEL`, `CODEX_MODEL_REQUESTED`,
`CODEX_MODEL_SOURCE`, `CODEX_MODEL_SUBSTITUTED`,
`CODEX_MODEL_SUBSTITUTION_REASON`, `CODEX_MODEL_EXEC_FLAGS` and
`CODEX_MODEL_REVIEW_FLAGS` as literals. Print
`Codex model: {CODEX_MODEL} ({CODEX_MODEL_SOURCE}; requested {CODEX_MODEL_REQUESTED})`
and, when substituted, one more line with the reason. Then run exactly one
structured review at the suffix supplied by the plan. Branch on the packet's
`CI_GREEN` (true only when the EXACT reviewed SHA is on a remote branch with
every CI run completed and successful):

**`CI_GREEN=true`: the read-only packet reviewer.** `codex review --base`
re-runs the project's build and test suite inside its sandbox before it
reviews; on a large tier-D diff that alone consumed the 540s cap (observed
2026-09-03: three timeouts of four, zero findings returned). Fresh exact-SHA
CI evidence makes that execution redundant, so skip it deliberately:

```bash
TMPERR=$(mktemp /tmp/codex-review-XXXXXXXX)
_REPO_ROOT=$(git rev-parse --show-toplevel) || { echo "ERROR: not in a git repo" >&2; exit 1; }
cd "$_REPO_ROOT"
source ~/.claude/skills/gstack/bin/gstack-codex-probe 2>/dev/null || true
_CODEX_T0=$(date +%s)
_gstack_codex_timeout_wrapper 540 codex exec {CODEX_MODEL_EXEC_FLAGS} -C "$_REPO_ROOT" -s read-only --add-dir "$(dirname "{PACKET_PATH}")" -c 'model_reasoning_effort="{medium|high from REVIEWERS suffix}"' ${CODEX_WEB_SEARCH_FLAG} "You are the codex-structured reviewer for the gstack review governor, in READ-ONLY mode. CI_GREEN=true for the exact head SHA $(git rev-parse HEAD) (see the packet's CI evidence): do NOT run the build, the test suite, typecheck or any install; this is a SEMANTIC review of the diff only. Read the review packet at {PACKET_PATH} first, then read the diff at {DIFF_PATH} in ONE pass (cat the whole file once; never page it in chunks, paging a large diff is what runs past the cap), then open other worktree files only to answer a specific question, with read-only git. Do not re-derive the project. Findings already fixed and listed in the packet as resolved are not to be re-reported. Review for ways this code fails in production: SQL and data safety, race conditions, LLM trust boundary, enum completeness, security, reliability, data-migration ordering and rollback. Output one line per finding: [P1] or [P2] or [INFO] path:line — problem — fix — evidence: quoted line(s); a finding you cannot anchor to a quoted line is [INFO] at most; if nothing, exactly NO FINDINGS. End with ONE line: Recommendation: <action> because <one-line reason naming the most exploitable finding, or no exploitable finding>." < /dev/null 2>"$TMPERR"
_CODEX_RC=$?; echo "CODEX_RC=$_CODEX_RC CODEX_ELAPSED_S=$(( $(date +%s) - _CODEX_T0 ))"
```

**`CI_GREEN=false` or `unknown`: the CLI diff review.** Nothing has
proven the tree green, so codex may run what it needs:

```bash
TMPERR=$(mktemp /tmp/codex-review-XXXXXXXX)
_REPO_ROOT=$(git rev-parse --show-toplevel) || { echo "ERROR: not in a git repo" >&2; exit 1; }
cd "$_REPO_ROOT"
source ~/.claude/skills/gstack/bin/gstack-codex-probe 2>/dev/null || true
_CODEX_T0=$(date +%s)
_gstack_codex_timeout_wrapper 540 codex review --base <base> {CODEX_MODEL_REVIEW_FLAGS} -c 'model_reasoning_effort="{medium|high from REVIEWERS suffix}"' ${CODEX_WEB_SEARCH_FLAG} < /dev/null 2>"$TMPERR"
_CODEX_RC=$?; echo "CODEX_RC=$_CODEX_RC CODEX_ELAPSED_S=$(( $(date +%s) - _CODEX_T0 ))"
```

Either way the cap stays 540s. The effort is `medium` for tiers A/B/C and
`high` for tier D. The model is the one `gstack-codex-model` resolved:
`{CODEX_MODEL_EXEC_FLAGS}` / `{CODEX_MODEL_REVIEW_FLAGS}` are empty on the
default route and `--model <slug>` / `-c model="<slug>"` on a routed one
(`codex review` rejects `-m`). No prompt argument is allowed with
`--base` (the read-only form takes the prompt because it uses
`codex exec`). Read stderr before cleanup; keep the printed
`CODEX_ELAPSED_S` for the gate row. Check for
`[P1]` markers: found → `GATE: FAIL`, not found → `GATE: PASS`. FAIL →
AskUserQuestion with A) investigate and fix now (recommended), B) continue.
The [P1] gate semantics are unchanged.

After Codex returns, record its terminal result immediately:

```bash
~/.claude/skills/gstack/bin/gstack-review-budget verdict "$RUN_ID" codex-structured <clean|issues_found|error|timeout> --cycle <n> [--critical N --informational N]
```

After an `error` or `timeout`, the same cycle-scoped dispatch may retry this
planned slot ONCE; record the retry verdict too. A second failure stays
incomplete and can never be logged as clean.

A user request for "full review" permits ONE extra dispatch only:
`gstack-review-budget dispatch "$RUN_ID" codex-structured --escalation user-request:full-review --cycle <n>`.
This consumes the run's single escalation; no other escalation may dispatch
afterward. It never enables the removed free-form challenge.

Persist both logs. The review row and gate row must carry the plan's literal
effort and `effort_source:"routed"`; the gate row also carries the resolved
model, the requested model, whether it was substituted, and the wall time,
so `gstack-outcome-report` can read a model change from the rows it already
aggregates; gate telemetry retains tokens (from the `tokens used` line in
stderr when present), `fix_cycle`, `rerun_cause`, and `manifest_wtree`:

```bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"adversarial-review","timestamp":"TIMESTAMP","status":"STATUS","source":"codex-structured","tier":"{TIER}","gate":"GATE","model":"{CODEX_MODEL}","effort":"{PLAN_EFFORT}","effort_source":"routed","commit":"COMMIT"}'
~/.claude/skills/gstack/bin/gstack-gate-log '{"record_type":"gate","run_id":"{RUN_ID}","skill":"review","gate":"codex-structured","trigger":"review-plan","model":"{CODEX_MODEL}","model_requested":"{CODEX_MODEL_REQUESTED}","model_source":"{CODEX_MODEL_SOURCE}","model_substituted":{true|false},"effort":"{PLAN_EFFORT}","effort_source":"routed","elapsed_s":{CODEX_ELAPSED_S},"tokens":{"total":{N},"source":"codex-stderr"},"verdict":"{clean=pass|fail|timeout|error}","findings":{"p1":{N}},"fix_cycle":{N},"rerun_cause":{null|"delta-verification"|"scope-expansion:{triggers}"},"manifest_wtree":"{MANIFEST_WTREE}"}' 2>/dev/null || true
```

Failures and timeouts are missing coverage, never a clean result. Remove
`$TMPERR` after reading it, then return to the Step 4.6
completion gate; exit 2 with `INCOMPLETE=` means STOP with a blocker report.
