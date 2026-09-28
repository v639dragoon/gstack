import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { releasePaths } from '../lib/ship-bin-common';
import { RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

const fixtures: ShipFx[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });

// Value: protects=README-switched post-merge repos never receive version writes from the compact release bin;
// fails_when=the policy-only fragment shortcut wins over bump frontmatter or VERSION is changed;
// why_new=the upstream compact release bin supersedes the fork's prose-only Step 12; seam=gstack-ship-release; no_claim=merge-time release execution
test('README mode chooses a bump and exact fragment without writing release files, with or without fragment policy', () => {
  for (const policy of [null, { changelog_fragments: { dir: 'notes' }, min_gstack_version: '1.91.336.0' }]) {
    const f = shipFixture({ 'changelog.d/README.md': '# Post-merge releases\n', ...(policy ? { '.gstack/ship-policy.json': JSON.stringify(policy) } : {}) });
    fixtures.push(f);
    const files = ['VERSION', 'CHANGELOG.md', 'package.json'];
    const before = files.map(p => fs.readFileSync(path.join(f.work, p), 'utf8'));
    expect(f.run(RELEASE, ['version', '--base', 'main']).status).toBe(3);
    const r = f.run(RELEASE, ['version', '--base', 'main', '--bump', 'patch']);
    expect([r.status, r.stdout]).toEqual([0, expect.stringContaining('BUMP_LEVEL=patch')]);
    expect(r.stdout).toContain('changelog.d/feat.md');
    expect(r.stdout).toContain('bump: patch');
    expect(files.map(p => fs.readFileSync(path.join(f.work, p), 'utf8'))).toEqual(before);
    expect(f.git('status', '--porcelain').stdout).toBe('');
    expect(releasePaths(policy, f.work, 'HEAD')).toEqual(['TODOS.md', 'changelog.d/feat.md']);
  }
});

// Value: protects=upstream's policy-only fragment branch keeps its entry-text-only output;
// fails_when=the fork imposes mandatory bump frontmatter without a README switch;
// why_new=negative control for the post-merge bin integration; seam=gstack-ship-release; no_claim=fragment folding
test('policy-only fragments keep upstream entry-text-only instructions', () => {
  const f = shipFixture({ '.gstack/ship-policy.json': JSON.stringify({ changelog_fragments: { dir: 'notes' }, min_gstack_version: '1.91.336.0' }) });
  fixtures.push(f);
  const r = f.run(RELEASE, ['version', '--base', 'main']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('notes/feat.md (entry text only, no heading)');
  expect(r.stdout).not.toContain('bump:');
});
