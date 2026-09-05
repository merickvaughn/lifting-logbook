import { TIMER_PHASE_KINDS } from '@lifting-logbook/core';
import type { TimerPhase, TimerPhaseKind } from '@lifting-logbook/core';
import {
  END_SESSION_LABEL,
  QUEUE_KIND_LABEL,
  phaseLabel,
  phaseSubLabel,
  primaryActionLabel,
  queueRowDetail,
  signedTime,
} from '@/lib/timerLabels';

/**
 * The per-kind copy records are exhaustive *by type* — a kind added to
 * `TIMER_PHASE_KINDS` without an entry is a compile error. These tests are the
 * runtime companion: they iterate the same array so every kind is exercised,
 * and they pin the copy each kind actually produces.
 */
function phase(kind: TimerPhaseKind, next: TimerPhase['next'] = null): TimerPhase {
  const set =
    kind === 'activation' ?
      { type: 'activation' as const, setLabel: 'Hip Airplane', spec: '' }
    : { type: 'work' as const, setLabel: 'Set 2', spec: '5 × 225 lbs' };
  return { kind, label: kind, dur: 60, lift: 'Squat', set, setIndex: 1, next };
}

const EVERY_KIND = TIMER_PHASE_KINDS.map((kind) => [kind] as const);

describe('phaseSubLabel', () => {
  it.each(EVERY_KIND)('produces non-empty copy for a %s phase', (kind) => {
    expect(phaseSubLabel(phase(kind))).not.toBe('');
  });

  it('names the set and its prescription for prep and set phases', () => {
    expect(phaseSubLabel(phase('prep'))).toBe('Set 2 · 5 × 225 lbs');
    expect(phaseSubLabel(phase('set'))).toBe('Set 2 · 5 × 225 lbs');
  });

  it('names only the movement for an activation (no dangling separator)', () => {
    expect(phaseSubLabel(phase('activation'))).toBe('Hip Airplane');
  });

  it('says what a rest precedes, or that the last set is done', () => {
    expect(phaseSubLabel(phase('rest', { lift: 'Bench', setLabel: 'Set 1', spec: '5 × 185' }))).toBe(
      'Up next: Bench · Set 1',
    );
    expect(phaseSubLabel(phase('rest'))).toBe('Last set done');
  });
});

describe('queue row copy', () => {
  it.each(EVERY_KIND)('has a badge for a %s phase', (kind) => {
    expect(QUEUE_KIND_LABEL[kind]).not.toBe('');
  });

  it('gives every kind a badge of its own', () => {
    const badges = TIMER_PHASE_KINDS.map((kind) => QUEUE_KIND_LABEL[kind]);
    expect(new Set(badges).size).toBe(TIMER_PHASE_KINDS.length);
  });

  it('shows the prescription after a set, the movement after an activation, nothing otherwise', () => {
    expect(queueRowDetail(phase('set'))).toBe(' · 5 × 225 lbs');
    expect(queueRowDetail(phase('activation'))).toBe(' · Hip Airplane');
    expect(queueRowDetail(phase('prep'))).toBe('');
    expect(queueRowDetail(phase('rest'))).toBe('');
  });
});

describe('shared session copy', () => {
  it('signs an overrun and leaves a countdown bare', () => {
    expect(signedTime(243, true)).toBe('+4:03');
    expect(signedTime(243, false)).toBe('4:03');
  });

  it('prefixes the phase label while paused', () => {
    expect(phaseLabel(phase('rest'), true)).toBe('Paused · rest');
    expect(phaseLabel(phase('rest'), false)).toBe('rest');
  });

  it('labels the primary control by run state and phase', () => {
    expect(primaryActionLabel(false, null, false)).toBe('Start');
    expect(primaryActionLabel(true, phase('set'), false)).toBe('Skip');
    expect(primaryActionLabel(true, phase('rest'), false)).toBe('Skip rest');
    expect(primaryActionLabel(true, phase('rest'), true)).toBe('Start next set');
  });

  it('names ending a session the same way on both surfaces', () => {
    expect(END_SESSION_LABEL).toBe('End timer');
  });
});
