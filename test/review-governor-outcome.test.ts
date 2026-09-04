import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
const root = join(import.meta.dir, '..'),
  bin = join(root, 'bin', 'gstack-outcome'),
  dirs: string[] = [];
function repo() {
  const d = mkdtempSync(join(tmpdir(), 'outcome-')),
    s = mkdtempSync(join(tmpdir(), 'outcome-state-'));
  dirs.push(d, s);
  for (const a of [
    ['init', '-b', 'main'],
    ['config', 'user.email', 't@t'],
    ['config', 'user.name', 'T'],
    ['checkout', '-b', 'feature-one'],
  ])
    spawnSync('git', a, { cwd: d, timeout: 30_000 });
  return { d, s };
}
function run(d: string, s: string, a: string[]) {
  return spawnSync(bin, a, {
    timeout: 30_000,
    cwd: d,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GSTACK_STATE_DIR: s },
  });
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
describe('gstack-outcome', () => {
  test('set/show/clear and validation', () => {
    const { d, s } = repo();
    expect(
      run(d, s, ['set', '--id', 'launch-1', '--slice', '2', '--final', '--tier', 'C']).status,
    ).toBe(0);
    const shown = JSON.parse(run(d, s, ['show', '--json']).stdout);
    expect(shown).toEqual({
      present: true,
      outcome_id: 'launch-1',
      slice_number: 2,
      is_final_slice: true,
      is_flag_flip: false,
      risk_tier_override: 'C',
    });
    expect(run(d, s, ['record-session', '--id', 'launch-1', '--session', 'abc']).status).toBe(0);
    expect(run(d, s, ['clear']).status).toBe(0);
    expect(JSON.parse(run(d, s, ['show', '--json']).stdout).present).toBe(false);
    expect(run(d, s, ['set', '--id', 'BAD', '--slice', '0']).status).toBe(1);
  });
});
