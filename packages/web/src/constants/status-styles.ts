/**
 * Shared investigation-status styles. Previously duplicated across
 * Investigations.tsx, Evidence.tsx, and InvestigationDetail.tsx with subtly
 * different shapes. Exported as three views (badge, dot, label) over the same
 * canonical key set so pages can pick whichever shape they need.
 */

export interface InvestigationStatusStyle {
  /** Tailwind background class for a status pill/badge. */
  bg: string;
  /** Tailwind text-color class matching `bg`. */
  text: string;
  /** Tailwind background class for a solid dot indicator. */
  dot: string;
  /** Short human label for list rows. */
  label: string;
  /** Longer human description used on the detail page while processing. */
  description: string;
}

export const INVESTIGATION_STATUS_STYLES: Record<string, InvestigationStatusStyle> = {
  pending: {
    bg: 'bg-slate-500/15',
    text: 'text-slate-400',
    dot: 'bg-slate-400',
    label: 'Pending',
    description: 'Waiting to start...',
  },
  planning: {
    bg: 'bg-blue-500/15',
    text: 'text-blue-400',
    dot: 'bg-blue-400',
    label: 'Planning',
    description: 'Planning investigation steps...',
  },
  investigating: {
    bg: 'bg-amber-500/15',
    text: 'text-amber-400',
    dot: 'bg-amber-400',
    label: 'Investigating',
    description: 'Querying data sources...',
  },
  evidencing: {
    bg: 'bg-amber-500/15',
    text: 'text-amber-400',
    dot: 'bg-violet-400',
    label: 'Collecting Evidence',
    description: 'Collecting evidence...',
  },
  explaining: {
    bg: 'bg-purple-500/15',
    text: 'text-purple-400',
    dot: 'bg-teal-400',
    label: 'Analyzing',
    description: 'Analyzing findings...',
  },
  acting: {
    bg: 'bg-purple-500/15',
    text: 'text-purple-400',
    dot: 'bg-purple-400',
    label: 'Acting',
    description: 'Determining actions...',
  },
  verifying: {
    bg: 'bg-cyan-500/15',
    text: 'text-cyan-400',
    dot: 'bg-cyan-400',
    label: 'Verifying',
    description: 'Verifying results...',
  },
  completed: {
    bg: 'bg-slate-500/15',
    text: 'text-slate-500',
    dot: 'bg-slate-500',
    label: 'Completed',
    description: 'Investigation complete',
  },
  failed: {
    bg: 'bg-red-500/15',
    text: 'text-red-400',
    dot: 'bg-red-500',
    label: 'Failed',
    description: 'Investigation failed',
  },
};

export const DEFAULT_INVESTIGATION_STATUS: InvestigationStatusStyle =
  INVESTIGATION_STATUS_STYLES['planning']!;

export function getInvestigationStatusStyle(status: string): InvestigationStatusStyle {
  return INVESTIGATION_STATUS_STYLES[status] ?? DEFAULT_INVESTIGATION_STATUS;
}
