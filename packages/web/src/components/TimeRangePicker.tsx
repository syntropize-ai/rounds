import React from 'react';
import ReactDOM from 'react-dom';
import { QUICK_RANGES } from '../constants/time-ranges.js';

/**
 * TimeRangePicker — button + popover for picking a dashboard time range.
 *
 * Behavior changes from the previous version (driven by user pain reports):
 *   - The button label always reflects the actual range. For relative
 *     ranges it shows the human label ("Last 1 hour"). For absolute
 *     ranges it shows a compact `Apr 12 14:00 → 16:30` instead of the
 *     uninformative literal "Custom".
 *   - Apply is disabled (and shows a hint) when from >= to instead of
 *     silently no-op'ing.
 *   - Escape closes the popover. Click-outside still works.
 *   - Refresh is no longer mixed in here — it's `<RefreshControl/>`,
 *     which adds auto-refresh and last-updated readout.
 */
export default function TimeRangePicker({ value, onChange }: {
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  const browserTimeZone = React.useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Browser time',
    [],
  );
  const [open, setOpen] = React.useState(false);
  const [customFrom, setCustomFrom] = React.useState('');
  const [customTo, setCustomTo] = React.useState('');
  const popoverRef = React.useRef<HTMLDivElement>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const [pos, setPos] = React.useState({ top: 0, left: 0 });

  // Close on click-outside or Escape.
  React.useEffect(() => {
    if (!open) return;
    const onMouse = (e: MouseEvent) => {
      if (popoverRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    // stopPropagation so the popover consumes Escape — the global chat
    // shortcut listens on window and would otherwise stop a running agent.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouse);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Position the portal below the trigger button each time it opens.
  React.useEffect(() => {
    if (open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left });
    }
  }, [open]);

  // Sync the custom-range inputs from `value` when an absolute range is in
  // effect (e.g. opening the popover should pre-fill what's already chosen).
  React.useEffect(() => {
    if (!value.includes('|')) return;
    const [from, to] = value.split('|');
    setCustomFrom(formatForDateTimeLocal(from));
    setCustomTo(formatForDateTimeLocal(to));
  }, [value]);

  const displayLabel = formatRangeLabel(value);

  const customFromMs = customFrom ? new Date(customFrom).getTime() : NaN;
  const customToMs = customTo ? new Date(customTo).getTime() : NaN;
  const customValid =
    Number.isFinite(customFromMs) && Number.isFinite(customToMs) && customFromMs < customToMs;

  const applyCustom = () => {
    if (!customValid) return;
    onChange(`${new Date(customFromMs).toISOString()}|${new Date(customToMs).toISOString()}`);
    setOpen(false);
  };

  return (
    <div className="shrink-0">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 bg-surface-high text-on-surface text-xs rounded-lg px-3 py-1.5 hover:bg-surface-bright transition-colors"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={displayLabel}
      >
        <ClockIcon />
        <span className="truncate max-w-[260px]">{displayLabel}</span>
        <ChevronDownIcon />
      </button>

      {open && ReactDOM.createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          className="fixed bg-surface-highest rounded-xl shadow-2xl shadow-black/40 min-w-[280px] py-2"
          style={{ top: pos.top, left: pos.left, zIndex: 9999 }}
        >
          <p className="px-3 py-1 text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">
            Quick ranges
          </p>
          <div className="grid grid-cols-2 gap-0.5 px-2">
            {QUICK_RANGES.map((r) => (
              <button
                key={r.value}
                type="button"
                onClick={() => { onChange(r.value); setOpen(false); }}
                className={`text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                  value === r.value
                    ? 'bg-primary/15 text-primary'
                    : 'text-on-surface hover:bg-surface-bright'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          <div className="border-t border-outline-variant/20 mt-2 pt-2 px-3">
            <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider mb-2">
              Custom range
            </p>
            <p className="text-[10px] text-on-surface-variant mb-2">Timezone: {browserTimeZone}</p>
            <div className="space-y-2">
              <div>
                <label className="text-[10px] text-on-surface-variant mb-0.5 block">From</label>
                <input
                  type="datetime-local"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="w-full bg-surface-high text-on-surface text-xs rounded-lg px-2.5 py-1.5 border-none focus:ring-1 focus:ring-primary"
                  style={{ colorScheme: 'dark' }}
                />
              </div>
              <div>
                <label className="text-[10px] text-on-surface-variant mb-0.5 block">To</label>
                <input
                  type="datetime-local"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="w-full bg-surface-high text-on-surface text-xs rounded-lg px-2.5 py-1.5 border-none focus:ring-1 focus:ring-primary"
                  style={{ colorScheme: 'dark' }}
                />
              </div>
              {!customValid && (customFrom || customTo) && (
                <p className="text-[10px] text-error">From must be before To.</p>
              )}
              <button
                type="button"
                onClick={applyCustom}
                disabled={!customValid}
                className="w-full bg-primary text-on-primary-fixed text-xs font-semibold rounded-lg py-1.5 disabled:opacity-40 transition-colors"
              >
                Apply
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Label formatting
// ---------------------------------------------------------------------------

/**
 * Map a stored `value` to the label shown on the trigger button.
 *
 *   "1h"                              → "Last 1 hour"
 *   "<isoFrom>|<isoTo>" (same day)    → "Apr 12, 14:00 → 16:30"
 *   "<isoFrom>|<isoTo>" (cross-day)   → "Apr 12 14:00 → Apr 13 02:30"
 *
 * Anything else falls back to the literal `value` so an unrecognized
 * relative range still renders something rather than blank.
 */
function formatRangeLabel(value: string): string {
  const known = QUICK_RANGES.find((r) => r.value === value);
  if (known) return known.label;
  if (!value.includes('|')) return value;

  const [fromStr, toStr] = value.split('|');
  const from = fromStr ? new Date(fromStr) : null;
  const to = toStr ? new Date(toStr) : null;
  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return 'Custom';
  }

  const sameDay =
    from.getFullYear() === to.getFullYear() &&
    from.getMonth() === to.getMonth() &&
    from.getDate() === to.getDate();

  const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

  if (sameDay) {
    return `${dateFmt.format(from)}, ${timeFmt.format(from)} → ${timeFmt.format(to)}`;
  }
  return `${dateFmt.format(from)} ${timeFmt.format(from)} → ${dateFmt.format(to)} ${timeFmt.format(to)}`;
}

/**
 * Format an ISO timestamp for `<input type="datetime-local">`. The native
 * input wants `YYYY-MM-DDTHH:mm` in the user's local timezone; toISOString
 * is UTC and would silently shift the visible value.
 */
function formatForDateTimeLocal(raw: string | undefined): string {
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Inline icons (kept inline so the picker is one self-contained component).
// ---------------------------------------------------------------------------

function ClockIcon(): JSX.Element {
  return (
    <svg className="w-3.5 h-3.5 text-on-surface-variant" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function ChevronDownIcon(): JSX.Element {
  return (
    <svg className="w-3 h-3 text-on-surface-variant" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}
