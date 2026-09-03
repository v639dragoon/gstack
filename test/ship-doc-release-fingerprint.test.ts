/**
 * Phase 0 document-release dispatch control — rendered-prose pins.
 *
 * doc-release was the audited pipeline's #1 sole-blocker (p50 8.8 min; 12 of
 * 36 dispatches were re-dispatches from ship-flow re-entry). The guard
 * de-duplicates SAME-RUN redispatches only; cross-run skipping stays a
 * logged shadow signal (`redispatch_would_skip`) — the Phase 1 evidence.
 *
 * These pins protect both directions:
 *  - the skip can never widen silently (all three conditions + the "cross-run
 *    still dispatches" sentence are pinned),
 *  - the original contract can never erode (the non-blocking failure clause
 *    and the S17/S19 position are pinned verbatim — the same strings the
 *    audit quoted from the pre-change template).
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

const RENDERED_SITES = [
  'ship/sections/pr-body.md',
  'test/fixtures/golden/claude-ship-SKILL.md',
  'test/fixtures/golden/codex-ship-SKILL.md',
  'test/fixtures/golden/factory-ship-SKILL.md',
];

describe('document-release dispatch control (Phase 0)', () => {
  for (const site of RENDERED_SITES) {
    const content = fs.readFileSync(path.join(ROOT, site), 'utf-8');
    // The claude ship SKILL.md carries pr-body via its section file, not
    // inline — skip sites that don't render the dispatch prose, but require
    // that at least the section file and both inlining goldens carry it.
    const carries = content.includes('Documentation sync (via subagent');
    if (!carries) continue;

    test(`${site}: the same-run skip requires ALL THREE conditions`, () => {
      expect(content).toMatch(/Skip the redispatch ONLY when ALL THREE hold/);
      expect(content).toMatch(/same\s+`run_id`/);
      expect(content).toMatch(/same\s+`doc_fingerprint`/);
      expect(content).toMatch(/not\s+`error`\/`timeout`/);
    });

    test(`${site}: a cross-run fingerprint match STILL dispatches (shadow only)`, () => {
      expect(content).toMatch(/DIFFERENT run:\s+still dispatch \(cross-run skipping is\s+NOT active in Phase 0\)/);
      expect(content).toContain('redispatch_would_skip');
    });

    test(`${site}: the pre-existing contract survives verbatim`, () => {
      expect(content).toContain('Do not block /ship on subagent failure.');
      expect(content).toContain('AFTER Step 17 (Push) and BEFORE Step 19 (Create PR)');
    });

    test(`${site}: the outcome record carries the doc fingerprint and impact shadow`, () => {
      expect(content).toContain('"gate":"doc-release"');
      expect(content).toContain('doc_fingerprint');
      expect(content).toContain('files_updated_count');
      expect(content).toContain('doc_impact_would_dispatch');
      expect(content).toContain('false_negative');
    });

    test(`${site}: no unconditional skip language`, () => {
      // The only skip is the guarded same-run one. A bare "skip the dispatch"
      // outside the ALL-THREE guard would be a silent policy widening.
      // Negated forms ("Never skip the dispatch", v1.75 doc-sync invariant)
      // are anti-skip language and deliberately not counted.
      const skips = content.match(/(?<!never )skip the dispatch/gi) ?? [];
      expect(skips.length).toBeLessThanOrEqual(1);
    });
  }

  test('at least the section file and both inlining goldens carry the dispatch prose', () => {
    const carriers = RENDERED_SITES.filter((s) =>
      fs.readFileSync(path.join(ROOT, s), 'utf-8').includes('Documentation sync (via subagent'),
    );
    expect(carriers.length).toBeGreaterThanOrEqual(3);
  });

  test('the governor bounds repair cycles and records rerun cause', () => {
    const reviewArmy = fs.readFileSync(path.join(ROOT, 'ship/sections/review-army.md'), 'utf-8');
    expect(reviewArmy).toContain('REPAIR_CYCLES_MAX');
    expect(reviewArmy).toContain('rerun-check');
    expect(reviewArmy).toContain('rerun_cause:"scope-expansion:{triggers}"');
    expect(reviewArmy).toContain('report which findings keep reappearing');
  });
});
