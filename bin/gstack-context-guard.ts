import * as fs from 'fs';
import * as path from 'path';
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
      process.env.GSTACK_HOME || path.join(process.env.HOME || '/', '.gstack'),
      'context-guard',
    );
    fs.mkdirSync(dir, { recursive: true });
    let kind: string | null = null,
      msg = '';
    if (tokens >= handoff) {
      kind = 'handoff';
      msg = `CONTEXT GUARD: ${tokens} tokens (>= ${Math.round(handoff / 1000)}k). Hand off now: update the ledger, run /context-save, and resume in a fresh session. Do not start a new review or worker in this session.`;
    } else if (tokens >= warn) {
      kind = 'warn';
      msg = `CONTEXT GUARD: ${tokens} tokens (>= ${Math.round(warn / 1000)}k). Update the plan ledger now (Completed / Remaining / Current SHA / Next action) and finish the current gate; plan the split at the next natural boundary.`;
    }
    if (!kind) return;
    const marker = path.join(dir, `${hook.session_id.replace(/[^a-zA-Z0-9._-]/g, '_')}.${kind}`);
    try {
      fs.writeFileSync(marker, '', { flag: 'wx' });
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
await main();
