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
  parseKubectlArgv,
  parseKubectlCommandString,
  KUBECTL_READ_VERBS,
  KUBECTL_WRITE_VERBS,
  KUBECTL_PERMANENT_DENY_VERBS,
  KUBECTL_PERMANENT_DENY_NAMESPACES,
} from './kubectl-allowlist.js';
export type { KubectlMode, AllowlistDecision, ParsedKubectl } from './kubectl-allowlist.js';

export { KubectlExecutionAdapter } from './kubectl-adapter.js';
export type {
  KubectlExecutionAdapterOptions,
  KubectlSpawnFn,
} from './kubectl-adapter.js';
