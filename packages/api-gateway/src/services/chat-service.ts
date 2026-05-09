import { randomUUID } from 'crypto';
import { createLogger } from '@agentic-obs/common/logging';
import type {
  ChatSession,
  ChatSessionContextRelation,
  ChatSessionContextResourceType,
  DashboardMessage,
  DashboardSseEvent,
  Identity,
} from '@agentic-obs/common';
import { createLlmGateway, createDbAuditSink } from '../routes/llm-factory.js';
import {
  DashboardOrchestratorAgent as OrchestratorAgent,
  shouldCompact,
  compactMessages,
} from '@agentic-obs/agent-core';
import type {
  IConversationStore as IAgentConversationStore,
  IDashboardAlertRuleStore as IAlertRuleStore,
  IDashboardInvestigationStore as IInvestigationStore,
} from '@agentic-obs/agent-core';
import {
  buildAdapterRegistry,
  toAgentDatasources,
} from './dashboard-service.js';
import { OpsCommandRunnerService } from './ops-command-runner-service.js';
import { createAgentConfigService } from './agent-config-adapter.js';
import { DuckDuckGoSearchAdapter } from '@agentic-obs/adapters';

// Web-search adapter is configuration-free for the default DuckDuckGo
// backend, so a single shared instance per process is fine.
const sharedWebSearchAdapter = new DuckDuckGoSearchAdapter();
import type { AccessControlSurface } from './accesscontrol-holder.js';
import type { AuditWriter } from '../auth/audit-writer.js';
import type { SetupConfigService } from './setup-config-service.js';
import type { IGatewayDashboardStore } from '../repositories/types.js';
import type {
  IInvestigationReportRepository,
  IAlertRuleRepository,
  IGatewayInvestigationStore,
  IChatSessionRepository,
  IChatSessionContextRepository,
  IChatMessageRepository,
  IChatSessionEventRepository,
  IOpsConnectorRepository,
  IApprovalRequestRepository,
  ILlmAuditRepository,
} from '@agentic-obs/data-layer';
import type { GitHubChangeSourceRegistry } from './github-change-source-service.js';

const log = createLogger('chat-service');

export interface ChatSessionOwnerScope {
  orgId: string;
  ownerUserId: string;
}

type OwnedChatSession = ChatSession & { ownerUserId?: string | null };
type ChatSessionScopeInput = Parameters<
  IChatSessionRepository['findById']
>[1] & {
  ownerUserId?: string;
};

export interface ChatSessionContextInput {
  id: string;
  sessionId: string;
  orgId: string;
  ownerUserId: string;
  resourceType: ChatSessionContextResourceType;
  resourceId: string;
  relation: ChatSessionContextRelation;
  createdAt: string;
}

function hasPersistedOwner(
  session: ChatSession,
): session is OwnedChatSession & { ownerUserId: string } {
  return (
    typeof (session as OwnedChatSession).ownerUserId === 'string' &&
    (session as OwnedChatSession).ownerUserId !== ''
  );
}

function ownerScope(identity: Identity): ChatSessionOwnerScope {
  return { orgId: identity.orgId, ownerUserId: identity.userId };
}

function sessionScope(scope: ChatSessionOwnerScope): ChatSessionScopeInput {
  return { orgId: scope.orgId, ownerUserId: scope.ownerUserId };
}

export async function findOwnedChatSession(
  store: IChatSessionRepository,
  sessionId: string,
  scope: ChatSessionOwnerScope,
): Promise<ChatSession | undefined> {
  const session = await store.findById(sessionId, sessionScope(scope));
  if (!session) return undefined;
  if (hasPersistedOwner(session)) {
    return session.ownerUserId === scope.ownerUserId ? session : undefined;
  }
  return undefined;
}

export async function listOwnedChatSessions(
  store: IChatSessionRepository,
  limit: number,
  scope: ChatSessionOwnerScope,
): Promise<ChatSession[]> {
  const sessions = await store.findAll(limit, sessionScope(scope));
  return sessions.filter((session) => {
    if (hasPersistedOwner(session))
      return session.ownerUserId === scope.ownerUserId;
    return false;
  });
}

function parseResourcePath(
  path: string,
):
  | { resourceType: ChatSessionContextResourceType; resourceId: string }
  | undefined {
  const pathname = path.split('?')[0] ?? '';
  const match = pathname.match(
    /^\/(dashboards|investigations|alerts|alert-rules)\/([^/?#]+)/,
  );
  if (!match) return undefined;
  const resourceType: ChatSessionContextResourceType =
    match[1] === 'dashboards'
      ? 'dashboard'
      : match[1] === 'investigations'
        ? 'investigation'
        : 'alert';
  return { resourceType, resourceId: decodeURIComponent(match[2] ?? '') };
}

function resourceFromPageContext(pageContext?: {
  kind: string;
  id?: string;
}):
  | { resourceType: ChatSessionContextResourceType; resourceId: string }
  | undefined {
  if (!pageContext?.id) return undefined;
  if (
    pageContext.kind !== 'dashboard' &&
    pageContext.kind !== 'investigation' &&
    pageContext.kind !== 'alert'
  ) {
    return undefined;
  }
  return { resourceType: pageContext.kind, resourceId: pageContext.id };
}

/**
 * Per-process datasource pin map. Keyed by chat-session id, values are a
 * `{ [signalType]: datasourceId }` bag the agent reads/writes via the
 * `datasources.pin` / `datasources.unpin` tools. Lifetime is the gateway
 * process — restarts drop pins (acceptable v1; persistence can land later
 * via a dedicated chat_sessions column when there's actual user pain).
 */
const sessionDatasourcePins = new Map<string, Record<string, string>>();

function getSessionDatasourcePins(sessionId: string): Record<string, string> {
  let pins = sessionDatasourcePins.get(sessionId);
  if (!pins) {
    pins = {};
    sessionDatasourcePins.set(sessionId, pins);
  }
  return pins;
}

/** Adapts data-layer IAlertRuleRepository to agent-core IAlertRuleStore.
 * Exported so background-orchestrator builds (alerts → investigation) can
 * reuse the same adapter without duplicating the shape. */
export function toAlertRuleStore(repo: IAlertRuleRepository): IAlertRuleStore {
  return {
    create: (data) =>
      repo.create(data as Parameters<IAlertRuleRepository['create']>[0]),
    update: repo.update
      ? (id, patch) =>
          repo.update(
            id,
            patch as Parameters<IAlertRuleRepository['update']>[1],
          )
      : undefined,
    findAll: repo.findAll
      ? async () => {
          const result = await repo.findAll();
          return 'list' in result ? result.list : result;
        }
      : undefined,
    findByWorkspace: repo.findByWorkspace
      ? (workspaceId) => repo.findByWorkspace(workspaceId)
      : undefined,
    findById: repo.findById ? (id) => repo.findById(id) : undefined,
    delete: repo.delete ? (id) => repo.delete(id) : undefined,
    getFolderUid: repo.getFolderUid
      ? (orgId, ruleId) => repo.getFolderUid(orgId, ruleId)
      : undefined,
  };
}

export interface ChatServiceDeps {
  dashboardStore: IGatewayDashboardStore;
  investigationReportStore: IInvestigationReportRepository;
  alertRuleStore: IAlertRuleRepository;
  investigationStore?: IGatewayInvestigationStore;
  chatSessionStore?: IChatSessionRepository;
  chatMessageStore?: IChatMessageRepository;
  chatEventStore?: IChatSessionEventRepository;
  chatSessionContextStore?: IChatSessionContextRepository;
  opsConnectorStore?: IOpsConnectorRepository;
  approvalStore?: IApprovalRequestRepository;
  /** P4 — when present, the agent can emit `remediation_plan.create` tools. */
  remediationPlanStore?: import('@agentic-obs/data-layer').IRemediationPlanRepository;
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
  /** In-process change sources such as GitHub webhooks. */
  githubChangeSources?: GitHubChangeSourceRegistry;
  /** Task 04 — when set, LLM gateway audit rows are persisted here. */
  llmAuditStore?: ILlmAuditRepository;
}

/**
 * openobs runs a single full-capability agent (`orchestrator`) for every
 * chat, regardless of the page the user started from. Early Wave 7
 * thinking had four specialized agents (dashboard-assistant,
 * alert-advisor, incident-responder, readonly-analyst) with narrower
 * `allowedTools` ceilings, but that kept biting user intent — "why is
 * latency high" on a dashboard page would pick dashboard-assistant,
 * which lacks `investigation.create`, so the agent narrated a bogus
 * "I don't have permission" even when the caller was an Admin.
 *
 * RBAC (Layer 3) still enforces who-can-do-what; the agent ceiling
 * (Layer 1) no longer narrows by page context. `pageContext` is kept
 * as a prompt hint — the orchestrator is still told what the user was
 * looking at — but it no longer shrinks the tool surface.
 */
function pickAgentTypeFromContext(
  _pageContext?: { kind: string; id?: string } | undefined,
): 'orchestrator' {
  return 'orchestrator';
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

  private async recordSessionContext(
    sessionId: string,
    scope: ChatSessionOwnerScope,
    resource:
      | { resourceType: ChatSessionContextResourceType; resourceId: string }
      | undefined,
    relation: ChatSessionContextRelation,
  ): Promise<void> {
    if (!resource?.resourceId || !this.deps.chatSessionContextStore) return;
    const context: ChatSessionContextInput = {
      id: randomUUID(),
      sessionId,
      orgId: scope.orgId,
      ownerUserId: scope.ownerUserId,
      resourceType: resource.resourceType,
      resourceId: resource.resourceId,
      relation,
      createdAt: new Date().toISOString(),
    };

    try {
      await this.deps.chatSessionContextStore.create(context);
    } catch (err) {
      log.warn(
        {
          err,
          sessionId,
          resourceType: resource.resourceType,
          resourceId: resource.resourceId,
        },
        'failed to persist chat session context',
      );
    }
  }

  async handleMessage(
    message: string,
    sessionId: string | undefined,
    sendEvent: (event: DashboardSseEvent) => void,
    identity: Identity,
    pageContext?: {
      kind: string;
      id?: string;
      timeRange?: string;
      clientTimezone?: string;
    },
    signal?: AbortSignal,
  ): Promise<ChatSessionResult> {
    const llm = await this.deps.setupConfig.getLlm();
    if (!llm) {
      throw new Error(
        'LLM not configured - please complete the Setup Wizard first.',
      );
    }
    const datasources = await this.deps.setupConfig.listDatasources({
      orgId: identity.orgId,
    });

    const resolvedSessionId = sessionId ?? randomUUID();
    const scope = ownerScope(identity);

    // Ensure a chat_sessions record exists for this session
    if (this.deps.chatSessionStore) {
      const existing = await findOwnedChatSession(
        this.deps.chatSessionStore,
        resolvedSessionId,
        scope,
      );
      if (sessionId && !existing) {
        throw new Error('Chat session not found');
      }
      if (!existing) {
        await this.deps.chatSessionStore.create({
          id: resolvedSessionId,
          orgId: identity.orgId,
          ownerUserId: identity.userId,
        });
      }
    }

    await this.recordSessionContext(
      resolvedSessionId,
      scope,
      resourceFromPageContext(pageContext),
      'viewed_with_chat',
    );

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
          log.warn(
            { err, sessionId: resolvedSessionId, kind: event.type },
            'failed to persist chat event',
          );
        }),
      );
    };

    const auditSink = this.deps.llmAuditStore
      ? createDbAuditSink(this.deps.llmAuditStore)
      : undefined;
    const gateway = createLlmGateway(llm, undefined, auditSink);
    const model = llm.model;
    const adapters = buildAdapterRegistry(
      datasources,
      this.deps.githubChangeSources
        ? await this.deps.githubChangeSources.listAdapters(identity.orgId)
        : [],
    );
    const opsCommandRunner =
      this.deps.opsConnectorStore && this.deps.approvalStore
        ? new OpsCommandRunnerService(
            {
              connectors: this.deps.opsConnectorStore,
              approvals: this.deps.approvalStore,
            },
            identity.orgId,
          )
        : undefined;
    const opsConnectors = opsCommandRunner
      ? await opsCommandRunner.listConnectors()
      : undefined;

    // Task 07 — AI-first configuration tools. Available whenever the gateway
    // has both setupConfig and an opsConnectors repository (the same surface
    // the manual Settings UI uses).
    const configService = this.deps.opsConnectorStore
      ? createAgentConfigService({
          setupConfig: this.deps.setupConfig,
          opsConnectors: this.deps.opsConnectorStore,
        })
      : undefined;

    // Parse relative time range (e.g., "1h", "6h", "24h", "7d") to absolute
    // start/end. Carry the client's IANA timezone so the prompt can label
    // both UTC and local time — without that the agent can't reconcile a
    // clock time the user reads off the panel's x-axis.
    let timeRange:
      | { start: string; end: string; clientTimezone?: string }
      | undefined;
    if (pageContext?.timeRange) {
      const now = new Date();
      const match = pageContext.timeRange.match(/^(\d+)([mhd])$/);
      if (match) {
        const amount = Number(match[1]);
        const unit = match[2];
        const ms =
          unit === 'm'
            ? amount * 60_000
            : unit === 'h'
              ? amount * 3_600_000
              : amount * 86_400_000;
        timeRange = {
          start: new Date(now.getTime() - ms).toISOString(),
          end: now.toISOString(),
          ...(pageContext.clientTimezone
            ? { clientTimezone: pageContext.clientTimezone }
            : {}),
        };
      }
    }

    // Chat history lives in chat_messages keyed by sessionId. The orchestrator
    // reads its history through `conversationStore.getMessages(sessionId)`;
    // we adapt chatMessageStore to that shape below.

    // --- Context compaction ---
    // Load existing summary from session, then check if we need to compact further
    let conversationSummary: string | undefined;
    if (this.deps.chatSessionStore) {
      const session = await findOwnedChatSession(
        this.deps.chatSessionStore,
        resolvedSessionId,
        scope,
      );
      conversationSummary = session?.contextSummary || undefined;
    }

    // Check if chat history is large enough to warrant compaction
    if (this.deps.chatMessageStore) {
      const allMessages =
        await this.deps.chatMessageStore.getMessages(resolvedSessionId);
      const asCompletionMessages = allMessages.map((m) => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      }));

      // Estimate system prompt tokens (~4000 is a safe estimate for the static prompt)
      const systemPromptTokenEstimate = 4000;
      if (shouldCompact(systemPromptTokenEstimate, asCompletionMessages)) {
        log.info(
          { sessionId: resolvedSessionId, messageCount: allMessages.length },
          'compacting conversation context',
        );
        const compacted = await compactMessages(
          gateway,
          model,
          asCompletionMessages,
        );
        conversationSummary = compacted.summary || conversationSummary;

        // Persist summary for reuse in future turns
        if (conversationSummary && this.deps.chatSessionStore) {
          await this.deps.chatSessionStore.updateContextSummary(
            resolvedSessionId,
            conversationSummary,
            sessionScope(scope),
          );
        }
      }
    }

    // Adapt chatMessageStore (sessionId → ChatMessage[]) to the orchestrator's
    // conversationStore shape. Writes are no-ops because chat-service persists
    // user / assistant turns directly to chat_messages above and below.
    const chatMsgStore = this.deps.chatMessageStore;
    const conversationStoreAdapter = {
      getMessages: async (key: string) =>
        chatMsgStore ? await chatMsgStore.getMessages(key) : [],
      addMessage: async (_key: string, msg: DashboardMessage) => msg,
      clearMessages: async () => {
        /* handled externally */
      },
      deleteConversation: async () => {
        /* handled externally */
      },
    } as IAgentConversationStore;

    const orchestrator = new OrchestratorAgent(
      {
        gateway,
        model,
        store: this.deps.dashboardStore,
        conversationStore: conversationStoreAdapter,
        investigationReportStore: this.deps.investigationReportStore,
        investigationStore: this.deps.investigationStore as
          | IInvestigationStore
          | undefined,
        alertRuleStore: toAlertRuleStore(this.deps.alertRuleStore),
        ...(this.deps.folderRepository
          ? { folderRepository: this.deps.folderRepository }
          : {}),
        adapters,
        webSearchAdapter: sharedWebSearchAdapter,
        allDatasources: toAgentDatasources(datasources),
        // Live pin bag for this session — the agent mutates it via
        // datasources.pin/unpin and we read it back across messages.
        sessionDatasourcePins: getSessionDatasourcePins(resolvedSessionId),
        ...(opsCommandRunner ? { opsCommandRunner, opsConnectors } : {}),
        ...(configService ? { configService } : {}),
        // P4 — agent can propose remediation plans when these stores are wired.
        ...(this.deps.remediationPlanStore
          ? { remediationPlans: this.deps.remediationPlanStore }
          : {}),
        ...(this.deps.approvalStore
          ? { approvalRequests: this.deps.approvalStore }
          : {}),
        sendEvent: wrappedSendEvent,
        timeRange,
        conversationSummary,
        identity,
        accessControl: this.deps.accessControl,
        ...(this.deps.auditWriter
          ? { auditWriter: this.deps.auditWriter }
          : {}),
        // Page-based specialized agent selection (§D-layer-1). Falls back to
        // the full orchestrator when the page has no tight capability ceiling.
        agentType: pickAgentTypeFromContext(pageContext),
      },
      resolvedSessionId,
    );

    // If the user is viewing a specific dashboard, scope the agent to it
    const dashboardId =
      pageContext?.kind === 'dashboard' ? pageContext.id : undefined;

    log.info(
      {
        sessionId: resolvedSessionId,
        dashboardId,
        messageLength: message.length,
      },
      'starting session orchestrator',
    );
    const replyContent = await orchestrator.handleMessage(
      message,
      dashboardId,
      signal,
    );
    const assistantActions = orchestrator.consumeConversationActions();
    const navigate = orchestrator.consumeNavigate();
    await this.recordSessionContext(
      resolvedSessionId,
      scope,
      navigate ? parseResourcePath(navigate) : undefined,
      'created_from_chat',
    );
    log.info(
      { sessionId: resolvedSessionId, reply: replyContent.slice(0, 100) },
      'session orchestrator done',
    );

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
      const session = await findOwnedChatSession(
        this.deps.chatSessionStore,
        resolvedSessionId,
        scope,
      );
      if (session && !session.title) {
        // Use first ~60 chars of user message as title
        const autoTitle =
          message.length > 60 ? message.slice(0, 57) + '...' : message;
        await this.deps.chatSessionStore.updateTitle(
          resolvedSessionId,
          autoTitle,
          sessionScope(scope),
        );
      }
    }

    return {
      sessionId: resolvedSessionId,
      replyContent,
      assistantMessageId,
      navigate,
    };
  }
}
