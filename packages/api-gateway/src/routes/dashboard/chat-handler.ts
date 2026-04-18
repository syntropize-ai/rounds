import type { Response } from 'express'
import { createLogger } from '@agentic-obs/common'
import type { DashboardSseEvent } from '@agentic-obs/common'
import type { AuthenticatedRequest } from '../../middleware/auth.js'

const log = createLogger('chat-handler')
import type { IGatewayDashboardStore, IConversationStore } from '../../repositories/types.js'
import type { IInvestigationReportRepository, IAlertRuleRepository, IGatewayInvestigationStore, IGatewayFeedStore } from '@agentic-obs/data-layer'
import { DashboardService, withDashboardLock } from '../../services/dashboard-service.js'
import type { AccessControlSurface } from '../../services/accesscontrol-holder.js'
import type { AuditWriter } from '../../auth/audit-writer.js'

function sendEvent(res: Response, event: DashboardSseEvent): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

/**
 * Thin HTTP/SSE adapter — delegates all business logic to DashboardService.
 */
export async function handleChatMessage(
  req: AuthenticatedRequest,
  res: Response,
  dashboardId: string,
  message: string,
  timeRange: { start?: string; end?: string; timezone?: string } | undefined,
  store: IGatewayDashboardStore,
  conversationStore: IConversationStore,
  investigationReportStore: IInvestigationReportRepository,
  alertRuleStore: IAlertRuleRepository,
  accessControl: AccessControlSurface,
  investigationStore?: IGatewayInvestigationStore,
  feedStore?: IGatewayFeedStore,
  auditWriter?: AuditWriter,
  folderRepository?: import('@agentic-obs/common').IFolderRepository,
): Promise<void> {
  if (!req.auth) {
    res.status(401).json({ message: 'authentication required' })
    return
  }
  const dashboard = await store.findById(dashboardId)
  if (!dashboard) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' })
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  let closed = false
  req.on('close', () => { closed = true })

  const heartbeat = setInterval(() => {
    if (!closed) res.write(': heartbeat\n\n')
  }, 30_000)

  try {
    await withDashboardLock(dashboardId, async () => {
      const service = new DashboardService({
        store, conversationStore, investigationReportStore, alertRuleStore,
        investigationStore, feedStore, accessControl,
        ...(auditWriter ? { auditWriter } : {}),
        ...(folderRepository ? { folderRepository } : {}),
      })
      const result = await service.handleChatMessage(
        dashboardId,
        message,
        timeRange,
        (event) => { if (!closed) sendEvent(res, event) },
        req.auth!,
      )

      if (!closed) {
        sendEvent(res, { type: 'done', messageId: result.assistantMessageId })
      }
    })
  }
  catch (err) {
    log.error({ err }, 'chat handler error')
    // Ensure dashboard exits generating state even on error
    try { await store.updateStatus(dashboardId, 'ready') } catch { /* best effort */ }
    const errMsg = err instanceof Error ? err.message : 'Internal error'
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', message: errMsg })}\n\n`)
  }
  finally {
    clearInterval(heartbeat)
    res.end()
  }
}
