/** Evidence reuse rules (harness pass 2026-09-15): a version-only package.json
 * change is allowed, a dependency/script change invalidates, the node
 * toolchain is bound, and a dirty tree never matches on commit alone. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { versionOnlyChange } from '../bin/gstack-evidence';
const bin = join(import.meta.dir, '..', 'bin', 'gstack-evidence'), dirs: string[] = [];
afterAll(() => dirs.forEach((x) => rmSync(x, { recursive: true, force: true })));
function setup() {
  const d = mkdtempSync(join(tmpdir(), 'ev-repo-')), s = mkdtempSync(join(tmpdir(), 'ev-state-'));
  dirs.push(d, s);
  for (const a of [['init', '-b', 'main'], ['config', 'user.email', 't@t'], ['config', 'user.name', 'T']])
    spawnSync('git', a, { cwd: d, timeout: 30_000 });
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'true' }, dependencies: { a: '1' } }, null, 2) + '\n');
  writeFileSync(join(d, 'x.ts'), 'x\n');
  spawnSync('git', ['add', '.'], { cwd: d, timeout: 30_000 });
  spawnSync('git', ['commit', '-m', 'base'], { cwd: d, timeout: 30_000 });
  return { d, s };
}
function ev(d: string, s: string, a: string[], env: any = {}) {
  return spawnSync(bin, a, { timeout: 60_000, cwd: d, encoding: 'utf8', env: { ...process.env, GSTACK_STATE_DIR: s, GIT_CONFIG_GLOBAL: '/dev/null', ...env } });
}
const CHECK = ['check', '--label', 'tests', '--expect-cmd', 'true', '--max-age', '24', '--allow-paths', 'CHANGELOG.md,VERSION', '--allow-version-only', 'package.json'];
describe('versionOnlyChange', () => {
  test('only a top-level version delta qualifies', () => {
    expect(versionOnlyChange('{"version":"1","a":1}', '{"a":1,"version":"2"}')).toBe(true);
    expect(versionOnlyChange('{"version":"1","a":1}', '{"version":"2","a":2}')).toBe(false);
    expect(versionOnlyChange('{"version":"1","scripts":{"t":"a"}}', '{"version":"2","scripts":{"t":"b"}}')).toBe(false);
    expect(versionOnlyChange('not json', '{"version":"2"}')).toBe(false);
    expect(versionOnlyChange('[1]', '[1]')).toBe(false);
  });
});
describe('gstack-evidence check bindings', () => {
  test('version bump stays FRESH; a dependency or script change goes STALE; a dirty tree on the same commit goes STALE', () => {
    const { d, s } = setup();
    expect(ev(d, s, ['run', '--label', 'tests', '--', 'true']).status).toBe(0);
    expect(ev(d, s, CHECK).stdout).toContain('EVIDENCE: FRESH');
    const pkg = JSON.parse(require('fs').readFileSync(join(d, 'package.json'), 'utf8'));
    writeFileSync(join(d, 'package.json'), JSON.stringify({ ...pkg, version: '1.0.1' }, null, 2) + '\n');
    const bumped = ev(d, s, CHECK);
    expect(bumped.stdout).toContain('EVIDENCE: FRESH');
    expect(bumped.status).toBe(0);
    writeFileSync(join(d, 'package.json'), JSON.stringify({ ...pkg, version: '1.0.1', dependencies: { a: '2' } }, null, 2) + '\n');
    const dep = ev(d, s, CHECK);
    expect(dep.stdout).toContain('EVIDENCE: STALE');
    expect(dep.stdout).toContain('package.json');
    writeFileSync(join(d, 'package.json'), JSON.stringify({ ...pkg, scripts: { test: 'vitest' } }, null, 2) + '\n');
    expect(ev(d, s, CHECK).stdout).toContain('EVIDENCE: STALE');
    writeFileSync(join(d, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    expect(ev(d, s, CHECK).stdout).toContain('EVIDENCE: FRESH');
    // Same commit, dirty source: the content fingerprint, not HEAD, decides.
    writeFileSync(join(d, 'x.ts'), 'y\n');
    expect(ev(d, s, CHECK).stdout).toContain('EVIDENCE: STALE');
  });
  test('toolchain binding: a record under another node runtime is STALE, an unbound record is STALE', () => {
    const { d, s } = setup();
    expect(ev(d, s, ['run', '--label', 'tests', '--', 'true']).status).toBe(0);
    expect(ev(d, s, CHECK).stdout).toContain('EVIDENCE: FRESH');
    const fake = mkdtempSync(join(tmpdir(), 'ev-node-'));
    dirs.push(fake);
    writeFileSync(join(fake, 'node'), '#!/bin/sh\necho v0.0.1-fake\n');
    require('fs').chmodSync(join(fake, 'node'), 0o755);
    const other = ev(d, s, CHECK, { PATH: `${fake}:${process.env.PATH}` });
    expect(other.stdout).toContain('EVIDENCE: STALE');
    expect(other.stdout).toContain('toolchain changed');
    const ledger = require('fs').readdirSync(join(s, 'projects')).map((p: string) => join(s, 'projects', p));
    const file = require('fs').readdirSync(ledger[0]).find((f: string) => f.endsWith('-evidence.jsonl'));
    const lines = require('fs').readFileSync(join(ledger[0], file), 'utf8').trim().split('\n');
    const rec = JSON.parse(lines.at(-1));
    delete rec.toolchain;
    writeFileSync(join(ledger[0], file), lines.slice(0, -1).concat(JSON.stringify(rec)).join('\n') + '\n');
    expect(ev(d, s, CHECK).stdout).toContain('no toolchain binding');
  });
});
