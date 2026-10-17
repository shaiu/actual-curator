// Maps Home Assistant app options (/data/options.json, snake_case) onto the environment variables
// actual-curator already understands. The app itself knows nothing about Home Assistant.

export type AppOptions = Record<string, string | number | boolean | null | undefined>;

export function optionsToEnv(options: AppOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === null || value === undefined || value === '') continue;
    env[key.toUpperCase()] = String(value);
  }
  // Fixed by the app: persistent state lives in /data, the port is the one config.yaml maps.
  env.DATA_DIR = '/data';
  env.PORT = '5007';
  return env;
}
