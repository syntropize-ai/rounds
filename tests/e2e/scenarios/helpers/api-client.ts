/**
 * Minimal fetch wrapper for e2e scenarios.
 *
 * Reads the service-account token cached by `tests/e2e/lib/seed.sh` once
 * at module load. Every scenario imports `apiGet/apiPost/...` from here
 * and never deals with auth headers directly.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(HERE, '..', '..', '.state');

export const BASE_URL =
  process.env['OPENOBS_TEST_BASE_URL'] ?? 'http://127.0.0.1:3000';

function loadToken(): string {
  try {
    const t = readFileSync(resolve(STATE_DIR, 'sa-token'), 'utf8').trim();
    if (!t) throw new Error('empty');
    return t;
  } catch (err) {
    throw new Error(
      `tests/e2e/.state/sa-token missing or empty — did seed.sh run? (${
        (err as Error).message
      })`,
    );
  }
}

const TOKEN = loadToken();

export class ApiError extends Error {
  constructor(
    public method: string,
    public path: string,
    public status: number,
    public bodyExcerpt: string,
  ) {
    super(`${method} ${path} -> ${status}: ${bodyExcerpt}`);
    this.name = 'ApiError';
  }
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(`${BASE_URL}${path}`, init);
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(method, path, res.status, text.slice(0, 500));
  }
  if (text.length === 0) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export const apiGet = <T>(path: string) => call<T>('GET', path);
export const apiPost = <T>(path: string, body?: unknown) =>
  call<T>('POST', path, body);
export const apiPut = <T>(path: string, body?: unknown) =>
  call<T>('PUT', path, body);
export const apiDelete = <T = void>(path: string) => call<T>('DELETE', path);
