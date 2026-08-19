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

function run(input: string, opts: { expectFail?: boolean } = {}): { stdout: string; stderr: string; exitCode: number } {
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    cwd: ROOT,
    env: { ...process.env, GSTACK_HOME: tmpDir },
    encoding: 'utf-8',
    timeout: 10000,
  };
  try {
    const stdout = execSync(`${BIN}/gstack-gate-log '${input.replace(/'/g, "'\\''")}'`, execOpts).trim();
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
    const stats = execSync(`${BIN}/gstack-specialist-stats`, execOpts);
    expect(stats).toContain('SPECIALIST_STATS: 0 reviews analyzed');

    const reviewRead = execSync(`${BIN}/gstack-review-read`, execOpts);
    expect(reviewRead).not.toContain('"record_type":"gate"');
  });
});
