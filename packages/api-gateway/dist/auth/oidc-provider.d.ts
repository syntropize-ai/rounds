import type { OidcConfig, OidcDiscovery, UserInfoClaims, UserRole } from './types.js';
export declare class OidcProvider {
    private readonly config;
    private discovery;
    private discoveryFetchedAt;
    private readonly DISCOVERY_TTL_MS;
    constructor(config: OidcConfig);
    getDiscovery(): Promise<OidcDiscovery>;
    getAuthorizationUrl(): Promise<{
        url: string;
        state: string;
    }>;
    handleCallback(code: string, state: string): Promise<{
        claims: UserInfoClaims;
        role: UserRole;
    }>;
    private mapGroupsToRole;
}
//# sourceMappingURL=oidc-provider.d.ts.map
