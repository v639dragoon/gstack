/**
 * Phase 0 effort routing — rendered-prose pins over every codex call site.
 *
 * The routing contract (audit §10 "stop using xhigh implicitly; route effort"):
 *  - ADVERSARIAL arms stay at HIGH: the codex adversarial challenge and the
 *    codex structured review (the P1 gate). Demoting either is a coverage
 *    change and must fail here.
 *  - Plan-stage voices (plan-{ceo,eng,devex,design}-review outside voice) and
 *    the doc-review voice inside /document-release route to MEDIUM.
 *  - xhigh exists ONLY as the /codex --xhigh user override, and an applied
 *    override must be RECORDED (effort_source user-override + effort_reason;
 *    gstack-gate-log refuses the record without a reason).
 *  - Every codex-call reviews.jsonl row template carries an "effort" field.
 *
 * Assertions are LINE-scoped where two efforts legitimately coexist in one
 * file: the stderr tempfile name (TMPERR_ADV / TMPERR / TMPERR_PV /
 * TMPERR_DOC) uniquely identifies each call site, so demoting the WRONG site
 * fails even though both spellings appear somewhere in the file.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

/** The line invoking codex (exec or review) that carries `marker` — NOT the
 * mktemp line, whose /tmp/codex-* prefix would match a loose filter. */
function codexLineWith(content: string, marker: string): string {
  const lines = content
    .split('\n')
    .filter((l) => l.includes(marker) && (l.includes('codex exec') || l.includes('codex review --base')));
  expect(lines.length).toBeGreaterThan(0);
  return lines[0];
}

/** The gstack-review-log row template for one skill value. */
function rowLine(content: string, skill: string): string {
  const lines = content
    .split('\n')
    .filter((l) => l.includes(`"skill":"${skill}"`) && l.includes('gstack-review-log'));
  expect(lines.length).toBeGreaterThan(0);
  return lines[0];
}

describe('effort routing (Phase 0)', () => {
  const ADVERSARIAL_SITES = ['ship/sections/adversarial.md', 'review/SKILL.md', 'test/fixtures/golden/factory-ship-SKILL.md'];
  for (const site of ADVERSARIAL_SITES) {
    test(`${site}: codex adversarial AND structured review both stay at high`, () => {
      const content = read(site);
      expect(codexLineWith(content, 'TMPERR_ADV')).toContain('model_reasoning_effort="high"');
      expect(codexLineWith(content, 'codex review --base')).toContain('model_reasoning_effort="high"');
    });

    test(`${site}: the adversarial-review row records its effort`, () => {
      const content = read(site);
      expect(content).toContain('"skill":"adversarial-review"');
      const row = rowLine(content, 'adversarial-review');
      expect(row).toContain('"effort":"high"');
      expect(row).toContain('"effort_source":"default"');
    });
  }

  const PLAN_VOICE_SITES = [
    'plan-ceo-review/sections/review-sections.md',
    'plan-eng-review/sections/review-sections.md',
    'plan-devex-review/sections/review-sections.md',
  ];
  for (const site of PLAN_VOICE_SITES) {
    test(`${site}: the plan outside voice is routed to medium and records it`, () => {
      const content = read(site);
      expect(codexLineWith(content, 'TMPERR_PV')).toContain('model_reasoning_effort="medium"');
      const row = rowLine(content, 'codex-plan-review');
      expect(row).toContain('"effort":"medium"');
      expect(row).toContain('"effort_source":"routed"');
    });
  }

  test('document-release: the codex doc voice is routed to medium and records it', () => {
    const content = read('document-release/sections/release-body.md');
    expect(codexLineWith(content, 'TMPERR_DOC')).toContain('model_reasoning_effort="medium"');
    const row = rowLine(content, 'codex-doc-review');
    expect(row).toContain('"effort":"medium"');
    expect(row).toContain('"effort_source":"routed"');
  });

  test('xhigh lives ONLY in the /codex skill, as an explicit recorded override', () => {
    const codexSkill = read('codex/SKILL.md');
    expect(codexSkill).toContain('xhigh');
    expect(codexSkill).toContain('"effort_source":"user-override"');
    expect(codexSkill).toContain('effort_reason');
    expect(codexSkill).toContain('unrecorded xhigh run is a bug');

    // No other rendered review/plan surface may mention xhigh — an implicit
    // xhigh appearing anywhere else is exactly what Phase 0 prohibits.
    for (const site of [
      ...ADVERSARIAL_SITES,
      ...PLAN_VOICE_SITES,
      'document-release/sections/release-body.md',
      'ship/SKILL.md',
      'ship/sections/review-army.md',
    ]) {
      expect(read(site)).not.toContain('model_reasoning_effort="xhigh"');
    }
  });

  test('/codex standalone review row records effort + source', () => {
    const codexSkill = read('codex/SKILL.md');
    const row = rowLine(codexSkill, 'codex-review');
    expect(row).toContain('"effort":"EFFORT"');
    expect(row).toContain('"effort_source":"EFFORT_SOURCE"');
  });
});
