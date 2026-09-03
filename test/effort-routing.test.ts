/**
 * Phase 0 effort routing — rendered-prose pins over every codex call site.
 *
 * The routing contract (audit §10 "stop using xhigh implicitly; route effort"):
 *  - Free-form adversarial challenge is gone. codex-structured is plan-routed
 *    at MEDIUM for A/B/C and HIGH for D.
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
  const ADVERSARIAL_SITES = ['ship/sections/adversarial.md', 'review/sections/adversarial.md', '.factory/skills/gstack-ship/SKILL.md'];
  for (const site of ADVERSARIAL_SITES) {
    test(`${site}: only plan-routed codex-structured remains`, () => {
      const content = read(site);
      expect(content).not.toContain('TMPERR_ADV');
      expect(content).not.toContain('codex adversarial challenge');
      const line = codexLineWith(content, 'codex review --base');
      expect(line).toContain('model_reasoning_effort=');
      expect(line).toContain('medium|high from REVIEWERS suffix');
    });

    test(`${site}: the adversarial-review row records its effort`, () => {
      const content = read(site);
      expect(content).toContain('"skill":"adversarial-review"');
      const row = rowLine(content, 'adversarial-review');
      expect(row).toContain('"effort":"{PLAN_EFFORT}"');
      expect(row).toContain('"effort_source":"routed"');
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
    // v1.75 lazy section loading: the review-mode steps render into
    // codex/sections/review-mode.md, no longer inline in codex/SKILL.md.
    const codexSkill = read('codex/sections/review-mode.md');
    const row = rowLine(codexSkill, 'codex-review');
    expect(row).toContain('"effort":"EFFORT"');
    expect(row).toContain('"effort_source":"EFFORT_SOURCE"');
  });

  test('every rendered codex exec/review line pins model_reasoning_effort', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name === 'SKILL.md' || (p.includes(`${path.sep}sections${path.sep}`) && entry.name.endsWith('.md'))) files.push(p);
      }
    };
    walk(ROOT);
    const calls = files.flatMap((file) => {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      let fenced = false;
      return lines.flatMap((line, i) => {
        if (line.trim().startsWith('```')) { fenced = !fenced; return []; }
        return fenced && /^\s*(?:_gstack_codex_timeout_wrapper\s+\d+\s+)?codex (exec|review)\b/.test(line)
          ? [{ file, line: lines.slice(i, i + 40).join('\n').split('\n```')[0] }]
          : [];
      });
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.line, `${path.relative(ROOT, call.file)}: ${call.line}`).toContain('model_reasoning_effort');
    }
  });
});
