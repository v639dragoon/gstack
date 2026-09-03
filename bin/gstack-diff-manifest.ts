// gstack-diff-manifest.ts — the computation half of bin/gstack-diff-manifest.
// Run only via that wrapper (env GDM_* + the three-section stdin payload).
// Kept as a real .ts file instead of an embedded `bun -e` string because the
// glob→regex code below is backslash-dense and double-quoted-bash escaping of
// it is a standing bug class in embedded one-liners.
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

type FileEntry = { path: string; additions: number; deletions: number; untracked: boolean };
type DocImpactRule = { paths?: string[]; docs?: string[] };
type Policy = {
  version?: number;
  auth_surfaces?: string[];
  d_surfaces?: string[];
  load_bearing_docs?: string[];
  doc_impact_map?: DocImpactRule[];
};

const env = process.env;

const stdin = await Bun.stdin.text();
const [rawStat = '', rawUntracked = '', rawScope = ''] = stdin.split(
  /\n---UNTRACKED---\n|\n---SCOPE---\n/,
);

// ---- changed-file set: committed+worktree numstat ∪ untracked --------------
const files: FileEntry[] = [];
const seen = new Set<string>();
const addFile = (adds: number, dels: number, p: string, untracked: boolean) => {
  if (!p || seen.has(p)) return;
  seen.add(p);
  files.push({ path: p, additions: adds, deletions: dels, untracked });
};
for (const line of rawStat.split('\n')) {
  const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
  if (!m) continue;
  addFile(
    m[1] === '-' ? 0 : parseInt(m[1], 10),
    m[2] === '-' ? 0 : parseInt(m[2], 10),
    m[3],
    false,
  );
}
for (const line of rawUntracked.split('\n')) {
  const m = line.match(/^(\d+)\t0\t(.+)$/);
  if (!m) continue;
  addFile(parseInt(m[1], 10), 0, m[2], true);
}
files.sort((a, b) => a.path.localeCompare(b.path));
const diffLines = files.reduce((s, f) => s + f.additions + f.deletions, 0);

// ---- scope passthrough -----------------------------------------------------
const scope: Record<string, boolean | string | null> = {
  frontend: false,
  backend: false,
  prompts: false,
  tests: false,
  docs: false,
  config: false,
  migrations: false,
  api: false,
  auth: false,
  error: null,
};
const scopeLines: string[] = [];
for (const line of rawScope.split('\n')) {
  if (!/^SCOPE_[A-Z_]+=/.test(line)) continue;
  scopeLines.push(line);
  const eq = line.indexOf('=');
  const k = line.slice(0, eq);
  const v = line.slice(eq + 1);
  if (k === 'SCOPE_ERROR') scope.error = v;
  else scope[k.replace('SCOPE_', '').toLowerCase()] = v === 'true';
}
if (env.GDM_SCOPE_EXIT !== '0' && !scope.error) scope.error = `exit_${env.GDM_SCOPE_EXIT}`;

// ---- policy ----------------------------------------------------------------
// Minimatch-lite: ** crosses directory boundaries, * and ? stay within one
// segment. A pattern with no slash matches a repo-root entry only. `**/` and
// `**` are swapped to control-char placeholders (written as \uXXXX escapes,
// never raw bytes) so the single-star pass can't eat them; `**/` renders as
// an OPTIONAL directory prefix so `**/otp/**` also matches a repo-root
// `otp/...`.
const globToRe = (g: string): RegExp => {
  const escaped = g
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0001/g, '(.*/)?')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
};
const matchAny = (p: string, globs: string[]): boolean => globs.some((g) => globToRe(g).test(p));

let policy: {
  present: boolean;
  path: string | null;
  sha256: string | null;
  version: number | null;
} = {
  present: false,
  path: null,
  sha256: null,
  version: null,
};
let pol: Policy | null = null;
if (env.GDM_POLICY_PATH) {
  try {
    const raw = fs.readFileSync(env.GDM_POLICY_PATH, 'utf-8');
    pol = JSON.parse(raw) as Policy;
    policy = {
      present: true,
      path: path.basename(env.GDM_POLICY_PATH),
      sha256: crypto.createHash('sha256').update(raw).digest('hex'),
      version: pol.version ?? null,
    };
  } catch {
    pol = null; // unreadable/invalid policy degrades to policy-less, never crashes the manifest
  }
}
const filePaths = files.map((f) => f.path);

// ---- shadow verdicts (LOGGED ONLY — nothing routes on these in Phase 0) ----
const authGlob = scope.auth === true;
const authPolicy = pol ? filePaths.some((p) => matchAny(p, pol!.auth_surfaces ?? [])) : null;
const dSurfaceMatches = pol ? filePaths.filter((p) => matchAny(p, pol!.d_surfaces ?? [])) : [];
const loadBearingMatches = pol
  ? filePaths.filter((p) => matchAny(p, pol!.load_bearing_docs ?? []))
  : [];
const docImpactMatches: { paths: string[]; docs: string[] }[] = [];
if (pol) {
  for (const rule of pol.doc_impact_map ?? []) {
    const hit = filePaths.filter((p) => matchAny(p, rule.paths ?? []));
    if (hit.length) docImpactMatches.push({ paths: hit, docs: rule.docs ?? [] });
  }
}

// Tier (fail-upward; audit §10 / Appendix A rule, shadow-only):
//   D  any file on a d_surface
//   A  EVERY file trivial-shaped (docs/tests/css/VERSION-shaped) — demoted to
//      B when any of them is a load-bearing doc (TODOS.md-class files crit:
//      2 of 3 tier-A docs-only PRs in the audit corpus produced CRITICALs)
//   C  backend/migrations/api scope, a scope error, or an empty/unknown set
//   B  everything else
const trivialRe =
  /(\.md$|\.(css|scss|less|sass|pcss)$|(^|\/)(CHANGELOG|TODOS|VERSION|LICENSE)[^/]*$|\.(test|spec)\.[^/]+$|(^|\/)(tests?|__tests__|e2e|spec|design-reviews|eng-reviews)\/)/;
let tier: string | null = null;
let tierRule: string | null = null;
if (pol) {
  if (dSurfaceMatches.length) {
    tier = 'D';
    tierRule = `d_surface:${dSurfaceMatches[0]}`;
  } else if (files.length === 0) {
    tier = 'C';
    tierRule = 'empty-file-list (fail-upward)';
  } else if (scope.error) {
    tier = 'C';
    tierRule = `scope-error:${scope.error} (fail-upward)`;
  } else if (filePaths.every((p) => trivialRe.test(p))) {
    if (loadBearingMatches.length) {
      tier = 'B';
      tierRule = `load-bearing-doc:${loadBearingMatches[0]}`;
    } else {
      tier = 'A';
      tierRule = 'all-files-trivial-shaped';
    }
  } else if (scope.backend || scope.migrations || scope.api) {
    tier = 'C';
    tierRule = `scope:${scope.migrations ? 'migrations' : scope.backend ? 'backend' : 'api'}`;
  } else {
    tier = 'B';
    tierRule = 'routine-product-change';
  }
}

const docFpInput =
  filePaths.join('\n') +
  '\n--base--\n' +
  env.GDM_BASE +
  '\n--doc-impact--\n' +
  docImpactMatches
    .flatMap((r) => r.paths)
    .sort()
    .join('\n');
const docFp = crypto.createHash('sha256').update(docFpInput).digest('hex');

const shadow = {
  risk_tier: tier,
  tier_rule: tierRule,
  auth_glob: authGlob,
  auth_policy: authPolicy,
  auth_disagreement: pol ? authGlob !== authPolicy : null,
  d_surface_matches: dSurfaceMatches,
  doc_impact_would_dispatch: pol ? docImpactMatches.length > 0 : null,
  doc_impact_matches: docImpactMatches,
  load_bearing_doc_matches: loadBearingMatches,
};

// ---- deterministic routing (enforced by the review governor) -------------
type RoutingOutcome = {
  present: boolean;
  outcome_id: string | null;
  slice_number: number | null;
  is_final_slice: boolean;
  is_flag_flip: boolean;
  risk_tier_override: string | null;
};
const absentOutcome: RoutingOutcome = {
  present: false,
  outcome_id: null,
  slice_number: null,
  is_final_slice: false,
  is_flag_flip: false,
  risk_tier_override: null,
};
let outcome = absentOutcome;
try {
  const candidate = JSON.parse(env.GDM_OUTCOME_JSON || '');
  if (candidate && candidate.present === true && typeof candidate.outcome_id === 'string') {
    outcome = {
      present: true,
      outcome_id: candidate.outcome_id,
      slice_number: Number.isInteger(candidate.slice_number) ? candidate.slice_number : null,
      is_final_slice: candidate.is_final_slice === true,
      is_flag_flip: candidate.is_flag_flip === true,
      risk_tier_override: /^[ABCD]$/.test(candidate.risk_tier_override)
        ? candidate.risk_tier_override
        : null,
    };
  }
} catch {
  /* absent/unparsable is deliberately non-fatal */
}

let routingTier: 'A' | 'B' | 'C' | 'D' = 'D';
let routingRule = '';
let tierSource:
  | 'policy'
  | 'fail-up:no-policy'
  | 'fail-up:policy-error'
  | 'fail-up:scope-error'
  | 'fail-up:empty';
if (!env.GDM_POLICY_PATH) {
  tierSource = 'fail-up:no-policy';
  routingRule = 'no-policy (fail-upward)';
} else if (!pol) {
  tierSource = 'fail-up:policy-error';
  routingRule = 'policy-error (fail-upward)';
} else if (files.length === 0) {
  tierSource = 'fail-up:empty';
  routingRule = 'empty-file-list (fail-upward)';
} else if (scope.error) {
  tierSource = 'fail-up:scope-error';
  routingRule = `scope-error:${scope.error} (fail-upward)`;
} else {
  tierSource = 'policy';
  routingTier = tier as 'A' | 'B' | 'C' | 'D';
  routingRule = tierRule!;
  if (scope.migrations === true) {
    routingTier = 'D';
    routingRule = 'scope:migrations (critical surface)';
  }
  // Authentication/authorization is a critical surface (dohma CLAUDE.md floor):
  // an auth_surfaces match ROUTES as D even when no d_surface glob fires.
  // Shadow keeps the audit's original rule; only routing promotes.
  const authHit = filePaths.find((p) => matchAny(p, pol!.auth_surfaces ?? []));
  if (routingTier !== 'D' && authHit) {
    routingTier = 'D';
    routingRule = `auth_surface:${authHit}`;
  }
}
const rank: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
if (outcome.risk_tier_override) {
  if (rank[outcome.risk_tier_override] > rank[routingTier]) {
    routingTier = outcome.risk_tier_override as 'A' | 'B' | 'C' | 'D';
    routingRule += `;override:${outcome.risk_tier_override}`;
  } else if (rank[outcome.risk_tier_override] < rank[routingTier]) {
    routingRule += `;override-ignored:${outcome.risk_tier_override}`;
  }
}
const routing = {
  risk_tier: routingTier,
  tier_rule: routingRule,
  tier_source: tierSource,
  auth_surface_matches: pol ? filePaths.filter((p) => matchAny(p, pol!.auth_surfaces ?? [])) : [],
  d_surface_matches: dSurfaceMatches,
  load_bearing_doc_matches: loadBearingMatches,
  doc_impact_matches: docImpactMatches,
  doc_impact_would_dispatch: docImpactMatches.length > 0,
  outcome,
};

// ---- write (content-addressed; reuse on identical wtree + policy) ----------
const wtree12 = (env.GDM_WTREE || 'nowtree').slice(0, 12);
const outPath = path.join(env.GDM_MANIFEST_DIR!, `${wtree12}.json`);
const manifest = {
  manifest_version: 1,
  run_id: env.GDM_RUN_ID,
  session_id: env.GDM_SESSION_ID || null,
  generated_at: new Date().toISOString(),
  base: env.GDM_BASE,
  merge_base: env.GDM_MERGE_BASE || null,
  commit_full: env.GDM_COMMIT_FULL || null,
  wtree: env.GDM_WTREE || null,
  dirty: env.GDM_DIRTY === 'true',
  diff_lines: diffLines,
  files,
  scope,
  policy,
  doc_fingerprint: docFp,
  shadow,
  routing,
};
let reused = false;
if (fs.existsSync(outPath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    reused =
      !!existing.routing &&
      existing.policy?.sha256 === policy.sha256 &&
      JSON.stringify(existing.routing?.outcome ?? absentOutcome) === JSON.stringify(outcome);
  } catch {
    reused = false;
  }
}
if (reused) {
  const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  Object.assign(existing, {
    run_id: manifest.run_id,
    session_id: manifest.session_id,
    generated_at: manifest.generated_at,
    base: manifest.base,
    merge_base: manifest.merge_base,
    commit_full: manifest.commit_full,
  });
  fs.writeFileSync(outPath, JSON.stringify(existing, null, 2) + '\n');
} else {
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
}

// Opportunistic cleanup: dirty-tree churn mints a file per content state;
// keep the 20 newest, they are all regenerable.
const entries = fs
  .readdirSync(env.GDM_MANIFEST_DIR!)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ f, m: fs.statSync(path.join(env.GDM_MANIFEST_DIR!, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m);
for (const e of entries.slice(20)) fs.unlinkSync(path.join(env.GDM_MANIFEST_DIR!, e.f));

console.log(`RUN_ID=${env.GDM_RUN_ID}`);
console.log(`MANIFEST_PATH=${outPath}`);
console.log(`MANIFEST_WTREE=${wtree12}`);
console.log(`DIFF_LINES=${diffLines}`);
console.log(`DOC_FP=${docFp}`);
console.log(`SHADOW_TIER=${tier ?? 'null'}`);
console.log(`RISK_TIER=${routingTier}`);
console.log(`OUTCOME_PRESENT=${outcome.present}`);
for (const l of scopeLines) console.log(l);
