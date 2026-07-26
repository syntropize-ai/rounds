/**
 * Turning a panel's backend error into something a reader can act on.
 *
 * A failing panel used to render the API's message verbatim, which in practice
 * meant a red box containing
 *
 *   Datasource ds-3f8a1c7e-9b21-4d0e-8f5a-... not found, not Prometheus, or
 *   not in your org
 *
 * That is three different problems in one sentence, addressed to whoever wrote
 * the backend, and the id is not something the reader has ever seen. It is
 * also the single most common panel failure on a self-hosted install: a
 * dashboard imported or agent-generated against a connector that has since
 * been renamed, deleted, or belongs to someone else.
 *
 * The raw text is not thrown away — it goes behind a disclosure, because
 * somebody debugging their own Prometheus wants it. It just should not be the
 * first thing anyone reads.
 */

export interface PanelErrorCopy {
  /** One sentence: what happened and what to do. */
  summary: string;
  /** The original message, when it adds anything. */
  detail?: string;
}

export function explainPanelError(raw: string): PanelErrorCopy {
  const text = raw.trim();

  if (/not found, not Prometheus, or not in your org/i.test(text)) {
    return {
      summary: 'This panel points at a data source that no longer exists. Check the connector in Settings, or edit the panel to use a different one.',
      detail: text,
    };
  }

  if (/API response shape mismatch/i.test(text)) {
    return {
      summary: 'The server returned data this page could not read. That usually means the API and the web build are out of step — reload, and if it persists the deployment needs updating.',
      detail: text,
    };
  }

  if (/too many requests|rate.?limit|\b429\b/i.test(text)) {
    return {
      summary: 'The data source is rate-limiting these queries. Wait a moment and retry, or widen the panel\'s time step to ask for fewer points.',
      detail: text,
    };
  }

  if (/\b(502|503|504)\b|bad gateway|unavailable|network|failed to fetch/i.test(text)) {
    return {
      summary: 'Could not reach the data source. Check that it is running and that the URL in Settings is right.',
      detail: text,
    };
  }

  if (/parse error|invalid parameter|bad_data|unexpected/i.test(text)) {
    return {
      summary: 'The data source rejected this panel\'s query. Edit the panel to fix the query.',
      detail: text,
    };
  }

  // Unrecognised. Show it as-is rather than inventing a friendlier reading of
  // an error we do not understand — and without a second copy in the details.
  return { summary: text };
}
