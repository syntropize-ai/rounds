export type {
  AdapterAction,
  AdapterCapability,
  ValidationResult,
  DryRunResult,
  ExecutionResult,
  ExecutionAdapter,
} from './types.js';

export {
  checkKubectl,
  classifyKubectlCommand,
  parseKubectlArgv,
  parseKubectlCommandString,
  KUBECTL_READ_VERBS,
  KUBECTL_WRITE_VERBS,
  KUBECTL_PERMANENT_DENY_VERBS,
  KUBECTL_PERMANENT_DENY_NAMESPACES,
} from './kubectl-allowlist.js';
export type {
  KubectlMode,
  KubectlPolicyDecision,
  KubectlCommandPolicy,
  AllowlistDecision,
  ParsedKubectl,
} from './kubectl-allowlist.js';

export { KubectlExecutionAdapter } from './kubectl-adapter.js';
export type {
  KubectlExecutionAdapterOptions,
  KubectlSpawnFn,
} from './kubectl-adapter.js';

export {
  ClusterShellExecutionAdapter,
  buildJobManifest,
} from './cluster-shell-adapter.js';
export type {
  ClusterShellExecutionAdapterOptions,
  ClusterShellSpawnFn,
  ClusterShellActionParams,
} from './cluster-shell-adapter.js';

export { ShellExecutionAdapter } from './shell-adapter.js';
export type {
  ShellExecutionAdapterOptions,
  ShellSpawnFn,
} from './shell-adapter.js';
