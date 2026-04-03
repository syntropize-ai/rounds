import { Router } from 'express';
export interface LlmConfig {
    provider: 'anthropic' | 'openai' | 'azure-openai' | 'aws-bedrock' | 'ollama' | 'gemini' | 'corporate-gateway';
    apiKey?: string;
    model: string;
    baseUrl?: string;
    region?: string;
    /** Auth type: "api-key" (default) or "bearer" (for corporate gateways with Okta/SSO) */
    authType?: 'api-key' | 'bearer';
    /** Shell command to obtain a token (e.g. ./scripts/token.sh). Token is cached and refreshed automatically. */
    tokenHelperCommand?: string;
}
export interface DatasourceConfig {
    id: string;
    type: 'loki' | 'elasticsearch' | 'clickhouse' | 'tempo' | 'jaeger' | 'otel' | 'prometheus' | 'victoria-metrics';
    name: string;
    url: string;
    environment?: string;
    cluster?: string;
    label?: string;
    apiKey?: string;
    username?: string;
    password?: string;
    isDefault?: boolean;
}
export interface NotificationConfig {
    slack?: {
        webhookUrl: string;
    };
    pagerduty?: {
        integrationKey: string;
    };
    email?: {
        host: string;
        port: number;
        username: string;
        password: string;
        from: string;
    };
}
export interface SetupConfig {
    configured: boolean;
    llm?: LlmConfig;
    datasources: DatasourceConfig[];
    notifications?: NotificationConfig;
    completedAt?: string;
}
/** Returns the current in-memory setup config (LLM, datasources, etc.). */
export declare function getSetupConfig(): SetupConfig;
/** Updates only the datasources array in the current config and persists. */
export declare function updateDatasources(datasources: DatasourceConfig[]): Promise<void>;
export declare function ensureConfigLoaded(): Promise<void>;
export declare function createSetupRouter(): Router;
//# sourceMappingURL=setup.d.ts.map