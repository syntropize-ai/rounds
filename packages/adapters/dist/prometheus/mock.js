/**
 * Mock Prometheus HTTP API for use in tests.
 * Intercepts fetch calls and returns deterministic data.
 */
function defaultHandler(_path, params) {
    const query = params.get('query') ?? '';
    const isRange = params.has('start') && params.has('end') && params.has('step');

    if (isRange) {
        const startSec = parseFloat(params.get('start') ?? '0');
        const endSec = parseFloat(params.get('end') ?? '0');
        const stepSec = parseFloat(params.get('step') ?? '15');

        const values = [];
        for (let t = startSec; t <= endSec; t += stepSec) {
            values.push([t, '0.042']);
        }

        const matrixItem = {
            __name__: query.slice(0, 30),
            service: 'test-service'
        };
        return {
            status: 'success',
            data: { resultType: 'matrix', result: [{ ...matrixItem, values }] }
        };
    }

    const time = parseFloat(params.get('time') ?? String(Date.now() / 1000));
    const vectorItem = {
        __name__: query.slice(0, 30),
        service: 'test-service'
    };
    return {
        status: 'success',
        data: { resultType: 'vector', result: [{ ...vectorItem, value: [time, '1.23'] }] }
    };
}

export function createMockFetch(handler = defaultHandler) {
    return async (input, _init) => {
        const url = typeof input === 'string' ? new URL(input) : input;
        // Handle health/ready endpoints
        if (url.pathname === '/-/ready') {
            return new Response('Prometheus is Ready.\n', { status: 200 });
        }
        const result = handler(url.pathname, url.searchParams) ?? defaultHandler(url.pathname, url.searchParams);
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };
}

/**
 * Returns a mock fetch that always responds with a Prometheus error
 */
export function createErrorFetch(errorMsg) {
    const body = {
        status: 'error',
        data: { resultType: 'vector', result: [] },
        errorType: 'execution',
        error: errorMsg,
    };
    return async () => new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

//# sourceMappingURL=mock.js.map