import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { packageVersion } from '../src/version.ts';

test('reads the version of a package that does not export its package.json', () => {
  const pinned = JSON.parse(readFileSync('node_modules/@actual-app/api/package.json', 'utf8')).version;
  expect(packageVersion('@actual-app/api')).toBe(pinned);
});

test('reads our own version', () =>
  expect(packageVersion()).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version));
