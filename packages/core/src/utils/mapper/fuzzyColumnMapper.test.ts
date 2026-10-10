import { fuzzyColumnMapper } from './fuzzyColumnMapper';

describe('fuzzyColumnMapper', () => {
  describe('lift-records', () => {
    it('maps exact canonical headers at full confidence', () => {
      const headers = ['Program', 'Cycle #', 'Workout #', 'Date', 'Lift', 'Set #', 'Weight', 'Reps', 'Notes'];
      const result = fuzzyColumnMapper(headers, 'lift-records');

      expect(result).toContainEqual(expect.objectContaining({
        sourceHeader: 'Program', destinationField: 'program', confidence: 1, required: true,
      }));
      expect(result).toContainEqual(expect.objectContaining({
        sourceHeader: 'Date', destinationField: 'date', required: true,
      }));
      expect(result).toContainEqual(expect.objectContaining({
        sourceHeader: 'Lift', destinationField: 'lift', required: true,
      }));
      expect(result).toContainEqual(expect.objectContaining({
        sourceHeader: 'Notes', destinationField: 'notes', required: false,
      }));
    });

    it('fuzzy-matches abbreviated headers', () => {
      const headers = ['Prog', 'Cycle', 'Workout', 'Date', 'Lift', 'Set', 'Wt', 'Reps'];
      const result = fuzzyColumnMapper(headers, 'lift-records');

      const wt = result.find((m) => m.sourceHeader === 'Wt');
      expect(wt?.destinationField).toBe('weight');
      expect(wt?.confidence).toBeGreaterThan(0.3);

      const set = result.find((m) => m.sourceHeader === 'Set');
      expect(set?.destinationField).toBe('setNum');
    });

    it('matches case-insensitively', () => {
      const headers = ['program', 'macrocycle #', 'workout #', 'date', 'lift', 'set #', 'weight', 'reps'];
      const result = fuzzyColumnMapper(headers, 'lift-records');

      const prog = result.find((m) => m.sourceHeader === 'program');
      expect(prog?.destinationField).toBe('program');
      expect(prog?.confidence).toBeGreaterThan(0.8);
    });

    it('marks all 8 lift-record fields as required', () => {
      const headers = ['Program', 'Cycle #', 'Workout #', 'Date', 'Lift', 'Set #', 'Weight', 'Reps'];
      const result = fuzzyColumnMapper(headers, 'lift-records');

      const requiredFields = result.filter((m) => m.required).map((m) => m.destinationField);
      expect(requiredFields).toEqual(
        expect.arrayContaining(['program', 'macrocycleNum', 'workoutNum', 'date', 'lift', 'setNum', 'weight', 'reps'])
      );
    });

    it('flags unmapped required fields with confidence 0', () => {
      const headers = ['Program', 'Date', 'Lift', 'Weight', 'Reps'];
      const result = fuzzyColumnMapper(headers, 'lift-records');

      const unmapped = result.filter((m) => m.confidence === 0 && m.required);
      expect(unmapped.length).toBeGreaterThan(0);
      expect(unmapped[0]?.transformationNote).toMatch(/not found/i);
    });

    it('handles special chars in headers (Cycle# Workout-Num)', () => {
      const headers = ['Program', 'Cycle#', 'Workout-Num', 'Date', 'Lift', 'Set#', 'Weight', 'Reps'];
      const result = fuzzyColumnMapper(headers, 'lift-records');

      expect(result.find((m) => m.sourceHeader === 'Cycle#')?.destinationField).toBe('macrocycleNum');
      expect(result.find((m) => m.sourceHeader === 'Workout-Num')?.destinationField).toBe('workoutNum');
    });
  });

  describe('training-maxes', () => {
    it('maps exact training-max headers', () => {
      const headers = ['Date Updated', 'Lift', 'Weight'];
      const result = fuzzyColumnMapper(headers, 'training-maxes');

      expect(result).toContainEqual(expect.objectContaining({
        sourceHeader: 'Date Updated', destinationField: 'dateUpdated', confidence: 1, required: true,
      }));
      expect(result).toContainEqual(expect.objectContaining({
        sourceHeader: 'Lift', destinationField: 'lift', required: true,
      }));
      expect(result).toContainEqual(expect.objectContaining({
        sourceHeader: 'Weight', destinationField: 'weight', required: true,
      }));
    });

    it('fuzzy-matches "Lift Name" → lift and "Wt" → weight', () => {
      const headers = ['Date Updated', 'Lift Name', 'Wt'];
      const result = fuzzyColumnMapper(headers, 'training-maxes');

      expect(result.find((m) => m.sourceHeader === 'Lift Name')?.destinationField).toBe('lift');
      expect(result.find((m) => m.sourceHeader === 'Wt')?.destinationField).toBe('weight');
    });

    it('marks all 3 training-max fields as required', () => {
      const headers = ['Date Updated', 'Lift', 'Weight'];
      const result = fuzzyColumnMapper(headers, 'training-maxes');

      expect(result.filter((m) => m.required)).toHaveLength(3);
    });
  });

  describe('program-spec', () => {
    it('maps exact program-spec headers, marking required vs optional', () => {
      const headers = ['Week', 'Offset', 'Lift', 'Increment', 'Order', 'Sets', 'Reps',
        'AMRAP?', 'Warm-Up %', 'WT Decrement %', 'Activation', 'Week Type'];
      const result = fuzzyColumnMapper(headers, 'program-spec');

      expect(result.find((m) => m.sourceHeader === 'Week')?.required).toBe(true);
      expect(result.find((m) => m.sourceHeader === 'Reps')?.required).toBe(true);
      expect(result.find((m) => m.sourceHeader === 'AMRAP?')?.required).toBe(false);
      expect(result.find((m) => m.sourceHeader === 'Activation')?.required).toBe(false);
    });
  });

  describe('strength-goals', () => {
    it('returns [] because strength-goals uses a server-parsed tier-ladder format', () => {
      // The real export is: Lift | Current TM | Intermediate | Advanced | Elite
      // The parser auto-detects this layout; per-column mapping is not applicable.
      const headers = ['Lift', 'Current TM', 'Intermediate', 'Advanced', 'Elite'];
      const result = fuzzyColumnMapper(headers, 'strength-goals');
      expect(result).toEqual([]);
    });
  });

  describe('confidence scoring', () => {
    it('gives confidence 1 for exact matches', () => {
      const result = fuzzyColumnMapper(['Weight'], 'training-maxes');
      expect(result.find((m) => m.sourceHeader === 'Weight')?.confidence).toBe(1);
    });

    it('gives lower confidence for partial matches', () => {
      const result = fuzzyColumnMapper(['Wt'], 'lift-records');
      const wt = result.find((m) => m.sourceHeader === 'Wt');
      expect(wt?.confidence).toBeLessThan(1);
      expect(wt?.confidence).toBeGreaterThan(0);
    });

    it('gives confidence 0 for unrecognised headers', () => {
      const result = fuzzyColumnMapper(['XYZ_UNKNOWN', 'GIBBERISH'], 'lift-records');
      const xyz = result.find((m) => m.sourceHeader === 'XYZ_UNKNOWN');
      expect(xyz?.confidence).toBe(0);
    });

    it('provides alternatives for ambiguous matches', () => {
      const result = fuzzyColumnMapper(['Set'], 'lift-records');
      const mapping = result.find((m) => m.sourceHeader === 'Set');
      expect(mapping?.alternatives).toBeDefined();
      expect(Array.isArray(mapping?.alternatives)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('skips blank source headers without crashing', () => {
      const headers = ['Program', '', 'Date', 'Lift'];
      const result = fuzzyColumnMapper(headers, 'lift-records');
      expect(Array.isArray(result)).toBe(true);
    });

    it('produces unmapped required entries even with all-empty headers', () => {
      const result = fuzzyColumnMapper(['', '', ''], 'lift-records');
      expect(result.filter((m) => m.confidence === 0 && m.required).length).toBeGreaterThan(0);
    });
  });
});
