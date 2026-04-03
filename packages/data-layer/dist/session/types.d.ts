export type SessionStatus = 'active' | 'completed' | 'archived';
export interface SessionMessage {
    role: 'user' | 'system' | 'assistant';
    content: string;
    timestamp: string;
    investigationId?: string;
}
export interface SessionContext {
    messages: SessionMessage[];
    metadata: Record<string, unknown>;
}
export interface Session {
    id: string;
    userId: string;
    status: SessionStatus;
    context: SessionContext;
    investigationIds: string[];
    createdAt: string;
    updatedAt: string;
}
//# sourceMappingURL=types.d.ts.map