import { PROGRAMS } from './programs';
import { userPrograms } from './user-programs';

const custom = {
  id: '0b5c1f3e-8a2d-4c6b-9e7f-1a2b3c4d5e6f',
  name: 'Sheets import',
  description: null,
  baseTemplate: null,
  createdAt: '2026-11-13',
};

describe('userPrograms', () => {
  it('lists the active template first, then the custom programs', () => {
    expect(userPrograms([custom], 'rpt').map((p) => p.id)).toEqual(['rpt', custom.id]);
  });

  // #1454: an import can go into a template the lifter can't make active, so it must still be listed.
  it('lists a template that holds the lifter’s sets though it’s neither active nor available', () => {
    expect(PROGRAMS.find((p) => p.id === '531')?.available).toBe(false);

    expect(userPrograms([custom], 'rpt', ['531', 'rpt'])).toEqual([
      { id: 'rpt', name: 'Reverse Pyramid Training (Lyle/Eric Helms)', isTemplate: true },
      custom,
      { id: '531', name: '5/3/1', isTemplate: true },
    ]);
  });

  it('lists a recorded custom program once, and a recorded slug outside the catalog by its slug', () => {
    expect(userPrograms([custom], null, [custom.id, '5-3-1'])).toEqual([
      custom,
      { id: '5-3-1', name: '5-3-1', isTemplate: true },
    ]);
  });
});
