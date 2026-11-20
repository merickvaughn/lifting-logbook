import { SupplementChange } from '@lifting-logbook/types';
import {
  ISupplementRepository,
  NewSupplementChange,
  SupplementState,
} from '../../ports/ISupplementRepository';
import { SupplementWriteConflictError } from '../../ports/errors';

/** Mirrors PrismaSupplementRepository, including its all-or-nothing save. */
export class InMemorySupplementRepository implements ISupplementRepository {
  private state: SupplementState = { items: [], folded: [], dayTypes: [], caffeineCutoff: null, nextSeq: 1 };
  private readonly log: SupplementChange[] = [];

  async load(): Promise<SupplementState> {
    return structuredClone(this.state);
  }

  async changes(): Promise<SupplementChange[]> {
    return structuredClone(this.log);
  }

  async save(next: SupplementState, changes: readonly NewSupplementChange[]): Promise<void> {
    if (next.nextSeq !== this.state.nextSeq) throw new SupplementWriteConflictError();
    const numbered = changes.map((c, i) => ({ ...c, seq: next.nextSeq + i }));
    this.state = structuredClone({ ...next, nextSeq: next.nextSeq + changes.length });
    this.log.push(...structuredClone(numbered));
  }
}
