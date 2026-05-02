/**
 * Thin wrappers over /api/folders for tests that need to spin up
 * scoped folders and tear them down. Reuses the SA token via
 * api-client.ts.
 */
import { apiPost, apiDelete } from './api-client.js';

interface FolderResp {
  id: string;
  uid: string;
  title: string;
}

export async function createFolder(title: string): Promise<FolderResp> {
  return apiPost<FolderResp>('/api/folders', { title });
}

export async function deleteFolder(uid: string): Promise<void> {
  try {
    await apiDelete(`/api/folders/${uid}`);
  } catch {
    /* best effort */
  }
}
