import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runScriptSync } from '../lib/script-invocation';
import { buildManifest, renderStage } from '../lib/review-pass';
import { BriefError, CODEX_INPUT_MAX_CHARS, INLINE_DIFF_RESERVE_CHARS, assertCodexInputFits, fitInlineDiff, renderBrief, sectionTexts } from '../lib/review-brief';

const ROOT = path.resolve(import.meta.dir, '..');
const BASE = 'd316f743e2e3b031282135896efa78d9c84964f1';
const section = (p: string, chars: number) => {
  const header = `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1 @@\n+`;
  return header + 'x'.repeat(Math.max(0, chars - header.length - 1)) + '\n';
};

describe('fitInlineDiff', () => {
  test('a diff within budget comes back unchanged with nothing omitted', () => {
    const d = section('src/a.ts', 200) + section('data/b.json', 300);
    expect(fitInlineDiff(d, 10_000)).toEqual({ diff: d, total: d.length, omitted: [] });
  });

  test('data and prose files leave first, largest first, and code keeps its order', () => {
    const d = section('src/a.ts', 3000) + section('data/big.json', 5000) + section('docs/RESULT.md', 4000) + section('src/b.ts', 2000) + section('data/small.json', 500);
    const fit = fitInlineDiff(d, 6500);
    expect(fit.omitted.map(o => o.path)).toEqual(['data/big.json', 'docs/RESULT.md']);
    expect(fit.diff.indexOf('b/src/a.ts')).toBeLessThan(fit.diff.indexOf('b/src/b.ts'));
    expect(fit.diff).toContain('b/data/small.json');
    expect(fit.diff).not.toContain('b/data/big.json');
    expect(fit.diff.length).toBeLessThanOrEqual(6500);
    expect(fit.total).toBe(d.length);
  });

  test('code files leave only after every data file, largest first', () => {
    const d = section('src/small.ts', 1000) + section('data/x.json', 1000) + section('src/large.ts', 6000);
    const fit = fitInlineDiff(d, 2500);
    expect(fit.omitted.map(o => o.path)).toEqual(['data/x.json', 'src/large.ts']);
    expect(fit.diff).toContain('b/src/small.ts');
  });

  test('the same diff always fits the same way (ties by path)', () => {
    const d = section('data/b.json', 2000) + section('data/a.json', 2000) + section('src/c.ts', 500);
    const one = fitInlineDiff(d, 3000);
    expect(one.omitted.map(o => o.path)).toEqual(['data/a.json']);
    expect(fitInlineDiff(d, 3000)).toEqual(one);
  });

  test('an oversized diff with no per-file sections is refused, never truncated', () => {
    expect(() => fitInlineDiff('x'.repeat(100), 10)).toThrow(BriefError);
  });
});

describe('codex packets fit the Codex input cap', () => {
  const t = sectionTexts(ROOT);
  const huge = section('scripts/shade/run.ts', 40_000)
    + Array.from({ length: 30 }, (_, i) => section(`data/render-fidelity/r${String(i).padStart(2, '0')}.json`, 90_000)).join('');

  test('codex-structured keeps code inline, lists the data files it left out, and fits', () => {
    expect(huge.length).toBeGreaterThan(CODEX_INPUT_MAX_CHARS);
    const text = renderBrief('codex-structured', { diff_base: BASE, diff: huge }, t);
    expect(text.length).toBeLessThanOrEqual(CODEX_INPUT_MAX_CHARS - INLINE_DIFF_RESERVE_CHARS + 20_000);
    expect(text).toContain('b/scripts/shade/run.ts');
    expect(text).toContain('## Omitted from the inline diff');
    expect(text).toContain(`git diff ${BASE} -- <path>`);
    expect(text).toMatch(/^- data\/render-fidelity\/r\d\d\.json \(\d+ chars\)$/m);
    expect(() => assertCodexInputFits('codex-structured', text)).not.toThrow();
  });

  test('outside-voice fits the same way', () => {
    const text = renderBrief('outside-voice', { diff_base: BASE, diff: huge }, t);
    expect(text).toContain('## Omitted from the inline diff');
    expect(text.length).toBeLessThanOrEqual(CODEX_INPUT_MAX_CHARS);
  });

  test('a small codex-structured packet carries no omitted section', () => {
    const text = renderBrief('codex-structured', { diff_base: BASE, diff: section('src/a.ts', 500) }, t);
    expect(text).not.toContain('## Omitted from the inline diff');
  });

  test('assertCodexInputFits refuses an over-cap inline-diff packet and ignores other roles', () => {
    const over = 'x'.repeat(CODEX_INPUT_MAX_CHARS + 1);
    expect(() => assertCodexInputFits('codex-structured', over)).toThrow(BriefError);
    expect(() => assertCodexInputFits('outside-voice', over)).toThrow(BriefError);
    expect(() => assertCodexInputFits('red-team', over)).not.toThrow();
  });
});

// Value: protects=the cap applies to the complete native packet, including governor context,
// while v1.97's selected diff stays in its bounded file; fails_when=either renderer writes an
// oversized prompt or drops the disk-diff route; seam=renderStage and the actual render CLI.
describe('native renderers enforce the composed packet cap', () => {
  test('staged voices keep the upstream diff file and refuse oversized governor context before writing a brief', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-cap-stage-'));
    try {
      for (const role of ['codex-structured', 'outside-voice'] as const) {
        const out = path.join(dir, role);
        fs.mkdirSync(out);
        const m = buildManifest({ pass: 'cap', out, ledger: path.join(out, 'ledger.jsonl'), base: 'main', diffBase: BASE,
          root: ROOT, checklistRoot: ROOT, dispatches: [{ role: 'outside-voice', name: role, effort: 'full', exclude: [] }], next: 'full', planLines: [],
          governor: { metadata: { run_id: 'cap', cycle: 0, tier: 'B', routed_effort: 'medium', specialist_reasons: [], bug_class: [] }, plan: {}, text: 'x'.repeat(CODEX_INPUT_MAX_CHARS), ci: 'unknown' } });
        const selected = section('src/selected.ts', 500);
        expect(() => renderStage(m, 'voices', sectionTexts(ROOT), () => selected)).toThrow(/Codex accepts at most 1048576/);
        const file = path.join(out, 'briefs', `${role}.prompt.md`);
        expect(fs.existsSync(file)).toBe(false);
        expect(m.readers[0]!.state).toBe('planned');
        expect(fs.readFileSync(path.join(out, 'briefs', `${role}.diff`), 'utf8')).toBe(selected);
        m.governor!.text = 'bounded governor context';
        renderStage(m, 'voices', sectionTexts(ROOT), () => selected);
        const brief = fs.readFileSync(file, 'utf8');
        expect(brief).toContain(`${role}.diff`);
        expect(brief).not.toContain('b/src/selected.ts');
        expect(brief).not.toContain('## Omitted from the inline diff');
        expect(brief.length).toBeLessThanOrEqual(CODEX_INPUT_MAX_CHARS);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('standalone render checks acceptance context too, with a bounded native diff file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-cap-cli-'));
    try {
      const repo = path.join(dir, 'repo'), state = path.join(dir, 'state'), commands = path.join(dir, 'bin');
      fs.mkdirSync(repo); fs.mkdirSync(commands);
      // A local-only actor: no provider, network CI, global state, or live installation.
      fs.writeFileSync(path.join(commands, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const env = { ...process.env, PATH: commands + path.delimiter + process.env.PATH, HOME: dir, GSTACK_STATE_ROOT: state,
        GSTACK_HOME: state, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
      const git = (...args: string[]) => {
        const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
        expect(r.status, r.stderr).toBe(0); return r.stdout.trim();
      };
      git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
      git('add', '.'); git('commit', '-qm', 'base'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      const sha = git('rev-parse', 'HEAD');
      const slug = runScriptSync(path.join(ROOT, 'bin/gstack-slug'), ['--get', 'REPO_SLUG'], { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
      expect(slug.status, slug.stderr).toBe(0);
      const budgets = path.join(state, 'projects', slug.stdout.trim(), 'budgets'); fs.mkdirSync(budgets, { recursive: true });
      const manifest = path.join(dir, 'manifest.json'); fs.writeFileSync(manifest, JSON.stringify({ files: [], routing: { tier_rule: 'fixture' } }));
      fs.writeFileSync(path.join(budgets, 'cap.json'), JSON.stringify({ cycle: 0, tier: 'B', blockingSeverities: [], manifestPath: manifest }));
      const acceptance = path.join(dir, 'acceptance.md'); fs.writeFileSync(acceptance, 'x'.repeat(CODEX_INPUT_MAX_CHARS));
      const out = path.join(dir, 'out');
      const render = () => runScriptSync(path.join(ROOT, 'bin/gstack-review-dispatch'), ['render', '--role', 'codex-structured', '--base', 'main', '--diff-base', sha, '--run-id', 'cap', '--cycle', '0', '--acceptance', acceptance, '--out', out], { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
      const refused = render(); expect(refused.status).not.toBe(0); expect(refused.stderr).toContain('Codex accepts at most 1048576');
      const file = path.join(out, 'codex-structured.prompt.md'); expect(fs.existsSync(file)).toBe(false);
      fs.writeFileSync(acceptance, 'bounded fixture acceptance');
      const fits = render(); expect(fits.status, fits.stderr).toBe(0);
      expect(fs.readFileSync(file, 'utf8')).toContain('codex-structured.diff');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
