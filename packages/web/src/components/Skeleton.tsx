import React from 'react';

/**
 * Skeleton renders a structural placeholder for first-screen loading states.
 *
 * Each variant is sized to roughly match the post-load content shape so the
 * layout doesn't shift when data arrives. Variants stay deliberately
 * coarse — the goal is "the page is loading, here's where things will be",
 * not pixel-accurate stand-ins.
 *
 * Colors come from the surface tokens defined in `index.css`
 * (`bg-surface-1`, `bg-surface-2`) and shimmer with `animate-pulse`.
 */

export type SkeletonVariant = 'panel' | 'report-section' | 'step' | 'row' | 'card';

interface SkeletonProps {
  variant: SkeletonVariant;
  className?: string;
}

export default function Skeleton({ variant, className = '' }: SkeletonProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      data-skeleton-variant={variant}
      className={`animate-pulse ${className}`}
    >
      {renderVariant(variant)}
    </div>
  );
}

function renderVariant(variant: SkeletonVariant): React.ReactElement {
  switch (variant) {
    case 'panel':
      return (
        <div className="rounded border border-outline-variant bg-surface-1 shadow-elev-1 p-4">
          <div className="h-4 w-1/3 rounded bg-surface-2 mb-3" />
          <div className="h-32 rounded bg-surface-2" />
        </div>
      );
    case 'report-section':
      return (
        <div className="rounded border border-outline-variant bg-surface-1 shadow-elev-1 p-5">
          <div className="h-5 w-1/4 rounded bg-surface-2 mb-3" />
          <div className="space-y-2">
            <div className="h-3 w-full rounded bg-surface-2" />
            <div className="h-3 w-11/12 rounded bg-surface-2" />
            <div className="h-3 w-3/4 rounded bg-surface-2" />
          </div>
        </div>
      );
    case 'step':
      return (
        <div className="flex items-start gap-3 px-4 py-3 border-b border-outline-variant">
          <div className="h-6 w-6 rounded-full bg-surface-2 shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-2/5 rounded bg-surface-2" />
            <div className="h-3 w-3/4 rounded bg-surface-2" />
          </div>
        </div>
      );
    case 'row':
      return (
        <div className="flex items-center gap-3 px-4 py-3 border border-outline-variant bg-surface-2">
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-1/2 rounded bg-surface-1" />
            <div className="h-2.5 w-1/3 rounded bg-surface-1" />
          </div>
          <div className="h-3 w-16 rounded bg-surface-1" />
        </div>
      );
    case 'card':
      return (
        <div className="rounded border border-outline-variant bg-surface-2 p-4 shadow-elev-1">
          <div className="flex items-start gap-3">
            <div className="h-7 w-7 rounded-lg bg-surface-1 shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-3/4 rounded bg-surface-1" />
              <div className="h-3 w-1/2 rounded bg-surface-1" />
              <div className="h-3 w-5/6 rounded bg-surface-1" />
            </div>
          </div>
        </div>
      );
  }
}
