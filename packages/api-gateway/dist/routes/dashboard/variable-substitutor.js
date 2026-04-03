// Substitutes $variable and ${variable} references in PromQL with actual values
/**
 * Replaces all $varName and ${varName} tokens in a PromQL query string with the
 * resolved current value of each matching dashboard variable.
 *
 * Multi-select "All" expands to ".*" so it works inside PromQL regex matchers.
 * Multi-select with specific values joins them with '|' for use in =~ selectors.
 */
export function substituteVariables(query, variables) {
    let result = query;
    for (const v of variables) {
        const value = v.current ?? '';
        let replacement;
        if (v.multi && v.includeAll && value === 'ALL') {
            replacement = '.*';
        }
        else {
            replacement = value;
        }
        // Replace both ${varName} and $varName forms - braced form first to avoid
        // double-substitution when one is a prefix of another variable name.
        const bracedPattern = new RegExp(`\\$\\{${escapeRegExp(v.name)}\\}`, 'g');
        const barePattern = new RegExp(`\\$${escapeRegExp(v.name)}(?![a-zA-Z0-9_])`, 'g');
        result = result.replace(bracedPattern, replacement);
        result = result.replace(barePattern, replacement);
    }
    return result;
}
function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
//# sourceMappingURL=variable-substitutor.js.map