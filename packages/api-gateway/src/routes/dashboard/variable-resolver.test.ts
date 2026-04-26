import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardVariable } from '@agentic-obs/common'
import { DashboardVariableResolutionError, VariableResolver } from './variable-resolver.js'

function queryVariable(query: string): DashboardVariable {
  return {
    name: 'service',
    label: 'Service',
    type: 'query',
    query,
  }
}

function mockFetch(response: Partial<Response> & { json: () => Promise<unknown> }): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
}

describe('VariableResolver', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves Prometheus label_values from a successful response', async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: async () => ({ status: 'success', data: ['api', 'web', 'api'] }),
    })

    const resolver = new VariableResolver('http://prometheus:9090/')

    await expect(resolver.resolve(queryVariable('label_values(up, service)')))
      .resolves.toEqual(['api', 'web'])
    expect(fetch).toHaveBeenCalledWith(
      'http://prometheus:9090/api/v1/label/service/values?match%5B%5D=up',
      expect.any(Object),
    )
  })

  it('keeps an empty array for successful empty label_values results', async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: async () => ({ status: 'success', data: [] }),
    })

    const resolver = new VariableResolver('http://prometheus:9090')

    await expect(resolver.resolve(queryVariable('label_values(service)')))
      .resolves.toEqual([])
  })

  it('keeps an empty array for unsupported query syntax', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const resolver = new VariableResolver('http://prometheus:9090')

    await expect(resolver.resolve(queryVariable('query_result(up)')))
      .resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws a typed error when Prometheus returns an HTTP failure', async () => {
    mockFetch({
      ok: false,
      status: 503,
      json: async () => ({ status: 'error' }),
    })

    const resolver = new VariableResolver('http://prometheus:9090')

    await expect(resolver.resolve(queryVariable('label_values(up, service)')))
      .rejects.toBeInstanceOf(DashboardVariableResolutionError)
    await expect(resolver.resolve(queryVariable('label_values(up, service)')))
      .rejects.toMatchObject({
        code: 'DASHBOARD_VARIABLE_RESOLUTION_FAILED',
        statusCode: 424,
        message: 'Prometheus label_values request failed with HTTP 503',
      })
  })

  it('throws a typed error when the Prometheus request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')))
    const resolver = new VariableResolver('http://prometheus:9090')

    await expect(resolver.resolve(queryVariable('label_values(service)')))
      .rejects.toMatchObject({
        code: 'DASHBOARD_VARIABLE_RESOLUTION_FAILED',
        statusCode: 424,
        message: 'Prometheus label_values request failed: connection refused',
      })
  })
})
