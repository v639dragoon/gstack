/** Outside voices are routed, never inherited: policy -> GSTACK_CODEX_MODEL ->
 * project default, at the caller's effort, never above high. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
const bin = join(import.meta.dir, '..', 'bin', 'gstack-codex-model'), gate = join(import.meta.dir, '..', 'bin', 'gstack-gate-log'), dirs: string[] = [];
// A `codex` shim that fails every probe sits FIRST on PATH, so a named model
// always takes the deterministic no-auth fallback and the suite never touches
// the real CLI or the network.
const shim = mkdtempSync(join(tmpdir(), 'voice-shim-'));
dirs.push(shim);
writeFileSync(join(shim, 'codex'), '#!/bin/sh\nexit 1\n');
require('fs').chmodSync(join(shim, 'codex'), 0o755);
afterAll(() => dirs.forEach((x) => rmSync(x, { recursive: true, force: true })));
function repo(policy: any) {
  const d = mkdtempSync(join(tmpdir(), 'voice-'));
  dirs.push(d);
  spawnSync('git', ['init', '-b', 'main'], { cwd: d, timeout: 30_000 });
  mkdirSync(join(d, '.codex'));
  writeFileSync(join(d, '.codex', 'config.toml'), 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "medium"\n');
  if (policy) writeFileSync(join(d, '.gstack-policy.json'), JSON.stringify(policy));
  return d;
}
const kv = (out: string) => Object.fromEntries(out.trim().split('\n').map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^'|'$/g, '')]; }));
function resolve(d: string, args: string[], env: any = {}) {
  return spawnSync(bin, ['resolve', ...args], { cwd: d, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GSTACK_CODEX_MODEL: '', PATH: `${shim}:${process.env.PATH}`, ...env } });
}
describe('gstack-codex-model resolve --voice', () => {
  test('unrouted voice = project default at medium, never the frontier model', () => {
    const r = kv(resolve(repo(null), ['--voice', 'design-review']).stdout);
    expect(r.CODEX_MODEL).toBe('gpt-5.6-sol');
    expect(r.CODEX_MODEL_SOURCE).toBe('default');
    expect(r.CODEX_MODEL_EXEC_FLAGS).toBe('');
    expect(r.CODEX_EFFORT).toBe('medium');
    expect(r.CODEX_VOICE).toBe('design-review');
  });
  test('policy names model and effort per voice; no CLI -> logged fallback to the default route', () => {
    const d = repo({ version: 1, routing: { models: { 'outside-voice': { 'design-review': { model: 'gpt-6-astra', effort: 'high' }, 'plan-review': { effort: 'low' } } } } });
    const r = resolve(d, ['--voice', 'design-review']);
    const v = kv(r.stdout);
    expect(v.CODEX_MODEL_REQUESTED).toBe('gpt-6-astra');
    expect(v.CODEX_EFFORT).toBe('high');
    expect(v.CODEX_MODEL_SOURCE).toBe('fallback');
    expect(v.CODEX_MODEL).toBe('gpt-5.6-sol');
    expect(v.CODEX_MODEL_SUBSTITUTED).toBe('true');
    const p = kv(resolve(d, ['--voice', 'plan-review']).stdout);
    expect(p.CODEX_EFFORT).toBe('low');
    expect(p.CODEX_MODEL_SOURCE).toBe('default');
  });
  test('a policy effort above high is refused, like --effort', () => {
    const d = repo({ version: 1, routing: { models: { 'outside-voice': { spec: { effort: 'xhigh' } } } } });
    expect(resolve(d, ['--voice', 'spec']).status).toBe(1);
    expect(resolve(repo(null), ['--voice', 'spec', '--effort', 'ultra']).status).toBe(1);
    expect(resolve(repo(null), ['--voice', '../x']).status).toBe(1);
  });
  test('GSTACK_CODEX_MODEL applies only when the policy names nothing (source env)', () => {
    const r = kv(resolve(repo(null), ['--voice', 'autoplan'], { GSTACK_CODEX_MODEL: 'custom-codex' }).stdout);
    expect(r.CODEX_MODEL_REQUESTED).toBe('custom-codex');
    expect(r.CODEX_MODEL_SOURCE).toBe('fallback');
  });
});
describe('gate-log outside-voice records', () => {
  test('require purpose/model/effort/status; a policy-routed Astra voice needs no model_reason, an env one does', () => {
    const d = repo(null), s = mkdtempSync(join(tmpdir(), 'voice-state-'));
    dirs.push(s);
    const log = (rec: any) => spawnSync(gate, [JSON.stringify(rec)], { cwd: d, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GSTACK_HOME: s } });
    const base = { record_type: 'gate', run_id: 'r', gate: 'outside-voice:design-review', purpose: 'design-review', model: 'gpt-5.6-sol', effort: 'medium', status: 'completed' };
    expect(log(base).status).toBe(0);
    expect(log({ ...base, status: 'partial' }).status).toBe(1);
    expect(log({ ...base, model: undefined }).status).toBe(1);
    expect(log({ ...base, model: 'gpt-6-astra', model_source: 'policy' }).status).toBe(0);
    expect(log({ ...base, model: 'gpt-6-astra', model_source: 'env' }).status).toBe(1);
    expect(log({ ...base, model: 'gpt-6-astra', model_source: 'env', model_reason: 'founder asked' }).status).toBe(0);
  });
});
