import { Router } from 'express';
import { ScheduledInvestigation } from '@agentic-obs/agent-core';
export interface ScheduleRouterDeps {
    scheduler: ScheduledInvestigation;
}
export declare function createScheduleRouter(deps: ScheduleRouterDeps): Router;
//# sourceMappingURL=schedules.d.ts.map
