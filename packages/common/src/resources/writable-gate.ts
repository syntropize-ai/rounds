/**
 * Writable gate — shared "is this resource mutable by the caller?" check.
 *
 * Resources marked as `provisioned_file` or `provisioned_git` are owned
 * by a file/GitOps pipeline outside the app and must NOT be silently
 * mutated by REST writes or agent tools. Call `assertWritable(resource)`
 * at the top of every write handler, immediately after the resource is
 * fetched. See docs/design/rfc-safety-patterns.md for the design rationale.
 */

export type ResourceSource =
  | 'manual'
  | 'api'
  | 'ai_generated'
  | 'provisioned_file'
  | 'provisioned_git';

/**
 * Optional details about how a resource was provisioned. Captured alongside
 * the `source` column on dashboards / alert_rules / folders. All fields
 * optional — callers populate whatever they know.
 */
export interface ResourceProvenance {
  repo?: string;
  path?: string;
  commit?: string;
  generatedBy?: string;
  prompt?: string;
}

export class ProvisionedResourceError extends Error {
  constructor(
    public readonly resource: { kind: string; id: string; source: ResourceSource },
  ) {
    super(
      `Cannot mutate provisioned resource ${resource.kind}:${resource.id} ` +
        `(source=${resource.source}). Fork to your workspace, or propose a diff.`,
    );
    this.name = 'ProvisionedResourceError';
  }
}

/**
 * Throws `ProvisionedResourceError` when the resource is owned by a
 * file/GitOps pipeline. Returns silently for `manual`, `api`, and
 * `ai_generated` resources.
 */
export function assertWritable(resource: {
  kind: string;
  id: string;
  source: ResourceSource;
}): void {
  if (
    resource.source === 'provisioned_file' ||
    resource.source === 'provisioned_git'
  ) {
    throw new ProvisionedResourceError(resource);
  }
}
