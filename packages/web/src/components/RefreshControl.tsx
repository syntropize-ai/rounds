import React from 'react';
import ReactDOM from 'react-dom';
import { relativeTimeFromElapsed } from '../utils/time.js';

/**
 * RefreshControl — combined manual refresh + auto-refresh interval picker.
 *
 * Why this is its own component (split from TimeRangePicker):
 *   The previous design had a single refresh button glued onto the time-
 *   range picker. Users couldn't tell whether a click registered (no
 *   visual feedback once the spinner stopped) and there was no way to
 *   leave the dashboard auto-refreshing.
 *
 * What this gives:
 *   - Explicit "last refreshed" readout under the manual button (live
 *     "5s ago" / "just now") so a stale dashboard is visible.
 *   - Auto-refresh dropdown: Off / 5s / 10s / 30s / 1m / 5m. Choice
 *     persists per-browser via localStorage so reloading keeps the
 *     last picked interval (hot reload + cluster restart-friendly).
 *   - Spin animation on every fire — manual or auto — so motion feedback
 *     always confirms a refresh actually went out.
 *
 * The component owns its own interval timer and `lastRefreshAt` state.
 * The parent only supplies the refresh callback.
 */

const STORAGE_KEY = 'rounds.dashboard.autoRefreshMs';

interface RefreshOption { label: string; ms: number; }
const OPTIONS: readonly RefreshOption[] = [
  { label: 'Off', ms: 0 },
  { label: '5s', ms: 5_000 },
  { label: '10s', ms: 10_000 },
  { label: '30s', ms: 30_000 },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 300_000 },
];

export default function RefreshControl({ onRefresh }: { onRefresh: () => void }): JSX.Element {
  const [intervalMs, setIntervalMs] = React.useState<number>(() => readStoredInterval());
  const [lastRefreshAt, setLastRefreshAt] = React.useState<number>(() => Date.now());
  const [spinning, setSpinning] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const popoverRef = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState({ top: 0, left: 0 });

  // Keep onRefresh in a ref so the interval effect doesn't re-subscribe
  // every render. This used to fire double-refreshes when callers
  // re-bound the handler on each parent render.
  const onRefreshRef = React.useRef(onRefresh);
  React.useEffect(() => { onRefreshRef.current = onRefresh; }, [onRefresh]);

  const fire = React.useCallback(() => {
    setSpinning(true);
    onRefreshRef.current();
    setLastRefreshAt(Date.now());
    // Spinner runs ~600ms — long enough to register visually, short
    // enough not to feel laggy when auto-refresh is firing every 5s.
    window.setTimeout(() => setSpinning(false), 600);
  }, []);

  // Auto-refresh timer.
  React.useEffect(() => {
    if (intervalMs <= 0) return;
    const id = window.setInterval(fire, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, fire]);

  // Live "last refreshed" display: tick once a second so "just now"
  // becomes "5s ago" without re-firing the refresh.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Persist interval choice per-browser.
  React.useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(intervalMs));
    } catch {
      // SSR / quota — silently ignore; the in-memory value still works.
    }
  }, [intervalMs]);

  // Click-outside / Escape closes the popover.
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

  React.useEffect(() => {
    if (open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      // Align the popover's right edge with the trigger's right edge so
      // it doesn't overflow off the toolbar at narrow widths.
      setPos({ top: r.bottom + 4, left: r.right - 140 });
    }
  }, [open]);

  const lastLabel = relativeTimeFromElapsed(Date.now() - lastRefreshAt);
  const activeOption = OPTIONS.find((o) => o.ms === intervalMs) ?? OPTIONS[0]!;

  return (
    <div className="flex items-center gap-1 shrink-0">
      <button
        type="button"
        onClick={fire}
        className="p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-high transition-colors"
        title={`Refresh now — last refreshed ${lastLabel}`}
        aria-label={`Refresh dashboard. Last refreshed ${lastLabel}.`}
      >
        <RefreshIcon spinning={spinning} />
      </button>

      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 text-xs rounded-lg px-2 py-1.5 hover:bg-surface-high transition-colors ${
          intervalMs > 0 ? 'text-primary' : 'text-on-surface-variant'
        }`}
        title="Auto-refresh interval"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="font-medium">{activeOption.label}</span>
        <ChevronDownIcon />
      </button>

      {open && ReactDOM.createPortal(
        <div
          ref={popoverRef}
          role="menu"
          className="fixed bg-surface-highest rounded-xl shadow-2xl shadow-black/40 min-w-[140px] py-1"
          style={{ top: pos.top, left: pos.left, zIndex: 9999 }}
        >
          {OPTIONS.map((opt) => (
            <button
              key={opt.ms}
              type="button"
              role="menuitemradio"
              aria-checked={opt.ms === intervalMs}
              onClick={() => { setIntervalMs(opt.ms); setOpen(false); }}
              className={`block w-full text-left px-3 py-1.5 text-xs transition-colors ${
                opt.ms === intervalMs
                  ? 'bg-primary/15 text-primary'
                  : 'text-on-surface hover:bg-surface-bright'
              }`}
            >
              {opt.label === 'Off' ? 'Off (manual only)' : `Every ${opt.label}`}
            </button>
          ))}
          <div className="border-t border-outline-variant/20 mt-1 pt-1.5 px-3 pb-1">
            <p className="text-[10px] text-on-surface-variant">Last refreshed: {lastLabel}</p>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function readStoredInterval(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    // Reject any value not in OPTIONS so an out-of-range stale entry
    // (e.g. from a removed interval) doesn't keep the timer firing
    // forever at an invalid cadence.
    return OPTIONS.some((o) => o.ms === n) ? n : 0;
  } catch {
    return 0;
  }
}

function RefreshIcon({ spinning }: { spinning: boolean }): JSX.Element {
  return (
    <svg
      className={`w-3.5 h-3.5 ${spinning ? 'animate-spin' : ''}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m14.836 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0A8.003 8.003 0 015.163 13M15 15h5" />
    </svg>
  );
}

function ChevronDownIcon(): JSX.Element {
  return (
    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}
