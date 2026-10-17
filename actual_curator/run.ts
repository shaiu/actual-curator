// Home Assistant app entry point: options → env, then start the unchanged service.
import { readFileSync } from 'node:fs';
import { optionsToEnv } from './options.ts';

const options = JSON.parse(readFileSync(process.env.HA_OPTIONS ?? '/data/options.json', 'utf8')) as Record<string, string | number | boolean | null>;
Object.assign(process.env, optionsToEnv(options));
await import('../src/main.ts'); // /app/src/main.ts in the image
