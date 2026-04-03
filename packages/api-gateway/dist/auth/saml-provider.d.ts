/**
 * SAML 2.0 Provider
 *
 * Full SAML support requires an external library such as `node-saml` or `samlify`.
 * This module provides the interface and SP metadata generation.
 * To enable SAML in production, install `node-saml` and replace the stub methods.
 */
import type { SamlConfig, UserInfoClaims, UserRole } from './types.js';
export declare class SamlProvider {
    private readonly config;
    constructor(config: SamlConfig);
    /**
     * Returns the URL to redirect the user to for SSO initiation.
     * Requires a SAML library to construct a proper SAMLRequest.
     */
    getAuthorizationUrl(): string;
    /**
     * Processes the SAMLResponse POST from the IdP.
     * Requires a SAML library to parse and validate the XML assertion.
     */
    handleCallback(samlResponse: string): Promise<{
        claims: UserInfoClaims;
        role: UserRole;
    }>;
    /**
     * Returns SP metadata XML for registration with the IdP (Okta, Azure AD, etc.).
     * This is safe to serve without a SAML library.
     */
    getSpMetadata(): string;
}
//# sourceMappingURL=saml-provider.d.ts.map