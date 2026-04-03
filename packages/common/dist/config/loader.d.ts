import { type AppConfig } from './schema.js';
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
export declare class ConfigLoader {
    /**
     * Load and validate application configuration.
     *
     * Priority (highest to lowest):
     * process.env / overrideEnv > .env files > env-specific YAML > default YAML
     */
    static load(options?: ConfigLoaderOptions): AppConfig;
}
//# sourceMappingURL=loader.d.ts.map