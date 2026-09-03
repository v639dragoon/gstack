import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';
const root = join(import.meta.dir, '..');
describe('review governor bins', () => {
  test('new commands are executable bash wrappers', () => {
    for (const n of [
      'gstack-outcome',
      'gstack-review-budget',
      'gstack-review-packet',
      'gstack-outcome-report',
      'gstack-context-guard',
    ]) {
      const p = join(root, 'bin', n);
      expect(statSync(p).mode & 0o111).not.toBe(0);
      expect(readFileSync(p, 'utf8').startsWith('#!/usr/bin/env bash')).toBe(true);
    }
  });
});
