import { PROGRAM_LENGTHS } from '@lifting-logbook/core';
import { InMemoryProgramPhilosophyRepository } from './program-philosophy.adapter';

const SCHEDULABLE = Object.entries(PROGRAM_LENGTHS);

describe('InMemoryProgramPhilosophyRepository', () => {
  const repo = new InMemoryProgramPhilosophyRepository();

  it('has programs to check', () => {
    // Every assertion below iterates this list; an empty one would pass vacuously.
    expect(SCHEDULABLE.length).toBeGreaterThan(0);
  });

  it.each(SCHEDULABLE)(
    'resolves "%s" by the programType the macrocycle dashboard carries',
    async (program) => {
      // The planner is told to pass the dashboard's programType, which is the
      // program id. Leangains and RPT were keyed "rpt-leangains" and resolved
      // to nothing (#1043).
      expect(await repo.getProgramPhilosophy(program)).not.toBeNull();
    },
  );

  it.each(SCHEDULABLE)(
    'says how this app runs "%s": length, mesocycles and when maxes change',
    async (program, meta) => {
      const appModel = (await repo.getProgramPhilosophy(program))?.appModel ?? '';

      expect(appModel).toContain(`${meta.lengthWeeks}-week macrocycle`);
      expect(appModel).toContain(`${meta.mesocycleWeeks}-week mesocycles`);
      expect(appModel).toContain('recalculated');
      expect(appModel).toContain('next macrocycle starts');
    },
  );

  it('tells the planner 5/3/1 has no deload week, keeping Wendler’s as his (#1043)', async () => {
    const philosophy = await repo.getProgramPhilosophy('5-3-1');

    expect(philosophy?.appModel).toContain('No deload week is scheduled');
    expect(philosophy?.deloadGuidance).toMatch(/^As Wendler wrote it:/);
    expect(philosophy?.summary).toMatch(/^As Wendler wrote it:/);
    expect(philosophy?.progressionRules).toMatch(/^As Wendler wrote it:/);
  });

  it.each(['leangains', 'rpt'])(
    'tells the planner which "%s" lifts the app runs as a reverse pyramid',
    async (program) => {
      // Berkhan's notes say "compound lifts only"; the presets add straight-set accessories.
      expect((await repo.getProgramPhilosophy(program))?.appModel).toContain(
        'the rest, including accessory work, are straight sets',
      );
    },
  );

  it('lists each program once', async () => {
    const types = (await repo.listPrograms()).map((p) => p.programType);
    expect(new Set(types).size).toBe(types.length);
  });
});
