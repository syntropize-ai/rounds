import * as dotenv from 'dotenv';
import { existsSync, readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { AppConfigSchema, type AppConfig } from './schema.js';

export interface ConfigLoaderOptions {
  /** .env files to load in priority order (later files do NOT override earlier) */
  envFiles?: string[];
  /** Base YAML config file (default: 'config/default.yml') */
  yamlFile?: string;
  /** Env-specific YAML file (default: `config/${NODE_ENV}.yml`) */
  envYamlFile?: string | false;
  /** Override process.env with this map - useful for testing, skips file loading when set */
  overrideEnv?: Record<string, string | undefined>;
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value !== undefined &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function buildEnvOverrides(env: Record<string, string | undefined>): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  const setNested = (obj: Record<string, unknown>, keys: string[], value: unknown) => {
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]!;
      if (typeof cur[k] !== 'object' || cur[k] === null) {
        cur[k] = {};
      }
      cur = cur[k] as Record<string, unknown>;
    }
    const last = keys[keys.length - 1]!;
    cur[last] = value;
  };

  const mapping: Array<[string, string[]]> = [
    ['PORT', ['server', 'port']],
    ['HOST', ['server', 'host']],
    ['CORS_ORIGINS', ['server', 'corsOrigins']],
    ['DATABASE_URL', ['database', 'url']],
    ['DATABASE_POOL_SIZE', ['database', 'poolSize']],
    ['DATABASE_SSL', ['database', 'ssl']],
    ['REDIS_URL', ['redis', 'url']],
    ['REDIS_PREFIX', ['redis', 'prefix']],
    ['LLM_PROVIDER', ['llm', 'provider']],
    ['LLM_API_KEY', ['llm', 'apiKey']],
    ['LLM_MODEL', ['llm', 'model']],
    ['LLM_FALLBACK_PROVIDER', ['llm', 'fallbackProvider']],
    ['PROACTIVE_CHECK_INTERVAL_MS', ['proactive', 'checkIntervalMs']],
    ['PROACTIVE_HISTORY_SIZE', ['proactive', 'historySize']],
    ['JWT_SECRET', ['security', 'jwtSecret']],
    ['API_KEY_HEADER', ['security', 'apiKeyHeader']],
    ['SESSION_TTL', ['security', 'sessionTtl']],
    ['LOG_LEVEL', ['logging', 'level']],
    ['LOG_FORMAT', ['logging', 'format']],
  ];

  for (const [envKey, path] of mapping) {
    const val = env[envKey];
    if (val !== undefined) {
      setNested(overrides, path, val);
    }
  }

  return overrides;
}

export class ConfigLoader {
  /**
   * Load and validate application configuration.
   *
   * Priority (highest to lowest):
   * process.env / overrideEnv > .env files > env-specific YAML > default YAML
   */
  static load(options: ConfigLoaderOptions = {}): AppConfig {
    const { overrideEnv } = options;

    let yamlBase: Record<string, unknown> = {};

    if (overrideEnv === undefined) {
      // === Load .env files ===
      const envFiles = options.envFiles ?? [
        '.env',
        '.env.local',
        `.env.${process.env['NODE_ENV'] ?? 'development'}`,
      ];
      for (const f of envFiles) {
        if (existsSync(f)) {
          dotenv.config({ path: f, override: false });
        }
      }
    }

    // === Load YAML base ===
    const yamlFile = options.yamlFile ?? 'config/default.yml';
    if (existsSync(yamlFile)) {
      const raw = parseYaml(readFileSync(yamlFile, 'utf-8')) as Record<string, unknown> | null;
      if (raw) yamlBase = raw;
    }

    // === Load env-specific YAML ===
    const envYamlFile = options.envYamlFile !== false
      ? (options.envYamlFile ?? `config/${process.env['NODE_ENV'] ?? 'development'}.yml`)
      : undefined;
    if (envYamlFile && existsSync(envYamlFile)) {
      const raw = parseYaml(readFileSync(envYamlFile, 'utf-8')) as Record<string, unknown> | null;
      if (raw) yamlBase = deepMerge(yamlBase, raw);
    }

    // === Apply env var overrides ===
    const env = overrideEnv ?? (process.env as Record<string, string | undefined>);
    const envOverrides = buildEnvOverrides(env);

    // Seed each section with {} so Zod can apply nested defaults even when
    // no YAML file is loaded and not all env vars are present.
    const sectionDefaults: Record<string, unknown> = {
      server: {},
      database: {},
      redis: {},
      llm: {},
      proactive: {},
      security: {},
      logging: {},
    };

    const merged = deepMerge(deepMerge(sectionDefaults, yamlBase), envOverrides);
    return AppConfigSchema.parse(merged);
  }
}
