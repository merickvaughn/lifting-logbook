import {
  buildDraftKey,
  buildModificationsDraftKey,
  clearDraft,
  readDraft,
  readModificationsDraft,
  writeDraft,
  writeModificationsDraft,
} from './workoutDraftStorage';

beforeEach(() => {
  window.localStorage.clear();
  jest.restoreAllMocks();
});

it('builds a namespaced key from program/macrocycle/workout/lift/set', () => {
  expect(buildDraftKey('5-3-1', 2, 3, 'Back Squat', 1)).toBe('workout-draft:5-3-1:2:3:Back Squat:1');
});

it('round-trips a draft through write then read', () => {
  writeDraft('k', { weight: '225', reps: '5', notes: 'felt heavy' });
  expect(readDraft('k')).toEqual({ weight: '225', reps: '5', notes: 'felt heavy' });
});

it('clearDraft removes a previously written draft', () => {
  writeDraft('k', { weight: '225', reps: '5', notes: '' });
  clearDraft('k');
  expect(readDraft('k')).toBeNull();
});

it('readDraft returns null when no draft has been written for the key', () => {
  expect(readDraft('never-written')).toBeNull();
});

it('readDraft returns null for corrupted JSON instead of throwing', () => {
  window.localStorage.setItem('bad-json', 'not-json{{{');
  expect(readDraft('bad-json')).toBeNull();
});

it('readDraft returns null for well-formed JSON with the wrong shape', () => {
  // weight is a number, not a string, and reps/notes are missing entirely.
  window.localStorage.setItem('bad-shape', JSON.stringify({ weight: 225 }));
  expect(readDraft('bad-shape')).toBeNull();
});

it('writeDraft silently no-ops when localStorage.setItem throws (e.g. quota exceeded)', () => {
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  });
  expect(() => writeDraft('k', { weight: '1', reps: '1', notes: '' })).not.toThrow();
});

it('readDraft silently returns null when localStorage.getItem throws', () => {
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  });
  expect(readDraft('k')).toBeNull();
});

it('clearDraft silently no-ops when localStorage.removeItem throws', () => {
  jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  });
  expect(() => clearDraft('k')).not.toThrow();
});

// The SSR guard (typeof window === 'undefined') is not exercised here: jsdom always
// defines `window`, and reliably faking its absence needs a suppression-policy-flagged
// cast on the delete. It's implicitly proven correct on every production server
// render — if it were broken, apps/web's workout page couldn't render at all.

describe('drafts keyed by the macrocycle id (#1198)', () => {
  it('keys by id and workout, without the program or number', () => {
    expect(buildDraftKey('5-3-1', 2, 3, 'Back Squat', 1, undefined, 'mc-a')).toBe('workout-draft:id:mc-a:3:Back Squat:1');
    expect(buildDraftKey('5-3-1', 9, 3, 'Back Squat', 1, undefined, 'mc-a')).toBe(
      buildDraftKey('5-3-1', 2, 3, 'Back Squat', 1, undefined, 'mc-a'),
    );
  });

  it('moves a draft saved under the number key to the id key on first read', () => {
    const legacy = buildDraftKey('5-3-1', 2, 3, 'Back Squat', 1);
    const keyed = buildDraftKey('5-3-1', 2, 3, 'Back Squat', 1, undefined, 'mc-a');
    writeDraft(legacy, { weight: '225', reps: '5', notes: '' });

    expect(readDraft(keyed, legacy)).toEqual({ weight: '225', reps: '5', notes: '' });
    expect(window.localStorage.getItem(legacy)).toBeNull();
    expect(readDraft(keyed)).toEqual({ weight: '225', reps: '5', notes: '' });
    // Another macrocycle's id key doesn't see the moved draft.
    expect(readDraft(buildDraftKey('5-3-1', 2, 3, 'Back Squat', 1, undefined, 'mc-b'))).toBeNull();
  });

  it('prefers a draft already under the id key and leaves the legacy one alone', () => {
    writeDraft('legacy', { weight: '1', reps: '1', notes: '' });
    writeDraft('keyed', { weight: '2', reps: '2', notes: '' });
    expect(readDraft('keyed', 'legacy')?.weight).toBe('2');
    expect(window.localStorage.getItem('legacy')).not.toBeNull();
  });
});

describe('modification toggles (#1152)', () => {
  it('round-trips the ids under a key apart from any set draft', () => {
    const key = buildModificationsDraftKey('5-3-1', 2, 3, 'Back Squat', 2, 'mc-a');
    writeModificationsDraft(key, ['m-paused']);
    expect(readModificationsDraft(key)).toEqual(['m-paused']);
    expect(key).not.toBe(buildDraftKey('5-3-1', 2, 3, 'Back Squat', 0, 2, 'mc-a'));
  });

  it('readModificationsDraft returns null for corrupted JSON instead of throwing', () => {
    window.localStorage.setItem('bad-mods', 'not-json{{{');
    expect(readModificationsDraft('bad-mods')).toBeNull();
  });

  it('readModificationsDraft returns null for well-formed JSON with the wrong shape', () => {
    window.localStorage.setItem('obj-mods', JSON.stringify({ ids: ['m-paused'] }));
    window.localStorage.setItem('num-mods', JSON.stringify(['m-paused', 7]));
    expect(readModificationsDraft('obj-mods')).toBeNull();
    expect(readModificationsDraft('num-mods')).toBeNull();
  });
});
