/**
 * Skeleton tests.
 *
 * Web vitest config runs in `node` (no jsdom) so we render to static markup
 * and assert on token-driven Tailwind classes plus the variant data attribute.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Skeleton, { type SkeletonVariant } from '../Skeleton.js';

function html(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

const VARIANTS: SkeletonVariant[] = ['panel', 'report-section', 'step', 'row', 'card'];

describe('Skeleton', () => {
  for (const variant of VARIANTS) {
    it(`renders the ${variant} variant without crashing`, () => {
      const out = html(<Skeleton variant={variant} />);
      expect(out).toContain(`data-skeleton-variant="${variant}"`);
      expect(out).toContain('animate-pulse');
    });
  }

  it('uses surface tokens for placeholder fills', () => {
    const out = html(<Skeleton variant="panel" />);
    expect(out).toContain('bg-surface-1');
    expect(out).toContain('bg-surface-2');
  });

  it('forwards className to the root element', () => {
    const out = html(<Skeleton variant="row" className="my-4" />);
    expect(out).toContain('my-4');
  });
});
