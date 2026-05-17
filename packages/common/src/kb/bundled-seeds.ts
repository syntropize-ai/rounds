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
];
