export interface Service {
    id: string;
    name: string;
    type: 'service' | 'endpoint' | 'job' | 'pod' | 'host';
    metadata: Record<string, string>;
    tags: string[];
    ownerId?: string;
}
//# sourceMappingURL=service.d.ts.map