/** Generated policy switches are executable workflow contracts, across hosts. */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateReviewArmy } from '../scripts/resolvers/review-army';
import { generateAdversarialStep, generateCodexDocReview } from '../scripts/resolvers/review';
import { generateQAReview, generateQAReviewPreflight } from '../scripts/resolvers/qa';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
const read = (p: string) => readFileSync(join(import.meta.dir, '..', p), 'utf8');
for (const host of ['claude', 'factory'] as const) for (const skillName of ['ship', 'review']) {
  const ctx = { skillName, host, paths: HOST_PATHS[host], tmplPath: '' } as TemplateContext;
  test(`D3 ${host}/${skillName}: each upstream trim is gated; governor slot remains unconditional`, () => {
    const army = generateReviewArmy(ctx), adv = generateAdversarialStep(ctx);
    for (const flag of ['UPSTREAM_SPECIALISTS', 'RED_TEAM_LOC_TRIGGER', 'ADVERSARIAL_CLAUDE', 'CODEX_CHALLENGE', 'UPSTREAM_STRUCTURED'])
      expect(army + adv).toContain(`\`${flag}=false\``);
    expect(army).toContain('dispatch only governor-planned');
    const slot = adv.slice(adv.indexOf('### Governor codex-structured slot'));
    expect(slot).toContain('Run this additional slot only when codex-structured is planned');
    expect(slot).not.toContain('UPSTREAM_STRUCTURED=false');
    expect(army).toContain('`ADVERSARIAL_CLAUDE`');
    expect(army).toContain('`UPSTREAM_STRUCTURED`');
    expect(army).toContain('`FULL_LANES_REQUIRED`');
  });
}
test('D3 pre-plan switches: Greptile and QA load manifest-free policy flags', () => {
  const review = read('review/SKILL.md.tmpl');
  expect(review.slice(review.indexOf('## Step 2.5:'), review.indexOf('## Step 3:'))).toContain('policy-flags <base>');
  expect(review).toContain('`GREPTILE=false`');
  expect(read('ship/sections/greptile.md.tmpl')).toContain('`GREPTILE=false`');
  const ctx = { skillName: 'review', host: 'claude', paths: HOST_PATHS.claude, tmplPath: '' } as TemplateContext;
  expect(generateQAReviewPreflight(ctx)).toContain('policy-flags <base>');
  const qa = generateQAReview(ctx); expect(qa).toContain('`QA_SMOKE=false`');
  expect(qa).toContain('never a not-run required probe'); expect(qa).toContain('required plan checks still run');
});
test('D3 rating and doc voice follow policy; audit reused is satisfied and bypasses blocked recovery', () => {
  expect(read('ship/sections/test-coverage.md.tmpl')).toContain('`COVERAGE_RATING=false`');
  expect(read('ship/sections/test-coverage.md.tmpl')).toContain('Star rating: off');
  for (const p of ['ship/sections/test-coverage.md.tmpl', 'ship/sections/plan-completion.md.tmpl', 'ship/sections/documentation.md.tmpl']) {
    expect(read(p)).toContain('reason=reused'); expect(read(p)).toContain('satisfied');
  }
  expect(read('ship/sections/documentation.md.tmpl')).toContain('not Blocked recovery');
  const ctx = { skillName: 'document-release', host: 'claude', paths: HOST_PATHS.claude, tmplPath: '' } as TemplateContext;
  expect(generateCodexDocReview(ctx)).toContain('`CODEX_DOC_VOICE=false`');
  expect(read('document-release/SKILL.md.tmpl')).not.toContain('GSTACK_CODEX_DOC_VOICE');
});
test('D3 advisory override lists test stubs without ASK or AUTO-FIX; legacy prose retained', () => {
  for (const p of ['review/SKILL.md.tmpl', 'ship/sections/review-army.md.tmpl']) {
    const text = read(p); expect(text).toContain('`AUTOFIX_INFORMATIONAL=false`');
    expect(text).toContain('ADVISORY findings are NEVER fixed'); expect(text).toContain('## Advisories (not fixed)');
    expect(text).toContain('Advisory test stubs'); expect(text).toContain('`MAX_ADVISORIES`');
    expect(text).toContain('AUTO-FIX'); expect(text).toContain('ASK');
  }
});
test('D3 binding, doc skip and Local/Full lanes are explicit in final acceptance and PR body', () => {
  const ship = read('ship/SKILL.md.tmpl'), pr = read('ship/sections/pr-body.md.tmpl');
  const binding = ship.slice(ship.indexOf('## Step 11.5:'), ship.indexOf('## Step 12:'));
  expect(binding).toContain('`ADVERSARIAL_CLAUDE=false`'); expect(binding).toContain('core and governor');
  expect(read('review/SKILL.md.tmpl')).toContain('When `ADVERSARIAL_CLAUDE=false`');
  for (const text of [ship, pr]) expect(text).toContain('Documentation: skipped (tier A/B, no doc-impact)');
  const tests = read('ship/sections/tests.md.tmpl'); expect(tests).toContain('Local lanes'); expect(tests).toContain('Full lanes');
  expect(tests).toContain('`FULL_LANES_REQUIRED=false`');
  expect(ship).toContain('build: DEFERRED'); expect(pr).toContain('CI_BACKSTOP');
  expect(pr).toContain('Never omit this section');
});
