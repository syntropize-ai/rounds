import type { Session } from './types.js';
export declare class SessionStore {
    private sessions;
    private refreshTokenIndex;
    create(userId: string, accessToken: string, refreshToken: string, ttlMs: number, meta?: {
        ipAddress?: string;
        userAgent?: string;
    }): Session;
    get(id: string): Session | undefined;
    getByRefreshToken(refreshToken: string): Session | undefined;
    getByUserId(userId: string): Session[];
    revoke(id: string): void;
    revokeAllForUser(userId: string): void;
    purgeExpired(): number;
    count(): number;
}
export declare const sessionStore: SessionStore;
//# sourceMappingURL=session-store.d.ts.map
