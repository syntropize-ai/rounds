/**
 * RiskAwareConfirm tests.
 *
 * The web package runs vitest under `environment: 'node'` (no jsdom), so
 * interaction is asserted by:
 *   1. Pure-logic helpers (`pickWording`, `requiredFriction`) cover every
 *      (mode, risk) pair.
 *   2. `renderToStaticMarkup` snapshots assert the right friction widgets
 *      (checkbox / type-name input / countdown notice) appear at each
 *      risk level on first render.
 *   3. Wording assertions confirm user_confirm vs formal_approval verbs.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import RiskAwareConfirm, {
  pickWording,
  requiredFriction,
} from '../RiskAwareConfirm.js';

describe('pickWording', () => {
  it('uses Approve/Reject for formal_approval regardless of risk', () => {
    for (const r of ['low', 'medium', 'high', 'critical'] as const) {
      const w = pickWording('formal_approval', r);
      expect(w.confirm).toBe('Approve');
      expect(w.cancel).toBe('Reject');
      expect(w.modifyExtra).toBe('Modify');
    }
  });

  it('uses Run / Confirm / Apply for user_confirm at low / medium / high+', () => {
    expect(pickWording('user_confirm', 'low').confirm).toBe('Run');
    expect(pickWording('user_confirm', 'medium').confirm).toBe('Confirm');
    expect(pickWording('user_confirm', 'high').confirm).toBe('Apply');
    expect(pickWording('strong_user_confirm', 'critical').confirm).toBe('Apply');
  });

  it('uses Cancel (not Reject) for user-driven modes', () => {
    expect(pickWording('user_confirm', 'low').cancel).toBe('Cancel');
    expect(pickWording('strong_user_confirm', 'high').cancel).toBe('Cancel');
  });
});

describe('requiredFriction', () => {
  it('low: no friction', () => {
    expect(requiredFriction('low')).toEqual({
      understandCheckbox: false,
      typeResourceName: false,
      showDryRun: false,
      countdownSeconds: 0,
    });
  });
  it('medium: I-understand checkbox only', () => {
    const f = requiredFriction('medium');
    expect(f.understandCheckbox).toBe(true);
    expect(f.typeResourceName).toBe(false);
    expect(f.countdownSeconds).toBe(0);
  });
  it('high: type resource name + dry-run, no countdown', () => {
    const f = requiredFriction('high');
    expect(f.typeResourceName).toBe(true);
    expect(f.showDryRun).toBe(true);
    expect(f.countdownSeconds).toBe(0);
  });
  it('critical: type resource name + dry-run + 30s countdown', () => {
    const f = requiredFriction('critical');
    expect(f.typeResourceName).toBe(true);
    expect(f.showDryRun).toBe(true);
    expect(f.countdownSeconds).toBe(30);
  });
});

function render(props: Partial<React.ComponentProps<typeof RiskAwareConfirm>> = {}) {
  return renderToStaticMarkup(
    React.createElement(RiskAwareConfirm, {
      risk: 'low',
      mode: 'user_confirm',
      onConfirm: () => {},
      onCancel: () => {},
      ...props,
    }),
  );
}

describe('RiskAwareConfirm rendering', () => {
  it('low risk user_confirm: single Run button, no friction widgets', () => {
    const html = render({ risk: 'low', mode: 'user_confirm' });
    expect(html).toContain('Run');
    expect(html).toContain('Cancel');
    expect(html).not.toContain('rac-understand');
    expect(html).not.toContain('rac-type-name');
    expect(html).not.toContain('rac-countdown');
  });

  it('medium risk user_confirm: shows I-understand checkbox', () => {
    const html = render({ risk: 'medium', mode: 'user_confirm' });
    expect(html).toContain('rac-understand');
    expect(html).toContain('Confirm');
    expect(html).not.toContain('rac-type-name');
  });

  it('high risk user_conversation: shows type-resource-name and dry-run slot', () => {
    const html = render({
      risk: 'high',
      mode: 'strong_user_confirm',
      resourceName: 'payments-api',
      dryRun: React.createElement('pre', null, 'kubectl scale … --replicas=4'),
    });
    expect(html).toContain('rac-type-name');
    expect(html).toContain('payments-api');
    expect(html).toContain('Dry-run / diff');
    expect(html).toContain('kubectl scale');
    expect(html).toContain('Apply');
  });

  it('critical risk: shows countdown notice and type-name field', () => {
    const html = render({
      risk: 'critical',
      mode: 'strong_user_confirm',
      resourceName: 'prod-db',
    });
    expect(html).toContain('rac-countdown');
    expect(html).toContain('rac-type-name');
    // Confirm button is rendered but should be disabled at first render
    // (countdown not elapsed). renderToStaticMarkup keeps `disabled`.
    expect(html).toMatch(/data-testid="rac-confirm"[^>]*disabled/);
  });

  it('formal_approval mode: uses Approve/Reject and renders Modify button when onModify supplied', () => {
    const html = render({
      risk: 'high',
      mode: 'formal_approval',
      resourceName: 'payments-api',
      onModify: () => {},
      approvalContext: React.createElement(
        'div',
        null,
        'Owner: payments-team / On-call: alice',
      ),
    });
    expect(html).toContain('Approve');
    // formal_approval cancel verb is "Reject", not "Cancel"
    expect(html).toContain('Reject');
    expect(html).toContain('rac-modify');
    expect(html).toContain('Owner: payments-team');
  });

  it('formal_approval without onModify: omits Modify button', () => {
    const html = render({ risk: 'low', mode: 'formal_approval' });
    expect(html).not.toContain('rac-modify');
  });
});
