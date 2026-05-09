/**
 * Filterable combobox for picking a model id.
 *
 * Replaces the old `<input list="...">`/`<datalist>` pattern, which
 * silently breaks in Chrome when the option list grows past ~100
 * entries (OpenRouter returns ~370 models). The native dropdown stops
 * appearing — the user sees the ▼ glyph but clicking does nothing.
 *
 * This is a minimal controlled combobox: a free-text input with an
 * absolutely-positioned filtered popup. Same interaction model as the
 * old datalist (type to filter, click to pick, free-text fallback when
 * the model id isn't in the list), but the popup renders independently
 * of browser quirks.
 *
 * Keyboard:
 *   - ↑/↓: move highlight
 *   - Enter: select highlighted option
 *   - Esc: close popup, keep current input value
 */
import { useEffect, useRef, useState } from 'react';

export interface ModelOption {
  id: string;
  label: string;
}

interface ModelComboboxProps {
  value: string;
  onChange: (next: string) => void;
  options: ModelOption[];
  placeholder?: string;
  /** Tailwind classes applied to the wrapped <input>. */
  inputClassName?: string;
  /** Tailwind classes applied to the outer wrapper (controls popup positioning). */
  className?: string;
}

// No render cap — even 1000-row providers (the realistic worst case for
// OpenRouter today is ~370) render fast enough as plain <li>. The user-
// scrollable popup with overflow-auto is the right UX; capping silently
// hides options below the cap and surprises users.

export function ModelCombobox({
  value,
  onChange,
  options,
  placeholder,
  inputClassName,
  className,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close when clicking outside the wrapper.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Filter: case-insensitive substring on id + label. Two cases skip the
  // filter and show all options (capped):
  //   - empty input — first-time browse
  //   - input value is EXACTLY a known option id — the user already picked
  //     one and is opening the popup to switch. Without this, opening the
  //     dropdown after a previous pick shows ONLY that option (the value
  //     trivially matches itself), hiding the other 369 entries.
  // Result is capped at MAX_VISIBLE_OPTIONS so a 370-item provider doesn't
  // render a multi-thousand-pixel popup.
  const q = value.trim().toLowerCase();
  const isExactMatch = q.length > 0 && options.some((o) => o.id.toLowerCase() === q);
  const filtered = q.length === 0 || isExactMatch
    ? options
    : options.filter((o) => o.id.toLowerCase().includes(q) || o.label.toLowerCase().includes(q));

  function commit(next: string) {
    onChange(next);
    setOpen(false);
    inputRef.current?.blur();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true);
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown') {
      setHighlight((h) => Math.min(filtered.length - 1, h + 1));
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      setHighlight((h) => Math.max(0, h - 1));
      e.preventDefault();
    } else if (e.key === 'Enter' && open && filtered[highlight]) {
      commit(filtered[highlight].id);
      e.preventDefault();
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={wrapperRef} className={`relative ${className ?? ''}`}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setHighlight(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        className={inputClassName}
        // Suppress browser password / contact / address autofill — this is a
        // model-id picker, not a credential field. Chrome historically ignores
        // bare `off` but respects "off" + a synthetic name; password managers
        // (1Password, LastPass, Bitwarden) read the data-* hints.
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        name="model-id-picker"
        data-1p-ignore="true"
        data-lpignore="true"
        data-form-type="other"
        aria-autocomplete="list"
        aria-expanded={open}
      />
      {open && filtered.length > 0 && (
        <ul
          className="absolute z-20 mt-1 left-0 right-0 max-h-96 overflow-auto rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)] shadow-lg text-sm"
          role="listbox"
        >
          {filtered.map((opt, i) => (
            <li
              key={opt.id}
              role="option"
              aria-selected={i === highlight}
              // mousedown not click — fires before input.blur, preventing the
              // focus race that would close the popup before the click lands.
              onMouseDown={(e) => { e.preventDefault(); commit(opt.id); }}
              onMouseEnter={() => setHighlight(i)}
              className={`px-3 py-1.5 cursor-pointer truncate ${
                i === highlight
                  ? 'bg-[var(--color-primary)]/10 text-[var(--color-on-surface)]'
                  : 'text-[var(--color-on-surface)] hover:bg-[var(--color-surface)]'
              }`}
              title={opt.label}
            >
              <span className="font-mono">{opt.id}</span>
              {opt.label && opt.label !== opt.id && (
                <span className="ml-2 text-xs text-tertiary">{opt.label}</span>
              )}
            </li>
          ))}
          {filtered.length > 50 && (
            <li className="px-3 py-1.5 text-xs text-tertiary border-t border-[var(--color-outline-variant)]/50 sticky bottom-0 bg-[var(--color-surface-high)]">
              {filtered.length} options — type to narrow.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
