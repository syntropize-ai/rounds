import { randomUUID } from 'crypto'
import type { Request, Response } from 'express'
import type { DashboardSseEvent } from '@agentic-obs/common'
import type { IGatewayDashboardStore, IConversationStore } from '../../repositories/types.js'
import { getSetupConfig } from '../setup.js'
import { createLlmGateway } from '../llm-factory.js'
import { OrchestratorAgent } from './agents/orchestrator-agent.js'

function sendEvent(res: Response, event: DashboardSseEvent): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

const dashboardLocks = new Map<string, Promise<void>>()

async function withDashboardLock<T>(dashboardId: string, fn: () => Promise<T>): Promise<T> {
  let resolve: () => void
  const next = new Promise<void>((r) => { resolve = r })
  const wait = dashboardLocks.get(dashboardId) ?? Promise.resolve()
  dashboardLocks.set(dashboardId, next)
  await wait
  try {
    return await fn()
  }
  finally {
    resolve!()
    if (dashboardLocks.get(dashboardId) === next) {
      dashboardLocks.delete(dashboardId)
    }
  }
}

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
  req.on('close', () => {
    closed = true
  })

  // Heartbeat every 30s to prevent proxy timeouts
  const heartbeat = setInterval(() => {
    if (!closed)
      res.write(': heartbeat\n\n')
  }, 30_000)

  try {
    // Save user message
    const userMessageId = randomUUID()
    conversationStore.addMessage(dashboardId, {
      id: userMessageId,
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    })

    if (closed)
      return

    await withDashboardLock(dashboardId, async () => {
      const config = getSetupConfig()
      if (!config.llm) {
        sendEvent(res, { type: 'error', message: 'LLM not configured - please complete the Setup Wizard first.' })
        return
      }

      const gateway = createLlmGateway(config.llm)
      const model = config.llm.model || 'claude-sonnet-4-5'

      // Resolve default/primary prometheus datasource (isDefault first, then first match)
      const promDatasources = config.datasources.filter((d) => d.type === 'prometheus' || d.type === 'victoria-metrics')
      const prom = promDatasources.find((d) => d.isDefault) ?? promDatasources[0]
      const prometheusUrl = prom?.url
      const prometheusHeaders: Record<string, string> = {}
      if (prom?.username && prom?.password) {
        prometheusHeaders.Authorization = `Basic ${Buffer.from(`${prom.username}:${prom.password}`).toString('base64')}`
      }
      else if (prom?.apiKey) {
        prometheusHeaders.Authorization = `Bearer ${prom.apiKey}`
      }

      const orchestrator = new OrchestratorAgent({
        gateway,
        model,
        store,
        conversationStore,
        prometheusUrl,
        prometheusHeaders,
        allDatasources: config.datasources,
        sendEvent: (event) => { if (!closed) sendEvent(res, event) },
      })

      console.log(`[ChatHandler] Starting orchestrator for dashboard=${dashboardId} message="${message.slice(0, 80)}"`)
      const replyContent = await orchestrator.handleMessage(dashboardId, message)
      console.log(`[ChatHandler] Orchestrator done. Reply="${replyContent.slice(0, 100)}"`)

      // Save assistant message
      const assistantMessageId = randomUUID()
      conversationStore.addMessage(dashboardId, {
        id: assistantMessageId,
        role: 'assistant',
        content: replyContent,
        timestamp: new Date().toISOString(),
      })

      if (closed)
        return

      sendEvent(res, { type: 'done', messageId: assistantMessageId })
    })
  }
  catch (err) {
    console.error('[ChatHandler] Error:', err)
    const errMsg = err instanceof Error ? err.message : 'Internal error'
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', message: errMsg })}\n\n`)
  }
  finally {
    clearInterval(heartbeat)
    res.end()
  }
}
