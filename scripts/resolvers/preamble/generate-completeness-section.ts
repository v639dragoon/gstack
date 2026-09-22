import { isSolProfileModel } from '../../models';
import type { TemplateContext } from '../types';

export function generateCompletenessSection(ctx?: TemplateContext): string {
  if (ctx?.explainLevel === 'terse') return '';
  if (isSolProfileModel(ctx?.model)) {
    return `## Completeness Principle — Boil the Ocean Within Scope

AI makes completeness cheap, so do the complete thing **inside the user's explicit task boundary**. The requested target, allowed files or systems, and acceptance criteria define the lake. Within that lake, cover the relevant tests, edge cases, and error paths. Related but unnecessary refactors, speculative hardening, cleanup, and migrations are separate scope: report them, do not implement them.

When options differ in in-scope coverage, include \`Completeness: X/10\` (10 = all relevant in-scope edge cases, 7 = happy path, 3 = shortcut). When options differ in kind, write: \`Note: options differ in kind, not coverage — no completeness score.\` Do not fabricate scores or expand the lake to raise one.`;
  }
  return `## Completeness Principle — Bounded Completion

Completion is bounded by the accepted behavior, not by what is cheap to add: implement it, cover the material failure cases, resolve blockers, finish. No unrelated cleanup, speculative tests, whole-file rewrites or repeated status reports; separate work (rewrites, long migrations) is its own scope, never a shortcut excuse.

When options differ in coverage, include \`Completeness: X/10\` (10 = every material in-scope case, 7 = happy path, 3 = shortcut). When options differ in kind, write: \`Note: options differ in kind, not coverage — no completeness score.\` Do not fabricate scores or widen scope to raise one.`;
}
