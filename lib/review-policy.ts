/** Opt-in review policy. Omitted/invalid switches preserve upstream defaults. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const globToRe = (g: string) => new RegExp('^' + g
  .replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0000')
  .replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  .replace(/\u0001/g, '(.*/)?').replace(/\u0000/g, '.*') + '$');
export const matchAny = (p: string, gs: string[]) => gs.some(g => globToRe(g).test(p));
export const globs = (value: unknown, fallback: string[] = []) =>
  Array.isArray(value) && value.every(g => typeof g === 'string' && g.length > 0) ? value : fallback;
export const DEFAULT_TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/*_spec.*',
  'test/**', 'tests/**', 'spec/**', '__tests__/**', 'cypress/**', 'e2e/**'];
export const DEFAULT_ENV_SURFACES = ['lib/env/**', '.env.example'];
export function readPolicy(repo: string): any {
  try { return JSON.parse(readFileSync(join(repo, '.gstack-policy.json'), 'utf8')); }
  catch { return {}; }
}
export function policyFlags(policy: any) {
  const p = policy?.routing?.passes;
  const flag = (key: string, fallback = true) => typeof p?.[key] === 'boolean' ? p[key] : fallback;
  return {
    upstreamSpecialists: flag('upstream_specialists'),
    upstreamStructured: flag('upstream_structured'),
    codexChallenge: flag('codex_challenge'),
    adversarialClaude: flag('native_adversarial'),
    redTeamLocTrigger: flag('red_team_loc_trigger'),
    greptile: flag('greptile'),
    coverageRating: flag('coverage_rating'),
    codexDocVoice: flag('doc_voice'),
    auditReuse: flag('audit_reuse', false),
    nonCodeDelta: flag('non_code_delta', false),
    autofixInformational: flag('autofix_informational'),
    docReleaseByImpact: flag('doc_release_by_impact', false),
  };
}
export const FLAG_NAMES: Record<string, string> = {
  upstreamSpecialists: 'UPSTREAM_SPECIALISTS', upstreamStructured: 'UPSTREAM_STRUCTURED',
  codexChallenge: 'CODEX_CHALLENGE', adversarialClaude: 'ADVERSARIAL_CLAUDE',
  redTeamLocTrigger: 'RED_TEAM_LOC_TRIGGER', greptile: 'GREPTILE', coverageRating: 'COVERAGE_RATING',
  codexDocVoice: 'CODEX_DOC_VOICE', auditReuse: 'AUDIT_REUSE', nonCodeDelta: 'NON_CODE_DELTA',
  autofixInformational: 'AUTOFIX_INFORMATIONAL', docReleaseByImpact: 'DOC_RELEASE_BY_IMPACT',
};
export function surfaceFlags(policy: any, files: string[], tier: string, scope: any) {
  const full = !policy?.lanes || tier === 'D' || scope?.config === true ||
    files.some(p => matchAny(p, globs(policy.lanes.full_paths)));
  // A missing CI backstop cannot silently defer a deterministic build.
  const ci = typeof policy?.lanes?.ci_backstop === 'string' ? policy.lanes.ci_backstop.trim() : '';
  return {
    qaSmoke: !Array.isArray(policy?.qa_smoke_surfaces) ||
      !policy.qa_smoke_surfaces.every((g: any) => typeof g === 'string' && g.length > 0) ||
      files.some(p => matchAny(p, globs(policy.qa_smoke_surfaces))),
    fullLanesRequired: full || !ci,
    buildGate: full || !ci ? 'REQUIRED' : 'DEFERRED',
    ciBackstop: ci,
  };
}

export type Delta = { files: { path: string; status: string }[]; lines: number; error?: string };
export function gitRead(repo: string, args: string[]) {
  const r = spawnSync('git', ['--no-replace-objects', ...args], { cwd: repo, encoding: 'utf8',
    timeout: 10_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_NO_LAZY_FETCH: '1' } });
  if (r.status !== 0 || r.error) throw new Error('git-failure');
  return r.stdout;
}
/** Compare immutable content trees, including dirty/untracked input captured by gstack-wtree. */
export function treeDelta(repo: string, from: string, to: string): Delta {
  try {
    if (![from, to].every(t => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(t))) throw new Error('git-failure');
    for (const t of [from, to]) if (gitRead(repo, ['cat-file', '-t', t]).trim() !== 'tree') throw new Error('git-failure');
    const parts = gitRead(repo, ['diff', '--no-ext-diff', '--no-renames', '--name-status', '-z', from, to]).split('\0');
    const files = [];
    for (let i = 0; i < parts.length - 1; i += 2) files.push({ status: parts[i], path: parts[i + 1] });
    const nums = gitRead(repo, ['diff', '--no-ext-diff', '--no-renames', '--numstat', '-z', from, to]).split('\0');
    let lines = 0;
    for (const row of nums.filter(Boolean)) {
      const [a, d] = row.split('\t');
      if (!/^\d+$/.test(a) || !/^\d+$/.test(d)) lines = Infinity;
      else lines += Number(a) + Number(d);
    }
    return { files, lines };
  } catch { return { files: [], lines: 0, error: 'git-failure' }; }
}
export function releaseMetadata(repo: string, from: string, to: string, p: string): boolean {
  if (p === 'VERSION' || /^(CHANGELOG(?:\.[^/]+)?|changelog\.d\/[^/]+|\.changes\/[^/]+)$/.test(p)) return true;
  if (p !== 'package.json') return false;
  try {
    const content = (tree: string) => {
      const obj = JSON.parse(gitRead(repo, ['show', `${tree}:package.json`]));
      delete obj.version;
      return JSON.stringify(obj);
    };
    return content(from) === content(to);
  } catch { return false; }
}
export const docPath = (p: string) => p.endsWith('.md') || /^docs\/.*\.(rst|txt)$/.test(p);
export function sensitiveTriggers(files: Delta['files'], policy: any): string[] {
  const triggers: string[] = [];
  for (const { path: p } of files) {
    if (matchAny(p, globs(policy.auth_surfaces))) triggers.push(`auth-surface:${p}`);
    if (matchAny(p, globs(policy.d_surfaces)) && !globs(policy.d_surface_exceptions).includes(p)) triggers.push(`d-surface:${p}`);
    if (matchAny(p, globs(policy.env_surfaces, DEFAULT_ENV_SURFACES))) triggers.push(`env:${p}`);
    if (matchAny(p, ['migrations/**', '**/migrations/**', 'db/migrate/**', 'db/data/**', 'data_migrations/**', '**/data_migrations/**', 'alembic/**'])) triggers.push(`migration:${p}`);
    if (matchAny(p, ['api/**', '**/api/**', '**/*controller*', '**/*route*', '**/*endpoint*', '**/*.graphql', '**/*.gql', 'openapi.*', 'swagger.*'])) triggers.push(`api:${p}`);
  }
  return triggers;
}
export function auditReusable(repo: string, gate: string, verdict: string, from: string, to: string, policy: any) {
  const delta = treeDelta(repo, from, to);
  if (delta.error || sensitiveTriggers(delta.files, policy).length) return false;
  return delta.files.every(f => {
    if (releaseMetadata(repo, from, to, f.path)) return true;
    if (gate === 'doc-release') return false;
    if (docPath(f.path)) return true;
    return gate === 'plan-completion' && matchAny(f.path, globs(policy.test_globs, DEFAULT_TEST_GLOBS)) ||
      gate === 'coverage-audit' && verdict === 'clean' && f.status === 'A' && matchAny(f.path, globs(policy.test_globs, DEFAULT_TEST_GLOBS));
  });
}
