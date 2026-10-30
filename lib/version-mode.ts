/** Twin of bin/gstack-version-mode: the repository opts into post-merge VERSION ownership with this marker. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
export const postMergeVersionMode = (repo: string): boolean => existsSync(join(repo, 'changelog.d', 'README.md'));
