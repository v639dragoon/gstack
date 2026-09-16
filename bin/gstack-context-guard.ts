import * as fs from 'fs';
import * as path from 'path';
/**
 * gstack-context-guard — PostToolUse hook. Reads the session transcript's
 * latest usage, and past GSTACK_CONTEXT_WARN / GSTACK_CONTEXT_HANDOFF tokens
 * emits ONE instruction per kind per session (marker files under
 * $GSTACK_HOME/context-guard/<session>.<kind>). The marker body records the
 * token count and time of the crossing; bin/gstack-context-fence reads the
 * `.handoff` marker to refuse a new expensive dispatch until a checkpoint
 * newer than the marker exists. Hook failures are silent by contract.
 */
export const CONTINUITY_FIELDS =
  'objective, acceptance criteria, completed work, remaining work, decisions, current branch/worktree and commit, dirty changes, running workers, verification evidence, next action';
export function messages(tokens: number, warn: number, handoff: number) {
  return {
    warn: `CONTEXT GUARD: ${tokens} tokens (>= ${Math.round(warn / 1000)}k). Refresh the task ledger now (Completed / Remaining / Current SHA / Next action) and prepare a compact checkpoint (/context-save) carrying: ${CONTINUITY_FIELDS}. Finish the current gate; plan the split at the next natural boundary.`,
    handoff: `CONTEXT GUARD: ${tokens} tokens (>= ${Math.round(handoff / 1000)}k). Hand off now: finish the active operation safely (never kill a running worker or discard an unfinished gate result), update the ledger, then run /context-save with: ${CONTINUITY_FIELDS}. Until that checkpoint exists, gstack-context-fence refuses any new worker, review, planning or Codex dispatch in this session. Resume in a fresh session from the checkpoint.`,
  };
}
async function main() {
  try {
    const hook = JSON.parse(await Bun.stdin.text());
    if (
      typeof hook.transcript_path !== 'string' ||
      typeof hook.session_id !== 'string' ||
      !hook.session_id
    )
      return;
    const fd = fs.openSync(hook.transcript_path, 'r'),
      size = fs.fstatSync(fd).size,
      n = Math.min(size, 256 * 1024),
      buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    if (size > n) lines.shift();
    let usage: any = null;
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        if (r?.message?.usage) usage = r.message.usage;
      } catch {}
    }
    if (!usage) return;
    const tokens =
      Number(usage.input_tokens || 0) +
      Number(usage.cache_creation_input_tokens || 0) +
      Number(usage.cache_read_input_tokens || 0);
    const warn = Number(process.env.GSTACK_CONTEXT_WARN || 250000),
      handoff = Number(process.env.GSTACK_CONTEXT_HANDOFF || 300000);
    const dir = path.join(
      process.env.GSTACK_HOME || process.env.GSTACK_STATE_DIR || path.join(process.env.HOME || '/', '.gstack'),
      'context-guard',
    );
    fs.mkdirSync(dir, { recursive: true });
    let kind: 'warn' | 'handoff' | null = null;
    if (tokens >= handoff) kind = 'handoff';
    else if (tokens >= warn) kind = 'warn';
    if (!kind) return;
    const msg = messages(tokens, warn, handoff)[kind];
    const marker = path.join(dir, `${hook.session_id.replace(/[^a-zA-Z0-9._-]/g, '_')}.${kind}`);
    try {
      fs.writeFileSync(marker, JSON.stringify({ tokens, ts: new Date().toISOString(), kind }) + '\n', { flag: 'wx' });
    } catch {
      return;
    }
    console.log(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
      }),
    );
  } catch {
    /* hook failures must be silent and never block Claude Code */
  }
}
if (import.meta.main) await main();
