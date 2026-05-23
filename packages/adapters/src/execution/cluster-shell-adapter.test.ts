import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import {
  ClusterShellExecutionAdapter,
  buildJobManifest,
} from './cluster-shell-adapter.js';

/**
 * Multi-call fake spawn. The adapter issues up to 4 kubectl calls per
 * execute (apply, wait, logs, get-status); the matcher routes each call
 * to a pre-programmed response.
 */
function fakeSpawn(responses: Array<{
  matchArgs: (args: readonly string[]) => boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}>) {
  type Call = { args: readonly string[]; stdin: string | null };
  const calls: Call[] = [];

  const fn = ((cmd: string, args: readonly string[]) => {
    const matched = responses.find((r) => r.matchArgs(args));
    if (!matched) {
      throw new Error(`unexpected kubectl call: ${args.join(' ')}`);
    }

    let stdinBuf = '';
    const stdin = new Writable({
      write(chunk: Buffer, _enc, cb) {
        stdinBuf += chunk.toString('utf8');
        cb();
      },
    });

    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: Writable;
      kill: () => void;
    };
    Object.assign(child, {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin,
      kill: () => undefined,
    });

    stdin.on('finish', () => {
      calls.push({ args, stdin: stdinBuf || null });
      setImmediate(() => {
        if (matched.stdout) (child.stdout as EventEmitter).emit('data', Buffer.from(matched.stdout));
        if (matched.stderr) (child.stderr as EventEmitter).emit('data', Buffer.from(matched.stderr));
        child.emit('close', matched.exitCode ?? 0, null);
      });
    });

    return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  return { fn, calls };
}

const KUBECONFIG = 'apiVersion: v1\nkind: Config\nclusters: []\n';

describe('buildJobManifest', () => {
  it('embeds the script as base64 and references the right SA/image/ns', () => {
    const yaml = buildJobManifest({
      jobName: 'rounds-cs-abcd1234',
      namespace: 'rounds-system',
      serviceAccount: 'rounds-bootstrap',
      image: 'alpine/k8s:1.29.0',
      script: 'echo hello && kubectl get pods',
    });
    expect(yaml).toContain('name: rounds-cs-abcd1234');
    expect(yaml).toContain('namespace: rounds-system');
    expect(yaml).toContain('serviceAccountName: rounds-bootstrap');
    expect(yaml).toContain('image: alpine/k8s:1.29.0');
    const expectedB64 = Buffer.from('echo hello && kubectl get pods').toString('base64');
    expect(yaml).toContain(expectedB64);
    // backoffLimit 0 + ttl 300 keep cleanup deterministic
    expect(yaml).toContain('backoffLimit: 0');
    expect(yaml).toContain('ttlSecondsAfterFinished: 300');
  });
});

describe('ClusterShellExecutionAdapter.validate', () => {
  it('rejects missing script', async () => {
    const { fn } = fakeSpawn([]);
    const a = new ClusterShellExecutionAdapter({ resolveKubeconfig: () => KUBECONFIG, spawnFn: fn });
    const r = await a.validate({ type: 'ops.cluster_shell', targetService: 'k', params: { scope: 'cluster' } });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/script/);
  });
  it('rejects scope=namespace without namespace', async () => {
    const { fn } = fakeSpawn([]);
    const a = new ClusterShellExecutionAdapter({ resolveKubeconfig: () => KUBECONFIG, spawnFn: fn });
    const r = await a.validate({ type: 'ops.cluster_shell', targetService: 'k', params: { script: 'echo hi', scope: 'namespace' } });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/namespace/);
  });
  it('accepts a well-formed cluster-scoped action', async () => {
    const { fn } = fakeSpawn([]);
    const a = new ClusterShellExecutionAdapter({ resolveKubeconfig: () => KUBECONFIG, spawnFn: fn });
    const r = await a.validate({ type: 'ops.cluster_shell', targetService: 'k', params: { script: 'echo hi', scope: 'cluster' } });
    expect(r.valid).toBe(true);
  });
});

describe('ClusterShellExecutionAdapter.execute (success path)', () => {
  it('apply → wait(complete) → logs → ExecutionResult.success', async () => {
    const { fn, calls } = fakeSpawn([
      { matchArgs: (a) => a.includes('apply'), stdout: 'job.batch/rounds-cs-x created\n' },
      { matchArgs: (a) => a.includes('wait'), stdout: 'job.batch/rounds-cs-x condition met\n' },
      { matchArgs: (a) => a.includes('logs'), stdout: 'hello from script\n' },
    ]);
    const a = new ClusterShellExecutionAdapter({
      resolveKubeconfig: () => KUBECONFIG,
      spawnFn: fn,
      waitTimeoutSeconds: 5,
    });
    const r = await a.execute({
      type: 'ops.cluster_shell',
      targetService: 'k',
      params: { script: 'echo hello from script', scope: 'cluster' },
    });
    expect(r.success).toBe(true);
    expect(r.output).toContain('hello from script');
    expect(calls).toHaveLength(3);
    // apply call piped manifest via stdin
    const applyCall = calls[0];
    expect(applyCall?.stdin).toContain('kind: Job');
    // hits bootstrap namespace by default for cluster scope
    expect(applyCall?.args.join(' ')).toMatch(/-n rounds-system/);
  });

  it('namespace scope routes Job into the requested namespace', async () => {
    const { fn, calls } = fakeSpawn([
      { matchArgs: (a) => a.includes('apply'), stdout: '' },
      { matchArgs: (a) => a.includes('wait'), stdout: '' },
      { matchArgs: (a) => a.includes('logs'), stdout: 'ok\n' },
    ]);
    const a = new ClusterShellExecutionAdapter({ resolveKubeconfig: () => KUBECONFIG, spawnFn: fn });
    const r = await a.execute({
      type: 'ops.cluster_shell',
      targetService: 'k',
      params: { script: 'echo ok', scope: 'namespace', namespace: 'apps' },
    });
    expect(r.success).toBe(true);
    expect(calls[0]?.args.join(' ')).toMatch(/-n apps/);
    expect(calls[0]?.stdin).toContain('namespace: apps');
  });
});

describe('ClusterShellExecutionAdapter.execute (failure paths)', () => {
  it('apply failure surfaces as ExecutionResult.error', async () => {
    const { fn } = fakeSpawn([
      { matchArgs: (a) => a.includes('apply'), stderr: 'error: serviceaccounts "rounds-bootstrap" not found', exitCode: 1 },
    ]);
    const a = new ClusterShellExecutionAdapter({ resolveKubeconfig: () => KUBECONFIG, spawnFn: fn });
    const r = await a.execute({
      type: 'ops.cluster_shell',
      targetService: 'k',
      params: { script: 'echo hi', scope: 'cluster' },
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/kubectl apply failed/);
    expect(r.error).toMatch(/rounds-bootstrap/);
  });

  it('wait timeout with Job still active reports "did not complete"', async () => {
    const { fn } = fakeSpawn([
      { matchArgs: (a) => a.includes('apply'), exitCode: 0 },
      { matchArgs: (a) => a.includes('wait'), stderr: 'timed out waiting for the condition', exitCode: 1 },
      { matchArgs: (a) => a.includes('logs'), stdout: 'partial output\n' },
      { matchArgs: (a) => a.includes('get') && a.includes('job'), stdout: '0/0/1' }, // succeeded/failed/active
    ]);
    const a = new ClusterShellExecutionAdapter({
      resolveKubeconfig: () => KUBECONFIG,
      spawnFn: fn,
      waitTimeoutSeconds: 3,
    });
    const r = await a.execute({
      type: 'ops.cluster_shell',
      targetService: 'k',
      params: { script: 'sleep 999', scope: 'cluster' },
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/did not complete/);
    expect(r.output).toContain('partial output');
  });

  it('script exits non-zero → Job failed → success=false with logs preserved', async () => {
    const { fn } = fakeSpawn([
      { matchArgs: (a) => a.includes('apply'), exitCode: 0 },
      { matchArgs: (a) => a.includes('wait'), stderr: 'error: timed out waiting', exitCode: 1 },
      { matchArgs: (a) => a.includes('logs'), stdout: 'script error: command not found\n' },
      { matchArgs: (a) => a.includes('get') && a.includes('job'), stdout: '0/1/0' },
    ]);
    const a = new ClusterShellExecutionAdapter({ resolveKubeconfig: () => KUBECONFIG, spawnFn: fn });
    const r = await a.execute({
      type: 'ops.cluster_shell',
      targetService: 'k',
      params: { script: 'nope', scope: 'cluster' },
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Job .* failed/);
    expect(r.output).toContain('script error');
  });
});

describe('ClusterShellExecutionAdapter overrides', () => {
  it('honors jobServiceAccount + bootstrapNamespace + defaultImage', async () => {
    const { fn, calls } = fakeSpawn([
      { matchArgs: (a) => a.includes('apply'), exitCode: 0 },
      { matchArgs: (a) => a.includes('wait'), exitCode: 0 },
      { matchArgs: (a) => a.includes('logs'), stdout: 'ok' },
    ]);
    const a = new ClusterShellExecutionAdapter({
      resolveKubeconfig: () => KUBECONFIG,
      spawnFn: fn,
      jobServiceAccount: 'custom-sa',
      bootstrapNamespace: 'my-system',
      defaultImage: 'bitnami/kubectl:latest',
    });
    await a.execute({
      type: 'ops.cluster_shell',
      targetService: 'k',
      params: { script: 'echo', scope: 'cluster' },
    });
    const applyCall = calls[0];
    expect(applyCall?.args.join(' ')).toContain('-n my-system');
    expect(applyCall?.stdin).toContain('serviceAccountName: custom-sa');
    expect(applyCall?.stdin).toContain('image: bitnami/kubectl:latest');
  });
});
