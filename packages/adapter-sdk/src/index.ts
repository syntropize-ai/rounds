// @agentic-obs/adapter-sdk - public API

export { BaseAdapter } from './base-adapter.js';
export { AdapterValidator } from './validator.js';
export { generateScaffold } from './scaffold/template.js';

export type {
  AdapterManifest,
  ConfigSchema,
  ConfigSchemaProperty,
  ManifestValidationResult,
} from './types.js';

export type { ScaffoldOptions, ScaffoldFile } from './scaffold/template.js';