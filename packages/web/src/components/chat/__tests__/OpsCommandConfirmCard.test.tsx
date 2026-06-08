import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import OpsCommandConfirmCard from '../OpsCommandConfirmCard.js';

describe('OpsCommandConfirmCard render', () => {
  it('renders the compact Codex-style action row with always-allow', () => {
    const html = renderToStaticMarkup(
      <OpsCommandConfirmCard
        confirmation={{
          id: 'confirm-1',
          connectorId: 'kube-local',
          capability: 'runtime.exec',
          command: 'kubectl exec -n default pod/foo -- ps aux',
          risk: 'high',
          summary: 'Run kubectl exec against pod/foo',
          expiresAt: '2026-06-07T00:00:00.000Z',
          status: 'pending',
        }}
      />,
    );

    expect(html).toContain('Run command?');
    expect(html).toContain('runtime.exec');
    expect(html).toContain('Always allow');
    expect(html).toContain('Cancel');
    expect(html).not.toContain('Yes, run');
    expect(html).not.toContain('No, cancel');
  });
});
