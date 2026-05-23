/**
 * Bundled (factory-shipped) knowledge-base seeds.
 *
 * Loaded once per org by `ensureBundledSeeds` in the api-gateway boot path.
 * Idempotent — keyed by `id`, so re-runs are safe.
 *
 * Each entry has:
 *   - kind=pattern  → high-level dashboard shapes (RED, USE, per-pod ops).
 *                     Lacks concrete metric names; the agent fills them in.
 *   - kind=template → concrete panel layouts with `${VAR}` placeholders the
 *                     agent substitutes at apply time.
 */

import type {
  KnowledgeInsertInput,
  PatternContent,
  TemplateContent,
  TemplatePanel,
} from './types.js';

const DS = '${DATASOURCE_ID}';

// ---------------------------------------------------------------------------
// Seed 1 — Pattern: RED method
// ---------------------------------------------------------------------------
const redContent: PatternContent = {
  applicableWhen:
    'You have a request-oriented service emitting per-request metrics (HTTP, gRPC, GraphQL, queue consumers). Use one panel-row per service.',
  structure: {
    rowGroups: [
      {
        title: '$SERVICE (RED)',
        panels: [
          {
            kind: 'time_series',
            queryShape: 'sum by (service) (rate(<requests>_total{service="$SERVICE"}[5m]))',
            vizHint: 'requests/s',
          },
          {
            kind: 'time_series',
            queryShape:
              'sum by (service) (rate(<requests>_total{service="$SERVICE",status=~"5.."}[5m])) / sum by (service) (rate(<requests>_total{service="$SERVICE"}[5m]))',
            vizHint: 'error ratio 0..1',
          },
          {
            kind: 'time_series',
            queryShape:
              'histogram_quantile(0.99, sum by (le,service) (rate(<requests>_duration_seconds_bucket{service="$SERVICE"}[5m])))',
            vizHint: 'p99 seconds',
          },
        ],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Seed 2 — Pattern: USE method
// ---------------------------------------------------------------------------
const useContent: PatternContent = {
  applicableWhen:
    'You are inspecting physical resources (CPU/mem/disk/net per node or pod). One row per resource type.',
  structure: {
    rowGroups: [
      {
        title: 'CPU',
        panels: [
          {
            kind: 'time_series',
            queryShape: '1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))',
            vizHint: 'utilization 0..1',
          },
          {
            kind: 'time_series',
            queryShape: 'avg by (instance) (node_load5) / count by (instance) (node_cpu_seconds_total{mode="idle"})',
            vizHint: 'saturation (load5 per core)',
          },
          {
            kind: 'time_series',
            queryShape: 'rate(node_cpu_seconds_total{mode="iowait"}[5m])',
            vizHint: 'iowait as proxy for errors',
          },
        ],
      },
      {
        title: 'Memory',
        panels: [
          {
            kind: 'time_series',
            queryShape:
              '1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)',
            vizHint: 'utilization 0..1',
          },
          {
            kind: 'time_series',
            queryShape: 'rate(node_vmstat_pswpin[5m]) + rate(node_vmstat_pswpout[5m])',
            vizHint: 'swap pages/s (saturation)',
          },
          {
            kind: 'time_series',
            queryShape: 'rate(node_vmstat_oom_kill[5m])',
            vizHint: 'OOM kills/s',
          },
        ],
      },
      {
        title: 'Disk',
        panels: [
          {
            kind: 'time_series',
            queryShape:
              '1 - (node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay"})',
            vizHint: 'utilization 0..1',
          },
          {
            kind: 'time_series',
            queryShape: 'rate(node_disk_io_time_seconds_total[5m])',
            vizHint: 'IO time fraction (saturation)',
          },
          {
            kind: 'time_series',
            queryShape: 'rate(node_disk_io_errors_total[5m])',
            vizHint: 'disk errors/s',
          },
        ],
      },
      {
        title: 'Network',
        panels: [
          {
            kind: 'time_series',
            queryShape: 'rate(node_network_receive_bytes_total[5m]) + rate(node_network_transmit_bytes_total[5m])',
            vizHint: 'bytes/s (utilization vs link)',
          },
          {
            kind: 'time_series',
            queryShape: 'rate(node_network_receive_drop_total[5m]) + rate(node_network_transmit_drop_total[5m])',
            vizHint: 'drops/s (saturation)',
          },
          {
            kind: 'time_series',
            queryShape: 'rate(node_network_receive_errs_total[5m]) + rate(node_network_transmit_errs_total[5m])',
            vizHint: 'errors/s',
          },
        ],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Seed 3 — Pattern: per-pod operational view
// ---------------------------------------------------------------------------
const perPodContent: PatternContent = {
  applicableWhen:
    'You are debugging a single workload and want per-pod resource + health + log signals on one screen.',
  structure: {
    rowGroups: [
      {
        title: '$POD',
        panels: [
          {
            kind: 'stat',
            queryShape:
              'rate(container_cpu_usage_seconds_total{pod="$POD"}[5m]) / (container_spec_cpu_quota{pod="$POD"}/100000) * 100',
            vizHint: '% of CPU quota',
          },
          {
            kind: 'stat',
            queryShape:
              'container_memory_working_set_bytes{pod="$POD"} / container_spec_memory_limit_bytes{pod="$POD"} * 100',
            vizHint: '% of mem limit',
          },
          {
            kind: 'stat',
            queryShape: 'kube_pod_container_status_restarts_total{pod="$POD"}',
            vizHint: 'restart count',
          },
          {
            kind: 'time_series',
            queryShape:
              'sum by (level) (rate(log_messages_total{pod="$POD",level=~"error|warn"}[5m]))',
            vizHint: 'log msgs/s',
          },
        ],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Seed 4 — Template: istio-data-plane (~26 panels)
// ---------------------------------------------------------------------------

function tmplPanel(p: {
  id: string;
  title: string;
  q: string;
  expr: string;
  viz?: string;
  row: number;
  col: number;
  width: number;
  height?: number;
  unit?: string;
  legend?: string;
}): TemplatePanel {
  return {
    id: p.id,
    title: p.title,
    description: `Q: ${p.q}`,
    visualization: p.viz ?? 'time_series',
    queries: [
      {
        refId: 'A',
        expr: p.expr,
        legendFormat: p.legend ?? '{{pod}}',
        instant: false,
        datasourceId: DS,
      },
    ],
    row: p.row,
    col: p.col,
    width: p.width,
    height: p.height ?? 6,
    ...(p.unit ? { unit: p.unit } : {}),
  };
}

const NS = '${NAMESPACE}';
const TR = '${TIME_RANGE}';

const istioPanels: TemplatePanel[] = [
  // Section 1 — Proxy Resource Usage (row=0, w=3 each)
  tmplPanel({
    id: 'istio-dp-1-cpu-util',
    title: 'CPU utilization',
    q: 'How much CPU is each istio-proxy sidecar consuming?',
    expr: `sum by (pod) (rate(container_cpu_usage_seconds_total{container="istio-proxy", namespace="${NS}"}[${TR}])) * 100`,
    row: 0, col: 0, width: 3, unit: 'percent',
  }),
  tmplPanel({
    id: 'istio-dp-2-cpu-limit',
    title: 'CPU limit utilization',
    q: 'Is any istio-proxy exceeding its CPU quota?',
    expr: `sum by (pod) (rate(container_cpu_usage_seconds_total{container="istio-proxy", namespace="${NS}"}[${TR}])) / on(pod) group_left() (container_spec_cpu_quota{container="istio-proxy", namespace="${NS}"} / 100000) * 100`,
    row: 0, col: 3, width: 3, unit: 'percent',
  }),
  tmplPanel({
    id: 'istio-dp-3-mem-util',
    title: 'Mem utilization',
    q: 'Is any istio-proxy near its memory limit?',
    expr: `container_memory_working_set_bytes{container="istio-proxy", namespace="${NS}"} / container_spec_memory_limit_bytes{container="istio-proxy", namespace="${NS}"} * 100`,
    row: 0, col: 6, width: 3, unit: 'percent',
  }),
  tmplPanel({
    id: 'istio-dp-4-mem-bytes',
    title: 'Mem bytes',
    q: 'Absolute memory used by each istio-proxy?',
    expr: `container_memory_working_set_bytes{container="istio-proxy", namespace="${NS}"}`,
    row: 0, col: 9, width: 3, unit: 'bytes',
  }),

  // Section 2 — Ingress Requests (row=3, reporter=destination)
  tmplPanel({
    id: 'istio-dp-5-ingress-total',
    title: 'Total Ingress Request',
    q: 'Inbound request rate per pod?',
    expr: `sum by (pod) (rate(istio_requests_total{reporter="destination", destination_workload_namespace="${NS}"}[${TR}]))`,
    row: 3, col: 0, width: 3, unit: 'reqps',
  }),
  tmplPanel({
    id: 'istio-dp-6-ingress-2xx',
    title: '2XX count',
    q: 'Inbound 2xx rate per pod?',
    expr: `sum by (pod) (rate(istio_requests_total{reporter="destination", destination_workload_namespace="${NS}", response_code=~"2.."}[${TR}]))`,
    row: 3, col: 3, width: 3, unit: 'reqps',
  }),
  tmplPanel({
    id: 'istio-dp-7-ingress-4xx',
    title: '4XX count',
    q: 'Inbound 4xx rate per pod?',
    expr: `sum by (pod) (rate(istio_requests_total{reporter="destination", destination_workload_namespace="${NS}", response_code=~"4.."}[${TR}]))`,
    row: 3, col: 6, width: 3, unit: 'reqps',
  }),
  tmplPanel({
    id: 'istio-dp-8-ingress-5xx',
    title: '5XX count',
    q: 'Inbound 5xx rate per pod?',
    expr: `sum by (pod) (rate(istio_requests_total{reporter="destination", destination_workload_namespace="${NS}", response_code=~"5.."}[${TR}]))`,
    row: 3, col: 9, width: 3, unit: 'reqps',
  }),
  tmplPanel({
    id: 'istio-dp-9-ingress-nonok-flag',
    title: 'Non-OK response flag',
    q: 'Inbound requests with envoy non-OK flag per pod?',
    expr: `sum by (pod) (rate(istio_requests_total{reporter="destination", destination_workload_namespace="${NS}", response_flags!="-"}[${TR}]))`,
    row: 3, col: 0, width: 3, unit: 'reqps',
  }),

  // Section 3 — Egress Requests (row=6, reporter=source)
  tmplPanel({
    id: 'istio-dp-10-egress-total',
    title: 'Total Egress Request',
    q: 'Outbound request rate per pod?',
    expr: `sum by (pod) (rate(istio_requests_total{reporter="source", source_workload_namespace="${NS}"}[${TR}]))`,
    row: 6, col: 0, width: 3, unit: 'reqps',
  }),
  tmplPanel({
    id: 'istio-dp-11-egress-2xx',
    title: '2XX count',
    q: 'Outbound 2xx rate per pod?',
    expr: `sum by (pod) (rate(istio_requests_total{reporter="source", source_workload_namespace="${NS}", response_code=~"2.."}[${TR}]))`,
    row: 6, col: 3, width: 3, unit: 'reqps',
  }),
  tmplPanel({
    id: 'istio-dp-12-egress-4xx',
    title: '4XX count',
    q: 'Outbound 4xx rate per pod?',
    expr: `sum by (pod) (rate(istio_requests_total{reporter="source", source_workload_namespace="${NS}", response_code=~"4.."}[${TR}]))`,
    row: 6, col: 6, width: 3, unit: 'reqps',
  }),
  tmplPanel({
    id: 'istio-dp-13-egress-5xx',
    title: '5XX count',
    q: 'Outbound 5xx rate per pod?',
    expr: `sum by (pod) (rate(istio_requests_total{reporter="source", source_workload_namespace="${NS}", response_code=~"5.."}[${TR}]))`,
    row: 6, col: 9, width: 3, unit: 'reqps',
  }),
  tmplPanel({
    id: 'istio-dp-14-egress-nonok-flag',
    title: 'Non-OK response flag',
    q: 'Outbound requests with envoy non-OK flag per pod?',
    expr: `sum by (pod) (rate(istio_requests_total{reporter="source", source_workload_namespace="${NS}", response_flags!="-"}[${TR}]))`,
    row: 6, col: 0, width: 3, unit: 'reqps',
  }),

  // Section 4 — TCP metrics (row=9, w=3)
  tmplPanel({
    id: 'istio-dp-15-tcp-opened',
    title: 'TCP Connections Opened',
    q: 'TCP open rate per pod?',
    expr: `sum by (pod) (rate(istio_tcp_connections_opened_total{destination_workload_namespace="${NS}"}[${TR}]))`,
    row: 9, col: 0, width: 3,
  }),
  tmplPanel({
    id: 'istio-dp-16-tcp-closed',
    title: 'TCP Connections Closed',
    q: 'TCP close rate per pod?',
    expr: `sum by (pod) (rate(istio_tcp_connections_closed_total{destination_workload_namespace="${NS}"}[${TR}]))`,
    row: 9, col: 3, width: 3,
  }),
  tmplPanel({
    id: 'istio-dp-17-tcp-sent',
    title: 'TCP Bytes Sent',
    q: 'TCP send throughput per pod?',
    expr: `sum by (pod) (rate(istio_tcp_sent_bytes_total{destination_workload_namespace="${NS}"}[${TR}]))`,
    row: 9, col: 6, width: 3, unit: 'Bps',
  }),
  tmplPanel({
    id: 'istio-dp-18-tcp-recv',
    title: 'TCP Bytes Received',
    q: 'TCP recv throughput per pod?',
    expr: `sum by (pod) (rate(istio_tcp_received_bytes_total{destination_workload_namespace="${NS}"}[${TR}]))`,
    row: 9, col: 9, width: 3, unit: 'Bps',
  }),

  // Section 5 — Ingress Gateway Resources (row=12, 3 panels w=4)
  tmplPanel({
    id: 'istio-dp-19-gw-cpu-util',
    title: 'Gateway CPU utilization',
    q: 'How much CPU does the ingress gateway use?',
    expr: `sum by (pod) (rate(container_cpu_usage_seconds_total{container="istio-proxy", pod=~"istio-ingressgateway-.*"}[${TR}])) / on(pod) group_left() (container_spec_cpu_quota{container="istio-proxy", pod=~"istio-ingressgateway-.*"} / 100000) * 100`,
    row: 12, col: 0, width: 4, unit: 'percent',
  }),
  tmplPanel({
    id: 'istio-dp-20-gw-mem-util',
    title: 'Gateway Mem utilization',
    q: 'Is ingress gateway near its memory limit?',
    expr: `container_memory_working_set_bytes{container="istio-proxy", pod=~"istio-ingressgateway-.*"} / container_spec_memory_limit_bytes{container="istio-proxy", pod=~"istio-ingressgateway-.*"} * 100`,
    row: 12, col: 4, width: 4, unit: 'percent',
  }),
  tmplPanel({
    id: 'istio-dp-21-gw-mem-bytes',
    title: 'Gateway Mem bytes',
    q: 'Absolute memory used by ingress gateway?',
    expr: `container_memory_working_set_bytes{container="istio-proxy", pod=~"istio-ingressgateway-.*"}`,
    row: 12, col: 8, width: 4, unit: 'bytes',
  }),

  // Section 6 — Istio Gateway Ingress metrics (row=15, source_workload=istio-ingressgateway)
  tmplPanel({
    id: 'istio-dp-22-gw-total',
    title: 'Total Gateway Request',
    q: 'Gateway-originated request rate per pod?',
    expr: `sum by (pod) (rate(istio_requests_total{source_workload="istio-ingressgateway"}[${TR}]))`,
    row: 15, col: 0, width: 3, unit: 'reqps',
  }),
  tmplPanel({
    id: 'istio-dp-23-gw-2xx',
    title: '2XX count',
    q: 'Gateway-originated 2xx rate per pod?',
    expr: `sum by (pod) (rate(istio_requests_total{source_workload="istio-ingressgateway", response_code=~"2.."}[${TR}]))`,
    row: 15, col: 3, width: 3, unit: 'reqps',
  }),
  tmplPanel({
    id: 'istio-dp-24-gw-4xx',
    title: '4XX count',
    q: 'Gateway-originated 4xx rate per pod?',
    expr: `sum by (pod) (rate(istio_requests_total{source_workload="istio-ingressgateway", response_code=~"4.."}[${TR}]))`,
    row: 15, col: 6, width: 3, unit: 'reqps',
  }),
  tmplPanel({
    id: 'istio-dp-25-gw-5xx',
    title: '5XX count',
    q: 'Gateway-originated 5xx rate per pod?',
    expr: `sum by (pod) (rate(istio_requests_total{source_workload="istio-ingressgateway", response_code=~"5.."}[${TR}]))`,
    row: 15, col: 9, width: 3, unit: 'reqps',
  }),
  tmplPanel({
    id: 'istio-dp-26-gw-nonok-flag',
    title: 'Non-OK response flag',
    q: 'Gateway-originated requests with envoy non-OK flag per pod?',
    expr: `sum by (pod) (rate(istio_requests_total{source_workload="istio-ingressgateway", response_flags!="-"}[${TR}]))`,
    row: 15, col: 0, width: 3, unit: 'reqps',
  }),
];

const istioContent: TemplateContent = {
  panels: istioPanels,
  variables: [
    { key: 'NAMESPACE', label: 'K8s namespace', defaultValue: '' },
    { key: 'WORKLOAD', label: 'Workload name regex', defaultValue: '.*' },
    { key: 'TIME_RANGE', label: 'Rate window', defaultValue: '5m' },
  ],
  notes:
    'Operational dashboard for an Istio data plane in a single namespace. Mirrors a real production layout — per-pod sidecar resources, per-pod inbound/outbound request status code split, TCP layer, and the ingress gateway viewed separately. Requires cAdvisor + kube-state-metrics + Istio metrics scraping.',
};

// ---------------------------------------------------------------------------
// Seed 5 — Template: k8s-workload-health
// ---------------------------------------------------------------------------

const HMP = '${HTTP_METRIC_PREFIX}';
const k8sWorkloadPanels: TemplatePanel[] = [
  // Resources
  tmplPanel({
    id: 'k8s-wh-1-cpu-util',
    title: 'Per-pod CPU vs limit',
    q: 'Is any pod near its CPU quota?',
    expr: `sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="${NS}", pod=~"${'${WORKLOAD}'}.*"}[${TR}])) / on(pod) group_left() (container_spec_cpu_quota{namespace="${NS}", pod=~"${'${WORKLOAD}'}.*"} / 100000) * 100`,
    row: 0, col: 0, width: 4, unit: 'percent',
  }),
  tmplPanel({
    id: 'k8s-wh-2-mem-util',
    title: 'Per-pod Mem vs limit',
    q: 'Is any pod near its memory limit?',
    expr: `container_memory_working_set_bytes{namespace="${NS}", pod=~"${'${WORKLOAD}'}.*"} / container_spec_memory_limit_bytes{namespace="${NS}", pod=~"${'${WORKLOAD}'}.*"} * 100`,
    row: 0, col: 4, width: 4, unit: 'percent',
  }),
  tmplPanel({
    id: 'k8s-wh-3-cpu-bytes',
    title: 'Per-pod Mem bytes',
    q: 'Absolute memory used per pod?',
    expr: `container_memory_working_set_bytes{namespace="${NS}", pod=~"${'${WORKLOAD}'}.*"}`,
    row: 0, col: 8, width: 4, unit: 'bytes',
  }),
  tmplPanel({
    id: 'k8s-wh-4-restarts',
    title: 'Container restarts',
    q: 'Are containers restart-looping?',
    expr: `kube_pod_container_status_restarts_total{namespace="${NS}", pod=~"${'${WORKLOAD}'}.*"}`,
    row: 3, col: 0, width: 4, viz: 'stat',
  }),
  tmplPanel({
    id: 'k8s-wh-5-ready',
    title: 'Pods ready',
    q: 'How many replicas are ready right now?',
    expr: `sum(kube_pod_status_ready{namespace="${NS}", pod=~"${'${WORKLOAD}'}.*", condition="true"})`,
    row: 3, col: 4, width: 4, viz: 'stat',
  }),
  tmplPanel({
    id: 'k8s-wh-6-not-ready',
    title: 'Pods not ready',
    q: 'How many replicas are NOT ready right now?',
    expr: `sum(kube_pod_status_ready{namespace="${NS}", pod=~"${'${WORKLOAD}'}.*", condition="false"})`,
    row: 3, col: 8, width: 4, viz: 'stat',
  }),
  // RED — rate, error, duration
  tmplPanel({
    id: 'k8s-wh-7-req-rate',
    title: 'Request rate',
    q: 'How many requests/s is the workload serving?',
    expr: `sum by (pod) (rate(${HMP}_total{namespace="${NS}", pod=~"${'${WORKLOAD}'}.*"}[${TR}]))`,
    row: 6, col: 0, width: 4, unit: 'reqps',
  }),
  tmplPanel({
    id: 'k8s-wh-8-err-ratio',
    title: 'Error ratio',
    q: 'What fraction of requests are 5xx?',
    expr: `sum by (pod) (rate(${HMP}_total{namespace="${NS}", pod=~"${'${WORKLOAD}'}.*", status=~"5.."}[${TR}])) / sum by (pod) (rate(${HMP}_total{namespace="${NS}", pod=~"${'${WORKLOAD}'}.*"}[${TR}]))`,
    row: 6, col: 4, width: 4, unit: 'percentunit',
  }),
  tmplPanel({
    id: 'k8s-wh-9-p99',
    title: 'p99 latency',
    q: 'Tail latency per pod?',
    expr: `histogram_quantile(0.99, sum by (le,pod) (rate(${HMP}_duration_seconds_bucket{namespace="${NS}", pod=~"${'${WORKLOAD}'}.*"}[${TR}])))`,
    row: 6, col: 8, width: 4, unit: 's',
  }),
  // Logs
  tmplPanel({
    id: 'k8s-wh-10-log-err',
    title: 'Log error rate',
    q: 'Is the workload spewing error/warn log lines?',
    expr: `sum by (pod) (rate(log_messages_total{namespace="${NS}", pod=~"${'${WORKLOAD}'}.*", level=~"error|warn"}[${TR}]))`,
    row: 9, col: 0, width: 6,
  }),
  tmplPanel({
    id: 'k8s-wh-11-oom',
    title: 'OOMKilled events',
    q: 'Have any pods been OOM-killed recently?',
    expr: `increase(kube_pod_container_status_terminated_reason{namespace="${NS}", pod=~"${'${WORKLOAD}'}.*", reason="OOMKilled"}[${TR}])`,
    row: 9, col: 6, width: 3, viz: 'stat',
  }),
  tmplPanel({
    id: 'k8s-wh-12-net-throughput',
    title: 'Network throughput',
    q: 'Network bytes/s in+out per pod?',
    expr: `sum by (pod) (rate(container_network_receive_bytes_total{namespace="${NS}", pod=~"${'${WORKLOAD}'}.*"}[${TR}]) + rate(container_network_transmit_bytes_total{namespace="${NS}", pod=~"${'${WORKLOAD}'}.*"}[${TR}]))`,
    row: 9, col: 9, width: 3, unit: 'Bps',
  }),
];

const k8sWorkloadContent: TemplateContent = {
  panels: k8sWorkloadPanels,
  variables: [
    { key: 'NAMESPACE', label: 'Namespace', defaultValue: '' },
    { key: 'WORKLOAD', label: 'Workload regex', defaultValue: '.*' },
    { key: 'HTTP_METRIC_PREFIX', label: 'HTTP metric prefix', defaultValue: 'http_requests' },
  ],
  notes:
    "Standard workload health dashboard: per-pod resources + RED + log error rate. Skip sections whose metrics aren't exposed.",
};

// ---------------------------------------------------------------------------
// Export — what `ensureBundledSeeds` walks at boot. orgId is filled in by the
// loader (per-org seeding); leaving it blank here keeps the array a pure
// constant.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Seeds 6-31 — per-software metric_doc + template pairs.
//
// Each software gets two seeds:
//   bundled-metric-<slug>    → metric_doc content (description, keyMetrics[], troubleshooting[])
//   bundled-template-<slug>  → TemplateContent (panels + variables + notes)
//
// Exporter conventions match: postgres_exporter, mysql_exporter, mongodb_exporter,
// redis_exporter, kafka_exporter, rabbitmq_exporter (Prom plugin), nats prometheus
// exporter, nginx-prometheus-exporter, haproxy native, envoy native /stats/prometheus,
// micrometer/jmx_exporter for JVM, prom-client for Node.js, promauto/client_golang for Go.
// ---------------------------------------------------------------------------

interface MetricDocContent {
  description: string;
  keyMetrics: Array<{
    metric: string;
    type: 'gauge' | 'counter' | 'histogram';
    meaning: string;
    redFlag?: string;
  }>;
  troubleshooting: string[];
  references?: string[];
}

type BundledSeed = Omit<KnowledgeInsertInput, 'orgId'>;

function metricDoc(opts: {
  slug: string;
  title: string;
  intentTags: string[];
  content: MetricDocContent;
}): BundledSeed {
  return {
    id: `bundled-metric-${opts.slug}`,
    source: 'bundled',
    sourceRef: null,
    kind: 'metric_doc',
    title: opts.title,
    intentTags: opts.intentTags,
    content: opts.content,
    createdBy: null,
  };
}

function templateSeed(opts: {
  slug: string;
  title: string;
  intentTags: string[];
  content: TemplateContent;
}): BundledSeed {
  return {
    id: `bundled-template-${opts.slug}`,
    source: 'bundled',
    sourceRef: null,
    kind: 'template',
    title: opts.title,
    intentTags: opts.intentTags,
    content: opts.content,
    createdBy: null,
  };
}

// Shared variables used by most per-software templates. Most exporters
// surface `instance` + `job` labels; we filter via JOB and let the user
// drill into instance via the panel legend.
const stdVars = () => [
  { key: 'JOB', label: 'Prometheus job', defaultValue: '' },
  { key: 'INSTANCE', label: 'Instance regex', defaultValue: '.*' },
  { key: 'TIME_RANGE', label: 'Rate window', defaultValue: '5m' },
];

const JOB = '${JOB}';

// ====== PostgreSQL ==========================================================
const postgresMetric: MetricDocContent = {
  description:
    'PostgreSQL operational health is observed through `postgres_exporter`. Watch transaction throughput and rollback ratio for application correctness, cache hit ratio for memory pressure, connection count vs `max_connections` for client saturation, and replication lag for standby health.\n\nA healthy primary shows >99% cache hit ratio, <1% rollback ratio, connections well under the limit, and replication lag in the low-MB range. Deadlocks should be rare; a steady stream indicates concurrent-update hotspots.',
  keyMetrics: [
    { metric: 'pg_stat_database_xact_commit', type: 'counter', meaning: 'Committed transactions per database.' },
    { metric: 'pg_stat_database_xact_rollback', type: 'counter', meaning: 'Rolled-back transactions; high ratio vs commits indicates app errors.', redFlag: 'Rollback ratio >5% sustained.' },
    { metric: 'pg_stat_database_blks_hit', type: 'counter', meaning: 'Buffer cache hits; combined with blks_read gives cache hit ratio.' },
    { metric: 'pg_stat_database_blks_read', type: 'counter', meaning: 'Disk reads bypassing the buffer cache.', redFlag: 'Cache hit ratio <95% sustained — under-sized shared_buffers or working set growth.' },
    { metric: 'pg_stat_activity_count', type: 'gauge', meaning: 'Current connection count; compare to max_connections.', redFlag: '>80% of max_connections — pool exhaustion imminent.' },
    { metric: 'pg_stat_replication_lag_bytes', type: 'gauge', meaning: 'WAL bytes the standby is behind the primary.', redFlag: 'Sustained growth or >100MB on a healthy network.' },
    { metric: 'pg_stat_database_deadlocks', type: 'counter', meaning: 'Deadlock detections — should be near zero.', redFlag: 'Any non-trivial rate indicates application concurrency bugs.' },
  ],
  troubleshooting: [
    'Cache hit ratio dropped — check for a recent query plan regression or working-set growth; consider raising shared_buffers.',
    'Connection count near limit — inspect pgbouncer/pooler health; look for long-running idle-in-transaction sessions.',
    'Replication lag growing — check standby disk I/O, network throughput between primary/standby, and WAL writer saturation.',
    'Spike in rollbacks — correlate with application deploys and error logs; common cause is serialization failures under load.',
    'Deadlocks appearing — capture `pg_stat_activity` during the event and review locking order in the offending transactions.',
  ],
  references: ['https://github.com/prometheus-community/postgres_exporter'],
};

const postgresPanels: TemplatePanel[] = [
  tmplPanel({ id: 'pg-1-tps', title: 'Transactions/sec', q: 'Commit and rollback throughput', expr: `sum by (datname) (rate(pg_stat_database_xact_commit{job="${JOB}"}[${TR}])) + sum by (datname) (rate(pg_stat_database_xact_rollback{job="${JOB}"}[${TR}]))`, row: 0, col: 0, width: 8, unit: 'ops', legend: '{{datname}}' }),
  tmplPanel({ id: 'pg-2-rollback-ratio', title: 'Rollback ratio', q: 'Rollbacks / total transactions', expr: `sum by (datname) (rate(pg_stat_database_xact_rollback{job="${JOB}"}[${TR}])) / (sum by (datname) (rate(pg_stat_database_xact_commit{job="${JOB}"}[${TR}])) + sum by (datname) (rate(pg_stat_database_xact_rollback{job="${JOB}"}[${TR}])))`, row: 0, col: 8, width: 8, unit: 'percentunit', legend: '{{datname}}' }),
  tmplPanel({ id: 'pg-3-cache-hit', title: 'Cache hit ratio', q: 'Buffer hits / (hits + reads)', expr: `sum by (datname) (rate(pg_stat_database_blks_hit{job="${JOB}"}[${TR}])) / (sum by (datname) (rate(pg_stat_database_blks_hit{job="${JOB}"}[${TR}])) + sum by (datname) (rate(pg_stat_database_blks_read{job="${JOB}"}[${TR}])))`, row: 0, col: 16, width: 8, unit: 'percentunit', legend: '{{datname}}' }),
  tmplPanel({ id: 'pg-4-connections', title: 'Active connections', q: 'Current connections per state', expr: `sum by (state) (pg_stat_activity_count{job="${JOB}"})`, row: 3, col: 0, width: 8, legend: '{{state}}' }),
  tmplPanel({ id: 'pg-5-replication-lag', title: 'Replication lag (bytes)', q: 'WAL bytes standby is behind primary', expr: `pg_stat_replication_lag_bytes{job="${JOB}"}`, row: 3, col: 8, width: 8, unit: 'bytes', legend: '{{client_addr}}' }),
  tmplPanel({ id: 'pg-6-deadlocks', title: 'Deadlocks/sec', q: 'Detected deadlocks', expr: `sum by (datname) (rate(pg_stat_database_deadlocks{job="${JOB}"}[${TR}]))`, row: 3, col: 16, width: 8, legend: '{{datname}}' }),
];

// ====== MySQL ===============================================================
const mysqlMetric: MetricDocContent = {
  description:
    'MySQL via `mysqld_exporter`. Track query throughput (`Questions`), slow query rate, InnoDB buffer pool effectiveness, row-lock contention, and replication lag. A healthy server shows a slow-query rate near zero, low row-lock waits, buffer pool reads dominated by hits, and seconds_behind_master near 0.',
  keyMetrics: [
    { metric: 'mysql_global_status_threads_connected', type: 'gauge', meaning: 'Current client connections.', redFlag: 'Approaching `max_connections`.' },
    { metric: 'mysql_global_status_questions', type: 'counter', meaning: 'Statements executed by the server.' },
    { metric: 'mysql_global_status_slow_queries', type: 'counter', meaning: 'Queries exceeding `long_query_time`.', redFlag: 'Sustained non-zero rate.' },
    { metric: 'mysql_global_status_innodb_buffer_pool_reads', type: 'counter', meaning: 'Reads that missed the buffer pool and hit disk.', redFlag: 'Rising faster than `_read_requests` — buffer pool too small.' },
    { metric: 'mysql_global_status_innodb_buffer_pool_read_requests', type: 'counter', meaning: 'Logical buffer pool read requests; pair with `_reads` for hit ratio.' },
    { metric: 'mysql_global_status_innodb_row_lock_waits', type: 'counter', meaning: 'Times a row lock had to wait.', redFlag: 'Steady growth indicates hot-row contention.' },
    { metric: 'mysql_slave_status_seconds_behind_master', type: 'gauge', meaning: 'Replica replication lag in seconds.', redFlag: 'Sustained >5s on a busy replica.' },
  ],
  troubleshooting: [
    'Slow queries spiking — enable the slow query log and capture explain plans; check for missing indexes after recent schema changes.',
    'Buffer pool hit ratio dropping — increase `innodb_buffer_pool_size` if RAM allows, or hunt for full table scans.',
    'Row-lock waits rising — identify hot rows via `SHOW ENGINE INNODB STATUS`; consider transaction shortening or different isolation level.',
    'Replication lag growing — check replica I/O thread state, network, and single-threaded apply bottlenecks; consider parallel replication.',
    'Connection saturation — verify pool sizing in app tier, look for connection leaks via `SHOW PROCESSLIST`.',
  ],
  references: ['https://github.com/prometheus/mysqld_exporter'],
};

const mysqlPanels: TemplatePanel[] = [
  tmplPanel({ id: 'mysql-1-qps', title: 'Queries/sec', q: 'Statement throughput', expr: `sum by (instance) (rate(mysql_global_status_questions{job="${JOB}"}[${TR}]))`, row: 0, col: 0, width: 8, unit: 'ops', legend: '{{instance}}' }),
  tmplPanel({ id: 'mysql-2-slow', title: 'Slow queries/sec', q: 'Queries over long_query_time', expr: `sum by (instance) (rate(mysql_global_status_slow_queries{job="${JOB}"}[${TR}]))`, row: 0, col: 8, width: 8, legend: '{{instance}}' }),
  tmplPanel({ id: 'mysql-3-connections', title: 'Connections', q: 'Active client connections', expr: `mysql_global_status_threads_connected{job="${JOB}"}`, row: 0, col: 16, width: 8, legend: '{{instance}}' }),
  tmplPanel({ id: 'mysql-4-bp-hit', title: 'InnoDB buffer pool hit ratio', q: '1 - reads/read_requests', expr: `1 - (sum by (instance) (rate(mysql_global_status_innodb_buffer_pool_reads{job="${JOB}"}[${TR}])) / sum by (instance) (rate(mysql_global_status_innodb_buffer_pool_read_requests{job="${JOB}"}[${TR}])))`, row: 3, col: 0, width: 8, unit: 'percentunit', legend: '{{instance}}' }),
  tmplPanel({ id: 'mysql-5-row-locks', title: 'Row-lock waits/sec', q: 'InnoDB row lock contention', expr: `sum by (instance) (rate(mysql_global_status_innodb_row_lock_waits{job="${JOB}"}[${TR}]))`, row: 3, col: 8, width: 8, legend: '{{instance}}' }),
  tmplPanel({ id: 'mysql-6-replag', title: 'Replication lag (s)', q: 'seconds_behind_master', expr: `mysql_slave_status_seconds_behind_master{job="${JOB}"}`, row: 3, col: 16, width: 8, unit: 's', legend: '{{instance}}' }),
];

// ====== MongoDB =============================================================
const mongoMetric: MetricDocContent = {
  description:
    'MongoDB via `mongodb_exporter` (Percona). Track op-counter throughput broken down by query/insert/update/delete, current connections vs the server limit, resident memory, replica set oplog window (how much rewind buffer the secondary has), and open cursors.',
  keyMetrics: [
    { metric: 'mongodb_op_counters_total', type: 'counter', meaning: 'Operations executed, labeled by `type`.' },
    { metric: 'mongodb_connections_current', type: 'gauge', meaning: 'Live client connections.', redFlag: 'Near `connections.available` — pool exhaustion.' },
    { metric: 'mongodb_memory_resident_bytes', type: 'gauge', meaning: 'Process resident memory in bytes.' },
    { metric: 'mongodb_replset_oplog_window_seconds', type: 'gauge', meaning: 'Window of time the secondary can replay from oplog.', redFlag: '<1h is fragile; a lagging secondary can fall off.' },
    { metric: 'mongodb_cursor_open', type: 'gauge', meaning: 'Open server-side cursors.', redFlag: 'Steady growth indicates app forgetting to close cursors.' },
    { metric: 'mongodb_mongod_global_lock_current_queue', type: 'gauge', meaning: 'Operations queued on the global lock; reader/writer breakdown.', redFlag: 'Sustained >0 — write or read contention.' },
  ],
  troubleshooting: [
    'Op-counter mix shifted — correlate with an app deploy; sudden update/delete spikes often indicate a runaway migration.',
    'Connection count climbing — check driver pool config and look for orphaned client processes.',
    'Oplog window shrinking — increase oplog size or fix the secondary keeping it pinned (likely replication lag).',
    'Cursor count growing — search the app for un-closed cursors; ensure timeouts are configured.',
    'Memory pressure — check working set vs RAM; consider sharding or scaling vertically.',
  ],
  references: ['https://github.com/percona/mongodb_exporter'],
};

const mongoPanels: TemplatePanel[] = [
  tmplPanel({ id: 'mongo-1-ops', title: 'Operations/sec', q: 'By operation type', expr: `sum by (type) (rate(mongodb_op_counters_total{job="${JOB}"}[${TR}]))`, row: 0, col: 0, width: 12, unit: 'ops', legend: '{{type}}' }),
  tmplPanel({ id: 'mongo-2-connections', title: 'Connections', q: 'Live client connections', expr: `mongodb_connections_current{job="${JOB}"}`, row: 0, col: 12, width: 12, legend: '{{instance}}' }),
  tmplPanel({ id: 'mongo-3-mem', title: 'Resident memory', q: 'Process RSS', expr: `mongodb_memory_resident_bytes{job="${JOB}"}`, row: 3, col: 0, width: 8, unit: 'bytes', legend: '{{instance}}' }),
  tmplPanel({ id: 'mongo-4-oplog-window', title: 'Oplog window (s)', q: 'Replay headroom on replica', expr: `mongodb_replset_oplog_window_seconds{job="${JOB}"}`, row: 3, col: 8, width: 8, unit: 's', legend: '{{instance}}' }),
  tmplPanel({ id: 'mongo-5-cursors', title: 'Open cursors', q: 'Server-side cursors', expr: `mongodb_cursor_open{job="${JOB}"}`, row: 3, col: 16, width: 8, legend: '{{instance}}' }),
];

// ====== Redis ===============================================================
const redisMetric: MetricDocContent = {
  description:
    'Redis via `redis_exporter`. Track command throughput, connected client count vs `maxclients`, memory used vs `maxmemory`, keyspace hit ratio (hits / (hits+misses)), evictions (a key sign of memory pressure), and replication offset diff (replica lag in bytes).',
  keyMetrics: [
    { metric: 'redis_commands_processed_total', type: 'counter', meaning: 'Commands executed by the server.' },
    { metric: 'redis_connected_clients', type: 'gauge', meaning: 'Current client connections.', redFlag: 'Near `maxclients`.' },
    { metric: 'redis_memory_used_bytes', type: 'gauge', meaning: 'Resident memory used by the dataset.', redFlag: '>90% of `redis_memory_max_bytes`.' },
    { metric: 'redis_keyspace_hits_total', type: 'counter', meaning: 'Successful key lookups.' },
    { metric: 'redis_keyspace_misses_total', type: 'counter', meaning: 'Key lookups returning nil.', redFlag: 'Hit ratio <80% — cache is undersized or misused.' },
    { metric: 'redis_evicted_keys_total', type: 'counter', meaning: 'Keys evicted under memory pressure.', redFlag: 'Any sustained rate when used as a cache; non-zero in non-cache mode is a bug.' },
    { metric: 'redis_connected_slave_offset_bytes', type: 'gauge', meaning: 'Replica offset; diff from master_repl_offset is lag.', redFlag: 'Sustained large diff vs master.' },
  ],
  troubleshooting: [
    'Hit ratio dropping — verify TTL strategy and key naming; consider a larger instance or warm-up after restart.',
    'Evictions appearing — confirm `maxmemory-policy`; scale memory or shed cold keys.',
    'Latency spikes — check `SLOWLOG`, look for `KEYS`/`SMEMBERS` on large structures, or fork-induced pauses from RDB/AOF rewrites.',
    'Replica lag growing — check network, replica disk if AOF is on, and confirm no replica blocking commands.',
    'Memory growth without traffic — look for big keys via `redis-cli --bigkeys` and check fragmentation ratio.',
  ],
  references: ['https://github.com/oliver006/redis_exporter'],
};

const redisPanels: TemplatePanel[] = [
  tmplPanel({ id: 'redis-1-ops', title: 'Commands/sec', q: 'Throughput', expr: `sum by (instance) (rate(redis_commands_processed_total{job="${JOB}"}[${TR}]))`, row: 0, col: 0, width: 8, unit: 'ops', legend: '{{instance}}' }),
  tmplPanel({ id: 'redis-2-clients', title: 'Connected clients', q: 'Live connections', expr: `redis_connected_clients{job="${JOB}"}`, row: 0, col: 8, width: 8, legend: '{{instance}}' }),
  tmplPanel({ id: 'redis-3-mem', title: 'Memory used', q: 'Dataset bytes', expr: `redis_memory_used_bytes{job="${JOB}"}`, row: 0, col: 16, width: 8, unit: 'bytes', legend: '{{instance}}' }),
  tmplPanel({ id: 'redis-4-hit-ratio', title: 'Keyspace hit ratio', q: 'hits / (hits + misses)', expr: `sum by (instance) (rate(redis_keyspace_hits_total{job="${JOB}"}[${TR}])) / (sum by (instance) (rate(redis_keyspace_hits_total{job="${JOB}"}[${TR}])) + sum by (instance) (rate(redis_keyspace_misses_total{job="${JOB}"}[${TR}])))`, row: 3, col: 0, width: 8, unit: 'percentunit', legend: '{{instance}}' }),
  tmplPanel({ id: 'redis-5-evictions', title: 'Evictions/sec', q: 'Keys evicted under pressure', expr: `sum by (instance) (rate(redis_evicted_keys_total{job="${JOB}"}[${TR}]))`, row: 3, col: 8, width: 8, legend: '{{instance}}' }),
  tmplPanel({ id: 'redis-6-replication', title: 'Replica offset', q: 'Replica replication offset', expr: `redis_connected_slave_offset_bytes{job="${JOB}"}`, row: 3, col: 16, width: 8, unit: 'bytes', legend: '{{slave_ip}}' }),
];

// ====== Kafka ===============================================================
const kafkaMetric: MetricDocContent = {
  description:
    'Kafka via `kafka_exporter` (cluster-level metrics) plus JMX-exported broker metrics. Track messages-in/bytes-in/out per broker for capacity, active controller count (must be 1), under-replicated partitions (the canary for broker/disk health), log end offset growth, and per-consumer-group lag.',
  keyMetrics: [
    { metric: 'kafka_server_brokertopicmetrics_messagesinpersec', type: 'gauge', meaning: 'Messages produced per second per broker (JMX-derived rate).' },
    { metric: 'kafka_server_brokertopicmetrics_bytesinpersec', type: 'gauge', meaning: 'Bytes-in throughput per broker.' },
    { metric: 'kafka_server_brokertopicmetrics_bytesoutpersec', type: 'gauge', meaning: 'Bytes-out throughput per broker.' },
    { metric: 'kafka_controller_kafkacontroller_activecontrollercount', type: 'gauge', meaning: 'Number of active controllers — must equal 1 across the cluster.', redFlag: 'Sum across brokers != 1 — split brain or no controller.' },
    { metric: 'kafka_log_log_logendoffset', type: 'gauge', meaning: 'Log end offset per topic/partition.' },
    { metric: 'kafka_server_replicamanager_underreplicatedpartitions', type: 'gauge', meaning: 'Partitions missing replicas on this broker.', redFlag: 'Any non-zero sustained value.' },
    { metric: 'kafka_consumergroup_lag', type: 'gauge', meaning: 'Consumer group lag in messages (from kafka_exporter).', redFlag: 'Sustained growth — consumer cannot keep up.' },
  ],
  troubleshooting: [
    'Under-replicated partitions — check broker disk space, network between brokers, and the broker logs for ISR shrinks.',
    'Consumer lag rising — scale consumer instances, check for slow message processing, or rebalance issues.',
    'No active controller — inspect ZooKeeper/KRaft quorum health.',
    'Throughput skew between brokers — re-balance partitions; check producer key distribution.',
    'Disk filling on a broker — adjust `log.retention.*`; verify cleanup threads are running.',
  ],
  references: ['https://github.com/danielqsj/kafka_exporter'],
};

const kafkaPanels: TemplatePanel[] = [
  tmplPanel({ id: 'kafka-1-msgs-in', title: 'Messages in/sec', q: 'Per-broker produce rate', expr: `sum by (instance) (kafka_server_brokertopicmetrics_messagesinpersec{job="${JOB}"})`, row: 0, col: 0, width: 8, legend: '{{instance}}' }),
  tmplPanel({ id: 'kafka-2-bytes-in', title: 'Bytes in/sec', q: 'Per-broker bytes in', expr: `sum by (instance) (kafka_server_brokertopicmetrics_bytesinpersec{job="${JOB}"})`, row: 0, col: 8, width: 8, unit: 'Bps', legend: '{{instance}}' }),
  tmplPanel({ id: 'kafka-3-bytes-out', title: 'Bytes out/sec', q: 'Per-broker bytes out', expr: `sum by (instance) (kafka_server_brokertopicmetrics_bytesoutpersec{job="${JOB}"})`, row: 0, col: 16, width: 8, unit: 'Bps', legend: '{{instance}}' }),
  tmplPanel({ id: 'kafka-4-controller', title: 'Active controllers', q: 'Cluster-wide should equal 1', expr: `sum(kafka_controller_kafkacontroller_activecontrollercount{job="${JOB}"})`, row: 3, col: 0, width: 6, viz: 'stat', legend: 'controllers' }),
  tmplPanel({ id: 'kafka-5-under-replicated', title: 'Under-replicated partitions', q: 'Sum across brokers', expr: `sum by (instance) (kafka_server_replicamanager_underreplicatedpartitions{job="${JOB}"})`, row: 3, col: 6, width: 9, legend: '{{instance}}' }),
  tmplPanel({ id: 'kafka-6-cg-lag', title: 'Consumer group lag', q: 'Lag per consumergroup/topic', expr: `sum by (consumergroup, topic) (kafka_consumergroup_lag{job="${JOB}"})`, row: 3, col: 15, width: 9, legend: '{{consumergroup}}/{{topic}}' }),
];

// ====== RabbitMQ ============================================================
const rabbitMetric: MetricDocContent = {
  description:
    'RabbitMQ via the official Prometheus plugin (`rabbitmq_prometheus`). Track queue depth (total + ready vs unacked), channel/connection counts, and node disk free bytes vs `disk_free_limit`. Backed-up queues are the leading indicator of consumer issues; ballooning unacked indicates slow consumers or misbehaving prefetch.',
  keyMetrics: [
    { metric: 'rabbitmq_queue_messages', type: 'gauge', meaning: 'Total messages in queue (ready + unacked).', redFlag: 'Sustained growth.' },
    { metric: 'rabbitmq_queue_messages_ready', type: 'gauge', meaning: 'Messages ready for delivery to consumers.' },
    { metric: 'rabbitmq_queue_messages_unacknowledged', type: 'gauge', meaning: 'Messages delivered but not acked.', redFlag: 'Large/growing — slow or stuck consumers.' },
    { metric: 'rabbitmq_channels', type: 'gauge', meaning: 'Open AMQP channels.' },
    { metric: 'rabbitmq_connections', type: 'gauge', meaning: 'Open AMQP connections.' },
    { metric: 'rabbitmq_node_disk_free_bytes', type: 'gauge', meaning: 'Free disk on the node.', redFlag: 'Approaching `rabbitmq_node_disk_free_limit_bytes` — publishers will be flow-controlled.' },
  ],
  troubleshooting: [
    'Queue depth climbing — scale consumers, inspect their logs for processing errors, and check prefetch settings.',
    'Unacked spiking — likely a consumer hang; inspect channel-level metrics, force-close stale channels if needed.',
    'Disk approaching free limit — purge dead queues, expand volume, or tighten message TTL.',
    'Channel/connection sprawl — set per-vhost limits; look for clients that reconnect on every message.',
    'Memory alarm — RabbitMQ throttles publishers; check `rabbitmq_node_mem_used` and free RAM.',
  ],
  references: ['https://www.rabbitmq.com/prometheus.html'],
};

const rabbitPanels: TemplatePanel[] = [
  tmplPanel({ id: 'rmq-1-messages', title: 'Queue depth', q: 'Total messages per queue', expr: `topk(20, rabbitmq_queue_messages{job="${JOB}"})`, row: 0, col: 0, width: 12, legend: '{{queue}}' }),
  tmplPanel({ id: 'rmq-2-ready-unacked', title: 'Ready vs Unacked', q: 'Delivery backlog vs in-flight', expr: `sum(rabbitmq_queue_messages_ready{job="${JOB}"}) or vector(0)`, row: 0, col: 12, width: 12, legend: 'ready' }),
  tmplPanel({ id: 'rmq-3-channels', title: 'Channels', q: 'Open channels', expr: `rabbitmq_channels{job="${JOB}"}`, row: 3, col: 0, width: 6, legend: '{{instance}}' }),
  tmplPanel({ id: 'rmq-4-connections', title: 'Connections', q: 'Open connections', expr: `rabbitmq_connections{job="${JOB}"}`, row: 3, col: 6, width: 6, legend: '{{instance}}' }),
  tmplPanel({ id: 'rmq-5-disk-free', title: 'Node disk free', q: 'Free bytes on each node', expr: `rabbitmq_node_disk_free_bytes{job="${JOB}"}`, row: 3, col: 12, width: 12, unit: 'bytes', legend: '{{instance}}' }),
];

// ====== NATS ================================================================
const natsMetric: MetricDocContent = {
  description:
    'NATS via `prometheus-nats-exporter`. Track core in/out message rate, connections, slow consumer count, and (if JetStream is on) per-consumer pending messages and stream byte size.',
  keyMetrics: [
    { metric: 'nats_varz_in_msgs', type: 'counter', meaning: 'Total messages received by the server.' },
    { metric: 'nats_varz_out_msgs', type: 'counter', meaning: 'Total messages delivered by the server.' },
    { metric: 'nats_varz_connections', type: 'gauge', meaning: 'Active client connections.' },
    { metric: 'nats_varz_slow_consumers', type: 'gauge', meaning: 'Subscribers the server had to disconnect for falling behind.', redFlag: 'Any growth — consumers too slow.' },
    { metric: 'nats_jetstream_consumer_num_pending', type: 'gauge', meaning: 'JetStream consumer pending messages.', redFlag: 'Sustained growth — consumer not keeping up.' },
    { metric: 'nats_jetstream_stream_bytes', type: 'gauge', meaning: 'On-disk bytes per stream.', redFlag: 'Approaching configured stream max_bytes.' },
  ],
  troubleshooting: [
    'Slow consumers growing — increase subscriber pending limits or fix downstream processing.',
    'JetStream pending climbing — scale consumer instances or raise ack wait/redelivery limits.',
    'Stream size near max — adjust retention/max_age, or expand max_bytes.',
    'Connection churn — check client backoff configs; look for cluster-route flapping.',
    'Cluster split — inspect `nats_varz_routes` and route connection health.',
  ],
  references: ['https://github.com/nats-io/prometheus-nats-exporter'],
};

const natsPanels: TemplatePanel[] = [
  tmplPanel({ id: 'nats-1-in', title: 'Msgs in/sec', q: 'Server inbound msg rate', expr: `sum by (instance) (rate(nats_varz_in_msgs{job="${JOB}"}[${TR}]))`, row: 0, col: 0, width: 8, legend: '{{instance}}' }),
  tmplPanel({ id: 'nats-2-out', title: 'Msgs out/sec', q: 'Server outbound msg rate', expr: `sum by (instance) (rate(nats_varz_out_msgs{job="${JOB}"}[${TR}]))`, row: 0, col: 8, width: 8, legend: '{{instance}}' }),
  tmplPanel({ id: 'nats-3-conns', title: 'Connections', q: 'Active clients', expr: `nats_varz_connections{job="${JOB}"}`, row: 0, col: 16, width: 8, legend: '{{instance}}' }),
  tmplPanel({ id: 'nats-4-slow', title: 'Slow consumers', q: 'Disconnected for being slow', expr: `nats_varz_slow_consumers{job="${JOB}"}`, row: 3, col: 0, width: 8, legend: '{{instance}}' }),
  tmplPanel({ id: 'nats-5-js-pending', title: 'JetStream pending', q: 'Per-consumer pending', expr: `topk(10, nats_jetstream_consumer_num_pending{job="${JOB}"})`, row: 3, col: 8, width: 8, legend: '{{stream_name}}/{{consumer_name}}' }),
  tmplPanel({ id: 'nats-6-js-bytes', title: 'JetStream stream bytes', q: 'On-disk per stream', expr: `nats_jetstream_stream_bytes{job="${JOB}"}`, row: 3, col: 16, width: 8, unit: 'bytes', legend: '{{stream_name}}' }),
];

// ====== Nginx ===============================================================
const nginxMetric: MetricDocContent = {
  description:
    'Nginx via `nginx-prometheus-exporter` (built on stub_status). Stub_status only exposes connection counts and total requests — no per-status-code split is available out of the box. For 4xx/5xx ratios, pair with the OpenTelemetry collector log scraper or VTS module. Track active/waiting/reading/writing connections to spot saturation, and request rate from `nginx_http_requests_total`.',
  keyMetrics: [
    { metric: 'nginx_http_requests_total', type: 'counter', meaning: 'Total HTTP requests handled.' },
    { metric: 'nginx_connections_active', type: 'gauge', meaning: 'Currently active client connections (reading + writing + waiting).', redFlag: 'Approaching `worker_connections * worker_processes`.' },
    { metric: 'nginx_connections_waiting', type: 'gauge', meaning: 'Idle keep-alive connections waiting for the next request.' },
    { metric: 'nginx_connections_reading', type: 'gauge', meaning: 'Connections where nginx is reading the request header.', redFlag: 'Sustained high count suggests slow clients.' },
    { metric: 'nginx_connections_writing', type: 'gauge', meaning: 'Connections where nginx is writing a response.' },
    { metric: 'nginx_connections_accepted', type: 'counter', meaning: 'Cumulative accepted connections.' },
    { metric: 'nginx_connections_handled', type: 'counter', meaning: 'Cumulative successfully handled connections; gap vs accepted indicates worker_connections exhaustion.', redFlag: 'accepted - handled > 0 — workers ran out of slots.' },
  ],
  troubleshooting: [
    'Active connections capped at worker limit — raise `worker_connections`/`worker_processes` or scale horizontally.',
    'Reading connections piling up — investigate slow clients; consider `client_header_timeout` tightening.',
    'Need status-code breakdown — switch to VTS module or scrape access logs with the OTel collector.',
    'Upstream errors — combine with upstream metrics (haproxy/envoy/app) since nginx stub_status doesn’t expose them.',
    'Worker restarts spike — check OOMs and config-reload patterns.',
  ],
  references: ['https://github.com/nginxinc/nginx-prometheus-exporter'],
};

const nginxPanels: TemplatePanel[] = [
  tmplPanel({ id: 'nginx-1-rps', title: 'Requests/sec', q: 'Throughput', expr: `sum by (instance) (rate(nginx_http_requests_total{job="${JOB}"}[${TR}]))`, row: 0, col: 0, width: 12, unit: 'reqps', legend: '{{instance}}' }),
  tmplPanel({ id: 'nginx-2-active', title: 'Active connections', q: 'Live connections', expr: `nginx_connections_active{job="${JOB}"}`, row: 0, col: 12, width: 12, legend: '{{instance}}' }),
  tmplPanel({ id: 'nginx-3-reading', title: 'Reading', q: 'Connections reading request', expr: `nginx_connections_reading{job="${JOB}"}`, row: 3, col: 0, width: 6, legend: '{{instance}}' }),
  tmplPanel({ id: 'nginx-4-writing', title: 'Writing', q: 'Connections writing response', expr: `nginx_connections_writing{job="${JOB}"}`, row: 3, col: 6, width: 6, legend: '{{instance}}' }),
  tmplPanel({ id: 'nginx-5-waiting', title: 'Waiting (keep-alive)', q: 'Idle keep-alive sockets', expr: `nginx_connections_waiting{job="${JOB}"}`, row: 3, col: 12, width: 6, legend: '{{instance}}' }),
  tmplPanel({ id: 'nginx-6-accept-gap', title: 'Accepted - handled', q: 'Worker-connection exhaustion', expr: `sum by (instance) (rate(nginx_connections_accepted{job="${JOB}"}[${TR}])) - sum by (instance) (rate(nginx_connections_handled{job="${JOB}"}[${TR}]))`, row: 3, col: 18, width: 6, legend: '{{instance}}' }),
];

// ====== HAProxy =============================================================
const haproxyMetric: MetricDocContent = {
  description:
    'HAProxy via its native Prometheus endpoint (`/metrics` on the stats socket). Track frontend request throughput, backend 5xx errors, backend queue depth (requests waiting for a server slot), active sessions, and backend response time.',
  keyMetrics: [
    { metric: 'haproxy_frontend_http_requests_total', type: 'counter', meaning: 'HTTP requests per frontend.' },
    { metric: 'haproxy_backend_response_errors_total', type: 'counter', meaning: 'Responses with errors per backend.', redFlag: 'Sustained rate >0.' },
    { metric: 'haproxy_backend_queue_current', type: 'gauge', meaning: 'Requests queued waiting for a backend slot.', redFlag: 'Sustained >0 — backends are saturated.' },
    { metric: 'haproxy_backend_current_sessions', type: 'gauge', meaning: 'Current active sessions per backend.' },
    { metric: 'haproxy_backend_response_time_average_seconds', type: 'gauge', meaning: 'Mean backend response time.', redFlag: 'p99 unavailable from native exporter; use this avg as a coarse signal.' },
    { metric: 'haproxy_server_check_status', type: 'gauge', meaning: 'Health-check state per server (1 = up).', redFlag: 'Servers flapping or persistently down.' },
  ],
  troubleshooting: [
    'Backend queue rising — scale backend server count or raise `maxconn`/`fullconn` if config-bound.',
    '5xx errors — inspect backend application logs; HAProxy bubbles up upstream errors.',
    'Server check failing — verify network/path, then app health endpoint.',
    'Session count near `maxconn` — raise the limit or shed traffic; check for long-lived connections.',
    'Need percentile latency — pair with app-level histograms; native metrics only expose averages.',
  ],
  references: ['https://www.haproxy.com/documentation/haproxy-runtime-api/reference/show-stat/'],
};

const haproxyPanels: TemplatePanel[] = [
  tmplPanel({ id: 'haproxy-1-rps', title: 'Frontend requests/sec', q: 'Per-frontend HTTP rate', expr: `sum by (proxy) (rate(haproxy_frontend_http_requests_total{job="${JOB}"}[${TR}]))`, row: 0, col: 0, width: 8, unit: 'reqps', legend: '{{proxy}}' }),
  tmplPanel({ id: 'haproxy-2-errors', title: 'Backend errors/sec', q: 'Per-backend response errors', expr: `sum by (proxy) (rate(haproxy_backend_response_errors_total{job="${JOB}"}[${TR}]))`, row: 0, col: 8, width: 8, legend: '{{proxy}}' }),
  tmplPanel({ id: 'haproxy-3-queue', title: 'Backend queue', q: 'Requests waiting for a server', expr: `haproxy_backend_queue_current{job="${JOB}"}`, row: 0, col: 16, width: 8, legend: '{{proxy}}' }),
  tmplPanel({ id: 'haproxy-4-sessions', title: 'Backend sessions', q: 'Active sessions per backend', expr: `haproxy_backend_current_sessions{job="${JOB}"}`, row: 3, col: 0, width: 12, legend: '{{proxy}}' }),
  tmplPanel({ id: 'haproxy-5-rt', title: 'Backend response time (avg)', q: 'Mean backend RT', expr: `haproxy_backend_response_time_average_seconds{job="${JOB}"}`, row: 3, col: 12, width: 12, unit: 's', legend: '{{proxy}}' }),
];

// ====== Envoy (standalone) =================================================
const envoyMetric: MetricDocContent = {
  description:
    'Standalone Envoy via its native `/stats/prometheus` endpoint. Track downstream request rate and 5xx class, upstream pending requests (queued because connections aren’t available), upstream active connection count, and server memory.',
  keyMetrics: [
    { metric: 'envoy_http_downstream_rq_total', type: 'counter', meaning: 'Downstream HTTP requests handled.' },
    { metric: 'envoy_http_downstream_rq_xx', type: 'counter', meaning: 'Downstream requests by response_code_class.', redFlag: 'Sustained 5xx-class rate.' },
    { metric: 'envoy_cluster_upstream_rq_pending_active', type: 'gauge', meaning: 'Upstream requests queued waiting for a connection.', redFlag: 'Sustained >0 — upstream pool exhausted or circuit-breaking.' },
    { metric: 'envoy_cluster_upstream_cx_active', type: 'gauge', meaning: 'Active upstream connections per cluster.' },
    { metric: 'envoy_server_memory_allocated', type: 'gauge', meaning: 'Memory allocated by the Envoy process.' },
    { metric: 'envoy_cluster_upstream_rq_retry', type: 'counter', meaning: 'Retried upstream requests.', redFlag: 'High retry rate masks upstream issues and amplifies load.' },
  ],
  troubleshooting: [
    '5xx class rising — drill into per-route stats and upstream logs.',
    'Pending requests piling up — raise `max_connections`/`max_pending_requests` in cluster circuit breakers, or scale upstream.',
    'Connection churn — check upstream keep-alive and idle timeouts.',
    'Memory growth — verify config-update churn; xDS update floods can leak memory in older versions.',
    'Retry storms — tighten retry policy (max_retries, retry_on conditions).',
  ],
  references: ['https://www.envoyproxy.io/docs/envoy/latest/configuration/upstream/cluster_manager/cluster_stats'],
};

const envoyPanels: TemplatePanel[] = [
  tmplPanel({ id: 'envoy-1-rps', title: 'Downstream req/sec', q: 'Inbound HTTP rate', expr: `sum by (instance) (rate(envoy_http_downstream_rq_total{job="${JOB}"}[${TR}]))`, row: 0, col: 0, width: 8, unit: 'reqps', legend: '{{instance}}' }),
  tmplPanel({ id: 'envoy-2-5xx', title: '5xx rate', q: '5xx-class responses', expr: `sum by (instance) (rate(envoy_http_downstream_rq_xx{job="${JOB}", envoy_response_code_class="5"}[${TR}]))`, row: 0, col: 8, width: 8, legend: '{{instance}}' }),
  tmplPanel({ id: 'envoy-3-pending', title: 'Upstream pending', q: 'Queued upstream requests', expr: `sum by (envoy_cluster_name) (envoy_cluster_upstream_rq_pending_active{job="${JOB}"})`, row: 0, col: 16, width: 8, legend: '{{envoy_cluster_name}}' }),
  tmplPanel({ id: 'envoy-4-cx-active', title: 'Upstream active conns', q: 'Active connections per cluster', expr: `sum by (envoy_cluster_name) (envoy_cluster_upstream_cx_active{job="${JOB}"})`, row: 3, col: 0, width: 12, legend: '{{envoy_cluster_name}}' }),
  tmplPanel({ id: 'envoy-5-memory', title: 'Server memory', q: 'Allocated bytes', expr: `envoy_server_memory_allocated{job="${JOB}"}`, row: 3, col: 12, width: 12, unit: 'bytes', legend: '{{instance}}' }),
];

// ====== JVM =================================================================
const jvmMetric: MetricDocContent = {
  description:
    'JVM apps exposing metrics via Micrometer (Spring Boot, Quarkus) or `jmx_exporter`. Track heap utilization, GC time and pause frequency, live thread count, loaded classes, and process CPU.',
  keyMetrics: [
    { metric: 'jvm_memory_used_bytes', type: 'gauge', meaning: 'Bytes used in each memory area (heap, nonheap).', redFlag: 'Heap consistently >80% of `jvm_memory_max_bytes{area="heap"}` after GC.' },
    { metric: 'jvm_memory_max_bytes', type: 'gauge', meaning: 'Configured max for each memory area.' },
    { metric: 'jvm_gc_collection_seconds_count', type: 'counter', meaning: 'GC pauses count per collector.', redFlag: 'Old-gen collection frequency rising.' },
    { metric: 'jvm_gc_collection_seconds_sum', type: 'counter', meaning: 'Cumulative GC time per collector; divide rate by count for avg pause.' },
    { metric: 'jvm_threads_current', type: 'gauge', meaning: 'Live thread count.', redFlag: 'Unbounded growth — thread leak.' },
    { metric: 'jvm_classes_loaded', type: 'gauge', meaning: 'Loaded class count.' },
    { metric: 'process_cpu_seconds_total', type: 'counter', meaning: 'CPU consumed by the JVM process.' },
  ],
  troubleshooting: [
    'Heap pressure — capture a heap dump (`jmap`) and analyze with Eclipse MAT for retained-size hotspots.',
    'GC time rising — switch collector (G1/ZGC), raise heap, or tune `MaxGCPauseMillis`.',
    'Thread leak — `jstack` snapshot; check for executors not shutting down or blocking I/O without timeout.',
    'Class count growing — check for dynamic class generation (proxies, scripting) without unloading.',
    'CPU saturation — async profiler flamegraph to find hot methods.',
  ],
  references: ['https://github.com/prometheus/jmx_exporter', 'https://micrometer.io/'],
};

const jvmPanels: TemplatePanel[] = [
  tmplPanel({ id: 'jvm-1-heap-util', title: 'Heap utilization', q: 'used/max for heap', expr: `jvm_memory_used_bytes{area="heap", job="${JOB}"} / jvm_memory_max_bytes{area="heap", job="${JOB}"}`, row: 0, col: 0, width: 8, unit: 'percentunit', legend: '{{instance}}' }),
  tmplPanel({ id: 'jvm-2-heap-bytes', title: 'Heap used (bytes)', q: 'Absolute heap usage', expr: `jvm_memory_used_bytes{area="heap", job="${JOB}"}`, row: 0, col: 8, width: 8, unit: 'bytes', legend: '{{instance}}' }),
  tmplPanel({ id: 'jvm-3-gc-time', title: 'GC time/sec', q: 'Per-collector GC time rate', expr: `sum by (gc) (rate(jvm_gc_collection_seconds_sum{job="${JOB}"}[${TR}]))`, row: 0, col: 16, width: 8, unit: 's', legend: '{{gc}}' }),
  tmplPanel({ id: 'jvm-4-gc-count', title: 'GC pauses/sec', q: 'Per-collector pause rate', expr: `sum by (gc) (rate(jvm_gc_collection_seconds_count{job="${JOB}"}[${TR}]))`, row: 3, col: 0, width: 8, legend: '{{gc}}' }),
  tmplPanel({ id: 'jvm-5-threads', title: 'Live threads', q: 'Thread count', expr: `jvm_threads_current{job="${JOB}"}`, row: 3, col: 8, width: 8, legend: '{{instance}}' }),
  tmplPanel({ id: 'jvm-6-cpu', title: 'Process CPU', q: 'CPU seconds rate', expr: `sum by (instance) (rate(process_cpu_seconds_total{job="${JOB}"}[${TR}]))`, row: 3, col: 16, width: 8, legend: '{{instance}}' }),
];

// ====== Node.js =============================================================
const nodejsMetric: MetricDocContent = {
  description:
    'Node.js apps exposing metrics via `prom-client` default registry. Track RSS memory, event-loop lag (the canary for CPU-bound or blocking work), active handles, V8 heap usage, and GC duration.',
  keyMetrics: [
    { metric: 'process_resident_memory_bytes', type: 'gauge', meaning: 'Process RSS.' },
    { metric: 'nodejs_eventloop_lag_seconds', type: 'gauge', meaning: 'Most recent event-loop lag sample.', redFlag: '>0.1s sustained — CPU-bound work blocking the loop.' },
    { metric: 'nodejs_active_handles_total', type: 'gauge', meaning: 'Active libuv handles (sockets, timers, fs).', redFlag: 'Unbounded growth — handle leak.' },
    { metric: 'nodejs_heap_size_total_bytes', type: 'gauge', meaning: 'Total V8 heap size.' },
    { metric: 'nodejs_heap_size_used_bytes', type: 'gauge', meaning: 'V8 heap used.', redFlag: 'Used / total trending up over hours — memory leak.' },
    { metric: 'nodejs_gc_duration_seconds_count', type: 'counter', meaning: 'GC events by kind.' },
  ],
  troubleshooting: [
    'Event-loop lag spiking — find the synchronous hot path with `--prof` or clinic.js flame; offload to a worker thread.',
    'Memory growth — take heap snapshots via `--inspect` and diff to find retainers.',
    'Handle leak — instrument `process._getActiveHandles()` to inventory; common cause is uncleared intervals or unfinished streams.',
    'High GC time — V8 may be in serial GC mode under pressure; raise `--max-old-space-size` if RAM is available.',
    'CPU-bound endpoint — consider worker_threads or move computation off the request path.',
  ],
  references: ['https://github.com/siimon/prom-client'],
};

const nodejsPanels: TemplatePanel[] = [
  tmplPanel({ id: 'node-1-rss', title: 'RSS memory', q: 'Process resident memory', expr: `process_resident_memory_bytes{job="${JOB}"}`, row: 0, col: 0, width: 8, unit: 'bytes', legend: '{{instance}}' }),
  tmplPanel({ id: 'node-2-eloop', title: 'Event-loop lag', q: 'Latest sample', expr: `nodejs_eventloop_lag_seconds{job="${JOB}"}`, row: 0, col: 8, width: 8, unit: 's', legend: '{{instance}}' }),
  tmplPanel({ id: 'node-3-handles', title: 'Active handles', q: 'libuv active handles', expr: `nodejs_active_handles_total{job="${JOB}"}`, row: 0, col: 16, width: 8, legend: '{{instance}}' }),
  tmplPanel({ id: 'node-4-heap', title: 'V8 heap used / total', q: 'used and total heap', expr: `nodejs_heap_size_used_bytes{job="${JOB}"} / nodejs_heap_size_total_bytes{job="${JOB}"}`, row: 3, col: 0, width: 12, unit: 'percentunit', legend: '{{instance}}' }),
  tmplPanel({ id: 'node-5-gc', title: 'GC events/sec', q: 'Per-kind GC frequency', expr: `sum by (kind) (rate(nodejs_gc_duration_seconds_count{job="${JOB}"}[${TR}]))`, row: 3, col: 12, width: 12, legend: '{{kind}}' }),
];

// ====== Go ==================================================================
const goMetric: MetricDocContent = {
  description:
    'Go apps exposing metrics via `client_golang` (promauto). Track goroutine count, heap in-use and alloc bytes, GC pause duration, OS thread count, and open file descriptors.',
  keyMetrics: [
    { metric: 'go_goroutines', type: 'gauge', meaning: 'Live goroutine count.', redFlag: 'Unbounded growth — goroutine leak.' },
    { metric: 'go_memstats_heap_inuse_bytes', type: 'gauge', meaning: 'Bytes in in-use heap spans.' },
    { metric: 'go_memstats_heap_alloc_bytes', type: 'gauge', meaning: 'Bytes allocated and in use right now.', redFlag: 'Steady growth without releases — leak or live-set inflation.' },
    { metric: 'go_gc_duration_seconds', type: 'histogram', meaning: 'GC pause durations (summary quantiles).', redFlag: 'p99 >100ms sustained — GC pressure.' },
    { metric: 'go_threads', type: 'gauge', meaning: 'OS threads created by the Go runtime.' },
    { metric: 'process_open_fds', type: 'gauge', meaning: 'Open file descriptors.', redFlag: 'Near `process_max_fds` — FD leak (often un-closed http.Response.Body).' },
  ],
  troubleshooting: [
    'Goroutine leak — capture `/debug/pprof/goroutine?debug=2` and look for blocked stacks (chan recv, sync.Mutex.Lock).',
    'Heap growing — `/debug/pprof/heap` then `go tool pprof -alloc_objects` vs `-inuse_objects`.',
    'GC pauses — reduce allocation rate (`pprof -alloc_space`), tune `GOGC` if memory is plentiful.',
    'FD exhaustion — confirm every `http.Get` calls `resp.Body.Close()`; check OS soft/hard limits.',
    'CPU saturation — `go tool pprof http://.../debug/pprof/profile?seconds=30` flamegraph.',
  ],
  references: ['https://github.com/prometheus/client_golang'],
};

const goPanels: TemplatePanel[] = [
  tmplPanel({ id: 'go-1-goroutines', title: 'Goroutines', q: 'Live goroutine count', expr: `go_goroutines{job="${JOB}"}`, row: 0, col: 0, width: 12, legend: '{{instance}}' }),
  tmplPanel({ id: 'go-2-heap', title: 'Heap in-use', q: 'In-use heap bytes', expr: `go_memstats_heap_inuse_bytes{job="${JOB}"}`, row: 0, col: 12, width: 12, unit: 'bytes', legend: '{{instance}}' }),
  tmplPanel({ id: 'go-3-gc-p99', title: 'GC pause p99', expr: `go_gc_duration_seconds{quantile="0.99", job="${JOB}"}`, q: '99th percentile GC pause', row: 3, col: 0, width: 12, unit: 's', legend: '{{instance}}' }),
  tmplPanel({ id: 'go-4-fds', title: 'Open file descriptors', q: 'process_open_fds', expr: `process_open_fds{job="${JOB}"}`, row: 3, col: 12, width: 12, legend: '{{instance}}' }),
];

// Default notes used by metric-doc-paired templates. Each template stands
// alone; metric_doc explains semantics, template is the panel layout.
const defaultNotes = (sw: string) =>
  `Standard ${sw} dashboard: ${sw}-exporter (or native) metrics. Filter via ${'${JOB}'} variable. Pair with the matching metric_doc seed for metric semantics and troubleshooting.`;

// Reduce JOB-only var sets to avoid duplication
const jobOnlyVars = stdVars();

const PER_SW_SEEDS: ReadonlyArray<BundledSeed> = [
  // Postgres
  metricDoc({ slug: 'postgres', title: 'PostgreSQL metrics', intentTags: ['postgres', 'postgresql', 'db', 'database', 'sql', 'on-call', 'performance'], content: postgresMetric }),
  templateSeed({ slug: 'postgres', title: 'PostgreSQL overview', intentTags: ['postgres', 'postgresql', 'db', 'database', 'dashboard', 'on-call'], content: { panels: postgresPanels, variables: jobOnlyVars, notes: defaultNotes('PostgreSQL') } }),
  // MySQL
  metricDoc({ slug: 'mysql', title: 'MySQL metrics', intentTags: ['mysql', 'db', 'database', 'sql', 'mariadb', 'on-call', 'performance'], content: mysqlMetric }),
  templateSeed({ slug: 'mysql', title: 'MySQL overview', intentTags: ['mysql', 'db', 'database', 'dashboard', 'mariadb', 'on-call'], content: { panels: mysqlPanels, variables: jobOnlyVars, notes: defaultNotes('MySQL') } }),
  // MongoDB
  metricDoc({ slug: 'mongodb', title: 'MongoDB metrics', intentTags: ['mongodb', 'mongo', 'db', 'database', 'nosql', 'document-db', 'on-call'], content: mongoMetric }),
  templateSeed({ slug: 'mongodb', title: 'MongoDB overview', intentTags: ['mongodb', 'mongo', 'db', 'database', 'dashboard', 'nosql', 'on-call'], content: { panels: mongoPanels, variables: jobOnlyVars, notes: defaultNotes('MongoDB') } }),
  // Redis
  metricDoc({ slug: 'redis', title: 'Redis metrics', intentTags: ['redis', 'cache', 'db', 'kv', 'in-memory', 'on-call', 'performance'], content: redisMetric }),
  templateSeed({ slug: 'redis', title: 'Redis overview', intentTags: ['redis', 'cache', 'kv', 'dashboard', 'in-memory', 'on-call'], content: { panels: redisPanels, variables: jobOnlyVars, notes: defaultNotes('Redis') } }),
  // Kafka
  metricDoc({ slug: 'kafka', title: 'Kafka metrics', intentTags: ['kafka', 'messaging', 'streaming', 'broker', 'consumer-lag', 'on-call', 'event-bus'], content: kafkaMetric }),
  templateSeed({ slug: 'kafka', title: 'Kafka cluster overview', intentTags: ['kafka', 'messaging', 'streaming', 'broker', 'dashboard', 'on-call'], content: { panels: kafkaPanels, variables: jobOnlyVars, notes: defaultNotes('Kafka') } }),
  // RabbitMQ
  metricDoc({ slug: 'rabbitmq', title: 'RabbitMQ metrics', intentTags: ['rabbitmq', 'amqp', 'messaging', 'queue', 'broker', 'on-call'], content: rabbitMetric }),
  templateSeed({ slug: 'rabbitmq', title: 'RabbitMQ overview', intentTags: ['rabbitmq', 'amqp', 'messaging', 'queue', 'dashboard', 'on-call'], content: { panels: rabbitPanels, variables: jobOnlyVars, notes: defaultNotes('RabbitMQ') } }),
  // NATS
  metricDoc({ slug: 'nats', title: 'NATS metrics', intentTags: ['nats', 'messaging', 'jetstream', 'pubsub', 'broker', 'on-call'], content: natsMetric }),
  templateSeed({ slug: 'nats', title: 'NATS overview', intentTags: ['nats', 'messaging', 'jetstream', 'pubsub', 'dashboard', 'on-call'], content: { panels: natsPanels, variables: jobOnlyVars, notes: defaultNotes('NATS') } }),
  // Nginx
  metricDoc({ slug: 'nginx', title: 'Nginx metrics', intentTags: ['nginx', 'http', 'proxy', 'web', 'reverse-proxy', 'on-call'], content: nginxMetric }),
  templateSeed({ slug: 'nginx', title: 'Nginx overview', intentTags: ['nginx', 'http', 'proxy', 'web', 'dashboard', 'on-call'], content: { panels: nginxPanels, variables: jobOnlyVars, notes: defaultNotes('Nginx') } }),
  // HAProxy
  metricDoc({ slug: 'haproxy', title: 'HAProxy metrics', intentTags: ['haproxy', 'http', 'tcp', 'load-balancer', 'proxy', 'on-call'], content: haproxyMetric }),
  templateSeed({ slug: 'haproxy', title: 'HAProxy overview', intentTags: ['haproxy', 'load-balancer', 'proxy', 'dashboard', 'on-call'], content: { panels: haproxyPanels, variables: jobOnlyVars, notes: defaultNotes('HAProxy') } }),
  // Envoy
  metricDoc({ slug: 'envoy', title: 'Envoy (standalone) metrics', intentTags: ['envoy', 'proxy', 'http', 'l7', 'edge', 'on-call'], content: envoyMetric }),
  templateSeed({ slug: 'envoy', title: 'Envoy overview', intentTags: ['envoy', 'proxy', 'http', 'edge', 'dashboard', 'on-call'], content: { panels: envoyPanels, variables: jobOnlyVars, notes: defaultNotes('Envoy') } }),
  // JVM
  metricDoc({ slug: 'jvm', title: 'JVM runtime metrics', intentTags: ['jvm', 'java', 'kotlin', 'scala', 'runtime', 'gc', 'heap', 'on-call'], content: jvmMetric }),
  templateSeed({ slug: 'jvm', title: 'JVM runtime overview', intentTags: ['jvm', 'java', 'runtime', 'dashboard', 'heap', 'gc', 'on-call'], content: { panels: jvmPanels, variables: jobOnlyVars, notes: defaultNotes('JVM') } }),
  // Node.js
  metricDoc({ slug: 'nodejs', title: 'Node.js runtime metrics', intentTags: ['nodejs', 'node', 'javascript', 'typescript', 'runtime', 'event-loop', 'on-call'], content: nodejsMetric }),
  templateSeed({ slug: 'nodejs', title: 'Node.js runtime overview', intentTags: ['nodejs', 'node', 'runtime', 'dashboard', 'event-loop', 'on-call'], content: { panels: nodejsPanels, variables: jobOnlyVars, notes: defaultNotes('Node.js') } }),
  // Go
  metricDoc({ slug: 'go', title: 'Go runtime metrics', intentTags: ['go', 'golang', 'runtime', 'goroutine', 'gc', 'on-call'], content: goMetric }),
  templateSeed({ slug: 'go', title: 'Go runtime overview', intentTags: ['go', 'golang', 'runtime', 'dashboard', 'goroutine', 'gc', 'on-call'], content: { panels: goPanels, variables: jobOnlyVars, notes: defaultNotes('Go') } }),
];

export const BUNDLED_SEEDS: ReadonlyArray<Omit<KnowledgeInsertInput, 'orgId'>> = [
  {
    id: 'bundled-pattern-red-method',
    source: 'bundled',
    sourceRef: null,
    kind: 'pattern',
    title: 'RED method (Rate, Errors, Duration)',
    intentTags: ['red', 'http', 'rest', 'rpc', 'service', 'latency', 'requests'],
    content: redContent,
    createdBy: null,
  },
  {
    id: 'bundled-pattern-use-method',
    source: 'bundled',
    sourceRef: null,
    kind: 'pattern',
    title: 'USE method (Utilization, Saturation, Errors)',
    intentTags: ['use', 'resource', 'cpu', 'memory', 'disk', 'network', 'node', 'pod'],
    content: useContent,
    createdBy: null,
  },
  {
    id: 'bundled-pattern-per-pod-ops',
    source: 'bundled',
    sourceRef: null,
    kind: 'pattern',
    title: 'Per-pod operational view',
    intentTags: ['pod', 'workload', 'on-call', 'debug', 'k8s', 'kubernetes'],
    content: perPodContent,
    createdBy: null,
  },
  {
    id: 'bundled-template-istio-data-plane',
    source: 'bundled',
    sourceRef: null,
    kind: 'template',
    title: 'Istio data plane',
    intentTags: ['istio', 'service-mesh', 'envoy', 'ingress', 'gateway', 'k8s', 'kubernetes'],
    content: istioContent,
    createdBy: null,
  },
  {
    id: 'bundled-template-k8s-workload-health',
    source: 'bundled',
    sourceRef: null,
    kind: 'template',
    title: 'Kubernetes workload health',
    intentTags: ['k8s', 'kubernetes', 'workload', 'pod', 'deployment', 'red', 'on-call'],
    content: k8sWorkloadContent,
    createdBy: null,
  },
  ...PER_SW_SEEDS,
];
