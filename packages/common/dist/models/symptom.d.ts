export interface Symptom {
    id: string;
    serviceId: string;
    type: 'latency' | 'error_rate' | 'saturation' | 'traffic';
    measurement: {
        current: number;
        baseline: number;
        unit: string;
    };
    window: {
        start: string;
        end: string;
    };
    severity: 'low' | 'medium' | 'high' | 'critical';
}
//# sourceMappingURL=symptom.d.ts.map