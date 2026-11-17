/**
 * E2 — carve static ordering guard (GATE tier, free, deterministic).
 *
 * The per-PR mechanical backstop for EVERY carved skill: it fails CI the moment a
 * regen drops/weakens a skeleton's STOP-Read directive, strands a section, leaks
 * heavy body back into the skeleton, or moves a post-STOP gate above the STOP.
 *
 * Data-driven from the canonical CARVE_GUARDS registry (EQ1) with per-skill
 * invariants (codex outside-voice #3 — NOT a copy of the ceo-specific test, which
 * this generalizes and retires). One test() per skill so a failure names the skill.
 */

import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import * as fs from 'fs';
import { CARVE_GUARDS } from './helpers/carve-guards';
import { checkOrdering } from './helpers/carve-guard-checks';

const ROOT = path.resolve(import.meta.dir, '..');

describe('carve static ordering (gate, free)', () => {
  for (const guard of Object.values(CARVE_GUARDS)) {
    test(`${guard.skill}: skeleton routes to sections correctly`, () => {
      const failures = checkOrdering(ROOT, guard);
      expect({ skill: guard.skill, failures }).toEqual({ skill: guard.skill, failures: [] });
    });
  }
});


test('ship conditional blocks retain lead triggers and read pointers while moving execution bodies', () => {
  const read = (file: string) => fs.readFileSync(path.join(ROOT, 'ship/sections', file), 'utf8');
  const cases = [
    ['tests.md', '**If an ecosystem matched but there is no existing-test evidence at all — bootstrap:**', 'test-bootstrap-body.md', '### B2. Research best practices'],
    ['tests.md', '**If any test fails:** Do NOT immediately stop.', 'test-failure-triage.md', '### Step T1: Classify each failure'],
    ['tests.md', 'Evals are mandatory when prompt-related files change. Select from the full diff,\nincluding uncommitted changes, before deciding whether to skip.', 'eval-suites-run.md', '**2. Run the selected command and preserve its exit status.**'],
    ['governor.md', 'Run this additional slot only when codex-structured is planned and not in REUSED.', 'governor-structured-slot.md', 'In /ship, use the GOVERNOR_STRUCTURED handoff'],
  ];
  for (const [lead, trigger, file, inner] of cases) {
    const text = read(lead!);
    expect(text, lead).toContain(trigger!);
    expect(text, lead).toContain(file!);
    expect(text, lead).toContain('in full. Do not work from memory');
    expect(text, lead).not.toContain(inner!);
    expect(read(file!), file).toContain(inner!);
  }
});
