import type { ToolDefinition } from '@agentic-obs/llm-gateway';
import type { ToolCategory } from './tool-search.js';

/**
 * Hand-written JSON-schema registry for every action handler the agent can
 * invoke. The model receives these via the native tool_use API (no prose).
 *
 * Each entry carries a `category`:
 *   - `always-on` tools ship on every gateway call (the working set).
 *   - `deferred` tools are only listed by name in a system reminder; the
 *     model loads their full schema on demand via `tool_search`.
 *
 * Adding a new action handler? Add an entry here too. The orchestrator
 * `toolsForAgent()` throws at startup if any name in `agent-registry.ts
 * allowedTools` is missing from this map — drift will be caught immediately.
 */
export interface ToolRegistryEntry {
  category: ToolCategory;
  schema: ToolDefinition;
}

export const TOOL_REGISTRY: Record<string, ToolRegistryEntry> = {
  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------
  'datasources.list': {
    category: 'always-on',
    schema: {
      name: 'datasources.list',
      description:
        'Enumerate configured datasources (id, backend type, signal kind, isDefault flag). Use for "what data sources do I have" type questions. For PICKING a datasource to query against, prefer datasources.suggest — list is for browsing, suggest is for committing.',
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
  },
  'datasources.suggest': {
    category: 'always-on',
    schema: {
      name: 'datasources.suggest',
      description:
        'Pick a datasource for the current request. Pass the raw user message as userIntent — substring-matches name/environment/cluster, falls back to the isDefault row, surfaces AMBIGUOUS when multiple candidates and no hint. On AMBIGUOUS use ask_user with the returned alternatives as structured options. After picking (or user confirms), follow with datasources.pin so subsequent tool calls reuse the choice. Skip when only one datasource of the right type exists.',
      input_schema: {
        type: 'object',
        properties: {
          userIntent: {
            type: 'string',
            description: 'The user\'s prompt text. Higher accuracy = pass it verbatim, not a paraphrase.',
          },
          type: {
            type: 'string',
            description: 'Backend type filter (prometheus, victoria-metrics, loki, etc.). Omit if unknown.',
          },
        },
        required: [],
      },
    },
  },
  'datasources.pin': {
    category: 'deferred',
    schema: {
      name: 'datasources.pin',
      description:
        'Stick a datasource to this session. Subsequent tools that need a datasource of the same backend type reuse it without re-suggesting. Use after the user picks one or confirms a high-confidence suggest match. Don\'t pin on cross-source compare requests — those need per-query overrides instead.',
      input_schema: {
        type: 'object',
        properties: {
          datasourceId: { type: 'string', description: 'Datasource id to pin' },
          type: { type: 'string', description: 'Backend type slot (default "prometheus")' },
        },
        required: ['datasourceId'],
      },
    },
  },
  'datasources.unpin': {
    category: 'deferred',
    schema: {
      name: 'datasources.unpin',
      description:
        'Drop the session pin for a backend type. Use when the user explicitly asks to switch ("use staging instead", "换到 prod") — the next tool call will re-suggest from scratch.',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Backend type slot to unpin (default "prometheus")' },
        },
        required: [],
      },
    },
  },

  // -------------------------------------------------------------------------
  // Metrics primitives (read-only, source-agnostic). Every call requires sourceId.
  // -------------------------------------------------------------------------
  'metrics.query': {
    category: 'deferred',
    schema: {
      name: 'metrics.query',
      description:
        'Run an instant PromQL/MetricsQL query against a metrics datasource. Returns up to 20 series at a specific timestamp (defaults to now). When analyzing what a panel currently shows, pass `time` set to the panel time-window end so the instant value matches the panel rather than "now". Validate complex queries with metrics.validate first when adding panels.',
      input_schema: {
        type: 'object',
        properties: {
          sourceId: { type: 'string', description: 'Datasource id from datasources.list' },
          query: { type: 'string', description: 'Backend-native query (PromQL for prometheus, MetricsQL for victoria-metrics)' },
          time: { type: 'string', description: 'Optional ISO-8601 evaluation timestamp. Default: now. Use the panel time-window end when analyzing a panel.' },
        },
        required: ['sourceId', 'query'],
      },
    },
  },
  'metrics.range_query': {
    category: 'deferred',
    schema: {
      name: 'metrics.range_query',
      description:
        'Run a range PromQL/MetricsQL query over a time window. Returns each series as time-stamped points. When analyzing what a panel shows, pass `start` and `end` set to the panel time-window so the result matches the panel rather than "now"; otherwise default window is the last 60 minutes at 60s step.',
      input_schema: {
        type: 'object',
        properties: {
          sourceId: { type: 'string', description: 'Datasource id from datasources.list' },
          query: { type: 'string', description: 'Backend-native query expression' },
          start: { type: 'string', description: 'ISO-8601 start timestamp (use with end). When analyzing a panel, set to the panel time-window start.' },
          end: { type: 'string', description: 'ISO-8601 end timestamp (use with start). When analyzing a panel, set to the panel time-window end.' },
          duration_minutes: { type: 'number', description: 'Alternative to start/end — query the last N minutes (default 60)' },
          step: { type: 'string', description: 'Resolution step, e.g. "60s", "5m". Default "60s"' },
        },
        required: ['sourceId', 'query'],
      },
    },
  },
  'metrics.discover': {
    // always-on: it's the entry point for nearly every metrics workflow
    // (panel build, alert rule, investigation, ad-hoc query). Forcing a
    // tool_search round-trip before each one would add a useless turn to
    // the most common path. Lower-frequency cousins (metrics.validate,
    // metrics.range_query) stay deferred.
    category: 'always-on',
    schema: {
      name: 'metrics.discover',
      description:
        'Ask a metrics backend what it has — five discovery shapes share one tool. Required: sourceId, kind. The kind selects the activity:\n' +
        ' - kind="names": list/search metric names; pass `match` to filter (large clusters are sampled without it).\n' +
        ' - kind="labels": list label keys; pass `metric` to scope to one series, omit for all labels in the backend.\n' +
        ' - kind="values": list values for one label; required arg `label`.\n' +
        ' - kind="series": find series matching selectors; required arg `match` (array of e.g. {__name__=~"http.*"}).\n' +
        ' - kind="metadata": fetch type (counter/gauge/histogram/summary) + help text; pass `metric` for a single lookup or omit to fetch everything.\n' +
        'Use BEFORE crafting queries — metadata dictates whether to wrap in rate(), labels dictate selector shape.',
      input_schema: {
        type: 'object',
        properties: {
          sourceId: { type: 'string', description: 'Datasource id from datasources.list' },
          kind: {
            type: 'string',
            enum: ['labels', 'values', 'series', 'metadata', 'names'],
            description: 'Which discovery shape to run. See description for required args per kind.',
          },
          metric: { type: 'string', description: 'For kind=labels (optional, scopes labels to one metric) and kind=metadata (optional, single metric lookup).' },
          label: { type: 'string', description: 'Required for kind=values: the label whose values to enumerate.' },
          match: {
            type: 'array',
            description: 'For kind=series: array of selectors, e.g. ["{__name__=~\\"http.*\\"}"].',
            items: { type: 'string' },
          },
          // Separate property (not match-as-union) so the JSON schema is honest:
          // kind=names takes a substring filter, kind=series takes selectors.
          // Two distinct shapes, two distinct fields. The handler accepts the
          // legacy `match` string for kind=names too, but the schema-honest
          // path is `filter`.
          filter: {
            type: 'string',
            description: 'For kind=names: substring filter (case-insensitive) applied to metric names. Without it large clusters return a sampled list.',
          },
        },
        required: ['sourceId', 'kind'],
      },
    },
  },
  'metrics.validate': {
    category: 'deferred',
    schema: {
      name: 'metrics.validate',
      description:
        'Test whether a query is syntactically valid and executes through both instant and dashboard range-query paths. Use as the validation gate before dashboard.add_panels — catches bad PromQL before it lands in a panel.',
      input_schema: {
        type: 'object',
        properties: {
          sourceId: { type: 'string', description: 'Datasource id from datasources.list' },
          query: { type: 'string', description: 'Backend-native query expression to validate' },
        },
        required: ['sourceId', 'query'],
      },
    },
  },

  // -------------------------------------------------------------------------
  // Logs primitives (read-only, source-agnostic). The query string is backend-native.
  // -------------------------------------------------------------------------
  'logs.query': {
    category: 'deferred',
    schema: {
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
  },
  'logs.labels': {
    category: 'deferred',
    schema: {
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
  },
  'logs.label_values': {
    category: 'deferred',
    schema: {
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
  },

  // -------------------------------------------------------------------------
  // Changes (read-only) — recent deploys, config rollouts, incidents, flag flips.
  // -------------------------------------------------------------------------
  'changes.list_recent': {
    category: 'deferred',
    schema: {
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
  },

  // -------------------------------------------------------------------------
  // Kubernetes / Ops integrations. Requires an operator-configured connector.
  // -------------------------------------------------------------------------
  'ops.run_command': {
    category: 'always-on',
    schema: {
      name: 'ops.run_command',
      description:
        'Run a Kubernetes/Ops command through a configured connector. Only use when the user asks to inspect or operate on cluster state and a connectorId is known. Read commands may run with intent="read"; write/mutating commands must use intent="propose" unless the user is executing an approved proposal.',
      input_schema: {
        type: 'object',
        properties: {
          connectorId: { type: 'string', description: 'Ops connector id configured in Settings' },
          command: { type: 'string', description: 'The exact kubectl/ops command to run or propose' },
          intent: {
            type: 'string',
            enum: ['read', 'propose', 'execute_approved'],
            description: 'read runs safe inspection commands; propose returns an approval/proposal for write commands; execute_approved is only for an already approved command.',
          },
        },
        required: ['connectorId', 'command', 'intent'],
      },
    },
  },

  // -------------------------------------------------------------------------
  // Dashboard lifecycle + mutation primitives
  // -------------------------------------------------------------------------
  'dashboard.create': {
    category: 'always-on',
    schema: {
      name: 'dashboard.create',
      description:
        'Create an empty dashboard. Returns dashboardId. Follow with dashboard.add_panels to populate it. Required before any other dashboard.* mutation when there is no current dashboard context. Requires a primary datasourceId — pick one via datasources.suggest first (or reuse the session pin if set).',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Dashboard title shown in the UI' },
          description: { type: 'string', description: 'One-line description of the dashboard purpose' },
          prompt: { type: 'string', description: 'Optional original user prompt for traceability (defaults to description)' },
          datasourceId: {
            type: 'string',
            description:
              'Primary datasource id for this dashboard. Panels added without their own per-query datasourceId fall back to this. Get from datasources.list / datasources.suggest.',
          },
        },
        required: ['title', 'datasourceId'],
      },
    },
  },
  'dashboard.list': {
    category: 'always-on',
    schema: {
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
  },
  'dashboard.clone': {
    category: 'always-on',
    schema: {
      name: 'dashboard.clone',
      description:
        "Clone a dashboard, replacing every query's datasourceId with targetDatasourceId. Use when the user says 'copy/move/clone this dashboard to {env}' — far cheaper than rebuilding from scratch.",
      input_schema: {
        type: 'object',
        properties: {
          sourceDashboardId: { type: 'string', description: 'Dashboard id to clone (from dashboard.list)' },
          targetDatasourceId: { type: 'string', description: 'Datasource id assigned to every query in the new dashboard' },
          newTitle: { type: 'string', description: 'Optional title for the new dashboard. Defaults to "{sourceTitle} (cloned)"' },
        },
        required: ['sourceDashboardId', 'targetDatasourceId'],
      },
    },
  },
  'dashboard.add_panels': {
    category: 'always-on',
    schema: {
      name: 'dashboard.add_panels',
      description:
        'Add one or more panels to a dashboard. The model constructs panel configs directly (title, visualization, queries, unit, ...). Validate complex queries with metrics.validate first. Panel sizing and layout are auto-applied. Every query must carry an explicit datasourceId — there is NO inheritance from the dashboard primary. For a single-source dashboard, set every query to the dashboard primary id. For cross-source compare panels, set per query (one source per query). The handler rejects panels with any missing datasourceId.',
      input_schema: {
        type: 'object',
        properties: {
          dashboardId: { type: 'string', description: 'Target dashboard id (from dashboard.create or dashboard.list)' },
          panels: {
            type: 'array',
            description: 'Panel configs. Each: { title, visualization, queries: [{refId, expr, datasourceId, legendFormat?, instant?}], unit?, ... }. datasourceId is REQUIRED per query.',
            items: { type: 'object' },
          },
        },
        required: ['dashboardId', 'panels'],
      },
    },
  },
  'dashboard.remove_panels': {
    category: 'always-on',
    schema: {
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
  },
  'dashboard.modify_panel': {
    category: 'always-on',
    schema: {
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
  },
  'dashboard.set_title': {
    category: 'always-on',
    schema: {
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
  },
  'dashboard.add_variable': {
    category: 'always-on',
    schema: {
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
  },

  // -------------------------------------------------------------------------
  // Investigation lifecycle
  // -------------------------------------------------------------------------
  'investigation.create': {
    category: 'always-on',
    schema: {
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
  },
  'investigation.list': {
    category: 'deferred',
    schema: {
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
  },
  'investigation.add_section': {
    category: 'deferred',
    schema: {
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
  },
  'investigation.complete': {
    category: 'deferred',
    schema: {
      name: 'investigation.complete',
      description:
        'Finalize the investigation, save the report, and navigate to it. MUST be called at the end of every investigation — without it, all sections are lost.',
      input_schema: {
        type: 'object',
        properties: {
          investigationId: { type: 'string', description: 'Id from investigation.create' },
          summary: { type: 'string', description: 'One-paragraph executive summary of the conclusion' },
        },
        required: ['investigationId', 'summary'],
      },
    },
  },

  // -------------------------------------------------------------------------
  // Alert rules
  // -------------------------------------------------------------------------
  'alert_rule.write': {
    category: 'deferred',
    schema: {
      name: 'alert_rule.write',
      description:
        'Create, update, or delete an alert rule — three verbs share one tool. Required: op. Per op:\n' +
        ' - op="create": requires `prompt` (natural-language description). The rule generator produces PromQL, threshold, severity, labels. Query the current metric value first so the threshold is grounded in real data. Optional `dashboardId` reuses that dashboard\'s queries/variables.\n' +
        ' - op="update": requires `ruleId`. Pass only the fields to change (threshold, operator, severity, forDurationSec, evaluationIntervalSec, query, name). Resolve "it"/"this alert" via Active Alert Rule Context.\n' +
        ' - op="delete": requires `ruleId`. Irreversible.',
      input_schema: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['create', 'update', 'delete'],
            description: 'Which verb to run. See description for required args per op.',
          },
          ruleId: { type: 'string', description: 'Required for op=update / op=delete: id of the rule.' },
          prompt: { type: 'string', description: 'Required for op=create: natural-language description of the alert condition.' },
          folderUid: { type: 'string', description: 'Required for op=create: the folder uid that owns the rule. Drives both RBAC scoping and where the rule lands. Use folder.list / folder.create first if unsure.' },
          dashboardId: { type: 'string', description: 'Optional for op=create: when set, the generator reuses dashboard queries/variables for consistency.' },
          threshold: { type: 'number', description: 'For op=update: new trigger threshold.' },
          operator: {
            type: 'string',
            enum: ['>', '<', '>=', '<=', '=='],
            description: 'For op=update: new comparison operator.',
          },
          severity: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low'],
            description: 'For op=update: new severity level.',
          },
          forDurationSec: { type: 'number', description: 'For op=update: how long the condition must hold before firing.' },
          evaluationIntervalSec: { type: 'number', description: 'For op=update: how often to evaluate the rule.' },
          query: { type: 'string', description: 'For op=update: new PromQL/MetricsQL expression.' },
          name: { type: 'string', description: 'For op=update: new rule name.' },
        },
        required: ['op'],
      },
    },
  },
  'alert_rule.list': {
    category: 'deferred',
    schema: {
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
  },
  'alert_rule.history': {
    category: 'deferred',
    schema: {
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
  },

  // -------------------------------------------------------------------------
  // Other
  // -------------------------------------------------------------------------
  'web.search': {
    category: 'always-on',
    schema: {
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
  },
  'navigate': {
    category: 'always-on',
    schema: {
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
  },

  // -------------------------------------------------------------------------
  // Lazy tool loading — fetches deferred tool schemas on demand.
  // -------------------------------------------------------------------------
  'tool_search': {
    category: 'always-on',
    schema: {
      name: 'tool_search',
      description:
        'Fetches full schema definitions for deferred tools so they can be called.\n\nDeferred tools appear by name in <system-reminder> messages. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools\' complete JSONSchema definitions inside a <functions> block. Once a tool\'s schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.\n\nQuery forms:\n- "select:Read,Edit,Grep" — fetch these exact tools by name\n- "notebook jupyter" — keyword search, ranked by best match',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Either an exact-name select ("select:tool1,tool2") to load known tools, or whitespace-separated keywords to search names + descriptions.',
          },
        },
        required: ['query'],
      },
    },
  },

  // -------------------------------------------------------------------------
  // Clarifying question — only tool besides "no tool call" that ends a turn.
  // -------------------------------------------------------------------------
  'ask_user': {
    category: 'always-on',
    schema: {
      name: 'ask_user',
      description:
        'Ask the user a clarifying question. Ends the conversation. Use VERY sparingly — only when the request is genuinely ambiguous (e.g. multiple datasources of the same kind and intent unclear). For one-of-N decisions (e.g. "Which datasource?"), pass `options`. The user\'s reply will be the option id, prefixed with `option:` so you can distinguish it from free text.',
      input_schema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask the user' },
          options: {
            type: 'array',
            description: 'When the answer is one-of-N, provide options. The chat UI renders these as buttons; clicking submits the option id back to you. Omit options for free-text questions.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Stable id you will receive back as the user reply' },
                label: { type: 'string', description: 'Button text shown to the user' },
                hint: { type: 'string', description: 'Optional secondary text under the button' },
              },
              required: ['id', 'label'],
            },
          },
        },
        required: ['question'],
      },
    },
  },
};

/**
 * Backwards-compatible flat-schema view for callers that just want the raw
 * ToolDefinitions (e.g. tests asserting on the tool catalog).
 */
export const TOOL_SCHEMAS: Record<string, ToolDefinition> = Object.fromEntries(
  Object.entries(TOOL_REGISTRY).map(([name, entry]) => [name, entry.schema]),
);

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

function lookupSchema(name: string): ToolDefinition {
  const entry = TOOL_REGISTRY[name];
  if (!entry) throw new Error(`Tool schema missing for "${name}" — add an entry in tool-schema-registry.ts`);
  return entry.schema;
}

/**
 * Resolve the ToolDefinitions for an agent's allowedTools list — every tool,
 * regardless of category. Callers that want to honor the `always-on` /
 * `deferred` split should use `alwaysOnToolsForAgent` + `deferredToolNamesForAgent`
 * instead.
 */
export function toolsForAgent(allowedTools: readonly string[]): ToolDefinition[] {
  return allowedTools
    .filter((name) => !NON_LLM_TOOLS.has(name))
    .map(lookupSchema);
}

/** Look up an entry, throwing the same drift error as `lookupSchema` for
 *  consistency. Used by the partition selectors so a typo in `agent-registry`
 *  fails at startup rather than silently dropping the tool from the model's
 *  surface. */
function lookupEntry(name: string): ToolRegistryEntry {
  const entry = TOOL_REGISTRY[name];
  if (!entry) throw new Error(`Tool schema missing for "${name}" — add an entry in tool-schema-registry.ts`);
  return entry;
}

/** ToolDefinitions for the agent's `always-on` tools — sent on every gateway call. */
export function alwaysOnToolsForAgent(allowedTools: readonly string[]): ToolDefinition[] {
  return allowedTools
    .filter((name) => !NON_LLM_TOOLS.has(name))
    .map(lookupEntry)
    .filter((entry) => entry.category === 'always-on')
    .map((entry) => entry.schema);
}

/** Names of the agent's `deferred` tools — surfaced as bare names in a
 *  system reminder; the model loads schemas on demand via `tool_search`. */
export function deferredToolNamesForAgent(allowedTools: readonly string[]): string[] {
  return allowedTools
    .filter((name) => !NON_LLM_TOOLS.has(name))
    .filter((name) => lookupEntry(name).category === 'deferred');
}

/** ToolDefinitions for a specific subset of deferred tools — used by the
 *  loop after `tool_search` resolves the model's request. */
export function deferredSchemasByName(names: Iterable<string>): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const name of names) {
    const entry = TOOL_REGISTRY[name];
    if (entry && entry.category === 'deferred') out.push(entry.schema);
  }
  return out;
}
