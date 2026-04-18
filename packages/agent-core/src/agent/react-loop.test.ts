import { describe, it, expect, vi } from 'vitest'
import { ReActLoop } from './react-loop.js'
import { AccessControlStub, makeTestIdentity } from './test-helpers.js'

describe('ReActLoop', () => {
  it('emits a reply event when the model returns a final reply message', async () => {
    const sendEvent = vi.fn()
    const gateway = {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          thought: 'done',
          message: 'I updated the p95 panel to use a stat visualization.',
          action: 'reply',
          args: {},
        }),
      }),
    } as any

    const loop = new ReActLoop({
      gateway,
      model: 'test-model',
      sendEvent,
      identity: makeTestIdentity(),
      accessControl: new AccessControlStub(),
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

  it('stops after the first successful mutation and emits a final reply', async () => {
    const sendEvent = vi.fn()
    const gateway = {
      complete: vi.fn()
        .mockResolvedValueOnce({
          content: JSON.stringify({
            thought: 'edit the panel',
            message: 'I’ll split that merged panel back into separate views.',
            action: 'modify_panel',
            args: { panelId: 'panel-1', patch: {} },
          }),
        })
        .mockResolvedValueOnce({
          content: 'I split the merged panel back into separate panels.',
        }),
    } as any

    const executeAction = vi.fn().mockResolvedValue('Split the merged panel into separate p95 and p99 panels.')

    const loop = new ReActLoop({
      gateway,
      model: 'test-model',
      sendEvent,
      identity: makeTestIdentity(),
      accessControl: new AccessControlStub(),
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
})
