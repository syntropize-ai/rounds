import { describe, it, expect, vi } from 'vitest'
import { ReActLoop } from './react-loop.js'
import { AccessControlStub, makeTestIdentity } from './test-helpers.js'

const ALLOWED_TOOLS = [
  'reply',
  'finish',
  'ask_user',
  'dashboard.modify_panel',
] as const

describe('ReActLoop', () => {
  it('emits a reply event when the model returns a final reply via the reply tool', async () => {
    const sendEvent = vi.fn()
    const gateway = {
      complete: vi.fn().mockResolvedValue({
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'reply',
            input: { message: 'I updated the p95 panel to use a stat visualization.' },
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
              name: 'dashboard.modify_panel',
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
})
