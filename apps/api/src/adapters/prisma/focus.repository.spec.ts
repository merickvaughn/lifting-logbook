import { PrismaClient } from '@prisma/client';
import { PrismaFocusRepository } from './focus.repository';

function row(id: string, progression: string) {
  return {
    id,
    userId: 'u',
    series: id,
    area: 'Biceps',
    period: 'monthly',
    align: 'calendar',
    start: new Date('2026-10-01T00:00:00.000Z'),
    selection: 'rules',
    overlap: 'reduce',
    progression,
    priority: 1,
    timer: { prep: 10, set: 45, rest: 60 },
    onEnd: 'prompt',
    nextArea: null,
    pool: [],
    createdAt: new Date(),
  };
}

function repoReading(rows: ReturnType<typeof row>[]): PrismaFocusRepository {
  const focusBlock = {
    findMany: jest.fn().mockResolvedValue(rows),
    findFirst: jest.fn().mockResolvedValue(rows[0]),
  };
  return new PrismaFocusRepository({ focusBlock } as unknown as PrismaClient, 'u');
}

// Until migration 20261111120000_focus_progression_types has run, a stored block can hold a
// focus progression from before the shared vocabulary (#1213).
describe('PrismaFocusRepository reading a stored progression', () => {
  it('maps the old fixed and tm to manual and percent_wave', async () => {
    const repo = repoReading([row('a', 'fixed'), row('b', 'tm')]);
    expect((await repo.listBlocks()).map((block) => block.progression)).toEqual(['manual', 'percent_wave']);
    expect((await repo.getBlock('a'))?.progression).toBe('manual');
  });

  it('keeps values already in the shared vocabulary', async () => {
    const repo = repoReading(['double', 'manual', 'percent_wave', 'rpe'].map((value) => row(value, value)));
    expect((await repo.listBlocks()).map((block) => block.progression)).toEqual(['double', 'manual', 'percent_wave', 'rpe']);
  });

  it('throws on a value in neither vocabulary', async () => {
    await expect(repoReading([row('a', 'linear')]).listBlocks()).rejects.toThrow(
      'Focus block a has an unknown progression: linear',
    );
  });
});
