/**
 * ClusterShellExecutionAdapter — `ExecutionAdapter` impl for the
 * `ops.cluster_shell` plan step kind.
 *
 * Spawns a one-shot `batch/v1` Job inside the user's cluster, waits for it
 * to terminate (success or fail), pulls the pod logs, and reports back.
 * Lets the agent propose operations that aren't kubectl-shaped (`istioctl
 * install`, `helm install`, `curl https://… | sh`) without ever asking the
 * user to "run this on your local box" — the cluster runs it.
 *
 * Architecture (mirrors KubectlExecutionAdapter on purpose):
 *   - kubeconfig is resolved per-invocation, written to a tmp file with
 *     mode 0600, exposed via `KUBECONFIG`, and unlinked in `finally`.
 *   - Underlying transport is the `kubectl` binary, so users only need one
 *     dependency in the api-gateway image. Job manifest is piped to
 *     `kubectl apply -f -` via stdin so we don't write the script to disk.
 *   - Cleanup of the Job itself is delegated to
 *     `spec.ttlSecondsAfterFinished` so even a crashed adapter doesn't
 *     leave orphans.
 *
 * Failure modes:
 *   - Apply fails (RBAC, validation): error surfaced in ExecutionResult.error.
 *   - Job timeout: `kubectl wait` returns non-zero; we then check the Job's
 *     `.status.failed` to differentiate genuine failure from "still running".
 *   - Script exits non-zero: Job condition becomes `Failed`; logs still
 *     fetched and returned as output, success=false.
 *
 * Reads `action.params` shaped as:
 *   {
 *     script: string,            // run as `sh -c "<script>"`
 *     scope: 'cluster' | 'namespace',
 *     namespace?: string,        // required when scope='namespace'
 *     image?: string,            // defaults to options.defaultImage
 *   }
 *
 * The connectorId travels on the step but is consumed upstream
 * (plan-executor → adapterFor) to bind the right kubeconfig before this
 * adapter is constructed; it isn't read here.
 */

import { spawn, type SpawnOptions, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AdapterAction,
  AdapterCapability,
  DryRunResult,
  ExecutionAdapter,
  ExecutionResult,
  ValidationResult,
} from './types.js';

/** Cap stdout/stderr we keep per kubectl invocation; logs may be large. */
const STDIO_CAP_BYTES = 256 * 1024;

/** Default container image — has kubectl, curl, sh, jq baked in. */
const DEFAULT_IMAGE = 'alpine/k8s:1.29.0';

/** Default ServiceAccount used inside the Job. Provisioned by the Rounds helm chart. */
const DEFAULT_JOB_SERVICE_ACCOUNT = 'rounds-bootstrap';

/** Default namespace for cluster-wide bootstrap jobs (where the SA lives). */
const DEFAULT_BOOTSTRAP_NAMESPACE = 'rounds-system';

/** Job wait timeout default (10 min — installs can be slow). */
const DEFAULT_WAIT_TIMEOUT_SECONDS = 600;

export interface ClusterShellSpawnFn {
  (
    cmd: string,
    args: readonly string[],
    options?: SpawnOptions,
  ): ChildProcessWithoutNullStreams;
}

export interface ClusterShellExecutionAdapterOptions {
  /**
   * Bound to the connector this adapter speaks to. Resolved on every
   * `execute` call so rotated kubeconfigs take effect without restart.
   */
  resolveKubeconfig: () => Promise<string> | string;
  /** Path or name of the kubectl binary. Defaults to `'kubectl'` on $PATH. */
  kubectlBinary?: string;
  /** Override for tests; defaults to `child_process.spawn`. */
  spawnFn?: ClusterShellSpawnFn;
  /** Hard timeout for one kubectl invocation, ms. Defaults to 60_000. */
  kubectlTimeoutMs?: number;
  /** How long `kubectl wait` should block on Job completion, seconds. */
  waitTimeoutSeconds?: number;
  /** Container image for the Job runner. */
  defaultImage?: string;
  /** ServiceAccount name. Must already exist in the target namespace. */
  jobServiceAccount?: string;
  /** Namespace where `scope='cluster'` Jobs run. The SA lives here. */
  bootstrapNamespace?: string;
}

export interface ClusterShellActionParams {
  script: string;
  scope: 'cluster' | 'namespace';
  namespace?: string;
  image?: string;
}

function takeParams(action: AdapterAction): ClusterShellActionParams {
  const p = action.params as unknown as Partial<ClusterShellActionParams>;
  if (typeof p?.script !== 'string' || !p.script) {
    throw new Error('ClusterShellExecutionAdapter: params.script must be a non-empty string');
  }
  if (p.scope !== 'cluster' && p.scope !== 'namespace') {
    throw new Error('ClusterShellExecutionAdapter: params.scope must be "cluster" or "namespace"');
  }
  if (p.scope === 'namespace' && (typeof p.namespace !== 'string' || !p.namespace)) {
    throw new Error('ClusterShellExecutionAdapter: params.namespace is required when scope="namespace"');
  }
  return {
    script: p.script,
    scope: p.scope,
    ...(p.namespace ? { namespace: p.namespace } : {}),
    ...(p.image ? { image: p.image } : {}),
  };
}

function tail(buf: Buffer[], cap: number): string {
  const all = Buffer.concat(buf);
  return all.length <= cap ? all.toString('utf8') : all.subarray(all.length - cap).toString('utf8');
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/**
 * Compose the Job manifest. Public for tests so we can assert on shape
 * without running kubectl.
 */
export function buildJobManifest(input: {
  jobName: string;
  namespace: string;
  serviceAccount: string;
  image: string;
  script: string;
}): string {
  // We pass the script via env var rather than substituting into the YAML
  // string to avoid YAML-injection from `'` / `"` / newlines in the script.
  // Using `command: ['sh','-c','$SCRIPT']` would suppress positional args;
  // `args: ['$SCRIPT']` reads stdin pos $0 which is sh-confusing. The
  // standard pattern is `sh -c 'exec "$@"' --` then args. We keep it
  // simpler by base64-encoding the script and decoding inside the
  // container — no YAML escaping needed.
  const scriptB64 = Buffer.from(input.script, 'utf8').toString('base64');
  return [
    'apiVersion: batch/v1',
    'kind: Job',
    'metadata:',
    `  name: ${input.jobName}`,
    `  namespace: ${input.namespace}`,
    '  labels:',
    '    app.kubernetes.io/managed-by: rounds',
    '    rounds.ai/component: cluster-shell',
    'spec:',
    '  ttlSecondsAfterFinished: 300',
    '  backoffLimit: 0',
    '  template:',
    '    metadata:',
    '      labels:',
    '        app.kubernetes.io/managed-by: rounds',
    '        rounds.ai/component: cluster-shell',
    `        rounds.ai/job-name: ${input.jobName}`,
    '    spec:',
    `      serviceAccountName: ${input.serviceAccount}`,
    '      restartPolicy: Never',
    '      containers:',
    '      - name: runner',
    `        image: ${input.image}`,
    '        env:',
    '        - name: ROUNDS_SCRIPT_B64',
    `          value: ${JSON.stringify(scriptB64)}`,
    '        command: ["sh", "-c"]',
    // Decode the script from $ROUNDS_SCRIPT_B64 and exec it via /bin/sh.
    // Using `set -e` so the first failing line stops the script and
    // surfaces a non-zero exit code into the Job condition.
    '        args:',
    '        - |',
    '          set -e',
    '          echo "$ROUNDS_SCRIPT_B64" | base64 -d | sh',
    '',
  ].join('\n');
}

/**
 * Generate a Job name: `rounds-cs-<8 hex>`. The full UUID would push us
 * past the 63-char DNS-1123 limit when combined with pod-suffix
 * machinery, so we truncate.
 */
function makeJobName(): string {
  const id = randomUUID().replace(/-/g, '').slice(0, 8);
  return `rounds-cs-${id}`;
}

export class ClusterShellExecutionAdapter implements ExecutionAdapter {
  private readonly opts: Required<Omit<ClusterShellExecutionAdapterOptions, 'spawnFn'>> & {
    spawnFn: ClusterShellSpawnFn;
  };

  constructor(opts: ClusterShellExecutionAdapterOptions) {
    this.opts = {
      resolveKubeconfig: opts.resolveKubeconfig,
      kubectlBinary: opts.kubectlBinary ?? 'kubectl',
      spawnFn: opts.spawnFn ?? (spawn as unknown as ClusterShellSpawnFn),
      kubectlTimeoutMs: opts.kubectlTimeoutMs ?? 60_000,
      waitTimeoutSeconds: opts.waitTimeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS,
      defaultImage: opts.defaultImage ?? DEFAULT_IMAGE,
      jobServiceAccount: opts.jobServiceAccount ?? DEFAULT_JOB_SERVICE_ACCOUNT,
      bootstrapNamespace: opts.bootstrapNamespace ?? DEFAULT_BOOTSTRAP_NAMESPACE,
    };
  }

  capabilities(): AdapterCapability[] {
    return ['ops.cluster_shell'];
  }

  async validate(action: AdapterAction): Promise<ValidationResult> {
    try {
      takeParams(action);
      return { valid: true };
    } catch (err) {
      return { valid: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async dryRun(action: AdapterAction): Promise<DryRunResult> {
    const params = takeParams(action);
    const ns = params.scope === 'cluster' ? this.opts.bootstrapNamespace : params.namespace!;
    return {
      estimatedImpact: `Spawn one-shot Job in namespace ${ns} (image ${params.image ?? this.opts.defaultImage}) running script (${params.script.length} chars).`,
      warnings: params.scope === 'cluster'
        ? ['Cluster-scoped script — may modify CRDs, control planes, or cluster-wide resources.']
        : [],
      willAffect: [`namespace/${ns}`],
    };
  }

  async execute(action: AdapterAction): Promise<ExecutionResult> {
    const executionId = randomUUID();
    let params: ClusterShellActionParams;
    try {
      params = takeParams(action);
    } catch (err) {
      return {
        success: false,
        output: '',
        rollbackable: false,
        executionId,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const namespace = params.scope === 'cluster' ? this.opts.bootstrapNamespace : params.namespace!;
    const image = params.image ?? this.opts.defaultImage;
    const jobName = makeJobName();
    const manifest = buildJobManifest({
      jobName,
      namespace,
      serviceAccount: this.opts.jobServiceAccount,
      image,
      script: params.script,
    });

    const kubeconfig = await this.opts.resolveKubeconfig();
    const dir = mkdtempSync(join(tmpdir(), 'rounds-kubeconfig-'));
    const kubeconfigPath = join(dir, 'kubeconfig');
    try {
      writeFileSync(kubeconfigPath, kubeconfig, { mode: 0o600 });

      // 1. apply the Job manifest via stdin.
      const apply = await this.runKubectl(
        ['apply', '-f', '-', '-n', namespace],
        kubeconfigPath,
        manifest,
      );
      if (apply.exitCode !== 0) {
        return {
          success: false,
          output: apply.stdout,
          rollbackable: false,
          executionId,
          error: `kubectl apply failed (exit ${apply.exitCode}): ${apply.stderr.trim() || apply.stdout.trim()}`,
        };
      }

      // 2. wait for the Job to terminate. We race two conditions —
      // success (`complete`) and failure (`failed`) — by waiting on the
      // first one. kubectl doesn't OR-combine conditions, so we wait on
      // complete with the full timeout; if that returns non-zero we then
      // inspect status directly to differentiate timeout vs Failed.
      const wait = await this.runKubectl(
        [
          'wait',
          `--for=condition=complete`,
          `--timeout=${this.opts.waitTimeoutSeconds}s`,
          '-n',
          namespace,
          `job/${jobName}`,
        ],
        kubeconfigPath,
      );

      // 3. fetch logs regardless of wait outcome — they're the most
      // useful diagnostic to surface.
      const logs = await this.runKubectl(
        ['logs', '-n', namespace, `job/${jobName}`, '--tail=-1'],
        kubeconfigPath,
      );

      if (wait.exitCode === 0) {
        return {
          success: true,
          output: logs.stdout || '(no output)',
          rollbackable: false,
          executionId,
        };
      }

      // 4. wait failed: inspect the Job to differentiate timeout vs Failed.
      const status = await this.runKubectl(
        [
          'get',
          'job',
          '-n',
          namespace,
          jobName,
          '-o',
          'jsonpath={.status.succeeded}/{.status.failed}/{.status.active}',
        ],
        kubeconfigPath,
      );
      const [succeeded, failed, active] = status.stdout.split('/');
      const failedCount = Number(failed) || 0;
      const activeCount = Number(active) || 0;
      const reason = failedCount > 0
        ? `Job ${jobName} failed (${failedCount} failed pod${failedCount === 1 ? '' : 's'})`
        : activeCount > 0
        ? `Job ${jobName} did not complete within ${this.opts.waitTimeoutSeconds}s (still running)`
        : `Job ${jobName} terminated without success (succeeded=${succeeded || 0}, failed=${failedCount}, active=${activeCount})`;

      return {
        success: false,
        output: logs.stdout || '(no output)',
        rollbackable: false,
        executionId,
        error: `${reason}. ${wait.stderr.trim() || ''}`.trim(),
      };
    } catch (err) {
      return {
        success: false,
        output: '',
        rollbackable: false,
        executionId,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* cleanup must not mask the original error */
      }
    }
  }

  /**
   * Spawn `kubectl <argv...>` with the per-invocation kubeconfig env.
   * Optionally pipe `stdin` (used for `kubectl apply -f -`).
   */
  private async runKubectl(
    argv: readonly string[],
    kubeconfigPath: string,
    stdin?: string,
  ): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      const child = this.opts.spawnFn(this.opts.kubectlBinary, argv as string[], {
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/usr/local/bin',
          KUBECONFIG: kubeconfigPath,
          HOME: process.env['HOME'] ?? '/tmp',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
      child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

      let timedOut = false;
      const t = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.opts.kubectlTimeoutMs);

      child.on('error', (err) => {
        clearTimeout(t);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(t);
        resolve({
          stdout: tail(stdoutChunks, STDIO_CAP_BYTES),
          stderr: tail(stderrChunks, STDIO_CAP_BYTES),
          exitCode: code ?? -1,
          timedOut,
        });
      });

      if (stdin !== undefined) {
        child.stdin.write(stdin);
        child.stdin.end();
      } else {
        child.stdin.end();
      }
    });
  }
}
