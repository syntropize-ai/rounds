import { Router } from 'express';
import { postMortemStore as postmortemStore } from './post-mortem-store.js';
import type { PostMortemInput, PostMortemReport } from '@agentic-obs/agent-core';
import type { IGatewayIncidentStore } from '../repositories/types.js';
export interface PostMortemGeneratorDep {
    generate(input: PostMortemInput): Promise<PostMortemReport>;
}
export interface IncidentRouterExtras {
    pmStore?: typeof postmortemStore;
    generator?: PostMortemGeneratorDep;
}
export declare function createIncidentRouter(store?: IGatewayIncidentStore, extras?: IncidentRouterExtras): Router;
export declare const incidentRouter: Router;
//# sourceMappingURL=incident.d.ts.map