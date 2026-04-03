import type { Request, Response } from 'express'
import { createLogger } from '@agentic-obs/common'
import type { DashboardSseEvent } from '@agentic-obs/common'

const log = createLogger('chat-handler')
import type { IGatewayDashboardStore, IConversationStore } from '../../repositories/types.js'
import { DashboardService, withDashboardLock } from '../../services/dashboard-service.js'

function sendEvent(res: Response, event: DashboardSseEvent): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

/**
 * Thin HTTP/SSE adapter — delegates all business logic to DashboardService.
 */
export async function handleChatMessage(
  req: Request,
  res: Response,
  dashboardId: string,
  message: string,
  store: IGatewayDashboardStore,
  conversationStore: IConversationStore,
): Promise<void> {
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
      const service = new DashboardService(store, conversationStore)
      const result = await service.handleChatMessage(
        dashboardId,
        message,
        (event) => { if (!closed) sendEvent(res, event) },
      )

      if (!closed) {
        sendEvent(res, { type: 'done', messageId: result.assistantMessageId })
      }
    })
  }
  catch (err) {
    log.error({ err }, 'chat handler error')
    const errMsg = err instanceof Error ? err.message : 'Internal error'
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', message: errMsg })}\n\n`)
  }
  finally {
    clearInterval(heartbeat)
    res.end()
  }
}
