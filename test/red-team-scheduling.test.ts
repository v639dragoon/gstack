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
 * What these pins protect, in both directions:
 *  - The activation condition is UNCHANGED — early launch moves WHEN Red Team
 *    runs on the >200-line path, never WHETHER. Deleting or editing the
 *    activation sentence fails here.
 *  - The late (specialist-CRITICAL) path still hands Red Team the merged
 *    findings — the input contract the early path deliberately lacks.
 *  - The narrower "security specialist" trigger wording (a real
 *    resolver/checklist inconsistency fixed in Phase 0) can never return:
 *    resolver prose said "any specialist" while red-team.md:3 said "security
 *    specialist" — the checklist is pinned to the WIDER form.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

const RENDERED_SITES = [
  'ship/sections/review-army.md',
  'review/sections/review-army.md',
  'test/fixtures/golden/factory-ship-SKILL.md',
];

const ACTIVATION = 'Only if DIFF_LINES > 200 OR any specialist produced a CRITICAL finding.';

describe('Red Team scheduling (Phase 0)', () => {
  for (const site of RENDERED_SITES) {
    const content = fs.readFileSync(path.join(ROOT, site), 'utf-8');

    test(`${site}: the activation condition survives verbatim`, () => {
      expect(content).toContain(ACTIVATION);
    });

    test(`${site}: early path launches in the same parallel dispatch as the specialists`, () => {
      // \s+ because the rendered prose hard-wraps mid-phrase.
      expect(content).toMatch(/SAME parallel dispatch\s+message/);
      expect(content).toContain('EARLY path (DIFF_LINES > 200)');
    });

    test(`${site}: late path still receives the merged specialist findings`, () => {
      expect(content).toContain('The merged specialist findings from Step');
      expect(content).toContain('who found the following issues');
    });

    test(`${site}: per-gate telemetry and the manifest index are wired in`, () => {
      expect(content).toContain('gstack-gate-log');
      expect(content).toContain('gstack-diff-manifest');
      // The manifest is an index, never a diff replacement — the raw diff
      // command must still be in the specialist prompt.
      expect(content).toContain('git diff "$DIFF_BASE"');
      expect(content).toMatch(/never\s+replaces the (raw )?diff/);
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
