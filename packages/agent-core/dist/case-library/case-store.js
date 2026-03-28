export class CaseStore {
  records = new Map();
  counter = 0;

  add(record) {
    const id = `case-${++this.counter}`;
    const full = { ...record, id, createdAt: new Date().toISOString() };
    this.records.set(id, full);
    return full;
  }

  get(id) {
    return this.records.get(id);
  }

  findById(id) {
    return this.get(id);
  }

  list() {
    return [...this.records.values()];
  }

  getAll() {
    return this.list();
  }

  update(id, patch) {
    const existing = this.records.get(id);
    if (!existing) return undefined;

    const updated = { ...existing, ...patch };
    this.records.set(id, updated);
    return updated;
  }

  remove(id) {
    return this.records.delete(id);
  }

  clear() {
    this.records.clear();
  }

  get size() {
    return this.records.size;
  }
}