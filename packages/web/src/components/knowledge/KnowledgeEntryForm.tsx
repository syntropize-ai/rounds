/**
 * Skill-style add/edit form. Same layout for "+ New skill" and inline edit
 * inside an expanded row. Pure helpers (parseTagsInput, validateForm,
 * entryToFormState, formStateToCreateBody, formStateToUpdateBody) are
 * exported so the node-only test env can verify them without a DOM.
 */
import React, { useMemo, useState } from 'react';
import type { KnowledgeEntry } from '@agentic-obs/common';
import { btnPrimary, btnSecondary, inputCls } from '../connectors/styles.js';
import type {
  KnowledgeCreateBody,
  KnowledgeUpdateBody,
} from './knowledge-api.js';

export interface FormState {
  title: string;
  description: string;
  body: string;
  tags: string; // raw comma-separated input
  sourceRef: string;
}

const EMPTY_FORM: FormState = {
  title: '',
  description: '',
  body: '',
  tags: '',
  sourceRef: '',
};

/**
 * Split a comma-separated tag string into a trimmed, deduped, non-empty list.
 */
export function parseTagsInput(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Title + description are required. Body is optional (stub skills allowed).
 */
export function validateForm(state: {
  title: string;
  description: string;
  body: string;
}): ValidationResult {
  if (!state.title.trim()) return { ok: false, message: 'Title is required.' };
  if (!state.description.trim())
    return {
      ok: false,
      message: 'Description is required — when should the agent consult this skill?',
    };
  return { ok: true };
}

/**
 * Round-trip an existing entry into editable form state. Undefined → empty.
 */
export function entryToFormState(entry?: KnowledgeEntry): FormState {
  if (!entry) return { ...EMPTY_FORM };
  return {
    title: entry.title,
    description: entry.description,
    body: entry.body,
    tags: entry.intentTags.join(', '),
    sourceRef: entry.sourceRef ?? '',
  };
}

export function formStateToCreateBody(state: FormState): KnowledgeCreateBody {
  const sourceRef = state.sourceRef.trim();
  return {
    title: state.title.trim(),
    description: state.description.trim(),
    body: state.body,
    intentTags: parseTagsInput(state.tags),
    sourceRef: sourceRef ? sourceRef : null,
  };
}

export function formStateToUpdateBody(state: FormState): KnowledgeUpdateBody {
  // Update body shape matches create. Server treats missing fields as
  // unchanged, but we always send the full set for simplicity.
  return formStateToCreateBody(state);
}

interface Props {
  initial?: KnowledgeEntry;
  onSubmit: (body: KnowledgeCreateBody) => Promise<void> | void;
  onCancel: () => void;
  submitting?: boolean;
}

export default function KnowledgeEntryForm({
  initial,
  onSubmit,
  onCancel,
  submitting,
}: Props) {
  const [state, setState] = useState<FormState>(() => entryToFormState(initial));
  const [validationError, setValidationError] = useState<string | null>(null);

  const isEdit = !!initial;
  const canSubmit = useMemo(
    () => state.title.trim().length > 0 && state.description.trim().length > 0 && !submitting,
    [state.title, state.description, submitting],
  );

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setState((prev) => ({ ...prev, [key]: value }));
    if (validationError) setValidationError(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const result = validateForm(state);
    if (!result.ok) {
      setValidationError(result.message);
      return;
    }
    setValidationError(null);
    void onSubmit(formStateToCreateBody(state));
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 p-4 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-lowest)]"
    >
      <div>
        <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1">
          Title
        </label>
        <input
          type="text"
          value={state.title}
          onChange={(e) => update('title', e.target.value)}
          className={inputCls}
          placeholder="e.g. PostgreSQL slow query investigation"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1">
          Description
        </label>
        <input
          type="text"
          value={state.description}
          onChange={(e) => update('description', e.target.value)}
          className={inputCls}
          placeholder="When should the agent consult this skill? e.g. 'When investigating PostgreSQL slow queries...'"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1">
          Body
        </label>
        <textarea
          value={state.body}
          onChange={(e) => update('body', e.target.value)}
          className={inputCls + ' font-mono text-sm'}
          rows={16}
          placeholder="Markdown supported. Use ## headings for sections (e.g. ## Key metrics, ## Troubleshooting)."
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1">
          Tags
        </label>
        <input
          type="text"
          value={state.tags}
          onChange={(e) => update('tags', e.target.value)}
          className={inputCls}
          placeholder="comma, separated, tags"
        />
      </div>

      {validationError && (
        <p className="text-xs text-error" role="alert">
          {validationError}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className={btnSecondary}
          disabled={submitting}
        >
          Cancel
        </button>
        <button type="submit" className={btnPrimary} disabled={!canSubmit}>
          {submitting ? 'Saving…' : isEdit ? 'Save' : 'Create'}
        </button>
      </div>
    </form>
  );
}
