import { BadRequestException } from '@nestjs/common';
import {
  LiftingProgramSpec,
  PRESET_BASE_SPECS,
  classifyAndCount,
  programSpecNaturalKey,
  programSpecRowKind,
} from '@lifting-logbook/core';
import {
  ILiftingProgramSpecRepository,
  SaveProgramSpecResult,
} from '../../ports/ILiftingProgramSpecRepository';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InMemoryLiftingProgramSpecRepository
  implements ILiftingProgramSpecRepository
{
  // Protected so a test can seed a stored override, which no import can write (#1210).
  protected specByProgram: Map<string, LiftingProgramSpec[]>;

  constructor(_preSeed = false) {
    // Program specs are global (not per-user), so always seed them. Seed every
    // built-in preset from the single source of truth (PRESET_BASE_SPECS) so a
    // newly added preset is served automatically, with no second wiring step
    // here (issue #739). `.slice()` hands out a copy so callers cannot mutate
    // the shared module-level constant.
    this.specByProgram = new Map(
      Object.entries(PRESET_BASE_SPECS).map(
        ([program, spec]): [string, LiftingProgramSpec[]] => [program, spec.slice()],
      ),
    );
  }

  async getProgramSpec(program: string): Promise<LiftingProgramSpec[]> {
    return this.specByProgram.get(program) ?? [];
  }

  async saveProgramSpec(
    program: string,
    rows: LiftingProgramSpec[],
  ): Promise<SaveProgramSpecResult> {
    if (!UUID_PATTERN.test(program)) {
      throw new BadRequestException('Program spec import requires a custom program');
    }

    const current = [...(this.specByProgram.get(program) ?? [])];
    const existingByKey = new Map(current.map((r) => [programSpecNaturalKey(r), r]));
    const byKey = new Map(existingByKey);

    // Shared classify/dedupe/tally loop + program-spec classifier (#532) so this
    // adapter's counts match the Prisma adapter's and the preview path's. The
    // deduped key is handed back by the shared loop, so it is reused here rather
    // than recomputed (#537).
    const result = await classifyAndCount(
      rows,
      (r) => programSpecNaturalKey(r),
      (r) => programSpecRowKind(r, existingByKey),
      (r, _kind, key) => {
        // Stores what the Prisma adapter's upsert stores (#1210): never the imported row's
        // progression fields, but the stored row's, except a `repsLow` the new `reps` falls below.
        const { progression: _p, repsLow: _r, ...imported } = r;
        const stored = existingByKey.get(key);
        byKey.set(key, {
          ...imported,
          ...(stored?.progression !== undefined && { progression: stored.progression }),
          ...(stored?.repsLow !== undefined && stored.repsLow <= r.reps && { repsLow: stored.repsLow }),
        });
      },
    );

    this.specByProgram.set(program, [...byKey.values()]);
    return result;
  }

  async deleteSpecRows(program: string, naturalKeys: string[]): Promise<void> {
    if (naturalKeys.length === 0) return;
    const keySet = new Set(naturalKeys);
    const existing = this.specByProgram.get(program) ?? [];
    this.specByProgram.set(program, existing.filter((r) => !keySet.has(programSpecNaturalKey(r))));
  }
}
