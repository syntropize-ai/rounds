// Folder types — canonical home after store→repository migration (Sprint 4).

export interface Folder {
  id: string;
  name: string;
  parentId?: string;
  createdAt: string;
}
