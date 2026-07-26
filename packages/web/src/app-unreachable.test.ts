/**
 * A backend that never answered must not be read as "setup is finished".
 *
 * Reproduced on a fresh install with the API process down: `/setup/status`
 * failed, the first-run check fell through, and the auth gate sent the user to
 * a sign-in form. Someone whose backend failed to start sees a login page and
 * types credentials into something that cannot ever succeed, with nothing on
 * screen naming the real problem.
 *
 * The 502 cases are here because the first version of this check was wrong in
 * exactly the way that only running it reveals: almost nobody reaches the API
 * directly, and a proxy in front of a dead backend answers rather than
 * dropping the connection.
 *
 * The direction matters both ways — blocking on too much would put a "can't
 * reach the API" wall in front of people whose API is answering fine.
 */

import { describe, it, expect } from 'vitest';
import { isUnreachable, unreachableDetail } from './App.js';

describe('isUnreachable', () => {
  it('blocks when nothing answered at all', () => {
    expect(isUnreachable({ code: 'NETWORK_ERROR' })).toBe(true);
    expect(isUnreachable({ code: 'REQUEST_TIMEOUT' })).toBe(true);
  });

  it('blocks when a proxy answered on behalf of a backend that did not', () => {
    // The realistic shape: Vite in development, an ingress in Kubernetes.
    // Checking only the transport's codes missed every one of these.
    for (const status of [502, 503, 504]) {
      expect(isUnreachable({ code: 'UNKNOWN', status }), String(status)).toBe(true);
    }
  });

  it('does not block on a 500, which means the app is running and threw', () => {
    // Saying "unreachable" here sends someone to check whether the process is
    // up, when the process is up and the bug is inside it.
    expect(isUnreachable({ code: 'UNKNOWN', status: 500 })).toBe(false);
  });

  it('does not block on an answer, however unwelcome', () => {
    for (const [code, status] of [
      ['UNAUTHORIZED', 401], ['FORBIDDEN', 403], ['NOT_FOUND', 404], ['VALIDATION', 400],
    ] as const) {
      expect(isUnreachable({ code, status }), code).toBe(false);
    }
  });
});

describe('unreachableDetail', () => {
  it('replaces a proxy status line with something actionable', () => {
    // The message on a 502 is `res.statusText` — "Bad Gateway" — which names
    // the messenger rather than the problem.
    const msg = unreachableDetail({ code: 'UNKNOWN', status: 502, message: 'Bad Gateway' });
    expect(msg).not.toContain('Bad Gateway');
    expect(msg).toContain('API process');
  });

  it('keeps the transport wording when the transport is the one that knows', () => {
    // "Cannot reach the Rounds API. Check that the API server is running."
    const message = 'Cannot reach the Rounds API. Check that the API server is running.';
    expect(unreachableDetail({ code: 'NETWORK_ERROR', message })).toBe(message);
  });
});
