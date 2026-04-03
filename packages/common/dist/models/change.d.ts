export interface Change {
    id: string;
    serviceId: string;
    type: 'deploy' | 'config' | 'scale' | 'feature_flag';
    timestamp: string;
    author: string;
    description: string;
    diff?: string;
    version?: string;
}
//# sourceMappingURL=change.d.ts.map