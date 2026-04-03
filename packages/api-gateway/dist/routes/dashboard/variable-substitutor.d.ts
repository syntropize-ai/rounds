import type { DashboardVariable } from '@agentic-obs/common';
/**
 * Replaces all $varName and ${varName} tokens in a PromQL query string with the
 * resolved current value of each matching dashboard variable.
 *
 * Multi-select "All" expands to ".*" so it works inside PromQL regex matchers.
 * Multi-select with specific values joins them with '|' for use in =~ selectors.
 */
export declare function substituteVariables(query: string, variables: DashboardVariable[]): string;
//# sourceMappingURL=variable-substitutor.d.ts.map