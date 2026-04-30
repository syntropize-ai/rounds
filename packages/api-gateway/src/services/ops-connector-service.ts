import { spawn, type SpawnOptions, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpsConnector, OpsConnectorConfig, OpsConnectorStatus } from '@agentic-obs/data-layer';
import { DefaultOpsSecretRefResolver, type OpsSecretRefResolver } from './ops-secret-ref-resolver.js';

export interface OpsConnectorTestResult {
  status: Exclude<OpsConnectorStatus, 'unknown'>;
  checks: {
    structure: 'ok' | 'failed';
    credentials: 'ok' | 'missing';
    runner: 'ok' | 'failed' | 'skipped';
  };
  message: string;
}

export interface KubernetesConnectorRunner {
  test(connector: OpsConnector): Promise<OpsConnectorTestResult>;
}

export interface KubectlSpawnFn {
  (
    cmd: string,
    args: readonly string[],
    options?: SpawnOptions,
  ): ChildProcessWithoutNullStreams;
}

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const SA_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
const SA_NAMESPACE_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

/** True when the gateway is running with a Kubernetes service-account mount. */
export function inClusterAvailable(): boolean {
  return Boolean(process.env['KUBERNETES_SERVICE_HOST']) && existsSync(SA_TOKEN_PATH);
}

/**
 * Build a kubeconfig YAML string from explicit cluster + token inputs. We hand
 * a YAML file to kubectl rather than using --server/--token flags so the same
 * code path works for execution and for connection-testing.
 */
export function synthesizeKubeconfig(input: {
  server: string;
  token: string;
  caData?: string;
  insecureSkipTlsVerify?: boolean;
  contextName?: string;
  clusterName?: string;
  namespace?: string;
}): string {
  const cluster = input.clusterName ?? 'openobs-cluster';
  const ctx = input.contextName ?? 'openobs-context';
  const user = 'openobs-user';
  const lines: string[] = [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    `- name: ${cluster}`,
    '  cluster:',
    `    server: ${input.server}`,
  ];
  if (input.insecureSkipTlsVerify) {
    lines.push('    insecure-skip-tls-verify: true');
  } else if (input.caData) {
    // CA must be base64-encoded for `certificate-authority-data`.
    const b64 = Buffer.from(input.caData, 'utf8').toString('base64');
    lines.push(`    certificate-authority-data: ${b64}`);
  }
  lines.push(
    'users:',
    `- name: ${user}`,
    '  user:',
    `    token: ${input.token}`,
    'contexts:',
    `- name: ${ctx}`,
    '  context:',
    `    cluster: ${cluster}`,
    `    user: ${user}`,
  );
  if (input.namespace) {
    lines.push(`    namespace: ${input.namespace}`);
  }
  lines.push(`current-context: ${ctx}`, '');
  return lines.join('\n');
}

/**
 * Build a kubeconfig from the in-cluster service-account mount. Reads token,
 * CA, and namespace from /var/run/secrets/kubernetes.io/serviceaccount/.
 */
export function synthesizeInClusterKubeconfig(opts?: {
  readFile?: (path: string) => string;
  envHost?: string;
  envPort?: string;
}): string {
  const read = opts?.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const host = opts?.envHost ?? process.env['KUBERNETES_SERVICE_HOST'];
  const port = opts?.envPort ?? process.env['KUBERNETES_SERVICE_PORT'] ?? '443';
  if (!host) throw new Error('KUBERNETES_SERVICE_HOST not set; not running in-cluster');
  const token = read(SA_TOKEN_PATH).trim();
  const ca = read(SA_CA_PATH);
  let namespace: string | undefined;
  try {
    namespace = read(SA_NAMESPACE_PATH).trim() || undefined;
  } catch {
    namespace = undefined;
  }
  return synthesizeKubeconfig({
    server: `https://${host}:${port}`,
    token,
    caData: ca,
    namespace,
  });
}

export function validateKubernetesConnector(config: OpsConnectorConfig): string | null {
  const apiServer = config.apiServer;
  if (apiServer !== undefined && typeof apiServer !== 'string') {
    return 'config.apiServer must be a string when provided';
  }
  if (typeof apiServer === 'string' && apiServer.length > 0) {
    try {
      const parsed = new URL(apiServer);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return 'config.apiServer must use http or https';
      }
    } catch {
      return 'config.apiServer must be a valid URL';
    }
  }

  if (config.clusterName !== undefined && typeof config.clusterName !== 'string') {
    return 'config.clusterName must be a string when provided';
  }
  if (config.context !== undefined && typeof config.context !== 'string') {
    return 'config.context must be a string when provided';
  }
  if (
    !config.apiServer
    && !config.clusterName
    && !config.context
    && (config as { mode?: string }).mode !== 'in-cluster'
  ) {
    return 'one of config.apiServer, config.clusterName, or config.context is required';
  }

  return null;
}

/**
 * Classify a kubectl error so the UI can show something more useful than a
 * raw stack trace. The patterns we look for are the most common pre-flight
 * failures: DNS, TLS chain, auth, RBAC, and timeouts.
 */
export function classifyKubectlError(stderr: string, timedOut: boolean): string {
  if (timedOut) return 'timeout: kubectl did not respond within 5s';
  const s = stderr.toLowerCase();
  if (s.includes('no such host') || s.includes('dial tcp') && s.includes('lookup')) {
    return `DNS error: ${stderr.trim()}`;
  }
  if (s.includes('connection refused')) {
    return `connection refused: ${stderr.trim()}`;
  }
  if (s.includes('certificate') || s.includes('x509') || s.includes('tls')) {
    return `TLS error: ${stderr.trim()}`;
  }
  if (s.includes('unauthorized') || s.includes('401')) {
    return `401 unauthorized: token rejected by API server`;
  }
  if (s.includes('forbidden') || s.includes('403')) {
    return `403 forbidden: token lacks permission for kubectl version`;
  }
  return stderr.trim() || 'kubectl failed';
}

/**
 * Spawn `kubectl version --output=json --kubeconfig=<temp>` and capture the
 * result. Used by the live runner — kept inline here (vs reusing the
 * KubectlExecutionAdapter) because the adapter is allowlist-gated for plan
 * execution; "test connection" is a different call site with a different
 * trust model.
 */
async function runKubectlVersion(
  kubeconfig: string,
  spawnFn: KubectlSpawnFn = spawn as unknown as KubectlSpawnFn,
  timeoutMs = 5000,
): Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), 'openobs-test-kc-'));
  const kubeconfigPath = join(dir, 'kubeconfig');
  try {
    writeFileSync(kubeconfigPath, kubeconfig, { mode: 0o600 });
    return await new Promise((resolve, reject) => {
      const child = spawnFn('kubectl', [
        'version',
        '--output=json',
        `--kubeconfig=${kubeconfigPath}`,
      ], {
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/usr/local/bin',
          HOME: process.env['HOME'] ?? dir,
        },
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => out.push(c));
      child.stderr.on('data', (c: Buffer) => err.push(c));
      let timedOut = false;
      const t = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.on('error', (e) => { clearTimeout(t); reject(e); });
      child.on('close', (code) => {
        clearTimeout(t);
        resolve({
          ok: code === 0 && !timedOut,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          timedOut,
        });
      });
    });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Live runner — actually shells out to `kubectl version` against the
 * connector's resolved kubeconfig. Replaces the structural-only path that
 * previously ran here.
 */
export class LiveKubernetesConnectorRunner implements KubernetesConnectorRunner {
  private readonly secretResolver: OpsSecretRefResolver;
  private readonly spawnFn: KubectlSpawnFn;
  private readonly timeoutMs: number;

  constructor(opts: {
    secretResolver?: OpsSecretRefResolver;
    spawnFn?: KubectlSpawnFn;
    timeoutMs?: number;
  } = {}) {
    this.secretResolver = opts.secretResolver ?? new DefaultOpsSecretRefResolver();
    this.spawnFn = opts.spawnFn ?? (spawn as unknown as KubectlSpawnFn);
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  async test(connector: OpsConnector): Promise<OpsConnectorTestResult> {
    const validation = validateKubernetesConnector(connector.config);
    if (validation) {
      return {
        status: 'error',
        checks: { structure: 'failed', credentials: 'missing', runner: 'skipped' },
        message: validation,
      };
    }

    let kubeconfig: string | null = null;
    if (connector.secretRef) {
      try {
        kubeconfig = await this.secretResolver.resolve(connector.secretRef);
      } catch (err) {
        return {
          status: 'error',
          checks: { structure: 'ok', credentials: 'missing', runner: 'skipped' },
          message: `secretRef could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else if (connector.secret) {
      kubeconfig = connector.secret;
    }

    if (!kubeconfig) {
      return {
        status: 'degraded',
        checks: { structure: 'ok', credentials: 'missing', runner: 'skipped' },
        message: 'no kubeconfig configured',
      };
    }

    try {
      const r = await runKubectlVersion(kubeconfig, this.spawnFn, this.timeoutMs);
      if (r.ok) {
        return {
          status: 'connected',
          checks: { structure: 'ok', credentials: 'ok', runner: 'ok' },
          message: 'kubectl version ok',
        };
      }
      return {
        status: 'error',
        checks: { structure: 'ok', credentials: 'ok', runner: 'failed' },
        message: classifyKubectlError(r.stderr, r.timedOut),
      };
    } catch (err) {
      return {
        status: 'error',
        checks: { structure: 'ok', credentials: 'ok', runner: 'failed' },
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Backwards-compat alias for callers that imported the old name. The default
 * runner is now Live (real probe).
 */
export const StructuralKubernetesConnectorRunner = LiveKubernetesConnectorRunner;
