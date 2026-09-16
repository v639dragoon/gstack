import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
/**
 * gstack-context-resume — SessionStart hook (matcher: compact|resume). After
 * an auto-compaction or a resumed session it injects the head of the newest
 * checkpoint for this project (what /context-save wrote, current branch
 * first) so the continuity fields survive the summary without a manual
 * /context-restore. Silent when there is no checkpoint. Bounded to
 * MAX_LINES so the injection never becomes its own context problem.
 */
export const MAX_LINES = 60;
export function pick(dir: string, branch: string | null): string | null {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().reverse();
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  if (branch) {
    for (const f of files.slice(0, 20)) {
      const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 2000);
      const m = /^branch:\s*["']?([^"'\n]+)["']?\s*$/m.exec(head);
      if (m && m[1].trim() === branch) return path.join(dir, f);
    }
  }
  return path.join(dir, files[0]);
}
async function main() {
  try {
    const hook = JSON.parse(await Bun.stdin.text());
    const home =
      process.env.GSTACK_HOME || process.env.GSTACK_STATE_DIR || path.join(process.env.HOME || '/', '.gstack');
    const cwd = typeof hook.cwd === 'string' && hook.cwd ? hook.cwd : process.cwd();
    const slugOut = spawnSync(path.join(path.dirname(Bun.fileURLToPath(import.meta.url)), 'gstack-slug'), {
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
    const file = pick(path.join(home, 'projects', slug, 'checkpoints'), branch);
    if (!file) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const body = lines.slice(0, MAX_LINES).join('\n') + (lines.length > MAX_LINES ? '\n[...]' : '');
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `CONTEXT RESUME (${hook.source ?? 'start'}): newest checkpoint ${file}. Continue from its Remaining Work and next action; run /context-restore for the full text.\n\n${body}`,
        },
      }),
    );
  } catch {
    /* fail-open */
  }
}
if (import.meta.main) await main();
