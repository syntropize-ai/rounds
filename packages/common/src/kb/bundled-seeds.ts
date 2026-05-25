/**
 * Bundled (factory-shipped) knowledge-base seeds.
 *
 * Loaded once per org by `ensureBundledSeeds` in the api-gateway boot path.
 * Idempotent — keyed by `id`, so re-runs are safe.
 *
 * Each entry is a skill the agent may consult based on its `description`. The
 * `body` is markdown the agent reads at apply time to author dashboards or
 * investigate issues — no structured JSON schema.
 */

import type { KnowledgeInsertInput } from './types.js';

type Seed = Omit<KnowledgeInsertInput, 'orgId'>;

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const redMethod: Seed = {
  id: 'bundled-red-method',
  source: 'bundled',
  sourceRef: null,
  title: 'RED method (Rate, Errors, Duration)',
  description:
    'When investigating a request-oriented service (HTTP, gRPC, GraphQL, queue consumer) and you need to build a dashboard around rate, errors, and duration.',
  intentTags: ['red', 'http', 'rest', 'rpc', 'service', 'latency', 'requests'],
  createdBy: null,
  body: `## When to use

Apply RED to any request-oriented service: HTTP, gRPC, GraphQL, or queue consumers that emit per-request metrics. One panel-row per service. Pair with USE on the same dashboard when you also want resource visibility.

## What to build

For each service produce three time-series panels in a row titled with the service name.

Rate — requests per second:

\`\`\`promql
sum by (service) (rate(<requests>_total{service="$SERVICE"}[5m]))
\`\`\`

Errors — 5xx ratio, scaled 0..1:

\`\`\`promql
sum by (service) (rate(<requests>_total{service="$SERVICE",status=~"5.."}[5m]))
  /
sum by (service) (rate(<requests>_total{service="$SERVICE"}[5m]))
\`\`\`

Duration — p99 latency in seconds (requires a histogram):

\`\`\`promql
histogram_quantile(0.99,
  sum by (le,service) (rate(<requests>_duration_seconds_bucket{service="$SERVICE"}[5m])))
\`\`\`

## Notes

- Substitute \`<requests>\` with the real metric prefix exposed by the service (e.g. \`http_server_requests\`, \`grpc_server_handled\`).
- If only a summary (not histogram) is available, use the \`{quantile="0.99"}\` series instead of \`histogram_quantile\`.
- For queue consumers, "rate" is messages-processed/s and "errors" is the nack/dead-letter ratio.
- Don't put rate and error ratio on a shared axis — error ratio belongs on a 0..1 scale.
`,
};

const useMethod: Seed = {
  id: 'bundled-use-method',
  source: 'bundled',
  sourceRef: null,
  title: 'USE method (Utilization, Saturation, Errors)',
  description:
    'When inspecting physical or virtual resources (CPU, memory, disk, network) per node or pod and you want a systematic resource-saturation view.',
  intentTags: ['use', 'resource', 'cpu', 'memory', 'disk', 'network', 'node', 'pod'],
  createdBy: null,
  body: `## When to use

Use USE when the question is "is the box healthy?" rather than "is the service healthy?". One row per resource: CPU, memory, disk, network. Each row gets three panels: utilization, saturation, errors.

## What to build

### CPU

\`\`\`promql
# Utilization (0..1)
1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))

# Saturation — load5 per core
avg by (instance) (node_load5)
  / count by (instance) (node_cpu_seconds_total{mode="idle"})

# Errors proxy — iowait
rate(node_cpu_seconds_total{mode="iowait"}[5m])
\`\`\`

### Memory

\`\`\`promql
# Utilization
1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)

# Saturation — swap pages/s
rate(node_vmstat_pswpin[5m]) + rate(node_vmstat_pswpout[5m])

# Errors — OOM kills/s
rate(node_vmstat_oom_kill[5m])
\`\`\`

### Disk

\`\`\`promql
# Utilization
1 - (node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}
     / node_filesystem_size_bytes{fstype!~"tmpfs|overlay"})

# Saturation — IO time fraction
rate(node_disk_io_time_seconds_total[5m])

# Errors
rate(node_disk_io_errors_total[5m])
\`\`\`

### Network

\`\`\`promql
# Utilization — bytes/s in+out
rate(node_network_receive_bytes_total[5m])
  + rate(node_network_transmit_bytes_total[5m])

# Saturation — drops/s
rate(node_network_receive_drop_total[5m])
  + rate(node_network_transmit_drop_total[5m])

# Errors
rate(node_network_receive_errs_total[5m])
  + rate(node_network_transmit_errs_total[5m])
\`\`\`

## Notes

- Metrics assume \`node_exporter\`. For containers, substitute \`container_*\` metrics from cAdvisor.
- "Saturation" is the most useful column — high utilization without saturation is fine.
- iowait is a coarse proxy for CPU-induced errors; treat it as a hint, not a definitive signal.
`,
};

const perPodOps: Seed = {
  id: 'bundled-per-pod-ops',
  source: 'bundled',
  sourceRef: null,
  title: 'Per-pod operational view',
  description:
    'When debugging a single Kubernetes workload and you want per-pod resource, health, and log signals on one screen.',
  intentTags: ['pod', 'workload', 'on-call', 'debug', 'k8s', 'kubernetes'],
  createdBy: null,
  body: `## When to use

You have an incident scoped to a specific pod (or small set) and need CPU/mem/restart/log signals in one view. Less ceremony than full RED+USE — optimized for fast triage.

## What to build

One row per pod. Within the row, four panels:

CPU as % of quota (stat):

\`\`\`promql
rate(container_cpu_usage_seconds_total{pod="$POD"}[5m])
  / (container_spec_cpu_quota{pod="$POD"} / 100000) * 100
\`\`\`

Memory as % of limit (stat):

\`\`\`promql
container_memory_working_set_bytes{pod="$POD"}
  / container_spec_memory_limit_bytes{pod="$POD"} * 100
\`\`\`

Restart count (stat):

\`\`\`promql
kube_pod_container_status_restarts_total{pod="$POD"}
\`\`\`

Log error/warn rate (time series):

\`\`\`promql
sum by (level) (rate(log_messages_total{pod="$POD",level=~"error|warn"}[5m]))
\`\`\`

## Notes

- Requires cAdvisor + kube-state-metrics + a log-to-metric pipeline (e.g. Loki recording rules or vector-emitted counters).
- If the workload has multiple containers, add \`container=\` to the matcher or aggregate with \`sum by (pod)\`.
- For Burstable QoS pods without quotas, the CPU panel will show NaN — gate the panel on \`container_spec_cpu_quota > 0\`.
`,
};

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const istio: Seed = {
  id: 'bundled-istio',
  source: 'bundled',
  sourceRef: null,
  title: 'Istio data plane dashboard',
  description:
    'When the user runs Istio service mesh and wants a data-plane dashboard covering envoy sidecar resources, per-pod inbound/outbound request flow, TCP layer, and ingress gateway traffic.',
  intentTags: ['istio', 'service-mesh', 'envoy', 'ingress', 'gateway', 'k8s', 'kubernetes'],
  createdBy: null,
  body: `## When to use

The cluster runs Istio and you want an operational data-plane view scoped to a namespace. Mirrors a real production layout: sidecar resources, per-pod request status code split (inbound and outbound), TCP layer, and the ingress gateway viewed separately. Requires cAdvisor + kube-state-metrics + Istio metrics scraping.

Variables to expose: \`NAMESPACE\` (k8s namespace), \`WORKLOAD\` (workload regex, default \`.*\`), \`TIME_RANGE\` (rate window, default \`5m\`).

## Recommended dashboard

### Row 1 — Proxy resource usage (4 panels, w=3 each)

CPU utilization (percent):

\`\`\`promql
sum by (pod) (rate(container_cpu_usage_seconds_total{container="istio-proxy", namespace="$NAMESPACE"}[$TIME_RANGE])) * 100
\`\`\`

CPU vs quota (percent):

\`\`\`promql
sum by (pod) (rate(container_cpu_usage_seconds_total{container="istio-proxy", namespace="$NAMESPACE"}[$TIME_RANGE]))
  / on(pod) group_left() (container_spec_cpu_quota{container="istio-proxy", namespace="$NAMESPACE"} / 100000) * 100
\`\`\`

Memory utilization (percent):

\`\`\`promql
container_memory_working_set_bytes{container="istio-proxy", namespace="$NAMESPACE"}
  / container_spec_memory_limit_bytes{container="istio-proxy", namespace="$NAMESPACE"} * 100
\`\`\`

Memory bytes:

\`\`\`promql
container_memory_working_set_bytes{container="istio-proxy", namespace="$NAMESPACE"}
\`\`\`

**Without cAdvisor (no \`container_*\` metrics scraped).** When the cluster scrapes only the Istio sidecars themselves (no kubelet/cAdvisor), use the metrics the pilot-agent + envoy expose directly. They share \`kubernetes_pod_name\` / \`app\` labels so per-pod grouping still works:

\`\`\`promql
# CPU per pod (percent) — pilot-agent process is a stand-in for the proxy:
sum by (kubernetes_pod_name) (rate(istio_agent_process_cpu_seconds_total{kubernetes_namespace="$NAMESPACE"}[$TIME_RANGE])) * 100

# Memory per pod (bytes) — envoy's own allocator:
sum by (kubernetes_pod_name) (envoy_server_memory_allocated{kubernetes_namespace="$NAMESPACE"})

# Memory ratio per pod (allocated / heap_size):
sum by (kubernetes_pod_name) (envoy_server_memory_allocated{kubernetes_namespace="$NAMESPACE"})
  / sum by (kubernetes_pod_name) (envoy_server_memory_heap_size{kubernetes_namespace="$NAMESPACE"}) * 100
\`\`\`

Prefer the cAdvisor path when both are available — it's the true container view. The Istio-native path is the fallback so the dashboard still has a CPU/memory row in clusters that didn't deploy cAdvisor.

### Row 2 — Ingress requests (reporter="destination")

Four panels: total / 2xx / 4xx / 5xx, plus a fifth for non-OK envoy response_flags.

\`\`\`promql
# Total
sum by (pod) (rate(istio_requests_total{reporter="destination", destination_workload_namespace="$NAMESPACE"}[$TIME_RANGE]))

# Per status class — vary response_code=~"2..|4..|5.."
sum by (pod) (rate(istio_requests_total{reporter="destination", destination_workload_namespace="$NAMESPACE", response_code=~"5.."}[$TIME_RANGE]))

# Non-OK flag
sum by (pod) (rate(istio_requests_total{reporter="destination", destination_workload_namespace="$NAMESPACE", response_flags!="-"}[$TIME_RANGE]))
\`\`\`

### Row 3 — Egress requests (reporter="source")

Mirror Row 2 but with \`reporter="source"\` and \`source_workload_namespace\`.

### Row 4 — TCP layer

Four panels: connections opened/closed (count), bytes sent/received (Bps).

\`\`\`promql
sum by (pod) (rate(istio_tcp_connections_opened_total{destination_workload_namespace="$NAMESPACE"}[$TIME_RANGE]))
sum by (pod) (rate(istio_tcp_connections_closed_total{destination_workload_namespace="$NAMESPACE"}[$TIME_RANGE]))
sum by (pod) (rate(istio_tcp_sent_bytes_total{destination_workload_namespace="$NAMESPACE"}[$TIME_RANGE]))
sum by (pod) (rate(istio_tcp_received_bytes_total{destination_workload_namespace="$NAMESPACE"}[$TIME_RANGE]))
\`\`\`

### Row 5 — Ingress gateway resources

Three panels (w=4): gateway CPU vs quota, memory utilization, memory bytes — same shape as Row 1 but filtered by \`pod=~"istio-ingressgateway-.*"\`.

### Row 6 — Gateway-originated requests

Five panels: total + 2xx/4xx/5xx + non-OK flag, with \`source_workload="istio-ingressgateway"\`.

\`\`\`promql
sum by (pod) (rate(istio_requests_total{source_workload="istio-ingressgateway"}[$TIME_RANGE]))
sum by (pod) (rate(istio_requests_total{source_workload="istio-ingressgateway", response_code=~"5.."}[$TIME_RANGE]))
\`\`\`

## Troubleshooting

- 5xx-class rising inbound but not outbound — the workload itself is failing, not its dependencies.
- 5xx outbound on a service whose dependencies are healthy — check Envoy response_flags for circuit breaking (\`UO\`) or no healthy upstream (\`UH\`).
- Sidecar CPU near limit — bump \`sidecar.istio.io/proxyCPULimit\`; tail Envoy logs for stat overflow.
- Gateway saturated — scale ingress gateway replicas; check upstream cluster connection pool settings.
`,
};

const k8sWorkload: Seed = {
  id: 'bundled-k8s-workload',
  source: 'bundled',
  sourceRef: null,
  title: 'Kubernetes workload health dashboard',
  description:
    'When the user wants a standard per-pod workload health dashboard combining resource usage, RED metrics, log errors, and OOM/restart counts for a Kubernetes Deployment or StatefulSet.',
  intentTags: ['k8s', 'kubernetes', 'workload', 'pod', 'deployment', 'red', 'on-call'],
  createdBy: null,
  body: `## When to use

Default workload-health dashboard for any K8s Deployment or StatefulSet: per-pod resources + RED + log error rate. Skip sections whose metrics aren't exposed.

Variables: \`NAMESPACE\`, \`WORKLOAD\` (regex, default \`.*\`), \`HTTP_METRIC_PREFIX\` (default \`http_requests\`), \`TIME_RANGE\` (default \`5m\`).

## Recommended dashboard

### Row 1 — Resources (3 panels, w=4)

\`\`\`promql
# CPU vs limit (%)
sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="$NAMESPACE", pod=~"$WORKLOAD.*"}[$TIME_RANGE]))
  / on(pod) group_left() (container_spec_cpu_quota{namespace="$NAMESPACE", pod=~"$WORKLOAD.*"} / 100000) * 100

# Memory vs limit (%)
container_memory_working_set_bytes{namespace="$NAMESPACE", pod=~"$WORKLOAD.*"}
  / container_spec_memory_limit_bytes{namespace="$NAMESPACE", pod=~"$WORKLOAD.*"} * 100

# Memory bytes
container_memory_working_set_bytes{namespace="$NAMESPACE", pod=~"$WORKLOAD.*"}
\`\`\`

### Row 2 — Pod lifecycle (3 stat panels, w=4)

\`\`\`promql
# Restarts
kube_pod_container_status_restarts_total{namespace="$NAMESPACE", pod=~"$WORKLOAD.*"}

# Ready
sum(kube_pod_status_ready{namespace="$NAMESPACE", pod=~"$WORKLOAD.*", condition="true"})

# Not ready
sum(kube_pod_status_ready{namespace="$NAMESPACE", pod=~"$WORKLOAD.*", condition="false"})
\`\`\`

### Row 3 — RED (3 panels, w=4)

\`\`\`promql
# Request rate
sum by (pod) (rate($HTTP_METRIC_PREFIX_total{namespace="$NAMESPACE", pod=~"$WORKLOAD.*"}[$TIME_RANGE]))

# 5xx error ratio
sum by (pod) (rate($HTTP_METRIC_PREFIX_total{namespace="$NAMESPACE", pod=~"$WORKLOAD.*", status=~"5.."}[$TIME_RANGE]))
  / sum by (pod) (rate($HTTP_METRIC_PREFIX_total{namespace="$NAMESPACE", pod=~"$WORKLOAD.*"}[$TIME_RANGE]))

# p99 latency
histogram_quantile(0.99,
  sum by (le,pod) (rate($HTTP_METRIC_PREFIX_duration_seconds_bucket{namespace="$NAMESPACE", pod=~"$WORKLOAD.*"}[$TIME_RANGE])))
\`\`\`

### Row 4 — Logs, OOM, network

\`\`\`promql
# Log error/warn rate
sum by (pod) (rate(log_messages_total{namespace="$NAMESPACE", pod=~"$WORKLOAD.*", level=~"error|warn"}[$TIME_RANGE]))

# OOMKilled events
increase(kube_pod_container_status_terminated_reason{namespace="$NAMESPACE", pod=~"$WORKLOAD.*", reason="OOMKilled"}[$TIME_RANGE])

# Network throughput
sum by (pod) (rate(container_network_receive_bytes_total{namespace="$NAMESPACE", pod=~"$WORKLOAD.*"}[$TIME_RANGE])
  + rate(container_network_transmit_bytes_total{namespace="$NAMESPACE", pod=~"$WORKLOAD.*"}[$TIME_RANGE]))
\`\`\`

## Troubleshooting

- Memory near limit + OOMKilled events — raise memory limit, hunt for leaks via heap dump.
- High restart count + log errors — read the last container logs (\`kubectl logs --previous\`).
- Ready count drops below replicas — readiness probe failing; check probe config and pod logs.
- 5xx ratio spike with stable latency — upstream dependency failure.
- p99 spike with stable rate — GC pause, lock contention, or downstream slowness.
`,
};

// ---------------------------------------------------------------------------
// Software entries
// ---------------------------------------------------------------------------

const postgres: Seed = {
  id: 'bundled-postgres',
  source: 'bundled',
  sourceRef: null,
  title: 'PostgreSQL',
  description:
    'When investigating PostgreSQL health: connection saturation, slow queries, cache hit ratio, replication lag, deadlocks, or building a Postgres dashboard.',
  intentTags: ['postgres', 'postgresql', 'db', 'database', 'sql', 'on-call', 'performance', 'dashboard'],
  createdBy: null,
  body: `## When to use

Investigating a PostgreSQL instance scraped by \`postgres_exporter\`. A healthy primary shows >99% cache hit ratio, <1% rollback ratio, connections well under \`max_connections\`, and replication lag in the low-MB range. Deadlocks should be rare; a steady stream indicates concurrent-update hotspots.

## Key metrics

- \`pg_stat_database_xact_commit\` (counter) — committed transactions per database.
- \`pg_stat_database_xact_rollback\` (counter) — rolled-back transactions. Rollback ratio >5% sustained indicates app errors.
- \`pg_stat_database_blks_hit\` / \`pg_stat_database_blks_read\` (counters) — buffer cache hits vs disk reads. Cache hit ratio <95% sustained means undersized \`shared_buffers\` or working-set growth.
- \`pg_stat_activity_count\` (gauge) — current connections. >80% of \`max_connections\` means pool exhaustion is imminent.
- \`pg_stat_replication_lag_bytes\` (gauge) — WAL bytes the standby is behind. Sustained growth or >100MB on a healthy network is a red flag.
- \`pg_stat_database_deadlocks\` (counter) — any non-trivial rate indicates application concurrency bugs.

## Common queries

\`\`\`promql
# Transactions/sec
sum by (datname) (rate(pg_stat_database_xact_commit{job="$JOB"}[5m]))
  + sum by (datname) (rate(pg_stat_database_xact_rollback{job="$JOB"}[5m]))

# Rollback ratio
sum by (datname) (rate(pg_stat_database_xact_rollback{job="$JOB"}[5m]))
  / (sum by (datname) (rate(pg_stat_database_xact_commit{job="$JOB"}[5m]))
     + sum by (datname) (rate(pg_stat_database_xact_rollback{job="$JOB"}[5m])))

# Cache hit ratio
sum by (datname) (rate(pg_stat_database_blks_hit{job="$JOB"}[5m]))
  / (sum by (datname) (rate(pg_stat_database_blks_hit{job="$JOB"}[5m]))
     + sum by (datname) (rate(pg_stat_database_blks_read{job="$JOB"}[5m])))

# Connections by state
sum by (state) (pg_stat_activity_count{job="$JOB"})

# Replication lag
pg_stat_replication_lag_bytes{job="$JOB"}

# Deadlocks/sec
sum by (datname) (rate(pg_stat_database_deadlocks{job="$JOB"}[5m]))
\`\`\`

## Recommended dashboard

Row 1: throughput trio — transactions/sec by datname, rollback ratio (0..1), cache hit ratio (0..1). Row 2: saturation/health trio — active connections by state, replication lag in bytes, deadlocks/sec by datname. Filter everything by a \`JOB\` variable.

## Troubleshooting

- Cache hit ratio dropped — check for a recent query plan regression or working-set growth; consider raising \`shared_buffers\`.
- Connection count near limit — inspect pgbouncer/pooler health; look for long-running idle-in-transaction sessions.
- Replication lag growing — check standby disk I/O, network throughput between primary/standby, and WAL writer saturation.
- Spike in rollbacks — correlate with deploys and error logs; serialization failures under load are a common cause.
- Deadlocks appearing — capture \`pg_stat_activity\` during the event; review locking order in offending transactions.

Reference: https://github.com/prometheus-community/postgres_exporter
`,
};

const mysql: Seed = {
  id: 'bundled-mysql',
  source: 'bundled',
  sourceRef: null,
  title: 'MySQL / MariaDB',
  description:
    'When investigating MySQL or MariaDB health: query throughput, slow queries, InnoDB buffer pool, row-lock contention, or replication lag.',
  intentTags: ['mysql', 'mariadb', 'db', 'database', 'sql', 'on-call', 'performance', 'dashboard'],
  createdBy: null,
  body: `## When to use

MySQL or MariaDB scraped by \`mysqld_exporter\`. A healthy server shows slow-query rate near zero, low row-lock waits, buffer pool reads dominated by hits, and \`seconds_behind_master\` near 0.

## Key metrics

- \`mysql_global_status_threads_connected\` (gauge) — current client connections. Approaching \`max_connections\` is a red flag.
- \`mysql_global_status_questions\` (counter) — statements executed.
- \`mysql_global_status_slow_queries\` (counter) — queries over \`long_query_time\`. Any sustained non-zero rate warrants investigation.
- \`mysql_global_status_innodb_buffer_pool_reads\` / \`_read_requests\` (counters) — buffer pool misses vs logical reads. Rising miss ratio means buffer pool too small.
- \`mysql_global_status_innodb_row_lock_waits\` (counter) — row lock contention. Steady growth indicates hot-row contention.
- \`mysql_slave_status_seconds_behind_master\` (gauge) — replica lag. Sustained >5s on a busy replica is a problem.

## Common queries

\`\`\`promql
# QPS
sum by (instance) (rate(mysql_global_status_questions{job="$JOB"}[5m]))

# Slow queries/sec
sum by (instance) (rate(mysql_global_status_slow_queries{job="$JOB"}[5m]))

# Active connections
mysql_global_status_threads_connected{job="$JOB"}

# InnoDB buffer pool hit ratio
1 - (sum by (instance) (rate(mysql_global_status_innodb_buffer_pool_reads{job="$JOB"}[5m]))
     / sum by (instance) (rate(mysql_global_status_innodb_buffer_pool_read_requests{job="$JOB"}[5m])))

# Row-lock waits/sec
sum by (instance) (rate(mysql_global_status_innodb_row_lock_waits{job="$JOB"}[5m]))

# Replication lag
mysql_slave_status_seconds_behind_master{job="$JOB"}
\`\`\`

## Recommended dashboard

Row 1: throughput — QPS, slow queries/sec, connection count. Row 2: storage engine health — InnoDB buffer pool hit ratio, row-lock waits/sec, replication lag in seconds. Filter by \`JOB\`.

## Troubleshooting

- Slow queries spiking — enable the slow query log and capture explain plans; check for missing indexes after recent schema changes.
- Buffer pool hit ratio dropping — increase \`innodb_buffer_pool_size\` if RAM allows, or hunt for full table scans.
- Row-lock waits rising — identify hot rows via \`SHOW ENGINE INNODB STATUS\`; consider shortening transactions or changing isolation level.
- Replication lag growing — check replica I/O thread state, network, and single-threaded apply bottlenecks; consider parallel replication.
- Connection saturation — verify pool sizing in app tier; check for leaks via \`SHOW PROCESSLIST\`.

Reference: https://github.com/prometheus/mysqld_exporter
`,
};

const mongodb: Seed = {
  id: 'bundled-mongodb',
  source: 'bundled',
  sourceRef: null,
  title: 'MongoDB',
  description:
    'When investigating MongoDB health: op-counter mix, connection pressure, replica oplog window, open cursors, or global-lock queue contention.',
  intentTags: ['mongodb', 'mongo', 'db', 'database', 'nosql', 'document-db', 'on-call', 'dashboard'],
  createdBy: null,
  body: `## When to use

MongoDB scraped by Percona \`mongodb_exporter\`. A healthy node shows steady op-counter mix, connection count well under \`connections.available\`, oplog window measured in hours, and zero global-lock queueing.

## Key metrics

- \`mongodb_op_counters_total\` (counter) — operations by \`type\` (query/insert/update/delete/getmore/command).
- \`mongodb_connections_current\` (gauge) — live client connections. Near \`connections.available\` means pool exhaustion.
- \`mongodb_memory_resident_bytes\` (gauge) — process RSS.
- \`mongodb_replset_oplog_window_seconds\` (gauge) — replay headroom on the secondary. <1h is fragile.
- \`mongodb_cursor_open\` (gauge) — open server-side cursors. Steady growth means the app forgets to close cursors.
- \`mongodb_mongod_global_lock_current_queue\` (gauge) — operations queued on the global lock. Sustained >0 means contention.

## Common queries

\`\`\`promql
# Operations/sec by type
sum by (type) (rate(mongodb_op_counters_total{job="$JOB"}[5m]))

# Connections
mongodb_connections_current{job="$JOB"}

# Resident memory
mongodb_memory_resident_bytes{job="$JOB"}

# Oplog window (seconds)
mongodb_replset_oplog_window_seconds{job="$JOB"}

# Open cursors
mongodb_cursor_open{job="$JOB"}
\`\`\`

## Recommended dashboard

Row 1: op-mix time-series (stacked by type), connections per instance. Row 2: resident memory, oplog window in seconds, open cursors. Filter by \`JOB\`.

## Troubleshooting

- Op-counter mix shifted — correlate with an app deploy; sudden update/delete spikes often indicate a runaway migration.
- Connection count climbing — check driver pool config and look for orphaned client processes.
- Oplog window shrinking — increase oplog size or fix the secondary keeping it pinned (likely replication lag).
- Cursor count growing — search the app for un-closed cursors; ensure timeouts are configured.
- Memory pressure — check working set vs RAM; consider sharding or scaling vertically.

Reference: https://github.com/percona/mongodb_exporter
`,
};

const redis: Seed = {
  id: 'bundled-redis',
  source: 'bundled',
  sourceRef: null,
  title: 'Redis',
  description:
    'When investigating Redis health: command throughput, memory pressure, keyspace hit ratio, evictions, or replication lag.',
  intentTags: ['redis', 'cache', 'kv', 'in-memory', 'on-call', 'performance', 'dashboard'],
  createdBy: null,
  body: `## When to use

Redis scraped by \`redis_exporter\`. Healthy operation: hit ratio >80%, zero evictions in non-cache mode, memory well below \`maxmemory\`, replica offset closely tracking master.

## Key metrics

- \`redis_commands_processed_total\` (counter) — commands executed.
- \`redis_connected_clients\` (gauge) — current clients. Near \`maxclients\` is bad.
- \`redis_memory_used_bytes\` (gauge) — dataset RSS. >90% of \`redis_memory_max_bytes\` is a red flag.
- \`redis_keyspace_hits_total\` / \`redis_keyspace_misses_total\` (counters) — derive hit ratio; <80% means undersized or misused cache.
- \`redis_evicted_keys_total\` (counter) — keys evicted under memory pressure. Any sustained rate when used as a cache is concerning; non-zero in non-cache mode is a bug.
- \`redis_connected_slave_offset_bytes\` (gauge) — replica offset; diff from master_repl_offset is lag in bytes.

## Common queries

\`\`\`promql
# Commands/sec
sum by (instance) (rate(redis_commands_processed_total{job="$JOB"}[5m]))

# Memory used
redis_memory_used_bytes{job="$JOB"}

# Hit ratio
sum by (instance) (rate(redis_keyspace_hits_total{job="$JOB"}[5m]))
  / (sum by (instance) (rate(redis_keyspace_hits_total{job="$JOB"}[5m]))
     + sum by (instance) (rate(redis_keyspace_misses_total{job="$JOB"}[5m])))

# Evictions/sec
sum by (instance) (rate(redis_evicted_keys_total{job="$JOB"}[5m]))

# Replica offset
redis_connected_slave_offset_bytes{job="$JOB"}
\`\`\`

## Recommended dashboard

Row 1: throughput trio — commands/sec, connected clients, memory bytes. Row 2: cache health trio — keyspace hit ratio (0..1), evictions/sec, replica offset bytes. Filter by \`JOB\`.

## Troubleshooting

- Hit ratio dropping — verify TTL strategy and key naming; consider a larger instance or warm-up after restart.
- Evictions appearing — confirm \`maxmemory-policy\`; scale memory or shed cold keys.
- Latency spikes — check \`SLOWLOG\`, look for \`KEYS\`/\`SMEMBERS\` on large structures, or fork-induced pauses from RDB/AOF rewrites.
- Replica lag growing — check network, replica disk if AOF is on, and confirm no replica blocking commands.
- Memory growth without traffic — look for big keys via \`redis-cli --bigkeys\` and check fragmentation ratio.

Reference: https://github.com/oliver006/redis_exporter
`,
};

const kafka: Seed = {
  id: 'bundled-kafka',
  source: 'bundled',
  sourceRef: null,
  title: 'Kafka',
  description:
    'When investigating Kafka cluster health: broker throughput, under-replicated partitions, controller count, or consumer-group lag.',
  intentTags: ['kafka', 'messaging', 'streaming', 'broker', 'consumer-lag', 'event-bus', 'on-call', 'dashboard'],
  createdBy: null,
  body: `## When to use

Kafka scraped by \`kafka_exporter\` (cluster/consumer-group metrics) plus JMX-exported broker metrics. Canaries: under-replicated partitions must be 0, active controller count must be 1, and consumer-group lag must be bounded and decreasing under steady-state.

## Key metrics

- \`kafka_server_brokertopicmetrics_messagesinpersec\` (gauge, JMX rate) — per-broker produce rate.
- \`kafka_server_brokertopicmetrics_bytesinpersec\` / \`_bytesoutpersec\` (gauges) — broker throughput.
- \`kafka_controller_kafkacontroller_activecontrollercount\` (gauge) — must sum to exactly 1 across the cluster.
- \`kafka_log_log_logendoffset\` (gauge) — log end offset per topic/partition.
- \`kafka_server_replicamanager_underreplicatedpartitions\` (gauge) — partitions missing replicas. Any non-zero sustained value is a problem.
- \`kafka_consumergroup_lag\` (gauge, from kafka_exporter) — per-group/topic lag in messages.

## Common queries

\`\`\`promql
# Messages in/sec per broker
sum by (instance) (kafka_server_brokertopicmetrics_messagesinpersec{job="$JOB"})

# Bytes in/out per broker
sum by (instance) (kafka_server_brokertopicmetrics_bytesinpersec{job="$JOB"})
sum by (instance) (kafka_server_brokertopicmetrics_bytesoutpersec{job="$JOB"})

# Active controllers (must equal 1)
sum(kafka_controller_kafkacontroller_activecontrollercount{job="$JOB"})

# Under-replicated partitions
sum by (instance) (kafka_server_replicamanager_underreplicatedpartitions{job="$JOB"})

# Consumer-group lag
sum by (consumergroup, topic) (kafka_consumergroup_lag{job="$JOB"})
\`\`\`

## Recommended dashboard

Row 1: per-broker throughput trio — messages-in/sec, bytes-in/sec, bytes-out/sec. Row 2: cluster integrity — active controllers (stat), under-replicated partitions per broker, consumer-group lag by group/topic. Filter by \`JOB\`.

## Troubleshooting

- Under-replicated partitions — check broker disk space, network between brokers, and the broker logs for ISR shrinks.
- Consumer lag rising — scale consumer instances, check for slow message processing, or rebalance issues.
- No active controller — inspect ZooKeeper / KRaft quorum health.
- Throughput skew between brokers — re-balance partitions; check producer key distribution.
- Disk filling on a broker — adjust \`log.retention.*\`; verify cleanup threads are running.

Reference: https://github.com/danielqsj/kafka_exporter
`,
};

const rabbitmq: Seed = {
  id: 'bundled-rabbitmq',
  source: 'bundled',
  sourceRef: null,
  title: 'RabbitMQ',
  description:
    'When investigating RabbitMQ health: queue depth, ready vs unacked backlog, channel/connection sprawl, or disk-free pressure causing publisher flow control.',
  intentTags: ['rabbitmq', 'amqp', 'messaging', 'queue', 'broker', 'on-call', 'dashboard'],
  createdBy: null,
  body: `## When to use

RabbitMQ scraped by the official \`rabbitmq_prometheus\` plugin. Backed-up queues are the leading indicator of consumer issues; ballooning unacked indicates slow consumers or misconfigured prefetch.

## Key metrics

- \`rabbitmq_queue_messages\` (gauge) — total messages in queue (ready + unacked). Sustained growth is a problem.
- \`rabbitmq_queue_messages_ready\` (gauge) — messages ready for delivery.
- \`rabbitmq_queue_messages_unacknowledged\` (gauge) — delivered but not acked. Large/growing means slow or stuck consumers.
- \`rabbitmq_channels\` (gauge) — open AMQP channels.
- \`rabbitmq_connections\` (gauge) — open AMQP connections.
- \`rabbitmq_node_disk_free_bytes\` (gauge) — free disk. Approaching \`rabbitmq_node_disk_free_limit_bytes\` triggers publisher flow control.

## Common queries

\`\`\`promql
# Top-20 deepest queues
topk(20, rabbitmq_queue_messages{job="$JOB"})

# Total ready across all queues
sum(rabbitmq_queue_messages_ready{job="$JOB"})

# Total unacked
sum(rabbitmq_queue_messages_unacknowledged{job="$JOB"})

# Channels / connections
rabbitmq_channels{job="$JOB"}
rabbitmq_connections{job="$JOB"}

# Disk free
rabbitmq_node_disk_free_bytes{job="$JOB"}
\`\`\`

## Recommended dashboard

Row 1: queue depth (topk 20 by queue), ready-vs-unacked split (two series). Row 2: channels and connections per node, node disk-free bytes. Filter by \`JOB\`.

## Troubleshooting

- Queue depth climbing — scale consumers, inspect their logs for processing errors, and check prefetch settings.
- Unacked spiking — likely a consumer hang; inspect channel-level metrics, force-close stale channels if needed.
- Disk approaching free limit — purge dead queues, expand volume, or tighten message TTL.
- Channel/connection sprawl — set per-vhost limits; look for clients that reconnect on every message.
- Memory alarm — RabbitMQ throttles publishers; check \`rabbitmq_node_mem_used\` and free RAM.

Reference: https://www.rabbitmq.com/prometheus.html
`,
};

const nats: Seed = {
  id: 'bundled-nats',
  source: 'bundled',
  sourceRef: null,
  title: 'NATS',
  description:
    'When investigating NATS health: core msg throughput, slow consumer count, or JetStream consumer pending and stream byte size.',
  intentTags: ['nats', 'messaging', 'jetstream', 'pubsub', 'broker', 'on-call', 'dashboard'],
  createdBy: null,
  body: `## When to use

NATS scraped by \`prometheus-nats-exporter\`. Slow consumers are the canary; in JetStream mode, watch per-consumer pending and stream byte size against configured \`max_bytes\`.

## Key metrics

- \`nats_varz_in_msgs\` (counter) — messages received by the server.
- \`nats_varz_out_msgs\` (counter) — messages delivered by the server.
- \`nats_varz_connections\` (gauge) — active client connections.
- \`nats_varz_slow_consumers\` (gauge) — subscribers the server had to disconnect for falling behind. Any growth is bad.
- \`nats_jetstream_consumer_num_pending\` (gauge) — JetStream consumer pending. Sustained growth means consumer can't keep up.
- \`nats_jetstream_stream_bytes\` (gauge) — on-disk bytes per stream. Approaching configured \`max_bytes\` is a red flag.

## Common queries

\`\`\`promql
# Msgs in/out per second
sum by (instance) (rate(nats_varz_in_msgs{job="$JOB"}[5m]))
sum by (instance) (rate(nats_varz_out_msgs{job="$JOB"}[5m]))

# Connections
nats_varz_connections{job="$JOB"}

# Slow consumers
nats_varz_slow_consumers{job="$JOB"}

# JetStream pending (topk)
topk(10, nats_jetstream_consumer_num_pending{job="$JOB"})

# Stream sizes
nats_jetstream_stream_bytes{job="$JOB"}
\`\`\`

## Recommended dashboard

Row 1: throughput trio — msgs-in/sec, msgs-out/sec, active connections. Row 2: health — slow consumers, JetStream pending (topk by consumer), JetStream stream bytes. Filter by \`JOB\`.

## Troubleshooting

- Slow consumers growing — increase subscriber pending limits or fix downstream processing.
- JetStream pending climbing — scale consumer instances or raise ack wait / redelivery limits.
- Stream size near max — adjust retention/max_age, or expand max_bytes.
- Connection churn — check client backoff configs; look for cluster-route flapping.
- Cluster split — inspect \`nats_varz_routes\` and route connection health.

Reference: https://github.com/nats-io/prometheus-nats-exporter
`,
};

const nginx: Seed = {
  id: 'bundled-nginx',
  source: 'bundled',
  sourceRef: null,
  title: 'Nginx',
  description:
    'When investigating Nginx health using stub_status: request rate, active/waiting connections, worker-connection saturation. Note status-code breakdown requires VTS or log scraping.',
  intentTags: ['nginx', 'http', 'proxy', 'web', 'reverse-proxy', 'on-call', 'dashboard'],
  createdBy: null,
  body: `## When to use

Nginx scraped by \`nginx-prometheus-exporter\` (built on \`stub_status\`). Stub_status exposes connection counts and total requests only — no per-status-code split. For 4xx/5xx ratios, pair with the OpenTelemetry collector log scraper or switch to the VTS module.

## Key metrics

- \`nginx_http_requests_total\` (counter) — total HTTP requests handled.
- \`nginx_connections_active\` (gauge) — active client connections (reading + writing + waiting). Approaching \`worker_connections * worker_processes\` is the saturation signal.
- \`nginx_connections_waiting\` (gauge) — idle keep-alive sockets.
- \`nginx_connections_reading\` (gauge) — connections where nginx is reading the request header. Sustained high count suggests slow clients.
- \`nginx_connections_writing\` (gauge) — connections writing a response.
- \`nginx_connections_accepted\` / \`_handled\` (counters) — gap means worker_connections exhaustion (accepted > handled).

## Common queries

\`\`\`promql
# Requests/sec
sum by (instance) (rate(nginx_http_requests_total{job="$JOB"}[5m]))

# Active connections
nginx_connections_active{job="$JOB"}

# Reading / writing / waiting breakdown
nginx_connections_reading{job="$JOB"}
nginx_connections_writing{job="$JOB"}
nginx_connections_waiting{job="$JOB"}

# Worker connection exhaustion (rate gap)
sum by (instance) (rate(nginx_connections_accepted{job="$JOB"}[5m]))
  - sum by (instance) (rate(nginx_connections_handled{job="$JOB"}[5m]))
\`\`\`

## Recommended dashboard

Row 1: requests/sec, active connections. Row 2: reading / writing / waiting (three small panels) + accepted-handled gap. Filter by \`JOB\`.

## Troubleshooting

- Active connections capped at worker limit — raise \`worker_connections\`/\`worker_processes\` or scale horizontally.
- Reading connections piling up — investigate slow clients; consider tightening \`client_header_timeout\`.
- Need status-code breakdown — switch to VTS module or scrape access logs with the OTel collector.
- Upstream errors — combine with upstream metrics (haproxy/envoy/app); nginx stub_status doesn't expose them.
- Worker restarts spike — check OOMs and config-reload patterns.

Reference: https://github.com/nginxinc/nginx-prometheus-exporter
`,
};

const haproxy: Seed = {
  id: 'bundled-haproxy',
  source: 'bundled',
  sourceRef: null,
  title: 'HAProxy',
  description:
    'When investigating HAProxy health: frontend request rate, backend errors, queue depth (backend saturation), session count, or server health-check state.',
  intentTags: ['haproxy', 'http', 'tcp', 'load-balancer', 'proxy', 'on-call', 'dashboard'],
  createdBy: null,
  body: `## When to use

HAProxy with its native Prometheus endpoint enabled. Backend queue depth is the key saturation signal — when it's >0 sustained, backends are full and HAProxy is buffering.

## Key metrics

- \`haproxy_frontend_http_requests_total\` (counter) — HTTP requests per frontend.
- \`haproxy_backend_response_errors_total\` (counter) — backend response errors. Sustained rate >0 is a red flag.
- \`haproxy_backend_queue_current\` (gauge) — requests queued waiting for a backend slot. Sustained >0 means backends are saturated.
- \`haproxy_backend_current_sessions\` (gauge) — active sessions per backend.
- \`haproxy_backend_response_time_average_seconds\` (gauge) — mean backend response time. (Native exporter does not expose percentiles — pair with app-level histograms for p99.)
- \`haproxy_server_check_status\` (gauge) — health-check state per server (1 = up). Flapping or persistently down is a problem.

## Common queries

\`\`\`promql
# Frontend req/sec
sum by (proxy) (rate(haproxy_frontend_http_requests_total{job="$JOB"}[5m]))

# Backend errors/sec
sum by (proxy) (rate(haproxy_backend_response_errors_total{job="$JOB"}[5m]))

# Queue depth
haproxy_backend_queue_current{job="$JOB"}

# Active sessions
haproxy_backend_current_sessions{job="$JOB"}

# Backend RT (avg)
haproxy_backend_response_time_average_seconds{job="$JOB"}
\`\`\`

## Recommended dashboard

Row 1: frontend req/sec, backend errors/sec, backend queue depth. Row 2: backend active sessions, backend avg response time. Filter by \`JOB\`.

## Troubleshooting

- Backend queue rising — scale backend server count or raise \`maxconn\`/\`fullconn\` if config-bound.
- 5xx errors — inspect backend application logs; HAProxy bubbles up upstream errors.
- Server check failing — verify network/path, then app health endpoint.
- Session count near \`maxconn\` — raise the limit or shed traffic; check for long-lived connections.
- Need percentile latency — pair with app-level histograms; native metrics only expose averages.

Reference: https://www.haproxy.com/documentation/haproxy-runtime-api/reference/show-stat/
`,
};

const envoy: Seed = {
  id: 'bundled-envoy',
  source: 'bundled',
  sourceRef: null,
  title: 'Envoy (standalone)',
  description:
    'When investigating standalone Envoy (not Istio): downstream request rate, 5xx class, upstream pending requests, connection pool saturation, or retry storms.',
  intentTags: ['envoy', 'proxy', 'http', 'l7', 'edge', 'on-call', 'dashboard'],
  createdBy: null,
  body: `## When to use

Standalone Envoy via its native \`/stats/prometheus\` endpoint. For Istio sidecars, use the \`bundled-istio\` entry instead. Upstream pending is the saturation signal: when it's >0 sustained, the upstream pool is exhausted or circuit-breaking.

## Key metrics

- \`envoy_http_downstream_rq_total\` (counter) — downstream requests handled.
- \`envoy_http_downstream_rq_xx\` (counter, labeled by \`envoy_response_code_class\`) — response class split.
- \`envoy_cluster_upstream_rq_pending_active\` (gauge) — upstream requests queued waiting for a connection. Sustained >0 = pool exhausted or breaker tripped.
- \`envoy_cluster_upstream_cx_active\` (gauge) — active upstream connections per cluster.
- \`envoy_server_memory_allocated\` (gauge) — process memory.
- \`envoy_cluster_upstream_rq_retry\` (counter) — retried upstream requests. High retry rate masks issues and amplifies load.

## Common queries

\`\`\`promql
# Downstream req/sec
sum by (instance) (rate(envoy_http_downstream_rq_total{job="$JOB"}[5m]))

# 5xx-class rate
sum by (instance) (rate(envoy_http_downstream_rq_xx{job="$JOB", envoy_response_code_class="5"}[5m]))

# Upstream pending per cluster
sum by (envoy_cluster_name) (envoy_cluster_upstream_rq_pending_active{job="$JOB"})

# Active upstream connections
sum by (envoy_cluster_name) (envoy_cluster_upstream_cx_active{job="$JOB"})

# Process memory
envoy_server_memory_allocated{job="$JOB"}
\`\`\`

## Recommended dashboard

Row 1: downstream req/sec, 5xx-class rate, upstream pending per cluster. Row 2: active upstream connections per cluster, server memory. Filter by \`JOB\`.

## Troubleshooting

- 5xx class rising — drill into per-route stats and upstream logs.
- Pending requests piling up — raise \`max_connections\`/\`max_pending_requests\` in cluster circuit breakers, or scale upstream.
- Connection churn — check upstream keep-alive and idle timeouts.
- Memory growth — verify config-update churn; xDS update floods can leak memory in older versions.
- Retry storms — tighten retry policy (\`max_retries\`, \`retry_on\` conditions).

Reference: https://www.envoyproxy.io/docs/envoy/latest/configuration/upstream/cluster_manager/cluster_stats
`,
};

const jvm: Seed = {
  id: 'bundled-jvm',
  source: 'bundled',
  sourceRef: null,
  title: 'JVM (Java / Kotlin / Scala)',
  description:
    'When investigating a JVM app exposing Micrometer or jmx_exporter metrics: heap pressure, GC pause behavior, thread leaks, or class-loading growth.',
  intentTags: ['jvm', 'java', 'kotlin', 'scala', 'runtime', 'gc', 'heap', 'on-call', 'dashboard'],
  createdBy: null,
  body: `## When to use

JVM apps with Micrometer (Spring Boot, Quarkus) or \`jmx_exporter\`. Heap consistently >80% of max *after* GC is the leading indicator of memory trouble.

## Key metrics

- \`jvm_memory_used_bytes\` (gauge, labeled by \`area\`) — used per memory area (heap, nonheap).
- \`jvm_memory_max_bytes\` (gauge) — configured max per area.
- \`jvm_gc_collection_seconds_count\` (counter) — GC pauses count per collector. Old-gen frequency rising is a red flag.
- \`jvm_gc_collection_seconds_sum\` (counter) — cumulative GC time; divide rate by count for avg pause.
- \`jvm_threads_current\` (gauge) — live threads. Unbounded growth = thread leak.
- \`jvm_classes_loaded\` (gauge) — loaded class count.
- \`process_cpu_seconds_total\` (counter) — process CPU consumption.

## Common queries

\`\`\`promql
# Heap utilization
jvm_memory_used_bytes{area="heap", job="$JOB"}
  / jvm_memory_max_bytes{area="heap", job="$JOB"}

# Heap bytes
jvm_memory_used_bytes{area="heap", job="$JOB"}

# GC time per collector
sum by (gc) (rate(jvm_gc_collection_seconds_sum{job="$JOB"}[5m]))

# GC pauses/sec
sum by (gc) (rate(jvm_gc_collection_seconds_count{job="$JOB"}[5m]))

# Live threads
jvm_threads_current{job="$JOB"}

# Process CPU
sum by (instance) (rate(process_cpu_seconds_total{job="$JOB"}[5m]))
\`\`\`

## Recommended dashboard

Row 1: heap utilization (0..1), heap bytes used, GC time/sec by collector. Row 2: GC pauses/sec by collector, live thread count, process CPU. Filter by \`JOB\`.

## Troubleshooting

- Heap pressure — capture a heap dump (\`jmap\`) and analyze with Eclipse MAT for retained-size hotspots.
- GC time rising — switch collector (G1/ZGC), raise heap, or tune \`MaxGCPauseMillis\`.
- Thread leak — \`jstack\` snapshot; check for executors not shutting down or blocking I/O without timeout.
- Class count growing — check for dynamic class generation (proxies, scripting) without unloading.
- CPU saturation — async-profiler flamegraph to find hot methods.

References: https://github.com/prometheus/jmx_exporter, https://micrometer.io/
`,
};

const nodejs: Seed = {
  id: 'bundled-nodejs',
  source: 'bundled',
  sourceRef: null,
  title: 'Node.js',
  description:
    'When investigating a Node.js app exposing prom-client metrics: event-loop lag, RSS growth, V8 heap, active-handle leaks, or GC frequency.',
  intentTags: ['nodejs', 'node', 'javascript', 'typescript', 'runtime', 'event-loop', 'on-call', 'dashboard'],
  createdBy: null,
  body: `## When to use

Node.js apps exposing metrics via \`prom-client\` default registry. Event-loop lag is the canary for any CPU-bound or blocking work.

## Key metrics

- \`process_resident_memory_bytes\` (gauge) — process RSS.
- \`nodejs_eventloop_lag_seconds\` (gauge) — latest sample. >0.1s sustained = CPU-bound or blocking work in the loop.
- \`nodejs_active_handles_total\` (gauge) — libuv active handles. Unbounded growth = handle leak.
- \`nodejs_heap_size_total_bytes\` (gauge) — total V8 heap size.
- \`nodejs_heap_size_used_bytes\` (gauge) — V8 heap used. used/total trending up over hours = memory leak.
- \`nodejs_gc_duration_seconds_count\` (counter) — GC events by kind.

## Common queries

\`\`\`promql
# RSS
process_resident_memory_bytes{job="$JOB"}

# Event-loop lag
nodejs_eventloop_lag_seconds{job="$JOB"}

# Active handles
nodejs_active_handles_total{job="$JOB"}

# Heap utilization
nodejs_heap_size_used_bytes{job="$JOB"}
  / nodejs_heap_size_total_bytes{job="$JOB"}

# GC events/sec by kind
sum by (kind) (rate(nodejs_gc_duration_seconds_count{job="$JOB"}[5m]))
\`\`\`

## Recommended dashboard

Row 1: RSS bytes, event-loop lag (seconds), active handles. Row 2: V8 heap used/total ratio, GC events/sec by kind. Filter by \`JOB\`.

## Troubleshooting

- Event-loop lag spiking — find the synchronous hot path with \`--prof\` or clinic.js flame; offload to a worker thread.
- Memory growth — take heap snapshots via \`--inspect\` and diff to find retainers.
- Handle leak — instrument \`process._getActiveHandles()\` to inventory; common cause is uncleared intervals or unfinished streams.
- High GC time — V8 may be in serial GC mode under pressure; raise \`--max-old-space-size\` if RAM is available.
- CPU-bound endpoint — consider worker_threads or move computation off the request path.

Reference: https://github.com/siimon/prom-client
`,
};

const go: Seed = {
  id: 'bundled-go',
  source: 'bundled',
  sourceRef: null,
  title: 'Go runtime',
  description:
    'When investigating a Go app exposing client_golang metrics: goroutine leaks, heap growth, GC pause p99, or file-descriptor exhaustion.',
  intentTags: ['go', 'golang', 'runtime', 'goroutine', 'gc', 'on-call', 'dashboard'],
  createdBy: null,
  body: `## When to use

Go apps exposing metrics via \`client_golang\` (promauto). Goroutine count and FD count are the leak canaries; GC pause p99 sustained >100ms means GC pressure.

## Key metrics

- \`go_goroutines\` (gauge) — live goroutine count. Unbounded growth = leak.
- \`go_memstats_heap_inuse_bytes\` (gauge) — in-use heap spans.
- \`go_memstats_heap_alloc_bytes\` (gauge) — currently allocated bytes. Steady growth without releases = leak or live-set inflation.
- \`go_gc_duration_seconds\` (summary) — GC pause durations with quantile labels. p99 >100ms sustained = GC pressure.
- \`go_threads\` (gauge) — OS threads created by the runtime.
- \`process_open_fds\` (gauge) — open file descriptors. Near \`process_max_fds\` = FD leak (often un-closed http.Response.Body).

## Common queries

\`\`\`promql
# Goroutines
go_goroutines{job="$JOB"}

# Heap in-use
go_memstats_heap_inuse_bytes{job="$JOB"}

# GC pause p99
go_gc_duration_seconds{quantile="0.99", job="$JOB"}

# Open FDs
process_open_fds{job="$JOB"}
\`\`\`

## Recommended dashboard

Row 1: goroutine count, heap in-use bytes. Row 2: GC pause p99 (seconds), open FDs. Filter by \`JOB\`.

## Troubleshooting

- Goroutine leak — capture \`/debug/pprof/goroutine?debug=2\` and look for blocked stacks (chan recv, sync.Mutex.Lock).
- Heap growing — \`/debug/pprof/heap\` then \`go tool pprof -alloc_objects\` vs \`-inuse_objects\`.
- GC pauses — reduce allocation rate (\`pprof -alloc_space\`); tune \`GOGC\` if memory is plentiful.
- FD exhaustion — confirm every \`http.Get\` calls \`resp.Body.Close()\`; check OS soft/hard limits.
- CPU saturation — \`go tool pprof http://.../debug/pprof/profile?seconds=30\` flamegraph.

Reference: https://github.com/prometheus/client_golang
`,
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const BUNDLED_SEEDS: ReadonlyArray<Omit<KnowledgeInsertInput, 'orgId'>> = [
  redMethod,
  useMethod,
  perPodOps,
  istio,
  k8sWorkload,
  postgres,
  mysql,
  mongodb,
  redis,
  kafka,
  rabbitmq,
  nats,
  nginx,
  haproxy,
  envoy,
  jvm,
  nodejs,
  go,
];
