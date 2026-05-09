/**
 * StatusPill tests.
 *
 * Web package runs vitest with `environment: 'node'` (no jsdom). We use
 * `renderToStaticMarkup` to assert that the right token-driven Tailwind
 * classes are emitted for each (kind, value) pair, plus that unknown
 * values fall back to the neutral chip without throwing.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import StatusPill from '../StatusPill.js';

function html(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe('StatusPill — severity', () => {
  it('renders critical with the severity-critical token classes', () => {
    const out = html(<StatusPill kind="severity" value="critical" />);
    expect(out).toContain('bg-severity-critical/10');
    expect(out).toContain('text-severity-critical');
    expect(out).toContain('Critical');
    expect(out).toContain('data-status-kind="severity"');
    expect(out).toContain('data-status-value="critical"');
  });

  it('renders high with the severity-high token classes', () => {
    const out = html(<StatusPill kind="severity" value="high" />);
    expect(out).toContain('bg-severity-high/10');
    expect(out).toContain('text-severity-high');
  });

  it('renders info with the severity-info token classes', () => {
    const out = html(<StatusPill kind="severity" value="info" label="auto-edit" />);
    expect(out).toContain('bg-severity-info/10');
    expect(out).toContain('text-severity-info');
    expect(out).toContain('auto-edit');
  });
});

describe('StatusPill — state', () => {
  it('renders firing with the state-firing token classes', () => {
    const out = html(<StatusPill kind="state" value="firing" pulse />);
    expect(out).toContain('bg-state-firing/10');
    expect(out).toContain('text-state-firing');
    expect(out).toContain('animate-pulse');
  });

  it('renders pending with the state-pending token classes', () => {
    const out = html(<StatusPill kind="state" value="pending" />);
    expect(out).toContain('bg-state-pending/10');
    expect(out).toContain('text-state-pending');
  });

  it('renders resolved with the state-resolved token classes', () => {
    const out = html(<StatusPill kind="state" value="resolved" />);
    expect(out).toContain('bg-state-resolved/10');
    expect(out).toContain('text-state-resolved');
  });
});

describe('StatusPill — risk', () => {
  it('renders critical risk with the risk-critical token classes', () => {
    const out = html(<StatusPill kind="risk" value="critical" />);
    expect(out).toContain('bg-risk-critical/10');
    expect(out).toContain('text-risk-critical');
  });

  it('renders high risk with the risk-high token classes', () => {
    const out = html(<StatusPill kind="risk" value="high" />);
    expect(out).toContain('bg-risk-high/10');
    expect(out).toContain('text-risk-high');
  });

  it('renders low risk with the risk-low token classes', () => {
    const out = html(<StatusPill kind="risk" value="low" />);
    expect(out).toContain('bg-risk-low/10');
    expect(out).toContain('text-risk-low');
  });
});

describe('StatusPill — variants and fallbacks', () => {
  it('renders the dot variant with a leading colored dot', () => {
    const out = html(<StatusPill kind="state" value="firing" variant="dot" pulse />);
    expect(out).toContain('rounded-full');
    expect(out).toContain('animate-pulse');
    expect(out).toContain('text-state-firing');
  });

  it('falls back to a neutral chip for unknown enum values', () => {
    const out = html(<StatusPill kind="severity" value="zebra" />);
    expect(out).toContain('var(--color-surface-high)');
    expect(out).toContain('Zebra');
  });

  it('respects size=md sizing', () => {
    const out = html(<StatusPill kind="severity" value="medium" size="md" />);
    expect(out).toContain('px-2');
    expect(out).toContain('text-xs');
  });
});
