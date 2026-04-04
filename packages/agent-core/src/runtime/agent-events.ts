import type { AgentType } from './agent-types.js';

export type AgentEventType =
  | 'agent.started'
  | 'agent.tool_called'
  | 'agent.tool_completed'
  | 'agent.tool_blocked'
  | 'agent.artifact_proposed'
  | 'agent.artifact_verified'
  | 'agent.completed'
  | 'agent.failed';

export interface AgentEvent {
  type: AgentEventType;
  agentType: AgentType;
  timestamp: string;
  metadata?: Record<string, unknown>;
}
