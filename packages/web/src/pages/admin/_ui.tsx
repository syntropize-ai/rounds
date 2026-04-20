/**
 * Small presentational primitives shared by the admin tabs. Kept in one file
 * so each tab doesn't re-declare the same `<Drawer>` / `<Modal>` boilerplate.
 */

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

// ────────────────────────────────────────────────────────────────────────────

export function Badge({
  children,
  variant = 'default',
}: {
  children: React.ReactNode;
  variant?: 'default' | 'primary' | 'success' | 'warn' | 'error' | 'neutral';
}): React.ReactElement {
  const map: Record<string, string> = {
    default: 'bg-surface-high text-on-surface-variant',
    primary: 'bg-primary/15 text-primary',
    success: 'bg-tertiary/15 text-tertiary',
    warn: 'bg-secondary/15 text-secondary',
    error: 'bg-error/15 text-error',
    neutral: 'bg-outline-variant text-on-surface-variant',
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full ${map[variant] ?? map.default}`}
    >
      {children}
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────────

export function PrimaryButton(
  props: React.ButtonHTMLAttributes<HTMLButtonElement>,
): React.ReactElement {
  const { className = '', ...rest } = props;
  return (
    <button
      type="button"
      className={`px-4 py-2 rounded-lg bg-primary text-on-primary-fixed text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-colors ${className}`}
      {...rest}
    />
  );
}

export function SecondaryButton(
  props: React.ButtonHTMLAttributes<HTMLButtonElement>,
): React.ReactElement {
  const { className = '', ...rest } = props;
  return (
    <button
      type="button"
      className={`px-4 py-2 rounded-lg border border-outline text-sm font-medium text-on-surface hover:bg-surface-high transition-colors disabled:opacity-50 ${className}`}
      {...rest}
    />
  );
}

export function DangerButton(
  props: React.ButtonHTMLAttributes<HTMLButtonElement>,
): React.ReactElement {
  const { className = '', ...rest } = props;
  return (
    <button
      type="button"
      className={`px-4 py-2 rounded-lg bg-error text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-colors ${className}`}
      {...rest}
    />
  );
}

// ────────────────────────────────────────────────────────────────────────────

export function TextInput(
  props: React.InputHTMLAttributes<HTMLInputElement>,
): React.ReactElement {
  const { className = '', ...rest } = props;
  return (
    <input
      className={`px-3 py-2 rounded-lg border border-outline-variant bg-surface-highest text-on-surface text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary ${className}`}
      {...rest}
    />
  );
}

export function Select(
  props: React.SelectHTMLAttributes<HTMLSelectElement>,
): React.ReactElement {
  const { className = '', ...rest } = props;
  return (
    <select
      className={`px-3 py-2 rounded-lg border border-outline-variant bg-surface-highest text-on-surface text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary ${className}`}
      {...rest}
    />
  );
}

// ────────────────────────────────────────────────────────────────────────────

export function Drawer({
  open,
  onClose,
  title,
  children,
  widthClass = 'w-[640px]',
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  widthClass?: string;
}): React.ReactElement | null {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className={`relative ml-auto h-full max-w-full ${widthClass} bg-surface-lowest border-l border-outline shadow-xl flex flex-col`}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-outline">
          <div className="text-base font-semibold text-on-surface">{title}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-on-surface-variant hover:text-on-surface text-xl leading-none"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  widthClass = 'max-w-md',
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  widthClass?: string;
}): React.ReactElement | null {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        className={`relative bg-surface-highest border border-outline rounded-2xl shadow-2xl w-full ${widthClass}`}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-outline">
          <div className="text-base font-semibold text-on-surface">{title}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-on-surface-variant hover:text-on-surface text-xl leading-none"
          >
            ×
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

export function ErrorBanner({ message }: { message: string | null }): React.ReactElement | null {
  if (!message) return null;
  return (
    <div className="mb-4 px-4 py-3 rounded-lg bg-error/10 border border-error/30 text-error text-sm">
      {message}
    </div>
  );
}

export function LoadingRow({ label = 'Loading…' }: { label?: string }): React.ReactElement {
  return (
    <div className="py-8 text-center text-on-surface-variant text-sm">{label}</div>
  );
}

export function EmptyState({ label }: { label: string }): React.ReactElement {
  return (
    <div className="py-12 text-center text-on-surface-variant text-sm">{label}</div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Row action dropdown — click anywhere outside or on an item to close.

export interface RowAction {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export function RowActions({ actions }: { actions: RowAction[] }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ top: number; right: number } | null>(null);
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);

  // The dropdown is rendered through a portal (see below) so it can escape
  // the table's `overflow-x-auto` container. That means we can't rely on
  // `rootRef.contains(event.target)` for outside-click — split the check
  // between the anchor button and the portaled menu.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onScrollOrResize = (): void => setOpen(false);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('resize', onScrollOrResize);
    // `true` so we catch scrolls on ancestors (e.g. the table's overflow
    // container). Otherwise the menu would detach from its button.
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open]);

  const toggle = (): void => {
    if (!open && buttonRef.current) {
      const r = buttonRef.current.getBoundingClientRect();
      // Align the menu's right edge with the button's right edge, 4px gap
      // below the button. `right` is distance from viewport right.
      setPos({ top: r.bottom + 4, right: Math.max(4, window.innerWidth - r.right) });
    }
    setOpen((v) => !v);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-label="Row actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="px-2 py-1 text-on-surface-variant hover:text-on-surface hover:bg-surface-high rounded text-sm"
      >
        •••
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ position: 'fixed', top: pos.top, right: pos.right, zIndex: 50 }}
          className="min-w-[180px] rounded-lg border border-outline bg-surface-highest shadow-lg py-1"
        >
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              disabled={a.disabled}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                if (!a.disabled) a.onSelect();
              }}
              className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-surface-high disabled:opacity-40 ${
                a.danger ? 'text-error' : 'text-on-surface'
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────

export function Pager({
  page,
  perpage,
  total,
  onChange,
}: {
  page: number;
  perpage: number;
  total: number;
  onChange: (page: number) => void;
}): React.ReactElement | null {
  if (total <= perpage) return null;
  const lastPage = Math.max(1, Math.ceil(total / perpage));
  const start = (page - 1) * perpage + 1;
  const end = Math.min(page * perpage, total);
  return (
    <div className="flex justify-center items-center gap-3 mt-4">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        className="px-3 py-1.5 text-sm text-on-surface-variant hover:text-on-surface disabled:opacity-40"
      >
        Previous
      </button>
      <span className="text-sm text-on-surface-variant">
        {start}–{end} of {total}
      </span>
      <button
        type="button"
        disabled={page >= lastPage}
        onClick={() => onChange(page + 1)}
        className="px-3 py-1.5 text-sm text-on-surface-variant hover:text-on-surface disabled:opacity-40"
      >
        Next
      </button>
    </div>
  );
}
