import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-context-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const env = {
  ...process.env,
  HOME: tmp,
  GSTACK_HOME: path.join(tmp, "home-state"),
  GSTACK_STATE_ROOT: path.join(tmp, "explicit-state"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
function run(
  cwd: string,
  command: string,
  args: string[],
  extra: Record<string, string> = {},
) {
  const r = spawnSync(command, args, {
    cwd,
    env: { ...env, ...extra },
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

// Exercise the identical writer with the former standalone outcome lookup.
// Copy only the writer; linked dependencies are read/executed, never written.
const legacyBin = path.join(fs.realpathSync(tmp), "derived-bin");
fs.mkdirSync(legacyBin);
for (const file of fs.readdirSync(path.join(root, "bin"))) {
  if (!["gstack-gate-log", "gstack-voice-row"].includes(file))
    fs.symlinkSync(path.join(root, "bin", file), path.join(legacyBin, file));
}
const source = fs.readFileSync(path.join(root, "bin/gstack-gate-log"), "utf8");
const fingerprint = source.slice(
  source.indexOf("  # With neither HEAD"),
  source.indexOf(
    '  if [ -n \"$(git status',
    source.indexOf("  # With neither HEAD"),
  ),
);
const referenceSource = source.replace(
  fingerprint,
  '  WTREE=$(\"$SCRIPT_DIR/gstack-wtree\" 2>/dev/null || true)\n',
);
const directRead =
  "try { outcome = (await import(env.GSTACK_OUTCOME_MODULE)).readOutcome(env.GSTACK_OUTCOME_BRANCH); } catch {}";
expect(source).toContain(directRead);
fs.writeFileSync(
  path.join(legacyBin, "gstack-gate-log"),
  referenceSource.replace(
    directRead,
    `try { outcome = JSON.parse(require('child_process').execFileSync(env.GSTACK_OUTCOME_MODULE.replace(/\\.ts$/, ''), ['show', '--json'], {encoding:'utf8',timeout:30000})); } catch {}`,
  ),
  { mode: 0o755 },
);

const handedBin = path.join(tmp, "handed-bin");
fs.mkdirSync(handedBin);
const slugCalls = path.join(tmp, "slug-calls");
for (const file of fs.readdirSync(path.join(root, "bin"))) {
  if (!["gstack-gate-log", "gstack-slug"].includes(file))
    fs.symlinkSync(path.join(root, "bin", file), path.join(handedBin, file));
}
fs.writeFileSync(path.join(handedBin, "gstack-gate-log"), source, {
  mode: 0o755,
});
fs.writeFileSync(
  path.join(handedBin, "gstack-slug"),
  `#!/usr/bin/env bash
printf 'called\\n' >> '${slugCalls}'
exec '${root}/bin/gstack-slug' "$@"
`,
  { mode: 0o755 },
);

for (const mode of [
  "branch",
  "detached",
  "unborn",
  "staged-unborn",
  "outside-git",
] as const) {
  test(`handed-in and standalone outcome context produce byte-identical gate rows: ${mode}`, () => {
    const repo = path.join(tmp, mode);
    fs.mkdirSync(repo);
    if (mode !== "outside-git") {
      run(repo, "git", ["init", "-q", "-b", "feature/paint"]);
      fs.writeFileSync(path.join(repo, "seed"), "seed\n");
      if (mode !== "unborn") run(repo, "git", ["add", "seed"]);
      if (!["unborn", "staged-unborn"].includes(mode))
        run(repo, "git", ["commit", "-qm", "seed"]);
      if (mode === "detached") run(repo, "git", ["checkout", "--detach", "-q"]);
    }
    // A marker must never redirect governor records; pin a different marker name.
    fs.writeFileSync(path.join(repo, ".gstack-project"), "");
    const bin = path.join(root, "bin");
    const slug = run(repo, path.join(bin, "gstack-slug"), [
      "--get",
      "REPO_SLUG",
    ]).trim();
    const branch = run(repo, path.join(bin, "gstack-slug"), [
      "--get",
      "BRANCH",
    ]).trim();
    const project = path.join(env.GSTACK_STATE_ROOT, "projects", slug);
    const metadata: Record<string, string> =
      mode === "branch"
        ? {
            GIT_CONFIG_COUNT: "5",
            GIT_CONFIG_KEY_0: "branch.feature/paint.gstackOutcomeId",
            GIT_CONFIG_VALUE_0: "paint-1",
            GIT_CONFIG_KEY_1: "branch.feature/paint.gstackOutcomeSlice",
            GIT_CONFIG_VALUE_1: "2",
            GIT_CONFIG_KEY_2: "branch.feature/paint.gstackOutcomeFinal",
            GIT_CONFIG_VALUE_2: "true",
            GIT_CONFIG_KEY_3: "branch.feature/paint.gstackOutcomeFlagFlip",
            GIT_CONFIG_VALUE_3: "false",
            GIT_CONFIG_KEY_4: "branch.feature/paint.gstackOutcomeTier",
            GIT_CONFIG_VALUE_4: "C",
          }
        : {};
    fs.mkdirSync(path.join(project, "manifests"), { recursive: true });
    fs.writeFileSync(
      path.join(project, "manifests/abc123.json"),
      '{"routing":{"risk_tier":"D"}}',
    );
    const record = JSON.stringify({
      record_type: "gate",
      gate: "codex-effort-decision",
      run_id: "same-input",
      effort: "high",
      effort_source: "default",
      manifest_wtree: "abc123",
    });
    const file = path.join(project, `${branch}-gates.jsonl`);
    // Inherited lookalike context must be ignored by both standalone shell bins.
    const extra = {
      ...metadata,
      GSTACK_OUTCOME_PROJECT_DIR: path.join(tmp, "wrong"),
      GSTACK_OUTCOME_BRANCH: "wrong",
      SLUG: "wrong",
      BRANCH: "wrong",
    };
    run(repo, path.join(legacyBin, "gstack-gate-log"), [record], extra);
    const before = fs.readFileSync(file, "utf8");
    const contextFile = path.join(tmp, `${mode}.gate-context`);
    run(
      repo,
      path.join(handedBin, "gstack-gate-log"),
      [record, "--context-out", contextFile],
      extra,
    );
    expect(fs.readFileSync(file, "utf8")).toBe(before + before);
    const context = fs.readFileSync(contextFile, "utf8");
    expect(fs.statSync(contextFile).mode & 0o777).toBe(0o600);
    const calls = fs.readFileSync(slugCalls, "utf8");
    run(
      repo,
      path.join(handedBin, "gstack-gate-log"),
      [record, "--context-in", context],
      extra,
    );
    expect(fs.readFileSync(slugCalls, "utf8")).toBe(calls);
    expect(fs.readFileSync(file, "utf8")).toBe(before.repeat(3));
    // Context from another cwd/root/branch/routing/override cannot move a row.
    let count = 3;
    for (const field of ["cwd", "root", "branch", "routing", "override"]) {
      const stale = { ...JSON.parse(context), [field]: "different" };
      run(
        repo,
        path.join(handedBin, "gstack-gate-log"),
        [record, "--context-in", JSON.stringify(stale)],
        extra,
      );
      expect(fs.readFileSync(file, "utf8")).toBe(before.repeat(++count));
    }
    expect(JSON.parse(before).risk_tier).toBe("D");
    expect(JSON.parse(before).outcome_id).toBe(
      mode === "branch" ? "paint-1" : null,
    );
    expect(fs.existsSync(path.join(tmp, "wrong"))).toBe(false);
    expect(fs.existsSync(env.GSTACK_HOME)).toBe(false);
  });
}

test("voice row builtin sanitization preserves the former field bytes", () => {
  const repo = path.join(tmp, "voice");
  const clock = path.join(tmp, "clock");
  fs.mkdirSync(repo);
  fs.mkdirSync(clock);
  fs.writeFileSync(
    path.join(clock, "date"),
    "#!/usr/bin/env bash\necho 100\n",
    { mode: 0o755 },
  );
  const voice = fs.readFileSync(
    path.join(root, "bin/gstack-voice-row"),
    "utf8",
  );
  const start = voice.indexOf("q() {");
  const end = voice.indexOf("elapsed=", start);
  let reference =
    voice.slice(0, start) +
    `q() { printf '%s' "$1" | tr -d '"\\\\'; }\n` +
    voice.slice(end);
  for (const field of [
    "skill",
    "voice",
    "status",
    "model",
    "src",
    "effort",
    "effort_source",
  ]) {
    reference = reference.replaceAll(
      "${" + field + "}",
      '$(q "$' + field + '")',
    );
  }
  expect(fs.realpathSync(legacyBin)).toBe(path.join(fs.realpathSync(tmp), "derived-bin"));
  expect(fs.existsSync(path.join(legacyBin, "gstack-voice-row"))).toBe(false);
  fs.writeFileSync(path.join(legacyBin, "gstack-voice-row"), reference, {
    mode: 0o755,
  });
  const extra = {
    PATH: clock + path.delimiter + process.env.PATH,
    GSTACK_RUN_ID: "same-voice",
  };
  const args = [
    's"\\kill\n\n',
    'review"\\\n',
    "completed\n",
    'gpt-"\\test\n',
    'default"\\\n',
    "high\n",
    "100",
    "",
    "--quiet",
  ];
  const slug = run(repo, path.join(root, "bin/gstack-slug"), [
    "--get",
    "REPO_SLUG",
  ]).trim();
  const file = path.join(
    env.GSTACK_STATE_ROOT,
    "projects",
    slug,
    "unknown-gates.jsonl",
  );
  run(repo, path.join(legacyBin, "gstack-voice-row"), args, extra);
  const before = fs.readFileSync(file, "utf8");
  run(repo, path.join(root, "bin/gstack-voice-row"), args, extra);
  expect(fs.readFileSync(file, "utf8")).toBe(before + before);
  expect(JSON.parse(before)).toMatchObject({
    skill: "skill",
    purpose: "review",
    model: "gpt-test",
    effort: "high",
  });
});
