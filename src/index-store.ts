/**
 * Lightweight in-memory index with localStorage persistence.
 * Stores path → { vector, indexedAt } pairs.
 * For a full vault (500 notes, 768-dim) this is ~1.5MB — fine for localStorage.
 */

export interface IndexEntry {
  vector: number[];
  indexedAt: number;
}

const STORAGE_KEY = "semantic-graph-index";

export class IndexStore {
  private data: Map<string, IndexEntry> = new Map();

  load(storageAdapter: { getItem: (key: string) => string | null }) {
    try {
      const raw = storageAdapter.getItem(STORAGE_KEY);
      if (raw) {
        const obj: Record<string, IndexEntry> = JSON.parse(raw);
        this.data = new Map(Object.entries(obj));
      }
    } catch {
      this.data = new Map();
    }
  }

  save(storageAdapter: { setItem: (key: string, value: string) => void }) {
    const obj = Object.fromEntries(this.data);
    storageAdapter.setItem(STORAGE_KEY, JSON.stringify(obj));
  }

  get(path: string): IndexEntry | undefined {
    return this.data.get(path);
  }

  set(path: string, entry: IndexEntry) {
    this.data.set(path, entry);
  }

  delete(path: string) {
    this.data.delete(path);
  }

  entries(): [string, IndexEntry][] {
    return Array.from(this.data.entries());
  }

  size(): number {
    return this.data.size;
  }

  clear() {
    this.data.clear();
  }
}
