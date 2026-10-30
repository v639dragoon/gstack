import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { readLedger } from '../lib/review-ledger';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
const root = join(import.meta.dir, '..'),
  budget = join(root, 'bin', 'gstack-review-budget'),
  packet = join(root, 'bin', 'gstack-review-context');
describe('review packet', () => {
  for (const withLedger of [false, true]) test(withLedger
    ? 'renders latest deduplicated resolved findings, reasons and reviewer instructions'
    : 'writes ordered sections, matching rules, diff and unknown CI', () => {
    const d = mkdtempSync(join(tmpdir(), 'packet-repo-')),
      state = mkdtempSync(join(tmpdir(), 'packet-state-'));
    try {
      for (const a of [
        ['init', '-b', 'main'],
        ['config', 'user.email', 't@t'],
        ['config', 'user.name', 'T'],
      ])
        spawnSync('git', a, { cwd: d, timeout: 30_000 });
      mkdirSync(join(d, '.claude', 'rules'), { recursive: true });
      writeFileSync(join(d, 'x.ts'), 'old\n');
      writeFileSync(join(d, '.gstack-policy.json'), '{}');
      writeFileSync(
        join(d, '.claude', 'rules', 'x.md'),
        '---\npaths:\n  - "x.ts"\n---\n\nKeep the X contract stable.\n',
      );
      spawnSync('git', ['add', '.'], { cwd: d, timeout: 30_000 });
      spawnSync('git', ['commit', '-m', 'base'], { cwd: d, timeout: 30_000 });
      spawnSync('git', ['checkout', '-b', 'feature/packet'], { cwd: d, timeout: 30_000 });
      writeFileSync(join(d, 'x.ts'), 'new\n');
      const mp = join(state, 'manifest.json');
      writeFileSync(
        mp,
        JSON.stringify({
          run_id: 'packet-run',
          files: [{ path: 'x.ts', additions: 1, deletions: 1 }],
          scope: {},
          policy: { path: '.gstack-policy.json' },
          routing: {
            risk_tier: 'B',
            tier_rule: 'routine-product-change',
            tier_source: 'policy',
            auth_surface_matches: [],
            d_surface_matches: [],
            load_bearing_doc_matches: [],
            doc_impact_matches: [],
            doc_impact_would_dispatch: false,
            outcome: {
              present: false,
              outcome_id: null,
              slice_number: null,
              is_final_slice: false,
              is_flag_flip: false,
              risk_tier_override: null,
            },
          },
        }),
      );
      const env = {
        ...process.env,
        GSTACK_STATE_DIR: state,
        GSTACK_PROJECT_SLUG: 'packet-test',
        GIT_CONFIG_GLOBAL: '/dev/null',
      };
      expect(spawnSync(budget, ['plan', mp], { cwd: d, env, timeout: 30_000 }).status).toBe(0);
      if (withLedger) {
        const finding = (fingerprint: string, summary = fingerprint) => ({
          record_type: 'finding', fingerprint, summary, severity: 'P1', gate: 'codex-structured', blocking: true,
        });
        const resolution = (fingerprint: string, action: string, extra = {}) => ({
          record_type: 'resolved', fingerprint, action, ...extra,
        });
        const rows = [
          finding('open', 'old open'), finding('open'),
          finding('fixed', 'old fixed'), finding('fixed', 'fixed \n summary'),
          resolution('fixed', 'fixed', { reason: 'fixed \n safely' }),
          finding('accepted'), resolution('accepted', 'accepted', { reason_kind: 'intentional', reason: 'kept \t on purpose' }),
          finding('twice', 'x'.repeat(310)), resolution('twice', 'accepted', { reason_kind: 'wrong', reason: 'outdated' }),
          resolution('twice', 'skipped', { reason_kind: 'deferred', reason: 'y'.repeat(310) }),
          finding('legacy'), resolution('legacy', 'accepted'),
          resolution('orphan', 'fixed'),
          { record_type: 'finding', fingerprint: 'bare', severity: 'P1', gate: 'codex-structured', blocking: true },
          resolution('bare', 'fixed', { reason: 42 }),
        ];
        writeFileSync(join(state, 'projects', 'packet-test', 'budgets', 'packet-run.ledger.jsonl'),
          rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      }
      const acc = join(state, 'acceptance.md');
      writeFileSync(acc, 'Ship the packet safely.\n');
      const r = spawnSync(packet, ['packet-run', 'main', '--acceptance', acc], {
        timeout: 30_000,
        cwd: d,
        env,
        encoding: 'utf8',
      });
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toContain('CI_GREEN=unknown');
      const pp = r.stdout.match(/^PACKET_PATH=(.+)$/m)![1],
        text = readFileSync(pp, 'utf8');
      expect(text).toStartWith('You are the codex-structured reviewer');
      expect(text).toContain('## Findings contract');
      expect(text).toContain('## Branch diff');
      const ledger = join(state, 'projects', 'packet-test', 'packets', 'packet-run', 'review-ledger.jsonl');
      const carrier = readLedger(ledger).find(e => e.event === 'rendered')!;
      expect(carrier.governor).toMatchObject({ tier: 'B', run_id: 'packet-run', cycle: 0, routed_effort: 'medium' });
      expect(carrier.file).toBe(pp);
      const output = join(state, 'review.out');
      const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: d, encoding: 'utf8', timeout: 30_000 }).stdout.trim();
      writeFileSync(output, `REVIEWED_TREE: ${tree} ${realpathSync(d)}\n[P1] x.ts:1 — broken — fix — evidence: new\nRecommendation: fix because broken.\n`);
      const dispatch = join(root, 'bin/gstack-review-dispatch');
      expect(spawnSync(dispatch, ['sent', '--ledger', ledger, '--role', 'codex-structured', '--sent', pp], { cwd: d, env, encoding: 'utf8', timeout: 30_000 }).status).toBe(0);
      const merged = join(state, 'merged.jsonl');
      const result = spawnSync(dispatch, ['collect', '--ledger', ledger, '--role', 'codex-structured', '--output', output, '--merged', merged], { cwd: d, env, encoding: 'utf8', timeout: 30_000 });
      expect([result.status, result.stdout]).toEqual([0, expect.stringContaining('findings=1')]);
      expect(JSON.parse(readFileSync(merged, 'utf8').trim())).toMatchObject({ label: 'P1', reader: 'codex-structured', raw: expect.stringContaining('x.ts:1') });
      const unresolved = text.split('## Unresolved blocking findings\n\n')[1].split('\n\n## Resolved findings')[0];
      const resolved = text.split('## Resolved findings\n\n')[1].split('\n\nResolved findings are settled:')[0];
      expect(unresolved).toBe(withLedger ? '- [P1] open (codex-structured): open' : 'none');
      expect(resolved).toBe(withLedger ? [
        '- [P1] fixed (codex-structured): fixed summary | fixed: fixed safely',
        '- [P1] accepted (codex-structured): accepted | accepted (intentional): kept on purpose',
        `- [P1] twice (codex-structured): ${'x'.repeat(297)}... | skipped (deferred): ${'y'.repeat(297)}...`,
        '- [P1] legacy (codex-structured): legacy | accepted',
        '- [P1] bare (codex-structured):  | fixed: 42',
      ].join('\n') : 'none');
      expect(text).toContain('Resolved findings are settled: do not report one again unless the current diff shows its fix is wrong or incomplete, or its recorded reason no longer holds; then cite its fingerprint and say which. When a defect is one instance of a pattern, name the pattern and list every other instance in the diff inside the same finding (a codex line appends "also at: path:line, path:line"; a JSON finding adds "instances":["path:line"]), so one fix round clears the whole class.');
      expect(text).toContain('Ship the packet safely.');
      expect(text).toContain('.claude/rules/x.md: Keep the X contract stable.');
      expect(text).toContain('do NOT run the build, the test suite, typecheck or any install');
      expect(readFileSync(r.stdout.match(/^DIFF_PATH=(.+)$/m)![1], 'utf8')).toContain('+new');
    } finally {
      rmSync(d, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  });
});
