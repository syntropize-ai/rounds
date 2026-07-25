/**
 * The SMTP password must be masked like every other secret on this screen.
 * No jsdom in the web package, so the markup is asserted via
 * renderToStaticMarkup (same pattern as AlertRuleEdit.test.tsx).
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StepNotifications } from './StepNotifications.js';

describe('StepNotifications secret fields', () => {
  it('masks the SMTP password', () => {
    const html = renderToStaticMarkup(
      <StepNotifications
        config={{
          slackWebhook: '',
          pagerDutyKey: 'pd-key',
          emailHost: 'smtp.example.com',
          emailPort: '587',
          emailUser: 'ops',
          emailPass: 'sup3r-secret',
          emailFrom: 'ops@example.com',
        }}
        onChange={() => undefined}
        onNext={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect(html).not.toMatch(/<input type="text"[^>]*value="sup3r-secret"/);
    expect(html).toMatch(/<input type="password"[^>]*value="sup3r-secret"/);
  });
});
