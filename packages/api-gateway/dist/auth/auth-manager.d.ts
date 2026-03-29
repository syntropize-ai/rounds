import type { User, UserRole, AuthProviderConfig } from './types.js';
export interface TokenPair {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
}
export interface AuthenticatedUser {
    user: User;
    tokens: TokenPair;
}
export declare class AuthManager {
    private oidcProvider?;
    private githubProvider?;
    private googleProvider?;
    private samlProvider?;
    configure(config: AuthProviderConfig): void;
    getEnabledProviders(): Array<{
        id: string;
        name: string;
        type: string;
    }>;
    getOidcAuthUrl(): Promise<{
        url: string;
        state: string;
    }>;
    handleOidcCallback(code: string, state: string, meta?: {
        ipAddress?: string;
        userAgent?: string;
    }): Promise<AuthenticatedUser>;
    getOAuthAuthUrl(provider: 'github' | 'google'): {
        url: string;
        state: string;
    };
    handleOAuthCallback(provider: 'github' | 'google', code: string, state: string, meta?: {
        ipAddress?: string;
        userAgent?: string;
    }): Promise<AuthenticatedUser>;
    localLogin(email: string, password: string, meta?: {
        ipAddress?: string;
        userAgent?: string;
    }): Promise<AuthenticatedUser | null>;
    refresh(refreshToken: string): TokenPair | null;
    logout(userId: string): void;
    verifyAccessToken(token: string): {
        sub: string;
        userId: string;
        role: UserRole;
        roles: string[];
    } | null;
    private upsertUser;
    private issueTokens;
}
export declare const authManager: AuthManager;
//# sourceMappingURL=auth-manager.d.ts.map
