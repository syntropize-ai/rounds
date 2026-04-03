import { z } from 'zod';
export declare const AppConfigSchema: z.ZodObject<{
    server: z.ZodObject<{
        port: z.ZodDefault<z.ZodNumber>;
        host: z.ZodDefault<z.ZodString>;
        corsOrigins: z.ZodDefault<z.ZodEffects<z.ZodUnion<[z.ZodArray<z.ZodString, "many">, z.ZodString]>, string[], string | string[]>>;
    }, "strip", z.ZodTypeAny, {
        host: string;
        port: number;
        corsOrigins: string[];
    }, {
        host?: string | undefined;
        port?: number | undefined;
        corsOrigins?: string | string[] | undefined;
    }>;
    database: z.ZodObject<{
        url: z.ZodString;
        poolSize: z.ZodDefault<z.ZodNumber>;
        ssl: z.ZodDefault<z.ZodEffects<z.ZodUnion<[z.ZodBoolean, z.ZodString]>, boolean, string | boolean>>;
    }, "strip", z.ZodTypeAny, {
        url: string;
        poolSize: number;
        ssl: boolean;
    }, {
        url: string;
        poolSize?: number | undefined;
        ssl?: string | boolean | undefined;
    }>;
    redis: z.ZodObject<{
        url: z.ZodDefault<z.ZodString>;
        prefix: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        url: string;
        prefix: string;
    }, {
        url?: string | undefined;
        prefix?: string | undefined;
    }>;
    llm: z.ZodObject<{
        provider: z.ZodDefault<z.ZodEnum<["anthropic", "openai", "azure", "gemini", "ollama"]>>;
        apiKey: z.ZodString;
        model: z.ZodDefault<z.ZodString>;
        fallbackProvider: z.ZodOptional<z.ZodEnum<["anthropic", "openai", "azure", "gemini", "ollama"]>>;
    }, "strip", z.ZodTypeAny, {
        provider: "anthropic" | "openai" | "azure" | "gemini" | "ollama";
        apiKey: string;
        model: string;
        fallbackProvider?: "anthropic" | "openai" | "azure" | "gemini" | "ollama" | undefined;
    }, {
        apiKey: string;
        provider?: "anthropic" | "openai" | "azure" | "gemini" | "ollama" | undefined;
        model?: string | undefined;
        fallbackProvider?: "anthropic" | "openai" | "azure" | "gemini" | "ollama" | undefined;
    }>;
    proactive: z.ZodObject<{
        checkIntervalMs: z.ZodDefault<z.ZodNumber>;
        historySize: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        checkIntervalMs: number;
        historySize: number;
    }, {
        checkIntervalMs?: number | undefined;
        historySize?: number | undefined;
    }>;
    security: z.ZodObject<{
        jwtSecret: z.ZodString;
        apiKeyHeader: z.ZodDefault<z.ZodString>;
        sessionTtl: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        jwtSecret: string;
        apiKeyHeader: string;
        sessionTtl: number;
    }, {
        jwtSecret: string;
        apiKeyHeader?: string | undefined;
        sessionTtl?: number | undefined;
    }>;
    logging: z.ZodObject<{
        level: z.ZodDefault<z.ZodEnum<["debug", "info", "warn", "error"]>>;
        format: z.ZodDefault<z.ZodEnum<["json", "text"]>>;
    }, "strip", z.ZodTypeAny, {
        level: "error" | "debug" | "info" | "warn";
        format: "text" | "json";
    }, {
        level?: "error" | "debug" | "info" | "warn" | undefined;
        format?: "text" | "json" | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    server: {
        host: string;
        port: number;
        corsOrigins: string[];
    };
    database: {
        url: string;
        poolSize: number;
        ssl: boolean;
    };
    redis: {
        url: string;
        prefix: string;
    };
    llm: {
        provider: "anthropic" | "openai" | "azure" | "gemini" | "ollama";
        apiKey: string;
        model: string;
        fallbackProvider?: "anthropic" | "openai" | "azure" | "gemini" | "ollama" | undefined;
    };
    proactive: {
        checkIntervalMs: number;
        historySize: number;
    };
    security: {
        jwtSecret: string;
        apiKeyHeader: string;
        sessionTtl: number;
    };
    logging: {
        level: "error" | "debug" | "info" | "warn";
        format: "text" | "json";
    };
}, {
    server: {
        host?: string | undefined;
        port?: number | undefined;
        corsOrigins?: string | string[] | undefined;
    };
    database: {
        url: string;
        poolSize?: number | undefined;
        ssl?: string | boolean | undefined;
    };
    redis: {
        url?: string | undefined;
        prefix?: string | undefined;
    };
    llm: {
        apiKey: string;
        provider?: "anthropic" | "openai" | "azure" | "gemini" | "ollama" | undefined;
        model?: string | undefined;
        fallbackProvider?: "anthropic" | "openai" | "azure" | "gemini" | "ollama" | undefined;
    };
    proactive: {
        checkIntervalMs?: number | undefined;
        historySize?: number | undefined;
    };
    security: {
        jwtSecret: string;
        apiKeyHeader?: string | undefined;
        sessionTtl?: number | undefined;
    };
    logging: {
        level?: "error" | "debug" | "info" | "warn" | undefined;
        format?: "text" | "json" | undefined;
    };
}>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
//# sourceMappingURL=schema.d.ts.map