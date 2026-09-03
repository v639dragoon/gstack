import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
const root = join(import.meta.dir, '..'),
  budget = join(root, 'bin', 'gstack-review-budget'),
  packet = join(root, 'bin', 'gstack-review-packet');
describe('review packet', () => {
  test('writes ordered sections, matching rules, diff and unknown CI', () => {
    const d = mkdtempSync(join(tmpdir(), 'packet-repo-')),
      state = mkdtempSync(join(tmpdir(), 'packet-state-'));
    try {
      for (const a of [
        ['init', '-b', 'main'],
        ['config', 'user.email', 't@t'],
        ['config', 'user.name', 'T'],
      ])
        spawnSync('git', a, { cwd: d });
      mkdirSync(join(d, '.claude', 'rules'), { recursive: true });
      writeFileSync(join(d, 'x.ts'), 'old\n');
      writeFileSync(join(d, '.gstack-policy.json'), '{}');
      writeFileSync(
        join(d, '.claude', 'rules', 'x.md'),
        '---\npaths:\n  - "x.ts"\n---\n\nKeep the X contract stable.\n',
      );
      spawnSync('git', ['add', '.'], { cwd: d });
      spawnSync('git', ['commit', '-m', 'base'], { cwd: d });
      spawnSync('git', ['checkout', '-b', 'feature/packet'], { cwd: d });
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
      expect(spawnSync(budget, ['plan', mp], { cwd: d, env }).status).toBe(0);
      const acc = join(state, 'acceptance.md');
      writeFileSync(acc, 'Ship the packet safely.\n');
      const r = spawnSync(packet, ['packet-run', 'main', '--acceptance', acc], {
        cwd: d,
        env,
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('CI_GREEN=unknown');
      const pp = r.stdout.match(/^PACKET_PATH=(.+)$/m)![1],
        text = readFileSync(pp, 'utf8');
      const sections = [
        '## Acceptance criteria',
        '## Risk',
        '## Changed files',
        '## Reviewed revision',
        '## Architecture constraints',
        '## CI / test evidence',
        '## Unresolved blocking findings',
      ];
      let last = -1;
      for (const h of sections) {
        const at = text.indexOf(h);
        expect(at).toBeGreaterThan(last);
        last = at;
      }
      expect(text).toContain('Ship the packet safely.');
      expect(text).toContain('.claude/rules/x.md: Keep the X contract stable.');
      expect(text).toContain('When CI_GREEN=true do not run the full build or test suite');
      expect(readFileSync(r.stdout.match(/^DIFF_PATH=(.+)$/m)![1], 'utf8')).toContain('+new');
    } finally {
      rmSync(d, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  });
});
