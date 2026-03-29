import { Router } from 'express';
export interface LlmConfig {
    provider: 'anthropic' | 'openai' | 'azure-openai' | 'aws-bedrock' | 'ollama' | 'corporate-gateway';
    apiKey?: string;
    model: string;
    baseUrl?: string;
    region?: string;
    authType?: 'api-key' | 'bearer';
    tokenHelperCommand?: string;
}
export interface DatasourceConfig {
    id: string;
    type: 'loki' | 'elasticsearch' | 'clickhouse' | 'tempo' | 'jaeger' | 'otel' | 'prometheus' | 'victoria-metrics';
    url: string;
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
export declare function getSetupConfig(): SetupConfig;
export declare function updateDatasources(datasources: DatasourceConfig[]): Promise<void>;
export declare function ensureConfigLoaded(): Promise<void>;
export declare function createSetupRouter(): Router;
//# sourceMappingURL=setup.d.ts.map
