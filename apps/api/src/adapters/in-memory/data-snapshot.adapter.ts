import { randomUUID } from 'node:crypto';
import {
  IDataSnapshotRepository,
  NewSnapshot,
  StoredSnapshot,
  StoredSnapshotSummary,
} from '../../ports/IDataSnapshotRepository';
import { decodeSnapshotRows, encodeSnapshotRows } from '../../snapshots/snapshot-payload';

/**
 * Snapshots in memory. Rows go through the same encoding as in Postgres, so a test reads back
 * what a stored snapshot would give it.
 */
export class InMemoryDataSnapshotRepository implements IDataSnapshotRepository {
  private readonly snapshots = new Map<string, Omit<StoredSnapshot, 'data'> & { rows: Buffer }>();

  /** Makes `create` throw, for tests of a snapshot that can't be saved. */
  failNextCreate = false;

  async create(snapshot: NewSnapshot): Promise<StoredSnapshotSummary> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error('snapshot could not be saved');
    }
    const { data, overwrite, ...rest } = snapshot;
    const rows = await encodeSnapshotRows({ data, ...(overwrite ? { overwrite } : {}) });
    const stored = { ...structuredClone(rest), id: randomUUID(), rows };
    this.snapshots.set(stored.id, stored);
    return this.summary(stored);
  }

  /** Moves a snapshot's expiry, for tests. */
  setExpiry(id: string, expiresAt: Date): void {
    const stored = this.snapshots.get(id);
    if (stored) stored.expiresAt = expiresAt;
  }

  async list(now: Date): Promise<StoredSnapshotSummary[]> {
    return [...this.snapshots.values()]
      .filter((s) => s.expiresAt > now)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((s) => this.summary(s));
  }

  async get(id: string, now: Date): Promise<StoredSnapshot | null> {
    const stored = this.snapshots.get(id);
    if (!stored || stored.expiresAt <= now) return null;
    return { ...this.summary(stored), ...(await decodeSnapshotRows(stored.rows)) };
  }

  async delete(id: string): Promise<boolean> {
    return this.snapshots.delete(id);
  }

  private summary({ rows: _rows, ...summary }: Omit<StoredSnapshot, 'data'> & { rows: Buffer }): StoredSnapshotSummary {
    return structuredClone(summary);
  }
}
