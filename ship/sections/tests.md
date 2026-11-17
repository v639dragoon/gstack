<!-- AUTO-GENERATED from tests.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Step 4: Test Framework Bootstrap

## Test Framework Bootstrap

**Read the project's CLAUDE.md (and TESTING.md if present) FIRST.** If it documents a test command, the project already told you: no detection, no bootstrap. Skip the rest of bootstrap and use that command in Step 5.

**Otherwise gather markers. Every marker below is EVIDENCE for the question you ask — never a command to run blind.** A marker names the ecosystem and the command to OFFER; it does not prove the command works. Never execute a candidate to "check" it: probing a runner the project never had fails loudly and teaches nothing.

```bash
setopt +o nomatch 2>/dev/null || true  # zsh compat
# Ecosystem markers
[ -f manage.py ] && echo "RUNTIME:python FRAMEWORK:django MARKER:manage.py"
{ [ -f pyproject.toml ] || [ -f pytest.ini ] || [ -f tox.ini ] || [ -f setup.cfg ] || [ -f requirements.txt ]; } && echo "RUNTIME:python"
{ [ -f Gemfile ] || [ -f Rakefile ] || [ -f .rspec ]; } && echo "RUNTIME:ruby"
[ -f package.json ] && echo "RUNTIME:node"
[ -f go.mod ] && echo "RUNTIME:go"
[ -f Cargo.toml ] && echo "RUNTIME:rust"
[ -f pubspec.yaml ] && echo "RUNTIME:dart"
[ -f composer.json ] && echo "RUNTIME:php"
[ -f mix.exs ] && echo "RUNTIME:elixir"
[ -f pom.xml ] && echo "RUNTIME:jvm BUILD:maven"
{ [ -f build.gradle ] || [ -f build.gradle.kts ]; } && echo "RUNTIME:jvm BUILD:gradle"
# Detect sub-frameworks
[ -f Gemfile ] && grep -q "rails" Gemfile 2>/dev/null && echo "FRAMEWORK:rails"
[ -f package.json ] && grep -q '"next"' package.json 2>/dev/null && echo "FRAMEWORK:nextjs"
grep -qsE '^ +sdk: *.?flutter' pubspec.yaml && echo "FRAMEWORK:flutter"
# Test evidence: config files, declared scripts, AND test FILES (tested projects often lack a config)
ls jest.config.* vitest.config.* playwright.config.* .rspec pytest.ini tox.ini phpunit.xml* dart_test.yaml 2>/dev/null
[ -f package.json ] && grep -q '"test"[[:space:]]*:' package.json && echo "SCRIPT:package.json test"
[ -f Makefile ] && grep -qE '^(test|check):' Makefile && echo "TARGET:make test"
[ -f pyproject.toml ] && grep -q "pytest" pyproject.toml && echo "CONFIG:pyproject pytest"
git ls-files | grep -cE '(^|/)(tests?|spec|__tests__)/|(^|/)tests?\.py$|(^|/)test_[^/]+\.py$|_test\.(go|py|rb|ts|js|exs|dart)$|\.(test|spec)\.[jt]sx?$|_spec\.rb$|Test\.(java|kt)$' | sed 's/^/TESTFILES:/'
# Rust unit tests live in src/; file names alone miss them
[ -f Cargo.toml ] && git grep -lF '#[test]' -- 'src' >/dev/null 2>&1 && echo "TESTS:rust in-source"
# Check opt-out marker
[ -f .gstack/no-test-bootstrap ] && echo "BOOTSTRAP_DECLINED"
```

Map the markers to the command you will OFFER — never to one you run on a guess:

| Marker | Ecosystem | Candidate command to offer |
|--------|-----------|----------------------------|
| `manage.py` | Django | `python manage.py test` (or `pytest` when pytest-django is in the deps) |
| `pytest.ini` / `tox.ini` / pytest in `pyproject.toml` / `test_*.py` | Python | `pytest` |
| `go.mod` (+ any `*_test.go`) | Go | `go test ./...` |
| `Cargo.toml` | Rust | `cargo test` |
| `pubspec.yaml` | Dart / Flutter | `flutter test` (FRAMEWORK:flutter) or `dart test`; `fvm` prefix if `.fvmrc` |
| `pom.xml` | JVM (Maven) | `mvn test` |
| `build.gradle` / `build.gradle.kts` | JVM (Gradle) | `./gradlew test` |
| `Gemfile` / `Rakefile` / `.rspec` | Ruby | `bundle exec rspec`, `bin/rails test`, or `rake test` |
| `mix.exs` | Elixir | `mix test` |
| `composer.json` | PHP | `composer test` or `./vendor/bin/phpunit` |
| `package.json` with a `test` script | Node | that script, run with the package manager the lockfile names |
| `Makefile` with a `test:` target | any | `make test` |

**If ANY existing-test evidence appears** (a config file, a declared test script or make target, a nonzero `TESTFILES:` count, or `TESTS:rust in-source`): the project has tests. **Do NOT bootstrap.** Print "Existing tests detected: {the evidence}." Then get the command the same way Step 5 does — CLAUDE.md/TESTING.md if documented, otherwise AskUserQuestion offering the candidates from the table above plus "Other", and persist the answer to CLAUDE.md's `## Testing` section so it is never asked again. When the ecosystem ships a runner (Django, Go, Rust, Dart, Elixir, Maven/Gradle), that runner is the candidate — never install a second framework beside a working one.
Read 2-3 existing test files to learn conventions (naming, imports, assertion style, setup patterns).
Store conventions as prose context for use in Step 7. **Skip the rest of bootstrap.**

Absent config files and absent `tests/` directories are NOT evidence of "no tests": Django keeps tests in `<app>/tests.py`, Go in `*_test.go` beside the source, Rust in `#[test]` blocks inside `src/`.

**If BOOTSTRAP_DECLINED** appears:
- Step 5's explicit Add tests choice overrides that marker for this invocation only: continue to runtime detection and B2–B3, including framework approval.
- Otherwise print "Test bootstrap previously declined — skipping" and **skip the rest of bootstrap**.

**If NO ecosystem marker matched:** Use AskUserQuestion:
"I couldn't detect your project's language. What runtime are you using?"
Options: A) Node.js/TypeScript B) Ruby/Rails C) Python D) Go E) Rust F) PHP G) Elixir H) This project doesn't need tests.
If the runtime you need isn't listed, offer "Other" and take the runtime plus the test command as free text.
If user picks H → write `.gstack/no-test-bootstrap` and continue without tests.

**If an ecosystem matched but there is no existing-test evidence at all — bootstrap:**

When (and only when) the bootstrap condition above holds:

> **STOP.** Before bootstrapping a test framework (B2-B8), only when the Step 4 detection requires it, Read `~/.claude/skills/gstack/ship/sections/test-bootstrap-body.md` and execute it
> in full. Do not work from memory — that section is the source of truth for this step.

---

## Step 5: Run tests (on merged code)

**Run it:** `~/.claude/skills/gstack/bin/gstack-ship-preflight --tests-only --base <base> --lane <label>=<command>...`
(or the Step 1 call with lanes). It runs the free pre-gate first, before any lane, eval or
remote gate (`gstack-pregate --allow-repo-commands`: stage 1 regen, secrets, strays, literals;
stage 2 the selected lanes under pipefail), then the lanes inside the evidence ledger, and prints `PREGATE:`, `LANES:` and
one `LANE: <label> <state> exit= tests_ran= log=` line each.
`fail` or `incomplete` blocks: fix, rerun. **No-stop** (docs/review-policy.md#no-stop): a pregate flake rerun (one per branch), a
timeout-only fix and two other routine stops go through `gstack-no-stop record` (`--help`); `recorded` goes on,
`refused` stops. `requires-remote` (other platforms; the remote gate under 8 cores) needs
`gstack-pregate clear` or, under a user cap, `--remote --spend-cap <usd>`. Rerun
after the final stamp (`gstack-ship-release finish` does); Step 18 refuses a stale one.
**Run lanes in the background.** Where the host has background commands (Claude Code: `run_in_background: true`),
start this call that way and wait for its completion notice: lanes outlast the foreground tool limit (10 minutes in
Claude Code), and a killed call reruns every lane.

Read TESTING.md's `Local lanes` and `Full lanes`. Before selecting lanes, run `gstack-diff-manifest <base>` and `gstack-review-budget plan "$MANIFEST_PATH" --cycle 0 --host claude` from the installed bin; retain RUN_ID and all printed literals. Run Local lanes always. When `FULL_LANES_REQUIRED=false`, skip Full lanes (full suite/build) and record `build: DEFERRED to CI check {CI_BACKSTOP}`; never a silent pass. When true, run Full lanes too. Repos without policy lanes retain every applicable suite below.

Use the project's test commands discovered in Step 4 or documented in CLAUDE.md/AGENTS.md. Run every applicable suite; do not assume Rails or Vitest. Pass each as `--lane <label>=<command>`; use the same lane labels and exact commands again in Step 16.

<a id="ci-carry"></a>
**CI is the one full test run.** When `origin/<base>`'s `.gstack/pregate.json` maps a lane's exact
command in `ship_lanes_from` (gstack maps `bun run test`), that lane is carried from a verified CI run
at this exact, clean tree instead of running here: `LANE: <label> carried run=<id>/<attempt> tests_ran=<n>`.
Before the first push that lane runs only targeted tests and the repro (the full suite too when the diff touches
merge-check code: `lib/ship-*`, `lib/pregate/*`, the ship and pregate bins,
`scripts/lib/shard-engine.ts`). Push early so CI runs beside the review: commit, `gstack-ship-release push
--branch <branch> --early` (sealed, secrets and guards first; no consent: Step 6.5 asks only for Greptile), open a draft PR
(`gstack-post pr-create --base <base> --draft --title-file <f> --body-file <f>`), then `gstack-ci-carry wait` in
the background; once it prints `CI_WAIT: green`, rerun `--tests-only` and the mapped lane is carried. A red
run is a failed lane: triage it below. Batch review fixes into one commit and one push. `CI_CARRY: none
label=<l> (<reason>)` names why a mapped lane did not carry; any preflight then stops with `STOP: SHIP_LANE_NOT_CARRIED` before
any lane runs: dispatch CI and wait as its `NEXT:` lines say, or rerun with `--run-uncarried-here` to run the lane here. A docs-only change ([docs/pregate.md#docs-only](../../docs/pregate.md#docs-only)) owes no test lane: pregate runs
the docs lane, and a mapped lane prints `LANE: <label> not owed: docs-only change …` from CI's skipped run. Any other lane that already passed at this
tree, command and runtime is reused (`reused=<time>`). In Step 16, `finish` defers a mapped
lane it cannot carry (`EVIDENCE: DEFERRED`); after Step 17's push, `gstack-ship-release accept --base <base>
--lane …` carries it from the green run at the final head and reruns the pregate there.

**If no applicable test suite exists:** Name the untested scope. AskUserQuestion:
A) Add tests (recommended), B) Ship with this named testing
gap, or C) Stop. Reuse an actual prior B answer only for the same scope and
content; declining bootstrap alone is not that approval. B continues with the
gap recorded, not passing tests. Independent build, eval, review and QA gates
still apply. A declared but unavailable suite is a blocker, not an absent suite.
A runs Step 4 with this new bootstrap choice, then returns here to run the tests.
C stops this attempt.

**For Rails projects using `bin/test-lane`, do NOT run `RAILS_ENV=test bin/rails db:migrate`** — `bin/test-lane` already calls
`db:test:prepare` internally, which loads the schema into the correct lane database.
Running bare test migrations without INSTANCE hits an orphan DB and corrupts structure.sql.

Each lane runs as `gstack-evidence run --label <label> -- '<command>'`: transparent (exit code passes
through) and recorded as `{command, exit, working-tree fingerprint, log path}` in
`$GSTACK_STATE_ROOT/projects/<slug>/<branch>-evidence.jsonl`, which Step 16 cites instead of
re-running when the content hasn't changed. Each lane has its own log (no shared /tmp
collisions between concurrent ships); read it for failure detail.

**A lane passes on its runner summary line, not on exit 0 alone.** Read each
lane's `tests_ran` from its `LANE:` line (or from the runner's own summary in the log)
and keep the three states apart; never merge them:

1. `tests_ran: N` (N > 0) with exit 0 — the lane passed; record N for the PR body.
2. `tests_ran: 0` — **ZERO-RUN**: bun `0 pass 0 fail`, jest "No tests found", pytest
   "no tests ran", rspec "0 examples", `go test` with only `[no test files]`, or an
   empty selection after a filter. Exit 0 here is not a pass, so triage a ZERO-RUN
   lane below as a failed lane: a bad selector, a missing file or a skipped `describe`
   is an in-branch failure until proven otherwise.
3. `tests_ran: unknown` — the runner's summary was not recognised. Keep today's
   exit-0 pass and record `count unavailable` for that lane in the PR body.

**If any test fails:** Do NOT immediately stop. When a free-suite shard failed,
first Read `~/.claude/skills/gstack/ship/sections/measure.md` and rerun that
shard's file list as it says (diagnostic, not a verdict). Then apply the Test
Failure Ownership Triage:

> **STOP.** Before triaging test failures, only when a Step 5 test run has failures, Read `~/.claude/skills/gstack/ship/sections/test-failure-triage.md` and execute it
> in full. Do not work from memory — that section is the source of truth for this step.

**Resume a red-base pause.** A parent waits with `gstack-base-red wait --pause
<file>` (a background operation; `BASE_GREEN:` once a new base head passes the
cases), then runs `/gstack-ship --resume <record>`: if HEAD is still the paused head,
rerun this Step 5 on HEAD merged with the new base in a scratch worktree (never a
pushed base merge); all green rewrites the receipt without `--base-red` and runs
Step 22. Any failure is triaged here as new; a moved HEAD starts /gstack-ship fresh.

**If all pass:** Report each lane's pass count (or `count unavailable`) in one line and continue to Step 6.

---

## Step 6: Eval Suites (conditional)

Evals are mandatory when prompt-related files change. Select from the full diff,
including uncommitted changes, before deciding whether to skip.

**1. Select affected suites using the project's contract.**

**Project-native path:** Read CLAUDE.md/AGENTS.md, package scripts and the eval
dependency map. Include changed prompts, skill templates, judges and harness
code. Use the documented selector and pre-merge command. If it reports no
affected suites, record that result and continue to Step 7. If prompt-related
files changed but selection or the command is unknown, report the validation
gap and ask before shipping. A missing Rails-pattern match is not a skip signal
for another stack.

**Rails example only — when this repository provides `bin/test-lane` and
`test/evals/*_eval_runner.rb`:**

- Match the diff against the project's documented prompt paths, such as
  `app/services/*_prompt_builder.rb`, generation/writer/designer services,
  evaluator/scorer/classifier/analyzer services, voice/writing/prompt/token
  concerns, chat tools, `config/system_prompts/*.txt` and `test/evals/**/*`.
- Match changed files to each runner's `PROMPT_SOURCE_FILES`; follow shared
  judge/support/fixture imports to all affected suites. A runner such as
  `post_generation_eval_runner.rb` maps to `post_generation_eval_test.rb`.
- Use the project's full pre-merge tier (`EVAL_JUDGE_TIER=full` for this runner).
  Do not substitute a cheaper development tier. If selection remains uncertain,
  include every plausibly affected suite.

When the selection above requires evals, read the execution section only then:

> **STOP.** Before running eval suites, only when the Step 6 selection requires evals, Read `~/.claude/skills/gstack/ship/sections/eval-suites-run.md` and execute it
> in full. Do not work from memory — that section is the source of truth for this step.

---

The governor DETERMINISTIC_GATES floor remains required: tests, typecheck, build, gitleaks, redaction, verification, claim-check and pregate.
