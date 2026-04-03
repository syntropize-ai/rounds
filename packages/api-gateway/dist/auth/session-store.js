import crypto from 'crypto';
export class SessionStore {
    sessions = new Map();
    refreshTokenIndex = new Map(); // refreshToken -> sessionId
    create(userId, accessToken, refreshToken, ttlMs, meta) {
        const id = crypto.randomUUID();
        const now = Date.now();
        const session = {
            id,
            userId,
            accessToken,
            refreshToken,
            expiresAt: now + ttlMs,
            createdAt: now,
            ...meta,
        };
        this.sessions.set(id, session);
        this.refreshTokenIndex.set(refreshToken, id);
        return session;
    }
    get(id) {
        const s = this.sessions.get(id);
        if (s && Date.now() > s.expiresAt) {
            this.revoke(id);
            return undefined;
        }
        return s;
    }
    getByRefreshToken(refreshToken) {
        const id = this.refreshTokenIndex.get(refreshToken);
        if (!id)
            return undefined;
        return this.get(id);
    }
    getByUserId(userId) {
        return [...this.sessions.values()].filter((s) => s.userId === userId);
    }
    revoke(id) {
        const s = this.sessions.get(id);
        if (s) {
            this.refreshTokenIndex.delete(s.refreshToken);
            this.sessions.delete(id);
        }
    }
    revokeAllForUser(userId) {
        for (const [id, s] of this.sessions) {
            if (s.userId === userId)
                this.revoke(id);
        }
    }
    purgeExpired() {
        let count = 0;
        const now = Date.now();
        for (const [id, s] of this.sessions) {
            if (now > s.expiresAt) {
                this.revoke(id);
                count++;
            }
        }
        return count;
    }
    count() {
        return this.sessions.size;
    }
}
export const sessionStore = new SessionStore();
//# sourceMappingURL=session-store.js.map