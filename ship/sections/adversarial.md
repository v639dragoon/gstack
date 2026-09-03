<!-- AUTO-GENERATED from adversarial.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Step 11: Adversarial review — governor routed

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

On exit 2, print its line and do not run Codex. Otherwise run exactly one
structured review at the suffix supplied by the plan:

```bash
TMPERR=$(mktemp /tmp/codex-review-XXXXXXXX)
_REPO_ROOT=$(git rev-parse --show-toplevel) || { echo "ERROR: not in a git repo" >&2; exit 1; }
cd "$_REPO_ROOT"
source ~/.claude/skills/gstack/bin/gstack-codex-probe 2>/dev/null || true
_gstack_codex_timeout_wrapper 540 codex review --base <base> -c 'model_reasoning_effort="{medium|high from REVIEWERS suffix}"' ${CODEX_WEB_SEARCH_FLAG} < /dev/null 2>"$TMPERR"
```

The effort is `medium` for tiers A/B/C and `high` for tier D. No prompt
argument is allowed with `--base`. Read stderr before cleanup. Check for
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
effort and `effort_source:"routed"`; gate telemetry retains tokens,
`fix_cycle`, `rerun_cause`, and `manifest_wtree`:

```bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"adversarial-review","timestamp":"TIMESTAMP","status":"STATUS","source":"codex-structured","tier":"{TIER}","gate":"GATE","effort":"{PLAN_EFFORT}","effort_source":"routed","commit":"COMMIT"}'
~/.claude/skills/gstack/bin/gstack-gate-log '{"record_type":"gate","run_id":"{RUN_ID}","skill":"ship","gate":"codex-structured","trigger":"review-plan","model":"codex","effort":"{PLAN_EFFORT}","effort_source":"routed","verdict":"{clean=pass|fail|timeout|error}","findings":{"p1":{N}},"fix_cycle":{N},"rerun_cause":{null|"delta-verification"|"scope-expansion:{triggers}"},"manifest_wtree":"{MANIFEST_WTREE}"}' 2>/dev/null || true
```

Failures and timeouts are missing coverage, never a clean result. Remove
`$TMPERR` after reading it, then return to the Step 9.2
completion gate; exit 2 with `INCOMPLETE=` means STOP with a blocker report.

## Capture Learnings

If you discovered a non-obvious pattern, pitfall, or architectural insight during
this session, log it for future sessions:

```bash
~/.claude/skills/gstack/bin/gstack-learnings-log '{"skill":"ship","type":"TYPE","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"SOURCE","files":["path/to/relevant/file"]}'
```

**Types:** `pattern` (reusable approach), `pitfall` (what NOT to do), `preference`
(user stated), `architecture` (structural decision), `tool` (library/framework insight),
`operational` (project environment/CLI/workflow knowledge).

**Sources:** `observed` (you found this in the code), `user-stated` (user told you),
`inferred` (AI deduction), `cross-model` (both Claude and Codex agree).

**Confidence:** 1-10. Be honest. An observed pattern you verified in the code is 8-9.
An inference you're not sure about is 4-5. A user preference they explicitly stated is 10.

**files:** Include the specific file paths this learning references. This enables
staleness detection: if those files are later deleted, the learning can be flagged.

**Only log genuine discoveries.** Don't log obvious things. Don't log things the user
already knows. A good test: would this insight save time in a future session? If yes, log it.



### Refresh learnings for the headline feature on this branch

The top-of-skill learnings pull was keyed to "release ship" broadly. Before the VERSION/CHANGELOG step, re-pull learnings keyed to THIS branch's headline feature so any prior version-bump or CHANGELOG pitfalls for similar features surface.

Pick ONE keyword that names the headline feature you're shipping. The keyword should be a noun: the primary skill or module name, the central feature noun, or the binary you changed. The keyword MUST be alphanumeric or hyphen only — no quotes, slashes, dots, colons, or whitespace. If your candidate has any of those, simplify to just the alphanumeric stem.

Worked examples (ship-specific): good keywords are `learnings-search`, `pacing`, `worktree-ship`. Bad: `the branch headline`, `v1.31.1.0`, `feat: token-or search`.

```bash
~/.claude/skills/gstack/bin/gstack-learnings-search --query "<your-keyword>" --limit 5 2>/dev/null || true
```

If any learnings come back, name which one applies to the version bump or CHANGELOG framing in one sentence. If none come back, continue without reference — the absence is itself useful information.
