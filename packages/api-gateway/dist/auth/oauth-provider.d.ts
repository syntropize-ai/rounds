import type { OAuthConfig, UserInfoClaims } from './types.js';
export declare class OAuthProvider {
    private readonly config;
    constructor(config: OAuthConfig);
    getAuthorizationUrl(): {
        url: string;
        state: string;
    };
    handleCallback(code: string, state: string): Promise<UserInfoClaims>;
    private normalizeGitHub;
    private normalizeGoogle;
}
//# sourceMappingURL=oauth-provider.d.ts.map
