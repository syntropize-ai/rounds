// BaseAdapter - abstract base class for all execution adapters
// Provides boilerplate for the ExecutionAdapter interface so adapter authors
// only need to implement the core logic, not the scaffolding.

import type {
  ExecutionAdapter,
  AdapterAction,
  AdapterCapability,
  ValidationResult,
  DryRunResult,
  ExecutionResult,
} from '@agentic-obs/agent-core';
import type { AdapterManifest } from './types.js';

/**
 * BaseAdapter provides a concrete starting point for ExecutionAdapter implementations.
 * * Subclasses must implement:
 * - `manifest()` - return the adapter's manifest descriptor
 * - `doExecute(action)` - the actual execution logic
 * * Subclasses may override:
 * - `doValidate(action)` - additional validation beyond capability check
 * - `doDryRun(action)` - simulation logic (default returns generic estimate)
 * - `doRollback(action, executionId)` - undo logic
 */
export abstract class BaseAdapter implements ExecutionAdapter {
  /**
   * Return the static manifest for this adapter type.
   * Must be implemented by every subclass.
   */
  abstract manifest(): AdapterManifest;

  /**
   * Execute the given action and return a result.
   * Must be implemented by every subclass.
   */
  protected abstract doExecute(action: AdapterAction): Promise<ExecutionResult>;

  // -- ExecutionAdapter interface --

  capabilities(): AdapterCapability[] {
    return this.manifest().capabilities;
  }

  async validate(action: AdapterAction): Promise<ValidationResult> {
    const m = this.manifest();

    if (!m.capabilities.includes(action.type)) {
      return {
        valid: false,
        reason: `Action type '${action.type}' is not supported by adapter '${m.name}'. Supported: ${m.capabilities.join(', ')}`,
      };
    }

    return this.doValidate(action);
  }

  async dryRun(action: AdapterAction): Promise<DryRunResult> {
    const m = this.manifest();

    if (!m.supportsDryRun) {
      return {
        estimatedImpact: `Would execute '${action.type}' on '${action.targetService}'`,
        warnings: ['This adapter does not support dry-run simulation - impact is estimated'],
        willAffect: [action.targetService],
      };
    }

    return this.doDryRun(action);
  }

  async execute(action: AdapterAction): Promise<ExecutionResult> {
    const validation = await this.validate(action);
    if (!validation.valid) {
      return {
        success: false,
        output: null,
        rollbackable: false,
        executionId: this.generateExecutionId(),
        errors: [validation.reason],
      };
    }

    return this.doExecute(action);
  }

  async rollback(action: AdapterAction, executionId: string): Promise<ExecutionResult> {
    const m = this.manifest();

    if (!m.supportsRollback) {
      return {
        success: false,
        output: null,
        rollbackable: false,
        executionId,
        error: `Adapter '${m.name}' does not support rollback`,
      };
    }

    return this.doRollback(action, executionId);
  }

  // -- Overridable hooks --

  /**
   * Additional validation beyond capability check.
   * Override to add param-level validation.
   */
  protected async doValidate(_action: AdapterAction): Promise<ValidationResult> {
    return { valid: true };
  }

  /**
   * Dry-run simulation.
   * Override to provide adapter-specific impact estimation.
   */
  protected async doDryRun(action: AdapterAction): Promise<DryRunResult> {
    return {
      estimatedImpact: `Would execute '${action.type}' on '${action.targetService}'`,
      warnings: [],
      willAffect: [action.targetService],
    };
  }

  /**
   * Rollback a previously executed action.
   * Override if your adapter supports undo operations.
   */
  protected async doRollback(_action: AdapterAction, executionId: string): Promise<ExecutionResult> {
    return {
      success: false,
      output: null,
      rollbackable: false,
      executionId,
      error: 'Rollback not implemented',
    };
  }

  // -- Utilities --

  protected generateExecutionId(): string {
    return `${this.manifest().name}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}