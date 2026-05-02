/**
 * kubectl helpers. We shell out — depending on the kubectl in PATH —
 * because the agent A test harness already provisions a kubeconfig for
 * the kind cluster (see tests/e2e/kit.sh). Every scenario that scales
 * a workload assumes the local kubectl can talk to the cluster.
 */
import { spawn } from 'node:child_process';

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
  // Wait until the deployment reflects the requested replicas. For
  // replicas=0: kubectl-wait on status.replicas never settles because
  // Kubernetes omits the field entirely when no pods exist. Poll the
  // pod list directly until it's empty.
  if (replicas === 0) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const { stdout } = await run('kubectl', [
        'get',
        'pods',
        '-n',
        namespace,
        '-l',
        `app=${name}`,
        '--no-headers',
        '--ignore-not-found',
      ]);
      if (stdout.trim() === '') return;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error(`pods for ${namespace}/${name} did not terminate within 90s`);
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
