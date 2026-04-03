import { describe, it, expect } from 'vitest';
import { ConfigLoader } from './loader.js';

const REQUIRED_BASE = {
  DATABASE_URL: 'postgres://localhost:5432/test',
  LLM_API_KEY: 'sk-test-key',
  JWT_SECRET: 'super-secret-key-that-is-at-least-32-chars!!',
};

describe('ConfigLoader', () => {
  describe('load() with overrideEnv', () => {
    it('returns a valid AppConfig with required fields', () => {
      const config = ConfigLoader.load({ overrideEnv: { ...REQUIRED_BASE } });
      expect(config.database.url).toBe('postgres://localhost:5432/test');
      expect(config.llm.apiKey).toBe('sk-test-key');
      expect(config.security.jwtSecret).toBe('super-secret-key-that-is-at-least-32-chars!!');
    });

    it('applies default values for optional fields', () => {
      const config = ConfigLoader.load({
        overrideEnv: { ...REQUIRED_BASE },
        yamlFile: 'config/nonexistent.yml',
        envYamlFile: false,
      });
      expect(config.server.port).toBe(3000);
      expect(config.server.host).toBe('0.0.0.0');
      expect(config.server.corsOrigins).toEqual(['http://localhost:3000']);
      expect(config.database.poolSize).toBe(10);
      expect(config.database.ssl).toBe(false);
      expect(config.redis.url).toBe('redis://localhost:6379');
      expect(config.redis.prefix).toBe('agentic');
      expect(config.llm.provider).toBe('anthropic');
      expect(config.llm.model).toBe('claude-sonnet-4-6');
      expect(config.proactive.checkIntervalMs).toBe(60000);
      expect(config.proactive.historySize).toBe(100);
      expect(config.security.apiKeyHeader).toBe('x-api-key');
      expect(config.security.sessionTtl).toBe(86400);
      expect(config.logging.level).toBe('info');
      expect(config.logging.format).toBe('json');
    });

    it('overrides defaults with env vars', () => {
      const config = ConfigLoader.load({
        overrideEnv: {
          ...REQUIRED_BASE,
          PORT: '8080',
          HOST: '127.0.0.1',
          DATABASE_POOL_SIZE: '20',
          DATABASE_SSL: 'true',
          REDIS_URL: 'redis://redis-host:6379',
          REDIS_PREFIX: 'prod',
          LLM_PROVIDER: 'openai',
          LLM_MODEL: 'gpt-4o',
          LLM_FALLBACK_PROVIDER: 'anthropic',
          PROACTIVE_CHECK_INTERVAL_MS: '30000',
          PROACTIVE_HISTORY_SIZE: '200',
          API_KEY_HEADER: 'x-custom-key',
          SESSION_TTL: '3600',
          LOG_LEVEL: 'debug',
          LOG_FORMAT: 'text',
        },
      });

      expect(config.server.port).toBe(8080);
      expect(config.server.host).toBe('127.0.0.1');
      expect(config.database.poolSize).toBe(20);
      expect(config.database.ssl).toBe(true);
      expect(config.redis.url).toBe('redis://redis-host:6379');
      expect(config.redis.prefix).toBe('prod');
      expect(config.llm.provider).toBe('openai');
      expect(config.llm.model).toBe('gpt-4o');
      expect(config.llm.fallbackProvider).toBe('anthropic');
      expect(config.proactive.checkIntervalMs).toBe(30000);
      expect(config.proactive.historySize).toBe(200);
      expect(config.security.apiKeyHeader).toBe('x-custom-key');
      expect(config.security.sessionTtl).toBe(3600);
      expect(config.logging.level).toBe('debug');
      expect(config.logging.format).toBe('text');
    });

    it('parses CORS_ORIGINS as comma-separated string', () => {
      const config = ConfigLoader.load({
        overrideEnv: {
          ...REQUIRED_BASE,
          CORS_ORIGINS: 'https://app.example.com,https://admin.example.com',
        },
      });

      expect(config.server.corsOrigins).toEqual([
        'https://app.example.com',
        'https://admin.example.com',
      ]);
    });

    it('coerces numeric string values to numbers', () => {
      const config = ConfigLoader.load({
        overrideEnv: { ...REQUIRED_BASE, PORT: '9000' },
      });
      expect(config.server.port).toBe(9000);
      expect(typeof config.server.port).toBe('number');
    });

    it('coerces DATABASE_SSL string "false" to boolean false', () => {
      const config = ConfigLoader.load({
        overrideEnv: { ...REQUIRED_BASE, DATABASE_SSL: 'false' },
      });
      expect(config.database.ssl).toBe(false);
    });
  });

  describe('validation errors', () => {
    it('throws when DATABASE_URL is missing', () => {
      expect(() =>
        ConfigLoader.load({
          overrideEnv: {
            LLM_API_KEY: 'sk-test',
            JWT_SECRET: 'super-secret-key-that-is-at-least-32-chars!!',
          },
          yamlFile: 'config/nonexistent.yml',
          envYamlFile: false,
        }),
      ).toThrow();
    });

    it('throws when LLM_API_KEY is missing', () => {
      expect(() =>
        ConfigLoader.load({
          overrideEnv: {
            DATABASE_URL: 'postgres://localhost:5432/test',
            JWT_SECRET: 'super-secret-key-that-is-at-least-32-chars!!',
          },
          yamlFile: 'config/nonexistent.yml',
          envYamlFile: false,
        }),
      ).toThrow();
    });

    it('throws when JWT_SECRET is too short', () => {
      expect(() =>
        ConfigLoader.load({
          overrideEnv: {
            ...REQUIRED_BASE,
            JWT_SECRET: 'short',
          },
        }),
      ).toThrow();
    });

    it('throws when LOG_LEVEL is invalid', () => {
      expect(() =>
        ConfigLoader.load({
          overrideEnv: { ...REQUIRED_BASE, LOG_LEVEL: 'verbose' },
        }),
      ).toThrow();
    });

    it('throws when LLM_PROVIDER is invalid', () => {
      expect(() =>
        ConfigLoader.load({
          overrideEnv: { ...REQUIRED_BASE, LLM_PROVIDER: 'cohere' },
        }),
      ).toThrow();
    });

    it('throws when PORT is out of range', () => {
      expect(() =>
        ConfigLoader.load({
          overrideEnv: { ...REQUIRED_BASE, PORT: '99999' },
        }),
      ).toThrow();
    });
  });

  describe('YAML + env merge', () => {
    it('merges YAML base with env overrides (env wins)', () => {
      // Provide a yamlFile path that does not exist - fallback to defaults only
      // Then override via env vars
      const config = ConfigLoader.load({
        overrideEnv: {
          ...REQUIRED_BASE,
          PORT: '5000',
        },
        yamlFile: 'config/nonexistent.yml',
        envYamlFile: false,
      });

      expect(config.server.port).toBe(5000);
    });
  });
});
