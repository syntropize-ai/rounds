/**
 * A resolved credential value.
 * The `value` is the raw secret (e.g. a bearer token, API key, webhook URL).
 * Treat as sensitive - never log or expose in responses.
 */
export interface ResolvedCredential {
    /** The raw secret value */
    value: string;
    /** The ref string that was used to look up this credential */
    ref: string;
    /** Source that resolved this credential (e.g. 'env', 'vault') */
    source: string;
}
/**
 * Resolves a `credentialRef` string into its actual secret value.
 *
 * Ref format examples:
 *   "env://SLACK_WEBHOOK_URL"        -> read from process.env.SLACK_WEBHOOK_URL
 *   "vault://secret/slack-webhook"   -> read from a secret store
 *
 * Implementations must throw (or return undefined) when the ref cannot be resolved.
 */
export interface CredentialResolver {
    /**
     * Returns the resolved credential, or `undefined` if not found.
     * Throws on configuration errors (e.g. unsupported scheme).
     */
    resolve(ref: string): Promise<ResolvedCredential | undefined>;
    /** Returns true if this resolver can handle the given ref. */
    canResolve(ref: string): boolean;
}
/**
 * A chain of resolvers tried in order.
 * The first resolver that `canResolve(ref)` handles the ref.
 */
export declare class CredentialResolverChain implements CredentialResolver {
    private readonly resolvers;
    constructor(resolvers?: CredentialResolver[]);
    add(resolver: CredentialResolver): this;
    canResolve(ref: string): boolean;
    resolve(ref: string): Promise<ResolvedCredential | undefined>;
}
//# sourceMappingURL=types.d.ts.map