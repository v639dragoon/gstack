import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
/**
 * gstack-context-fence — PreToolUse hook that ENFORCES the context guard's
 * handoff line. Once bin/gstack-context-guard has written the session's
 * `.handoff` marker, this hook denies every NEW expensive dispatch — an Agent
 * spawn, a Codex invocation, a review-budget dispatch, a wrapped verification
 * lane, or a planning/review/ship skill — until a checkpoint newer than the
 * marker exists under $GSTACK_HOME/projects/<slug>/checkpoints/ (what
 * /context-save writes). Everything else stays allowed, so the active
 * operation can finish, the ledger can be edited and the checkpoint written;
 * running workers are never touched. Missing input or any failure is silent
 * and allows the call (fail-open, like every gstack hook).
 */
export const EXPENSIVE_TOOLS = ['Agent', 'Task'];
export const EXPENSIVE_SKILLS = /^(autoplan|ship|review|plan-(ceo|eng|design|devex)-review|design-review|design-consultation|design-shotgun|spec|qa|qa-only|investigate|codex|land-and-deploy)$/;
export const EXPENSIVE_BASH =
  /\bcodex\s+(exec|review)\b|gstack-review-budget\s+dispatch\b|gstack-evidence\s+run\b|gstack-claude-code\b/;
export function decide(
  tool: string,
  input: any,
  markerMtimeMs: number | null,
  newestCheckpointMs: number | null,
): string | null {
  if (markerMtimeMs === null) return null;
  if (newestCheckpointMs !== null && newestCheckpointMs > markerMtimeMs) return null;
  let expensive = false;
  if (EXPENSIVE_TOOLS.includes(tool)) expensive = true;
  else if (tool === 'Skill') expensive = EXPENSIVE_SKILLS.test(String(input?.skill ?? ''));
  else if (tool === 'Bash') {
    const cmd = String(input?.command ?? '');
    expensive = EXPENSIVE_BASH.test(cmd) && !/context-save|checkpoints\//.test(cmd);
  }
  if (!expensive) return null;
  return `CONTEXT GUARD: this session crossed the handoff threshold and no checkpoint has been written since. Finish the active operation, update the ledger, run /context-save (objective, acceptance criteria, completed, remaining, decisions, branch/worktree/commit, dirty changes, running workers, verification evidence, next action), then continue in a fresh session. New ${tool} dispatches are refused until that checkpoint exists.`;
}
function newestCheckpoint(dir: string): number | null {
  try {
    let newest: number | null = null;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const ms = fs.statSync(path.join(dir, f)).mtimeMs;
      if (newest === null || ms > newest) newest = ms;
    }
    return newest;
  } catch {
    return null;
  }
}
async function main() {
  try {
    const hook = JSON.parse(await Bun.stdin.text());
    if (typeof hook.session_id !== 'string' || !hook.session_id) return;
    const home =
      process.env.GSTACK_HOME || process.env.GSTACK_STATE_DIR || path.join(process.env.HOME || '/', '.gstack');
    const marker = path.join(
      home,
      'context-guard',
      `${hook.session_id.replace(/[^a-zA-Z0-9._-]/g, '_')}.handoff`,
    );
    let markerMs: number | null = null;
    try {
      markerMs = fs.statSync(marker).mtimeMs;
    } catch {
      return;
    }
    const cwd = typeof hook.cwd === 'string' && hook.cwd ? hook.cwd : process.cwd();
    const slugOut = spawnSync(path.join(path.dirname(Bun.fileURLToPath(import.meta.url)), 'gstack-slug'), {
      cwd,
      encoding: 'utf8',
      timeout: 4000,
      env: { ...process.env, GSTACK_HOME: home },
    }).stdout;
    const slug = /^SLUG=(.+)$/m.exec(slugOut || '')?.[1]?.trim();
    const ckpt = slug ? newestCheckpoint(path.join(home, 'projects', slug, 'checkpoints')) : null;
    const reason = decide(String(hook.tool_name ?? ''), hook.tool_input, markerMs, ckpt);
    if (!reason) return;
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }),
    );
  } catch {
    /* fail-open */
  }
}
if (import.meta.main) await main();
