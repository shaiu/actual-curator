import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * Version of an installed package, or of actual-curator itself when no name is given. Walks up from
 * the package's entry point, because some packages (e.g. @actual-app/api) do not export package.json.
 */
export function packageVersion(name?: string): string {
  let dir = name ? dirname(require.resolve(name)) : dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      const json = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string; version?: string };
      if (json.version && (!name || json.name === name)) return json.version;
    }
    const up = dirname(dir);
    if (up === dir) return 'unknown';
    dir = up;
  }
}
