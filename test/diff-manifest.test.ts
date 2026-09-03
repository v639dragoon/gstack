/**
 * Tests for bin/gstack-diff-manifest — the Phase 0 shared diff/risk manifest.
 *
 * Pattern follows test/diff-scope.test.ts (throwaway git repos → run script →
 * assert), plus a temp GSTACK_HOME so manifests land in an inspectable
 * sandbox. Everything here is deterministic and free-tier.
 *
 * The shadow verdicts asserted here are LOGGED-ONLY in Phase 0 — these tests
 * pin what gets recorded.
 *
 * Hermeticity: every git invocation (fixture setup AND the script under test)
 * runs with GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM pointed at /dev/null. A
 * user-global gitignore is enough to silently drop fixtures from commits —
 * measured on a real machine whose ~/.gitignore_global carries `*.sql`, which
 * made every migration fixture vanish from `git add .` and turned this exact
 * test red while the logic under test was correct. (The same mechanism
 * explains test/diff-scope.test.ts's migration-case failures on that machine.)
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const SCRIPT = join(import.meta.dir, '..', 'bin', 'gstack-diff-manifest');

// Isolate every git call from user/system config (see header).
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

const dirs: string[] = [];

const TEST_POLICY = {
  version: 1,
  auth_surfaces: ['lib/auth/**', 'middleware.ts', '**/magic-link/**'],
  d_surfaces: ['supabase/migrations/**', 'lib/env/**', '.github/workflows/**'],
  load_bearing_docs: ['TODOS.md', 'docs/runbooks/**'],
  doc_impact_map: [
    { paths: ['supabase/migrations/**'], docs: ['docs/runbooks/schema.md'] },
    { paths: ['lib/env/**'], docs: ['.env.example'] },
  ],
};

function createRepo(
  files: string[],
  opts: { policy?: object | null; baseFiles?: Record<string, string> } = {},
): { dir: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), 'diff-manifest-test-'));
  const home = mkdtempSync(join(tmpdir(), 'diff-manifest-home-'));
  dirs.push(dir, home);

  const run = (cmd: string, args: string[]) =>
    spawnSync(cmd, args, {
      cwd: dir,
      stdio: 'pipe',
      timeout: 5000,
      env: { ...process.env, ...GIT_ENV },
    });

  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.email', 'test@test.com']);
  run('git', ['config', 'user.name', 'Test']);

  // Base commit. The policy file is committed at BASE on purpose: it must not
  // appear in the changed-file set and pollute tier classification.
  writeFileSync(join(dir, 'README.md'), '# test\n');
  if (opts.policy !== null) {
    writeFileSync(
      join(dir, '.gstack-policy.json'),
      JSON.stringify(opts.policy ?? TEST_POLICY, null, 2),
    );
  }
  for (const [name, contents] of Object.entries(opts.baseFiles ?? {})) {
    const target = join(dir, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, contents);
  }
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'initial']);

  run('git', ['checkout', '-b', 'feature/test']);
  for (const f of files) {
    const fullPath = join(dir, f);
    const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'));
    if (dirPath !== dir) mkdirSync(dirPath, { recursive: true });
    writeFileSync(fullPath, 'line one\nline two\n');
  }
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'add files']);

  return { dir, home };
}

type ManifestRun = {
  vars: Record<string, string>;
  status: number;
  manifest: any | null;
  stdout: string;
};

function runManifest(
  dir: string,
  home: string,
  args: string[] = ['main'],
  extraEnv: Record<string, string> = {},
): ManifestRun {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: dir,
    stdio: 'pipe',
    timeout: 15000,
    env: { ...process.env, ...GIT_ENV, GSTACK_HOME: home, ...extraEnv },
  });
  const stdout = result.stdout.toString().trim();
  const vars: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) vars[line.slice(0, eq)] = line.slice(eq + 1);
  }
  let manifest: any | null = null;
  if (vars.MANIFEST_PATH && existsSync(vars.MANIFEST_PATH)) {
    manifest = JSON.parse(readFileSync(vars.MANIFEST_PATH, 'utf-8'));
  }
  return { vars, status: result.status ?? -1, manifest, stdout };
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('gstack-diff-manifest', () => {
  test('a d_surface file classifies tier D with a rule naming the surface (fail-upward)', () => {
    const { dir, home } = createRepo(['supabase/migrations/0001_init.sql', 'lib/util.ts']);
    const r = runManifest(dir, home);
    expect(r.status).toBe(0);
    expect(r.vars.SHADOW_TIER).toBe('D');
    expect(r.manifest.shadow.risk_tier).toBe('D');
    expect(r.manifest.shadow.tier_rule).toContain('supabase/migrations/0001_init.sql');
    expect(r.manifest.shadow.d_surface_matches).toContain('supabase/migrations/0001_init.sql');
  });

  test('auth glob-vs-policy disagreement: *session* filename trips the glob, not the explicit list', () => {
    // The audit's core AUTH finding: `sessions` is dohma's product noun, so the
    // *session* glob over-triggers ~3.7x. The shadow record captures exactly that.
    const { dir, home } = createRepo(['app/sessions/page.tsx']);
    const r = runManifest(dir, home);
    expect(r.status).toBe(0);
    expect(r.vars.SCOPE_AUTH).toBe('true');
    expect(r.manifest.shadow.auth_glob).toBe(true);
    expect(r.manifest.shadow.auth_policy).toBe(false);
    expect(r.manifest.shadow.auth_disagreement).toBe(true);
  });

  test('an explicit auth surface matches the policy list (agreement, no disagreement flag)', () => {
    const { dir, home } = createRepo(['lib/auth/token.ts']);
    const r = runManifest(dir, home);
    expect(r.manifest.shadow.auth_glob).toBe(true); // *auth* glob also fires
    expect(r.manifest.shadow.auth_policy).toBe(true);
    expect(r.manifest.shadow.auth_disagreement).toBe(false);
  });

  test('no policy file → graceful degradation: null verdicts, exit 0, manifest still written', () => {
    const { dir, home } = createRepo(['lib/util.ts'], { policy: null });
    const r = runManifest(dir, home);
    expect(r.status).toBe(0);
    expect(r.vars.SHADOW_TIER).toBe('null');
    expect(r.manifest.policy.present).toBe(false);
    expect(r.manifest.shadow.risk_tier).toBe(null);
    expect(r.manifest.shadow.auth_policy).toBe(null);
    expect(r.manifest.shadow.doc_impact_would_dispatch).toBe(null);
  });

  test('docs-only change is tier A; a load-bearing doc demotes it to B', () => {
    const a = createRepo(['docs/notes.md']);
    expect(runManifest(a.dir, a.home).vars.SHADOW_TIER).toBe('A');

    const b = createRepo(['docs/notes.md', 'TODOS.md']);
    const rb = runManifest(b.dir, b.home);
    expect(rb.vars.SHADOW_TIER).toBe('B');
    expect(rb.manifest.shadow.tier_rule).toContain('TODOS.md');
    expect(rb.manifest.shadow.load_bearing_doc_matches).toContain('TODOS.md');
  });

  test('content-addressed immutability: same tree → same path; changed tree → new path', () => {
    const { dir, home } = createRepo(['lib/util.ts']);
    const r1 = runManifest(dir, home);
    const r2 = runManifest(dir, home);
    expect(r2.vars.MANIFEST_PATH).toBe(r1.vars.MANIFEST_PATH);

    writeFileSync(join(dir, 'lib/util.ts'), 'line one\nline two\nline three\n');
    const r3 = runManifest(dir, home);
    expect(r3.vars.MANIFEST_PATH).not.toBe(r1.vars.MANIFEST_PATH);
    // The original manifest is untouched — immutability, not replacement.
    expect(existsSync(r1.vars.MANIFEST_PATH)).toBe(true);
  });

  test('a diff-scope SCOPE_ERROR is carried in-band; the manifest survives and exit stays 0', () => {
    // A file matching no diff-scope category trips its exit-2 unmatched
    // tripwire. The manifest must carry that in scope.error, not vanish.
    const { dir, home } = createRepo(['strangefile.xyz']);
    const r = runManifest(dir, home);
    expect(r.status).toBe(0);
    expect(r.vars.SCOPE_ERROR).toBe('unmatched');
    expect(r.manifest.scope.error).toBe('unmatched');
    // Unclassifiable scope fails UPWARD, never down.
    expect(r.manifest.shadow.risk_tier).toBe('C');
  });

  test('doc-impact map: hit sets would_dispatch and the fingerprint reacts to the file list', () => {
    const { dir, home } = createRepo(['lib/env/server.ts']);
    const r1 = runManifest(dir, home);
    expect(r1.manifest.shadow.doc_impact_would_dispatch).toBe(true);
    expect(r1.manifest.shadow.doc_impact_matches[0].docs).toContain('.env.example');

    // Same tree, same fingerprint (stability).
    const r2 = runManifest(dir, home);
    expect(r2.vars.DOC_FP).toBe(r1.vars.DOC_FP);

    // New file → different fingerprint.
    writeFileSync(join(dir, 'newfile.ts'), 'x\n');
    const r3 = runManifest(dir, home);
    expect(r3.vars.DOC_FP).not.toBe(r1.vars.DOC_FP);
  });

  test('run_id: minted when absent, reused verbatim when passed (one skill run, one id)', () => {
    const { dir, home } = createRepo(['lib/util.ts']);
    const minted = runManifest(dir, home);
    expect(minted.vars.RUN_ID).toMatch(/^\d+-\d+$/);

    const passed = runManifest(dir, home, ['main', 'ship-run-42']);
    expect(passed.vars.RUN_ID).toBe('ship-run-42');
  });

  test('stdout is shell-safe for source <(...): every line is a KEY=VALUE assignment', () => {
    const { dir, home } = createRepo(['lib/util.ts']);
    const r = runManifest(dir, home);
    for (const line of r.stdout.split('\n')) {
      expect(line).toMatch(/^[A-Z_]+=[^\s]*$/);
    }
  });

  test('per-file additions/deletions and untracked files land in the manifest', () => {
    const { dir, home } = createRepo(['lib/util.ts']);
    writeFileSync(join(dir, 'untracked-new.ts'), 'a\nb\nc\n');
    const r = runManifest(dir, home);
    const byPath = Object.fromEntries(r.manifest.files.map((f: any) => [f.path, f]));
    expect(byPath['lib/util.ts'].additions).toBe(2);
    expect(byPath['lib/util.ts'].untracked).toBe(false);
    expect(byPath['untracked-new.ts'].additions).toBe(3);
    expect(byPath['untracked-new.ts'].untracked).toBe(true);
    expect(parseInt(r.vars.DIFF_LINES, 10)).toBeGreaterThanOrEqual(5);
  });

  test('outside a git repo: MANIFEST_ERROR=no_git and exit 2', () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'diff-manifest-nongit-'));
    const home = mkdtempSync(join(tmpdir(), 'diff-manifest-home-'));
    dirs.push(nonGit, home);
    const result = spawnSync('bash', [SCRIPT, 'main'], {
      cwd: nonGit,
      stdio: 'pipe',
      timeout: 15000,
      env: { ...process.env, ...GIT_ENV, GSTACK_HOME: home },
    });
    expect(result.status).toBe(2);
    expect(result.stdout.toString()).toContain('MANIFEST_ERROR=no_git');
  });

  test('routing is never null and fails upward to D without usable inputs', () => {
    const noPolicy = createRepo(['lib/util.ts'], { policy: null });
    const np = runManifest(noPolicy.dir, noPolicy.home);
    expect(np.manifest.routing.risk_tier).toBe('D');
    expect(np.manifest.routing.tier_source).toBe('fail-up:no-policy');

    const bad = createRepo(['lib/util.ts']);
    writeFileSync(join(bad.dir, '.gstack-policy.json'), '{bad json');
    const bp = runManifest(bad.dir, bad.home);
    expect(bp.manifest.routing.risk_tier).toBe('D');
    expect(bp.manifest.routing.tier_source).toBe('fail-up:policy-error');

    const scope = createRepo(['strangefile.xyz']);
    const sp = runManifest(scope.dir, scope.home);
    expect(sp.manifest.routing.risk_tier).toBe('D');
    expect(sp.manifest.routing.tier_source).toBe('fail-up:scope-error');

    const empty = createRepo([]);
    const ep = runManifest(empty.dir, empty.home);
    expect(ep.manifest.routing.risk_tier).toBe('D');
    expect(ep.manifest.routing.tier_source).toBe('fail-up:empty');
  });

  test('routing mirrors policy tiers and outcome overrides only raise', () => {
    const a = createRepo(['docs/notes.md']);
    expect(runManifest(a.dir, a.home).manifest.routing.risk_tier).toBe('A');
    const b = createRepo(['app/page.tsx']);
    expect(runManifest(b.dir, b.home).manifest.routing.risk_tier).toBe('B');
    const c = createRepo(['lib/server.ts']);
    expect(runManifest(c.dir, c.home).manifest.routing.risk_tier).toBe('C');
    const d = createRepo(['supabase/migrations/x.sql']);
    expect(runManifest(d.dir, d.home).manifest.routing.risk_tier).toBe('D');

    const raised = createRepo(['docs/notes.md']);
    const outcome = JSON.stringify({
      present: true,
      outcome_id: 'launch-1',
      slice_number: 1,
      is_final_slice: false,
      is_flag_flip: false,
      risk_tier_override: 'C',
    });
    expect(
      runManifest(raised.dir, raised.home, ['main'], { GDM_OUTCOME_JSON: outcome }).manifest.routing
        .risk_tier,
    ).toBe('C');
    const lowered = runManifest(d.dir, d.home, ['main'], { GDM_OUTCOME_JSON: outcome });
    expect(lowered.manifest.routing.risk_tier).toBe('D');
    expect(lowered.manifest.routing.tier_rule).toContain('override-ignored:C');
  });

  test('an auth_surface match ROUTES as D even without a d_surface hit (shadow keeps the audit rule)', () => {
    const auth = createRepo(['lib/auth/session.ts']);
    const m = runManifest(auth.dir, auth.home).manifest;
    expect(m.routing.risk_tier).toBe('D');
    expect(m.routing.tier_rule).toBe('auth_surface:lib/auth/session.ts');
    expect(m.routing.tier_source).toBe('policy');
    expect(m.shadow.risk_tier).toBe('C'); // shadow unchanged: lib/ is backend scope, not a d_surface
  });

  test('a rename into a d_surface uses canonical paths and routes D', () => {
    const { dir, home } = createRepo([], { baseFiles: { 'ci/deploy.yml': 'deploy: true\n' } });
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    spawnSync('git', ['mv', 'ci/deploy.yml', '.github/workflows/deploy.yml'], {
      cwd: dir,
      env: { ...process.env, ...GIT_ENV },
    });
    const r = runManifest(dir, home);
    expect(r.manifest.files.map((f: any) => f.path)).toContain('.github/workflows/deploy.yml');
    expect(r.manifest.files.map((f: any) => f.path).join(',')).not.toContain('{ci =>');
    expect(r.manifest.routing.risk_tier).toBe('D');
  });

  test('migration scope is always routing tier D without a policy-glob match', () => {
    const policy = { ...TEST_POLICY, d_surfaces: [] };
    const repo = createRepo(['supabase/migrations/x.sql'], { policy });
    const r = runManifest(repo.dir, repo.home);
    expect(r.manifest.routing.risk_tier).toBe('D');
    expect(r.manifest.routing.tier_rule).toBe('scope:migrations (critical surface)');
    expect(r.manifest.shadow.risk_tier).toBe('C');
  });

  test('root .env* policy glob matches .env.staging', () => {
    const policy = { ...TEST_POLICY, d_surfaces: ['.env*'] };
    const repo = createRepo(['.env.staging'], { policy });
    const m = runManifest(repo.dir, repo.home).manifest;
    expect(m.routing.d_surface_matches).toEqual(['.env.staging']);
    expect(m.routing.risk_tier).toBe('D');
  });

  test('manifest reuse refreshes run identity on an unchanged tree', () => {
    const repo = createRepo(['docs/notes.md']);
    const first = runManifest(repo.dir, repo.home, ['main', 'run-one']);
    const second = runManifest(repo.dir, repo.home, ['main', 'run-two']);
    expect(second.vars.MANIFEST_PATH).toBe(first.vars.MANIFEST_PATH);
    expect(JSON.parse(readFileSync(second.vars.MANIFEST_PATH, 'utf8')).run_id).toBe('run-two');
  });
});
