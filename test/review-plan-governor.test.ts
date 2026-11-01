/** Integration: governor additions and opt-in D3 selection reach the real builder and collector. No model calls. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readManifest } from '../lib/review-pass';
import { readLedger } from '../lib/review-ledger';
const root = path.resolve(import.meta.dir, '..');

function fixture(tier: string, passes: Record<string, boolean>, migrations = false) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-gov-')));
  const repo = path.join(temp, 'repo'), state = path.join(temp, 'state'), out = path.join(temp, 'packets');
  fs.mkdirSync(repo); fs.mkdirSync(state);
  const env = { ...process.env, GSTACK_STATE_ROOT: state, GSTACK_PROJECT_SLUG: 'fixture', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8', timeout: 10_000 });
    expect(r.status, r.stderr).toBe(0);
  };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, '.gstack-policy.json'), JSON.stringify({ routing: { passes } }));
  fs.writeFileSync(path.join(repo, 'main.ts'), 'export const x = 1;\n');
  git('add', '.'); git('commit', '-qm', 'base'); git('checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(repo, 'main.ts'), Array.from({ length: 80 }, (_, i) => `export const x${i} = ${i};`).join('\n') + '\n');
  git('add', '.'); git('commit', '-qm', 'feature');
  const manifest = path.join(temp, 'governor.json');
  fs.writeFileSync(manifest, JSON.stringify({ run_id: 'integration', base: 'main', files: [{ path: 'main.ts', additions: 80, deletions: 1 }], scope: { migrations }, policy: { path: '.gstack-policy.json' }, routing: {
    risk_tier: tier, tier_rule: 'fixture', tier_source: 'policy', auth_surface_matches: [], d_surface_matches: [], load_bearing_doc_matches: [], doc_impact_matches: [], outcome: { present: false },
  } }));
  const run = (bin: string, args: string[]) => spawnSync(path.join(root, 'bin', bin), args, { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
  const planned = run('gstack-review-budget', ['plan', manifest, '--host', 'codex']);
  expect(planned.status, planned.stderr).toBe(0);
  const flags = ['--base', 'main', '--gate-tagged', '0', '--run-id', 'integration', '--cycle', '0'];
  const plan = run('gstack-review-plan', [...flags, '--json']);
  expect(plan.status, plan.stderr).toBe(0);
  return { temp, repo, env, git, out, run, flags, plan: JSON.parse(plan.stdout), cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

// The upstream carrier moved to review-dispatch's pass manifest; governor tier checklists share its one batched reader.
test('tier D migration plan keeps red-team, strict structured and every specialist floor in the single batch', () => {
  const f = fixture('D', {}, true);
  try {
    expect(f.plan.dispatches.map((d: { name: string }) => d.name)).toEqual(expect.arrayContaining(['red-team', 'codex-structured', 'batched']));
    const batch = f.plan.dispatches.find((d: { name: string }) => d.name === 'batched');
    expect(batch.checklists).toEqual(expect.arrayContaining(['security', 'data-migration']));
    expect(batch.governor_gates).toEqual(expect.arrayContaining(['specialist:security', 'specialist:data-migration']));
    expect(f.plan.dispatches.filter((d: { role: string }) => d.role === 'specialist')).toHaveLength(1);
    expect(f.plan.depth).toBe('standard');
    expect(f.plan.dispatches.find((d: { name: string }) => d.name === 'codex-structured')).toMatchObject({ governor_floor: true, governor: { routed_effort: 'high' } });
    const built = f.run('gstack-review-dispatch', ['pass', '--base', 'main', '--pass', 'p1', '--out', f.out, '--', ...f.flags]);
    expect(built.status, built.stderr).toBe(0);
    const file = path.join(f.out, 'pass-manifest.json');
    const stage = f.run('gstack-review-dispatch', ['stage', '--manifest', file, '--stage', 'voices']);
    expect(stage.status, stage.stderr).toBe(0);
    const manifest = readManifest(file);
    const strict = manifest.readers.find(p => p.role === 'codex-structured')!;
    expect(strict.governor_floor).toBe(true);
    expect(fs.readFileSync(strict.file!, 'utf8')).toContain('do NOT run the build, the test suite, typecheck or any install');
    expect(fs.readFileSync(strict.file!, 'utf8')).toContain('## Governor context');
  } finally { f.cleanup(); }
});

test('D3-off reviewer is absent from the plan and dispatch ledger expectations; strict collect completes', () => {
  const f = fixture('B', { native_adversarial: false, upstream_specialists: false, codex_challenge: false, red_team_loc_trigger: false });
  try {
    expect(f.plan.dispatches.map((d: { name: string }) => d.name)).toEqual(['codex-structured']);
    const built = f.run('gstack-review-dispatch', ['pass', '--base', 'main', '--pass', 'p1', '--out', f.out, '--', ...f.flags]);
    expect(built.status, built.stderr).toBe(0);
    const file = path.join(f.out, 'pass-manifest.json');
    expect(f.run('gstack-review-dispatch', ['stage', '--manifest', file, '--stage', 'voices']).status).toBe(0);
    const manifest = readManifest(file);
    expect(manifest.readers.map(p => p.role)).toEqual(['codex-structured']);
    const strict = manifest.readers[0]!;
    const tree = strict.tree!;
    const output = path.join(f.out, 'strict.out');
    fs.writeFileSync(output, `REVIEWED_TREE: ${tree}\nNO FINDINGS\nRecommendation: proceed because no exploitable finding.\n`);
    expect(f.run('gstack-review-dispatch', ['sent', '--ledger', manifest.ledger, '--role', strict.role!, '--sent', strict.file!]).status).toBe(0);
    const result = f.run('gstack-review-dispatch', ['collect', '--ledger', manifest.ledger, '--role', strict.role!, '--output', output, '--merged', manifest.merged]);
    expect([result.status, result.stdout]).toEqual([0, expect.stringContaining('findings=0')]);
    expect(readLedger(manifest.ledger).filter(e => e.event === 'rendered').map(e => e.role)).toEqual(['codex-structured']);
  } finally { f.cleanup(); }
});

test('D3 switches cannot drop floor checklists, red-team or structured', () => {
  const f = fixture('D', { upstream_specialists: false, red_team_loc_trigger: false, upstream_structured: false, codex_challenge: false });
  try {
    for (const gate of ['codex-structured', 'red-team'])
      expect(f.plan.dispatches.find((d: { governor_gate: string }) => d.governor_gate === gate)).toMatchObject({ governor_floor: true });
    expect(f.plan.dispatches.find((d: { name: string }) => d.name === 'batched').governor_gates).toContain('specialist:security');
    expect(f.plan.dispatches.some((d: { governor_gate: string }) => d.governor_gate === 'upstream-outside:challenge')).toBe(false);
  } finally { f.cleanup(); }
});


test('ordinary blocking repair uses upstream scoped selection and below-floor repair uses fix-check', () => {
  const f = fixture('B', {});
  try {
    const since = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: f.repo, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    fs.appendFileSync(path.join(f.repo, 'main.ts'), 'export const fixed = true;\n');
    f.git('add', '.'); f.git('commit', '-qm', 'fix');
    const repeat = ['--pass', '1', '--last', 'full', '--pass1-depth', 'standard', '--range-base', since];
    const scoped = f.run('gstack-review-plan', [...f.flags, ...repeat, '--fixed-blocking', '--json']);
    expect(JSON.parse(scoped.stdout).next.step).toBe('scoped');
    const check = f.run('gstack-review-plan', [...f.flags, ...repeat, '--fixed-below', '--json']);
    expect(JSON.parse(check.stdout).next.step).toBe('fix-check');
  } finally { f.cleanup(); }
});

for (const risky of ['lib/auth/access.ts', 'lib/oauth/token.ts', 'lib/session/token.ts', 'lib/jwt/token.ts', 'db/rls.sql', 'billing/entitlements.ts', 'db/migrations/a.sql', 'lib/secrets.ts'])
  test(`risky fix ${risky} requires full whole-branch review despite D3; cap stops`, () => {
    const f = fixture('B', { native_adversarial: false, upstream_specialists: false, codex_challenge: false, red_team_loc_trigger: false });
    try {
      const since = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: f.repo, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
      fs.mkdirSync(path.dirname(path.join(f.repo, risky)), { recursive: true });
      fs.writeFileSync(path.join(f.repo, risky), 'export const fixed = true;\n');
      f.git('add', '.'); f.git('commit', '-qm', 'risky fix');
      const repeat = ['--pass', '1', '--last', 'full', '--fixed-below', '--pass1-depth', 'standard', '--range-base', since];
      const planned = f.run('gstack-review-plan', [...f.flags, ...repeat, '--json']);
      const plan = JSON.parse(planned.stdout);
      expect(plan.next.step).toBe('full'); expect(plan.depth).toBe('full');
      expect(plan.dispatches.map((d: { name: string }) => d.name)).toEqual(expect.arrayContaining(['batched', 'red-team', 'adversarial', 'codex-structured']));
      const built = f.run('gstack-review-dispatch', ['pass', '--base', 'main', '--pass', 'p2', '--out', f.out, '--', ...f.flags, ...repeat]);
      expect(built.status, built.stderr).toBe(0);
      const file = path.join(f.out, 'pass-manifest.json');
      expect(f.run('gstack-review-dispatch', ['stage', '--manifest', file, '--stage', 'voices']).status).toBe(0);
      const strict = readManifest(file).readers.find(r => r.role === 'codex-structured')!;
      expect(fs.readFileSync(strict.file!, 'utf8')).toContain('+export const x79 = 79;');
      // flagReader uses the first occurrence; replace it explicitly for the cap probe.
      const capFlags = [...repeat]; capFlags[1] = '2';
      const cap = JSON.parse(f.run('gstack-review-plan', [...f.flags, ...capFlags, '--json']).stdout);
      expect(cap.next.step).toBe('stop'); expect(cap.dispatches).toEqual([]);
    } finally { f.cleanup(); }
  });

test('risky repair refuses a narrowed review receipt and overrides D3 registration/dispatch skips', () => {
  const bin = path.join(root, 'bin');
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'risk-callback-')));
  try {
    const repo = path.join(temp, 'repo'); fs.mkdirSync(repo);
    const env = { ...process.env, GSTACK_STATE_ROOT: path.join(temp, 'state'), GSTACK_PROJECT_SLUG: 'risk', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...args: string[]) => { const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8', timeout: 10_000 }); expect(r.status, r.stderr).toBe(0); };
    const run = (name: string, args: string[]) => spawnSync(path.join(bin, name), args, { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, '.gstack-policy.json'), JSON.stringify({ routing: { passes: { native_adversarial: false, upstream_specialists: false } } }));
    fs.writeFileSync(path.join(repo, 'main.ts'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
    const manifest = path.join(temp, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ run_id: 'risk', base: 'main', files: [{ path: 'main.ts' }], scope: {}, policy: { path: '.gstack-policy.json' }, routing: { risk_tier: 'B', tier_source: 'policy', outcome: { present: false } } }));
    expect(run('gstack-review-budget', ['plan', manifest]).status).toBe(0);
    const start = run('gstack-review-log', ['--start', 'review']); expect(start.status).toBe(0);
    fs.mkdirSync(path.join(repo, 'billing')); fs.writeFileSync(path.join(repo, 'billing/entitlements.ts'), 'repair\n');
    const saved = run('gstack-review-log', [JSON.stringify({ skill: 'review', status: 'issues_found', issues_found: 1, critical: 1, completed: true, converged: false }), '--finish', start.stdout.trim()]);
    expect(saved.status, saved.stderr).toBe(0);
    git('add', '.'); git('commit', '-qm', 'risky repair');
    const narrowed = run('gstack-review-log', ['--start', 'review', '--fix-range']);
    expect(narrowed.status).not.toBe(0); expect(narrowed.stderr).toContain('risky-surface full re-review required');
    expect(run('gstack-review-budget', ['plan', manifest, '--cycle', '1']).status).toBe(0);
    for (const gate of ['native-adversarial', 'upstream-specialist:testing']) {
      expect(run('gstack-review-budget', ['register-upstream', 'risk', gate, '--cycle', '1']).status).toBe(0);
      expect(run('gstack-review-budget', ['dispatch', 'risk', gate, '--cycle', '1']).status).toBe(0);
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

// Value: protects=the strict governor reviewer reaches the consent-enforcing Codex route rather than a general-purpose subagent;
// fails_when=the pass program creates that reader or silently treats it as finished;
// why_new=upstream's compact pass is the successor dispatcher; seam=the registered pass program and native dispatch CLI; no_claim=model output
 test('compact pass returns the strict reader to the parent without creating any subagent', async () => {
  const f = fixture('B', { native_adversarial: false, upstream_specialists: false, codex_challenge: false, red_team_loc_trigger: false });
  try {
    let created = 0;
    const tools = {
      capy: {
        bash: async ({ command }: {command: string}) => {
          const r = spawnSync('bash', ['-c', command], { cwd: f.repo, env: {...f.env, PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH}, encoding: 'utf8', timeout: 30_000 });
          return {exit_code: r.status ?? 1, output: r.stdout + r.stderr};
        },
        write: async () => { throw Error('strict handoff writes no prompt through the host'); },
      },
      subagent: {list: async () => ({tasks: []}), create: async () => {created++; throw Error('strict reviewer must not use subagent.create');}},
    };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<string>;
    const program = fs.readFileSync(path.join(root, 'lib/capy-review-pass.js'), 'utf8');
    const result = await new AsyncFunction('tools', 'sleep', 'now', 'input', program)(tools, async () => {}, async () => 0,
      {base: 'main', out: f.out, pass: 'p1', stage: 'voices', planFlags: f.flags, startedAt: 0});
    expect(result).toContain('GOVERNOR_STRUCTURED: reader=codex-structured');
    expect(result).toContain('NEXT: governor-structured');
    expect(result).toContain(' out=' + f.out + '/codex-structured.out');
    expect(created).toBe(0);
    const strict = readManifest(path.join(f.out, 'pass-manifest.json')).readers.find(r => r.role === 'codex-structured')!;
    expect(strict.state).toBe('rendered');
    expect(strict.governor_floor).toBe(true);
  } finally {f.cleanup();}
});

// Value: protects=the compact send/collect callbacks own every floor's budget; fails_when=a launched batch bypasses
// its logical specialist slots or a duplicate success reserves another attempt; seam=native dispatch CLI and budget ledger.
test('native batched callbacks account tier floors with D3 disabled and cannot silently launch again', () => {
  const f = fixture('D', {upstream_specialists: false}, true);
  try {
    expect(f.run('gstack-review-dispatch', ['pass', '--base', 'main', '--pass', 'p1', '--out', f.out, '--', ...f.flags]).status).toBe(0);
    const mf = path.join(f.out, 'pass-manifest.json');
    expect(f.run('gstack-review-dispatch', ['stage', '--manifest', mf, '--stage', 'specialists']).status).toBe(0);
    const m = readManifest(mf), batch = m.readers.find(r => r.role === 'specialist-batched')!;
    const slug = f.run('gstack-slug', ['--get', 'REPO_SLUG']).stdout.trim();
    const budgetLedger = path.join(f.env.GSTACK_STATE_ROOT, 'projects', slug, 'budgets', 'integration.ledger.jsonl');
    const rows = () => fs.existsSync(budgetLedger) ? fs.readFileSync(budgetLedger, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
    const wrong = path.join(f.out, 'wrong.txt'); fs.writeFileSync(wrong, 'summarized prompt');
    expect(f.run('gstack-review-dispatch', ['sent', '--ledger', m.ledger, '--role', batch.role!, '--sent', wrong]).status).not.toBe(0);
    expect(rows().filter(r => r.record_type === 'dispatch' && r.allowed)).toHaveLength(0);
    const send = () => f.run('gstack-review-dispatch', ['sent', '--ledger', m.ledger, '--role', batch.role!, '--sent', batch.file!]);
    expect(send().status).toBe(0);
    const output = path.join(f.out, 'batch.out');
    fs.writeFileSync(output, `REVIEWED_TREE: ${batch.tree}\nNO FINDINGS\n`);
    const collect = () => f.run('gstack-review-dispatch', ['collect', '--ledger', m.ledger, '--role', batch.role!, '--output', output, '--merged', m.merged]);
    expect(collect().status).toBe(0);
    expect(collect().status).toBe(0); // resume does not duplicate governor verdicts
    for (const gate of batch.governor_gates!) {
      expect(rows().filter(r => r.record_type === 'dispatch' && r.allowed && r.gate === gate)).toHaveLength(1);
      expect(rows().filter(r => r.record_type === 'verdict' && r.gate === gate && r.verdict === 'clean')).toHaveLength(1);
    }
    expect(send().status).not.toBe(0);
    // The parent owns the actual provider/model receipt. A compact callback must not add
    // a second gate-log invocation before this existing telemetry instruction runs.
    for (const gate of batch.governor_gates!) {
      expect(f.run('gstack-gate-log', [JSON.stringify({record_type:'gate',run_id:'integration',gate,model:'sonnet',verdict:'clean'})]).status).toBe(0);
    }
    const project = path.join(f.env.GSTACK_STATE_ROOT, 'projects', slug);
    const telemetry = fs.readdirSync(project).filter(p => p.endsWith('-gates.jsonl')).flatMap(p => fs.readFileSync(path.join(project,p),'utf8').trim().split('\n').map(s => JSON.parse(s)));
    for (const gate of batch.governor_gates!) expect(telemetry.filter(r => r.gate === gate)).toHaveLength(1);
  } finally {f.cleanup();}
});

// Value: protects=the founder Sonnet pin at the actual successor launcher; fails_when=an unpinned/Opus
// general-purpose reader reaches create; seam=checked-in Capy program with native bin callbacks and declared no-launch actor.
for (const model of [undefined, {model_id: 'anthropic/claude-opus-5-5'}, {model_id: 'anthropic/claude-sonnet-5-5'}]) test(`compact governed batch model boundary: ${model?.model_id ?? 'default'}`, async () => {
  const f = fixture('D', {}, true);
  try {
    let created = 0;
    const tools = {
      capy: {bash: async ({command}: {command: string}) => {
        const r = spawnSync('bash', ['-c', command], {cwd: f.repo, env: {...f.env, PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH}, encoding: 'utf8', timeout: 30_000});
        return {exit_code: r.status ?? 1, output: r.stdout + r.stderr};
      }, write: async ({path: file, content}: {path: string;content: string}) => {fs.mkdirSync(path.dirname(file), {recursive:true});fs.writeFileSync(file, content);}},
      subagent: {list: async () => ({tasks: []}), create: async (args: {start: {model: unknown}}) => {created++; expect(args.start.model).toEqual(model); throw Error('fixture captured accepted model boundary');}},
    };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<string>;
    const result = await new AsyncFunction('tools', 'sleep', 'now', 'input', fs.readFileSync(path.join(root, 'lib/capy-review-pass.js'), 'utf8'))(tools, async () => {}, async () => 0,
      {base:'main',out:f.out,pass:'p1',planFlags:f.flags,models:{specialist:model},startedAt:0});
    const accepted = model?.model_id.includes('sonnet');
    expect(result).toContain(accepted ? 'fixture captured accepted model boundary' : 'requires an explicit Sonnet or Haiku model');
    expect(created).toBe(accepted ? 1 : 0);
  } finally {f.cleanup();}
});
