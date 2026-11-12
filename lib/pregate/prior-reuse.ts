/** Per-file local evidence from the previous pregate record. All I/O is injected; uncertainty runs the full selection. */
import * as path from 'node:path';
import { ARTIFACT_SCHEMAS, checkSchema, type PregateFile, type ValidationError } from '../headless-artifacts';
import { LOCKFILES, PIN_FILES } from '../evidence-bundle';
import { baseBranchOf } from './remote-receipt';
import type { TouchedFile } from './types';

export type PriorReuseReason = 'opted_out' | 'no_prior' | 'policy_changed' | 'runtime_changed' | 'tree_unavailable' | 'delta_deletes' | 'identity_input' | 'delta_no_lane';
export type PriorReuse =
  | { ok: true; candidates: string[]; deltaSelected: string[]; delta: string[] }
  | { ok: false; reason: PriorReuseReason; detail: string; line: string };
export interface PriorReuseInput {
  prior?: PregateFile | null;
  enabled?: boolean;
  policy: string;
  policyDigest?: string;
  base: string;
  tree: string;
  runtime: string | null;
  localTests: string[];
}
export interface PriorReuseReaders {
  /** null means failure; an empty string is a successful empty git result. */
  git: (args: string[]) => string | null;
  select: (touched: TouchedFile[]) => { tests: string[]; noLane: string[] };
  /** The same base-unioned always-run list selectLanes uses, restricted to current local tests. Throws on unreadable input. */
  always: () => string[];
}
const sorted = (files: string[]) => [...new Set(files)].sort();
const refuse = (reason: PriorReuseReason, detail: string): PriorReuse =>
  ({ ok: false, reason, detail, line: `REUSE: refused reason=${reason} — ${detail}; every selected test runs here` });

/** evidence-bundle executionIdentity hashes LOCKFILES, PIN_FILES, package.json and .github/workflows; nested copies are conservative identity inputs too. */
export function isPriorIdentityInput(file: string): boolean {
  const name = file.split('/').at(-1)!;
  return file.startsWith('.gstack/') || file.startsWith('.github/workflows/') ||
    LOCKFILES.includes(name) || /\.lock(?:b|\.json)?$/.test(name) || PIN_FILES.includes(name) || name === 'package.json' || name === 'bunfig.toml' ||
    /^tsconfig.*\.json$/.test(name) || /^(?:vitest|jest|playwright)(?:\..*)?\.config(?:\..+)?$/.test(name);
}

export function priorReuse(input: PriorReuseInput, readers: PriorReuseReaders): PriorReuse {
  if (input.enabled === false) return refuse('opted_out', '--no-prior-reuse disables the prior local pass');
  const prior = input.prior;
  const errors: ValidationError[] = [];
  if (prior) checkSchema(prior, ARTIFACT_SCHEMAS.pregate, '', errors, 'prior pregate');
  const lanes = !errors.length ? prior?.checks?.find(c => c.id === 'lanes') : undefined;
  if (!prior || errors.length || !lanes || !['pass', 'warn'].includes(lanes.status) || !validRunnerPasses(lanes.passed_by_runner)) {
    return refuse('no_prior', 'no valid prior pass or warn with passed_by_runner at this output path');
  }
  if (!samePolicy(prior.policy, input.policy, readers.git) || prior.policy_digest !== input.policyDigest || baseBranchOf(prior.base) !== input.base) {
    return refuse('policy_changed', 'the prior policy, policy digest or base branch differs');
  }
  if (!input.runtime || lanes.inputs?.runtime !== input.runtime) return refuse('runtime_changed', 'the prior lanes runtime differs from the current launch runtime');
  const trees = [prior.tree, input.tree];
  try {
    if (trees.some(t => !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(t) || readers.git(['cat-file', '-e', `${t}^{tree}`]) === null)) {
      return refuse('tree_unavailable', 'both fingerprints must exist as tree objects in this repository');
    }
    // -z preserves paths containing tabs, newlines or Git quote characters. --no-renames turns a rename into a deletion.
    const raw = readers.git(['diff-tree', '-r', '--no-renames', '--name-status', '-z', prior.tree, input.tree]);
    if (raw === null) return refuse('tree_unavailable', 'the tree delta could not be read');
    const fields = raw.split('\0');
    if (fields.pop() !== '') return refuse('tree_unavailable', 'the tree delta is not NUL terminated');
    const touched: TouchedFile[] = [];
    for (let i = 0; i < fields.length; i += 2) {
      const status = fields[i], file = fields[i + 1];
      if (status === 'D') return refuse('delta_deletes', `the delta deletes ${file}`);
      if (!file || (status !== 'A' && status !== 'M')) return refuse('tree_unavailable', 'the tree delta contains an unsupported entry');
      touched.push({ path: file, status, uncommitted: false });
    }
    const delta = sorted(touched.map(t => t.path));
    const identity = delta.filter(isPriorIdentityInput);
    if (identity.length) return refuse('identity_input', `execution identity input(s) changed: ${identity.join(' ')}`);
    const selection = readers.select(touched);
    if (selection.noLane.length) return refuse('delta_no_lane', `delta path(s) have no known lane: ${selection.noLane.join(' ')}`);
    const deltaSelected = sorted(selection.tests);
    const excluded = new Set([...deltaSelected, ...(delta.length ? readers.always() : [])]);
    const passed = new Set(Object.values(lanes.passed_by_runner!).flat());
    const candidates = sorted(input.localTests.filter(f => passed.has(f) && !excluded.has(f)));
    return { ok: true, candidates, deltaSelected, delta };
  } catch {
    return refuse('tree_unavailable', 'a delta, selection or always-run input could not be read safely');
  }
}

/** A base policy label: `<ref>@<base commit>:<policy path>` (lib/pregate/config.ts). */
const BASE_POLICY_LABEL = /^(\S+)@([0-9a-f]{7,40}):(\S+)$/;

/**
 * The same policy, read exactly or across a moved base. Every worktree shares `origin/<base>`, which other sessions
 * fetch, so the label's base commit moves while the policy file stays byte-identical; that is the same policy when the
 * file is the same blob at both commits. The delta is still selected under the current policy, so this only stops a
 * refusal no result depends on. Anything unresolvable is a different policy.
 */
export function samePolicy(prior: string | undefined, current: string, git: PriorReuseReaders['git']): boolean {
  if (prior === current) return true;
  const a = prior ? BASE_POLICY_LABEL.exec(prior) : null;
  const b = BASE_POLICY_LABEL.exec(current);
  if (!a || !b || a[1] !== b[1] || a[3] !== b[3]) return false;
  const blob = (commit: string, file: string) => git(['rev-parse', '--verify', '--quiet', `${commit}:${file}`])?.trim() || null;
  const before = blob(a[2]!, a[3]!);
  return !!before && before === blob(b[2]!, b[3]!);
}

/** The schema intentionally declares an object; validate its dynamic runner entries before trusting evidence. */
function validRunnerPasses(value: unknown): value is Record<string, string[]> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.values(value).every(files => Array.isArray(files) && files.every(f => typeof f === 'string'));
}

type Group = { cwd: string; runner: string; files: string[] };
export const runnerKey = (group: Pick<Group, 'cwd' | 'runner'>): string => `${group.cwd}\t${group.runner}`;

/** Match candidates only after the complete plan, including Playwright's selected config, is known. */
export function matchPriorRunners(prior: PregateFile | null | undefined, decision: PriorReuse, planned: Group[], selected: number, gap = false) {
  const passed = prior?.checks.find(c => c.id === 'lanes')?.passed_by_runner ?? {};
  const candidates = new Set(decision.ok && !gap ? decision.candidates : []);
  const reused = new Set<string>();
  const changed = new Set<string>();
  const evidence = new Map<string, string[]>();
  const groups: Group[] = [];
  for (const group of planned) {
    const key = runnerKey(group);
    const before = new Set(validRunnerPasses(passed) ? passed[key] ?? [] : []);
    evidence.set(key, sorted([...(evidence.get(key) ?? []), ...group.files.map(f => path.posix.join(group.cwd, f))]));
    const files = group.files.filter(f => {
      const file = path.posix.join(group.cwd, f);
      if (!candidates.has(file)) return true;
      if (before.has(file)) { reused.add(file); return false; }
      changed.add(file);
      return true;
    });
    if (files.length) groups.push({ ...group, files });
  }
  const line = !decision.ok ? decision.line : `REUSE: accepted ${reused.size} of ${selected} selected local test file(s) from the prior pass at tree ${prior!.tree.slice(0, 12)}; ${selected - reused.size} still run (delta ${decision.delta.length} path(s), ${decision.deltaSelected.length} selected)${changed.size ? `; ${changed.size} candidate(s) rerun because their runner changed` : ''}`;
  return { groups, reused: sorted([...reused]), passedByRunner: Object.fromEntries(evidence), line };
}
