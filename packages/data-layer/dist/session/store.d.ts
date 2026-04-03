import type { Session, SessionMessage } from './types.js';
export declare class SessionStore {
    private readonly sessions;
    create(userId: string): Session;
    get(id: string): Session | undefined;
    update(id: string, updates: Partial<Session>): Session;
    delete(id: string): boolean;
    listByUser(userId: string): Session[];
    addMessage(sessionId: string, message: SessionMessage): void;
    linkInvestigation(sessionId: string, investigationId: string): void;
}
//# sourceMappingURL=store.d.ts.map