import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as dns from 'node:dns/promises'
import { ensureSafeUrl } from './url-validator.js'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}))

const lookup = vi.mocked(dns.lookup)

describe('ensureSafeUrl', () => {
  const originalNodeEnv = process.env['NODE_ENV']
  const originalAllowPrivateUrls = process.env['OPENOBS_ALLOW_PRIVATE_URLS']

  beforeEach(() => {
    process.env['NODE_ENV'] = 'production'
    delete process.env['OPENOBS_ALLOW_PRIVATE_URLS']
    lookup.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalNodeEnv === undefined) {
      delete process.env['NODE_ENV']
    } else {
      process.env['NODE_ENV'] = originalNodeEnv
    }
    if (originalAllowPrivateUrls === undefined) {
      delete process.env['OPENOBS_ALLOW_PRIVATE_URLS']
    } else {
      process.env['OPENOBS_ALLOW_PRIVATE_URLS'] = originalAllowPrivateUrls
    }
  })

  it('does not hang forever when strict-mode DNS lookup stalls', async () => {
    vi.useFakeTimers()
    lookup.mockImplementation(() => new Promise(() => {}) as ReturnType<typeof dns.lookup>)

    const promise = ensureSafeUrl('https://prometheus.demo.prometheus.io/')
    await vi.advanceTimersByTimeAsync(2_500)

    await expect(promise).resolves.toMatchObject({
      protocol: 'https:',
      hostname: 'prometheus.demo.prometheus.io',
    })
  })

  it('still blocks public hostnames that resolve to private addresses', async () => {
    lookup.mockResolvedValue({ address: '127.0.0.1', family: 4 })

    await expect(ensureSafeUrl('https://example.com/'))
      .rejects.toThrow('URL host resolves to a blocked (private/loopback) address')
  })
})
