import React from 'react';

/**
 * Rotating Rounds logo used as a "working" indicator under live agent
 * activity. The two arcs of the logo rotate around the red center dot
 * (similar to the Claude Code spinner) so the user can tell at a glance
 * that the model is still doing work.
 *
 * `currentColor` on the arc strokes lets callers tint via Tailwind text-*
 * classes. The red center dot is brand-fixed.
 */
export function RoundsSpinner({ className = 'w-3.5 h-3.5' }: { className?: string }): React.ReactElement {
  return (
    <svg
      className={`${className} animate-spin shrink-0`}
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M 18 7.75 A 28 28 0 1 1 7.75 46" strokeWidth="7.8" />
      <path d="M 45 32 A 13 13 0 1 1 32 19" strokeWidth="7.8" />
      <circle cx="32" cy="32" r="5" fill="#EF4444" stroke="none" />
    </svg>
  );
}

export default RoundsSpinner;
