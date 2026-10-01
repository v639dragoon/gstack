/** Born-clean prose contract for the deterministic review governor. */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SITES = [
  'ship/SKILL.md',
  ...fs.readdirSync(path.join(ROOT, 'ship/sections')).filter(f => f.endsWith('.md')).map(f => `ship/sections/${f}`),
  'review/SKILL.md',
  ...fs.readdirSync(path.join(ROOT, 'review/sections')).filter(f => f.endsWith('.md')).map(f => `review/sections/${f}`),
  'document-release/SKILL.md',
  ...fs.readdirSync(path.join(ROOT, 'document-release/sections')).filter(f => f.endsWith('.md')).map(f => `document-release/sections/${f}`),
];
const union = () => SITES.map(read).join('\n');

describe('review governor rendered prose', () => {
  test('subagent models are explicit and never Fable or Opus', () => {
    const text = union();
    expect(text).not.toMatch(/model:\s*["']?(?:fable|opus)/i);
    for (const root of ['ship/SKILL.md', 'review/SKILL.md', 'document-release/SKILL.md'])
      expect(read(root)).toContain('Every Agent/subagent call');
    for (const model of text.matchAll(/model:\s*["']([^"']+)["']/g))
      expect(['sonnet', 'haiku']).toContain(model[1]);
  });

  test('upstream dispatch, merge, QA and native adversarial contracts survive D4', () => {
    const text = union();
    expect(text).toContain('DIFF_LINES < 50');
    expect(text).toContain('DIFF_LINES > 200');
    expect(text).toContain('Collect and merge findings');
    expect(text).toContain('#### 7. Hand off to Fix-First');
    expect(text).toContain('adversarial subagent (always runs)');
    expect(text).toContain('Finish the adversarial phase');
    expect(text).toContain('upstream-specialist:<name>');
    expect(text).toContain('register-upstream "$RUN_ID" native-adversarial');
  });

  test('upstream and routed dispatches remain accounted and snapshot-bound', () => {
    const text = union();
    for (const gate of ['codex-structured', 'coverage-audit', 'plan-completion', 'doc-release', 'native-adversarial'])
      expect(text).toContain(`gstack-review-budget dispatch "$RUN_ID" ${gate}`);
    expect(text).toContain('manifest_wtree');
    expect(text).toContain('head_sha');
    expect(text).toContain('REPAIR_CYCLES_MAX');
    expect(text).toContain('rerun-check');
  });

  test('upstream AUTO-FIX and ASK advice handling wins over governor classification', () => {
    const text = union();
    expect(text).toContain('Auto-fix all AUTO-FIX');
    expect(text).toContain('advice ASK-only');
    expect(text).toContain("policy's BLOCKING/ADVISORY metadata never overrides upstream AUTO-FIX/ASK");
    expect(text).not.toContain('ADVISORY findings are NEVER fixed');
  });

  test('native completion is mandatory alongside all routed reviewers', () => {
    for (const root of ['ship', 'review']) {
      const text = [read(`${root}/SKILL.md`), ...fs.readdirSync(path.join(ROOT, root, 'sections'))
        .filter(f => f.endsWith('.md')).map(f => read(`${root}/sections/${f}`))].join('\n');
      expect(text).toContain('gstack-review-budget complete "$RUN_ID" --cycle <n>');
      expect(text).toContain('--require-native');
      expect(text).toContain('INCOMPLETE=');
      expect(text).toContain('STOP with a blocker report');
    }
  });

  test('deterministic gates remain present', () => {
    const ship = read('ship/SKILL.md') + read('ship/sections/tests.md') + read('ship/sections/pr-body.md');
    expect(ship).toMatch(/tests fail[\s\S]{0,120}STOP|STOP[\s\S]{0,120}tests fail/i);
    expect(ship).toContain('gitleaks');
    expect(ship).toContain('Scan-at-sink before sending'); // v1.84 wording of the redaction gate (was 'redaction scan-at-sink')
    expect(ship).toContain('## Step 16: Verification Gate');
    expect(union()).toMatch(/\[P1\][\s\S]{0,160}GATE: FAIL[\s\S]{0,180}AskUserQuestion/);
  });

  test('missing-outcome warning is verbatim', () => {
    expect(union()).toContain('Outcome metadata missing — treating this slice as FINAL (full release review at tier {TIER}). Set it with: ~/.claude/skills/gstack/bin/gstack-outcome set --id <id> --slice <n> [--final] [--flag-flip]');
  });
});
