import type { JsonSchemaProperty, ToolDefinition } from '@agentic-obs/llm-gateway';
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

const PANEL_VISUALIZATIONS = ['time_series', 'stat', 'bar', 'bar_gauge', 'heatmap', 'gauge', 'table', 'pie', 'histogram'] as const;
const PANEL_UNITS = ['none', 'short', 'percent', 'percentunit', 'bytes', 'decbytes', 'bytes_si', 'decbytes_si', 'bps', 'Bps', 'reqps', 'ops', 'opsps', 's', 'ms', 'dateTime'] as const;
const PANEL_QUERY_SCHEMA: JsonSchemaProperty = {
  type: 'object',
  properties: {
    refId: { type: 'string', description: 'Series reference id, usually A/B/C.' },
    expr: { type: 'string', description: 'Backend-native query expression (PromQL).' },
    datasourceId: { type: 'string', description: 'Required connector id for this query.' },
    legendFormat: { type: 'string' },
    instant: { type: 'boolean' },
  },
  required: ['refId', 'expr', 'datasourceId'],
};

export const TOOL_REGISTRY: Record<string, ToolRegistryEntry> = {
  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------
  'connectors_list': {
    category: 'always-on',
    schema: {
      name: 'connectors_list',
      description:
        'Enumerate configured connectors (id, backend type, signal kind, isDefault flag). Use for "what connectors do I have" type questions. For PICKING a connector to query against, prefer connectors_suggest — list is for browsing, suggest is for committing.',
      input_schema: {
        type: 'object',
        properties: {
          signalType: {
            type: 'string',
            enum: ['metrics', 'logs', 'changes'],
            description: 'Filter by signal kind. Omit to see all connectors.',
          },
        },
        required: [],
      },
    },
  },
  'connectors_suggest': {
    category: 'always-on',
    schema: {
      name: 'connectors_suggest',
      description:
        'Pick a connector for the current request. Pass the raw user message as userIntent — substring-matches name/environment/cluster, falls back to the isDefault row, surfaces AMBIGUOUS when multiple candidates and no hint. On AMBIGUOUS use ask_user with the returned alternatives as structured options. After picking (or user confirms), follow with connectors_pin so subsequent tool calls reuse the choice. Skip when only one connector of the right type exists.',
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
  'connectors_pin': {
    category: 'deferred',
    schema: {
      name: 'connectors_pin',
      description:
        'Stick a connector to this session. Subsequent tools that need a connector of the same backend type reuse it without re-suggesting. Use after the user picks one or confirms a high-confidence suggest match. Don\'t pin on cross-source compare requests — those need per-query overrides instead.',
      input_schema: {
        type: 'object',
        properties: {
          connectorId: { type: 'string', description: 'Connector id to pin' },
          type: { type: 'string', description: 'Backend type slot (default "prometheus")' },
        },
        required: ['connectorId'],
      },
    },
  },
  'connectors_unpin': {
    category: 'deferred',
    schema: {
      name: 'connectors_unpin',
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
  'metrics_query': {
    category: 'deferred',
    schema: {
      name: 'metrics_query',
      description:
        'Run an instant PromQL/MetricsQL query against a metrics connector. Returns up to 20 series at a specific timestamp (defaults to now). When analyzing what a panel currently shows, pass `time` set to the panel time-window end so the instant value matches the panel rather than "now". Validate complex queries with metrics_validate first when adding panels.',
      input_schema: {
        type: 'object',
        properties: {
          sourceId: { type: 'string', description: 'Connector id from connectors_list' },
          query: { type: 'string', description: 'Backend-native query (PromQL for prometheus, MetricsQL for victoria-metrics)' },
          time: { type: 'string', description: 'Optional ISO-8601 evaluation timestamp. Default: now. Use the panel time-window end when analyzing a panel.' },
        },
        required: ['sourceId', 'query'],
      },
    },
  },
  'metrics_range_query': {
    category: 'deferred',
    schema: {
      name: 'metrics_range_query',
      description:
        'Run a range PromQL/MetricsQL query over a time window. Returns each series as time-stamped points. When analyzing what a panel shows, pass `start` and `end` set to the panel time-window so the result matches the panel rather than "now"; otherwise default window is the last 60 minutes at 60s step.',
      input_schema: {
        type: 'object',
        properties: {
          sourceId: { type: 'string', description: 'Connector id from connectors_list' },
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
  'metrics_discover': {
    // always-on: it's the entry point for nearly every metrics workflow
    // (panel build, alert rule, investigation, ad-hoc query). Forcing a
    // tool_search round-trip before each one would add a useless turn to
    // the most common path. Lower-frequency cousins (metrics_validate,
    // metrics_range_query) stay deferred.
    category: 'always-on',
    schema: {
      name: 'metrics_discover',
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
          sourceId: { type: 'string', description: 'Connector id from connectors_list' },
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
  'metrics_validate': {
    category: 'deferred',
    schema: {
      name: 'metrics_validate',
      description:
        'Runs the query and reports the actual result shape (series count, labels present, sample values, and a flag when a by() grouping collapsed) so you can judge whether it returns what you intended — a query that merely runs is not necessarily correct. Use as the gate before dashboard_add_panels.',
      input_schema: {
        type: 'object',
        properties: {
          sourceId: { type: 'string', description: 'Connector id from connectors_list' },
          query: { type: 'string', description: 'Backend-native query expression to validate' },
        },
        required: ['sourceId', 'query'],
      },
    },
  },
  'panel_preview': {
    category: 'always-on',
    schema: {
      name: 'panel_preview',
      description:
        'Verify a panel spec against the live datasource BEFORE calling dashboard_add_panels. Runs each query as a range query, reports series counts + a tiny sample, flags viz/query mismatches (stat+rate, heatmap without by(le), bar with multi-series), and returns ok:false when any query failed or every query returned zero series. Use as step 5 of the panel-authoring protocol. The verify-gate around dashboard_add_panels runs the same check on the server; passing here keeps the gate green.',
      input_schema: {
        type: 'object',
        properties: {
          datasourceId: { type: 'string', description: 'Optional. Connector id; omit to use the session pin or workspace primary.' },
          panel: {
            type: 'object',
            description: 'Single panel spec to validate.',
            properties: {
              title: { type: 'string' },
              description: { type: 'string', description: 'One-line. Should start with "Q: <the question>" per the panel-authoring protocol.' },
              visualization: { type: 'string', enum: ['time_series', 'stat', 'bar', 'heatmap', 'gauge', 'table'] },
              queries: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    expr: { type: 'string', description: 'Backend-native query expression (PromQL).' },
                    legendFormat: { type: 'string' },
                    instant: { type: 'boolean' },
                  },
                  required: ['expr'],
                },
              },
              unit: { type: 'string', enum: [...PANEL_UNITS], description: 'Optional canonical display unit. Omit when unknown; panel_preview returns suggestedUnit.' },
            },
            required: ['title', 'visualization', 'queries'],
          },
          timeRange: {
            type: 'object',
            description: 'Time window to run queries against. Pass `{relative: "1h"}` for a relative span, or `{from, to}` for explicit epoch ms. Default 1h.',
          },
        },
        required: ['panel'],
      },
    },
  },
  'metric_explore': {
    category: 'always-on',
    schema: {
      name: 'metric_explore',
      description:
        'Render an interactive time-series chart inline in the chat. This is a UI side-effect — it paints pixels for the user, not just data for you to reason with.\n\n' +
        'USE ONLY when the user asked to SEE/SHOW/PLOT/CHART/VISUALIZE something, or when the trend/shape genuinely answers the question (a sudden spike, a flat line where there shouldn\'t be one). Concrete triggers: "show me CPU", "graph requests/sec", "what does latency look like", "画一下 / 看看走势 / 出个图".\n\n' +
        'DO NOT use for:\n' +
        '  - Existence checks ("有 X 指标吗", "是否有 ...") — use `metrics_discover` (kind=names with filter) instead.\n' +
        '  - Single-value checks ("当前 X 是多少", thresholds) — use `metrics_query` (instant query) instead.\n' +
        '  - Internal investigation where YOU need numbers to reason about, not pixels to show — use `metrics_query` / `metrics_range_query` (silent, no chart bubble).\n' +
        '  - "Substitute" charts when the asked-about metric doesn\'t exist — e.g. user asked about istio metrics, none found, do NOT render `up` or another tangentially related series to "show something". Just say "no istio metrics found" in text.\n' +
        '  - Persistent dashboards (use `dashboard_create`).\n\n' +
        'When you do use it: the chart appears in the chat on its own — do NOT describe the series contents in your reply. Just acknowledge what you queried in one line.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'PromQL expression' },
          timeRangeHint: { type: 'string', description: 'Time window hint: "1h" | "6h" | "24h" | "7d" | "since 14:00" | "30m around 14:23". Omit on follow-ups about the same incident/metric to inherit the previous chart\'s range automatically (a small note is surfaced if the prior chart is stale).' },
          datasourceId: { type: 'string', description: 'Connector id. Omit to use the primary metrics datasource for the workspace.' },
          metricKind: {
            type: 'string',
            enum: ['latency', 'counter', 'gauge', 'errors'],
            description: 'Optional explicit kind. Omit to let the server infer from the query (histogram_quantile→latency, rate()→counter, errors/5xx→errors, else gauge).',
          },
        },
        required: ['query'],
      },
    },
  },

  // -------------------------------------------------------------------------
  // Narrow per-shape metric discovery primitives — Read/Grep/Glob style.
  // Each does ONE specific lookup so the model's intent is unambiguous from
  // the tool name alone. The legacy `metrics_discover` collapse-tool stays
  // available; these are the preferred entry points for new discovery flows.
  // -------------------------------------------------------------------------
  'metrics_list_names': {
    category: 'deferred',
    schema: {
      name: 'metrics_list_names',
      description:
        'List metric names available on a metrics connector, optionally filtered by a JS-flavored case-insensitive regex via `match`. Use BEFORE drafting any PromQL when you are unsure whether a metric exists or what naming convention the cluster uses. Returns at most 500 names per call — refine `match` if truncated.',
      input_schema: {
        type: 'object',
        properties: {
          datasourceId: { type: 'string', description: 'Connector id. Omit to use the primary metrics datasource.' },
          match: { type: 'string', description: 'Optional case-insensitive regex applied to metric names (e.g. "http|grpc").' },
        },
        required: [],
      },
    },
  },
  'metrics_get_labels': {
    category: 'deferred',
    schema: {
      name: 'metrics_get_labels',
      description:
        'List the label keys present on a specific metric. Use to discover which dimensions a metric can be sliced by BEFORE writing a selector like `metric{label="value"}`. Never invent label names — query them here first.',
      input_schema: {
        type: 'object',
        properties: {
          datasourceId: { type: 'string', description: 'Connector id. Omit to use the primary metrics datasource.' },
          metricName: { type: 'string', description: 'The metric whose label keys to enumerate.' },
        },
        required: ['metricName'],
      },
    },
  },
  'metrics_get_label_values': {
    category: 'deferred',
    schema: {
      name: 'metrics_get_label_values',
      description:
        'Sample the values for ONE label on ONE metric. Use when you have a metric + label in hand and need to know which values to filter on (e.g. which values of `namespace` exist on `http_requests_total`). Returns at most `limit` values (default 50, max 500) plus a `truncated` flag.',
      input_schema: {
        type: 'object',
        properties: {
          datasourceId: { type: 'string', description: 'Connector id. Omit to use the primary metrics datasource.' },
          metricName: { type: 'string', description: 'The metric to scope to.' },
          label: { type: 'string', description: 'The label whose values to sample.' },
          limit: { type: 'integer', description: 'Max values to return (default 50, max 500).' },
        },
        required: ['metricName', 'label'],
      },
    },
  },
  'metrics_get_cardinality': {
    category: 'deferred',
    schema: {
      name: 'metrics_get_cardinality',
      description:
        'Count total series for a metric. Use to gauge whether a query will be cheap or fan out to thousands of series before you commit to it. Returns `{ seriesCount, truncated }` — `truncated` is true when the metric exceeds the internal pull cap (50k); treat the count as a lower bound in that case.',
      input_schema: {
        type: 'object',
        properties: {
          datasourceId: { type: 'string', description: 'Connector id. Omit to use the primary metrics datasource.' },
          metricName: { type: 'string', description: 'The metric whose total series count to report.' },
        },
        required: ['metricName'],
      },
    },
  },
  'metrics_sample_series': {
    category: 'deferred',
    schema: {
      name: 'metrics_sample_series',
      description:
        'Return a handful of current series for a metric, each with its full label set and current value. Use to confirm the shape of the data before writing a more complex query — answers "what does this metric actually look like right now?". Returns up to `limit` series (default 10, max 100).',
      input_schema: {
        type: 'object',
        properties: {
          datasourceId: { type: 'string', description: 'Connector id. Omit to use the primary metrics datasource.' },
          metricName: { type: 'string', description: 'The metric to sample.' },
          limit: { type: 'integer', description: 'Max series to return (default 10, max 100).' },
        },
        required: ['metricName'],
      },
    },
  },
  'metrics_find_related': {
    category: 'deferred',
    schema: {
      name: 'metrics_find_related',
      description:
        'Find other metrics that share label keys with this one — a proxy for "which metrics are produced by the same job / sidecar / exporter". Use during investigations to surface neighboring signals (e.g. given `http_request_duration_seconds`, returns `http_requests_total`, `http_request_size_bytes`, ...). Ranked by number of shared label keys (not values). Structural labels (`le`, `quantile`) are ignored.',
      input_schema: {
        type: 'object',
        properties: {
          datasourceId: { type: 'string', description: 'Connector id. Omit to use the primary metrics datasource.' },
          metricName: { type: 'string', description: 'The seed metric.' },
          limit: { type: 'integer', description: 'Max related metrics to return (default 10, max 50).' },
        },
        required: ['metricName'],
      },
    },
  },

  // -------------------------------------------------------------------------
  // Logs primitives (read-only, source-agnostic). The query string is backend-native.
  // -------------------------------------------------------------------------
  'logs_query': {
    category: 'deferred',
    schema: {
      name: 'logs_query',
      description:
        'Run a logs query (LogQL for Loki, ES DSL for Elasticsearch, etc.) over an explicit ISO-8601 window. Returns "[timestamp] {labels} message" lines, truncated to keep observations compact.',
      input_schema: {
        type: 'object',
        properties: {
          sourceId: { type: 'string', description: 'Connector id from connectors_list (signalType=logs)' },
          query: { type: 'string', description: 'Backend-native logs query' },
          start: { type: 'string', description: 'ISO-8601 start timestamp (required)' },
          end: { type: 'string', description: 'ISO-8601 end timestamp (required)' },
          limit: { type: 'integer', description: 'Max log entries to return (1-1000)' },
        },
        required: ['sourceId', 'query', 'start', 'end'],
      },
    },
  },
  'logs_labels': {
    category: 'deferred',
    schema: {
      name: 'logs_labels',
      description: 'List available log labels for a logs connector. Use for discovery before constructing selectors.',
      input_schema: {
        type: 'object',
        properties: {
          sourceId: { type: 'string', description: 'Connector id from connectors_list (signalType=logs)' },
        },
        required: ['sourceId'],
      },
    },
  },
  'logs_label_values': {
    category: 'deferred',
    schema: {
      name: 'logs_label_values',
      description: 'List values for a log label (e.g. all values of "namespace"). Truncated to 50 with a "more" hint.',
      input_schema: {
        type: 'object',
        properties: {
          sourceId: { type: 'string', description: 'Connector id from connectors_list (signalType=logs)' },
          label: { type: 'string', description: 'Log label name' },
        },
        required: ['sourceId', 'label'],
      },
    },
  },

  // -------------------------------------------------------------------------
  // Changes (read-only) — recent deploys, config rollouts, incidents, flag flips.
  // -------------------------------------------------------------------------
  'changes_list_recent': {
    category: 'deferred',
    schema: {
      name: 'changes_list_recent',
      description:
        'List recent change events (deploys, config rollouts, feature-flag flips, incidents). Use early in investigations to correlate anomalies with known changes. If sourceId is omitted, the first registered change-event connector is used.',
      input_schema: {
        type: 'object',
        properties: {
          sourceId: { type: 'string', description: 'Connector id (signalType=changes). Omit to use the first configured change source.' },
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
  'ops_run_command': {
    category: 'always-on',
    schema: {
      name: 'ops_run_command',
      description:
        'Run a shell command against a Kubernetes/Ops connector. Use whenever the user asks to inspect or operate on cluster state and a connectorId is known.\n\n' +
        'REAL SHELL — `command` runs as `sh -c "<command>"` with the connector\'s kubeconfig exported as KUBECONFIG. All shell features work: pipes (`|`), redirects (`>`/`<`/`>>`), chaining (`&&`, `||`, `;`), command substitution (`$(...)`, backticks), quoting, heredocs, env vars. Use `--flag=value` form when the value starts with `-` (e.g. `--tail=20`, not `--tail -20`). The runner image carries kubectl, curl, jq, grep, awk, sed, head, tail.\n\n' +
        'Confirmation is automatic: any command whose pattern looks mutating (kubectl apply/create/patch/delete/scale/exec/edit/rollout/cordon/drain/…, or shell rm/mv/dd/mkfs, or output redirect to `/`) triggers a Yes/No card before execution. Pure read commands (kubectl get/describe/logs/top/events/version/api-resources/explain) run immediately. The `intent` field is the model\'s declared expectation but the pattern check is authoritative.\n\n' +
        'Exit codes are DATA, not failure. The tool returns stdout as the observation; if exit≠0 or stderr was non-empty, a footer like `[stderr: ... | exit: 1]` is appended. Non-zero exits are normal for chains (`a && b` where b is the speculative part), fallbacks (`a || b`), greps that miss, `kubectl get` on a resource that doesn\'t exist, etc. Read the stdout — if you got the data you wanted, you\'re done; don\'t retry just because the footer shows exit≠0.\n\n' +
        'intent="read" — declare when the command only inspects state. Safe during investigation; treat like a metrics query.\n' +
        'intent="propose" — declare when the command is mutating. Surfaces the confirmation card promptly.\n' +
        'intent="execute_approved" — reserved for the confirmation route. Never invoke this directly from a chat or investigation turn.\n\n' +
        'When to choose `ops_cluster_shell` instead: the command needs a tool not on the api-gateway image (istioctl, helm, an operator installer), or it has to run with the cluster\'s in-cluster network/SA. For everything else (kubectl chains, jq pipelines, looking at logs/events), prefer this tool — startup is instant; cluster_shell spins up a Job pod and pays 10-30s latency.',
      input_schema: {
        type: 'object',
        properties: {
          connectorId: { type: 'string', description: 'Ops connector id configured in Settings' },
          command: { type: 'string', description: 'The exact kubectl/ops command to run or propose' },
          intent: {
            type: 'string',
            enum: ['read', 'propose', 'execute_approved'],
            description: 'read runs safe inspection commands; propose requests a confirmed write; execute_approved is reserved for internal executors.',
          },
        },
        required: ['connectorId', 'command', 'intent'],
      },
    },
  },
  'ops_cluster_shell': {
    category: 'always-on',
    schema: {
      name: 'ops_cluster_shell',
      description:
        'Request a confirmed shell operation inside a Kubernetes cluster through a configured connector. Use this for direct user requests that are not kubectl-shaped: installing Istio with istioctl/helm, running a bootstrap script, applying an operator installer, or other one-shot cluster scripts.\n\n' +
        'This is the interactive chat path: the runtime checks the caller permission, then shows a Yes/No confirmation card before execution. Do not create a remediation plan for a direct user chat request.\n\n' +
        'scope="namespace" runs the Job in the target namespace and requires namespace. scope="cluster" runs in the bootstrap namespace using the cluster bootstrap service account and should be reserved for cluster-wide installs/CRDs/controllers.',
      input_schema: {
        type: 'object',
        properties: {
          connectorId: { type: 'string', description: 'Kubernetes/Ops connector id configured in Settings.' },
          script: { type: 'string', description: 'Shell script body to execute as `sh -c` inside a one-shot Job.' },
          scope: { type: 'string', enum: ['cluster', 'namespace'], description: 'Blast radius for the one-shot Job.' },
          namespace: { type: 'string', description: 'Required when scope="namespace".' },
          image: { type: 'string', description: 'Optional Job runner image. LEAVE UNSET in almost all cases — the default image (`alpine/k8s:1.29.0`) already has kubectl, curl, sh, and jq pre-installed and works for installer scripts like istioctl/helm/kubectl chains. Only override when the script needs a tool that is not in the default image (e.g. a vendor-specific CLI baked into a specific image). Picking something narrower like `curlimages/curl` will break any kubectl/sh step later in the script.' },
        },
        required: ['connectorId', 'script', 'scope'],
      },
    },
  },
  // -------------------------------------------------------------------------
  // Remediation plans (Phase 4 of docs/design/auto-remediation.md). The agent
  // emits these AFTER `investigation_complete` when a fix is concrete and in
  // scope of an attached connector. The plan is the unit of approval; steps
  // are the unit of execution. Never run write commands from the
  // investigation turn — propose them in a plan instead.
  // -------------------------------------------------------------------------
  'remediation_plan_create': {
    category: 'always-on',
    schema: {
      name: 'remediation_plan_create',
      description:
        'Propose a structured remediation plan: an ordered list of write steps the operator approves once and then executes atomically.\n\n' +
        'BACKGROUND ONLY: use this after an alert-triggered background investigation completes with a concrete, in-scope fix. Direct user chat requests must not use remediation plans; interactive writes are handled by permission checks plus user confirmation.\n\n' +
        'Evidence gate: the latest saved investigation report must have a passed root-cause evidence gate. The root cause must be directly supported by recorded checks, competing explanations must be ruled out, time/scope relevance must be established, the plan target must match the verified root-cause object/field, and the plan must include an explicit validation step. Missing or unresolved evidence rejects the plan before persistence.\n\n' +
        'LOW COST: this tool does NOT execute anything. It creates a pending_approval plan record and a plan-level ApprovalRequest; a human must open the approval and click Approve before any plan step runs. Treat calling this tool as equivalent to saving a draft for review.\n\n' +
        'Skip ONLY when: the user explicitly asked to stop after diagnosis; the fix needs credentials no configured connector has; the right next step isn\'t executable here (data migration, code change, ask upstream); the safe action is monitor + re-check.\n\n' +
        'Step ordering: reads/verifications first, then writes, then a final `kubectl rollout status` (or equivalent) verification step where it makes sense. Halt-on-failure is the default; only set continueOnError=true on truly non-critical steps (notification, optional cleanup).',
      input_schema: {
        type: 'object',
        properties: {
          investigationId: { type: 'string', description: 'Id from the saved investigation that motivated this background remediation plan. Required; its latest report must have passed the root-cause evidence gate.' },
          summary: { type: 'string', description: 'One-line description of what the plan does. Surfaced in approval UI.' },
          targetObject: { type: 'string', description: 'Specific object/field this plan changes. Must match the verified root-cause object/field on the linked investigation.' },
          validationMethod: { type: 'string', description: 'How the operator should verify the plan worked after execution. Must name the check, metric, log, query, or observable result.' },
          steps: {
            type: 'array',
            description: 'Ordered list of steps. The order is the execution order. Halt-on-failure by default.',
            items: {
              type: 'object',
              properties: {
                kind: {
                  type: 'string',
                  enum: ['ops.run_command', 'ops.cluster_shell'],
                  description:
                    'Step kind. `ops.run_command` = a single kubectl invocation (default — use it whenever a kubectl-shaped fix works). `ops.cluster_shell` = a shell script executed in a one-shot Job inside the cluster, for operations that kubectl alone can\'t express (e.g. `istioctl install`, `helm install`, `curl | sh` bootstraps). Prefer ops.run_command when both are viable.',
                },
                commandText: { type: 'string', description: 'Human-readable command, e.g. "kubectl scale deploy/web -n app --replicas=3" or "istioctl install --set profile=demo". Surfaced verbatim to the approver.' },
                paramsJson: {
                  type: 'object',
                  description:
                    'Structured args; shape depends on `kind`.\n' +
                    'ops.run_command: { argv: string[] (kubectl tokens WITHOUT "kubectl"), connectorId: string }.\n' +
                    'ops.cluster_shell: { script: string (run as `sh -c "<script>"`), scope: "cluster"|"namespace", namespace?: string (required when scope=namespace), image?: string (defaults to a kubectl+curl image), connectorId: string }.',
                  properties: {
                    argv: { type: 'array', items: { type: 'string' }, description: 'kubectl argv tokens (ops.run_command only).' },
                    script: { type: 'string', description: 'Shell script body (ops.cluster_shell only).' },
                    scope: { type: 'string', enum: ['cluster', 'namespace'], description: 'Blast radius (ops.cluster_shell only). Picks the policy gate: `cluster` hits runtime.cluster_shell.cluster (cluster-admin approval); `namespace` hits runtime.cluster_shell.namespace (inline confirm).' },
                    namespace: { type: 'string', description: 'Target namespace for scope="namespace" (ops.cluster_shell only).' },
                    image: { type: 'string', description: 'Container image for the Job (ops.cluster_shell only). Defaults to a kubectl+curl-capable image.' },
                    connectorId: { type: 'string', description: 'ops connector id (both kinds).' },
                  },
                  required: ['connectorId'],
                },
                dryRunText: { type: 'string', description: 'Optional. The expected effect of this step in plain text. Include how the verified root-cause object/field should change when useful.' },
                riskNote: { type: 'string', description: 'Optional. Human-readable risk note ("brief drop to 2 replicas"). Surfaced in the approval UI.' },
                continueOnError: { type: 'boolean', description: 'If true, plan continues if this step fails. Default false (halt). Use for non-critical steps like notifications.' },
              },
              required: ['kind', 'commandText', 'paramsJson'],
            },
          },
          expiresInMs: { type: 'number', description: 'Optional. Override the default approval window (24h) in milliseconds.' },
        },
        required: ['investigationId', 'summary', 'targetObject', 'validationMethod', 'steps'],
      },
    },
  },
  'remediation_plan_create_rescue': {
    category: 'deferred',
    schema: {
      name: 'remediation_plan_create_rescue',
      description:
        'Propose a rescue/undo plan paired with a primary plan, to be invoked manually by an operator if the primary fails. Same shape as remediation_plan_create plus rescueForPlanId — including the required targetObject and validationMethod fields; the same root-cause evidence gate applies. Does NOT auto-create an ApprovalRequest; rescue plans are triggered on demand from the UI.\n\n' +
        'Pair with the primary plan ONLY when each primary write step is reasonably reversible AND you know the exact undo (scale up→down, replicas, env-var flip, ConfigMap patch, image rollback to a known-good tag).\n\n' +
        'Skip rescue for inherently irreversible primary steps (`kubectl delete <unique resource>`, manual data migration, schema change). A wrong undo is worse than no undo — silence beats fabrication.\n\n' +
        'Rescue plans don\'t auto-approve and don\'t auto-run. They sit in storage; an operator triggers them from the UI only after the primary fails.',
      input_schema: {
        type: 'object',
        properties: {
          rescueForPlanId: { type: 'string', description: 'Id of the primary plan this rescue undoes.' },
          investigationId: { type: 'string', description: 'Same investigation that produced the primary plan.' },
          summary: { type: 'string', description: 'One-line description of the rollback action.' },
          targetObject: { type: 'string', description: 'Specific object/field this plan changes. Must match the verified root-cause object/field on the linked investigation.' },
          validationMethod: { type: 'string', description: 'How the operator should verify the rollback worked after execution. Must name the check, metric, log, query, or observable result.' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['ops.run_command'] },
                commandText: { type: 'string' },
                paramsJson: {
                  type: 'object',
                  properties: {
                    argv: { type: 'array', items: { type: 'string' } },
                    connectorId: { type: 'string' },
                  },
                  required: ['argv', 'connectorId'],
                },
                dryRunText: { type: 'string' },
                riskNote: { type: 'string' },
                continueOnError: { type: 'boolean' },
              },
              required: ['kind', 'commandText', 'paramsJson'],
            },
          },
        },
        required: ['rescueForPlanId', 'investigationId', 'summary', 'targetObject', 'validationMethod', 'steps'],
      },
    },
  },

  // -------------------------------------------------------------------------
  // Dashboard lifecycle + mutation primitives
  // -------------------------------------------------------------------------
  'dashboard_create': {
    category: 'always-on',
    schema: {
      name: 'dashboard_create',
      description:
        'Prepare a new dashboard draft. It is not persisted or shown to the user until dashboard_add_panels succeeds with real content. Follow with dashboard_add_panels to create and populate it in one step. Required before any other dashboard.* mutation when there is no current dashboard context. Requires a primary datasourceId — pick one via connectors_suggest first (or reuse the session pin if set).',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Dashboard title shown in the UI' },
          description: { type: 'string', description: 'One-line description of the dashboard purpose' },
          prompt: { type: 'string', description: 'Optional original user prompt for traceability (defaults to description)' },
          datasourceId: {
            type: 'string',
            description:
              'Primary connector id for this dashboard. Panels added without their own per-query datasourceId fall back to this. Get from connectors_list / connectors_suggest.',
          },
        },
        required: ['title', 'datasourceId'],
      },
    },
  },
  'dashboard_list': {
    category: 'always-on',
    schema: {
      name: 'dashboard_list',
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
  'dashboard_clone': {
    category: 'always-on',
    schema: {
      name: 'dashboard_clone',
      description:
        "Clone a dashboard, replacing every query's datasourceId with targetDatasourceId. Use when the user says 'copy/move/clone this dashboard to {env}' — far cheaper than rebuilding from scratch.",
      input_schema: {
        type: 'object',
        properties: {
          sourceDashboardId: { type: 'string', description: 'Dashboard id to clone (from dashboard_list)' },
          targetDatasourceId: { type: 'string', description: 'Connector id assigned to every query in the new dashboard' },
          newTitle: { type: 'string', description: 'Optional title for the new dashboard. Defaults to "{sourceTitle} (cloned)"' },
        },
        required: ['sourceDashboardId', 'targetDatasourceId'],
      },
    },
  },
  'dashboard_add_panels': {
    category: 'always-on',
    schema: {
      name: 'dashboard_add_panels',
      description:
        'Add one or more panels to a dashboard. By default targets the active dashboard (set by dashboard_create / dashboard_clone / current page context). To target a different existing dashboard, pass `dashboardId` — call `dashboard_list` first to resolve the id by name before doing so. The model constructs panel configs directly (title, visualization, queries, unit, ...). Panel sizing and layout are auto-applied. Every query must carry an explicit datasourceId — there is NO inheritance from the dashboard primary. For a single-source dashboard, set every query to the dashboard primary id. For cross-source compare panels, set per query (one source per query). The handler rejects panels with any missing datasourceId.\n\n' +
        'PRE-FLIGHT: if the dashboard targets a NAMED system (Redis, Kafka, Postgres, nginx, Istio, ...) call kb_recommend FIRST, then kb_get any relevant result and use that body as the canonical metric/layout source. Call web_search only after KB returns no relevant entry. Carve-out: skip KB only when the exact metric names and layout you are about to use are already quoted in the current conversation.\n\n' +
        'Skipping the pre-flight is the dominant failure mode: training-data priors invent plausible-looking names → metrics_validate rejects → re-plan → wasted turns. KB lookups are cheap and bundled entries are the source of truth for common stacks.\n\n' +
        'Validate every non-trivial query through metrics_validate before this call. The handler rejects unvalidated queries. If the user asks for several distinct dashboard areas, create and populate one focused dashboard at a time instead of combining them into one oversized dashboard.\n\n' +
        'UNIT: any rate(*_cpu_seconds_total) panel MUST use unit="percent" AND multiply the whole expression by 100. Raw cores are sub-1 (e.g. 0.05) and the chart axis collapses to "0.00 0.00 0.00" — unreadable. Applies whether the title says "rate", "usage", "utilization", etc. Other unit conventions: bytes-per-second = "Bps", seconds = "s", raw bytes = "bytes". If the value is not a known quantity, omit unit (renderer uses "short").',
      input_schema: {
        type: 'object',
        properties: {
          dashboardId: {
            type: 'string',
            description:
              'Optional target dashboard id. Use this when the user names an existing dashboard found via dashboard_list and the current page context is not that dashboard. Passing this also makes the named dashboard the active target for subsequent dashboard.* tool calls in this turn.',
          },
          panels: {
            type: 'array',
            description: 'Panel configs. datasourceId is REQUIRED per query. unit is optional; use only known metric unit metadata or omit it.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                visualization: { type: 'string', enum: [...PANEL_VISUALIZATIONS] },
                queries: {
                  type: 'array',
                  items: PANEL_QUERY_SCHEMA,
                },
                unit: { type: 'string', enum: [...PANEL_UNITS], description: 'Optional canonical display unit. Omit when unknown instead of guessing.' },
                stackMode: { type: 'string', enum: ['none', 'normal', 'percent'] },
                fillOpacity: { type: 'number' },
                decimals: { type: 'number' },
                thresholds: {
                  type: 'array',
                  description: 'Threshold lines. Each entry is { value: number, color: string, label?: string } — a single value, not a range. Do NOT use Grafana-style { from, to } shape.',
                  items: {
                    type: 'object',
                    properties: {
                      value: { type: 'number' },
                      color: { type: 'string' },
                      label: { type: 'string' },
                    },
                    required: ['value', 'color'],
                  },
                },
                sparkline: { type: 'boolean' },
                colorMode: { type: 'string', enum: ['value', 'background', 'none'] },
                graphMode: { type: 'string', enum: ['none', 'area'] },
                lineWidth: { type: 'number' },
                legendStats: {
                  type: 'array',
                  items: { type: 'string', enum: ['last', 'mean', 'max', 'min'] },
                  description:
                    'Optional. Omit (or set []) to use the dense default of just the most recent value per series - matches Grafana density and keeps the chart from being squeezed by a stat table. Only set explicitly (e.g. ["mean","max","last"]) when the user asks to see multiple aggregates side by side. The render layer will trim multi-stat configs on narrow/short panels automatically.',
                },
                legendPlacement: { type: 'string', enum: ['bottom', 'right'] },
                colorScale: { type: 'string', enum: ['linear', 'sqrt', 'log'] },
                showPoints: { type: 'string', enum: ['auto', 'never'] },
                yScale: {
                  type: 'string',
                  enum: ['linear', 'log'],
                  description:
                    'yScale controls the y-axis scale. Default linear. Use `log` when the query spans more than ~1000x dynamic range and linear would compress the smaller values into a flat line — typical triggers: `histogram_quantile(*, 0.99)` / `0.999` latency tails, single panel showing p50 + p99 + p999 together, or error/retry counters across many orders of magnitude. Keep `linear` for CPU%, memory bytes, QPS, ratios, and other bounded or single-order-of-magnitude quantities.',
                },
                collapseEmptyBuckets: { type: 'boolean' },
                barGaugeMax: { type: 'number' },
                barGaugeMode: { type: 'string', enum: ['gradient', 'lcd'] },
                annotations: { type: 'array', items: { type: 'object' } },
              },
              required: ['title', 'visualization', 'queries'],
            },
          },
        },
        required: ['panels'],
      },
    },
  },
  'dashboard_remove_panels': {
    category: 'always-on',
    schema: {
      name: 'dashboard_remove_panels',
      description: 'Remove one or more panels from the active dashboard by id. Verify panel ids from the Dashboard State context first.',
      input_schema: {
        type: 'object',
        properties: {
          panelIds: {
            type: 'array',
            description: 'Ids of panels to remove',
            items: { type: 'string' },
          },
        },
        required: ['panelIds'],
      },
    },
  },
  'dashboard_modify_panel': {
    category: 'always-on',
    schema: {
      name: 'dashboard_modify_panel',
      description:
        'Patch fields on an existing panel of the active dashboard (title, queries, visualization, unit, thresholds, …). Provide only the keys to change; everything else on the panel is preserved.',
      input_schema: {
        type: 'object',
        properties: {
          panelId: { type: 'string', description: 'Panel id to modify (from the Dashboard State context)' },
          title: { type: 'string', description: 'Optional new title' },
          description: { type: 'string', description: 'Optional new description' },
          visualization: { type: 'string', description: 'Optional visualization change (time_series, stat, gauge, ...)' },
          queries: { type: 'array', description: 'Optional replacement query list. Each replacement query must include refId, expr, and datasourceId.', items: PANEL_QUERY_SCHEMA },
          unit: { type: 'string', enum: [...PANEL_UNITS], description: 'Optional canonical value unit. Omit when unknown instead of guessing.' },
        },
        required: ['panelId'],
      },
    },
  },
  'dashboard_rearrange': {
    category: 'always-on',
    schema: {
      name: 'dashboard_rearrange',
      description:
        'Reorder the active dashboard panels in place. Use this for layout/rearrangement requests instead of removing and re-adding panels, because remove+add destroys panel ids and queries. Pass panelIds in the desired display order after checking the Dashboard State for current ids; any panels you omit keep their current relative order and are placed after the listed panels.',
      input_schema: {
        type: 'object',
        properties: {
          panelIds: {
            type: 'array',
            description: 'Panel ids in desired display order. Omitted existing panels keep relative order after these.',
            items: { type: 'string' },
          },
        },
        required: ['panelIds'],
      },
    },
  },
  'dashboard_set_title': {
    category: 'always-on',
    schema: {
      name: 'dashboard_set_title',
      description: 'Update the active dashboard\'s title and (optionally) description. Use for renaming an existing dashboard.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'New title' },
          description: { type: 'string', description: 'Optional new description' },
        },
        required: ['title'],
      },
    },
  },
  'dashboard_lint': {
    category: 'always-on',
    schema: {
      name: 'dashboard_lint',
      description:
        'Validate a drafted DashboardSpec against the built-in rule set (data presence, label validity, unit/viz match, histogram_quantile form, grouping cardinality, duplicate-query detection, panel-as-question discipline, time-range sanity, ...). Returns a flat list of issues; each has a severity (`error` | `warn` | `info`), `ruleName`, optional `panelId`, message, and a fixHint.\n\n' +
        'Call this AFTER drafting panels and BEFORE saving. Treat every `error` as blocking — fix the cause and re-lint. For `warn`-severity issues, either fix or briefly justify why the warning is acceptable for this dashboard. `info` is advisory.\n\n' +
        'When no metrics connector is wired, query-execution rules (panel-returns-data, query-uses-known-labels, high-cardinality-grouping) self-skip with a single `info`-severity issue per skipped rule; the pure structural rules still run.',
      input_schema: {
        type: 'object',
        properties: {
          spec: {
            type: 'object',
            description: 'The full DashboardSpec to lint — panels[], variables[], refreshIntervalSec, etc. Pass the exact shape you intend to save.',
          },
          datasourceId: {
            type: 'string',
            description: 'Connector id used for query/label/cardinality probes. Omit to use the session-pinned metrics connector or the default.',
          },
          only: {
            type: 'array',
            description: 'Optional allowlist of rule names; when set only these rules run.',
            items: { type: 'string' },
          },
          skip: {
            type: 'array',
            description: 'Optional denylist of rule names to exclude. Applied after `only`.',
            items: { type: 'string' },
          },
        },
        required: ['spec'],
      },
    },
  },
  'dashboard_add_variable': {
    category: 'always-on',
    schema: {
      name: 'dashboard_add_variable',
      description:
        'Add a template variable ($variable) to the active dashboard for drill-down. Only use when the user explicitly asks for filtering by a label.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Variable name (without the leading $)' },
          label: { type: 'string', description: 'Display label shown in the UI (defaults to name)' },
          type: {
            type: 'string',
            enum: ['query', 'custom', 'datasource'],
            description: 'Variable kind. "query" runs a label_values query; "custom" uses a static option list; "datasource" picks a connector.',
          },
          query: { type: 'string', description: 'For type=query: a label_values(metric, label) expression' },
          multi: { type: 'boolean', description: 'Allow multi-select' },
          includeAll: { type: 'boolean', description: 'Include an "All" option' },
        },
        required: ['name'],
      },
    },
  },

  // -------------------------------------------------------------------------
  // Folder lifecycle — organize dashboards/alerts. The handler runs against
  // the configured folder backend (Grafana-shaped today).
  // -------------------------------------------------------------------------
  'folder_create': {
    category: 'deferred',
    schema: {
      name: 'folder_create',
      description:
        'Create a folder for organizing dashboards or alert rules. Returns the new folder uid. Use ONLY when the user explicitly asks to create a folder; do NOT pre-create folders for dashboard_create / alert_rule_write (those default to wildcard / "alerts" when folderUid is omitted).',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Folder title shown in the UI' },
          parentUid: { type: 'string', description: 'Optional parent folder uid for nested folders. Omit for top-level.' },
        },
        required: ['title'],
      },
    },
  },
  'folder_list': {
    category: 'deferred',
    schema: {
      name: 'folder_list',
      description:
        'List folders. Use when the user asks "what folders exist" or to discover a folderUid to pass into dashboard_create / alert_rule_write.',
      input_schema: {
        type: 'object',
        properties: {
          parentUid: { type: 'string', description: 'Optional parent uid to list children of one folder. Omit for top-level.' },
          limit: { type: 'integer', description: 'Maximum rows to return (default 50)' },
        },
        required: [],
      },
    },
  },

  // -------------------------------------------------------------------------
  // Investigation lifecycle
  // -------------------------------------------------------------------------
  'investigation_create': {
    category: 'always-on',
    schema: {
      name: 'investigation_create',
      description:
        'Start a new investigation draft for a "why is X" question. The persisted investigation record is created only when investigation_complete saves the report.\n\n' +
        'Trigger on diagnostic intents: "why is X" / "investigate X" / "diagnose X" / "排查 X" / "为什么 X 这么慢/高/坏". Do NOT trigger on read intents like "show me X", "what\'s the value of X", "list X" — those are queries, not investigations.\n\n' +
        'Call this at the START of the diagnosis, BEFORE running discovery queries. Investigation sections should capture the actual reasoning trace; if you query first then create the record, the record only contains the writeup, not the live trail.',
      input_schema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question being investigated, e.g. "Why is p99 latency high?"' },
        },
        required: ['question'],
      },
    },
  },
  'investigation_list': {
    category: 'deferred',
    schema: {
      name: 'investigation_list',
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
  'investigation_add_text': {
    category: 'deferred',
    schema: {
      name: 'investigation_add_text',
      description:
        'Append a narrative (markdown) section to the active investigation. Use for the prose that interprets what you just observed: one beat of reasoning per call.\n\n' +
        'Interleave with queries — query → add_text interpreting it → next query → next add_text — so the report reads as the reasoning that actually happened, not a batch dump.\n\n' +
        'Every section MUST start with a short `## heading` that names the beat (e.g. `## Symptom`, `## Ruling out load`, `## Hotspot: /foo`). Free-form headings — fit them to the actual content, don\'t reflexively reach for "## Initial Assessment".\n\n' +
        'For chart-backed findings call `investigation_add_evidence` instead. Every investigation needs at least one evidence section — pure prose alone is incomplete.',
      input_schema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'Markdown. Start with `## heading`. Substantial paragraphs of analysis with specific numbers inline.',
          },
        },
        required: ['content'],
      },
    },
  },
  'investigation_record_check': {
    category: 'deferred',
    schema: {
      name: 'investigation_record_check',
      description:
        'Record one load-bearing diagnostic check in the active investigation ledger. This is the investigation control plane: call it after every important metrics/logs/ops/changes/web/kb read before you move on or complete.\n\n' +
        'Use it to say which hypothesis the read tested, what signal type it was, what came back, whether that supports/rules out/is inconclusive, the scope it covers (time window and/or affected objects), and the next best check. This is how the main loop keeps its investigation state current while it follows the evidence.\n\n' +
        'Do not use this for prose. Use investigation_add_text for the human-facing report; use investigation_record_check for the structured reasoning state.',
      input_schema: {
        type: 'object',
        properties: {
          hypothesis: { type: 'string', description: 'The hypothesis this check tested, e.g. "component A is returning errors because config value B is invalid".' },
          signalType: {
            type: 'string',
            enum: ['metric', 'log', 'kubernetes', 'change', 'trace', 'config', 'knowledge', 'web', 'other'],
            description: 'Independent signal class used by this check.',
          },
          tool: { type: 'string', description: 'The read tool just used, e.g. metrics_range_query, logs_query, ops_run_command.' },
          query: { type: 'string', description: 'PromQL/log query/kubectl command/search phrase. Empty only when the tool had no query string.' },
          result: { type: 'string', description: 'Specific observed result with numbers/object names/statuses, not vague prose.' },
          interpretation: { type: 'string', description: 'What this result means for the hypothesis and the investigation.' },
          status: {
            type: 'string',
            enum: ['supported', 'ruled_out', 'inconclusive'],
            description:
              'Whether this check supports, rules out, or leaves the hypothesis inconclusive. '
              + 'Use "ruled_out" ONLY when data came back and that data contradicts the hypothesis. '
              + 'If the source was missing, unconfigured, empty, or errored, the hypothesis is "inconclusive" — '
              + 'not being able to look is not the same as having looked and found nothing. '
              + 'Deploys and config changes cause most incidents, so silently downgrading "I could not check for changes" '
              + 'into "changes are ruled out" is the single most expensive mistake available here.',
          },
          scope: {
            type: 'object',
            description: 'What this check actually covers. Set at least one of the two fields — the evidence gate reads them as fields, not from your prose.',
            properties: {
              timeWindow: { type: 'string', description: 'Time range this observation covers, e.g. "2026-07-20T10:00Z..11:00Z" or "last 30m".' },
              affected: { type: 'string', description: 'Objects/namespace/service/tenant the observation is scoped to, e.g. "deploy/reviews-v2 in namespace prod".' },
            },
          },
          nextCheck: { type: 'string', description: 'The next best uncertainty-reducing check, if any.' },
        },
        required: ['hypothesis', 'signalType', 'tool', 'result', 'interpretation', 'status', 'scope'],
      },
    },
  },
  'investigation_add_evidence': {
    category: 'deferred',
    schema: {
      name: 'investigation_add_evidence',
      description:
        'Attach a chart panel (with auto-captured snapshot) to the active investigation as evidence for the surrounding analysis. EVERY investigation needs 1-4 evidence calls — a pure-text report is incomplete; readers can\'t verify the reasoning without the data.\n\n' +
        'Reuse the query you just ran: take the `metrics_range_query` or `metrics_query` expr you just executed and pass it as `panel.queries[0].expr`. The system captures the snapshot automatically — you don\'t provide data, only the query.\n\n' +
        'When citing this evidence inline in subsequent text, reference it with a bracketed token (`[m1]`, `[l1]`, `[k1]`, `[c1]`) — UI renders clickable chips.',
      input_schema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'Short caption interpreting the chart (e.g. "p99 by handler — /api/v1/query_range dominates at 120ms").',
          },
          panel: {
            type: 'object',
            description: 'Chart spec. The system fills in the data automatically — you only provide title + visualization + queries.',
            properties: {
              title: { type: 'string', description: '5-8 words naming the chart.' },
              visualization: {
                type: 'string',
                enum: ['time_series', 'stat', 'bar', 'heatmap', 'gauge', 'pie', 'table', 'bar_gauge', 'histogram', 'status_timeline'],
                description: '`time_series` for trends, `stat` for one big number, `bar` for top-N.',
              },
              queries: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    refId: { type: 'string' },
                    expr: { type: 'string', description: 'The PromQL/MetricsQL you ran — usually the same expr from a recent metrics_range_query.' },
                    legendFormat: { type: 'string' },
                    instant: { type: 'boolean' },
                  },
                  required: ['expr'],
                },
              },
              unit: { type: 'string', description: 'Display unit (e.g. "ms", "reqps", "percent", "bytes"). Omit if unknown.' },
            },
            required: ['title', 'visualization', 'queries'],
          },
        },
        required: ['content', 'panel'],
      },
    },
  },
  'investigation_complete': {
    category: 'deferred',
    schema: {
      name: 'investigation_complete',
      description:
        'Finalize the active investigation, save the report, and navigate to it. Implicitly targets the investigation_create record from this session. Call this only after the same main loop has already followed the evidence, recorded the load-bearing checks, and written the report sections.\n\n' +
        'MUST be the LAST tool call of any investigation turn. If you end with plain text without calling investigation_complete, every section is discarded and the user sees nothing — this is the single most common investigation failure.\n\n' +
        'The summary is the executive summary shown above the report. One paragraph stating the conclusion + the most likely cause. Do not duplicate the section bodies.\n\n' +
        'For confirmed/likely root causes: use at least 80% confidence (confidence >= 0.8), rootCause.object and rootCause.cause must name the specific changeable object/value/config/rollout, evidenceRefs must point to at least two recorded check ids across at least two signal types, and ruledOut must include plausible alternatives you eliminated. The server evidence gate also requires: direct proof for the root-cause object/cause, recorded handling of competing explanations, at least one referenced check carrying a `scope.timeWindow` or `scope.affected` value, a repair target consistent with the proven root cause, and a non-empty `validationMethod` on this call (validation wording buried in nextAction/rootCause.nextCheck does NOT count). If any of these are missing, the report is saved as unresolved and cannot back an approvable remediation plan. For unresolved investigations: set rootCause.status="unresolved" and provide rootCause.nextCheck.\n\n' +
        'The nextAction must be durable: it should fix the bad pattern or lifecycle issue, not just substitute the current observed value. If an emergency workaround exists, label it as temporary mitigation and still name the durable fix or prevention. Never recommend hardcoding an ephemeral runtime value, generated identifier, transient endpoint, or one-off observed value as the primary remediation.\n\n' +
        'Order: investigation_complete FIRST, then (optionally) remediation_plan_create, then your final plain-text reply.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One-paragraph executive summary of the conclusion' },
          rootCause: {
            type: 'object',
            properties: {
              status: {
                type: 'string',
                enum: ['confirmed', 'likely', 'unresolved'],
                description: 'Use confirmed/likely only when confidence is at least 0.8. Use unresolved when available evidence cannot determine root cause.',
              },
              object: { type: 'string', description: 'Specific object involved, e.g. "service checkout", "config rule payments-timeout", "worker queue-consumer". Required unless unresolved.' },
              field: { type: 'string', description: 'Specific field/value if known, e.g. limit, threshold, route weight, dependency endpoint, timeout.' },
              cause: { type: 'string', description: 'Causal mechanism, not the symptom, e.g. "timeout too low causing downstream request failures". Required unless unresolved.' },
              nextCheck: { type: 'string', description: 'For unresolved only: exact next check or unavailable data needed.' },
            },
            required: ['status'],
          },
          confidence: { type: 'number', description: 'Root-cause confidence from 0 to 1. Must be >= 0.8 for confirmed/likely.' },
          evidenceRefs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Recorded check ids that support the conclusion, e.g. ["check_1", "check_3"].',
          },
          ruledOut: {
            type: 'array',
            items: { type: 'string' },
            description: 'Plausible alternative hypotheses ruled out, e.g. ["no traffic", "scrape issue"].',
          },
          validationMethod: { type: 'string', description: 'How to verify the root cause or fix — name the metric/log/check/result to observe. Required for confirmed/likely claims: the gate reads this field only, not nextAction / rootCause.nextCheck.' },
          nextAction: { type: 'string', description: 'Durable fix or next operator action plus how to validate it. If a short-term workaround is useful, label it as temporary mitigation and still include the durable remediation or prevention.' },
        },
        required: ['summary', 'rootCause', 'confidence', 'evidenceRefs', 'ruledOut'],
      },
    },
  },

  // -------------------------------------------------------------------------
  // Alert rules
  // -------------------------------------------------------------------------
  'alert_rule_write': {
    category: 'deferred',
    schema: {
      name: 'alert_rule_write',
      description:
        'Create, update, or delete an alert rule — three verbs share one tool. Required: op. Per op:\n' +
        ' - op="create": requires `spec` (fully structured alert rule). Build the spec in the main agent flow after metrics discovery/query validation. Do not pass a natural-language prompt and expect this tool to generate the rule. Optional `dashboardId` links the alert to a dashboard. Optional `folderUid` only when the user explicitly names a folder; otherwise the rule lands in the default Alerts folder. When a metrics connector is registered, the tool result includes a backtest preview ("would have fired N time(s) ... in the last 24h") computed against real data; when no metrics connector is wired, the preview is omitted (no fabrication).\n' +
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
          spec: {
            type: 'object',
            description: 'Required for op=create: complete alert rule spec. The main agent must construct this after discovery and validation.',
            properties: {
              name: { type: 'string', description: 'Short descriptive alert rule name.' },
              description: { type: 'string', description: 'Human-readable description of what this alert detects and why it matters.' },
              condition: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: 'Validated PromQL/MetricsQL expression.' },
                  operator: { type: 'string', enum: ['>', '<', '>=', '<=', '=='] },
                  threshold: { type: 'number' },
                  forDurationSec: { type: 'number' },
                },
                required: ['query', 'operator', 'threshold', 'forDurationSec'],
              },
              evaluationIntervalSec: { type: 'number' },
              severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
              labels: { type: 'object', description: 'String labels attached to the rule.' },
              autoInvestigate: { type: 'boolean' },
            },
            required: ['name', 'description', 'condition', 'evaluationIntervalSec', 'severity'],
          },
          folderUid: { type: 'string', description: 'Optional for op=create: folder uid that owns the rule. Omit unless the user explicitly asks for a folder; omitted rules land in the default Alerts folder.' },
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
  'alert_rule_list': {
    category: 'deferred',
    schema: {
      name: 'alert_rule_list',
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
  'alert_rule_history': {
    category: 'deferred',
    schema: {
      name: 'alert_rule_history',
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
  'web_search': {
    category: 'always-on',
    schema: {
      name: 'web_search',
      description:
        'Search the web for monitoring best practices, metric naming conventions, and dashboard patterns when the workspace KB has no relevant entry. Cheap read — same cost class as metrics_discover. Spend it when KB and live discovery do not answer the question; the model\'s training-data priors on metric names go stale.\n\n' +
        'Call this BEFORE the next tool when ANY of:\n' +
        '1. Named-system dashboard with no relevant KB entry — user names a standard system (Redis, Kafka, Postgres, nginx, etcd, ...), kb_recommend/kb_get returned no useful entry, and exact exporter metric names are not already in the conversation. Search for the canonical exporter + reference layout BEFORE constructing panel queries.\n' +
        '2. Investigation hits an unfamiliar metric / label / vendor behavior — when you hit a name like `redis_aof_rewrite_in_progress` or `kafka_consumergroup_lag` and you can\'t say what it means in one line from context, search before guessing. Same for "is this a known upstream bug" hypotheses — vendor docs / GitHub issues are the disambiguator.\n' +
        '3. Best-practice panel layout for an in-house service pattern (HTTP server, gRPC, queue consumer, batch job) when the worked example doesn\'t already cover it.\n\n' +
        'Anti-pattern: skipping the search and inventing metric names from training-data priors. The downstream cost is dashboard_add_panels → metrics_validate failure → wasted turns; cheaper to web_search up front.',
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

  'load_task_context': {
    category: 'always-on',
    schema: {
      name: 'load_task_context',
      description:
        'Load the detailed playbook for the task shape you are about to work on. The base prompt is intentionally small; the worked examples, query patterns, panel-correctness rules, and knowledge-base protocol for each task live here and are returned as the observation.\n\nCall this ONCE, right after you have identified the task shape from the decision flow and before doing the heavy work. Modes:\n- "dashboard_build" — building or editing a dashboard / its panels.\n- "investigate" — "why is X high/slow/broken", incident diagnosis, writing an investigation report.\n- "alert_author" — creating or editing an alert rule.\n- "ad_hoc_explore" — "show me / what is / how is" a metric value (renders an inline chart), or a numeric breakdown.\n- "ops_command" — mutating cluster state (scale / delete / install / apply).\n\nDo NOT call it for trivial conversational answers ("what does rate() do?") or for opening/listing existing resources — the base prompt already covers those. Do NOT call it more than once for the same task unless the shape genuinely changes mid-conversation.',
      input_schema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['dashboard_build', 'investigate', 'alert_author', 'ad_hoc_explore', 'ops_command'],
            description: 'The task shape whose playbook to load.',
          },
        },
        required: ['mode'],
      },
    },
  },

  // -------------------------------------------------------------------------
  // Connector-model setup and allowlisted settings.
  // -------------------------------------------------------------------------
  'connector_list': {
    category: 'always-on',
    schema: {
      name: 'connector_list',
      description:
        'List configured connectors. Filter by category, capability, or status when the user asks what is connected or when a workflow needs a connector with a specific capability.',
      input_schema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Optional category filter, e.g. observability, runtime, code, cicd, incident.' },
          capability: { type: 'string', description: 'Optional capability filter, e.g. metrics.query, logs.query, runtime.scale, vcs.repo.read.' },
          status: { type: 'string', enum: ['draft', 'active', 'failed', 'disabled'], description: 'Optional status filter.' },
        },
        required: [],
      },
    },
  },
  'connector_template_list': {
    category: 'deferred',
    schema: {
      name: 'connector_template_list',
      description:
        'List connector templates the product knows how to create. Use before proposing a new connector so required fields and capabilities are explicit.',
      input_schema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Optional category filter.' },
          capability: { type: 'string', description: 'Optional capability filter.' },
        },
        required: [],
      },
    },
  },
  'connector_detect': {
    category: 'deferred',
    schema: {
      name: 'connector_detect',
      description:
        'Probe the environment for connector candidates from templates. Returns candidate config fragments with confidence and source. Does not persist anything.',
      input_schema: {
        type: 'object',
        properties: {
          template: { type: 'string', description: 'Optional template type to probe, e.g. prometheus, loki, kubernetes, github.' },
        },
        required: [],
      },
    },
  },
  'connector_propose': {
    category: 'deferred',
    schema: {
      name: 'connector_propose',
      description:
        'Create a connector draft from a template, name, and non-secret config. NEVER include raw credentials, tokens, kubeconfigs, or passwords; secrets are uploaded through POST /api/connectors/:id/secret after the connector exists. Use connector_template_list first if required config fields are unclear.',
      input_schema: {
        type: 'object',
        properties: {
          template: { type: 'string', description: 'Template type, e.g. prometheus, loki, kubernetes, github.' },
          name: { type: 'string', description: 'Human-friendly connector name.' },
          config: { type: 'object', description: 'Template-specific non-secret config, e.g. {url}, {org}, or {clusterName}.' },
          scope: { type: 'object', description: 'Optional initial policy scope preview, e.g. namespaces, labels, repos, paths.' },
          isDefault: { type: 'boolean', description: 'When true, mark as default for its connector type.' },
        },
        required: ['template', 'name', 'config'],
      },
    },
  },
  'connector_apply': {
    category: 'deferred',
    schema: {
      name: 'connector_apply',
      description:
        'Persist a connector draft created by connector_propose. Returns connector id, status, and capabilities. If credentials are required, direct the user to Settings → Connectors to attach the secret.',
      input_schema: {
        type: 'object',
        properties: {
          draftId: { type: 'string', description: 'Draft id returned by connector_propose.' },
        },
        required: ['draftId'],
      },
    },
  },
  'connector_test': {
    category: 'deferred',
    schema: {
      name: 'connector_test',
      description:
        'Test an existing connector and return ok/error, latency, and verified capabilities.',
      input_schema: {
        type: 'object',
        properties: {
          connectorId: { type: 'string', description: 'Connector id from connector_list or connector_apply.' },
        },
        required: ['connectorId'],
      },
    },
  },
  'setting_get': {
    category: 'deferred',
    schema: {
      name: 'setting_get',
      description:
        'Read one allowlisted non-sensitive org setting. Permission, role, security, and credential settings are not readable through the agent.',
      input_schema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            enum: ['default_alert_folder_uid', 'default_dashboard_folder_uid', 'notification_default_channel', 'auto_investigation_enabled'],
            description: 'Allowlisted setting key.',
          },
        },
        required: ['key'],
      },
    },
  },
  'setting_set': {
    category: 'deferred',
    schema: {
      name: 'setting_set',
      description:
        'Update one allowlisted non-sensitive org setting. Medium-risk settings may still require confirmation by policy. Permission, role, security, and credential settings must go through Admin Center UI.',
      input_schema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            enum: ['default_alert_folder_uid', 'default_dashboard_folder_uid', 'notification_default_channel', 'auto_investigation_enabled'],
            description: 'Allowlisted setting key.',
          },
          value: { type: 'string', description: 'New value.' },
        },
        required: ['key', 'value'],
      },
    },
  },

  // -------------------------------------------------------------------------
  // Knowledge base (hybrid retrieval over bundled + saved + distilled entries)
  // -------------------------------------------------------------------------
  'kb_search': {
    category: 'always-on',
    schema: {
      name: 'kb_search',
      description:
        'Hybrid-search the workspace knowledge base for bundled and saved skill-style entries (title + description + markdown body + tags), combining lexical TF-IDF and semantic intent features. Call before web_search when the user names a known system.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text search query' },
          limit: { type: 'integer', description: 'Max entries to return (default 5, capped at 20)' },
        },
        required: ['query'],
      },
    },
  },
  'kb_get': {
    category: 'always-on',
    schema: {
      name: 'kb_get',
      description:
        'Fetch a single knowledge-base entry by id. Call after kb_search or kb_recommend to retrieve full content.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'KB entry id from kb_search or kb_recommend' },
        },
        required: ['id'],
      },
    },
  },
  'kb_recommend': {
    category: 'always-on',
    schema: {
      name: 'kb_recommend',
      description:
        'Recommend KB templates and patterns for the given intent. Call before dashboard_create.',
      input_schema: {
        type: 'object',
        properties: {
          intent: { type: 'string', description: 'Free-text description of what the user wants to monitor.' },
        },
        required: ['intent'],
        additionalProperties: false,
      },
    },
  },

  // -------------------------------------------------------------------------
  // GitHub VCS read tools. Reads via the configured GitHub connector. The
  // connector must be configured in Settings → Connectors → GitHub. All four
  // are read-only and gated by the connector policy capabilities
  // `vcs.repo.read` / `vcs.pr.read` / `vcs.diff.read`.
  // -------------------------------------------------------------------------
  'github_list_repos': {
    category: 'deferred',
    schema: {
      name: 'github_list_repos',
      description:
        'List repositories the GitHub App installation can see. Reads via the configured GitHub connector. The connector must be configured in Settings → Connectors → GitHub. Pass connectorId only if the org has multiple GitHub connectors; otherwise the single configured one is used.',
      input_schema: {
        type: 'object',
        properties: {
          connectorId: { type: 'string', description: 'GitHub connector id. Optional when the org has exactly one.' },
        },
        required: [],
      },
    },
  },
  'github_list_prs': {
    category: 'deferred',
    schema: {
      name: 'github_list_prs',
      description:
        'List pull requests on a repository. Reads via the configured GitHub connector. The connector must be configured in Settings → Connectors → GitHub.',
      input_schema: {
        type: 'object',
        properties: {
          connectorId: { type: 'string', description: 'GitHub connector id. Optional when the org has exactly one.' },
          owner: { type: 'string', description: 'Repository owner (org or user login).' },
          repo: { type: 'string', description: 'Repository name.' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'PR state filter. Default open.' },
          limit: { type: 'number', description: 'Max PRs to return. Default 20, max 100.' },
        },
        required: ['owner', 'repo'],
      },
    },
  },
  'github_get_pr': {
    category: 'deferred',
    schema: {
      name: 'github_get_pr',
      description:
        'Fetch full detail for a single pull request (title, body, head/base SHAs, file/line stats, mergedAt). Reads via the configured GitHub connector. The connector must be configured in Settings → Connectors → GitHub.',
      input_schema: {
        type: 'object',
        properties: {
          connectorId: { type: 'string', description: 'GitHub connector id. Optional when the org has exactly one.' },
          owner: { type: 'string', description: 'Repository owner.' },
          repo: { type: 'string', description: 'Repository name.' },
          number: { type: 'number', description: 'Pull request number.' },
        },
        required: ['owner', 'repo', 'number'],
      },
    },
  },
  'github_get_diff': {
    category: 'deferred',
    schema: {
      name: 'github_get_diff',
      description:
        'Fetch the unified diff text for a pull request. Reads via the configured GitHub connector. The connector must be configured in Settings → Connectors → GitHub. Large diffs are truncated at ~256 KB with a marker; for a structured view of file paths and stats use github_get_pr.',
      input_schema: {
        type: 'object',
        properties: {
          connectorId: { type: 'string', description: 'GitHub connector id. Optional when the org has exactly one.' },
          owner: { type: 'string', description: 'Repository owner.' },
          repo: { type: 'string', description: 'Repository name.' },
          number: { type: 'number', description: 'Pull request number.' },
        },
        required: ['owner', 'repo', 'number'],
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
        'Ask the user a clarifying question. Ends the conversation. Use VERY sparingly — only when the request is genuinely ambiguous (e.g. multiple connectors of the same kind and intent unclear). For one-of-N decisions (e.g. "Which connector?"), pass `options`. The user\'s reply will be the option id, prefixed with `option:` so you can distinguish it from free text.',
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
