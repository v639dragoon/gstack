/**
 * An AppleScript `activate` LAUNCHES an app that is not running. A browser
 * started that way carries none of Playwright's launch flags (no
 * --use-mock-keychain), so it reaches for the user's real keychain and macOS
 * raises a "Keychain Not Found" dialog. Every `to activate` in shipped source
 * must sit behind an `is running` guard on the same line, so raising a window
 * can never start one. Born clean: there is no allowlist.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..', '..');

function shippedSourceFiles(): string[] {
  const out = spawnSync('git', ['ls-files', '-z', '--', '*.ts', '*.js', '*.mjs', '*.sh', 'bin/*'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (out.status !== 0) throw new Error(`git ls-files failed: ${out.stderr}`);
  return out.stdout
    .split('\0')
    .filter(Boolean)
    .filter((f) => !/(^|\/)test\//.test(f) && !f.endsWith('.test.ts'));
}

describe('AppleScript activate never launches an app', () => {
  test('every `to activate` in shipped source is guarded by `is running`', () => {
    const offenders: string[] = [];
    for (const rel of shippedSourceFiles()) {
      const abs = path.join(ROOT, rel);
      if (!fs.statSync(abs).isFile()) continue;
      fs.readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
        if (/\bto activate\b/.test(line) && !/\bis running\b/.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
