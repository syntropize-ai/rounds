export class BudgetExceededError extends Error {
    investigationId;
    reason;
    constructor(investigationId, reason) {
        super(`Budget exceeded for investigation "${investigationId}": ${reason}`);
        this.investigationId = investigationId;
        this.reason = reason;
        this.name = 'BudgetExceededError';
    }
}
//# sourceMappingURL=types.js.map