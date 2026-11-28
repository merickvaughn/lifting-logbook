import { serializeComplexes, serializeLiftRecords } from '../export/serializeExportCsv';
import { parseComplexes } from '../parser/parseComplexes';
import { parseCsvText } from '../parser/parseCsvText';
import { classifyImport } from './classifyImport';
import { groupComplexImportRows, validateComplexImport } from './validateComplexImport';

const table = (csv: string) => parseCsvText(csv);

describe('complexes.csv (#1514)', () => {
  const complexes = [
    { name: 'Bear', components: [{ lift: 'Power Clean', reps: 1 }, { lift: 'Front Squat', reps: 1 }] },
    { name: '=Odd, name', components: [{ lift: 'Zercher Hold', reps: 6 }, { lift: 'Deadlift', reps: 2 }, { lift: 'Deadlift', reps: 3 }] },
  ];

  it('reads back what the export writes, components in order', () => {
    const { valid, errors } = validateComplexImport(parseComplexes(table(serializeComplexes(complexes))));

    expect(errors).toEqual([]);
    expect(groupComplexImportRows(valid)).toEqual(complexes);
  });

  it('classifies as complexes, and a lift-record export with a Complex column does not', () => {
    expect(classifyImport(table(serializeComplexes(complexes))).type).toBe('complexes');
    const sets = serializeLiftRecords([
      {
        program: '5-3-1', macrocycleNum: 1, workoutNum: 1, date: new Date('2026-01-05T00:00:00Z'),
        lift: 'Squat', occurrence: 0, setNum: 1, weight: 100, reps: 5, notes: '', modifications: [],
        complex: 'Bear', complexRound: 1,
      },
    ]);
    expect(classifyImport(table(sets)).type).toBe('lift-records');
  });

  it('orders components by Component, whatever the row order, and groups names ignoring case', () => {
    const rows = parseComplexes(table('Complex,Component,Lift,Reps\nbear,2,Squat,2\nBear,1,Deadlift,1\n'));

    expect(groupComplexImportRows(validateComplexImport(rows).valid)).toEqual([
      { name: 'bear', components: [{ lift: 'Deadlift', reps: 1 }, { lift: 'Squat', reps: 2 }] },
    ]);
  });

  it('fails every row of a complex with a bad row, too few components or a repeated position', () => {
    const rows = parseComplexes(
      table(
        [
          'Complex,Component,Lift,Reps',
          'Bad reps,1,Squat,0',
          'Bad reps,2,Deadlift,3',
          'Solo,1,Squat,3',
          'Twice,1,Squat,3',
          'Twice,1,Deadlift,3',
          ',1,Squat,3',
          'Fine,1,Squat,3',
          'Fine,2,Deadlift,3',
          '',
        ].join('\n'),
      ),
    );
    const { valid, errors } = validateComplexImport(rows);

    expect(valid.map((r) => r.complex)).toEqual(['Fine', 'Fine']);
    expect(errors.map((e) => [e.row, e.code])).toEqual([
      [1, 'REPS_INVALID'],
      [3, 'COMPLEX_NAME_INVALID'],
      [5, 'COMPONENT_INVALID'],
      [6, 'COMPLEX_NAME_INVALID'],
    ]);
  });
});
