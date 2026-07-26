/**
 * The verdict banner's job is to change what a reader does next, so these
 * pin the two things that would quietly undo that: showing nothing, and
 * showing "not verified" as if it were a failure.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Provenance } from '@agentic-obs/common';
import RootCauseVerdict from './RootCauseVerdict.js';

const render = (provenance: Provenance) =>
  renderToStaticMarkup(<RootCauseVerdict provenance={provenance} />);

const passed: Provenance = {
  rootCauseGate: {
    status: 'passed',
    reasons: [],
    rootCause: { status: 'confirmed', object: 'deployment/reviews-v2', cause: 'a mesh rule delays its calls' },
    confidence: 0.9,
    evidenceRefs: ['check_1', 'check_2'],
    ruledOut: ['ratings latency'],
    validationMethod: 'watch p95 return to baseline',
    evaluatedAt: '2026-07-26T00:00:00.000Z',
  },
};

const downgraded: Provenance = {
  rootCauseGate: {
    status: 'unresolved',
    reasons: [
      'at least one competing explanation must be recorded as ruled_out',
      'referenced evidence must include at least two independent signal types from metrics, logs, Kubernetes state or change events',
    ],
    rootCause: { status: 'likely', object: 'reviews-v2', nextCheck: 'check the mesh routing config for reviews' },
    confidence: 0.7,
    evidenceRefs: ['check_1'],
    ruledOut: [],
    evaluatedAt: '2026-07-26T00:00:00.000Z',
  },
};

describe('RootCauseVerdict', () => {
  it('says the cause was verified, and names it', () => {
    const html = render(passed);
    expect(html).toContain('Root cause verified');
    expect(html).toContain('deployment/reviews-v2');
    // The reader's next action when it *is* verified.
    expect(html).toContain('watch p95 return to baseline');
  });

  it('translates the gate reasons instead of dumping internal rules', () => {
    // Rendering "referenced evidence must include at least two independent
    // signal types" verbatim next to a confident summary reads as the report
    // arguing with itself.
    const html = render(downgraded);
    expect(html).not.toContain('evidenceRefs');
    expect(html).not.toContain('ruled_out');
    expect(html).toContain('did not rule out other explanations');
    expect(html).toContain('the same kind of data');
  });

  it('gives the reader the next check', () => {
    expect(render(downgraded)).toContain('check the mesh routing config for reviews');
  });

  it('does not present an unverified conclusion as an error', () => {
    // The gate withholding a verdict is the product working. Styled as a
    // failure, people learn to read past the honest state — and the honest
    // state is the whole differentiator.
    const html = render(downgraded);
    expect(html).not.toMatch(/text-error|bg-error|text-warning|bg-warning/);
    expect(html.toLowerCase()).not.toContain('failed');
    expect(html.toLowerCase()).not.toContain('error');
  });

  it('says something useful when the agent simply declined to conclude', () => {
    // No reasons at all: the agent reported unresolved itself rather than
    // being downgraded. "Here is what is missing:" followed by an empty list
    // reads as a bug.
    const html = render({
      rootCauseGate: { ...downgraded.rootCauseGate!, reasons: [], rootCause: { status: 'unresolved' } },
    });
    expect(html).toContain('did not reach a conclusion');
    expect(html).not.toContain('Still to check');
  });

  it('renders nothing for a report saved before the gate existed', () => {
    expect(render({ model: 'claude-opus-4-8', toolCalls: 12 })).toBe('');
  });
});
