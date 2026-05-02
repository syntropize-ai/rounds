/**
 * kubectl helpers. We shell out — depending on the kubectl in PATH —
 * because the agent A test harness already provisions a kubeconfig for
 * the kind cluster (see tests/e2e/kit.sh). Every scenario that scales
 * a workload assumes the local kubectl can talk to the cluster.
 */
import { spawn } from 'node:child_process';
import { pollUntil } from './wait.js';

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (b) => (stdout += b.toString()));
    p.stderr.on('data', (b) => (stderr += b.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(' ')} exit ${code}: ${stderr}`));
    });
  });
}

async function podCount(namespace: string, deploy: string): Promise<number> {
  // Count Pods that match the deployment's selector. We use the
  // app=<deploy> label that the e2e fixtures set on every workload.
  const { stdout } = await run('kubectl', [
    'get',
    'pods',
    '-n',
    namespace,
    '-l',
    `app=${deploy}`,
    '--no-headers',
    '--ignore-not-found',
  ]);
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length;
}

export async function scaleDeployment(
  namespace: string,
  name: string,
  replicas: number,
): Promise<void> {
  await run('kubectl', [
    'scale',
    `deploy/${name}`,
    '-n',
    namespace,
    `--replicas=${replicas}`,
  ]);
  if (replicas === 0) {
    // `kubectl rollout status` settles instantly at replicas=0 even while
    // pods are still terminating, and `--for=jsonpath={.status.replicas}=0`
    // never matches because the field is omitted at 0. Poll the pod
    // count directly until every replica is gone.
    await pollUntil(
      async () => ((await podCount(namespace, name)) === 0 ? true : null),
      { timeoutMs: 180_000, intervalMs: 2000, label: `pods of ${name} -> 0` },
    );
  } else {
    await run('kubectl', [
      'rollout',
      'status',
      `deploy/${name}`,
      '-n',
      namespace,
      '--timeout=120s',
    ]);
  }
}
