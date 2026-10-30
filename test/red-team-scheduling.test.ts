/**
 * Phase 0 Red Team scheduling — rendered-prose pins.
 *
 * Pattern follows test/ship-review-loop.test.ts: assert the RENDERED surfaces
 * (never the resolver source), across every host that renders the Review Army
 * section. The claude ship skill carries Review Army in
 * ship/sections/review-army.md (not inlined into ship/SKILL.md), /review
 * and factory also keep it in lazy section files; the codex host strips Review
 * Army entirely, so the codex golden is deliberately NOT a site here.
 *
 * These pins protect the governor contract: Red Team is a plan slot or one
 * recorded specialist-critical escalation, never a line-count trigger, and
 * every dispatch is budget-gated and packet-first.
 */
import { afterAll, describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

// Render a private host tree; ignored per-user registrations are not test inputs.
const hostOut = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'red-team-host-'));
const rendered = Bun.spawnSync([process.execPath, 'run', 'scripts/gen-skill-docs.ts', '--host', 'factory', '--out-dir', hostOut], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', timeout: 180_000 });
if (rendered.exitCode !== 0) throw Error(rendered.stderr.toString());
afterAll(() => fs.rmSync(hostOut, { recursive: true, force: true }));
const RENDERED_SITES = [
  'ship/sections/review-army.md',
  'review/sections/review-army.md',
  '.factory/skills/gstack-ship/sections/review-army.md',
];

describe('Red Team scheduling (Phase 0)', () => {
  for (const site of RENDERED_SITES) {
    const content = fs.readFileSync(path.join(site.startsWith('.factory/') ? hostOut : ROOT, site), 'utf-8');

    test(`${site}: upstream activation and planned Red Team both run under D4`, () => {
      expect(content).toContain(site.includes('ship') ? 'DISPATCH: red-team' : 'DIFF_LINES > 200 OR any specialist produced a CRITICAL finding');
      expect(content).toContain('A planned');
      expect(content).toContain('red-team runs even without upstream activation');
      expect(content).toContain('upstream-specialist:red-team');
      expect(content).toContain('does not consume the single routed escalation');
    });

    test(`${site}: dispatch is budget-gated before every Agent call`, () => {
      const gate = content.indexOf(site.includes('ship') ? 'gstack-review-budget dispatch "$RUN_ID" <governor_gate>' : 'gstack-review-budget dispatch "$RUN_ID" <gate>');
      const agent = content.indexOf('Every allowed Agent');
      expect(gate).toBeGreaterThanOrEqual(0);
      expect(agent).toBeGreaterThan(gate);
    });

    test(`${site}: telemetry and the shared packet are wired in`, () => {
      expect(content).toContain('gstack-gate-log');
      expect(content).toContain('gstack-diff-manifest');
      expect(content).toContain(site.includes('ship') ? 'gstack-review-packet build' : 'gstack-review-packet "$RUN_ID" <base>');
      expect(content).toContain(site.includes('ship') ? 'read=' : 'including its inline diff');
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
