/**
 * Visualization color palette, organized by hue.
 *
 * Each hue provides five shades, progressing from perceptually lightest
 * (`superLight`) through the canonical `base` tone to perceptually darkest
 * (`superDark`). Values were chosen by hand for balanced saturation and to
 * stay legible on the openobs dark surface (#1a1e2e) without appearing neon.
 *
 * Design notes:
 *  - `base` shades are the primary choice for series colors. They sit around
 *    the Tailwind 500 / Radix step-9 lightness range.
 *  - `light` / `superLight` are intended for hover fills, highlights, and
 *    sparkline areas layered over the base stroke.
 *  - `dark` / `superDark` are intended for axis labels on light mode, text on
 *    colored backgrounds, or muted past-value variants in sparklines.
 *  - Hues are evenly spaced around the color wheel where possible; `yellow`
 *    and `orange` are pulled slightly warmer for readability on dark.
 */
export type Hue =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'cyan';

export type Shade = 'superLight' | 'light' | 'base' | 'dark' | 'superDark';

export const PALETTE: Record<Hue, Record<Shade, string>> = {
  red: {
    superLight: '#fecaca',
    light: '#f87171',
    base: '#e5484d',
    dark: '#b42318',
    superDark: '#7a1414',
  },
  orange: {
    superLight: '#fed7aa',
    light: '#fb923c',
    base: '#f07934',
    dark: '#c2410c',
    superDark: '#7c2d12',
  },
  yellow: {
    superLight: '#fde68a',
    light: '#facc15',
    base: '#e2b007',
    dark: '#a16207',
    superDark: '#713f12',
  },
  green: {
    superLight: '#bbf7d0',
    light: '#4ade80',
    base: '#30a46c',
    dark: '#15803d',
    superDark: '#14532d',
  },
  blue: {
    superLight: '#bfdbfe',
    light: '#60a5fa',
    base: '#3e7bfa',
    dark: '#1d4ed8',
    superDark: '#1e3a8a',
  },
  purple: {
    superLight: '#ddd6fe',
    light: '#a78bfa',
    base: '#8e4ec6',
    dark: '#6d28d9',
    superDark: '#3b0764',
  },
  pink: {
    superLight: '#fbcfe8',
    light: '#f472b6',
    base: '#d6409f',
    dark: '#9d174d',
    superDark: '#500724',
  },
  cyan: {
    superLight: '#a5f3fc',
    light: '#22d3ee',
    base: '#05a2c2',
    dark: '#0e7490',
    superDark: '#164e63',
  },
};
