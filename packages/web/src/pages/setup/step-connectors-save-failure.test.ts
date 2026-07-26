/**
 * Setup must not report a connector as added when the server refused it.
 *
 * This is the first five minutes of the product, and the original failure was
 * invisible rather than ugly: `apiClient` reports HTTP errors by returning an
 * error instead of throwing, the handler ignored the result, and the row was
 * appended either way. A rejected connector rendered exactly like a working
 * one, "Continue" moved on, and the user finished setup believing Prometheus
 * was connected — finding out later on an empty dashboard, with no reason
 * given anywhere.
 *
 * The wording is tested alongside the behaviour because a correct-but-opaque
 * message ("VALIDATION: invalid config.url") leaves the user just as stuck.
 */

import { describe, it, expect } from 'vitest';
import { describeSaveFailure } from './StepConnectors.js';

describe('describeSaveFailure', () => {
  it('says the connector was not saved when the API is unreachable', () => {
    const msg = describeSaveFailure(
      { code: 'NETWORK_ERROR', message: 'Cannot reach the Rounds API. Check that the API server is running.' },
      false,
    );
    // The critical half: not just "something went wrong" but "it did not save".
    expect(msg).toContain('not saved');
    expect(msg).toContain('Check that the API server is running');
  });

  it('tells a user without permission who can fix it', () => {
    const msg = describeSaveFailure({ code: 'FORBIDDEN', message: 'forbidden' }, false);
    expect(msg).toContain('not allowed');
    expect(msg).toContain('administrator');
    // The raw message here carries nothing useful, so it is not echoed.
    expect(msg).not.toContain('forbidden');
  });

  it('names the actual conflict rather than the status', () => {
    expect(describeSaveFailure({ code: 'CONFLICT', message: 'duplicate' }, false))
      .toContain('already exists');
  });

  it('keeps the server detail on a validation failure', () => {
    // Here the raw message is the useful part — it names the bad field.
    expect(describeSaveFailure({ code: 'VALIDATION', message: 'config.url must be an absolute URL' }, false))
      .toContain('config.url must be an absolute URL');
  });

  it('never leads with an error code', () => {
    for (const code of ['NETWORK_ERROR', 'FORBIDDEN', 'CONFLICT', 'VALIDATION', 'WEIRD_UNSEEN_CODE']) {
      const msg = describeSaveFailure({ code, message: 'detail' }, false);
      expect(msg.startsWith(code), `${code} leaked into the first word`).toBe(false);
    }
  });

  it('says update rather than save when editing', () => {
    expect(describeSaveFailure({ code: 'FORBIDDEN', message: '' }, true)).toContain('update');
    expect(describeSaveFailure({ code: 'NETWORK_ERROR', message: '' }, true)).toContain('not updated');
  });
});
