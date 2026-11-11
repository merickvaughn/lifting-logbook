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

describe('PrismaFocusRepository reading a stored progression', () => {
  it('reads each value in the shared vocabulary', async () => {
    const repo = repoReading(['double', 'manual', 'percent_wave', 'rpe'].map((value) => row(value, value)));
    expect((await repo.listBlocks()).map((block) => block.progression)).toEqual(['double', 'manual', 'percent_wave', 'rpe']);
    expect((await repo.getBlock('double'))?.progression).toBe('double');
  });

  it.each(['linear', 'fixed', 'tm'])('throws on %s, which is not a focus progression', async (value) => {
    await expect(repoReading([row('a', value)]).listBlocks()).rejects.toThrow(
      `Focus block a has an unknown progression: ${value}`,
    );
  });
});
