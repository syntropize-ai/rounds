export declare const investigationOpenApiSpec: {
    readonly openapi: "3.0.3";
    readonly info: {
        readonly title: "Agentic Observability - Investigation API";
        readonly version: "1.0.0";
        readonly description: "REST API for creating and managing agentic investigations.";
    };
    readonly tags: readonly [{
        readonly name: "investigations";
        readonly description: "Investigation lifecycle";
    }];
    readonly paths: {
        readonly '/investigations': {
            readonly post: {
                readonly tags: readonly ["investigations"];
                readonly summary: "Create a new investigation";
                readonly operationId: "createInvestigation";
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/CreateInvestigationBody";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 201: {
                        readonly description: "Investigation created";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/Investigation";
                                };
                            };
                        };
                    };
                    readonly 400: {
                        readonly description: "Invalid request body";
                    };
                    readonly 401: {
                        readonly description: "Unauthorized";
                    };
                };
            };
            readonly get: {
                readonly tags: readonly ["investigations"];
                readonly summary: "List all investigations";
                readonly operationId: "listInvestigations";
                readonly responses: {
                    readonly 200: {
                        readonly description: "List of investigations";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly $ref: "#/components/schemas/InvestigationSummary";
                                    };
                                };
                            };
                        };
                    };
                    readonly 401: {
                        readonly description: "Unauthorized";
                    };
                };
            };
        };
        readonly '/investigations/{id}': {
            readonly get: {
                readonly tags: readonly ["investigations"];
                readonly summary: "Get investigation by ID";
                readonly operationId: "getInvestigation";
                readonly parameters: readonly [{
                    readonly name: "id";
                    readonly in: "path";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                    };
                }];
                readonly responses: {
                    readonly 200: {
                        readonly description: "Investigation detail";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/Investigation";
                                };
                            };
                        };
                    };
                    readonly 404: {
                        readonly description: "Not found";
                    };
                    readonly 401: {
                        readonly description: "Unauthorized";
                    };
                };
            };
        };
        readonly '/investigations/{id}/plan': {
            readonly get: {
                readonly tags: readonly ["investigations"];
                readonly summary: "Get the investigation plan";
                readonly operationId: "getInvestigationPlan";
                readonly parameters: readonly [{
                    readonly name: "id";
                    readonly in: "path";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                    };
                }];
                readonly responses: {
                    readonly 200: {
                        readonly description: "Investigation plan";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/PlanResponse";
                                };
                            };
                        };
                    };
                    readonly 404: {
                        readonly description: "Not found";
                    };
                    readonly 401: {
                        readonly description: "Unauthorized";
                    };
                };
            };
        };
        readonly '/investigations/{id}/follow-up': {
            readonly post: {
                readonly tags: readonly ["investigations"];
                readonly summary: "Add a follow-up question";
                readonly operationId: "followUp";
                readonly parameters: readonly [{
                    readonly name: "id";
                    readonly in: "path";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                    };
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/FollowUpBody";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 201: {
                        readonly description: "Follow-up created";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/FollowUpRecord";
                                };
                            };
                        };
                    };
                    readonly 404: {
                        readonly description: "Investigation not found";
                    };
                    readonly 401: {
                        readonly description: "Unauthorized";
                    };
                };
            };
        };
        readonly '/investigations/{id}/feedback': {
            readonly post: {
                readonly operationId: "submitFeedback";
                readonly parameters: readonly [{
                    readonly name: "id";
                    readonly in: "path";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                    };
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/FeedbackBody";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        readonly description: "Feedback recorded";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/FeedbackResponse";
                                };
                            };
                        };
                    };
                    readonly 404: {
                        readonly description: "Investigation not found";
                    };
                    readonly 401: {
                        readonly description: "Unauthorized";
                    };
                };
            };
        };
        readonly '/investigations/{id}/stream': {
            readonly get: {
                readonly tags: readonly ["investigations"];
                readonly summary: "Stream investigation progress via SSE";
                readonly operationId: "streamInvestigation";
                readonly parameters: readonly [{
                    readonly name: "id";
                    readonly in: "path";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                    };
                }];
                readonly responses: {
                    readonly 200: {
                        readonly description: "SSE stream of investigation events";
                        readonly content: {
                            readonly 'text/event-stream': {
                                readonly schema: {
                                    readonly type: "string";
                                };
                                readonly example: "event: investigationStatus\ndata: {\"id\":\"inv_abc\",\"status\":\"investigating\"}\n\n";
                            };
                        };
                    };
                    readonly 404: {
                        readonly description: "Investigation not found";
                    };
                    readonly 401: {
                        readonly description: "Unauthorized";
                    };
                };
            };
        };
    };
    readonly components: {
        readonly schemas: {
            readonly CreateInvestigationBody: {
                readonly type: "object";
                readonly required: readonly ["question"];
                readonly properties: {
                    readonly question: {
                        readonly type: "string";
                        readonly description: "Natural-language question";
                    };
                    readonly sessionId: {
                        readonly type: "string";
                    };
                    readonly entity: {
                        readonly type: "string";
                        readonly description: "Entity hint (e.g. service name)";
                    };
                    readonly timeRange: {
                        readonly type: "object";
                        readonly properties: {
                            readonly start: {
                                readonly type: "string";
                                readonly format: "date-time";
                            };
                            readonly end: {
                                readonly type: "string";
                                readonly format: "date-time";
                            };
                        };
                    };
                };
            };
            readonly InvestigationSummary: {
                readonly type: "object";
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                    };
                    readonly status: {
                        readonly type: "string";
                        readonly enum: readonly ["planning", "investigating", "evidencing", "explaining", "active", "verifying", "completed", "failed"];
                    };
                    readonly intent: {
                        readonly type: "string";
                    };
                    readonly sessionId: {
                        readonly type: "string";
                    };
                    readonly userId: {
                        readonly type: "string";
                    };
                    readonly createdAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly updatedAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                };
            };
            readonly Investigation: {
                readonly type: "object";
                readonly description: "Full investigation with plan, hypotheses, evidence, and actions";
            };
            readonly PlanResponse: {
                readonly type: "object";
                readonly properties: {
                    readonly investigationId: {
                        readonly type: "string";
                    };
                    readonly plans: {
                        readonly type: "object";
                    };
                };
            };
            readonly FollowUpBody: {
                readonly type: "object";
                readonly required: readonly ["question"];
                readonly properties: {
                    readonly question: {
                        readonly type: "string";
                    };
                };
            };
            readonly FollowUpRecord: {
                readonly type: "object";
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                    };
                    readonly investigationId: {
                        readonly type: "string";
                    };
                    readonly question: {
                        readonly type: "string";
                    };
                    readonly createdAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                };
            };
            readonly FeedbackBody: {
                readonly type: "object";
                readonly required: readonly ["helpful"];
                readonly properties: {
                    readonly helpful: {
                        readonly type: "boolean";
                    };
                    readonly comment: {
                        readonly type: "string";
                    };
                    readonly hypothesisId: {
                        readonly type: "string";
                    };
                };
            };
            readonly FeedbackResponse: {
                readonly type: "object";
                readonly properties: {
                    readonly received: {
                        readonly type: "boolean";
                    };
                    readonly investigationId: {
                        readonly type: "string";
                    };
                };
            };
        };
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