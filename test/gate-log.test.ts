import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Phase 0 PR-gating telemetry: gstack-gate-log writes ONE record per gate
// INVOCATION to <branch>-gates.jsonl — a sibling of <branch>-reviews.jsonl,
// deliberately a separate file so per-invocation rows stay invisible to
// gstack-review-read (dashboard context volume) and gstack-specialist-stats
// (globs *-reviews.jsonl) by construction. These tests pin both the writer's
// contract AND that reader isolation.

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

let tmpDir: string;
let slugDir: string;

function run(input: string, opts: { expectFail?: boolean; env?: Record<string,string> } = {}): { stdout: string; stderr: string; exitCode: number } {
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    cwd: ROOT,
    env: { ...process.env, GSTACK_HOME: tmpDir, ...opts.env },
    encoding: 'utf-8',
    timeout: 10000,
  };
  try {
    const stdout = execSync(`${BIN}/gstack-gate-log '${input.replace(/'/g, "'\\''")}'`, { ...execOpts, timeout: 30_000 }).trim();
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e: any) {
    if (opts.expectFail) {
      return { stdout: e.stdout?.toString() || '', stderr: e.stderr?.toString() || '', exitCode: e.status || 1 };
    }
    throw e;
  }
}

function gatesFiles(): string[] {
  const found: string[] = [];
  if (!fs.existsSync(slugDir)) return found;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('-gates.jsonl')) found.push(p);
    }
  };
  walk(slugDir);
  return found;
}

function readNewestRecord(): any {
  const files = gatesFiles();
  expect(files.length).toBeGreaterThan(0);
  const content = fs.readFileSync(files[0], 'utf-8').trim();
  const lines = content.split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

const VALID = '{"record_type":"gate","gate":"specialist:security","run_id":"123-456","trigger":"SCOPE_AUTH=true","verdict":"clean"}';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gatelog-'));
  slugDir = path.join(tmpDir, 'projects');
  fs.mkdirSync(slugDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('gstack-gate-log', () => {
  test('appends a valid gate record to a -gates.jsonl file (never -reviews.jsonl)', () => {
    const result = run(VALID);
    expect(result.exitCode).toBe(0);

    const rec = readNewestRecord();
    expect(rec.record_type).toBe('gate');
    expect(rec.gate).toBe('specialist:security');
    expect(rec.run_id).toBe('123-456');
    expect(rec.trigger).toBe('SCOPE_AUTH=true');

    // The reviews file must NOT gain a row from a gate-log call.
    const projectDirs = fs.readdirSync(slugDir);
    const projectDir = path.join(slugDir, projectDirs[0]);
    const reviewFiles = fs.readdirSync(projectDir).filter((f) => f.endsWith('-reviews.jsonl'));
    expect(reviewFiles.length).toBe(0);
  });

  test('effort xhigh/ultra without a user-override source is refused (never automatic)', () => {
    for (const effort of ['xhigh', 'ultra']) {
      const r = run(JSON.stringify({ record_type: 'gate', gate: 'codex-structured', run_id: 'r-ultra', effort, effort_source: 'routed' }), { expectFail: true });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr + r.stdout).toContain('requires effort_source "user-override"');
    }
    expect(gatesFiles().length).toBe(0);
    const ok = run(JSON.stringify({ record_type: 'gate', gate: 'codex-structured', run_id: 'r-ultra', effort: 'ultra', effort_source: 'user-override', effort_reason: 'founder escalation: final adversarial on a migration' }));
    expect(ok.exitCode).toBe(0);
    expect(gatesFiles().length).toBe(1);
  });

  test('rejects non-JSON input with non-zero exit code and writes nothing', () => {
    const result = run('not json at all', { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(gatesFiles().length).toBe(0);
  });

  test('rejects a record whose record_type is not "gate" (discriminator guard)', () => {
    const result = run('{"record_type":"review","gate":"red-team","run_id":"1-2"}', { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('record_type');
    expect(gatesFiles().length).toBe(0);
  });

  test('rejects a record missing gate or run_id', () => {
    const noGate = run('{"record_type":"gate","run_id":"1-2"}', { expectFail: true });
    expect(noGate.exitCode).not.toBe(0);
    expect(noGate.stderr).toContain('gate');

    const noRun = run('{"record_type":"gate","gate":"red-team"}', { expectFail: true });
    expect(noRun.exitCode).not.toBe(0);
    expect(noRun.stderr).toContain('run_id');

    expect(gatesFiles().length).toBe(0);
  });

  test('effort_source "user-override" without a non-empty effort_reason is REJECTED (no implicit xhigh)', () => {
    const missing = run(
      '{"record_type":"gate","gate":"codex-adversarial","run_id":"1-2","effort":"xhigh","effort_source":"user-override"}',
      { expectFail: true },
    );
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain('effort_reason');

    const blank = run(
      '{"record_type":"gate","gate":"codex-adversarial","run_id":"1-2","effort":"xhigh","effort_source":"user-override","effort_reason":"  "}',
      { expectFail: true },
    );
    expect(blank.exitCode).not.toBe(0);
    expect(gatesFiles().length).toBe(0);

    const withReason = run(
      '{"record_type":"gate","gate":"codex-adversarial","run_id":"1-2","effort":"xhigh","effort_source":"user-override","effort_reason":"user --xhigh flag"}',
      );
    expect(withReason.exitCode).toBe(0);
    const rec = readNewestRecord();
    expect(rec.effort_reason).toBe('user --xhigh flag');
  });

  test('routed/default effort_source needs no reason', () => {
    const result = run('{"record_type":"gate","gate":"codex-doc-voice","run_id":"1-2","effort":"medium","effort_source":"routed"}');
    expect(result.exitCode).toBe(0);
    expect(readNewestRecord().effort_source).toBe('routed');
  });

  test('stamps authoritative binding fields; caller-supplied ones are IGNORED', () => {
    const forged =
      '{"record_type":"gate","gate":"red-team","run_id":"1-2","wtree":"forged","tree":"forged","commit_full":"forged","dirty":"forged"}';
    const result = run(forged);
    expect(result.exitCode).toBe(0);
    const rec = readNewestRecord();
    expect(rec.commit_full).toMatch(/^[0-9a-f]{40}$/);
    expect(rec.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(rec.wtree).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof rec.dirty).toBe('boolean');
    expect(rec.wtree).not.toBe('forged');
  });

  test('arbitrary extra fields (shadow verdicts, tokens, findings) pass through untouched', () => {
    const input = JSON.stringify({
      record_type: 'gate',
      gate: 'doc-release',
      run_id: '1-2',
      findings: { critical: 1, informational: 4, p1: 0 },
      tokens: { total: 41230, source: 'codex-stderr' },
      shadow: { risk_tier: 'D', auth_disagreement: true, redispatch_would_skip: false },
      fix_cycle: 2,
      rerun_cause: 'fix-loop',
      critical_path: true,
    });
    const result = run(input);
    expect(result.exitCode).toBe(0);
    const rec = readNewestRecord();
    expect(rec.findings).toEqual({ critical: 1, informational: 4, p1: 0 });
    expect(rec.tokens).toEqual({ total: 41230, source: 'codex-stderr' });
    expect(rec.shadow).toEqual({ risk_tier: 'D', auth_disagreement: true, redispatch_would_skip: false });
    expect(rec.fix_cycle).toBe(2);
    expect(rec.rerun_cause).toBe('fix-loop');
    expect(rec.critical_path).toBe(true);
  });

  test('stamps outcome identity and manifest routing tier, ignoring caller values', () => {
    const branch = execSync('git branch --show-current', { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).trim();
    const manifestDir = path.join(tmpDir, 'projects', 'governor-test', 'manifests');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, 'abc123.json'), JSON.stringify({ routing: { risk_tier: 'C' } }));
    const keys: Record<string,string> = {
      GSTACK_PROJECT_SLUG: 'governor-test', GIT_CONFIG_COUNT: '5',
      GIT_CONFIG_KEY_0: `branch.${branch}.gstackOutcomeId`, GIT_CONFIG_VALUE_0: 'launch-1',
      GIT_CONFIG_KEY_1: `branch.${branch}.gstackOutcomeSlice`, GIT_CONFIG_VALUE_1: '2',
      GIT_CONFIG_KEY_2: `branch.${branch}.gstackOutcomeFinal`, GIT_CONFIG_VALUE_2: 'false',
      GIT_CONFIG_KEY_3: `branch.${branch}.gstackOutcomeFlagFlip`, GIT_CONFIG_VALUE_3: 'false',
      GIT_CONFIG_KEY_4: `branch.${branch}.gstackOutcomeTier`, GIT_CONFIG_VALUE_4: 'C',
    };
    expect(run('{"record_type":"gate","gate":"codex-structured","run_id":"r","manifest_wtree":"abc123","outcome_id":"forged","outcome_slice":99,"risk_tier":"A"}', { env: keys }).exitCode).toBe(0);
    const rec = readNewestRecord();
    expect(rec.outcome_id).toBe('launch-1'); expect(rec.outcome_slice).toBe(2); expect(rec.risk_tier).toBe('C');
  });

  // Derived/defaulted fields (the payload-compression change): the five call
  // sites stopped hand-substituting `commit`, `diff_scope` and `critical_path`
  // because the writer can supply all three. Each must be DERIVED when absent
  // and OVERRIDABLE when present — a default that ignores an explicit value
  // would silently mislabel a non-critical-path gate as blocking.
  test('derives commit from HEAD when the caller omits it', () => {
    expect(run(VALID).exitCode).toBe(0);
    const rec = readNewestRecord();
    expect(rec.commit).toMatch(/^[0-9a-f]{7,40}$/);
    // and it must agree with the authoritative full stamp it is derived from
    expect(rec.commit_full.startsWith(rec.commit)).toBe(true);
  });

  test('an explicit commit WINS over the derived one', () => {
    const input = '{"record_type":"gate","gate":"red-team","run_id":"1-2","commit":"deadbee"}';
    expect(run(input).exitCode).toBe(0);
    expect(readNewestRecord().commit).toBe('deadbee');
  });

  test('defaults diff_scope to "full" and critical_path to true when omitted', () => {
    expect(run(VALID).exitCode).toBe(0);
    const rec = readNewestRecord();
    expect(rec.diff_scope).toBe('full');
    expect(rec.critical_path).toBe(true);
  });

  test('REGRESSION: an explicit critical_path:false / diff_scope survives the default', () => {
    const input =
      '{"record_type":"gate","gate":"red-team","run_id":"1-2","critical_path":false,"diff_scope":"scoped"}';
    expect(run(input).exitCode).toBe(0);
    const rec = readNewestRecord();
    // A default that clobbered these would record a non-blocking, narrowly
    // scoped gate as a full-diff blocking one — silently wrong telemetry.
    expect(rec.critical_path).toBe(false);
    expect(rec.diff_scope).toBe('scoped');
  });

  test('manifest_wtree is NOT derived — it stays absent when the caller omits it', () => {
    // Deliberate asymmetry: manifest_wtree records the worktree the MANIFEST
    // was built in, while the log-time worktree is already stamped as `wtree`.
    // Deriving it would make the two always agree and destroy the only signal
    // that a manifest came from a different tree than the gate it logs.
    expect(run(VALID).exitCode).toBe(0);
    const rec = readNewestRecord();
    expect(rec.manifest_wtree).toBeUndefined();
    expect(rec.wtree).toMatch(/^[0-9a-f]{40}$/);
  });

  // The reader-isolation contract: gate records must be INVISIBLE to the two
  // existing reviews.jsonl consumers. This is the design's load-bearing claim
  // (separate file ⇒ isolation by construction) — pin it, don't assume it.
  test('gate records are invisible to gstack-specialist-stats and gstack-review-read', () => {
    // Write gate rows that would confuse specialist-stats if it saw them.
    run('{"record_type":"gate","gate":"specialist:security","run_id":"1-2","specialists":{"security":{"dispatched":true,"findings":9}}}');
    run(VALID);
    expect(gatesFiles().length).toBeGreaterThan(0);

    const execOpts: ExecSyncOptionsWithStringEncoding = {
      cwd: ROOT,
      env: { ...process.env, GSTACK_HOME: tmpDir },
      encoding: 'utf-8',
      timeout: 10000,
    };
    const stats = execSync(`${BIN}/gstack-specialist-stats`, { ...execOpts, timeout: 30_000 });
    expect(stats).toContain('SPECIALIST_STATS: 0 reviews analyzed');

    const reviewRead = execSync(`${BIN}/gstack-review-read`, { ...execOpts, timeout: 30_000 });
    expect(reviewRead).not.toContain('"record_type":"gate"');
  });
});
