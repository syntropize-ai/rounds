export interface Evidence {
    id: string;
    hypothesisId: string;
    type: 'metric' | 'log' | 'trace' | 'event' | 'change' | 'log_cluster' | 'trace_waterfall';
    query: string;
    queryLanguage: string;
    result: unknown;
    summary: string;
    timestamp: string;
    reproducible: boolean;
}
//# sourceMappingURL=evidence.d.ts.map