/** Fork routes use upstream's real role/send boundary. Fake Codex only; no API spend. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { outsideVoiceCommand } from '../scripts/resolvers/outside-voice';
import { generateGovernorStructuredBody } from '../scripts/resolvers/governor-structured';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');
const ctx: TemplateContext = { skillName: 'review', tmplPath: '', host: 'claude', paths: { ...HOST_PATHS.claude, binDir: BIN, skillRoot: ROOT } };
type Arm = 'voice' | 'structured-voice' | 'packet' | 'diff' | 'spec';

function invoke(arm: Arm, options: { disabled?: boolean; stored?: string; effort?: string; reason?: string; native?: boolean;
  shell?: 'bash' | 'zsh'; errexit?: boolean; routeFailure?: boolean } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'governor-send-')));
  try {
    const repo = path.join(dir, 'fixture-repo'), fake = path.join(dir, 'fake-bin'), state = path.join(dir, 'state');
    const codexHome = path.join(dir, '.codex'), calls = path.join(dir, 'calls.jsonl');
    for (const folder of [repo, fake, state, codexHome, path.join(repo, '.gstack/tmp')]) fs.mkdirSync(folder, { recursive: true });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(CODEX_|GSTACK_|OPENAI_|CLAUDECODE)/.test(key))) as Record<string, string>;
    Object.assign(env, { HOME: dir, CODEX_HOME: codexHome, GSTACK_HOME: state, GSTACK_STATE_ROOT: '', TMPDIR: dir,
      PATH: `${fake}${path.delimiter}${process.env.PATH}`, CODEX_API_KEY: 'fake-only', CLAUDECODE: '1', GSTACK_ACTIVE_HOST: 'claude', CALLS: calls,
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
    if (options.effort) env.GSTACK_CODEX_EFFORT = options.effort;
    if (options.reason) env.GSTACK_CODEX_EFFORT_REASON = options.reason;
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8', timeout: 5000 });
      if (result.status !== 0) throw Error(result.stderr);
    };
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'source.txt'), 'source\n');
    git('add', 'source.txt'); git('commit', '-qm', 'fixture');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-native"\n');
    fs.writeFileSync(path.join(state, 'config.yaml'), `codex_reviews: ${options.disabled ? 'disabled' : 'enabled'}\ntelemetry: off\n${options.stored ? `codex_effort: ${options.stored}\n` : ''}`);
    const routedModel = options.routeFailure ? '--invalid' : 'gpt-routed';
    fs.writeFileSync(path.join(repo, '.gstack-policy.json'), JSON.stringify({ routing: { models: { 'outside-voice': { 'plan-review': { model: routedModel, effort: 'low' }, spec: { model: routedModel, effort: 'low' } } } } }));
    const fakeCode = path.join(dir, 'fake.ts');
    fs.writeFileSync(fakeCode, `import {appendFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2); if(args[0]==='--version'){console.log('codex-cli 0.160.0');process.exit(0)}
if(args[0]==='sandbox')process.exit(0);
const probe=args.includes('reply OK'); appendFileSync(process.env.CALLS!,JSON.stringify({args,probe,deadline:process.env._CODEX_DEADLINE})+'\\n');
if(probe){console.log('OK');process.exit(0)}
await Bun.stdin.text();const text=process.env.GSTACK_CODEX_VOICE==='spec'?'SCORE: 8\\nAMBIGUITIES: NONE\\n':'NO FINDINGS\\nRecommendation: proceed because no exploitable finding was found.\\n';
if(args[0]==='review')console.log(text);else writeFileSync(args[args.indexOf('-o')+1],text);`);
    fs.writeFileSync(path.join(fake, 'codex'), `#!/usr/bin/env bash\nexec '${process.execPath}' '${fakeCode}' "$@"\n`, { mode: 0o755 });
    const prompt = path.join(repo, '.gstack/tmp/prompt.txt');
    fs.writeFileSync(prompt, 'Review the supplied packet.\n', { mode: 0o600 });
    let script: string;
    if (arm === 'voice' || arm === 'structured-voice' || arm === 'spec') {
      script = outsideVoiceCommand({ ...ctx, skillName: arm === 'spec' ? 'spec' : 'plan-eng-review' }, {
        promptFile: prompt, timeoutMs: 120000, voice: arm === 'spec' ? 'spec' : 'plan-review',
        ...(arm === 'structured-voice' ? { structuredBase: 'main', gate: 'structured' } : { role: 'plan-review' }),
        ...(arm === 'spec' ? { gate: 'spec', reasoningEffort: 'medium' } : {}) });
    } else {
      const fences = [...generateGovernorStructuredBody(ctx).matchAll(/```bash\n([\s\S]*?)\n```/g)].map(match => match[1]!).filter(body => body.includes('_CODEX_T0='));
      expect(fences).toHaveLength(2);
      const route = spawnSync(path.join(BIN, 'gstack-codex-model'), ['resolve', '--model', options.native ? '' : 'gpt-routed',
        '--effort', 'medium', '--source', options.native ? 'default' : 'policy', '--selection-only'], { cwd: repo, env, encoding: 'utf8', timeout: 5000 });
      expect(route.status, route.stderr).toBe(0);
      const model = /^CODEX_MODEL='([A-Za-z0-9._-]+)'$/m.exec(route.stdout)?.[1];
      expect(model).toBeDefined();
      // Carry the printed model as a literal into a fresh Bash call, exactly
      // as the skill directs. A prefix eval would hide unbound shell state.
      script = fences[arm === 'packet' ? 0 : 1]!
        .replaceAll('~/.claude/skills/gstack', ROOT).replaceAll('{PLAN_EFFORT}', 'medium')
        .replaceAll('{CODEX_MODEL}', model!).replaceAll('{PACKET_PATH}', prompt)
        .replaceAll('<prompt-file-name>', 'prompt.txt').replaceAll('<base>', 'main');
      // Observe the shared classifier rather than treating a final assignment as success.
      script += '\nexit "$_CODEX_GATE_RC"\n';
    }
    const started = Math.floor(Date.now() / 1000);
    const result = spawnSync(options.shell ?? 'bash', ['-c', (options.errexit ? 'set -e\n' : '') + script], { cwd: repo, env, encoding: 'utf8', timeout: 30000 });
    const rows = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    const receipts = fs.readdirSync(dir).filter(name => name.endsWith('.effort')).map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    const projects = path.join(state, 'projects');
    const gateRows = fs.existsSync(projects) ? (fs.readdirSync(projects, { recursive: true }) as string[])
      .filter(file => file.endsWith('-gates.jsonl')).flatMap(file => fs.readFileSync(path.join(projects, file), 'utf8').trim().split('\n').map(line => JSON.parse(line))) : [];
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, rows, receipts, gateRows, started };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

for (const arm of ['voice', 'packet', 'diff'] as const) {
  test(`${arm}: one bound routed model and one deadline reach the real send wrapper`, () => {
    const result = invoke(arm);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.rows.map(row => row.probe)).toEqual([true, false]);
    expect(result.rows.every(row => row.args.includes('model="gpt-routed"'))).toBe(true);
    // Upstream role-ready deliberately caps readiness at half of the bound
    // invocation budget; dispatch retains the original end, without a reset.
    const budget = arm === 'voice' ? 120 : 540;
    const end = Number(result.rows[1].deadline), readinessEnd = Number(result.rows[0].deadline);
    expect(end).toBeGreaterThanOrEqual(result.started + budget);
    expect(end).toBeLessThanOrEqual(result.started + budget + 1);
    expect(readinessEnd).toBeLessThan(end);
    expect(end - readinessEnd).toBeLessThanOrEqual(Math.ceil(budget / 2));
    expect(result.rows[1].args).toContain(`model_reasoning_effort="${arm === 'voice' ? 'low' : 'medium'}"`);
  }, 30000);
  test(`${arm}: disabled consent starts no repository-bearing CLI call`, () => {
    const result = invoke(arm, { disabled: true });
    expect(result.status).not.toBe(0);
    // Upstream readiness may send its fixed low-effort "reply OK" probe,
    // which carries no repository data. The actual review send is refused.
    expect(result.rows.filter(row => !row.probe)).toEqual([]);
    expect(result.rows.every(row => row.args.includes('reply OK') && row.args.includes('model_reasoning_effort="low"'))).toBe(true);
    expect(result.stderr).toContain('consent_missing');
  }, 30000);
}

test('unrouted governor preserves the configured native model instead of the plan catalog default', () => {
  const result = invoke('packet', { native: true });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.rows.every(row => row.args.includes('model="gpt-native"'))).toBe(true);
}, 30000);

test('upstream env/config override the routed default, including max, and receipts record what was sent', () => {
  for (const options of [{ stored: 'low' }, { stored: 'low', effort: 'max' }]) {
    const result = invoke('packet', options);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.receipts).toEqual([{ effort: options.effort ?? options.stored, effort_source: options.effort ? 'env' : 'config', effort_reason: '' }]);
    expect(result.rows[1].args).toContain(`model_reasoning_effort="${options.effort ?? options.stored}"`);
  }
}, 30000);

test('the final xhigh/ultra send is refused unless its override is recorded', () => {
  for (const effort of ['xhigh', 'ultra']) {
    const refused = invoke('packet', { effort });
    expect(refused.status).not.toBe(0);
    expect(refused.rows.map(row => row.probe)).toEqual([true]);
    const allowed = invoke('packet', { effort, reason: 'Owner requested the difficult semantic review' });
    expect(allowed.status, allowed.stderr + allowed.stdout).toBe(0);
    expect(allowed.receipts).toEqual([{ effort, effort_source: 'user-override', effort_reason: 'Owner requested the difficult semantic review' }]);
    expect(allowed.rows[1].args).toContain(`model_reasoning_effort="${effort}"`);
  }
}, 30000);

test('spec records its fixed medium effort even when the policy is low and the environment says ultra', () => {
  const result = invoke('spec', { effort: 'ultra' });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.rows[1].args).toContain('model_reasoning_effort="medium"');
  expect(result.gateRows.find(row => row.gate === 'outside-voice:spec')).toMatchObject({ effort: 'medium', effort_source: 'default', effort_reason: '' });
  expect(result.stdout).not.toContain('CODEX_EFFORT_DECISION:');
}, 30000);

// Fork routing guards migrated from upstream-owned fixture files. Exercise
// the actual registered selection/send callbacks, never a private router stub.
for (const shell of ['bash', ...(Bun.which('zsh') ? ['zsh' as const] : [])] as const) {
  test(`${shell}: routed exec/review settings stay distinct argv through the upstream carrier`, () => {
    for (const arm of ['voice', 'structured-voice'] as const) {
      const result = invoke(arm, { shell });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      const dispatch = result.rows.find(row => !row.probe);
      expect(dispatch.args).toContain('model="gpt-routed"');
      if (arm === 'structured-voice') expect(dispatch.args).toContain('review_model="gpt-routed"');
      expect(dispatch.args).toContain('model_reasoning_effort="low"');
      expect(dispatch.args).toContain('skills.include_instructions=false');
      expect(result.gateRows.find(row => row.gate === 'outside-voice:plan-review')).toMatchObject({ effort: 'low', effort_source: 'routed' });
    }
  }, 30000);
}

test.each([false, true])('route failure refuses dispatch before any Codex call with errexit=%s', errexit => {
  const result = invoke('voice', { errexit, routeFailure: true });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('malformed model slug');
  expect(result.rows).toEqual([]);
}, 30000);
