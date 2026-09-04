import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
const bin = join(import.meta.dir, '..', 'bin', 'gstack-outcome-report');
describe('outcome report', () => {
  test('joins transcripts, gates, reviews and ledgers with safe recommendations', () => {
    const repo = mkdtempSync(join(tmpdir(), 'report-repo-')),
      state = mkdtempSync(join(tmpdir(), 'report-state-')),
      transcripts = mkdtempSync(join(tmpdir(), 'report-transcripts-'));
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: repo, timeout: 30_000 });
      const project = join(state, 'projects', 'report-test'),
        budgets = join(project, 'budgets');
      mkdirSync(join(project, 'outcomes'), { recursive: true });
      mkdirSync(budgets, { recursive: true });
      const outcome = {
        outcome_id: 'launch-1',
        created_at: new Date().toISOString(),
        slices: [
          {
            branch: 'main',
            slice_number: 1,
            is_final_slice: true,
            is_flag_flip: false,
            set_at: new Date().toISOString(),
          },
        ],
        sessions: ['sess'],
        escapes: [{ summary: 'manual' }],
      };
      writeFileSync(join(project, 'outcomes', 'launch-1.json'), JSON.stringify(outcome));
      const plan = { runId: 'r1', tier: 'B', outcome_id: 'launch-1', blockingSeverities: ['P1'] };
      writeFileSync(join(budgets, 'r1.json'), JSON.stringify(plan));
      writeFileSync(
        join(budgets, 'r1.ledger.jsonl'),
        [
          {
            record_type: 'dispatch',
            run_id: 'r1',
            gate: 'codex-structured',
            allowed: true,
            semantic: true,
          },
          {
            record_type: 'finding',
            run_id: 'r1',
            gate: 'codex-structured',
            severity: 'P1',
            fingerprint: 'f',
            summary: 'bug',
          },
          { record_type: 'resolved', run_id: 'r1', fingerprint: 'f', action: 'fixed' },
          {
            record_type: 'finding',
            run_id: 'r1',
            gate: 'codex-structured',
            severity: 'INFORMATIONAL',
            category: 'auth',
            blocking: true,
            fingerprint: 'auth-info',
            summary: 'auth issue',
          },
          {
            record_type: 'resolved',
            run_id: 'r1',
            fingerprint: 'auth-info',
            action: 'accepted',
          },
          {
            record_type: 'rerun-check',
            run_id: 'r1',
            full_rerun: true,
            triggers: ['api:app/api/x.ts'],
          },
        ]
          .map(JSON.stringify)
          .join('\n') + '\n',
      );
      writeFileSync(
        join(project, 'main-gates.jsonl'),
        [
          {
            outcome_id: 'launch-1',
            run_id: 'r1',
            gate: 'codex-structured',
            risk_tier: 'B',
            model: 'gpt',
            effort: 'medium',
            fix_cycle: 0,
            findings: { informational: 1 },
          },
          {
            outcome_id: 'launch-1',
            run_id: 'r1',
            gate: 'codex-structured',
            risk_tier: 'B',
            model: 'gpt',
            effort: 'medium',
            fix_cycle: 1,
            findings: { informational: 2 },
          },
        ]
          .map(JSON.stringify)
          .join('\n') + '\n',
      );
      writeFileSync(
        join(project, 'main-reviews.jsonl'),
        JSON.stringify({
          outcome_id: 'launch-1',
          findings: [{ severity: 'INFORMATIONAL', action: 'fixed' }],
        }) + '\n',
      );
      const escaped = realpathSync(repo).replace(/[^a-zA-Z0-9_-]/g, '-'),
        td = join(transcripts, escaped);
      mkdirSync(td, { recursive: true });
      writeFileSync(
        join(td, 'sess.jsonl'),
        [
          {
            type: 'assistant',
            message: {
              model: 'claude-sonnet',
              usage: {
                input_tokens: 10,
                cache_creation_input_tokens: 5,
                cache_read_input_tokens: 5,
              },
              content: [{ type: 'tool_use', name: 'AskUserQuestion' }],
            },
          },
          {
            type: 'assistant',
            effort: 'high',
            message: {
              model: 'claude-sonnet',
              usage: {
                input_tokens: 20,
                cache_creation_input_tokens: 20,
                cache_read_input_tokens: 20,
              },
              content: [],
            },
          },
        ]
          .map(JSON.stringify)
          .join('\n') + '\n',
      );
      const env = {
        ...process.env,
        GSTACK_STATE_DIR: state,
        GSTACK_PROJECT_SLUG: 'report-test',
        GSTACK_CLAUDE_PROJECTS_DIR: transcripts,
        GIT_CONFIG_GLOBAL: '/dev/null',
      };
      const r = spawnSync(bin, ['launch-1', '--json'], { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.lead).toEqual({
        model: 'claude-sonnet',
        effort: 'high',
        turns: 2,
        ending_context_tokens: 60,
      });
      expect(out.runs_by_model_effort['gpt@medium']).toBe(2);
      expect(out.blocking_findings_accepted).toBe(2);
      expect(out.informational_findings).toBe(3);
      expect(out.informational_fixed).toBe(1);
      expect(out.repair_cycles).toBe(2);
      expect(out.full_reruns).toEqual([{ run_id: 'r1', triggers: ['api:app/api/x.ts'] }]);
      expect(out.founder_interruptions).toBe(1);
      expect(out.post_merge_escapes).toBe(1);
      expect(out.reviewer_yield['codex-structured|B'].yield).toBe(1);
      for (let i = 0; i < 8; i++) {
        writeFileSync(
          join(budgets, `d${i}.json`),
          JSON.stringify({ runId: `d${i}`, tier: 'D', outcome_id: null, blockingSeverities: [] }),
        );
        writeFileSync(
          join(budgets, `d${i}.ledger.jsonl`),
          JSON.stringify({
            record_type: 'dispatch',
            gate: 'red-team',
            allowed: true,
            semantic: true,
          }) + '\n',
        );
      }
      const before = readdirSync(budgets).sort().join(',');
      const rec = spawnSync(bin, ['launch-1', '--recommend'], { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
      expect(rec.stdout).not.toContain('PROPOSE: red-team on tier D');
      expect(readdirSync(budgets).sort().join(',')).toBe(before);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
      rmSync(transcripts, { recursive: true, force: true });
    }
  });
});
