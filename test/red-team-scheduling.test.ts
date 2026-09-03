/**
 * Phase 0 Red Team scheduling — rendered-prose pins.
 *
 * Pattern follows test/ship-review-loop.test.ts: assert the RENDERED surfaces
 * (never the resolver source), across every host that renders the Review Army
 * section. The claude ship skill carries Review Army in
 * ship/sections/review-army.md (not inlined into ship/SKILL.md), /review
 * carries it in review/sections/review-army.md behind a STOP pointer (v1.75
 * lazy section loading — review/SKILL.md no longer inlines it), and the
 * factory golden inlines it; the codex host strips Review Army entirely, so
 * the codex golden is deliberately NOT a site here.
 *
 * These pins protect the governor contract: Red Team is a plan slot or one
 * recorded specialist-critical escalation, never a line-count trigger, and
 * every dispatch is budget-gated and packet-first.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

const RENDERED_SITES = [
  'ship/sections/review-army.md',
  'review/sections/review-army.md',
  '.factory/skills/gstack-ship/SKILL.md',
];

describe('Red Team scheduling (Phase 0)', () => {
  for (const site of RENDERED_SITES) {
    const content = fs.readFileSync(path.join(ROOT, site), 'utf-8');

    test(`${site}: Red Team is plan-routed or a specialist-critical escalation`, () => {
      expect(content).toContain('Red Team runs only when `red-team` occupies a plan slot');
      expect(content).toContain('specialist-critical:<fingerprint>');
    });

    test(`${site}: LOC and Early Red Team routing are absent`, () => {
      expect(content).not.toContain('DIFF_LINES > 200');
      expect(content).not.toContain('Early Red Team');
    });

    test(`${site}: dispatch is budget-gated before the Agent call`, () => {
      const gate = content.indexOf('gstack-review-budget dispatch "$RUN_ID" <gate>');
      const agent = content.indexOf('Every allowed Agent');
      expect(gate).toBeGreaterThanOrEqual(0);
      expect(agent).toBeGreaterThan(gate);
    });

    test(`${site}: telemetry and the shared packet are wired in`, () => {
      expect(content).toContain('gstack-gate-log');
      expect(content).toContain('gstack-diff-manifest');
      expect(content).toContain('gstack-review-packet "$RUN_ID" <base>');
      expect(content).toContain('Read the review packet at {PACKET_PATH} and the diff at {DIFF_PATH} first.');
    });

    test(`${site}: the narrower security-specialist trigger wording never returns`, () => {
      expect(content).not.toMatch(/security specialist found CRITICAL/);
    });
  }

  test('review/specialists/red-team.md scope line carries the WIDER any-specialist form', () => {
    const checklist = fs.readFileSync(path.join(ROOT, 'review/specialists/red-team.md'), 'utf-8');
    expect(checklist).toContain('any specialist found CRITICAL findings');
    expect(checklist).not.toMatch(/security specialist found CRITICAL/);
  });
});
