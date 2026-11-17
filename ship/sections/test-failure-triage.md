<!-- AUTO-GENERATED from test-failure-triage.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Test Failure Ownership Triage

When tests fail, do NOT immediately stop. First, determine ownership:

### Step T1: Classify each failure

For each failing test:

1. **Get the files changed on this branch:**
   ```bash
   git diff origin/<base>...HEAD --name-only
   ```

2. **Classify the failure:**
   - **In-branch** if: the failing test file itself was modified on this branch, OR the test output references code that was changed on this branch, OR you can trace the failure to a change in the branch diff.
   - **Likely pre-existing** if: neither the test file nor the code it tests was modified on this branch, AND the failure is unrelated to any branch change you can identify.
   - **When ambiguous, default to in-branch.** It is safer to stop the developer than to let a broken test ship. Only classify as pre-existing when you are confident.

   This classification is heuristic — use your judgment reading the diff and the test output. You do not have a programmatic dependency graph.

### Step T2: Handle in-branch failures

**STOP.** These are your failures. Show them and do not proceed. The developer must fix their own broken tests before shipping.

### Step T3: Handle pre-existing failures

Check `REPO_MODE` from the preamble output.

**If REPO_MODE is `solo`:**

Ask with AskUserQuestion in the AskUserQuestion Format. List each failure with file:line and a brief error description, say the failures appear pre-existing (not caused by this branch), and say that in a solo repo nobody else will fix them. Options, with A recommended because the context is fresh:
- A) Investigate and fix now (human: ~2-4h / CC: ~15min) — Completeness 10/10
- B) Add as P0 TODO — fix after this branch lands — Completeness 7/10
- C) Skip — I know about this, ship anyway — Completeness 3/10

**If REPO_MODE is `collaborative` or `unknown`:**

Ask with AskUserQuestion in the AskUserQuestion Format. List each failure the same way, and say that in a collaborative repo these may be someone else's responsibility. Options, with B recommended so the person who broke it fixes it:
- A) Investigate and fix now anyway — Completeness 10/10
- B) Blame + assign GitHub issue to the author — Completeness 9/10
- C) Add as P0 TODO — Completeness 7/10
- D) Skip — ship anyway — Completeness 3/10

### Step T4: Execute the chosen action

**If "Investigate and fix now":**
- One read-only root-cause pass. If the cause is still unclear, reproduce it with a focused failing test and trace it to the root cause before the fix.
- Fix the pre-existing failure.
- Commit the fix separately from the branch's changes: `git commit -m "fix: pre-existing test failure in <test-file>"`
- Continue with the workflow.

**If "Add as P0 TODO":**
- If `TODOS.md` exists, add the entry following the format in `review/TODOS-format.md` (or `.claude/skills/review/TODOS-format.md`).
- If `TODOS.md` does not exist, create it with the standard header and add the entry.
- Entry should include: title, the error output, which branch it was noticed on, and priority P0.
- Continue with the workflow — treat the pre-existing failure as non-blocking.

**If "Blame + assign GitHub issue" (collaborative only):**
- Find who likely broke it. Check BOTH the test file AND the production code it tests:
  ```bash
  # Who last touched the failing test?
  git log --format="%an (%ae)" -1 -- "<failing-test-file>"
  # Who last touched the production code the test covers? (often the actual breaker)
  git log --format="%an (%ae)" -1 -- "<source-file-under-test>"
  ```
  If these are different people, prefer the production code author — they likely introduced the regression.
- Create an issue assigned to that person. Its title and body carry test names and error output, so they travel as files, never inside a command:

```bash
_GT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.gstack/tmp"
mkdir -p "$_GT" && chmod 700 "$_GT" || { echo "Not sent: cannot create $_GT for the text file." >&2; exit 1; }
_EX=$(git rev-parse --git-path info/exclude 2>/dev/null) && mkdir -p "$(dirname "$_EX")" && { grep -qxF '/.gstack/tmp/' "$_EX" 2>/dev/null || echo '/.gstack/tmp/' >> "$_EX"; }
TITLE_FILE=$(mktemp "${_GT:?}/issue-title.XXXXXX") || { echo "Not sent: mktemp failed in $_GT." >&2; exit 1; }; echo "TITLE_FILE: $TITLE_FILE (name: ${TITLE_FILE##*/})"
BODY_FILE=$(mktemp "${_GT:?}/issue-body.XXXXXX") || { echo "Not sent: mktemp failed in $_GT." >&2; exit 1; }; echo "BODY_FILE: $BODY_FILE (name: ${BODY_FILE##*/})"
```

Write the text into each printed file with your file-write tool (Claude Code's Write tool needs a Read of the empty file first), exactly as it should appear. The text never goes into a shell command, heredoc or quoted argument. If a write fails or is refused, do not send: print the cause, the file path and the command below for sending by hand. Title file: `Pre-existing test failure: <test name>`. Body file (Markdown; the error goes in a `~~~` fence so backticks in it stay literal):

```text
Failing on <current branch>; pre-existing.

**Error:**
~~~
<first 10 lines of the failure>
~~~

**Last modified by:** <author>
**Noticed by:** gstack /gstack-ship on <date>
```

Then post with your platform from Step 0 (`github` or `gitlab`). Substitute the two printed names, and an assignee only when it is a valid login for that platform (GitHub: letters, digits and single hyphens, at most 39 characters); otherwise drop the assignee flag and name the person in the body.

```bash
TITLE_FILE="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.gstack/tmp/<title-file-name>"
BODY_FILE="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.gstack/tmp/<body-file-name>"
[ -s "$TITLE_FILE" ] && [ -s "$BODY_FILE" ] || { echo "Not sent: $TITLE_FILE or $BODY_FILE is missing or empty, so the text was never written. Write it, then send by hand: gh issue create --title \"\$(cat $TITLE_FILE)\" --body-file $BODY_FILE" >&2; exit 1; }
[ "${GSTACK_CAPY:-}" = 1 ] && { echo "Not sent: on Capy, gh signs in as the owner's own GitHub account. Hand $TITLE_FILE and $BODY_FILE to whoever owns the work instead (docs/troubleshooting.md#host-publish)." >&2; exit 0; }
case "<platform>" in
  github) gh issue create --title "$(cat "$TITLE_FILE")" --body-file "$BODY_FILE" --assignee "<github-username>" ;;
  gitlab) glab issue create -t "$(cat "$TITLE_FILE")" -d "$(cat "$BODY_FILE")" -a "<gitlab-username>" ;;
  *) echo "Not sent: no GitHub or GitLab remote. Files: $TITLE_FILE $BODY_FILE" >&2; false ;;
esac && rm "$TITLE_FILE" "$BODY_FILE"
```

- If neither CLI is available or `--assignee`/`-a` fails (user not in org, etc.), create the issue without assignee and note who should look at it in the body.
- Continue with the workflow.

**If "Skip":**
- Continue with the workflow.
- Note in output: "Pre-existing test failure skipped: <test-name>"

**Red base (before T3).** When T1 calls every failure likely pre-existing,
prove it before asking: write `.gstack/tmp/base-red.json` with your file-write tool
(`{"lane":"<label>","total":<failures the lane reported>,"failures":[{"id":"<test
name>","file":"<test file>","signature":"<first error line>"}]}`), then run

```bash
~/.claude/skills/gstack/bin/gstack-base-red classify --failures .gstack/tmp/base-red.json --base <base> --pause
```

It reads `base_red` from the base branch's ship policy and reruns those files at
the base head and at HEAD in scratch worktrees. Exit 0 with `BASE_RED_VERDICT:
base-red` and `PAUSE: <file>`: skip T3, record the pause file and its cases in
the invocation record, and continue to Step 6; Step 16 treats exactly these cases
as this run's waived failures (any other failure is new), and the receipt write
adds `--base-red <pause file>`, so Step 22 ends `SHIP_PAUSED` with
`status=incomplete` instead of READY. Exit 1 (`IN_BRANCH:` lines,
`BASE_RED_UNCONFIGURED`, `BASE_RED_UNNAMED`, `BASE_RED_REPRO_ERROR`): continue T3
as written.

**After triage:** If any in-branch failures remain unfixed, **STOP**. Do not proceed. If all failures were pre-existing and handled (fixed, TODOed, assigned, skipped, or base-red and paused), continue to Step 6.
