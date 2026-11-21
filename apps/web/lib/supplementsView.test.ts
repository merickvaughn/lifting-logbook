import { STACK, dose, item } from './__tests__/supplementsTestStack';
import { buildView, clock12, linkHost, num, placementText, storeName, type Stack } from './supplementsView';

describe('supplementsView helpers', () => {
  it('writes a 24-hour time the way the page shows it', () => {
    expect(clock12('16:30')).toBe('4:30 PM');
    expect(clock12('15:00')).toBe('3:00 PM');
    expect(clock12('00:05')).toBe('12:05 AM');
    expect(clock12('12:00')).toBe('12:00 PM');
  });

  it('shows a time that isn’t 24-hour HH:MM as it is, never as NaN', () => {
    expect(clock12('4:30 PM')).toBe('4:30 PM');
    expect(clock12('25:00')).toBe('25:00');
  });

  it('formats amounts to one decimal with separators', () => {
    expect(num(387.5)).toBe('387.5');
    expect(num(3400)).toBe('3,400');
    expect(num(24)).toBe('24');
  });

  it('reads a link’s host, and nothing from a non-web link', () => {
    expect(linkHost('https://www.amazon.com/dp/x')).toBe('amazon.com');
    expect(linkHost('javascript:alert(1)')).toBeUndefined();
    expect(linkHost('not a url')).toBeUndefined();
  });

  it('names a store from its host', () => {
    expect(storeName('amazon.com')).toBe('Amazon');
    expect(storeName('thorne.com')).toBe('Thorne');
    expect(storeName('example.co.uk')).toBe('Example');
  });

  it('names the day types of any dose limited to them, daily or workout', () => {
    expect(placementText(dose('am', '1 g', ['rest']), STACK.dayTypes)).toBe('Morning (Rest day)');
    expect(placementText(dose('pre', '1 g', ['lift']), STACK.dayTypes)).toBe('Pre-workout (Lift day)');
    expect(placementText(dose('am', '1 g'), STACK.dayTypes)).toBe('Morning');
  });
});

const stackOf = (over: Partial<Stack>): Stack => ({ ...STACK, ...over });
const rowsOf = (v: ReturnType<typeof buildView>) => [...v.workout.slots, ...v.daily.slots].flatMap((s) => s.rows);

describe('buildView', () => {
  it('with no day types, still places every-day doses and lists pending items', () => {
    const v = buildView(stackOf({ dayTypes: [] }), '');
    expect(v.dayType.name).toBe('Every day');
    expect(v.workout.count).toBe(0);
    expect(v.daily.slots.find((s) => s.slot === 'all')?.rows.map((r) => r.item.name)).toContain('Creatine monohydrate');
    expect(v.pending.map((r) => r.item.name)).toEqual(['Hydrolyzed collagen peptides']);
    // Pre-X and Quest are dosed only around a session, which no day type gives them yet.
    expect(v.unscheduled.map((r) => r.item.name)).toEqual(['Nutricost Pre-X', 'Quest protein (vanilla milkshake)']);
  });

  it('lists an active item with no doses as not scheduled, and leaves pending ones to Pending', () => {
    const v = buildView(
      stackOf({ items: [item('new', 'New powder'), item('later', 'Later powder', { status: 'pending' })] }),
      'lift',
    );
    expect(v.unscheduled).toHaveLength(1);
    expect(v.unscheduled[0]).toMatchObject({ amount: '', detail: 'No dose yet' });
    expect(rowsOf(v)).toEqual([]);
  });

  it('gives two doses in one slot their own rows and keys, and doesn’t tag either "also" that slot', () => {
    const split = item('split', 'Split dose', { doses: [dose('am', '1 g'), dose('am', '2 g'), dose('pm', '1 g')] });
    const rows = rowsOf(buildView(stackOf({ items: [split] }), 'lift'));
    expect(rows.map((r) => r.amount)).toEqual(['1 g', '2 g', '1 g']);
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
    expect(rows.map((r) => r.also)).toEqual([['Night'], ['Night'], ['Morning']]);
  });

  it('says on an every-day row which day types it is limited to, and nothing when it lists them all', () => {
    const restOnly = item('zma', 'ZMA', { timing: 'Before bed', doses: [dose('pm', '1 serving', ['rest'])] });
    expect(rowsOf(buildView(stackOf({ items: [restOnly] }), 'rest'))[0]?.detail).toBe('Rest day only · Before bed');
    const both = item('zma', 'ZMA', { timing: 'Before bed', doses: [dose('pm', '1 serving', ['lift', 'rest'])] });
    expect(rowsOf(buildView(stackOf({ items: [both] }), 'rest'))[0]?.detail).toBe('Before bed');
  });

  it('with no day types, words the caffeine total per day', () => {
    const coffee = item('c', 'Caffeine pill', { ingredients: [{ key: 'caffeine', amount: 400, unit: 'mg' }], doses: [dose('am', '1')] });
    const notes = buildView(stackOf({ dayTypes: [], items: [coffee] }), '').notesByItem.get('c');
    expect(notes?.map((n) => n.line)).toEqual(['~400 mg caffeine from supplements a day']);
  });

  it('lets an error other than a malformed time surface', () => {
    // A day type with no name breaks only the advisory copy, so the catch is the one thing deciding.
    const broken = { ...STACK, dayTypes: [{ id: 'lift', sessionTime: '16:30' }] } as unknown as Stack;
    expect(() => buildView(broken, 'lift')).toThrow(TypeError);
  });

  it('marks an unverified item as not counted and leaves its protein off the row', () => {
    const shake = item('shake', 'Mystery shake', {
      unverified: true,
      ingredients: [{ key: 'protein', amount: 20, unit: 'g' }],
      doses: [dose('am', '1 scoop')],
    });
    const v = buildView(stackOf({ items: [shake] }), 'lift');
    expect(rowsOf(v)[0]).toMatchObject({ counted: false, protein: undefined });
    expect(v.protein.total).toBe('0 g');
  });

  it('shows the stack without advisories when a stored time is malformed', () => {
    const v = buildView(stackOf({ caffeineCutoff: '3pm' }), 'lift');
    expect(v.advisoryError).toBeInstanceOf(RangeError);
    expect(v.notesByItem.size).toBe(0);
    expect(v.workout.count).toBeGreaterThan(0);
  });
});
