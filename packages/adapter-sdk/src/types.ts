/**
 * Configuration schema for an adapter, using a subset of JSON Schema.
 * Defines what parameters the adapter needs to initialize (e.g., API keys, URLs).
 */
export interface ConfigSchema {
  properties: Record<string, ConfigSchemaProperty>;
  required?: string[];
}

/**
 * Metadata for a single configuration property.
 */
export interface ConfigSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'integer';
  description: string;
  default?: any;
  required?: boolean;
  secret?: boolean; // If true, UI should mask this value
}

/**
 * The full descriptor for an Execution Adapter.
 * This manifest is used for discovery and validation.
 */
export interface AdapterManifest {
  /** Machine-readable name, e.g., "kubernetes-control" */
  name: string;
  /** Semver version string */
  version: string;
  /** Human-readable description of what the adapter does */
  description: string;
  /** * List of action types this adapter can handle.
   * Format: "adapterName:action" (e.g., "k8s:scale-deployment")
   */
  capabilities: string[];
  /** Schema for the adapter's configuration */
  configSchema: ConfigSchema;
  /** Whether the adapter implements the dryRun method */
  supportsDryRun: boolean;
  /** Whether the adapter implements the rollback method */
  supportsRollback: boolean;
}

/**
 * Result of a manifest or adapter instance validation.
 */
export interface ManifestValidationResult {
  /** True if the adapter conforms to the spec */
  valid: boolean;
  /** List of human-readable error messages if valid is false */
  errors: string[];
}