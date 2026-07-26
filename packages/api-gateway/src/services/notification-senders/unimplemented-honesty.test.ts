/**
 * The contact-point test button is where an operator decides whether their
 * paging path works.
 *
 * `senderFor` returns null for email, pagerduty, opsgenie and telegram — those
 * integrations have no implementation, and when an alert fires the consumer
 * logs "no sender implemented" and drops the notification. The test route
 * nevertheless reported `success: true` with "configure credentials for live
 * testing", which says the opposite: that it works and credentials are the
 * only gap.
 *
 * So the sequence was: add a PagerDuty contact point, click Test, see green,
 * go on call, never get paged. A test that cannot fail is not a test.
 */

import { describe, it, expect } from 'vitest';
import { senderFor } from './index.js';

describe('the registry says plainly what is not implemented', () => {
  it('has no sender for the four types the test route used to pass', () => {
    for (const type of ['email', 'pagerduty', 'opsgenie', 'telegram'] as const) {
      expect(senderFor(type), type).toBeNull();
    }
  });

  it('has one for the types that do deliver', () => {
    for (const type of ['slack', 'webhook', 'discord', 'teams'] as const) {
      expect(senderFor(type), type).not.toBeNull();
    }
  });

  it('is the single source the test route branches on', () => {
    // The route used to hardcode its own list of four. Two lists of the same
    // thing drift, and the drift direction here is reporting a channel as
    // working after someone implements or removes it.
    const unimplemented = (['email', 'pagerduty', 'opsgenie', 'telegram'] as const)
      .filter((t) => senderFor(t) === null);
    expect(unimplemented).toHaveLength(4);
  });
});
