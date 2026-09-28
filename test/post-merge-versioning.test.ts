import { describe, test, expect } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const helper = join(root, 'bin/gstack-version-mode');

describe('gstack-version-mode', () => {
  test('selects mode from current checkout and --repo, including a path with spaces', () => {
    const repo = mkdtempSync(join(tmpdir(), 'version mode '));
    try {
      const run = (args: string[] = []) => execFileSync('bash', [helper, ...args], { cwd: repo, encoding: 'utf8' }).trim();
      expect(run()).toBe('in-branch');
      expect(run(['--repo', repo])).toBe('in-branch');
      mkdirSync(join(repo, 'changelog.d'));
      writeFileSync(join(repo, 'changelog.d/README.md'), 'opt in\n');
      expect(run()).toBe('post-merge');
      expect(run(['--repo', repo])).toBe('post-merge');
      expect(spawnSync('bash', [helper, '--repo'], { encoding: 'utf8' }).status).toBe(2);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe('rendered skill mode branches', () => {
  test('ship keeps in-branch bump and adds post-merge fragment contract', () => {
    const ship = read('ship/SKILL.md');
    const changelog = read('ship/sections/changelog.md');
    expect(ship).toContain('gstack-version-mode');
    expect(ship).toContain('Skip classify/write/repair, `gstack-next-version`, queue, and `NEW_VERSION`');
    expect(ship).toContain('gstack-version-bump classify --base <base>');
    expect(ship).toContain('gstack-next-version --base <base>');
    expect(changelog).toContain('git diff --name-only --diff-filter=A <base>...HEAD -- changelog.d/');
    expect(changelog).toContain('bump: micro | patch | minor | major');
    expect(changelog).toContain('frontmatter has exactly one key');
    expect(changelog).toContain('**In-branch only:**');
    expect(changelog).toContain('## [X.Y.Z.W] - YYYY-MM-DD');
  });

  test('PR, readiness, review, and document-release select mode', () => {
    const pr = read('ship/sections/pr-body.md');
    const ship = read('ship/SKILL.md');
    const land = read('land-and-deploy/SKILL.md');
    const gate = read('land-and-deploy/sections/readiness-gate.md');
    const review = read('review/SKILL.md');
    const docs = read('document-release/sections/release-body.md');
    expect(ship).toContain('NEW_TITLE="<type>: <summary>"');
    expect(ship).toContain('Every created or updated title MUST');
    expect(pr).toContain('in-branch it must start with `v$NEW_VERSION `, and post-merge it must have no version prefix');
    expect(ship.replace(/\s+/g, ' ')).toContain('Name BUMP_LEVEL and FRAGMENT_PATH in the body without claiming an assigned version');
    expect(land).toContain('Post-merge claims no VERSION slot: skip to Step 3.5');
    expect(gate).toContain('**Wrong version (in-branch only):**');
    expect(gate).toContain('Fragment: <FRAGMENT_PATH> present / MISSING');
    expect(gate).toContain('ALLOW_PATHS=$FRAGMENT_PATH');
    expect(review).toContain('Post-merge skips this advisory because it claims no VERSION');
    expect(docs).toContain('Post-merge:** Find the single added fragment');
    expect(docs).toContain('Skip this entire question');
    expect(docs).toContain('Post-merge mode skips this entire title-sync block');
  });
});
