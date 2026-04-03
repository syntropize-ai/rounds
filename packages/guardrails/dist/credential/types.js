// Credential Vault types - CredentialResolver interface + supporting types
/**
 * A chain of resolvers tried in order.
 * The first resolver that `canResolve(ref)` handles the ref.
 */
export class CredentialResolverChain {
    resolvers;
    constructor(resolvers = []) {
        this.resolvers = resolvers;
    }
    add(resolver) {
        this.resolvers.push(resolver);
        return this;
    }
    canResolve(ref) {
        return this.resolvers.some((r) => r.canResolve(ref));
    }
    async resolve(ref) {
        for (const resolver of this.resolvers) {
            if (resolver.canResolve(ref)) {
                return resolver.resolve(ref);
            }
        }
        return undefined;
    }
}
//# sourceMappingURL=types.js.map