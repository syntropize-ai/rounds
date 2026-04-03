// OpenAPI 3.0 spec for the Investigation API (served at GET /openapi.json)
export const investigationOpenApiSpec = {
    openapi: '3.0.3',
    info: {
        title: 'Agentic Observability - Investigation API',
        version: '1.0.0',
        description: 'REST API for creating and managing agentic investigations.',
    },
    tags: [{ name: 'investigations', description: 'Investigation lifecycle' }],
    paths: {
        '/investigations': {
            post: {
                tags: ['investigations'],
                summary: 'Create a new investigation',
                operationId: 'createInvestigation',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/CreateInvestigationBody' },
                        },
                    },
                },
                responses: {
                    201: {
                        description: 'Investigation created',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/Investigation' },
                            },
                        },
                    },
                    400: { description: 'Invalid request body' },
                    401: { description: 'Unauthorized' },
                },
            },
            get: {
                tags: ['investigations'],
                summary: 'List all investigations',
                operationId: 'listInvestigations',
                responses: {
                    200: {
                        description: 'List of investigations',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'array',
                                    items: { $ref: '#/components/schemas/InvestigationSummary' },
                                },
                            },
                        },
                    },
                    401: { description: 'Unauthorized' },
                },
            },
        },
        '/investigations/{id}': {
            get: {
                tags: ['investigations'],
                summary: 'Get investigation by ID',
                operationId: 'getInvestigation',
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
                responses: {
                    200: {
                        description: 'Investigation detail',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/Investigation' },
                            },
                        },
                    },
                    404: { description: 'Not found' },
                    401: { description: 'Unauthorized' },
                },
            },
        },
        '/investigations/{id}/plan': {
            get: {
                tags: ['investigations'],
                summary: 'Get the investigation plan',
                operationId: 'getInvestigationPlan',
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
                responses: {
                    200: {
                        description: 'Investigation plan',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/PlanResponse' },
                            },
                        },
                    },
                    404: { description: 'Not found' },
                    401: { description: 'Unauthorized' },
                },
            },
        },
        '/investigations/{id}/follow-up': {
            post: {
                tags: ['investigations'],
                summary: 'Add a follow-up question',
                operationId: 'followUp',
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/FollowUpBody' },
                        },
                    },
                },
                responses: {
                    201: {
                        description: 'Follow-up created',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/FollowUpRecord' },
                            },
                        },
                    },
                    404: { description: 'Investigation not found' },
                    401: { description: 'Unauthorized' },
                },
            },
        },
        '/investigations/{id}/feedback': {
            post: {
                operationId: 'submitFeedback',
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/FeedbackBody' },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'Feedback recorded',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/FeedbackResponse' },
                            },
                        },
                    },
                    404: { description: 'Investigation not found' },
                    401: { description: 'Unauthorized' },
                },
            },
        },
        '/investigations/{id}/stream': {
            get: {
                tags: ['investigations'],
                summary: 'Stream investigation progress via SSE',
                operationId: 'streamInvestigation',
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
                responses: {
                    200: {
                        description: 'SSE stream of investigation events',
                        content: {
                            'text/event-stream': {
                                schema: { type: 'string' },
                                example: 'event: investigationStatus\ndata: {"id":"inv_abc","status":"investigating"}\n\n',
                            },
                        },
                    },
                    404: { description: 'Investigation not found' },
                    401: { description: 'Unauthorized' },
                },
            },
        },
    },
    components: {
        schemas: {
            CreateInvestigationBody: {
                type: 'object',
                required: ['question'],
                properties: {
                    question: { type: 'string', description: 'Natural-language question' },
                    sessionId: { type: 'string' },
                    entity: { type: 'string', description: 'Entity hint (e.g. service name)' },
                    timeRange: {
                        type: 'object',
                        properties: {
                            start: { type: 'string', format: 'date-time' },
                            end: { type: 'string', format: 'date-time' },
                        },
                    },
                },
            },
            InvestigationSummary: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    status: {
                        type: 'string',
                        enum: ['planning', 'investigating', 'evidencing', 'explaining', 'active', 'verifying', 'completed', 'failed'],
                    },
                    intent: { type: 'string' },
                    sessionId: { type: 'string' },
                    userId: { type: 'string' },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' },
                },
            },
            Investigation: {
                type: 'object',
                description: 'Full investigation with plan, hypotheses, evidence, and actions',
            },
            PlanResponse: {
                type: 'object',
                properties: {
                    investigationId: { type: 'string' },
                    plans: { type: 'object' },
                },
            },
            FollowUpBody: {
                type: 'object',
                required: ['question'],
                properties: { question: { type: 'string' } },
            },
            FollowUpRecord: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    investigationId: { type: 'string' },
                    question: { type: 'string' },
                    createdAt: { type: 'string', format: 'date-time' },
                },
            },
            FeedbackBody: {
                type: 'object',
                required: ['helpful'],
                properties: {
                    helpful: { type: 'boolean' },
                    comment: { type: 'string' },
                    hypothesisId: { type: 'string' },
                },
            },
            FeedbackResponse: {
                type: 'object',
                properties: {
                    received: { type: 'boolean' },
                    investigationId: { type: 'string' },
                },
            },
        },
        securitySchemes: {
            BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
            ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' },
        },
    },
    security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
};
//# sourceMappingURL=openapi.js.map