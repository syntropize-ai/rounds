// Re-export the canonical changes adapter interface from @agentic-obs/adapters.
// Kept here for backwards-compat with code that still imports from agent-core.

export type {
  IChangesAdapter,
  ChangeKind,
  ChangeRecord,
  ChangesListInput,
} from '@agentic-obs/adapters';
