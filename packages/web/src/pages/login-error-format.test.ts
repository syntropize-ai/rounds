/**
 * Unit tests for the Login page's error-message formatter.
 *
 * Verifies the design doc's operator-facing copy for each error class
 * (09-frontend.md §T8.1 → error handling).
 */

import { describe, it, expect } from 'vitest';
import { formatLoginError } from './Login.js';
import { AuthApiError } from '../api/client.js';

describe('formatLoginError', () => {
  it('maps 401 to a generic "invalid credentials" message', () => {
    const err = new AuthApiError(401, 'invalid username or password');
    expect(formatLoginError(err)).toBe('Invalid email/username or password');
  });

  it('does not echo the raw server message on 401 — uses the safe generic', () => {
    const errUser = new AuthApiError(401, 'user not found');
    const errPw = new AuthApiError(401, 'wrong password');
    // Both server messages collapse to the same safe string, so the UI
    // cannot leak whether the username or password was wrong.
    expect(formatLoginError(errUser)).toBe('Invalid email/username or password');
    expect(formatLoginError(errPw)).toBe('Invalid email/username or password');
  });

  it('extracts the minutes value from a 429 rate-limit message', () => {
    const err = new AuthApiError(429, 'too many login attempts, retry in 5 minutes');
    expect(formatLoginError(err)).toBe('Too many attempts. Try again in 5 minutes.');
  });

  it('falls back to a generic rate-limit message when no minutes given', () => {
    const err = new AuthApiError(429, 'too many login attempts');
    expect(formatLoginError(err)).toBe('Too many attempts. Try again later.');
  });

  it('shows a retry-friendly message for 5xx responses', () => {
    const err = new AuthApiError(500, 'internal server error');
    expect(formatLoginError(err)).toBe('Unable to log in right now. Please retry.');
  });

  it('shows a retry-friendly message for 502/503', () => {
    expect(formatLoginError(new AuthApiError(502, 'bad gateway'))).toMatch(/retry/i);
    expect(formatLoginError(new AuthApiError(503, 'service unavailable'))).toMatch(/retry/i);
  });

  it('defaults to a generic message when the error is not an AuthApiError', () => {
    expect(formatLoginError(new Error('network boom'))).toBe(
      'Unable to log in right now. Please retry.',
    );
  });
});
