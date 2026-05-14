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
        'Test whether a query is syntactically valid and executes through both instant and dashboard range-query paths. Use as the validation gate before dashboard_add_panels — catches bad PromQL before it lands in a panel.',
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
        'Run a Kubernetes/Ops command through a configured connector. Only use when the user asks to inspect or operate on cluster state and a connectorId is known. Read commands may run with intent="read"; write/mutating commands must use intent="propose" unless the user is executing an approved proposal.\n\n' +
        'intent="read" — kubectl get/describe/logs only. Safe during investigation; treat like a metrics query.\n' +
        'intent="propose" — ad-hoc write proposal OUTSIDE an investigation flow (e.g. user directly says "scale web to 3"). From an investigation turn, prefer remediation_plan_create so the fix is gated under the plan approval UI rather than a one-off proposal.\n' +
        'intent="execute_approved" — only after an approval has fired AND the executor is running plan steps. Never invoke this directly from a chat or investigation turn; the plan executor calls it for you.\n\n' +
        'Anti-pattern: using intent="read" for a mutating verb (scale/apply/delete/patch). The connector rejects it — pick the right intent up front.',
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
  // Remediation plans (Phase 4 of auto-remediation design notes). The agent
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
        'Propose a structured remediation plan after an investigation has identified a concrete, in-scope fix.\n\n' +
        'LOW COST: this tool does NOT execute anything. It creates a pending_approval plan record and a plan-level ApprovalRequest; a human must open the approval and click Approve before any plan step runs. Treat calling this tool as equivalent to saving a draft for review.\n\n' +
        'DEFAULT next step after investigation_complete when ALL of: (a) root cause is concrete, (b) the fix is one or more kubectl commands, (c) an attached connector covers the target namespace. Refusing to file a plan in those cases makes the agent worse — humans gate execution at the approval UI, so over-cautious "leave it to the operator" is the wrong posture.\n\n' +
        'Skip ONLY when: the user explicitly asked to stop after diagnosis; the fix needs credentials no configured connector has; the next step isn\'t kubectl-shaped (data migration, code change, ask upstream); the safe action is monitor + re-check.\n\n' +
        'Do NOT call from a non-investigation turn. A direct "scale web to 3" in chat is a request, not an investigation outcome — use ops_run_command intent=propose.\n\n' +
        'Step ordering: reads/verifications first, then writes, then a final `kubectl rollout status` (or equivalent) verification step where it makes sense. Halt-on-failure is the default; only set continueOnError=true on truly non-critical steps (notification, optional cleanup).',
      input_schema: {
        type: 'object',
        properties: {
          investigationId: { type: 'string', description: 'Id from investigation_create that motivated this plan.' },
          summary: { type: 'string', description: 'One-line description of what the plan does. Surfaced in approval UI.' },
          steps: {
            type: 'array',
            description: 'Ordered list of steps. The order is the execution order. Halt-on-failure by default.',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['ops.run_command'], description: 'Step kind. Today only ops.run_command (kubectl) is supported.' },
                commandText: { type: 'string', description: 'Human-readable command, e.g. "kubectl scale deploy/web -n app --replicas=3". Surfaced verbatim to the approver.' },
                paramsJson: {
                  type: 'object',
                  description: 'Structured args. For ops.run_command, must include `argv` (kubectl argv WITHOUT the leading "kubectl") and `connectorId` (the connector row to run against).',
                  properties: {
                    argv: { type: 'array', items: { type: 'string' }, description: 'kubectl argv tokens.' },
                    connectorId: { type: 'string', description: 'ops connector id.' },
                  },
                  required: ['argv', 'connectorId'],
                },
                dryRunText: { type: 'string', description: 'Optional. The expected effect of this step in plain text. If you ran a related read query while investigating, summarize the predicted outcome here.' },
                riskNote: { type: 'string', description: 'Optional. Human-readable risk note ("brief drop to 2 replicas"). Surfaced in the approval UI.' },
                continueOnError: { type: 'boolean', description: 'If true, plan continues if this step fails. Default false (halt). Use for non-critical steps like notifications.' },
              },
              required: ['kind', 'commandText', 'paramsJson'],
            },
          },
          expiresInMs: { type: 'number', description: 'Optional. Override the default approval window (24h) in milliseconds.' },
        },
        required: ['investigationId', 'summary', 'steps'],
      },
    },
  },
  'remediation_plan_create_rescue': {
    category: 'deferred',
    schema: {
      name: 'remediation_plan_create_rescue',
      description:
        'Propose a rescue/undo plan paired with a primary plan, to be invoked manually by an operator if the primary fails. Same shape as remediation_plan_create plus rescueForPlanId. Does NOT auto-create an ApprovalRequest; rescue plans are triggered on demand from the UI.\n\n' +
        'Pair with the primary plan ONLY when each primary write step is reasonably reversible AND you know the exact undo (scale up→down, replicas, env-var flip, ConfigMap patch, image rollback to a known-good tag).\n\n' +
        'Skip rescue for inherently irreversible primary steps (`kubectl delete <unique resource>`, manual data migration, schema change). A wrong undo is worse than no undo — silence beats fabrication.\n\n' +
        'Rescue plans don\'t auto-approve and don\'t auto-run. They sit in storage; an operator triggers them from the UI only after the primary fails.',
      input_schema: {
        type: 'object',
        properties: {
          rescueForPlanId: { type: 'string', description: 'Id of the primary plan this rescue undoes.' },
          investigationId: { type: 'string', description: 'Same investigation that produced the primary plan.' },
          summary: { type: 'string', description: 'One-line description of the rollback action.' },
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
        required: ['rescueForPlanId', 'investigationId', 'summary', 'steps'],
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
        'Create an empty dashboard. Returns dashboardId. Follow with dashboard_add_panels to populate it. Required before any other dashboard.* mutation when there is no current dashboard context. Requires a primary datasourceId — pick one via connectors_suggest first (or reuse the session pin if set).',
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
        'Add one or more panels to the active dashboard. Call dashboard_create or dashboard_open first; this tool implicitly targets that dashboard. The model constructs panel configs directly (title, visualization, queries, unit, ...). Panel sizing and layout are auto-applied. Every query must carry an explicit datasourceId — there is NO inheritance from the dashboard primary. For a single-source dashboard, set every query to the dashboard primary id. For cross-source compare panels, set per query (one source per query). The handler rejects panels with any missing datasourceId.\n\n' +
        'PRE-FLIGHT: if the dashboard targets a NAMED system (Redis, Kafka, Postgres, nginx, ...) AND no exporter metric names appear anywhere in the conversation context, call web_search FIRST to get the canonical exporter metric naming + a reference layout. Carve-out: skip web_search only when the exact metric names you\'re about to use are already quoted in the current conversation (user pasted them, an earlier metrics_discover returned them, etc.).\n\n' +
        'Skipping the pre-flight is the dominant failure mode: training-data priors invent plausible-looking names → metrics_validate rejects → re-plan → wasted turns. The web_search round trip is one cheap read; the rebuild is several mutations.\n\n' +
        'Validate every non-trivial query through metrics_validate before this call. The handler rejects unvalidated queries. If the user asks for several distinct dashboard areas, create and populate one focused dashboard at a time instead of combining them into one oversized dashboard.',
      input_schema: {
        type: 'object',
        properties: {
          panels: {
            type: 'array',
            description: 'Panel configs. Each: { title, visualization, queries: [{refId, expr, datasourceId, legendFormat?, instant?}], unit?, ... }. datasourceId is REQUIRED per query.',
            items: { type: 'object' },
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
          queries: { type: 'array', description: 'Optional replacement query list', items: { type: 'object' } },
          unit: { type: 'string', description: 'Optional value unit (seconds, bytes, percentunit, reqps, ...)' },
        },
        required: ['panelId'],
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
  // Investigation lifecycle
  // -------------------------------------------------------------------------
  'investigation_create': {
    category: 'always-on',
    schema: {
      name: 'investigation_create',
      description:
        'Start a new investigation record for a "why is X" question. Returns investigationId.\n\n' +
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
  'investigation_add_section': {
    category: 'deferred',
    schema: {
      name: 'investigation_add_section',
      description:
        'Append a section to the active investigation report. Call investigation_create first; this tool implicitly targets that record. type="text" is narrative analysis (substantial paragraphs); type="evidence" attaches a panel snapshot for a key finding.\n\n' +
        'Interleave querying and writing: query → add_section(text) interpreting that result → query more → another section → drop in an evidence panel next to the prose that cites it. Do NOT batch all queries first then dump prose at the end — the report loses the actual reasoning shape.\n\n' +
        'type=evidence is reserved for the 2–4 panels that carry the conclusion; not "every panel I ran". Each evidence section earns its place next to the paragraph that interprets it.\n\n' +
        'Every text section MUST start with a short `## heading` that names the beat (e.g. `## Symptom`, `## Ruling out load`, `## Hotspot: /foo`). Without headings the rendered report collapses into one wall of text under "Summary" and the user can\'t tell sections apart. Headings are free-form — fit them to what the paragraph actually says, don\'t reflexively reach for "## Initial Assessment" / "## Hypothesis 1".\n\n' +
        'When citing a piece of evidence inline, reference it with a short bracketed token: `[m1]` for the 1st metric panel, `[l1]` for a log finding, `[k1]` for k8s/cluster state, `[c1]` for a recent change. The UI renders these as clickable chips. Citations are encouraged, not required.',
      input_schema: {
        type: 'object',
        properties: {
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
        required: ['type', 'content'],
      },
    },
  },
  'investigation_complete': {
    category: 'deferred',
    schema: {
      name: 'investigation_complete',
      description:
        'Finalize the active investigation, save the report, and navigate to it. Implicitly targets the investigation_create record from this session.\n\n' +
        'MUST be the LAST tool call of any investigation turn. If you end with plain text without calling investigation_complete, every section is discarded and the user sees nothing — this is the single most common investigation failure.\n\n' +
        'The summary you pass here is the executive summary shown above the report. One paragraph stating the conclusion + the most likely cause. Do not duplicate the section bodies.\n\n' +
        'Order: investigation_complete FIRST, then (optionally) remediation_plan_create, then your final plain-text reply.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One-paragraph executive summary of the conclusion' },
        },
        required: ['summary'],
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
        'Search the web for monitoring best practices, metric naming conventions, and dashboard patterns. Cheap read — same cost class as metrics_discover. Spend it liberally; the model\'s training-data priors on metric names go stale.\n\n' +
        'Call this BEFORE the next tool when ANY of:\n' +
        '1. Named-system dashboard — user names a standard system (Redis, Kafka, Postgres, nginx, etcd, ...). Search for the canonical exporter + reference layout BEFORE constructing panel queries. Skip ONLY if the exact exporter metric names already appear in the conversation.\n' +
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
