import * as dotenv from 'dotenv';
import { existsSync, readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { AppConfigSchema } from './schema.js';
function deepMerge(base, override) {
    const result = { ...base };
    for (const [key, value] of Object.entries(override)) {
        if (value !== undefined &&
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value) &&
            typeof result[key] === 'object' &&
            result[key] !== null &&
            !Array.isArray(result[key])) {
            result[key] = deepMerge(result[key], value);
        }
        else if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
}
function buildEnvOverrides(env) {
    const overrides = {};
    const setNested = (obj, keys, value) => {
        let cur = obj;
        for (let i = 0; i < keys.length - 1; i++) {
            const k = keys[i];
            if (typeof cur[k] !== 'object' || cur[k] === null) {
                cur[k] = {};
            }
            cur = cur[k];
        }
        const last = keys[keys.length - 1];
        cur[last] = value;
    };
    const mapping = [
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
    static load(options = {}) {
        const { overrideEnv } = options;
        let yamlBase = {};
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
            const raw = parseYaml(readFileSync(yamlFile, 'utf-8'));
            if (raw)
                yamlBase = raw;
        }
        // === Load env-specific YAML ===
        const envYamlFile = options.envYamlFile !== false
            ? (options.envYamlFile ?? `config/${process.env['NODE_ENV'] ?? 'development'}.yml`)
            : undefined;
        if (envYamlFile && existsSync(envYamlFile)) {
            const raw = parseYaml(readFileSync(envYamlFile, 'utf-8'));
            if (raw)
                yamlBase = deepMerge(yamlBase, raw);
        }
        // === Apply env var overrides ===
        const env = overrideEnv ?? process.env;
        const envOverrides = buildEnvOverrides(env);
        // Seed each section with {} so Zod can apply nested defaults even when
        // no YAML file is loaded and not all env vars are present.
        const sectionDefaults = {
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
//# sourceMappingURL=loader.js.map