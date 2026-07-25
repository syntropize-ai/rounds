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

  describe('default policy (OPENOBS_ALLOW_PRIVATE_URLS unset)', () => {
    beforeEach(() => {
      // A stock install sets neither knob.
      delete process.env['NODE_ENV']
    })

    const blocked = [
      'http://10.0.0.1:9090/',
      'http://172.16.0.1:9090/',
      'http://192.168.1.5:9090/',
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:9090/',
      'http://localhost:9090/',
      'http://0.0.0.0:9090/',
      'http://[::ffff:10.0.0.1]:9090/',
      'http://[::ffff:169.254.169.254]/',
      'http://[::ffff:127.0.0.1]:9090/',
      'http://[::ffff:a00:1]:9090/',
      'http://[0:0:0:0:0:ffff:10.0.0.1]:9090/',
      'http://[::10.0.0.1]:9090/',
      'http://[::1]:9090/',
      'http://[0:0:0:0:0:0:0:1]:9090/',
      'http://[fe80::1]:9090/',
      'http://[fd12:3456::1]:9090/',
    ]

    for (const url of blocked) {
      it(`blocks ${url}`, async () => {
        await expect(ensureSafeUrl(url))
          .rejects.toThrow('URL host is not allowed (private/loopback address)')
      })
    }

    it('leaves public addresses alone', async () => {
      lookup.mockResolvedValue({ address: '2606:4700:4700::1111', family: 6 })

      await expect(ensureSafeUrl('https://[2606:4700:4700::1111]/')).resolves.toMatchObject({
        hostname: '[2606:4700:4700::1111]',
      })
      await expect(ensureSafeUrl('http://8.8.8.8/')).resolves.toMatchObject({
        hostname: '8.8.8.8',
      })
    })

    it('blocks regardless of NODE_ENV', async () => {
      process.env['NODE_ENV'] = 'development'

      await expect(ensureSafeUrl('http://10.0.0.1:9090/'))
        .rejects.toThrow('URL host is not allowed (private/loopback address)')
    })
  })

  describe('opt-out (OPENOBS_ALLOW_PRIVATE_URLS=true)', () => {
    beforeEach(() => {
      process.env['OPENOBS_ALLOW_PRIVATE_URLS'] = 'true'
    })

    it('allows in-cluster and loopback targets', async () => {
      await expect(ensureSafeUrl('http://prometheus.monitoring:9090/')).resolves.toMatchObject({
        hostname: 'prometheus.monitoring',
      })
      await expect(ensureSafeUrl('http://10.0.0.1:9090/')).resolves.toMatchObject({
        hostname: '10.0.0.1',
      })
      await expect(ensureSafeUrl('http://localhost:9090/')).resolves.toMatchObject({
        hostname: 'localhost',
      })
      // `new URL` canonicalizes the mapped literal to its hex spelling.
      await expect(ensureSafeUrl('http://[::ffff:10.0.0.1]:9090/')).resolves.toMatchObject({
        hostname: '[::ffff:a00:1]',
      })
    })
  })
})
