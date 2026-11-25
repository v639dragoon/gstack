import { resolveStateRoot } from '../lib/state-root';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runScriptSync } from '../lib/script-invocation';
/**
 * gstack-context-resume — SessionStart hook (matcher: compact|resume|clear).
 * After an auto-compaction or a resumed session it injects the head of the
 * newest checkpoint for this project (what /context-save wrote, current
 * branch first) so the continuity fields survive the summary without a manual
 * /context-restore. After a /clear it is stricter, because /clear also starts
 * unrelated work and parallel worktrees share one checkpoint directory: only a
 * checkpoint saved on the CURRENT branch within CLEAR_MAX_AGE_MS qualifies,
 * with no cross-branch fallback. Silent when nothing qualifies. Bounded to
 * MAX_LINES so the injection never becomes its own context problem.
 */
export const MAX_LINES = 60;
// dohma's .claude/settings.json greps this file for the line-start declaration
// below (a comment naming the constant does not match) before wiring /clear to
// this hook, so an older install never sees /clear. Renaming or reformatting
// that line silently turns the /clear restore off there.
export const CLEAR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export function pick(dir: string, branch: string | null, source?: string, now = Date.now()): string | null {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().reverse();
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const clear = source === 'clear';
  if (clear && !branch) return null;
  if (branch) {
    for (const f of files.slice(0, 20)) {
      const full = path.join(dir, f);
      const head = fs.readFileSync(full, 'utf8').slice(0, 2000);
      const m = /^branch:\s*["']?([^"'\n]+)["']?\s*$/m.exec(head);
      if (!m || m[1].trim() !== branch) continue;
      if (clear && now - fs.statSync(full).mtimeMs > CLEAR_MAX_AGE_MS) return null;
      return full;
    }
  }
  return clear ? null : path.join(dir, files[0]);
}
// The restore skill's installed command: `gstack-context-restore` under
// `./setup --prefix`, `context-restore` otherwise. Read from the name: line of
// the checkout's context-restore/SKILL.md, which setup patches in prefix mode,
// so the cue never names a command the host did not register.
export function restoreCommand(root: string): string {
  try {
    const m = /^name:\s*([A-Za-z0-9_-]+)\s*$/m.exec(fs.readFileSync(path.join(root, 'context-restore', 'SKILL.md'), 'utf8').slice(0, 2000));
    if (m) return m[1];
  } catch {
    /* fall through to the plain name */
  }
  return 'context-restore';
}
export function instruction(source: string | undefined, file: string, command = 'context-restore'): string {
  if (source === 'clear')
    return `CONTEXT RESUME (clear): the newest checkpoint for this branch is ${file}. Unless the user's first message clearly starts unrelated work, run /${command} before anything else and continue from its Remaining Work and next action.`;
  return `CONTEXT RESUME (${source ?? 'start'}): newest checkpoint ${file}. Continue from its Remaining Work and next action; run /${command} for the full text.`;
}
async function main() {
  try {
    const hook = JSON.parse(await Bun.stdin.text());
    const home =
      resolveStateRoot();
    const cwd = typeof hook.cwd === 'string' && hook.cwd ? hook.cwd : process.cwd();
    const slugOut = runScriptSync(path.join(path.dirname(Bun.fileURLToPath(import.meta.url)), 'gstack-slug'), [], {
      cwd,
      encoding: 'utf8',
      timeout: 4000,
      env: { ...process.env, GSTACK_HOME: home },
    }).stdout;
    const slug = /^SLUG=(.+)$/m.exec(slugOut || '')?.[1]?.trim();
    if (!slug) return;
    const branch =
      spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', timeout: 4000 }).stdout?.trim() ||
      null;
    const file = pick(path.join(home, 'projects', slug, 'checkpoints'), branch, hook.source);
    if (!file) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const body = lines.slice(0, MAX_LINES).join('\n') + (lines.length > MAX_LINES ? '\n[...]' : '');
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `${instruction(hook.source, file, restoreCommand(path.dirname(path.dirname(Bun.fileURLToPath(import.meta.url)))))}\n\n${body}`,
        },
      }),
    );
  } catch {
    /* fail-open */
  }
}
if (import.meta.main) await main();
