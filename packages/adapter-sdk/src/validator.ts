// AdapterValidator - validates that an adapter correctly implements the SDK contract
// Provides boilerplate for the ExecutionAdapter interface so adapter authors
// only need to implement the core logic, not the scaffolding.

import type { ExecutionAdapter } from '@agentic-obs/agent-core';
import type { AdapterManifest, ManifestValidationResult } from './types.js';
import type { BaseAdapter } from './base-adapter.js';

/**
 * AdapterValidator checks that an adapter:
 * 1. Provides a valid manifest (name, version, capabilities)
 * 2. Capabilities() matches manifest.capabilities
 * 3. Config schema has required fields defined
 * 4. All required interface methods are present and callable
 */
export class AdapterValidator {
  /**
   * Validate an AdapterManifest for structural correctness.
   */
  validateManifest(manifest: AdapterManifest): ManifestValidationResult {
    const errors: string[] = [];

    if (!manifest.name || manifest.name.trim() === '') {
      errors.push('manifest.name is required and must be non-empty');
    } else if (!/^[a-z0-9-]+$/.test(manifest.name)) {
      errors.push('manifest.name must match pattern [a-z0-9-] (lowercase, numbers, hyphens only)');
    }

    if (!manifest.version || manifest.version.trim() === '') {
      errors.push('manifest.version is required');
    } else if (!/^\d+\.\d+\.\d+/.test(manifest.version)) {
      errors.push('manifest.version must be a semver string (e.g. "1.0.0")');
    }

    if (!manifest.description || manifest.description.trim() === '') {
      errors.push('manifest.description is required');
    }

    if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
      errors.push('manifest.capabilities must be a non-empty array of action type strings');
    } else {
      for (const cap of manifest.capabilities) {
        if (typeof cap !== 'string' || !cap.includes(':')) {
          errors.push(`manifest.capabilities: "${cap}" must be in format 'adapterName:action' (e.g. 'k8s:sc')`);
        }
      }
    }

    if (!manifest.configSchema || typeof manifest.configSchema !== 'object') {
      errors.push('manifest.configSchema is required');
    } else {
      if (!manifest.configSchema.properties || typeof manifest.configSchema.properties !== 'object') {
        errors.push('manifest.configSchema.properties must be an object');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Validate that an adapter instance conforms to the ExecutionAdapter interface
   * and that its capabilities() output matches its manifest.
   */
  validateAdapter(adapter: ExecutionAdapter): ManifestValidationResult {
    const errors: string[] = [];

    // Check required interface methods
    const requiredMethods = ['capabilities', 'validate', 'dryRun', 'execute'] as const;
    for (const method of requiredMethods) {
      if (typeof adapter[method] !== 'function') {
        errors.push(`Adapter is missing required method: ${method}()`);
      }
    }

    if (errors.length > 0) return { valid: false, errors };

    // Check capabilities() returns an array
    let caps: unknown;
    try {
      caps = adapter.capabilities();
    } catch (err) {
      errors.push(`capabilities() threw: ${err instanceof Error ? err.message : String(err)}`);
      return { valid: false, errors };
    }

    if (!Array.isArray(caps)) {
      errors.push('capabilities() must return an array');
    } else if (caps.length === 0) {
      errors.push('capabilities() must return at least one action type');
    }

    // If it's a BaseAdapter, cross-check capabilities with manifest
    const asBase = adapter as Partial<BaseAdapter>;
    if (typeof asBase.manifest === 'function') {
      let manifest: AdapterManifest;
      try {
        manifest = asBase.manifest();
      } catch (err) {
        errors.push(`manifest() threw: ${err instanceof Error ? err.message : String(err)}`);
        return { valid: false, errors };
      }

      const manifestResult = this.validateManifest(manifest);
      errors.push(...manifestResult.errors);

      // Cross-check capabilities match manifest
      const manifestCaps = new Set(manifest.capabilities);
      const adapterCaps = new Set(caps as string[]);
      
      for (const cap of adapterCaps) {
        if (!manifestCaps.has(cap)) {
          errors.push(`capabilities() declares '${cap}' but it is absent from manifest.capabilities`);
        }
      }
      for (const cap of manifestCaps) {
        if (!adapterCaps.has(cap)) {
          errors.push(`manifest.capabilities declares '${cap}' but capabilities() does not include it`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }
}