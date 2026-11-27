import { BarbellComplex, ComplexComponent } from '@lifting-logbook/types';

export interface CreateBarbellComplexInput {
  name: string;
  components: ComplexComponent[];
}

export interface UpdateBarbellComplexPatch {
  name?: string;
  components?: ComplexComponent[];
}

/**
 * Per-user store of barbell complex definitions (#1495). The owning userId is bound to the adapter
 * at construction time (via the repository factory), never passed per call, like the other
 * per-user repositories.
 */
export interface IBarbellComplexRepository {
  /** Every complex of this user, by name. */
  list(): Promise<BarbellComplex[]>;

  /** Throws `BarbellComplexConflictError` if this user has a complex of that name. */
  create(input: CreateBarbellComplexInput): Promise<BarbellComplex>;

  /**
   * Throws `BarbellComplexNotFoundError` for an unknown id, and `BarbellComplexConflictError` if
   * the new name is taken.
   */
  update(id: string, patch: UpdateBarbellComplexPatch): Promise<BarbellComplex>;

  /**
   * Removes a complex. Logged sets name a complex by its name, so none refers to the row. A program
   * row that names it plans nothing for it from then on. Throws `BarbellComplexNotFoundError` for an
   * unknown id.
   */
  delete(id: string): Promise<void>;
}
