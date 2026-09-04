import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
const root = join(import.meta.dir, '..'),
  bin = join(root, 'bin', 'gstack-context-guard'),
  dirs: string[] = [];
function go(tokens: number, session = 's') {
  const d = mkdtempSync(join(tmpdir(), 'guard-'));
  dirs.push(d);
  const t = join(d, 't.jsonl');
  writeFileSync(
    t,
    JSON.stringify({
      type: 'assistant',
      message: {
        usage: { input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }) + '\n',
  );
  const run = () =>
    spawnSync(bin, {
      timeout: 30_000,
      input: JSON.stringify({ transcript_path: t, session_id: session }),
      encoding: 'utf8',
      env: {
        ...process.env,
        GSTACK_STATE_DIR: d,
        GSTACK_CONTEXT_WARN: '100',
        GSTACK_CONTEXT_HANDOFF: '200',
      },
    });
  return { run, d };
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
describe('context guard', () => {
  test('below is silent, warn and handoff emit once, garbage is silent', () => {
    expect(go(99).run().stdout).toBe('');
    const w = go(100);
    expect(w.run().stdout).toContain('CONTEXT GUARD');
    expect(w.run().stdout).toBe('');
    const h = go(200);
    expect(h.run().stdout).toContain('Hand off now');
    expect(h.run().stdout).toBe('');
    expect(spawnSync(bin, { input: 'garbage', encoding: 'utf8', timeout: 30_000 }).stdout).toBe('');
  });
});
