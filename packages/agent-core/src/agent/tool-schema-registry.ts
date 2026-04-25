import type { ToolDefinition } from '@agentic-obs/llm-gateway';

/**
 * Hand-written JSON-schema registry for every action handler the agent can
 * invoke. The model receives these via the native tool_use API (no prose).
 *
 * Adding a new action handler? Add an entry here too. The orchestrator
 * `toolsForAgent()` throws at startup if any name in `agent-registry.ts
 * allowedTools` is missing from this map — drift will be caught immediately.
 */
export const TOOL_SCHEMAS: Record<string, ToolDefinition> = {
  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------
  'datasources.list': {
    name: 'datasources.list',
    description:
      'List every configured datasource with its id, backend type, and signal kind. Call this FIRST before any metrics/logs/changes query — every query tool requires an explicit sourceId.',
    input_schema: {
      type: 'object',
      properties: {
        signalType: {
          type: 'string',
          enum: ['metrics', 'logs', 'changes'],
          description: 'Filter by signal kind. Omit to see all datasources.',
        },
      },
      required: [],
    },
  },

  // -------------------------------------------------------------------------
  // Metrics primitives (read-only, source-agnostic). Every call requires sourceId.
  // -------------------------------------------------------------------------
  'metrics.query': {
    name: 'metrics.query',
    description:
      'Run an instant PromQL/MetricsQL query against a metrics datasource. Returns up to 20 series at the current timestamp. Validate complex queries with metrics.validate first when adding panels.',
    input_schema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Datasource id from datasources.list' },
        query: { type: 'string', description: 'Backend-native query (PromQL for prometheus, MetricsQL for victoria-metrics)' },
      },
      required: ['sourceId', 'query'],
    },
  },
  'metrics.range_query': {
    name: 'metrics.range_query',
    description:
      'Run a range PromQL/MetricsQL query over a time window. Returns each series as time-stamped points. Default window is the last 60 minutes at 60s step when start/end/duration_minutes are omitted.',
    input_schema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Datasource id from datasources.list' },
        query: { type: 'string', description: 'Backend-native query expression' },
        start: { type: 'string', description: 'ISO-8601 start timestamp (use with end)' },
        end: { type: 'string', description: 'ISO-8601 end timestamp (use with start)' },
        duration_minutes: { type: 'number', description: 'Alternative to start/end — query the last N minutes (default 60)' },
        step: { type: 'string', description: 'Resolution step, e.g. "60s", "5m". Default "60s"' },
      },
      required: ['sourceId', 'query'],
    },
  },
  'metrics.labels': {
    name: 'metrics.labels',
    description:
      'List label names for a metric (omit metric for the full set). Use to discover what labels a series carries before crafting selectors.',
    input_schema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Datasource id from datasources.list' },
        metric: { type: 'string', description: 'Optional metric name to scope labels. Omit for all labels in the backend.' },
      },
      required: ['sourceId'],
    },
  },
  'metrics.label_values': {
    name: 'metrics.label_values',
    description: 'List all values for a label (e.g. all values of "handler"). Truncated to 50 with a "more" hint.',
    input_schema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Datasource id from datasources.list' },
        label: { type: 'string', description: 'Label name to enumerate values for' },
      },
      required: ['sourceId', 'label'],
    },
  },
  'metrics.series': {
    name: 'metrics.series',
    description:
      'Find series matching one or more selectors, e.g. {__name__=~"http.*"}. Returns series strings. Useful when you know a label pattern but not the exact metric name.',
    input_schema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Datasource id from datasources.list' },
        match: {
          type: 'array',
          description: 'Series selectors, e.g. ["{__name__=~\\"http.*\\"}"]',
          items: { type: 'string' },
        },
      },
      required: ['sourceId', 'match'],
    },
  },
  'metrics.metadata': {
    name: 'metrics.metadata',
    description:
      'Get metric type (counter/gauge/histogram/summary) and help text. ESSENTIAL before writing queries — type dictates whether to wrap in rate() and what visualization to pick.',
    input_schema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Datasource id from datasources.list' },
        metric: { type: 'string', description: 'Single metric name to look up' },
        metrics: {
          type: 'array',
          description: 'Multiple metric names to look up. Omit both to fetch all metadata the backend exposes.',
          items: { type: 'string' },
        },
      },
      required: ['sourceId'],
    },
  },
  'metrics.metric_names': {
    name: 'metrics.metric_names',
    description:
      'Search/list metric names. ALWAYS pass a "match" keyword (e.g. "http", "redis") to filter — without it, large clusters return a sampled list and prompt you to filter.',
    input_schema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Datasource id from datasources.list' },
        match: { type: 'string', description: 'Substring filter applied case-insensitively to metric names' },
      },
      required: ['sourceId'],
    },
  },
  'metrics.validate': {
    name: 'metrics.validate',
    description:
      'Test whether a query is syntactically valid and returns data. Use as the validation gate before dashboard.add_panels — catches bad PromQL before it lands in a panel.',
    input_schema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Datasource id from datasources.list' },
        query: { type: 'string', description: 'Backend-native query expression to validate' },
      },
      required: ['sourceId', 'query'],
    },
  },

  // -------------------------------------------------------------------------
  // Logs primitives (read-only, source-agnostic). The query string is backend-native.
  // -------------------------------------------------------------------------
  'logs.query': {
    name: 'logs.query',
    description:
      'Run a logs query (LogQL for Loki, ES DSL for Elasticsearch, etc.) over an explicit ISO-8601 window. Returns "[timestamp] {labels} message" lines, truncated to keep observations compact.',
    input_schema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Datasource id from datasources.list (signalType=logs)' },
        query: { type: 'string', description: 'Backend-native logs query' },
        start: { type: 'string', description: 'ISO-8601 start timestamp (required)' },
        end: { type: 'string', description: 'ISO-8601 end timestamp (required)' },
        limit: { type: 'integer', description: 'Max log entries to return (1-1000)' },
      },
      required: ['sourceId', 'query', 'start', 'end'],
    },
  },
  'logs.labels': {
    name: 'logs.labels',
    description: 'List available log labels for a logs datasource. Use for discovery before constructing selectors.',
    input_schema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Datasource id from datasources.list (signalType=logs)' },
      },
      required: ['sourceId'],
    },
  },
  'logs.label_values': {
    name: 'logs.label_values',
    description: 'List values for a log label (e.g. all values of "namespace"). Truncated to 50 with a "more" hint.',
    input_schema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Datasource id from datasources.list (signalType=logs)' },
        label: { type: 'string', description: 'Log label name' },
      },
      required: ['sourceId', 'label'],
    },
  },

  // -------------------------------------------------------------------------
  // Changes (read-only) — recent deploys, config rollouts, incidents, flag flips.
  // -------------------------------------------------------------------------
  'changes.list_recent': {
    name: 'changes.list_recent',
    description:
      'List recent change events (deploys, config rollouts, feature-flag flips, incidents). Use early in investigations to correlate anomalies with known changes. If sourceId is omitted, the first registered change-event datasource is used.',
    input_schema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Datasource id (signalType=changes). Omit to use the first configured change source.' },
        service: { type: 'string', description: 'Optional service filter — only events tagged with this service' },
        window_minutes: { type: 'number', description: 'Lookback window in minutes (default 60)' },
      },
      required: [],
    },
  },

  // -------------------------------------------------------------------------
  // Dashboard lifecycle + mutation primitives
  // -------------------------------------------------------------------------
  'dashboard.create': {
    name: 'dashboard.create',
    description:
      'Create an empty dashboard. Returns dashboardId. Follow with dashboard.add_panels to populate it. Required before any other dashboard.* mutation when there is no current dashboard context.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Dashboard title shown in the UI' },
        description: { type: 'string', description: 'One-line description of the dashboard purpose' },
        prompt: { type: 'string', description: 'Optional original user prompt for traceability (defaults to description)' },
      },
      required: ['title'],
    },
  },
  'dashboard.list': {
    name: 'dashboard.list',
    description:
      'List existing dashboards. Pass a filter keyword (matched against title/description) to narrow results. Use this for "open X" / "show X" requests before navigating.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Substring matched against title and description (case-insensitive)' },
        limit: { type: 'integer', description: 'Maximum rows to return (default 50)' },
      },
      required: [],
    },
  },
  'dashboard.add_panels': {
    name: 'dashboard.add_panels',
    description:
      'Add one or more panels to a dashboard. The model constructs panel configs directly (title, visualization, queries, unit, ...). Validate complex queries with metrics.validate first. Panel sizing and layout are auto-applied.',
    input_schema: {
      type: 'object',
      properties: {
        dashboardId: { type: 'string', description: 'Target dashboard id (from dashboard.create or dashboard.list)' },
        panels: {
          type: 'array',
          description: 'Panel configs. Each: { title, visualization, queries: [{refId, expr, legendFormat?, instant?}], unit?, ... }. See Panel Schema Reference.',
          items: { type: 'object' },
        },
      },
      required: ['dashboardId', 'panels'],
    },
  },
  'dashboard.remove_panels': {
    name: 'dashboard.remove_panels',
    description: 'Remove one or more panels from a dashboard by id. Verify panel ids from the Dashboard State context first.',
    input_schema: {
      type: 'object',
      properties: {
        dashboardId: { type: 'string', description: 'Target dashboard id' },
        panelIds: {
          type: 'array',
          description: 'Ids of panels to remove',
          items: { type: 'string' },
        },
      },
      required: ['dashboardId', 'panelIds'],
    },
  },
  'dashboard.modify_panel': {
    name: 'dashboard.modify_panel',
    description:
      'Patch fields on an existing panel (title, queries, visualization, unit, thresholds, …). Provide only the keys to change; everything else on the panel is preserved.',
    input_schema: {
      type: 'object',
      properties: {
        dashboardId: { type: 'string', description: 'Target dashboard id' },
        panelId: { type: 'string', description: 'Panel id to modify' },
        title: { type: 'string', description: 'Optional new title' },
        description: { type: 'string', description: 'Optional new description' },
        visualization: { type: 'string', description: 'Optional visualization change (time_series, stat, gauge, ...)' },
        queries: { type: 'array', description: 'Optional replacement query list', items: { type: 'object' } },
        unit: { type: 'string', description: 'Optional value unit (seconds, bytes, percentunit, reqps, ...)' },
      },
      required: ['dashboardId', 'panelId'],
    },
  },
  'dashboard.set_title': {
    name: 'dashboard.set_title',
    description: 'Update the dashboard title and (optionally) description. Use for renaming an existing dashboard.',
    input_schema: {
      type: 'object',
      properties: {
        dashboardId: { type: 'string', description: 'Target dashboard id' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'Optional new description' },
      },
      required: ['dashboardId', 'title'],
    },
  },
  'dashboard.add_variable': {
    name: 'dashboard.add_variable',
    description:
      'Add a template variable ($variable) to a dashboard for drill-down. Only use when the user explicitly asks for filtering by a label.',
    input_schema: {
      type: 'object',
      properties: {
        dashboardId: { type: 'string', description: 'Target dashboard id' },
        name: { type: 'string', description: 'Variable name (without the leading $)' },
        label: { type: 'string', description: 'Display label shown in the UI (defaults to name)' },
        type: {
          type: 'string',
          enum: ['query', 'custom', 'datasource'],
          description: 'Variable kind. "query" runs a label_values query; "custom" uses a static option list; "datasource" picks a datasource.',
        },
        query: { type: 'string', description: 'For type=query: a label_values(metric, label) expression' },
        multi: { type: 'boolean', description: 'Allow multi-select' },
        includeAll: { type: 'boolean', description: 'Include an "All" option' },
      },
      required: ['dashboardId', 'name'],
    },
  },

  // -------------------------------------------------------------------------
  // Investigation lifecycle
  // -------------------------------------------------------------------------
  'investigation.create': {
    name: 'investigation.create',
    description:
      'Start a new investigation record for a "why is X" question. Returns investigationId. Use when the user asks for diagnosis or root-cause analysis.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question being investigated, e.g. "Why is p99 latency high?"' },
      },
      required: ['question'],
    },
  },
  'investigation.list': {
    name: 'investigation.list',
    description: 'List existing investigations. Pass a filter keyword to search by intent/question text.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Substring matched against the investigation question (case-insensitive)' },
        limit: { type: 'integer', description: 'Maximum rows (default 50)' },
      },
      required: [],
    },
  },
  'investigation.add_section': {
    name: 'investigation.add_section',
    description:
      'Append a section to an investigation report. type="text" is narrative analysis (substantial paragraphs); type="evidence" attaches a panel snapshot for a key finding. Text sections are the main content; evidence panels support them.',
    input_schema: {
      type: 'object',
      properties: {
        investigationId: { type: 'string', description: 'Id from investigation.create' },
        type: {
          type: 'string',
          enum: ['text', 'evidence'],
          description: '"text" for narrative analysis; "evidence" for a panel-backed finding',
        },
        content: { type: 'string', description: 'Markdown content. For text sections, write substantial paragraphs of analysis with specific numbers inline.' },
        panel: {
          type: 'object',
          description: 'Required for type=evidence: panel config with title, visualization, queries. The system auto-captures a data snapshot.',
        },
      },
      required: ['investigationId', 'type', 'content'],
    },
  },
  'investigation.complete': {
    name: 'investigation.complete',
    description:
      'Finalize the investigation, save the report, and navigate to it. MUST be called at the end of every investigation — without it, all sections are lost. Do NOT use reply or finish to end an investigation.',
    input_schema: {
      type: 'object',
      properties: {
        investigationId: { type: 'string', description: 'Id from investigation.create' },
        summary: { type: 'string', description: 'One-paragraph executive summary of the conclusion' },
      },
      required: ['investigationId', 'summary'],
    },
  },

  // -------------------------------------------------------------------------
  // Alert rules
  // -------------------------------------------------------------------------
  'create_alert_rule': {
    name: 'create_alert_rule',
    description:
      'Create an alert rule from a natural-language description. The rule generator produces the PromQL, threshold, severity, and labels. Query the current value first so the threshold is grounded in real data.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Natural-language description of the alert condition' },
        dashboardId: { type: 'string', description: 'Optional dashboard id — when set, the generator reuses dashboard queries/variables for consistency' },
      },
      required: ['prompt'],
    },
  },
  'modify_alert_rule': {
    name: 'modify_alert_rule',
    description: 'Modify an existing alert rule. Provide ruleId and only the fields to change. Use the Active Alert Rule Context to resolve "it"/"this alert" references.',
    input_schema: {
      type: 'object',
      properties: {
        ruleId: { type: 'string', description: 'Id of the rule to modify' },
        threshold: { type: 'number', description: 'New trigger threshold' },
        operator: {
          type: 'string',
          enum: ['>', '<', '>=', '<=', '=='],
          description: 'New comparison operator',
        },
        severity: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'New severity level',
        },
        forDurationSec: { type: 'number', description: 'How long the condition must hold before firing' },
        evaluationIntervalSec: { type: 'number', description: 'How often to evaluate the rule' },
        query: { type: 'string', description: 'New PromQL/MetricsQL expression' },
        name: { type: 'string', description: 'New rule name' },
      },
      required: ['ruleId'],
    },
  },
  'delete_alert_rule': {
    name: 'delete_alert_rule',
    description: 'Delete an alert rule. Irreversible.',
    input_schema: {
      type: 'object',
      properties: {
        ruleId: { type: 'string', description: 'Id of the rule to delete' },
      },
      required: ['ruleId'],
    },
  },
  'alert_rule.list': {
    name: 'alert_rule.list',
    description: 'List existing alert rules. Pass a filter keyword to search by name.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Substring matched against rule name (case-insensitive)' },
      },
      required: [],
    },
  },
  'alert_rule.history': {
    name: 'alert_rule.history',
    description:
      'Recent alert firing/resolution events as ready-to-use annotations JSON. Pass the returned JSON directly as panel.annotations on time_series/heatmap panels for "what happened when" overlays.',
    input_schema: {
      type: 'object',
      properties: {
        ruleId: { type: 'string', description: 'Optional — restrict to one rule. Omit for all rules.' },
        sinceMinutes: { type: 'number', description: 'Lookback window in minutes (default 60)' },
        limit: { type: 'integer', description: 'Max events (default 50)' },
      },
      required: [],
    },
  },

  // -------------------------------------------------------------------------
  // Other
  // -------------------------------------------------------------------------
  'web.search': {
    name: 'web.search',
    description:
      'Search the web for monitoring best practices, metric naming conventions, and dashboard patterns. Use proactively before creating dashboards, even on familiar stacks.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        max_results: { type: 'integer', description: 'Max results to return (default 8)' },
      },
      required: ['query'],
    },
  },
  'navigate': {
    name: 'navigate',
    description:
      'Open a page in the UI. Use after a list tool to "open X" / "show X". Valid paths: "/dashboards/<id>", "/investigations/<id>", "/alerts", "/dashboards", "/investigations".',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute UI path beginning with "/"' },
      },
      required: ['path'],
    },
  },

  // -------------------------------------------------------------------------
  // Terminal actions — end the conversation
  // -------------------------------------------------------------------------
  'reply': {
    name: 'reply',
    description:
      'Send a conversational reply with no tool actions this turn. Ends the conversation. Use when the user asked a question that needs no tools (concept explanation, recap), or after data-gathering tools when no further action is needed.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The reply text shown to the user. Be specific, cite real numbers from tool results.' },
      },
      required: ['message'],
    },
  },
  'finish': {
    name: 'finish',
    description:
      'Summarize what your tool calls above ACTUALLY accomplished. Ends the conversation after mutations. Do not claim success unless the corresponding mutation tool returned ok.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Specific summary listing what changed (dashboard X created with N panels, alert Y configured, etc).' },
      },
      required: ['message'],
    },
  },
  'ask_user': {
    name: 'ask_user',
    description:
      'Ask the user a clarifying question. Ends the conversation. Use VERY sparingly — only when the request is genuinely ambiguous (e.g. multiple datasources of the same kind and intent unclear).',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user' },
      },
      required: ['question'],
    },
  },
};

/**
 * Internal capabilities listed in `agent-registry.allowedTools` that are NOT
 * LLM-facing tools — the agent uses them directly through plain LLM
 * completions or verifier wiring rather than emitting a tool_use block. They
 * intentionally have no schema entry; `toolsForAgent` skips them.
 */
const NON_LLM_TOOLS = new Set<string>([
  'llm.complete',
  'verifier.run',
]);

export function toolsForAgent(allowedTools: readonly string[]): ToolDefinition[] {
  return allowedTools
    .filter((name) => !NON_LLM_TOOLS.has(name))
    .map((name) => {
      const schema = TOOL_SCHEMAS[name];
      if (!schema) throw new Error(`Tool schema missing for "${name}" — add an entry in tool-schema-registry.ts`);
      return schema;
    });
}
