export declare const investigationOpenApiSpec: {
    readonly openapi: "3.0.3";
    readonly info: {
        readonly title: "Agentic Observability - Investigation API";
        readonly version: "0.1.0";
        readonly description: "REST API for creating and managing agentic investigations.";
    };
    readonly tags: readonly [{
        readonly name: "Investigations";
        readonly description: "Investigation lifecycle";
    }];
    readonly paths: Record<string, unknown>;
    readonly components: {
        readonly schemas: Record<string, unknown>;
        readonly securitySchemes: {
            readonly BearerAuth: {
                readonly type: "http";
                readonly scheme: "bearer";
                readonly bearerFormat: "JWT";
            };
            readonly ApiKeyAuth: {
                readonly type: "apiKey";
                readonly in: "header";
                readonly name: "x-api-key";
            };
        };
    };
    readonly security: readonly [{
        readonly BearerAuth: readonly [];
    }, {
        readonly ApiKeyAuth: readonly [];
    }];
};
//# sourceMappingURL=openapi.d.ts.map
