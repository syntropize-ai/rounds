import { randomUUID } from 'crypto';
import { createLogger } from '@agentic-obs/common/logging';
import type { DashboardSseEvent, Identity } from '@agentic-obs/common';
import { createLlmGateway } from '../routes/llm-factory.js';
import { DashboardOrchestratorAgent as OrchestratorAgent, shouldCompact, compactMessages, estimateTokens } from '@agentic-obs/agent-core';
import type { IDashboardAlertRuleStore as IAlertRuleStore, IDashboardInvestigationStore as IInvestigationStore } from '@agentic-obs/agent-core';
import { PrometheusMetricsAdapter } from '@agentic-obs/adapters';
import { resolvePrometheusDatasource, toAgentDatasources } from './dashboard-service.js';
import type { AccessControlSurface } from './accesscontrol-holder.js';
import type { AuditWriter } from '../auth/audit-writer.js';
import type { SetupConfigService } from './setup-config-service.js';
import type { IGatewayDashboardStore, IConversationStore } from '../repositories/types.js';
import type { IInvestigationReportRepository, IAlertRuleRepository, IGatewayInvestigationStore, IChatSessionRepository, IChatMessageRepository, IChatSessionEventRepository } from '@agentic-obs/data-layer';

const log = createLogger('chat-service');

/** Adapts data-layer IAlertRuleRepository to agent-core IAlertRuleStore. */
function toAlertRuleStore(repo: IAlertRuleRepository): IAlertRuleStore {
  return {
    create: (data) => repo.create(data as Parameters<IAlertRuleRepository['create']>[0]),
    update: repo.update ? (id, patch) => repo.update(id, patch as Parameters<IAlertRuleRepository['update']>[1]) : undefined,
    findAll: repo.findAll
      ? async () => {
          const result = await repo.findAll();
          return 'list' in result ? result.list : result;
        }
      : undefined,
    findById: repo.findById ? (id) => repo.findById(id) : undefined,
    delete: repo.delete ? (id) => repo.delete(id) : undefined,
  };
}

export interface ChatServiceDeps {
  dashboardStore: IGatewayDashboardStore;
  conversationStore: IConversationStore;
  investigationReportStore: IInvestigationReportRepository;
  alertRuleStore: IAlertRuleRepository;
  investigationStore?: IGatewayInvestigationStore;
  chatSessionStore?: IChatSessionRepository;
  chatMessageStore?: IChatMessageRepository;
  chatEventStore?: IChatSessionEventRepository;
  /** Wave 7 — RBAC surface for the agent permission gate. Required. */
  accessControl: AccessControlSurface;
  /** Audit-log writer. Optional but strongly recommended in production. */
  auditWriter?: AuditWriter;
  /** Folder backend — enables agent folder.create / folder.list tools. Optional
   *  (in-memory deployments can omit; those tools return a clear
   *  "not configured" observation). */
  folderRepository?: import('@agentic-obs/common').IFolderRepository;
  /** W2 / T2.4 — LLM + datasource config source. */
  setupConfig: SetupConfigService;
}

/**
 * Pick the narrowest specialized agent type given a page context.
 * Falls back to `orchestrator` when no tighter ceiling applies. Specialized
 * types enforce Layer 1 of the permission gate (AgentDef.allowedTools), so a
 * chat panel opened on a dashboard page cannot, say, create alert rules even
 * if the user would otherwise have permission — the tool isn't in the
 * agent's capability ceiling.
 */
function pickAgentTypeFromContext(
  pageContext?: { kind: string; id?: string } | undefined,
): 'orchestrator' | 'dashboard-assistant' | 'alert-advisor' | 'incident-responder' | 'readonly-analyst' {
  switch (pageContext?.kind) {
    case 'dashboard':       return 'dashboard-assistant';
    case 'alert':
    case 'alerts':          return 'alert-advisor';
    case 'investigation':
    case 'investigations':  return 'incident-responder';
    default:                return 'orchestrator';
  }
}

// Event kinds that represent transient signalling (terminator, navigation
// side-effect, duplicated message content) and should NOT be persisted to the
// event trace — they'd clutter replay or double-render messages already saved
// in chat_messages.
const SKIP_PERSIST_KINDS = new Set(['reply', 'done', 'navigate']);

export interface ChatSessionResult {
  sessionId: string;
  replyContent: string;
  assistantMessageId: string;
  navigate?: string;
}

export class ChatService {
  constructor(private deps: ChatServiceDeps) {}

  async handleMessage(
    message: string,
    sessionId: string | undefined,
    sendEvent: (event: DashboardSseEvent) => void,
    identity: Identity,
    pageContext?: { kind: string; id?: string; timeRange?: string },
  ): Promise<ChatSessionResult> {
    const llm = await this.deps.setupConfig.getLlm();
    if (!llm) {
      throw new Error('LLM not configured - please complete the Setup Wizard first.');
    }
    const datasources = await this.deps.setupConfig.listDatasources();

    const resolvedSessionId = sessionId ?? randomUUID();

    // Ensure a chat_sessions record exists for this session
    if (this.deps.chatSessionStore) {
      const existing = await this.deps.chatSessionStore.findById(resolvedSessionId);
      if (!existing) {
        await this.deps.chatSessionStore.create({ id: resolvedSessionId });
      }
    }

    // Persist the user message to chat_messages
    const userMsgId = randomUUID();
    if (this.deps.chatMessageStore) {
      await this.deps.chatMessageStore.addMessage(resolvedSessionId, {
        id: userMsgId,
        role: 'user',
        content: message,
        timestamp: new Date().toISOString(),
      });
    }

    // Wrap sendEvent so every step event (thinking, tool_call, tool_result,
    // panel_added, etc.) is persisted under this session. The live SSE stream
    // still goes out immediately; persistence is awaited in the background so
    // it doesn't add latency to user-visible updates.
    const eventStore = this.deps.chatEventStore;
    let seq = eventStore ? await eventStore.nextSeq(resolvedSessionId) : 0;
    const persistQueue: Array<Promise<void>> = [];
    const wrappedSendEvent = (event: DashboardSseEvent) => {
      sendEvent(event);
      if (!eventStore) return;
      if (SKIP_PERSIST_KINDS.has(event.type)) return;
      const record = {
        id: randomUUID(),
        sessionId: resolvedSessionId,
        seq: seq++,
        kind: event.type,
        payload: event as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      };
      persistQueue.push(
        Promise.resolve(eventStore.append(record)).catch((err) => {
          log.warn({ err, sessionId: resolvedSessionId, kind: event.type }, 'failed to persist chat event');
        }),
      );
    };

    const gateway = createLlmGateway(llm);
    const model = llm.model;
    const prom = resolvePrometheusDatasource(datasources);

    const metricsAdapter = prom
      ? new PrometheusMetricsAdapter(prom.url, prom.headers)
      : undefined;

    // Parse relative time range (e.g., "1h", "6h", "24h", "7d") to absolute start/end
    let timeRange: { start: string; end: string } | undefined;
    if (pageContext?.timeRange) {
      const now = new Date();
      const match = pageContext.timeRange.match(/^(\d+)([mhd])$/);
      if (match) {
        const amount = Number(match[1]);
        const unit = match[2];
        const ms = unit === 'm' ? amount * 60_000 : unit === 'h' ? amount * 3_600_000 : amount * 86_400_000;
        timeRange = { start: new Date(now.getTime() - ms).toISOString(), end: now.toISOString() };
      }
    }

    // Chat history is stored in chat_messages (independent of dashboards).
    // The orchestrator reads from conversationStore keyed by sessionId when
    // no dashboardId is scoped, so we pass chatMessageStore-backed adapter below.

    // --- Context compaction ---
    // Load existing summary from session, then check if we need to compact further
    let conversationSummary: string | undefined;
    if (this.deps.chatSessionStore) {
      const session = await this.deps.chatSessionStore.findById(resolvedSessionId);
      conversationSummary = session?.contextSummary || undefined;
    }

    // Check if chat history is large enough to warrant compaction
    if (this.deps.chatMessageStore) {
      const allMessages = await this.deps.chatMessageStore.getMessages(resolvedSessionId);
      const asCompletionMessages = allMessages.map(m => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      }));

      // Estimate system prompt tokens (~4000 is a safe estimate for the static prompt)
      const systemPromptTokenEstimate = 4000;
      if (shouldCompact(systemPromptTokenEstimate, asCompletionMessages)) {
        log.info({ sessionId: resolvedSessionId, messageCount: allMessages.length }, 'compacting conversation context');
        const compacted = await compactMessages(gateway, model, asCompletionMessages);
        conversationSummary = compacted.summary || conversationSummary;

        // Persist summary for reuse in future turns
        if (conversationSummary && this.deps.chatSessionStore) {
          await this.deps.chatSessionStore.updateContextSummary(resolvedSessionId, conversationSummary);
        }
      }
    }

    // Route conversation history reads: if the key is a dashboardId, use
    // dashboard_messages (legacy). Otherwise use chat_messages (session mode).
    // Writes are no-ops here — chat-service persists messages directly.
    const chatMsgStore = this.deps.chatMessageStore;
    const dashboardStore = this.deps.dashboardStore;
    const baseConvStore = this.deps.conversationStore;
    const conversationStoreAdapter = chatMsgStore
      ? {
          getMessages: async (key: string) => {
            // Check if this is a dashboard ID (exists in dashboards table)
            const dash = await dashboardStore.findById(key);
            if (dash) {
              return baseConvStore.getMessages(key);
            }
            // Otherwise treat as sessionId — read from chat_messages
            return chatMsgStore.getMessages(key) as ReturnType<typeof baseConvStore.getMessages>;
          },
          addMessage: async () => { /* writes handled directly by chat-service */ },
          clearMessages: async () => { /* handled externally */ },
        }
      : baseConvStore;

    const orchestrator = new OrchestratorAgent({
      gateway,
      model,
      store: this.deps.dashboardStore,
      conversationStore: conversationStoreAdapter as typeof baseConvStore,
      investigationReportStore: this.deps.investigationReportStore,
      investigationStore: this.deps.investigationStore as IInvestigationStore | undefined,
      alertRuleStore: toAlertRuleStore(this.deps.alertRuleStore),
      ...(this.deps.folderRepository ? { folderRepository: this.deps.folderRepository } : {}),
      metricsAdapter,
      allDatasources: toAgentDatasources(datasources),
      sendEvent: wrappedSendEvent,
      timeRange,
      conversationSummary,
      identity,
      accessControl: this.deps.accessControl,
      ...(this.deps.auditWriter ? { auditWriter: this.deps.auditWriter } : {}),
      // Page-based specialized agent selection (§D-layer-1). Falls back to
      // the full orchestrator when the page has no tight capability ceiling.
      agentType: pickAgentTypeFromContext(pageContext),
    }, resolvedSessionId);

    // If the user is viewing a specific dashboard, scope the agent to it
    const dashboardId = pageContext?.kind === 'dashboard' ? pageContext.id : undefined;

    log.info({ sessionId: resolvedSessionId, dashboardId, message: message.slice(0, 80) }, 'starting session orchestrator');
    const replyContent = await orchestrator.handleMessage(message, dashboardId);
    const assistantActions = orchestrator.consumeConversationActions();
    const navigate = orchestrator.consumeNavigate();
    log.info({ sessionId: resolvedSessionId, reply: replyContent.slice(0, 100) }, 'session orchestrator done');

    // Wait for all queued event persistence to flush before we finalize the
    // assistant message — guarantees the step trace is fully durable by the
    // time the client sees 'done' and subsequent /messages loads are consistent.
    if (persistQueue.length > 0) {
      await Promise.all(persistQueue);
    }

    // Persist assistant response to chat_messages
    const assistantMessageId = randomUUID();
    if (this.deps.chatMessageStore) {
      await this.deps.chatMessageStore.addMessage(resolvedSessionId, {
        id: assistantMessageId,
        role: 'assistant',
        content: replyContent,
        actions: assistantActions.length > 0 ? assistantActions : undefined,
        timestamp: new Date().toISOString(),
      });
    }

    // Update session title from first assistant message if title is empty
    if (this.deps.chatSessionStore) {
      const session = await this.deps.chatSessionStore.findById(resolvedSessionId);
      if (session && !session.title) {
        // Use first ~60 chars of user message as title
        const autoTitle = message.length > 60 ? message.slice(0, 57) + '...' : message;
        await this.deps.chatSessionStore.updateTitle(resolvedSessionId, autoTitle);
      }
    }

    return { sessionId: resolvedSessionId, replyContent, assistantMessageId, navigate };
  }
}
