import { describe, it, expect, vi } from 'vitest'
import { ReActLoop } from './react-loop.js'
import { AccessControlStub, makeTestIdentity } from './test-helpers.js'

const ALLOWED_TOOLS = [
  'ask_user',
  'tool_search',
  'dashboard_modify_panel',
  'metrics_query',
] as const

describe('ReActLoop', () => {
  it('emits a reply event when the model returns a final reply as plain text (no tool call)', async () => {
    const sendEvent = vi.fn()
    const gateway = {
      complete: vi.fn().mockResolvedValue({
        content: 'I updated the p95 panel to use a stat visualization.',
        toolCalls: [],
      }),
    } as any

    const loop = new ReActLoop({
      gateway,
      model: 'test-model',
      sendEvent,
      identity: makeTestIdentity(),
      accessControl: new AccessControlStub(),
      allowedTools: ALLOWED_TOOLS,
    })

    const result = await loop.runLoop(
      'system prompt',
      'make p95 a stat panel',
      vi.fn(),
    )

    expect(result).toBe('I updated the p95 panel to use a stat visualization.')
    expect(sendEvent).toHaveBeenCalledWith({
      type: 'reply',
      content: 'I updated the p95 panel to use a stat visualization.',
    })
  })

  it('stops after the first successful mutation and emits a final reply (text-only second turn)', async () => {
    const sendEvent = vi.fn()
    const gateway = {
      complete: vi.fn()
        .mockResolvedValueOnce({
          content: 'I’ll split that merged panel back into separate views.',
          toolCalls: [
            {
              id: 'call_1',
              name: 'dashboard_modify_panel',
              input: { dashboardId: 'd1', panelId: 'panel-1', patch: {} },
            },
          ],
        })
        // Second turn: model returns plain text with no tool call — the loop
        // treats it as a final reply.
        .mockResolvedValueOnce({
          content: 'I split the merged panel back into separate panels.',
          toolCalls: [],
        }),
    } as any

    const executeAction = vi.fn().mockResolvedValue('Split the merged panel into separate p95 and p99 panels.')

    const loop = new ReActLoop({
      gateway,
      model: 'test-model',
      sendEvent,
      identity: makeTestIdentity(),
      accessControl: new AccessControlStub(),
      allowedTools: ALLOWED_TOOLS,
    })

    const result = await loop.runLoop(
      'system prompt',
      'actually split them back apart',
      executeAction,
    )

    expect(executeAction).toHaveBeenCalledTimes(1)
    expect(gateway.complete).toHaveBeenCalledTimes(2)
    expect(result).toBe('I split the merged panel back into separate panels.')
    expect(sendEvent).toHaveBeenCalledWith({
      type: 'reply',
      content: 'I split the merged panel back into separate panels.',
    })
  })

  it('emits an ask_user event when ask_user carries an options array', async () => {
    const sendEvent = vi.fn()
    const gateway = {
      complete: vi.fn().mockResolvedValue({
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'ask_user',
            input: {
              question: 'Which connector?',
              options: [
                { id: 'prom-prod', label: 'Prometheus prod', hint: 'cluster=prod' },
                { id: 'prom-stg', label: 'Prometheus staging' },
              ],
            },
          },
        ],
      }),
    } as any

    const loop = new ReActLoop({
      gateway,
      model: 'test-model',
      sendEvent,
      identity: makeTestIdentity(),
      accessControl: new AccessControlStub(),
      allowedTools: ALLOWED_TOOLS,
    })

    await loop.runLoop('system', 'I have two prom connectors', vi.fn())

    expect(sendEvent).toHaveBeenCalledWith({
      type: 'ask_user',
      question: 'Which connector?',
      options: [
        { id: 'prom-prod', label: 'Prometheus prod', hint: 'cluster=prod' },
        { id: 'prom-stg', label: 'Prometheus staging' },
      ],
    })
    // Free-text reply event should NOT have been emitted on the structured path.
    expect(sendEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reply' }),
    )
  })

  it('falls back to a reply event when ask_user has no options (free-text)', async () => {
    const sendEvent = vi.fn()
    const gateway = {
      complete: vi.fn().mockResolvedValue({
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'ask_user',
            input: { question: 'What time range should I use?' },
          },
        ],
      }),
    } as any

    const loop = new ReActLoop({
      gateway,
      model: 'test-model',
      sendEvent,
      identity: makeTestIdentity(),
      accessControl: new AccessControlStub(),
      allowedTools: ALLOWED_TOOLS,
    })

    await loop.runLoop('system', 'help', vi.fn())

    expect(sendEvent).toHaveBeenCalledWith({
      type: 'reply',
      content: 'What time range should I use?',
    })
    expect(sendEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ask_user' }),
    )
  })

  it('returns a misconfiguration error when the model emits neither tool call nor text', async () => {
    const sendEvent = vi.fn()
    const gateway = {
      complete: vi.fn().mockResolvedValue({
        content: '',
        toolCalls: [],
      }),
    } as any

    const loop = new ReActLoop({
      gateway,
      model: 'test-model',
      sendEvent,
      identity: makeTestIdentity(),
      accessControl: new AccessControlStub(),
      allowedTools: ALLOWED_TOOLS,
    })

    const result = await loop.runLoop('system', 'hi', vi.fn())
    expect(result).toMatch(/no content and no tool call/i)
    expect(sendEvent).toHaveBeenCalledWith({
      type: 'error',
      message: expect.stringMatching(/no content and no tool call/i),
    })
  })

  it('intercepts tool_search inline and exposes the loaded deferred tool on the next turn', async () => {
    const sendEvent = vi.fn()
    const gateway = {
      complete: vi.fn()
        // Turn 1: model asks tool_search to load metrics_query.
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'tool_search',
              input: { query: 'select:metrics_query' },
            },
          ],
        })
        // Turn 2: ends with plain text.
        .mockResolvedValueOnce({
          content: 'Loaded the query tool, no further action needed.',
          toolCalls: [],
        }),
    } as any

    const loop = new ReActLoop({
      gateway,
      model: 'test-model',
      sendEvent,
      identity: makeTestIdentity(),
      accessControl: new AccessControlStub(),
      allowedTools: ALLOWED_TOOLS,
    })

    const result = await loop.runLoop('system', 'load metrics_query', vi.fn())

    expect(result).toBe('Loaded the query tool, no further action needed.')

    // First gateway call should NOT have metrics_query in tools (it's deferred).
    const firstToolNames = (gateway.complete.mock.calls[0]![1].tools as Array<{ name: string }>)
      .map((t) => t.name)
    expect(firstToolNames).toContain('tool_search')
    expect(firstToolNames).not.toContain('metrics_query')

    // Second gateway call should now include metrics_query (newly loaded).
    const secondToolNames = (gateway.complete.mock.calls[1]![1].tools as Array<{ name: string }>)
      .map((t) => t.name)
    expect(secondToolNames).toContain('metrics_query')
  })
})
