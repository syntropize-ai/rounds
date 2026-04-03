import { z } from 'zod';
export const AppConfigSchema = z.object({
    server: z.object({
        port: z.coerce.number().int().min(1).max(65535).default(3000),
        host: z.string().default('0.0.0.0'),
        corsOrigins: z.union([z.array(z.string()), z.string()]).transform((v) => typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v).default(['http://localhost:3000']),
    }),
    database: z.object({
        url: z.string().min(1),
        poolSize: z.coerce.number().int().min(1).default(10),
        ssl: z.union([z.boolean(), z.string()]).transform((v) => typeof v === 'string' ? v === 'true' : v).default(false),
    }),
    redis: z.object({
        url: z.string().default('redis://localhost:6379'),
        prefix: z.string().default('agentic'),
    }),
    llm: z.object({
        provider: z.enum(['anthropic', 'openai', 'azure', 'gemini', 'ollama']).default('anthropic'),
        apiKey: z.string().min(1),
        model: z.string().default('claude-sonnet-4-6'),
        fallbackProvider: z.enum(['anthropic', 'openai', 'azure', 'gemini', 'ollama']).optional(),
    }),
    proactive: z.object({
        checkIntervalMs: z.coerce.number().int().min(1000).default(60000),
        historySize: z.coerce.number().int().min(1).default(100),
    }),
    security: z.object({
        jwtSecret: z.string().min(32),
        apiKeyHeader: z.string().default('x-api-key'),
        sessionTtl: z.coerce.number().int().positive().default(86400),
    }),
    logging: z.object({
        level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
        format: z.enum(['json', 'text']).default('json'),
    }),
});
//# sourceMappingURL=schema.js.map