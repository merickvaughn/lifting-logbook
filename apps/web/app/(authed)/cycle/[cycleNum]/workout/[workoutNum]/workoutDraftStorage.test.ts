import { buildDraftKey, clearDraft, readDraft, writeDraft } from './workoutDraftStorage';

beforeEach(() => {
  window.localStorage.clear();
  jest.restoreAllMocks();
});

it('builds a namespaced key from program/cycle/workout/lift/set', () => {
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
