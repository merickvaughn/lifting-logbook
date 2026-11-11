import { MacrocycleNumberConflictError } from '../../ports/errors';

/**
 * An in-memory store that holds macrocycle numbers, which a renumbering rewrites as the Prisma
 * adapter rewrites its tables (#1199). Returns how many rows moved.
 */
export interface NumberedStore {
  /** The Prisma table the store stands in for, which a refused renumbering names. */
  readonly table: string;
  rewriteNumbers(program: string, changes: ReadonlyMap<number, number>): number;
  /** The numbers the program's rows hold, which a renumbering checks before it moves anything. */
  numbersHeld(program: string): Set<number>;
  /** Deletes the program's rows on `macrocycleNums`, as removing a macrocycle does. */
  dropNumbers(program: string, macrocycleNums: readonly number[]): void;
}

/**
 * Every store in a repository bundle that holds a number, so a store added to the bundle is
 * renumbered and deleted with the rest without being listed by hand.
 */
export function numberedStoresIn(bundle: object): NumberedStore[] {
  return Object.values(bundle).filter(
    (repo): repo is NumberedStore =>
      typeof repo === 'object' &&
      repo !== null &&
      'table' in repo &&
      'numbersHeld' in repo &&
      typeof repo.numbersHeld === 'function',
  );
}

/** The numbers `program`'s keys in `map` hold. */
export function numbersInMap<V>(
  map: Map<string, V>,
  program: string,
  numberOf: (key: string) => { program: string; macrocycleNum: number },
): Set<number> {
  const held = new Set<number>();
  for (const key of map.keys()) {
    const at = numberOf(key);
    if (at.program === program) held.add(at.macrocycleNum);
  }
  return held;
}

/** Deletes `program`'s entries in `map` on `macrocycleNums`. */
export function dropFromMap<V>(
  map: Map<string, V>,
  program: string,
  macrocycleNums: readonly number[],
  numberOf: (key: string) => { program: string; macrocycleNum: number },
): void {
  for (const key of [...map.keys()]) {
    const at = numberOf(key);
    if (at.program === program && macrocycleNums.includes(at.macrocycleNum)) map.delete(key);
  }
}

/**
 * Moves each of `map`'s entries for `program` whose number is in `changes` to the key for its new
 * number. A new key that's already taken throws, as the database's unique key would.
 */
export function rekeyMap<V>(
  map: Map<string, V>,
  program: string,
  changes: ReadonlyMap<number, number>,
  numberOf: (key: string) => { program: string; macrocycleNum: number },
  keyWith: (key: string, macrocycleNum: number) => string,
): number {
  const moved: Array<[string, V]> = [];
  for (const [key, value] of [...map]) {
    const at = numberOf(key);
    const to = at.program === program ? changes.get(at.macrocycleNum) : undefined;
    if (to === undefined) continue;
    map.delete(key);
    moved.push([keyWith(key, to), value]);
  }
  for (const [key, value] of moved) {
    if (map.has(key)) throw new MacrocycleNumberConflictError(program, undefined, { cause: `collides on ${JSON.stringify(key)}` });
    map.set(key, value);
  }
  return moved.length;
}

/** For keys `<program>:<macrocycleNum>`, where the program may hold a colon. */
export const colonKey = {
  numberOf(key: string): { program: string; macrocycleNum: number } {
    const split = key.lastIndexOf(':');
    return { program: key.slice(0, split), macrocycleNum: Number(key.slice(split + 1)) };
  },
  keyWith(key: string, macrocycleNum: number): string {
    return `${key.slice(0, key.lastIndexOf(':'))}:${macrocycleNum}`;
  },
};

/** For keys `<program>\0<macrocycleNum>\0<workoutNum>`. */
export const nulKey = {
  numberOf(key: string): { program: string; macrocycleNum: number } {
    const [program = '', macrocycleNum = ''] = key.split('\0');
    return { program, macrocycleNum: Number(macrocycleNum) };
  },
  keyWith(key: string, macrocycleNum: number): string {
    const [program, , workoutNum] = key.split('\0');
    return `${program}\0${macrocycleNum}\0${workoutNum}`;
  },
};
