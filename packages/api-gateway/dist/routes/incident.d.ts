import { Router } from 'express';
import type { PostMortemInput, PostMortemReport } from '@agentic-obs/agent-core';
import type { IGatewayIncidentStore, IGatewayInvestigationStore } from '../repositories/types.js';
import type { IPostMortemRepository } from '@agentic-obs/data-layer';
export interface PostMortemGeneratorDep {
    generate(input: PostMortemInput): Promise<PostMortemReport>;
}
export interface IncidentRouterDeps {
    store: IGatewayIncidentStore;
    investigationStore: IGatewayInvestigationStore;
    pmStore: IPostMortemRepository;
    generator?: PostMortemGeneratorDep;
}
export declare function createIncidentRouter(deps: IncidentRouterDeps): Router;
//# sourceMappingURL=incident.d.ts.map