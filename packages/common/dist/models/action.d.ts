export interface Action {
    id: string;
    investigationId: string;
    type: 'rollback' | 'scale' | 'restart' | 'ticket' | 'notify' | 'runbook' | 'feature_flag';
    description: string;
    policyTag: 'suggest' | 'approve_required' | 'deny';
    status: 'proposed' | 'approved' | 'executing' | 'completed' | 'failed' | 'denied';
    params: Record<string, unknown>;
    result?: {
        success: boolean;
        message?: string;
        executedAt?: string;
    };
    risk: 'low' | 'medium' | 'high';
}
//# sourceMappingURL=action.d.ts.map