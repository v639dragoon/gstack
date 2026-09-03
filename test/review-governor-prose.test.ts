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

  test('LOC triggers and removed adversarial pass are absent', () => {
    const text = union();
    expect(text).not.toContain('DIFF_LINES > 200');
    expect(text).not.toContain('DIFF_LINES < 50');
    expect(text).not.toContain('Early Red Team');
  });

  test('all governed dispatches name their budget gate first', () => {
    const text = union();
    expect(text).toContain('gstack-review-budget dispatch "$RUN_ID" <gate> --cycle <n>');
    for (const gate of ['codex-structured', 'coverage-audit', 'plan-completion', 'doc-release']) {
      expect(text).toContain(`gstack-review-budget dispatch "$RUN_ID" ${gate}`);
    }
  });

  test('advisories and bounded delta repair are explicit', () => {
    const text = union();
    expect(text).toContain('ADVISORY findings are NEVER fixed');
    expect(text).toContain('MAX_ADVISORIES');
    expect(text).toContain('## Advisories (not fixed)');
    expect(text).toContain('REPAIR_CYCLES_MAX');
    expect(text).toContain('rerun-check');
    expect(text).toContain('--verify-of <fingerprint>');
    expect(text).not.toContain('<sha-before-fixes>');
    expect(text).toContain('BLOCKING_CATEGORIES');
  });

  test('reviewer verdicts and completion fail closed in ship and review', () => {
    for (const root of ['ship', 'review']) {
      const text = [read(`${root}/SKILL.md`), ...fs.readdirSync(path.join(ROOT, root, 'sections'))
        .filter(f => f.endsWith('.md')).map(f => read(`${root}/sections/${f}`))].join('\n');
      expect(text).toContain('gstack-review-budget verdict "$RUN_ID"');
      expect(text).toContain('gstack-review-budget complete "$RUN_ID" --cycle <n>');
      expect(text).toContain('INCOMPLETE=');
      expect(text).toMatch(/INCOMPLETE=[\s\S]{0,180}STOP with a blocker report/);
      expect(text).toContain('--cycle <n>');
    }
  });

  test('deterministic gates remain present', () => {
    const ship = read('ship/SKILL.md') + read('ship/sections/tests.md') + read('ship/sections/pr-body.md');
    expect(ship).toMatch(/tests fail[\s\S]{0,120}STOP|STOP[\s\S]{0,120}tests fail/i);
    expect(ship).toContain('gitleaks');
    expect(ship).toContain('redaction scan-at-sink');
    expect(ship).toContain('verification gate');
    expect(union()).toMatch(/\[P1\][\s\S]{0,160}GATE: FAIL[\s\S]{0,180}AskUserQuestion/);
  });

  test('missing-outcome warning is verbatim', () => {
    expect(union()).toContain('Outcome metadata missing — treating this slice as FINAL (full release review at tier {TIER}). Set it with: ~/.claude/skills/gstack/bin/gstack-outcome set --id <id> --slice <n> [--final] [--flag-flip]');
  });
});
