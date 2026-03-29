import { Router } from 'express';
import type { PostMortemStore } from './post-mortem-store.js';
import type { PostMortemInput, PostMortemReport } from '@agentic-obs/agent-core';
import type { IGatewayIncidentStore } from '../repositories/types.js';
export interface PostMortemGeneratorDep {
    generate(input: PostMortemInput): Promise<PostMortemReport>;
}
export interface IncidentRouterExtras {
    pmStore?: PostMortemStore;
    generator?: PostMortemGeneratorDep;
}
export declare function createIncidentRouter(store?: IGatewayIncidentStore, extras?: IncidentRouterExtras): Router;
export declare const incidentRouter: Router;
//# sourceMappingURL=incident.d.ts.map
