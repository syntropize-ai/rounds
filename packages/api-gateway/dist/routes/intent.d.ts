import { Router } from 'express';
import type { IGatewayDashboardStore } from '../repositories/types.js';
/**
 * SSE-streaming intent endpoint.
 *
 * Flow:
 * 1. Classify intent via LLM (stream progress events)
 * 2. Execute alert - create rule; dashboard/investigate - create workspace
 * 3. Send final "done" event with navigation target
 *
 * The home page stays visible throughout, showing real-time progress.
 */
export declare function createIntentRouter(dashboardStore: IGatewayDashboardStore): Router;
//# sourceMappingURL=intent.d.ts.map
