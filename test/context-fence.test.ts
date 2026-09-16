/** Context handoff ENFORCEMENT: past the handoff marker, a new expensive
 * dispatch is refused until a checkpoint newer than the marker exists. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { decide } from '../bin/gstack-context-fence.ts';
const root = join(import.meta.dir, '..'),
  fence = join(root, 'bin', 'gstack-context-fence'),
  guard = join(root, 'bin', 'gstack-context-guard'),
  dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function repo() {
  const d = mkdtempSync(join(tmpdir(), 'fence-repo-'));
  dirs.push(d);
  for (const a of [['init', '-b', 'main'], ['config', 'user.email', 't@t'], ['config', 'user.name', 'T'], ['remote', 'add', 'origin', 'https://github.com/acme/widget.git']])
    spawnSync('git', a, { cwd: d, timeout: 30_000 });
  writeFileSync(join(d, 'x.ts'), 'x\n');
  spawnSync('git', ['add', '.'], { cwd: d, timeout: 30_000 });
  spawnSync('git', ['commit', '-m', 'base'], { cwd: d, timeout: 30_000 });
  return d;
}
function run(bin: string, input: any, state: string, cwd: string) {
  return spawnSync(bin, {
    timeout: 30_000,
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    env: { ...process.env, GSTACK_STATE_DIR: state, GSTACK_CONTEXT_WARN: '100', GSTACK_CONTEXT_HANDOFF: '200' },
  });
}
describe('decide (pure)', () => {
  test('no marker allows everything; a newer checkpoint lifts the fence', () => {
    expect(decide('Agent', {}, null, null)).toBeNull();
    expect(decide('Agent', {}, 1000, 2000)).toBeNull();
  });
  test('expensive tools are refused past the marker, ordinary work is not', () => {
    expect(decide('Agent', {}, 1000, null)).toContain('CONTEXT GUARD');
    expect(decide('Agent', {}, 1000, 900)).toContain('refused');
    expect(decide('Skill', { skill: 'ship' }, 1000, null)).toContain('CONTEXT GUARD');
    expect(decide('Skill', { skill: 'context-save' }, 1000, null)).toBeNull();
    expect(decide('Bash', { command: 'codex exec "x" -s read-only' }, 1000, null)).toContain('CONTEXT GUARD');
    expect(decide('Bash', { command: '~/.claude/skills/gstack/bin/gstack-review-budget dispatch "$RUN_ID" codex-structured' }, 1000, null)).toContain('CONTEXT GUARD');
    expect(decide('Bash', { command: 'gstack-evidence run --label tests -- npm test' }, 1000, null)).toContain('CONTEXT GUARD');
    expect(decide('Bash', { command: 'git status' }, 1000, null)).toBeNull();
    expect(decide('Edit', { file_path: 'plan.md' }, 1000, null)).toBeNull();
    expect(decide('Write', { file_path: 'checkpoints/x.md' }, 1000, null)).toBeNull();
  });
});
describe('fence + guard end to end', () => {
  test('guard writes a marker with the token count; fence denies until /context-save writes a checkpoint', () => {
    const d = repo(), state = mkdtempSync(join(tmpdir(), 'fence-state-'));
    dirs.push(state);
    const t = join(state, 't.jsonl');
    writeFileSync(t, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 250, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + '\n');
    const g = run(guard, { transcript_path: t, session_id: 'sess1' }, state, d);
    expect(g.stdout).toContain('Hand off now');
    expect(g.stdout).toContain('running workers');
    const marker = JSON.parse(require('fs').readFileSync(join(state, 'context-guard', 'sess1.handoff'), 'utf8'));
    expect(marker.tokens).toBe(250);
    const hook = { session_id: 'sess1', cwd: d, tool_name: 'Agent', tool_input: { prompt: 'review' } };
    const denied = run(fence, hook, state, d);
    expect(denied.stdout).toContain('"permissionDecision":"deny"');
    expect(run(fence, { ...hook, tool_name: 'Bash', tool_input: { command: 'git diff' } }, state, d).stdout).toBe('');
    // Another session is untouched.
    expect(run(fence, { ...hook, session_id: 'other' }, state, d).stdout).toBe('');
    // A checkpoint OLDER than the marker does not lift it; a newer one does.
    const ck = join(state, 'projects', 'acme-widget', 'checkpoints');
    mkdirSync(ck, { recursive: true });
    writeFileSync(join(ck, '20260101-old.md'), 'branch: main\n');
    utimesSync(join(ck, '20260101-old.md'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(run(fence, hook, state, d).stdout).toContain('deny');
    writeFileSync(join(ck, '20260915-new.md'), 'branch: main\n');
    utimesSync(join(ck, '20260915-new.md'), new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    expect(run(fence, hook, state, d).stdout).toBe('');
    // Garbage input is silent (fail-open).
    expect(spawnSync(fence, { input: 'garbage', encoding: 'utf8', timeout: 30_000 }).stdout).toBe('');
  });
});
