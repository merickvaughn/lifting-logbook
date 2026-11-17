import { Prisma, PrismaClient } from '@prisma/client';
import { TrainingDataCounts } from '@lifting-logbook/types';
import {
  DataSnapshotScope,
  IDataSnapshotRepository,
  NewSnapshot,
  SNAPSHOT_KINDS,
  SnapshotKind,
  StoredSnapshot,
  StoredSnapshotSummary,
} from '../../ports/IDataSnapshotRepository';
import { decodeSnapshotRows, encodeSnapshotRows } from '../../snapshots/snapshot-payload';

const SUMMARY = { id: true, kind: true, scope: true, counts: true, createdAt: true, expiresAt: true } as const;

type SummaryRow = Prisma.DataSnapshotGetPayload<{ select: typeof SUMMARY }>;

/** Reads and downloads see only the kinds this release knows; `create` still checks what it gets back. */
const KNOWN_KINDS = { kind: { in: [...SNAPSHOT_KINDS] } };

const isKnownKind = (kind: string): kind is SnapshotKind => (SNAPSHOT_KINDS as readonly string[]).includes(kind);

/** A stored kind this release knows; the column is plain text. */
function snapshotKind(kind: string): SnapshotKind {
  if (!isKnownKind(kind)) throw new Error(`snapshot kind ${kind} is not one this release reads`);
  return kind;
}

function summary(row: SummaryRow): StoredSnapshotSummary {
  return {
    id: row.id,
    kind: snapshotKind(row.kind),
    // Written only by `create` below, from these types.
    scope: row.scope as unknown as DataSnapshotScope,
    counts: row.counts as unknown as TrainingDataCounts,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export class PrismaDataSnapshotRepository implements IDataSnapshotRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  async create(snapshot: NewSnapshot): Promise<StoredSnapshotSummary> {
    const row = await this.prisma.dataSnapshot.create({
      data: {
        userId: this.userId,
        kind: snapshot.kind,
        scope: snapshot.scope as unknown as Prisma.InputJsonObject,
        counts: snapshot.counts as unknown as Prisma.InputJsonObject,
        rows: await encodeSnapshotRows(snapshot.data),
        createdAt: snapshot.createdAt,
        expiresAt: snapshot.expiresAt,
      },
      select: SUMMARY,
    });
    return summary(row);
  }

  async list(now: Date): Promise<StoredSnapshotSummary[]> {
    const rows = await this.prisma.dataSnapshot.findMany({
      where: { userId: this.userId, ...KNOWN_KINDS, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
      select: SUMMARY,
    });
    return rows.map(summary);
  }

  async get(id: string, now: Date): Promise<StoredSnapshot | null> {
    const row = await this.prisma.dataSnapshot.findFirst({
      where: { id, userId: this.userId, ...KNOWN_KINDS, expiresAt: { gt: now } },
      select: { ...SUMMARY, rows: true },
    });
    return row ? { ...summary(row), data: await decodeSnapshotRows(row.rows) } : null;
  }

  async delete(id: string): Promise<boolean> {
    const { count } = await this.prisma.dataSnapshot.deleteMany({ where: { id, userId: this.userId } });
    return count > 0;
  }
}
