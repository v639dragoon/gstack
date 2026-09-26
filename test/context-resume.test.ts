/** Context RESUME: after compact/resume the newest checkpoint is injected
 * (current branch first); after /clear only a fresh current-branch one is. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { CLEAR_MAX_AGE_MS, instruction, pick } from '../bin/gstack-context-resume.ts';
const resume = join(import.meta.dir, '..', 'bin', 'gstack-context-resume'),
  dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function ckpt(dir: string, name: string, branch: string, ageMs: number) {
  writeFileSync(join(dir, name), `---\nbranch: ${branch}\n---\n## Working on: ${name}\n`);
  const t = new Date(Date.now() - ageMs);
  utimesSync(join(dir, name), t, t);
  return join(dir, name);
}
describe('pick (pure)', () => {
  test('compact and resume prefer the current branch and fall back across branches', () => {
    const d = tmp('resume-ck-');
    const mine = ckpt(d, '20260101-mine.md', 'lane-a', 1000);
    const other = ckpt(d, '20260102-other.md', 'lane-b', 1000);
    expect(pick(d, 'lane-a', 'compact')).toBe(mine);
    expect(pick(d, 'lane-c', 'compact')).toBe(other);
    expect(pick(d, null, 'resume')).toBe(other);
  });
  test('clear takes only a fresh checkpoint saved on the current branch', () => {
    const d = tmp('resume-ck-');
    const mine = ckpt(d, '20260101-mine.md', 'lane-a', 60_000);
    ckpt(d, '20260102-other.md', 'lane-b', 1000);
    expect(pick(d, 'lane-a', 'clear')).toBe(mine);
    expect(pick(d, 'lane-c', 'clear')).toBeNull();
    expect(pick(d, null, 'clear')).toBeNull();
    ckpt(d, '20260101-mine.md', 'lane-a', CLEAR_MAX_AGE_MS + 60_000);
    expect(pick(d, 'lane-a', 'clear')).toBeNull();
  });
  test('the clear instruction runs /context-restore unless the user starts unrelated work', () => {
    expect(instruction('clear', 'x.md')).toContain('run /context-restore before anything else');
    expect(instruction('clear', 'x.md')).toContain('unrelated work');
    expect(instruction('compact', 'x.md')).toContain('CONTEXT RESUME (compact)');
  });
});
describe('resume hook end to end', () => {
  test('a /clear injects the current-branch checkpoint and stays silent without one', () => {
    const repo = tmp('resume-repo-'), state = tmp('resume-state-');
    for (const a of [['init', '-b', 'main'], ['config', 'user.email', 't@t'], ['config', 'user.name', 'T'], ['remote', 'add', 'origin', 'https://github.com/acme/widget.git']])
      spawnSync('git', a, { cwd: repo, timeout: 30_000 });
    writeFileSync(join(repo, 'x.ts'), 'x\n');
    spawnSync('git', ['add', '.'], { cwd: repo, timeout: 30_000 });
    spawnSync('git', ['commit', '-m', 'base'], { cwd: repo, timeout: 30_000 });
    const ck = join(state, 'projects', 'acme-widget', 'checkpoints');
    mkdirSync(ck, { recursive: true });
    const run = () =>
      spawnSync(resume, {
        timeout: 30_000,
        input: JSON.stringify({ source: 'clear', cwd: repo, session_id: 's' }),
        encoding: 'utf8',
        cwd: repo,
        env: { ...process.env, GSTACK_STATE_DIR: state },
      }).stdout;
    ckpt(ck, '20260102-other.md', 'lane-b', 1000);
    expect(run()).toBe('');
    ckpt(ck, '20260101-main.md', 'main', 1000);
    const out = run();
    expect(out).toContain('CONTEXT RESUME (clear)');
    expect(out).toContain('20260101-main.md');
    expect(out).toContain('Working on: 20260101-main.md');
  });
});
