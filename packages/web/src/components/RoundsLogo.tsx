import React from 'react';

/**
 * Triple Rounds brand mark — 2-ring variant.
 *
 * Outer + inner concentric 270° arcs + critical-red center dot. Rings inherit
 * `currentColor` so the parent's text colour (typically `text-on-surface`)
 * drives light/dark theming automatically; the dot stays severity-critical
 * red (#EF4444).
 *
 * When `animated` is true, each ring rotates independently around the
 * geometric centre (32, 32) — outer CW slow, inner CCW fast — and the
 * centre dot pulses. Rotating the whole SVG via a parent CSS class would
 * only spin both rings rigidly in the same direction, which is why the
 * animation lives inside the SVG via SMIL `<animateTransform>`.
 */
export function RoundsLogo({
  className = '',
  size = 28,
  animated = false,
}: {
  className?: string;
  size?: number;
  animated?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      strokeLinecap="round"
      className={className}
    >
      <path
        d="M 18 7.75 A 28 28 0 1 1 7.75 46"
        stroke="currentColor"
        strokeWidth="7.8"
      >
        {animated && (
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 32 32"
            to="360 32 32"
            dur="3.2s"
            repeatCount="indefinite"
          />
        )}
      </path>
      <path
        d="M 45 32 A 13 13 0 1 1 32 19"
        stroke="currentColor"
        strokeWidth="7.8"
      >
        {animated && (
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="360 32 32"
            to="0 32 32"
            dur="2.4s"
            repeatCount="indefinite"
          />
        )}
      </path>
      <circle cx="32" cy="32" r="5" fill="#EF4444">
        {animated && (
          <animate
            attributeName="opacity"
            values="1;0.55;1"
            dur="1.6s"
            repeatCount="indefinite"
          />
        )}
      </circle>
    </svg>
  );
}
