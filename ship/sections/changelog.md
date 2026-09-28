<!-- AUTO-GENERATED from changelog.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Step 13: CHANGELOG (auto-generate)

**Post-merge:** Write or refresh exactly one fragment, `changelog.d/<slug>.md`, and leave CHANGELOG.md unchanged. Derive `<slug>` from the current branch by replacing each `/` with `-` and dropping every character outside `[A-Za-z0-9._-]`. Before choosing a path, find this branch's added fragment with `git diff --name-only --diff-filter=A <base>...HEAD -- changelog.d/`. If one exists, rewrite it in place on every rerun; if more than one exists, stop and reconcile to one. Otherwise use the slug path. Save the exact relative path as `FRAGMENT_PATH` for later gates. Use the diff and commit checklist in steps 2-4 and the voice rules in step 5. Write exactly:

   ```markdown
   ---
   bump: micro | patch | minor | major
   ---
   <lead paragraph, then applicable ### Fixed / ### Changed / ### Added sections>
   ```

Replace the displayed alternatives with the lowercase `BUMP_LEVEL` value; the frontmatter has exactly one key, `bump`. The body has no `# ` or `## ` heading and no version/date header. Cross-check every substantive commit against the fragment. The fragment is the only release file in this PR. Skip the in-branch instructions below.

**In-branch only:**

1. Read `CHANGELOG.md` header to know the format.

2. **First, enumerate every commit on the branch:**
   ```bash
   git log origin/<base>..HEAD --oneline
   ```
   Copy the full list. Count the commits. You will use this as a checklist.

3. **Read the full diff** to understand what each commit actually changed:
   ```bash
   git diff origin/<base>
   ```

4. **Group commits by theme** before writing anything. Common themes:
   - New features / capabilities
   - Performance improvements
   - Bug fixes
   - Dead code removal / cleanup
   - Infrastructure / tooling / tests
   - Refactoring

5. **Write the CHANGELOG entry** covering ALL groups:
   - If existing CHANGELOG entries on the branch already cover some commits, replace them with one unified entry for the new version
   - Categorize changes into applicable sections:
     - `### Added` — new features
     - `### Changed` — changes to existing functionality
     - `### Fixed` — bug fixes
     - `### Removed` — removed features
   - Write concise, descriptive bullet points
   - Insert after the observed file header, before the first release entry, dated today
   - Format: `## [X.Y.Z.W] - YYYY-MM-DD`
   - **Voice:** Lead with what the user can now **do** that they couldn't before. Use plain language, not implementation details. Never mention TODOS.md, internal tracking, or contributor-facing details.

6. **Cross-check:** Compare your CHANGELOG entry against the commit list from step 2.
   Every commit must map to at least one bullet point. If any commit is unrepresented,
   add it now. If the branch has N commits spanning K themes, the CHANGELOG must
   reflect all K themes.

**Do NOT ask the user to describe changes.** Infer from the diff and commit history.

---
