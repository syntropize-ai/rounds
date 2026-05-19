/**
 * Re-export shim — the real implementation now lives in agent-core so agent
 * tool handlers can fire panel-event rows without depending on this package.
 * Existing imports from `./panel-event-recorder` keep working.
 */

export {
  createPanelEventRecorder,
  noopPanelEventRecorder,
  isAiGenerated,
  type PanelEventRecorder,
  type RecorderContext,
} from '@agentic-obs/agent-core';
