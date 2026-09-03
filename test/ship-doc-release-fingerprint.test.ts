/** D1 (2026-09-30): upstream audit contract; fork attempt telemetry survives. */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
const ROOT = path.resolve(import.meta.dir, '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf-8');
describe('document-release audit telemetry (D1)', () => {
  const content = read('ship/sections/documentation.md');
  test('audit retains upstream attempt budget, hash-bound reentry and blocked recovery', () => {
    expect(content).toContain('initial audit plus ONE repair/re-audit');
    expect(content).toContain('base/input hashes still match');
    expect(content).toContain('stop for repair (recommended), or ship with the specific named');
    expect(read('ship/SKILL.md')).toContain('Step 14.5: Documentation audit');
    expect(read('ship/sections/pr-body.md')).not.toContain('Documentation sync (via subagent');
  });
  test('every attempt including failure writes best-effort audit metadata', () => {
    expect(content).toContain('on every failed launch, invalid output or blocked recovery');
    for (const field of ['gate":"doc-release', 'audit_id', 'attempt', 'status', 'files_updated_count', 'documentation_section', 'fix_cycle', 'rerun_cause', 'doc_impact_would_dispatch', 'false_negative']) expect(content).toContain(field);
    expect(content).toContain('error if blocked or invalid');
    expect(content).toContain('Telemetry failure never changes the audit gate');
    expect(content).not.toContain('doc_commit');
    expect(content).not.toContain('redispatch_would_skip');
    expect(content).not.toContain('"pushed"');
  });
  test('the fix-cycle telemetry clause is present and telemetry-only', () => {
    const reviewArmy = read('ship/sections/review-army.md');
    expect(reviewArmy).toContain('Track the fix-cycle index');
    expect(reviewArmy).toContain('"rerun_cause":"fix-loop"');
    expect(reviewArmy).toContain('Telemetry only — the loop is unchanged');
    expect(reviewArmy).toContain('REPAIR_CYCLES_MAX');
  });
});
