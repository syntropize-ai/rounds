// In-memory store for asset version history

import type { AssetType, AssetVersion, EditSource } from '@agentic-obs/common';

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function versionKey(assetType: AssetType, assetId: string): string {
  return `${assetType}::${assetId}`;
}

export class VersionStore {
  private readonly versions = new Map<string, AssetVersion[]>();

  /** Create a new version entry for the given asset. Returns the created version. */
  record(
    assetType: AssetType,
    assetId: string,
    snapshot: unknown,
    editedBy: string,
    editSource: EditSource,
    message?: string,
  ): AssetVersion {
    const key = versionKey(assetType, assetId);
    const history = this.versions.get(key) ?? [];
    const nextVersion = history.length > 0 ? history[history.length - 1]!.version + 1 : 1;

    const entry: AssetVersion = {
      id: uid(),
      assetType,
      assetId,
      version: nextVersion,
      snapshot,
      editedBy,
      editSource,
      ...(message !== undefined ? { message } : {}),
      createdAt: new Date().toISOString(),
    };

    history.push(entry);
    this.versions.set(key, history);
    return entry;
  }

  /** Return all versions for an asset, newest first. */
  getHistory(assetType: AssetType, assetId: string): AssetVersion[] {
    const key = versionKey(assetType, assetId);
    const history = this.versions.get(key) ?? [];
    return [...history].reverse();
  }

  /** Return a specific version of an asset. */
  getVersion(assetType: AssetType, assetId: string, version: number): AssetVersion | undefined {
    const key = versionKey(assetType, assetId);
    const history = this.versions.get(key) ?? [];
    return history.find((v) => v.version === version);
  }

  /** Return the latest version of an asset. */
  getLatest(assetType: AssetType, assetId: string): AssetVersion | undefined {
    const key = versionKey(assetType, assetId);
    const history = this.versions.get(key) ?? [];
    return history.length > 0 ? history[history.length - 1] : undefined;
  }

  /** Return the snapshot at a given version (caller applies it). */
  rollback(assetType: AssetType, assetId: string, version: number): unknown | undefined {
    const entry = this.getVersion(assetType, assetId, version);
    return entry?.snapshot;
  }
}

/** Module-level singleton */
export const defaultVersionStore = new VersionStore();
