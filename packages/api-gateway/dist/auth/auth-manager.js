import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { createLogger } from '@agentic-obs/common';
import { OidcProvider } from './oidc-provider.js';
const log = createLogger('auth-manager');
import { OAuthProvider } from './oauth-provider.js';
import { localLogin, createLocalUser } from './local-provider.js';
import { sessionStore } from './session-store.js';
import { userStore } from './user-store.js';
const JWT_SECRET = (() => {
    const secret = process.env['JWT_SECRET'];
    if (!secret)
        throw new Error('[auth-manager] FATAL: JWT_SECRET environment variable is required. Set a cryptographically random secret of at least 32 characters.');
    return secret;
})();
const ACCESS_TOKEN_TTL_SEC = 15 * 60; // 15 minutes
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export class AuthManager {
    oidcProvider;
    githubProvider;
    googleProvider;
    configure(config) {
        if (config.oidc)
            this.oidcProvider = new OidcProvider(config.oidc);
        if (config.github)
            this.githubProvider = new OAuthProvider(config.github);
        if (config.google)
            this.googleProvider = new OAuthProvider(config.google);
    }
    getEnabledProviders() {
        const providers = [
            { id: 'local', name: 'Email & Password', type: 'local' },
        ];
        if (this.oidcProvider)
            providers.push({ id: 'oidc', name: 'SSO (OIDC)', type: 'oidc' });
        if (this.githubProvider)
            providers.push({ id: 'github', name: 'GitHub', type: 'oauth' });
        if (this.googleProvider)
            providers.push({ id: 'google', name: 'Google', type: 'oauth' });
        return providers;
    }
    // OIDC
    async getOidcAuthUrl() {
        if (!this.oidcProvider)
            throw new Error('OIDC provider is not configured');
        return this.oidcProvider.getAuthorizationUrl();
    }
    async handleOidcCallback(code, state, meta) {
        if (!this.oidcProvider)
            throw new Error('OIDC provider is not configured');
        const { claims, role } = await this.oidcProvider.handleCallback(code, state);
        const user = await this.upsertUser(claims, 'oidc', role);
        const tokens = this.issueTokens(user, meta);
        userStore.addAuditEntry({ action: 'login', actorId: user.id, actorEmail: user.email, provider: 'oidc', ...meta });
        return { user, tokens };
    }
    // OAuth (GitHub / Google)
    getOAuthAuthUrl(provider) {
        const p = provider === 'github' ? this.githubProvider : this.googleProvider;
        if (!p)
            throw new Error(`${provider} OAuth provider is not configured`);
        return p.getAuthorizationUrl();
    }
    async handleOAuthCallback(provider, code, state, meta) {
        const p = provider === 'github' ? this.githubProvider : this.googleProvider;
        if (!p)
            throw new Error(`${provider} OAuth provider is not configured`);
        const claims = await p.handleCallback(code, state);
        const user = await this.upsertUser(claims, provider, 'viewer');
        const tokens = this.issueTokens(user, meta);
        userStore.addAuditEntry({ action: 'login', actorId: user.id, actorEmail: user.email, provider, ...meta });
        return { user, tokens };
    }
    // Local auth
    async localLogin(email, password, meta) {
        const user = await localLogin(email, password);
        if (!user) {
            userStore.addAuditEntry({ action: 'login_failed', actorEmail: email, provider: 'local', ...meta });
            return null;
        }
        const tokens = this.issueTokens(user, meta);
        userStore.addAuditEntry({ action: 'login', actorId: user.id, actorEmail: user.email, provider: 'local', ...meta });
        return { user, tokens };
    }
    // Session management
    refresh(refreshToken) {
        const session = sessionStore.getByRefreshToken(refreshToken);
        if (!session)
            return null;
        const user = userStore.findById(session.userId);
        if (!user || user.disabled) {
            sessionStore.revoke(session.id);
            return null;
        }
        sessionStore.revoke(session.id);
        return this.issueTokens(user);
    }
    logout(userId) {
        sessionStore.revokeAllForUser(userId);
        userStore.addAuditEntry({ action: 'logout', actorId: userId });
    }
    verifyAccessToken(token) {
        try {
            const payload = jwt.verify(token, JWT_SECRET);
            return {
                sub: String(payload['sub'] ?? ''),
                userId: String(payload['userId'] ?? ''),
                role: payload['role'] ?? 'viewer',
                roles: payload['roles'] ?? [String(payload['role'] ?? 'viewer')],
            };
        }
        catch (err) {
            log.debug({ err }, 'failed to verify access token');
            return null;
        }
    }
    // Helpers
    async upsertUser(claims, provider, defaultRole) {
        let user = userStore.findByExternalId(provider, claims.sub);
        if (!user && claims.email)
            user = userStore.findByEmail(claims.email);
        if (user) {
            return userStore.update(user.id, {
                name: claims.name ?? user.name,
                avatarUrl: claims.picture ?? user.avatarUrl,
                externalId: claims.sub,
                lastLoginAt: new Date().toISOString(),
            }) ?? user;
        }
        const newUser = userStore.create({
            email: claims.email ?? '',
            name: claims.name ?? claims.email ?? 'Unknown',
            avatarUrl: claims.picture,
            authProvider: provider,
            externalId: claims.sub,
            role: defaultRole,
            teams: [],
        });
        userStore.addAuditEntry({ action: 'user_created', actorId: newUser.id, actorEmail: newUser.email, provider });
        return newUser;
    }
    issueTokens(user, meta) {
        const accessToken = jwt.sign({ sub: user.id, userId: user.id, email: user.email, role: user.role, roles: [user.role], jti: crypto.randomBytes(8).toString('hex') }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL_SEC });
        const refreshToken = crypto.randomBytes(48).toString('hex');
        sessionStore.create(user.id, accessToken, refreshToken, REFRESH_TOKEN_TTL_MS, meta);
        return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SEC };
    }
}
export const authManager = new AuthManager();
// Optional admin seed: set SEED_ADMIN=true plus SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD
if (process.env['SEED_ADMIN'] === 'true' && userStore.count() === 0) {
    const seedEmail = process.env['SEED_ADMIN_EMAIL'];
    const seedPassword = process.env['SEED_ADMIN_PASSWORD'];
    if (seedEmail && seedPassword) {
        createLocalUser(seedEmail, seedPassword, 'Admin User', 'admin').catch((err) => {
            log.debug({ err }, 'failed to seed admin user (may already exist)');
        });
    }
}
//# sourceMappingURL=auth-manager.js.map