import type { DashboardVariable } from '@agentic-obs/common';
export declare class VariableResolver {
    private readonly prometheusUrl;
    private readonly headers;
    constructor(prometheusUrl: string, headers?: Record<string, string>);
    resolve(variable: DashboardVariable): Promise<string[]>;
    private resolveQuery;
    private resolveDatasources;
}
//# sourceMappingURL=variable-resolver.d.ts.map
