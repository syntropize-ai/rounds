import { Router } from 'express';
import { EvidenceStore } from '@agentic-obs/agent-core';
/**
 * Create the evidence router, optionally injecting an EvidenceStore.
 * Passing a custom store makes the routes fully testable without globals.
 */
export declare function createEvidenceRouter(store?: EvidenceStore): Router;
/** Shared singleton store for the running server */
export declare const evidenceStore: EvidenceStore;
/** Default router wired to the singleton store */
export declare const evidenceRouter: Router;
//# sourceMappingURL=evidence.d.ts.map
